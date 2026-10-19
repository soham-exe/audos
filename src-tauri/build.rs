use std::fs;
use std::env;

fn main() {
    // 1. Check if the environment variable is already set (e.g., by GitHub Actions)
    let mut secret = env::var("AUDOS_SECRET").unwrap_or_else(|_| String::new());

    // 2. If it's not set, try to read it from the local .env file
    if secret.is_empty() {
        if let Ok(content) = fs::read_to_string(".env") {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    if key.trim() == "AUDOS_SECRET" {
                        secret = value.trim().trim_matches('"').trim_matches('\'').to_string();
                        break;
                    }
                }
            }
        }
    }

    // 3. If it's still empty, use a fallback (so local dev doesn't break)
    if secret.is_empty() {
        secret = "fallback-secret".to_string();
    }

    // 4. Inject it into the compilation
    println!("cargo:rustc-env=AUDOS_SECRET={}", secret);

    tauri_build::build()
}