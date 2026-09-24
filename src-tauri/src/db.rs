use rusqlite::{Connection, Result};
use std::sync::Mutex;
use tauri::State;

pub struct DbState {
    pub conn: Mutex<Connection>,
}

pub fn init_db(app_dir: &std::path::Path) -> Result<Connection> {
    std::fs::create_dir_all(app_dir).unwrap_or_default();
    let db_path = app_dir.join("audos.db");
    let conn = Connection::open(db_path)?;

    // WAL mode: readers don't block writers, essential for scanning while playing
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cache_size", -64000)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS Tracks (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type       TEXT NOT NULL,
            file_path_or_url  TEXT NOT NULL UNIQUE,
            title             TEXT,
            artist_name       TEXT,
            album_name        TEXT,
            duration          INTEGER,
            thumbnail         TEXT
        )",
        [],
    )?;

    // Index for fast path lookups (used by cleanup + playlist resolution)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tracks_path ON Tracks(file_path_or_url)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tracks_source ON Tracks(source_type)",
        [],
    )?;

    Ok(conn)
}

#[derive(serde::Serialize)]
pub struct Track {
    pub id: i64,
    pub source_type: String,
    pub file_path_or_url: String,
    pub title: Option<String>,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration: Option<i64>,
    pub thumbnail: Option<String>,
}

#[tauri::command]
pub fn get_tracks(state: State<'_, DbState>) -> Result<Vec<Track>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, source_type, file_path_or_url, title, artist_name, album_name, duration, thumbnail
             FROM Tracks
             ORDER BY title COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Track {
                id: row.get(0)?,
                source_type: row.get(1)?,
                file_path_or_url: row.get(2)?,
                title: row.get(3)?,
                artist_name: row.get(4)?,
                album_name: row.get(5)?,
                duration: row.get(6)?,
                thumbnail: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();
    for r in rows {
        tracks.push(r.map_err(|e| e.to_string())?);
    }
    Ok(tracks)
}

pub fn insert_track(
    conn: &Connection,
    source_type: &str,
    file_path: &str,
    title: Option<&str>,
    artist_name: Option<&str>,
    album_name: Option<&str>,
    duration: Option<i64>,
    thumbnail: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO Tracks
            (source_type, file_path_or_url, title, artist_name, album_name, duration, thumbnail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_path_or_url) DO UPDATE SET
            title = excluded.title,
            artist_name = excluded.artist_name,
            album_name = excluded.album_name,
            duration = excluded.duration,
            thumbnail = excluded.thumbnail",
        (source_type, file_path, title, artist_name, album_name, duration, thumbnail),
    )?;
    Ok(())
}

#[tauri::command]
pub fn insert_track_cmd(
    state: State<'_, DbState>,
    source_type: String,
    file_path_or_url: String,
    title: Option<String>,
    artist_name: Option<String>,
    album_name: Option<String>,
    duration: Option<i64>,
    thumbnail: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    insert_track(
        &conn,
        &source_type,
        &file_path_or_url,
        title.as_deref(),
        artist_name.as_deref(),
        album_name.as_deref(),
        duration,
        thumbnail.as_deref(),
    )
    .map_err(|e| e.to_string())
}

pub fn delete_track(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM Tracks WHERE file_path_or_url = ?1", [path])?;
    Ok(())
}

#[tauri::command]
pub fn delete_track_cmd(state: State<'_, DbState>, file_path_or_url: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    delete_track(&conn, &file_path_or_url).map_err(|e| e.to_string())
}

/// Removes DB rows whose files no longer exist on disk (local files only)
pub fn cleanup_deleted_files(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path_or_url FROM Tracks WHERE source_type = 'local_file'",
    )?;
    let paths: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    let mut deleted = 0;
    for p in paths {
        if !std::path::Path::new(&p).exists() {
            deleted += conn.execute("DELETE FROM Tracks WHERE file_path_or_url = ?1", [&p])?;
        }
    }
    Ok(deleted)
}

#[tauri::command]
pub fn cleanup_deleted_files_cmd(state: State<'_, DbState>) -> Result<usize, String> {
    let conn = state.conn.lock().unwrap();
    cleanup_deleted_files(&conn).map_err(|e| e.to_string())
}