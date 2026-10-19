use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

struct CachedLyrics {
    data: LyricsData,
    fetched_at: Instant,
}

static LYRICS_CACHE: OnceLock<Mutex<HashMap<String, CachedLyrics>>> = OnceLock::new();

fn lyrics_cache() -> &'static Mutex<HashMap<String, CachedLyrics>> {
    LYRICS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const CACHE_TTL_SECS: u64 = 3600;
const PER_SOURCE_TIMEOUT_SECS: u64 = 5;

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncedLine {
    pub time_ms: i64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LyricsData {
    pub plain: String,
    pub synced: Option<Vec<SyncedLine>>,
    pub source: String,
}

/// Heuristic to determine if a song is English based on the title.
fn is_title_english(title: &str) -> bool {
    let has_cjk = title.chars().any(|c| {
        ('\u{4e00}'..='\u{9fff}').contains(&c) ||
        ('\u{3040}'..='\u{30ff}').contains(&c) ||
        ('\u{ac00}'..='\u{d7af}').contains(&c) ||
        ('\u{ff00}'..='\u{ffef}').contains(&c)
    });

    if has_cjk {
        return false;
    }

    let total_chars = title.chars().filter(|c| c.is_alphanumeric()).count();
    if total_chars == 0 { return true; }
    
    let latin_chars = title
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .count();

    (latin_chars as f64 / total_chars as f64) > 0.5
}

fn parse_lrc(lrc: &str, strip_translations: bool) -> Vec<SyncedLine> {
    let mut lines = Vec::new();
    let mut offset_ms: i64 = 0;

    for line in lrc.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if line.starts_with("[offset:") && line.ends_with(']') {
            if let Ok(val) = line[8..line.len()-1].parse::<i64>() {
                offset_ms = val;
            }
            continue;
        }

        let mut times: Vec<i64> = Vec::new();
        let mut rest = line;
        let mut is_meta = false;

        while rest.starts_with('[') {
            let end = match rest.find(']') {
                Some(i) => i,
                None => break,
            };
            let tag = &rest[1..end];
            
            if let Some((m, s)) = tag.split_once(':') {
                if let (Ok(mins), Ok(secs)) = (m.parse::<i64>(), s.parse::<f64>()) {
                    times.push(mins * 60_000 + (secs * 1000.0) as i64);
                } else {
                    is_meta = true;
                }
            } else {
                is_meta = true;
            }
            rest = &rest[end + 1..];
        }

        if is_meta && times.is_empty() { continue; }

        let mut text = rest.trim().to_string();
        
        if strip_translations {
            if let Some(idx) = text.find(|c: char| 
                ('\u{4e00}'..='\u{9fff}').contains(&c) ||
                ('\u{3040}'..='\u{30ff}').contains(&c) ||
                ('\u{ac00}'..='\u{d7af}').contains(&c)
            ) {
                text = text[..idx].trim().to_string();
            }
            text = text.trim_end_matches(|c| c == '/' || c == '-' || c == ' ').to_string();
        }

        if !times.is_empty() {
            for time_ms in times {
                lines.push(SyncedLine { 
                    time_ms: time_ms + offset_ms, 
                    text: text.clone() 
                });
            }
        }
    }
    
    lines.sort_by_key(|l| l.time_ms);
    lines
}

