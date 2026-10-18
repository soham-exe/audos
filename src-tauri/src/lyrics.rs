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

fn parse_lrc(lrc: &str) -> Vec<SyncedLine> {
    let mut lines = Vec::new();
    let mut offset_ms: i64 = 0;

    for line in lrc.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        // Handle offset tag [offset:500]
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
            
            // Check if it's a timestamp (e.g., "00:12.34" or "01:23")
            if let Some((m, s)) = tag.split_once(':') {
                if let (Ok(mins), Ok(secs)) = (m.parse::<i64>(), s.parse::<f64>()) {
                    times.push(mins * 60_000 + (secs * 1000.0) as i64);
                } else {
                    is_meta = true; // e.g., [ar:Artist]
                }
            } else {
                is_meta = true; // e.g., [ti:Title]
            }
            rest = &rest[end + 1..];
        }

        if is_meta && times.is_empty() {
            continue; // Skip metadata lines entirely
        }

        let text = rest.trim().to_string();
        
        // Include lines even if text is empty (instrumental breaks/gaps)
        if !times.is_empty() {
            for time_ms in times {
                lines.push(SyncedLine { 
                    time_ms: time_ms + offset_ms, 
                    text: text.clone() 
                });
            }
        }
    }
    
    // Ensure chronological order
    lines.sort_by_key(|l| l.time_ms);
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
    // Try with exact duration first
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
                let synced = json["syncedLyrics"].as_str().map(parse_lrc);
                if !plain.trim().is_empty() || synced.as_ref().map_or(false, |s| !s.is_empty()) {
                    return Some(LyricsData { plain, synced, source: "LRCLIB".into() });
                }
            }
        }
    }

    // If exact duration failed, try a fuzzy search without duration
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
                    // Find the best result (first one usually)
                    if let Some(best) = arr.first() {
                        let plain = best["plainLyrics"].as_str().unwrap_or("").to_string();
                        let synced = best["syncedLyrics"].as_str().map(parse_lrc);
                        if !plain.trim().is_empty() || synced.as_ref().map_or(false, |s| !s.is_empty()) {
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
        .query(&[("id", song_id.to_string()), ("lv", "-1".into()), ("kv", "-1".into()), ("tv", "-1".into())])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .ok()?;

    if !lyric_resp.status().is_success() { return None; }
    let lyric_json = lyric_resp.json::<Value>().await.ok()?;

    let lrc_text = lyric_json["lrc"]["lyric"].as_str().unwrap_or("").trim();
    if lrc_text.is_empty() { return None; }

    let synced = parse_lrc(lrc_text);
    if synced.is_empty() { return None; }

    let plain = synced.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
    Some(LyricsData { plain, synced: Some(synced), source: "NetEase".into() })
}

async fn fetch_jiosaavn(client: &Client, title: &str, artist: &str) -> Option<LyricsData> {
    let query = format!("{} {}", title, artist);
    let resp = client
        .get("https://saavn.dev/api/search/songs")
        .query(&[("query", query.as_str()), ("limit", "5")])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() { return None; }
    let json = resp.json::<Value>().await.ok()?;

    let songs = json["data"]["results"].as_array()?;
    let lyrics = songs.iter().find_map(|s| s["lyrics"].as_str())?.to_string();

    if lyrics.trim().is_empty() { return None; }

    // JioSaavn sometimes returns synced lyrics disguised as plain text. Try to parse it.
    let synced = parse_lrc(&lyrics);
    let final_synced = if synced.len() > 2 { Some(synced) } else { None };

    Some(LyricsData {
        plain: lyrics,
        synced: final_synced,
        source: "JioSaavn".into(),
    })
}

#[tauri::command]
pub async fn fetch_lyrics(title: String, artist: String, duration: i64) -> Result<LyricsData, String> {
    // Clean up title (remove common YouTube junk in title)
    let clean_title = title
        .replace("(Official Video)", "")
        .replace("(Lyric Video)", "")
        .replace("(Audio)", "")
        .replace("[Official Music Video]", "")
        .trim()
        .to_string();

    let cache_key = format!("{}|{}|{}", clean_title, artist, duration);

    {
        let cache = lyrics_cache().lock().unwrap();
        if let Some(entry) = cache.get(&cache_key) {
            if entry.fetched_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) {
                println!("[lyrics] cache hit ({}): {}", entry.data.source, clean_title);
                return Ok(entry.data.clone());
            }
        }
    }

    let client = http_client()?;
    let mut errors: Vec<String> = Vec::new();

    let mut result = fetch_lrclib(&client, &clean_title, &artist, duration).await;
    
    if result.is_none() {
        result = fetch_netease(&client, &clean_title, &artist).await;
    }
    
    if result.is_none() {
        result = fetch_jiosaavn(&client, &clean_title, &artist).await;
    }

    match result {
        Some(data) => {
            println!("[lyrics] hit {} for: {}", data.source, clean_title);
            let mut cache = lyrics_cache().lock().unwrap();
            cache.insert(cache_key, CachedLyrics { data: data.clone(), fetched_at: Instant::now() });
            Ok(data)
        }
        None => {
            errors.push("All sources failed".into());
            Err(format!("No lyrics found. {}", errors.join(" | ")))
        }
    }
}