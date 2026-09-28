use reqwest::Client;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

const MIN_FILE_SIZE: u64 = 15_000_000;
const MAX_AGE_DAYS: u64 = 15; // Fallback: re-download if we can't reach GitHub
const VERSION_FILE_NAME: &str = "yt-dlp.version";

fn version_file_path(app_dir: &Path) -> PathBuf {
    app_dir.join(VERSION_FILE_NAME)
}

fn read_cached_version(app_dir: &Path) -> Option<String> {
    fs::read_to_string(version_file_path(app_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_cached_version(app_dir: &Path, version: &str) {
    if let Err(e) = fs::write(version_file_path(app_dir), version) {
        eprintln!("[yt-dlp] Failed to write version file: {}", e);
    }
}

/// Fetch the latest yt-dlp version tag from GitHub's release redirect.
/// Returns Err if the network is unavailable — caller falls back to age check.
async fn get_latest_version_from_github() -> Result<String, String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Audos")
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none()) // Don't follow — we want the Location header
        .build()
        .map_err(|e| format!("Client build failed: {}", e))?;

    let response = client
        .get("https://github.com/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    // GitHub returns 302 Found with a Location header
    let status = response.status();
    if !status.is_redirection() {
        return Err(format!("Unexpected status: {}", status));
    }

    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .ok_or("No Location header")?
        .to_str()
        .map_err(|e| format!("Bad Location header: {}", e))?;

    // Location looks like: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19
    // Extract the last path segment
    let tag = location
        .rsplit('/')
        .next()
        .ok_or("Could not parse tag from Location")?
        .to_string();

    if tag.is_empty() {
        return Err("Empty tag".to_string());
    }

    Ok(tag)
}

pub async fn download_yt_dlp(app_dir: &Path) -> Result<PathBuf, String> {
    let yt_dlp_path = app_dir.join("yt-dlp.exe");

    // Try the remote version check first
    let remote_version = match get_latest_version_from_github().await {
        Ok(v) => {
            println!("[yt-dlp] Latest version on GitHub: {}", v);
            Some(v)
        }
        Err(e) => {
            println!("[yt-dlp] Could not check GitHub ({}), falling back to age check", e);
            None
        }
    };

    // Decide whether to download
    let needs_download = match (&remote_version, &yt_dlp_path) {
        (Some(remote), path) if path.exists() => {
            // Try cache first, fall back to spawning --version
            let local = read_cached_version(app_dir)
                .or_else(|| {
                    match get_local_version(path) {
                        Ok(v) => {
                            write_cached_version(app_dir, &v);
                            Some(v)
                        }
                        Err(_) => None,
                    }
                });

            match local {
                Some(local) if local == *remote => {
                    println!("[yt-dlp] Local version {} is up to date (cached)", local);
                    false
                }
                Some(local) => {
                    println!("[yt-dlp] Local {} vs remote {} — updating", local, remote);
                    true
                }
                None => {
                    println!("[yt-dlp] Could not determine local version, will download");
                    true
                }
            }
        }
        (Some(_), _) => true,
        (None, path) => !is_valid_yt_dlp_by_age(path)?,
    };

    if !needs_download && yt_dlp_path.exists() {
        println!("[yt-dlp] Using existing binary at: {:?}", yt_dlp_path);
        return Ok(yt_dlp_path);
    }

    if !app_dir.exists() {
        fs::create_dir_all(app_dir)
            .map_err(|e| format!("Failed to create app directory: {}", e))?;
    }

    let urls = [
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
        "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe",
    ];

    let mut last_error = String::from("No URL attempted");

    for url in &urls {
        println!("[yt-dlp] Attempting download from: {}", url);

        let client = Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Audos")
            .timeout(std::time::Duration::from_secs(300))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        match client.get(*url).send().await {
            Ok(response) => {
                println!("[yt-dlp] Response status: {}", response.status());

                if !response.status().is_success() {
                    last_error = format!("HTTP {}", response.status());
                    continue;
                }

                match response.bytes().await {
                    Ok(bytes) => {
                        println!("[yt-dlp] Downloaded {} bytes", bytes.len());

                        if (bytes.len() as u64) < MIN_FILE_SIZE {
                            last_error = format!("File too small: {} bytes", bytes.len());
                            continue;
                        }

                        let temp_path = app_dir.join("yt-dlp.exe.tmp");
                        if let Err(e) = fs::write(&temp_path, &bytes) {
                            last_error = format!("Write failed: {}", e);
                            continue;
                        }

                        if yt_dlp_path.exists() {
                            let _ = fs::remove_file(&yt_dlp_path);
                        }

                        if let Err(e) = fs::rename(&temp_path, &yt_dlp_path) {
                            last_error = format!("Rename failed: {}", e);
                            continue;
                        }

                        println!("[yt-dlp] Successfully downloaded to: {:?}", yt_dlp_path);

                        if let Some(ref remote) = remote_version {
                            write_cached_version(app_dir, remote);
                        }

                        return Ok(yt_dlp_path);
                    }
                    Err(e) => {
                        last_error = format!("Read bytes failed: {}", e);
                        continue;
                    }
                }
            }
            Err(e) => {
                last_error = format!("Request failed: {}", e);
                continue;
            }
        }
    }

    Err(format!("All download attempts failed. Last error: {}", last_error))
}

/// Read the version string from the local yt-dlp binary by running `--version`.
fn get_local_version(path: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version");

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if !output.status.success() {
        return Err("yt-dlp --version failed".to_string());
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        return Err("Empty version".to_string());
    }
    Ok(version)
}

/// Age-based fallback: re-download if the binary is older than MAX_AGE_DAYS
/// or too small. Used only when GitHub is unreachable.
fn is_valid_yt_dlp_by_age(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        println!("[yt-dlp] Binary not found, will download");
        return Ok(false);
    }

    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;

    if metadata.len() < MIN_FILE_SIZE {
        println!("[yt-dlp] Existing binary is too small ({} bytes)", metadata.len());
        return Ok(false);
    }

    if let Ok(modified_time) = metadata.modified() {
        if let Ok(modified_duration) = modified_time.duration_since(UNIX_EPOCH) {
            if let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) {
                let age_in_seconds = now.as_secs() - modified_duration.as_secs();
                let max_age_seconds = MAX_AGE_DAYS * 24 * 60 * 60;

                if age_in_seconds > max_age_seconds {
                    let days_old = age_in_seconds / (24 * 60 * 60);
                    println!("[yt-dlp] Binary is {} days old, will download", days_old);
                    return Ok(false);
                }
            }
        }
    }

    Ok(true)
}

pub fn verify_yt_dlp(yt_dlp_path: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new(yt_dlp_path);
    cmd.arg("--version");

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!("[yt-dlp] Version: {}", version);
        Ok(version)
    } else {
        let _ = fs::remove_file(yt_dlp_path);
        Err(format!(
            "yt-dlp verification failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}