use crate::db::{cleanup_deleted_files, insert_track, DbState};
use id3::TagLike;
use rusqlite::Connection;
use std::path::Path;
use walkdir::WalkDir;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "wav", "ogg", "opus", "aac", "wma"];

pub fn scan_dir(dir_path: &Path, conn: &Connection) {
    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };

        if !AUDIO_EXTS.contains(&ext.as_str()) {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        let filename = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Defaults from filename
        let mut title = filename.clone();
        let mut artist: Option<String> = None;
        let mut album: Option<String> = None;
        let mut thumbnail: Option<String> = None;

        // MP3 ID3 only for now. Everything else falls back to filename.
        if ext == "mp3" {
            if let Ok(tag) = id3::Tag::read_from_path(path) {
                if let Some(t) = tag.title() { title = t.to_string(); }
                if let Some(a) = tag.artist() { artist = Some(a.to_string()); }
                if let Some(al) = tag.album() { album = Some(al.to_string()); }

                if let Some(pic) = tag.pictures().next() {
                    let b64 = BASE64_STANDARD.encode(&pic.data);
                    thumbnail = Some(format!("data:{};base64,{}", pic.mime_type, b64));
                }
            }
        }

        // TODO Phase 4: probe duration via symphonia/lofty

        let _ = insert_track(
            conn,
            "local_file",
            &path_str,
            Some(&title),
            artist.as_deref(),
            album.as_deref(),
            None, // duration
            thumbnail.as_deref(),
        );
    }
}

#[tauri::command]
pub fn scan_directory(path: String, state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let _ = cleanup_deleted_files(&conn);
    scan_dir(Path::new(&path), &conn);
    Ok(())
}