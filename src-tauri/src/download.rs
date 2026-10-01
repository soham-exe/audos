use crate::yt_bridge::get_yt_dlp_path;

/// Sanitize a string to be a valid filename
fn sanitize_filename(name: &str) -> String {
    name
        .chars()
        .map(|c| {
            match c {
                // Replace invalid filename characters with underscores
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
                // Remove control characters
                c if c.is_control() => '_',
                _ => c,
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Turn raw yt-dlp stderr into a short, human-readable message.
fn classify_ytdlp_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();

    if s.contains("403") || s.contains("forbidden") {
        "YouTube blocked this download. It may be region-locked or age-restricted.".into()
    } else if s.contains("429") || s.contains("too many requests") {
        "Too many requests. Please wait a minute and try again.".into()
    } else if s.contains("sign in to confirm") || s.contains("cookies") {
        "YouTube is asking for verification. Try again later.".into()
    } else if s.contains("video unavailable") || s.contains("private video") {
        "This video is unavailable or private.".into()
    } else if s.contains("connection") || s.contains("timed out") || s.contains("network") {
        "Network error. Check your connection.".into()
    } else if s.contains("copyright") {
        "This video was removed due to a copyright claim.".into()
    } else {
        "Download failed. Please try again.".into()
    }
}

#[tauri::command]
pub async fn download_yt_track(
    yt_id: String,
    title: String,
    artist: String,
    thumbnail: String,
    duration: i64,
    // app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::db::DbState>,
) -> Result<String, String> {
    // 1. Get the path of the running .exe
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;

    // 2. Get the folder containing the .exe
    let exe_dir = exe_path
        .parent()
        .ok_or("Could not find executable directory")?;

    // 3. Create the "downloaded" folder inside that directory
    let lib_dir = exe_dir.join("downloaded");
    std::fs::create_dir_all(&lib_dir).map_err(|e| e.to_string())?;

    // 4. Create filename from song metadata (artist - title)
    let sanitized_artist = sanitize_filename(&artist);
    let sanitized_title = sanitize_filename(&title);
    let filename = if !sanitized_artist.is_empty() && sanitized_artist.to_lowercase() != "unknown artist" {
        format!("{} - {}.webm", sanitized_artist, sanitized_title)
    } else {
        format!("{}.webm", sanitized_title)
    };
    
    // Handle duplicate filenames by adding a counter
    let mut file_path = lib_dir.join(&filename);
    let mut counter = 1;
    while file_path.exists() {
        let base_name = if !sanitized_artist.is_empty() && sanitized_artist.to_lowercase() != "unknown artist" {
            format!("{} - {} ({})", sanitized_artist, sanitized_title, counter)
        } else {
            format!("{} ({})", sanitized_title, counter)
        };
        file_path = lib_dir.join(format!("{}.webm", base_name));
        counter += 1;
    }
    
    let yt_exe = get_yt_dlp_path();

    // Create the command
    crate::yt_bridge::throttle_ytdlp().await;
    let mut cmd = tokio::process::Command::new(&yt_exe);

    // APPLY THE HIDE FLAG HERE
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .arg("-f")
        .arg("bestaudio")
        .arg("-o")
        .arg(file_path.to_str().unwrap())
        .arg(format!("https://www.youtube.com/watch?v={}", yt_id))
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[download] yt-dlp failed: {}", stderr);
        return Err(classify_ytdlp_error(&stderr));
    }

    let file_path_str = file_path.to_string_lossy().to_string();

    let conn = state.conn.lock().unwrap();

    // Delete any prior streaming row for this yt_id (it's now superseded by
    // the downloaded file). Also delete any prior downloaded row for the
    // same yt_id if the file path changed (e.g. user deleted + re-downloaded).
    let _ = conn.execute(
        "DELETE FROM Tracks WHERE yt_id = ?1",
        [&yt_id],
    );

    // Insert the downloaded row, keeping yt_id for identity matching
    let _ = conn.execute(
        "INSERT OR REPLACE INTO Tracks
            (source_type, file_path_or_url, title, artist_name, thumbnail, duration, yt_id)
         VALUES ('downloaded_native', ?1, ?2, ?3, ?4, ?5, ?6)",
        (&file_path_str, &title, &artist, &thumbnail, &duration, &yt_id),
    );

    Ok(file_path_str)
}
