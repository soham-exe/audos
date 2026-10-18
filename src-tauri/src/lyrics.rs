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
const PER_SOURCE_TIMEOUT_SECS: u64 = 4;

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
    for line in lrc.lines() {
        let mut times: Vec<i64> = Vec::new();
        let mut rest = line;
        while rest.starts_with('[') {
            let end = match rest.find(']') {
                Some(i) => i,
                None => break,
            };
            let tag = &rest[1..end];
            if let Some((m, s)) = tag.split_once(':') {
                if let (Ok(mins), Ok(secs)) = (m.parse::<i64>(), s.parse::<f64>()) {
                    times.push(mins * 60_000 + (secs * 1000.0) as i64);
                }
            }
            rest = &rest[end + 1..];
        }
        if times.is_empty() {
            continue;
        }
        let text = rest.trim().to_string();
        for time_ms in times {
            lines.push(SyncedLine { time_ms, text: text.clone() });
        }
    }
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

async fn try_lrclib(client: &Client, title: &str, artist: &str, duration: i64) -> Result<LyricsData, String> {
    let resp = client
        .get("https://lrclib.net/api/get")
        .query(&[
            ("track_name", title),
            ("artist_name", artist),
            ("duration", &duration.to_string()),
        ])
        .send()
        .await
        .map_err(|e| format!("lrclib request: {}", e))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Err("lrclib: not found".into());
    }
    if !status.is_success() {
        return Err(format!("lrclib: HTTP {}", status));
    }

    let json: Value = resp.json().await.map_err(|e| format!("lrclib parse: {}", e))?;

    if json["instrumental"].as_bool().unwrap_or(false) {
        return Err("lrclib: instrumental".into());
    }

    let plain = json["plainLyrics"].as_str().unwrap_or("").to_string();
    let synced = json["syncedLyrics"].as_str().map(parse_lrc);

    if plain.trim().is_empty() && synced.as_ref().map_or(true, |s| s.is_empty()) {
        return Err("lrclib: empty".into());
    }

    Ok(LyricsData { plain, synced, source: "LRCLIB".into() })
}

async fn try_netease(client: &Client, title: &str, artist: &str) -> Result<LyricsData, String> {
    let query = format!("{} {}", title, artist);
    let search_resp = client
        .get("https://music.163.com/api/search/get")
        .query(&[("s", query.as_str()), ("type", "1"), ("limit", "5")])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|e| format!("netease search: {}", e))?;

    if !search_resp.status().is_success() {
        return Err(format!("netease search: HTTP {}", search_resp.status()));
    }

    let search_json: Value = search_resp.json().await
        .map_err(|e| format!("netease search parse: {}", e))?;

    let song_id = search_json["result"]["songs"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|s| s["id"].as_i64())
        .ok_or("netease: no results")?;

    let lyric_resp = client
        .get("https://music.163.com/api/song/lyric")
        .query(&[("id", song_id.to_string()), ("lv", "-1".into()), ("kv", "-1".into()), ("tv", "-1".into())])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|e| format!("netease lyric: {}", e))?;

    if !lyric_resp.status().is_success() {
        return Err(format!("netease lyric: HTTP {}", lyric_resp.status()));
    }

    let lyric_json: Value = lyric_resp.json().await
        .map_err(|e| format!("netease lyric parse: {}", e))?;

    let lrc_text = lyric_json["lrc"]["lyric"].as_str().unwrap_or("").trim();
    if lrc_text.is_empty() {
        return Err("netease: empty lyric".into());
    }

    let synced = parse_lrc(lrc_text);
    if synced.is_empty() {
        return Err("netease: no timestamps".into());
    }

    let plain = synced.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");

    Ok(LyricsData { plain, synced: Some(synced), source: "NetEase".into() })
}

async fn try_jiosaavn(client: &Client, title: &str, artist: &str) -> Result<LyricsData, String> {
    let query = format!("{} {}", title, artist);
    let resp = client
        .get("https://saavn.dev/api/search/songs")
        .query(&[("query", query.as_str()), ("limit", "5")])
        .send()
        .await
        .map_err(|e| format!("jiosaavn search: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("jiosaavn: HTTP {}", resp.status()));
    }

    let json: Value = resp.json().await.map_err(|e| format!("jiosaavn parse: {}", e))?;

    let songs = json["data"]["results"].as_array().ok_or("jiosaavn: no results")?;
    if songs.is_empty() {
        return Err("jiosaavn: empty results".into());
    }

    let lyrics = songs
        .iter()
        .find_map(|s| s["lyrics"].as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();

    if lyrics.trim().is_empty() {
        return Err("jiosaavn: no lyrics field".into());
    }

    Ok(LyricsData {
        plain: lyrics,
        synced: None,
        source: "JioSaavn".into(),
    })
}

#[tauri::command]
pub async fn fetch_lyrics(title: String, artist: String, duration: i64) -> Result<LyricsData, String> {
    let cache_key = format!("{}|{}|{}", title, artist, duration);

    {
        let cache = lyrics_cache().lock().unwrap();
        if let Some(entry) = cache.get(&cache_key) {
            if entry.fetched_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) {
                println!("[lyrics] cache hit ({}): {}", entry.data.source, title);
                return Ok(entry.data.clone());
            }
        }
    }

    let client = http_client()?;
    let mut errors: Vec<String> = Vec::new();

    match try_lrclib(&client, &title, &artist, duration).await {
        Ok(data) => {
            println!("[lyrics] hit LRCLIB for: {}", title);
            let mut cache = lyrics_cache().lock().unwrap();
            cache.insert(cache_key, CachedLyrics { data: data.clone(), fetched_at: Instant::now() });
            return Ok(data);
        }
        Err(e) => errors.push(format!("LRCLIB: {}", e)),
    }

    match try_netease(&client, &title, &artist).await {
        Ok(data) => {
            println!("[lyrics] hit NetEase for: {}", title);
            let mut cache = lyrics_cache().lock().unwrap();
            cache.insert(cache_key, CachedLyrics { data: data.clone(), fetched_at: Instant::now() });
            return Ok(data);
        }
        Err(e) => errors.push(format!("NetEase: {}", e)),
    }

    match try_jiosaavn(&client, &title, &artist).await {
        Ok(data) => {
            println!("[lyrics] hit JioSaavn for: {}", title);
            let mut cache = lyrics_cache().lock().unwrap();
            cache.insert(cache_key, CachedLyrics { data: data.clone(), fetched_at: Instant::now() });
            return Ok(data);
        }
        Err(e) => errors.push(format!("JioSaavn: {}", e)),
    }

    Err(format!("No lyrics found. {}", errors.join(" | ")))
}