use reqwest::Client;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

const MIN_FILE_SIZE: u64 = 15_000_000; // yt-dlp.exe is typically > 15MB
const MAX_AGE_DAYS: u64 = 30; // Re-download if older than 30 days

pub async fn download_yt_dlp(app_dir: &Path) -> Result<PathBuf, String> {
    let yt_dlp_path = app_dir.join("yt-dlp.exe");
    
    // Check if existing binary is valid and not too old
    if is_valid_yt_dlp(&yt_dlp_path)? {
        println!("[yt-dlp] Using existing binary at: {:?}", yt_dlp_path);
        return Ok(yt_dlp_path);
    }
    
    // Create app directory if it doesn't exist
    if !app_dir.exists() {
        fs::create_dir_all(app_dir)
            .map_err(|e| format!("Failed to create app directory: {}", e))?;
    }
    
    // Download yt-dlp from official repo
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    println!("[yt-dlp] Downloading from: {}", url);
    
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Audos")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download yt-dlp: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Failed to download yt-dlp: HTTP {}", response.status()));
    }
    
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    // Verify the downloaded file is valid
    if (bytes.len() as u64) < MIN_FILE_SIZE {
        return Err(format!(
            "Downloaded file is too small ({} bytes), download might be corrupted",
            bytes.len()
        ));
    }
    
    // Write to temporary file first for atomic operation
    let temp_path = app_dir.join("yt-dlp.exe.tmp");
    fs::write(&temp_path, &bytes)
        .map_err(|e| format!("Failed to write temporary file: {}", e))?;
    
    // Replace old file if it exists
    if yt_dlp_path.exists() {
        fs::remove_file(&yt_dlp_path)
            .map_err(|e| format!("Failed to remove old yt-dlp: {}", e))?;
    }
    
    // Rename temp file to final name (atomic on Windows)
    fs::rename(&temp_path, &yt_dlp_path)
        .map_err(|e| format!("Failed to rename temporary file: {}", e))?;
    
    println!("[yt-dlp] Successfully downloaded to: {:?}", yt_dlp_path);
    Ok(yt_dlp_path)
}

fn is_valid_yt_dlp(path: &Path) -> Result<bool, String> {
    // Check if file exists
    if !path.exists() {
        println!("[yt-dlp] Binary not found, will download");
        return Ok(false);
    }
    
    // Check file size
    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;
    
    if metadata.len() < MIN_FILE_SIZE {
        println!("[yt-dlp] Existing binary is too small ({} bytes), re-downloading", metadata.len());
        return Ok(false);
    }
    
    // Check if file is not too old
    if let Ok(modified_time) = metadata.modified() {
        if let Ok(modified_duration) = modified_time.duration_since(UNIX_EPOCH) {
            if let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) {
                let age_in_seconds = now.as_secs() - modified_duration.as_secs();
                let max_age_seconds = MAX_AGE_DAYS * 24 * 60 * 60;
                
                if age_in_seconds > max_age_seconds {
                    let days_old = age_in_seconds / (24 * 60 * 60);
                    println!("[yt-dlp] Binary is {} days old, downloading fresh version", days_old);
                    return Ok(false);
                }
            }
        }
    }
    
    Ok(true)
}

// Helper function to verify yt-dlp works
// Helper function to verify yt-dlp works
pub fn verify_yt_dlp(yt_dlp_path: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new(yt_dlp_path);
    cmd.arg("--version");

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;
    
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!("[yt-dlp] Version: {}", version);
        Ok(version)
    } else {
        // If the binary is corrupted, remove it so it gets re-downloaded
        let _ = fs::remove_file(yt_dlp_path);
        Err(format!(
            "yt-dlp verification failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

// Optional: Update yt-dlp to latest version
#[allow(dead_code)]
pub fn update_yt_dlp(yt_dlp_path: &Path) -> Result<bool, String> {
    let mut cmd = std::process::Command::new(yt_dlp_path);
    cmd.arg("-U");

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute yt-dlp update: {}", e))?;
    
    if output.status.success() {
        println!("[yt-dlp] Updated successfully");
        Ok(true)
    } else {
        Err(format!(
            "Failed to update yt-dlp: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}