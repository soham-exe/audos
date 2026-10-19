use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant,SystemTime};
use std::fs;
use ed25519_dalek::{VerifyingKey, Signature, Verifier};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Sha256, Digest};
/// Public key that matches the private key used by sign-db.sh.
/// If you rotate keys, you MUST ship a new app version.
const EXPECTED_PUBKEY_B64: &str = "v/XpAxssLz/WGTQBzhTbIP6nyOYr+eg2xxtf8tMOhxk=";
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
                
                let lower_plain = plain.trim().to_lowercase();
                let is_junk = lower_plain.len() < 5 || lower_plain == "instrumental" || lower_plain == "[instrumental]";
                let has_synced = synced.as_ref().map_or(false, |s| !s.is_empty());
                
                if !is_junk || has_synced {
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
    let base_url = "https://cdn.jsdelivr.net/gh/soham-exe/audos-lyrics-db@latest";
    let json_url = format!("{}/lyrics_db.json", base_url);
    let sig_url  = format!("{}/lyrics_db.json.sig", base_url);

    let cache_dir = dirs::cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("audos");
    let _ = fs::create_dir_all(&cache_dir);
    let cache_json = cache_dir.join("lyrics_db.json");
    let cache_sig  = cache_dir.join("lyrics_db.json.sig");

    let mut json_text = String::new();
    let mut sig_text  = String::new();
    let mut needs_update = true;

    // 1. Check if local cache exists and is less than 24 hours old
    let cache_age_ok = fs::metadata(&cache_json)
        .and_then(|m| m.modified())
        .and_then(|t| SystemTime::now().duration_since(t).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
        .map(|age| age.as_secs() < 86400)
        .unwrap_or(false);

    if cache_age_ok {
        needs_update = false;
        if let (Ok(j), Ok(s)) = (fs::read_to_string(&cache_json), fs::read_to_string(&cache_sig)) {
            json_text = j;
            sig_text  = s;
        }
    }

    // 2. Download from CDN if missing or older than 24h
    if needs_update {
        println!("[DB] Fetching signed DB from CDN...");

        let json_resp = client.get(&json_url).send().await;
        let sig_resp  = client.get(&sig_url).send().await;

        match (json_resp, sig_resp) {
            (Ok(jr), Ok(sr)) => {
                if jr.status().is_success() && sr.status().is_success() {
                    if let (Ok(jtext), Ok(stext)) = (jr.text().await, sr.text().await) {
                        println!("[DB] Downloaded JSON length: {}, Sig length: {}", jtext.len(), stext.len());
                        
                        match verify_db_signature(&jtext, &stext) {
                            Ok(()) => {
                                println!("[DB] Signature verified ✓");
                                let changed = json_text != jtext || sig_text != stext;
                                if changed {
                                    println!("[DB] New signed DB version — updating cache.");
                                    let _ = fs::write(&cache_json, &jtext);
                                    let _ = fs::write(&cache_sig,  &stext);
                                } else {
                                    println!("[DB] Signed DB unchanged — refreshing timestamp.");
                                    if let Ok(file) = fs::OpenOptions::new().write(true).open(&cache_json) {
                                        let _ = file.set_modified(SystemTime::now());
                                    }
                                }
                                json_text = jtext;
                                sig_text  = stext;
                            }
                            Err(e) => {
                                println!("[SECURITY WARNING] DB signature verification failed: {}", e);
                                println!("[SECURITY WARNING] Rejecting download; using cache.");
                            }
                        }
                    } else {
                        println!("[DB] Failed to read response text.");
                    }
                } else {
                    println!("[DB] HTTP Error - JSON: {}, Sig: {}", jr.status(), sr.status());
                }
            }
            (Err(e1), _) => {
                println!("[DB] JSON request failed: {}", e1);
            }
            (_, Err(e2)) => {
                println!("[DB] Sig request failed: {}", e2);
            }
        }
    }


    if json_text.is_empty() { return None; }

    // 3. Re-verify the cache too (protects against local disk tampering)
    if !sig_text.is_empty() {
        if let Err(e) = verify_db_signature(&json_text, &sig_text) {
            println!("[SECURITY WARNING] Cached DB failed verification: {}", e);
            return None;
        }
    }

    // 4. Parse and search
    let json: Value = serde_json::from_str(&json_text).ok()?;
    let search_title  = title.to_lowercase().trim().to_string();
    let search_artist = artist.to_lowercase().trim().to_string();

    let mut best_match: Option<&str> = None;

    if let Value::Object(map) = &json {
        for (key, val) in map {
            let k = key.to_lowercase();
            if k.contains(&search_title) && (search_artist.is_empty() || k.contains(&search_artist)) {
                if let Some(lrc_text) = val.as_str() {
                    best_match = Some(lrc_text);
                    break;
                }
            }
        }
    }

    if let Some(lrc_text) = best_match {
        let synced = parse_lrc(lrc_text, false);
        let plain = synced.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
        let trimmed = plain.trim().to_lowercase();
        
        if trimmed.len() > 5 && trimmed != "instrumental" && trimmed != "[instrumental]" {
            println!("[lyrics] Hit custom DB for: {}", title);
            return Some(LyricsData {
                plain,
                synced: if synced.is_empty() { None } else { Some(synced) },
                source: "Audos DB".into(),
            });
        }
    }

    None
}
fn verify_db_signature(json: &str, sig_b64: &str) -> Result<(), String> {
    let pubkey_bytes = B64.decode(EXPECTED_PUBKEY_B64)
        .map_err(|e| format!("bad pubkey b64: {}", e))?;
    let pubkey_arr: [u8; 32] = pubkey_bytes.try_into()
        .map_err(|_| "pubkey is not 32 bytes".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&pubkey_arr)
        .map_err(|e| format!("bad pubkey: {}", e))?;

    let clean_sig: String = sig_b64.chars().filter(|c| !c.is_whitespace()).collect();
    let sig_bytes = B64.decode(&clean_sig)
        .map_err(|e| format!("bad sig b64: {}", e))?;
    let sig_arr: [u8; 64] = sig_bytes.try_into()
        .map_err(|_| "signature is not 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&sig_arr);

    // ── STRICT NORMALIZATION (must exactly match sign_helper) ──
    let json = json.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let json = json.trim();

    // Hash the normalized JSON
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    let hash = hasher.finalize();

    // Verify the signature against the hash
    verifying_key.verify(&hash, &signature)
        .map_err(|e| format!("signature mismatch: {}", e))
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

    // ── PRIORITY 1: Check Custom DB against ALL title variations first ──
    for search_title in &search_titles {
        if let Some(data) = fetch_custom_db(&client, search_title, &artist).await {
            println!("[lyrics] hit {} for: {}", data.source, search_title);
            final_result = Some(data);
            break;
        }
    }

    // ── PRIORITY 2: If Custom DB missed, waterfall through the network APIs ──
    if final_result.is_none() {
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

            // 1. LRCLIB
            let mut result = fetch_lrclib(&client, &search_title, &artist, duration).await;
            
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
            
            // Cache successful custom DB hits under the main search key so we don't refetch it
            if data.source == "Audos DB" {
                let main_cache_key = format!("{}|{}|{}", base_title, artist, duration);
                let mut cache = lyrics_cache().lock().unwrap();
                cache.insert(main_cache_key, CachedLyrics { data: data.clone(), fetched_at: Instant::now() });
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