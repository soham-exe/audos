mod db;
mod download;
mod proxy;
mod scanner;
mod yt_bridge;
mod yt_setup;
mod home_feed;
mod radio;

use std::sync::Mutex;
use tauri::Manager;

pub struct ProxyState {
    pub port: Mutex<Option<u16>>,
}

pub struct SetupState {
    pub yt_dlp_ready: Mutex<bool>,
}

#[tauri::command]
fn get_proxy_port(state: tauri::State<'_, ProxyState>) -> Result<u16, String> {
    state
        .port
        .lock()
        .unwrap()
        .ok_or_else(|| "Proxy not ready yet".into())
}

#[tauri::command]
fn is_yt_dlp_ready(state: tauri::State<'_, SetupState>) -> bool {
    *state.yt_dlp_ready.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("no app data dir");
            let conn = db::init_db(&app_dir).expect("db init failed");

            app.manage(db::DbState { conn: Mutex::new(conn) });
            app.manage(ProxyState { port: Mutex::new(None) });
            app.manage(SetupState { yt_dlp_ready: Mutex::new(false) });

            let handle = app.handle().clone();
            let dir = app_dir.clone();

            tauri::async_runtime::spawn(async move {
                // Start proxy
                if let Ok(port) = proxy::start_proxy().await {
                    let state = handle.state::<ProxyState>();
                    *state.port.lock().unwrap() = Some(port);
                    println!("[proxy] listening on {}", port);
                }

                // Download/verify yt-dlp
                match yt_setup::download_yt_dlp(&dir).await {
                    Ok(path) => {
                        if let Ok(ver) = yt_setup::verify_yt_dlp(&path) {
                            yt_bridge::set_yt_dlp_path(path.to_string_lossy().to_string());
                            println!("[yt-dlp] ready (v{})", ver);

                            // Mark yt-dlp as ready
                            let setup = handle.state::<SetupState>();
                            *setup.yt_dlp_ready.lock().unwrap() = true;
                        }
                    }
                    Err(e) => eprintln!("[yt-dlp] setup failed: {}", e),
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::get_tracks,
            db::insert_track_cmd,
            db::delete_track_cmd,
            db::cleanup_deleted_files_cmd,
            scanner::scan_directory,
            yt_bridge::search_youtube,
            download::download_yt_track,
            home_feed::fetch_home_feed,
            home_feed::total_categories,
            radio::fetch_related_tracks,
            get_proxy_port,
            is_yt_dlp_ready,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}