use serde_json::Value;
use std::sync::OnceLock;

use std::sync::{Mutex};
use std::time::{Duration, Instant};

static LAST_SPAWN: OnceLock<Mutex<Instant>> = OnceLock::new();

/// Global throttle: ensures no two yt-dlp processes start within 1.2s of each other.
/// Call this right before every `Command::new(&yt_exe)`.
pub async fn throttle_ytdlp() {
    let lock = LAST_SPAWN.get_or_init(|| {
        Mutex::new(Instant::now() - Duration::from_secs(10))
    });

    loop {
        let wait_ms = {
            let mut last = lock.lock().unwrap();
            let elapsed = last.elapsed();
            const MIN_GAP: Duration = Duration::from_millis(1200);
            if elapsed >= MIN_GAP {
                *last = Instant::now();
                return;
            }
            (MIN_GAP - elapsed).as_millis() as u64
        };
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
    }
}

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

static YT_DLP_PATH: OnceLock<String> = OnceLock::new();

pub fn set_yt_dlp_path(path: String) {
    let _ = YT_DLP_PATH.set(path);
}

pub fn get_yt_dlp_path() -> String {
    YT_DLP_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| "yt-dlp".to_string())
}

#[derive(serde::Serialize, Clone)]
pub struct YtTrack {
    pub id: String,
    pub title: String,
    pub uploader: String,
    pub duration: i64,
    pub thumbnail: String,
}

#[tauri::command]
pub async fn find_alternative(
    title: String,
    artist: String,
    duration: i64,
) -> Result<Option<YtTrack>, String> {
    let yt_exe = get_yt_dlp_path();
    // Quoted search forces YouTube to treat the whole phrase as one query
    let query = format!("ytsearch5:\"{}\" \"{}\"", title, artist);

    throttle_ytdlp().await;
    let mut cmd = tokio::process::Command::new(&yt_exe);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }

    let output = cmd
        .arg(&query)
        .arg("--dump-json")
        .arg("--flat-playlist")
        .output()
        .await
        .map_err(|e| format!("Command failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        if line.trim().is_empty() { continue; }

        if let Ok(json) = serde_json::from_str::<Value>(line) {
            let id = json["id"].as_str().unwrap_or("").to_string();
            if id.len() != 11 { continue; }

            let t = json["title"].as_str().unwrap_or("").to_string();
            if t.is_empty() { continue; }

            let u = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("")
                .to_string();

            let d = json["duration"].as_f64().unwrap_or(0.0) as i64;

            // Duration must be within 3 seconds of the original
            let duration_ok = duration == 0 || (d - duration).abs() <= 3;
            if !duration_ok { continue; }

            // Must be from a channel we trust
            // (import these from home_feed, or duplicate the check)
            if !crate::home_feed::is_trusted_music_channel(&u)
                && !crate::home_feed::is_music_adjacent(&u)
            {
                continue;
            }

            return Ok(Some(YtTrack {
                id: id.clone(),
                title: t,
                uploader: u,
                duration: d,
                thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id),
            }));
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn search_youtube(query: String) -> Result<Vec<YtTrack>, String> {
    let yt_exe = get_yt_dlp_path();
    let search_query = format!("ytsearch10:{}", query);

    // Create the command
    throttle_ytdlp().await;
    let mut cmd = tokio::process::Command::new(&yt_exe);

    // APPLY THE HIDE FLAG HERE
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .arg(&search_query)
        .arg("--dump-json")
        .arg("--flat-playlist")
        .output()
        .await
        .map_err(|e| format!("Command failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut results = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(json) = serde_json::from_str::<Value>(line) {
            results.push(YtTrack {
                id: json["id"].as_str().unwrap_or("").to_string(),
                title: json["title"]
                    .as_str()
                    .unwrap_or("Unknown Title")
                    .to_string(),
                uploader: json["uploader"].as_str().unwrap_or("Unknown").to_string(),
                duration: json["duration"].as_f64().unwrap_or(0.0) as i64,
                thumbnail: format!(
                    "https://i.ytimg.com/vi/{}/hqdefault.jpg",
                    json["id"].as_str().unwrap_or("")
                ),
            });
        }
    }

    Ok(results)
}

pub async fn get_stream_url(yt_id: &str) -> Result<String, String> {
    let yt_exe = get_yt_dlp_path();

    for attempt in 1..=3 {
        throttle_ytdlp().await;
        let mut cmd = tokio::process::Command::new(&yt_exe);
        #[cfg(windows)]
        { cmd.creation_flags(0x08000000); }

        let output = cmd
            .arg("-g")
            .arg("-f")
            .arg("bestaudio[protocol^=http][protocol!=m3u8]/bestaudio[ext=m4a]/bestaudio")
            .arg(format!("https://www.youtube.com/watch?v={}", yt_id))
            .output()
            .await
            .map_err(|e| format!("Command failed: {}", e))?;

        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if url.starts_with("http") {
            return Ok(url);
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("page needs to be reloaded") && attempt < 3 {
            tokio::time::sleep(tokio::time::Duration::from_secs(2 * attempt as u64)).await;
            continue;
        }

        return Err(format!("Failed to extract stream URL: {}", stderr.trim()));
    }

    Err("Failed after 3 attempts".to_string())
}
