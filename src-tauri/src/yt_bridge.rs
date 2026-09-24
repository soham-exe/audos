use serde_json::Value;
use std::sync::OnceLock;

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

#[derive(serde::Serialize)]
pub struct YtTrack {
    pub id: String,
    pub title: String,
    pub uploader: String,
    pub duration: i64,
    pub thumbnail: String,
}

#[tauri::command]
pub async fn search_youtube(query: String) -> Result<Vec<YtTrack>, String> {
    let yt_exe = get_yt_dlp_path();
    let search_query = format!("ytsearch10:{}", query);

    // Create the command
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
    // Create the command
    let mut cmd = tokio::process::Command::new(&yt_exe);

    // APPLY THE HIDE FLAG HERE
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .arg("-g")
        .arg("-f")
        .arg("bestaudio[protocol^=http][protocol!=m3u8]/bestaudio[ext=m4a]/bestaudio")
        .arg(format!("https://www.youtube.com/watch?v={}", yt_id))
        .output()
        .await
        .map_err(|e| format!("Command failed: {}", e))?;

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() || !url.starts_with("http") {
        return Err("Failed to extract stream URL".into());
    }
    Ok(url)
}
