use crate::yt_bridge::{get_yt_dlp_path, YtTrack};
use serde_json::Value;
use tokio::process::Command;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

/// Given a YouTube video ID, fetch YouTube's auto-generated "Mix" —
/// a radio-style list of related tracks. Used to extend the queue
/// when it runs out.
#[tauri::command]
pub async fn fetch_related_tracks(yt_id: String) -> Result<Vec<YtTrack>, String> {
    // YouTube's mix playlist is `RD<videoId>` — this is what you get
    // when you click "Start radio" on a video.
    let mix_url = format!(
        "https://www.youtube.com/watch?v={}&list=RD{}",
        yt_id, yt_id
    );

    println!("[radio] fetching related for: {}", yt_id);

    let yt_exe = get_yt_dlp_path();
    let mut cmd = Command::new(&yt_exe);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .arg("--dump-json")
        .arg("--flat-playlist")
        .arg("--playlist-end")
        .arg("30")
        .arg("--no-warnings")
        .arg(&mix_url)
        .output()
        .await
        .map_err(|e| format!("yt-dlp spawn failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in stdout.lines() {
        if line.trim().is_empty() { continue; }

        if let Ok(json) = serde_json::from_str::<Value>(line) {
            let id = json["id"].as_str().unwrap_or("").to_string();

            // Skip the seed video itself (it's the first entry in the mix)
            if id.is_empty() || id == yt_id { continue; }

            let title = json["title"].as_str().unwrap_or("").to_string();
            let uploader = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();

            let duration = json["duration"].as_f64().unwrap_or(0.0);

            // Songs only: 60s - 12min (radio mixes sometimes have
            // slightly longer tracks than pure song searches)
            if duration > 0.0 && (duration < 45.0 || duration > 720.0) {
                continue;
            }

            results.push(YtTrack {
                id: id.clone(),
                title,
                uploader,
                duration: duration as i64,
                thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id),
            });
        }
    }

    println!("[radio] got {} related tracks for {}", results.len(), yt_id);
    Ok(results)
}