fn adjust_sync(mut lines: Vec<SyncedLine>, current_audio_time: i64) -> Vec<SyncedLine> {
    if lines.is_empty() || current_audio_time <= 0 {
        return lines;
    }

    let first_lyric_idx = lines.iter().position(|l| !l.text.trim().is_empty()).unwrap_or(0);
    if first_lyric_idx >= lines.len() {
        return lines;
    }

    let first_lyric = &lines[first_lyric_idx];
    let diff = current_audio_time - first_lyric.time_ms;
    
    if diff > 4000 && current_audio_time < (first_lyric.time_ms + 30_000) {
        println!("[lyrics] Dynamic sync adjustment: +{}ms", diff);
        for line in &mut lines {
            line.time_ms += diff;
        }
    }

    lines
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Audos/0.1.4 (https://github.com/soham-exe/audos)")
        .timeout(Duration::from_secs(PER_SOURCE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Client error: {}", e))
}

async fn fetch_lrclib(client: &Client, title: &str, artist: &str, duration: i64) -> Option<LyricsData> {
    let mut query = vec![
        ("track_name", title.to_string()),
        ("artist_name", artist.to_string()),
    ];
    if duration > 0 {
        query.push(("duration", duration.to_string()));
    }

    let resp = client
        .get("https://lrclib.net/api/get")
        .query(&query)
        .send()
        .await
        .ok()?;

    if resp.status().is_success() {
        if let Ok(json) = resp.json::<Value>().await {
            if !json["instrumental"].as_bool().unwrap_or(false) {
                let plain = json["plainLyrics"].as_str().unwrap_or("").to_string();
                let synced = json["syncedLyrics"].as_str().map(|lrc| parse_lrc(lrc, false));
                if !plain.trim().is_empty() || synced.as_ref().map_or(false, |s| !s.is_empty()) {
                    return Some(LyricsData { plain, synced, source: "LRCLIB".into() });
                }
            }
        }
    }

    // Fuzzy search fallback
    if duration > 0 {
        let resp = client
            .get("https://lrclib.net/api/search")
            .query(&[("q", format!("{} {}", title, artist))])
            .send()
            .await
            .ok()?;

        if resp.status().is_success() {
            if let Ok(results) = resp.json::<Value>().await {
                if let Some(arr) = results.as_array() {
                    if let Some(best) = arr.first() {
                        let plain = best["plainLyrics"].as_str().unwrap_or("").to_string();
                        let synced = best["syncedLyrics"].as_str().map(|lrc| parse_lrc(lrc, false));
                        
                        // Ensure we don't return empty lyrics
                        let has_content = !plain.trim().is_empty() || synced.as_ref().map_or(false, |s| !s.is_empty());
                        if has_content {
                            return Some(LyricsData { plain, synced, source: "LRCLIB (Fuzzy)".into() });
                        }
                    }
                }
            }
        }
    }
    None
}

async fn fetch_netease(client: &Client, title: &str, artist: &str) -> Option<LyricsData> {
    let query = format!("{} {}", title, artist);
    let search_resp = client
        .get("https://music.163.com/api/search/get")
        .query(&[("s", query.as_str()), ("type", "1"), ("limit", "5")])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .ok()?;

    if !search_resp.status().is_success() { return None; }
    let search_json = search_resp.json::<Value>().await.ok()?;

    let song_id = search_json["result"]["songs"]
        .as_array()?
        .first()?
        .get("id")?
        .as_i64()?;

    let lyric_resp = client
        .get("https://music.163.com/api/song/lyric")
        .query(&[("id", song_id.to_string()), ("lv", "-1".into())])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .ok()?;

    if !lyric_resp.status().is_success() { return None; }
    let lyric_json = lyric_resp.json::<Value>().await.ok()?;

    let lrc_text = lyric_json["lrc"]["lyric"].as_str().unwrap_or("").trim();
    if lrc_text.is_empty() { return None; }

    let clean_lrc_text = lrc_text
        .lines()
        .filter(|line| {
            let t = line.to_lowercase();
            !t.contains("作词") && !t.contains("作曲") && !t.contains("编曲") && 
            !t.contains("制作人") && !t.contains("lyricist") && !t.contains("composer")
        })
        .collect::<Vec<&str>>()
        .join("\n");

    let is_english = is_title_english(title);
    let synced = parse_lrc(&clean_lrc_text, is_english);
    if synced.is_empty() { return None; }

    let plain = synced.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
    Some(LyricsData { plain, synced: Some(synced), source: "NetEase".into() })
}

/// Lyrica API: an open-source aggregator that pulls from 7 sources.
/// Public demo instance requires no auth.
async fn fetch_lyrica(client: &Client, title: &str, artist: &str) -> Option<LyricsData> {
    // Lyrica's search is very literal. We need to strip out extra junk from the artist name too.
    // e.g. "Arijit Singh, Mithoon, Pritam" -> "Arijit Singh"
    let primary_artist = artist
        .split(',')
        .next()
        .unwrap_or(artist)
        .split('&')
        .next()
        .unwrap_or(artist)
        .split("feat.")
        .next()
        .unwrap_or(artist)
        .trim()
        .to_string();

    // The title is already cleaned by `fetch_lyrics`, but we'll do a final safety check
    // to remove any parentheticals that survived.
    let mut clean_title = title.to_string();
    if let Some(idx) = clean_title.find('(') {
        clean_title = clean_title[..idx].trim().to_string();
    }
    if let Some(idx) = clean_title.find('[') {
        clean_title = clean_title[..idx].trim().to_string();
    }

    let resp = client
        .get("https://wilooper-lyrica.hf.space/lyrics/")
        .query(&[
            ("artist", primary_artist.as_str()),
            ("song", clean_title.as_str()),
            ("timestamps", "true"),
        ])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() { 
        println!("[lyrica] HTTP error: {}", resp.status());
        return None; 
    }
    
    let text = resp.text().await.ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;

    if json["status"].as_str() != Some("success") {
        println!("[lyrica] API returned status: {:?}", json["status"]);
        return None;
    }

    let data = &json["data"];

    // 1. Get the LRC string
    let lrc_string = data["lyrics"].as_str().unwrap_or("").to_string();
    
    // 2. Parse it
    let synced = if !lrc_string.is_empty() {
        let parsed = parse_lrc(&lrc_string, false);
        if parsed.is_empty() { None } else { Some(parsed) }
    } else {
        None
    };

    let plain = if let Some(ref s) = synced {
        s.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n")
    } else {
        lrc_string
    };

    if plain.trim().is_empty() && synced.is_none() {
        return None;
    }

    let original_source = data["source"].as_str().unwrap_or("unknown");
    let display_source = format!("Lyrica ({})", original_source);

    Some(LyricsData {
        plain,
        synced,
        source: display_source,
    })
}

async fn fetch_custom_db(client: &Client, title: &str, artist: &str) -> Option<LyricsData> {
    // Point this to your actual GitHub Repo!
    let url = "https://raw.githubusercontent.com/soham-exe/audos-lyrics-db/main/lyrics_db.json";
    
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    
    let text = resp.text().await.ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    
    let key = format!("{}|{}", title.to_lowercase().trim(), artist.to_lowercase().trim());
    
    if let Some(lrc_text) = json[key].as_str() {
        println!("[lyrics] Hit custom DB!");
        let synced = parse_lrc(lrc_text, false);
        let plain = synced.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
        return Some(LyricsData { 
            plain, 
            synced: if synced.is_empty() { None } else { Some(synced) }, 
            source: "Audos DB".into() 
        });
    }
    None
}

#[tauri::command]
pub async fn fetch_lyrics(title: String, artist: String, duration: i64, current_time: Option<i64>) -> Result<LyricsData, String> {
    // 1. Initial cleanup: remove garbage words but KEEP the structure
    let mut base_title = title.to_string();
    let junk_words = [
        "Full Video Song", "Video Song", "Official Video", "Lyric Video", 
        "Official Music Video", "Music Video", "Audio", "Full Song", 
        "HD", "4K", "Lyrical", "Visualizer"
    ];
    for junk in junk_words {
        let lower = base_title.to_lowercase();
        let junk_lower = junk.to_lowercase();
        if let Some(idx) = lower.find(&junk_lower) {
            base_title.replace_range(idx..idx + junk.len(), "");
        }
    }
    
    // Remove brackets and parentheses
    if let Some(idx) = base_title.find('(') {
        if idx > 0 { base_title = base_title[..idx].trim().to_string(); }
    }
    if let Some(idx) = base_title.find('[') {
        if idx > 0 { base_title = base_title[..idx].trim().to_string(); }
    }

    let base_title = base_title.trim().to_string();

    // 2. Build the Waterfall Search Strategy
    let mut search_titles = vec![base_title.clone()]; // Try the whole thing first
    
    // Fallback 1: Split by pipe (|)
    if let Some(idx) = base_title.find('|') {
        let pipe_split = base_title[..idx].trim().to_string();
        if pipe_split != base_title {
            search_titles.push(pipe_split);
        }
    }
    
    // Fallback 2: Split by hyphen (-)
    if let Some(idx) = base_title.find(" - ") {
        let hyphen_split = base_title[..idx].trim().to_string();
        if hyphen_split != base_title && !search_titles.contains(&hyphen_split) {
            search_titles.push(hyphen_split);
        }
    }

    let client = http_client()?;
    let mut final_result = None;

    // 3. Loop through the waterfall
    for search_title in search_titles {
        let cache_key = format!("{}|{}|{}", search_title, artist, duration);
        
        // Check cache for this specific search query
        {
            let cache = lyrics_cache().lock().unwrap();
            if let Some(entry) = cache.get(&cache_key) {
                if entry.fetched_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) {
                    println!("[lyrics] cache hit ({}): {}", entry.data.source, search_title);
                    final_result = Some(entry.data.clone());
                    break;
                }
            }
        }

        // 0. Custom DB
        let mut result = fetch_custom_db(&client, &search_title, &artist).await;
        
        // 1. LRCLIB
        if result.is_none() {
            result = fetch_lrclib(&client, &search_title, &artist, duration).await;
        }
        
        // 2. NetEase
        if result.is_none() {
            println!("[lyrics] LRCLIB miss, trying NetEase for: {}", search_title);
            result = fetch_netease(&client, &search_title, &artist).await;
        }
        
        // 3. Lyrica
        if result.is_none() {
            println!("[lyrics] NetEase miss, trying Lyrica for: {}", search_title);
            result = fetch_lyrica(&client, &search_title, &artist).await;
        }

        // If we found something, cache it, save it, and break the loop!
        if let Some(data) = result {
            println!("[lyrics] hit {} for: {}", data.source, search_title);
            let mut cache = lyrics_cache().lock().unwrap();
            cache.insert(cache_key, CachedLyrics { data: data.clone(), fetched_at: Instant::now() });
            final_result = Some(data);
            break;
        }
    }

    // 4. Handle the final result
    match final_result {
        Some(mut data) => {
            // Apply sync adjustment if needed
            if let Some(ref mut synced) = data.synced {
                if let Some(ct) = current_time {
                    let adjusted = adjust_sync(synced.clone(), ct);
                    *synced = adjusted;
                }
            }
            Ok(data)
        }
        None => {
            Err("No lyrics found across all sources and fallbacks.".into())
        }
    }
}

#[tauri::command]
pub async fn report_missing_lyrics(title: String, artist: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    
    let worker_url = "https://audos-lyrics-reporter.soham-2004.workers.dev/"; 
    
    // Use env! to read the value injected by build.rs at compile time
    let secret = env!("AUDOS_SECRET");
    
    let body = serde_json::json!({
        "title": title,
        "artist": artist
    });

    let resp = client.post(worker_url)
        .header("User-Agent", "Audos-App")
        .header("X-Audos-Secret", secret)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("Worker error: {}", resp.status()))
    }
}