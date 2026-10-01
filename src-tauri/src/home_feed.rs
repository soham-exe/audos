use crate::yt_bridge::{get_yt_dlp_path, YtTrack};
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;
use chrono::{Datelike, Local};
use std::sync::OnceLock;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
pub struct CategoryFeed {
    pub category: String,
    pub tracks: Vec<YtTrack>,
}

use std::sync::RwLock;

static USER_REGION: OnceLock<RwLock<String>> = OnceLock::new();

fn user_region() -> String {
    USER_REGION
        .get_or_init(|| RwLock::new("Global".to_string()))
        .read()
        .unwrap()
        .clone()
}

#[tauri::command]
pub fn set_user_region(region: String) {
    println!("[region] backend region set to: {}", region);
    let lock = USER_REGION.get_or_init(|| RwLock::new("Global".to_string()));
    *lock.write().unwrap() = region;

    // Invalidate the category cache so the next fetch rebuilds it
    // with the new region.
    *category_cache().write().unwrap() = None;
}

/// All category definitions, ordered by priority.
/// The frontend requests a slice by index range.

/// Cached shuffled category order. Built lazily and rebuilt
/// whenever the user's region changes.
static CATEGORY_ORDER: OnceLock<RwLock<Option<Vec<(&'static str, String)>>>> = OnceLock::new();

fn category_cache() -> &'static RwLock<Option<Vec<(&'static str, String)>>> {
    CATEGORY_ORDER.get_or_init(|| RwLock::new(None))
}

// ── Feed caches ──
struct CachedTracks {
    tracks: Vec<YtTrack>,
    fetched_at: u64,
}

static PLAYLIST_URL_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static TRACKS_CACHE: OnceLock<Mutex<HashMap<String, CachedTracks>>> = OnceLock::new();

fn playlist_url_cache() -> &'static Mutex<HashMap<String, String>> {
    PLAYLIST_URL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tracks_cache() -> &'static Mutex<HashMap<String, CachedTracks>> {
    TRACKS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const TRACKS_TTL_SECS: u64 = 2 * 60 * 60;         // 30 min

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn all_categories(year: i32) -> Vec<(&'static str, String)> {
    // Fast path: return cached
    {
        let cache = category_cache().read().unwrap();
        if let Some(v) = cache.as_ref() {
            return v.clone();
        }
    }

    // Slow path: build once, cache
    {
        let mut lock = category_cache().write().unwrap();
        if let Some(v) = lock.as_ref() {
            return v.clone();
        }

        let region = user_region();
        let trending_query = if region == "Global" {
            format!("top {} Global hits playlist", year)
        } else {
            format!("top spotify hits {} {} playlist", year,region)
        };

        let mut categories: Vec<(&'static str, String)> = vec![
            ("Trending Now", trending_query),
        ];

        // Shuffled pool
        let mut pool: Vec<(&'static str, String)> = vec![
            // ── Top 40 / Pop ──
            ("Pop Hits",           format!("top pop hits {} playlist", year)),
            ("K-Pop",              format!("kpop hits {} playlist", year)),
            ("J-Pop",              format!("jpop hits {} playlist", year)),

            // ── Hip-Hop / Rap ──
            ("Hip Hop",            format!("hip hop hits {} playlist", year)),
            ("Trap",               format!("trap hits {} playlist", year)),
            ("Drill",              format!("drill rap {} playlist", year)),
            ("Underground Rap",    "underground rap playlist".to_string()),

            // ── Rock / Metal ──
            ("Metal",              format!("metal hits {} playlist", year)),
            ("Classic Rock",       "classic rock hits playlist".to_string()),
            ("Metalcore",          format!("metalcore {} playlist", year)),
            ("Post Rock",          "post rock instrumental playlist".to_string()),

            // ── Electronic ──
            ("EDM",                format!("edm hits {} playlist", year)),
            ("Techno",             "techno playlist".to_string()),
            ("Trance",             "trance playlist".to_string()),
            ("Future Bass",        "future bass playlist".to_string()),

            // ── Soul / R&B / Groove ──
            ("R&B",                format!("r&b hits {} playlist", year)),
            ("Soul",               "soul music playlist".to_string()),
            ("Funk",               "funk music playlist".to_string()),
            ("Blues",              "blues music playlist".to_string()),

            // ── Reggae / World ──
            ("City Pop",           "city pop playlist".to_string()),

            // ── Jazz / Lo-Fi / Chill ──
            ("Jazz",               format!("jazz hits {} playlist", year)),
            ("Lo-Fi",              format!("lofi beats {} playlist", year)),
            ("Synthwave",          "synthwave playlist".to_string()),
            ("Ambient",            "ambient music playlist".to_string()),

            // ── Study / Focus / Sleep ──
            ("Study Music",        "study music playlist".to_string()),
            ("Coffeehouse",        "coffeehouse jazz playlist".to_string()),
            ("Sleep Music",        "sleep music playlist".to_string()),

            // ── Indian / Regional ──
            ("Bollywood",          format!("bollywood hits {} playlist", year)),
            ("Punjabi",            format!("punjabi hits {} playlist", year)),
            ("Tamil Hits",         format!("tamil hits {} playlist", year)),
            ("Telugu Hits",        format!("telugu hits {} playlist", year)),
            // ── Classical / Instrumental ──
            ("Classical",          "indian classical music playlist".to_string()),
            ("Orchestral",         "orchestral playlist".to_string()),

            // ── Anime / Game ──
            ("Anime Openings",     format!("anime openings {} playlist", year)),
            ("Anime OST",          "anime soundtrack playlist".to_string()),
            ("Video Game OST",     "video game music playlist".to_string()),

            // ── Retro / Discovery ──
            ("Classics",           "80s 90s classic hits playlist".to_string()),
            ("Hidden Gems",        "underrated songs playlist".to_string()),
            ("Viral Songs",        format!("viral ticktok songs {} playlist", year)),
        ];

        // Shuffle once at init
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(1);

        let mut rng_state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let n = pool.len();
        for i in (1..n).rev() {
            rng_state = rng_state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let j = (rng_state >> 33) as usize % (i + 1);
            pool.swap(i, j);
        }

        categories.extend(pool);
        *lock = Some(categories.clone());
        categories
    }
}


/// Fetch a batch of categories by index range.
/// `start` and `end` are inclusive-exclusive (like Rust slices).
#[tauri::command]
pub async fn fetch_home_feed(start: usize, end: usize) -> Result<Vec<CategoryFeed>, String> {
    let year = Local::now().year();
    let all = all_categories(year);

    let start = start.min(all.len());
    let end = end.min(all.len());
    if start >= end {
        return Ok(Vec::new());
    }

    let batch: Vec<(String, String)> = all[start..end]
        .iter()
        .map(|(name, query)| (name.to_string(), query.clone()))
        .collect();

    println!("[home_feed] fetching batch {}..{} ({} categories)", start, end, batch.len());

    let mut feeds = Vec::new();
    for (name, query) in batch {
        let tracks = fetch_category(&query).await.unwrap_or_default();
        feeds.push(CategoryFeed { category: name, tracks });
        // Stagger between categories so we don't burst YouTube
        tokio::time::sleep(tokio::time::Duration::from_millis(900)).await;
    }

    Ok(feeds)
}

#[tauri::command]
pub fn total_categories() -> usize {
    let year = Local::now().year();
    all_categories(year).len()
}

async fn fetch_from_search(query: &str) -> Result<Vec<YtTrack>, String> {
    let search_url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
        urlencoding(query)
    );

    let yt_exe = get_yt_dlp_path();
    crate::yt_bridge::throttle_ytdlp().await;
    let mut cmd = Command::new(&yt_exe);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .arg("--dump-json")
        .arg("--flat-playlist")
        .arg("--playlist-end")
        .arg("20")
        .arg(&search_url)
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
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(json) = serde_json::from_str::<Value>(line) {
            // Skip dead entries — yt-dlp emits these for deleted/private videos
            // with `"title": null`. They have a valid id but won't play.
            if json["title"].is_null() {
                continue;
            }

            let id = json["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() || id.len() != 11 {
                continue;
            }

            let title = json["title"].as_str().unwrap_or("").to_string();
            if title.is_empty() {
                continue;
            }
                        // Reject YouTube's placeholder titles for deleted / private / unavailable videos
            let tl = title.to_lowercase();
            if tl == "[deleted video]"
                || tl == "[private video]"
                || tl == "deleted video"
                || tl == "private video"
                || tl.starts_with("[deleted")
                || tl.starts_with("[private")
                || tl == "[unavailable video]"
            {
                continue;
            }

            // ...rest of parsing
            let uploader = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();

            let duration = json["duration"].as_f64().unwrap_or(0.0);

            if duration > 0.0 && (duration < 60.0 || duration > 1200.0) {
                continue;
            }

            if is_non_music_content(&title) {
                continue;
            }
            if is_bad_uploader(&uploader) {
                continue;
            }
            if !is_trusted_music_channel(&uploader) && !is_music_adjacent(&uploader) {
                continue;
            }

            results.push(YtTrack {
                id: id.clone(),
                title,
                uploader,
                duration: duration as i64,
                thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id),
            });

            if results.len() >= 12 {
                break;
            }
        }
    }

    Ok(results)
}

async fn fetch_category(query: &str) -> Result<Vec<YtTrack>, String> {
    // ── Try the playlist path first ──
    match fetch_from_playlist(query).await {
        Ok(tracks) if tracks.len() >= 5 => {
            println!("[home_feed] '{}' → {} tracks (playlist)", query, tracks.len());
            return Ok(tracks);
        }
        Ok(tracks) => {
            println!(
                "[home_feed] '{}' → playlist yielded only {} tracks, falling back to search",
                query, tracks.len()
            );
        }
        Err(e) => {
            println!("[home_feed] '{}' → playlist path failed ({}), falling back to search", query, e);
        }
    }

    // ── Fallback: existing per-video search ──
    let tracks = fetch_from_search(query).await.unwrap_or_default();
    println!("[home_feed] '{}' → {} tracks (search)", query, tracks.len());
    Ok(tracks)
}

async fn fetch_from_playlist(query: &str) -> Result<Vec<YtTrack>, String> {
    // ── Cache check ──
    {
        let cache = tracks_cache().lock().unwrap();
        if let Some(entry) = cache.get(query) {
            let age = now_secs().saturating_sub(entry.fetched_at);

            if age < TRACKS_TTL_SECS {
                println!("[home_feed] '{}' → cache hit ({} tracks, age {}s)",
                    query, entry.tracks.len(), age);
                return Ok(entry.tracks.clone());
            }

            // Stale — return cached, refresh in background
            let cached = entry.tracks.clone();
            let q = query.to_string();
            println!("[home_feed] '{}' → stale cache (age {}s), refreshing in background",
                query, age);
            tokio::spawn(async move {
                let _ = refresh_cache_and_store(&q).await;
            });
            return Ok(cached);
        }
    }

    // ── Cold cache: fetch + store synchronously ──
    println!("[home_feed] '{}' → cold fetch", query);
    refresh_cache_and_store(query).await
}

/// Fetches fresh and stores in the tracks cache. Single source of truth
/// for cache writes so nothing can bypass it.
async fn refresh_cache_and_store(query: &str) -> Result<Vec<YtTrack>, String> {
    let tracks = fetch_playlist_contents(query).await?;

    {
        let mut cache = tracks_cache().lock().unwrap();
        cache.insert(query.to_string(), CachedTracks {
            tracks: tracks.clone(),
            fetched_at: now_secs(),
        });
    }

    Ok(tracks)
}

/// The actual work: playlist URL selection + playlist contents fetch.
async fn fetch_playlist_contents(query: &str) -> Result<Vec<YtTrack>, String> {
    // ── Resolve playlist URL (from cache or fresh search) ──
    let playlist_url = resolve_playlist_url(query).await?;

    // ── Fetch playlist contents ──
    let yt_exe = get_yt_dlp_path();
    crate::yt_bridge::throttle_ytdlp().await;
    let mut cmd = Command::new(&yt_exe);

    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }

    let output = cmd
        .arg("--dump-json")
        .arg("--flat-playlist")
        .arg("--ignore-errors")          // Skip deleted/private videos entirely
        .arg("--ignore-no-formats-error") // Skip videos with no playable formats
        .arg("--playlist-end")
        .arg("25")
        .arg("--no-warnings")
        .arg(&playlist_url)
        .output()
        .await
        .map_err(|e| format!("yt-dlp spawn failed: {}", e))?;

    if !output.status.success() {
        return Err("playlist fetch failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in stdout.lines() {
        if line.trim().is_empty() { continue; }

        if let Ok(json) = serde_json::from_str::<Value>(line) {
            if json["title"].is_null() { continue; }
            let id = json["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() || id.len() != 11 { continue; }

            let title = json["title"].as_str().unwrap_or("").to_string();
            if title.is_empty() { continue; }

            // Reject YouTube's placeholder titles for deleted / private / unavailable videos
            let tl = title.to_lowercase();
            if tl == "[deleted video]"
                || tl == "[private video]"
                || tl == "deleted video"
                || tl == "private video"
                || tl.starts_with("[deleted")
                || tl.starts_with("[private")
                || tl == "[unavailable video]"
            {
                continue;
            }

            let uploader = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();

            let duration = json["duration"].as_f64().unwrap_or(0.0);
            if duration > 0.0 && (duration < 30.0 || duration > 1800.0) { continue; }
            if is_non_music_content(&title) { continue; }

            results.push(YtTrack {
                id: id.clone(),
                title,
                uploader,
                duration: duration as i64,
                thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id),
            });

            if results.len() >= 15 { break; }
        }
    }

    Ok(results)
}

/// Returns a playlist URL for the query, from cache if possible.
/// Runs the search + scoring only on a cache miss.
async fn resolve_playlist_url(query: &str) -> Result<String, String> {
    // Cache lookup
    {
        let cache = playlist_url_cache().lock().unwrap();
        if let Some(url) = cache.get(query) {
            println!("[home_feed] '{}' → using cached playlist url", query);
            return Ok(url.clone());
        }
    }

    // Cache miss — search and score
    let search_url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAw%3D%3D",
        urlencoding(&format!("{} playlist", query))
    );

    let yt_exe = get_yt_dlp_path();
    crate::yt_bridge::throttle_ytdlp().await;
    let mut cmd = Command::new(&yt_exe);

    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }

    let output = cmd
        .arg("--dump-json")
        .arg("--flat-playlist")
        .arg("--playlist-end")
        .arg("5")
        .arg("--no-warnings")
        .arg(&search_url)
        .output()
        .await
        .map_err(|e| format!("yt-dlp spawn failed: {}", e))?;

    if !output.status.success() {
        return Err("playlist search failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut best: Option<(String, String, i64)> = None;

    for line in stdout.lines() {
        if line.trim().is_empty() { continue; }

        if let Ok(json) = serde_json::from_str::<Value>(line) {
            let id = json["id"].as_str().unwrap_or("");
            let title = json["title"].as_str().unwrap_or("").to_string();
            let uploader = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("")
                .to_string();

            if id.is_empty() || title.is_empty() { continue; }

            let score = score_playlist(query, &title, &uploader, json["playlist_count"].as_i64());
            if score <= 0 { continue; }

            let url = format!("https://www.youtube.com/playlist?list={}", id);
            println!("[home_feed] playlist candidate: '{}' (score {})", title, score);

            match &best {
                Some((_, _, best_score)) if *best_score >= score => {}
                _ => best = Some((url, title, score)),
            }
        }
    }

    let (url, title, _) = best.ok_or_else(|| "no suitable playlist found".to_string())?;
    println!("[home_feed] selected playlist: '{}' → {}", title, url);

    {
        let mut cache = playlist_url_cache().lock().unwrap();
        cache.insert(query.to_string(), url.clone());
    }

    Ok(url)
}

/// Score a playlist candidate. Higher is better. Zero or below = reject.
/// `query` is the original category query so we can require relevance.
fn score_playlist(query: &str, title: &str, uploader: &str, playlist_count: Option<i64>) -> i64 {
    let t = title.to_lowercase();
    let u = uploader.to_lowercase();

    // ── Query relevance check ──
    // Normalize hyphens and spaces so "kpop" matches "k-pop"
    let title_normalized = t.replace('-', "").replace(' ', "");

    // Filler words that appear in almost every playlist title
    let filler: &[&str] = &[
        "playlist", "playlists", "songs", "song", "music", "hits", "hit",
        "top", "best", "the", "a", "an", "and", "or", "of", "for", "to",
        "2023", "2024", "2025", "2026", "2027", "2028",
    ];

    // Extract meaningful tokens from the query
    let mut tokens: Vec<String> = Vec::new();
    for raw in query.to_lowercase().split_whitespace() {
        let cleaned: String = raw
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '&')
            .collect();
        if cleaned.is_empty() { continue; }
        if filler.contains(&cleaned.as_str()) { continue; }
        if cleaned.len() >= 3 || cleaned.contains('&') {
            tokens.push(cleaned);
        }
    }

    if !tokens.is_empty() {
        // Title must contain at least one token (with hyphen normalization)
        let has_match = tokens.iter().any(|tok| {
            let tok_normalized = tok.replace('-', "").replace(' ', "");
            title_normalized.contains(&tok_normalized)
        });
        if !has_match {
            return 0;
        }
    } else {
        // No meaningful tokens (e.g. "top hits 2026 playlist").
        // Require the playlist to look like a generic hits/charts list.
        let generic_ok = t.contains("top")
            || t.contains("chart")
            || t.contains("billboard")
            || t.contains("hits")
            || t.contains("trending")
            || t.contains("viral");
        if !generic_ok {
            return 0;
        }
    }

    // ── Hard rejects ──
    // Personal playlists (usually named "My ..." or the user's own name)
    if t.starts_with("my ") || t.starts_with("mine") {
        return 0;
    }
    // Full album uploads masquerading as playlists
    if t.contains("full album") || t.contains("(full album)") {
        return 0;
    }
    // Single artist playlists (we want variety)
    if t.contains(" - greatest hits") || (t.contains("best of ") && !t.contains("various")) {
        // Allow "Best of 2026" but reject "Best of Drake"
        let words_after_best_of: Vec<&str> = t.split("best of ").nth(1)
            .map(|s| s.split_whitespace().take(3).collect())
            .unwrap_or_default();
        // If the next word looks like a year, allow it
        let has_year = words_after_best_of.iter().any(|w| {
            w.trim_matches(|c: char| !c.is_numeric()).parse::<i32>().is_ok()
        });
        if !has_year {
            return 0;
        }
    }

    let mut score: i64 = 0;

    // ── Positive signals ──
    if t.contains("top") || t.contains("hits") { score += 3; }
    if t.contains("chart") || t.contains("billboard") { score += 3; }
    if t.contains("playlist") { score += 2; }
    if t.contains("mix") || t.contains("collection") { score += 1; }
    if t.contains("2025") || t.contains("2026") { score += 3; }
    if t.contains("best") && !t.contains("best of") { score += 1; }

    // ── Uploader trust ──
    if is_trusted_music_channel(&u) { score += 5; }
    else if is_music_adjacent(&u) { score += 2; }

    // ── Size heuristics ──
    if let Some(count) = playlist_count {
        if count < 10 {
            score -= 3;
        } else if count >= 20 && count <= 200 {
            score += 3;
        } else if count > 500 {
            score -= 1;
        }
    }

    // ── Bad uploader check ──
    if is_bad_uploader(&u) { return 0; }

    score
}

fn is_non_music_content(title: &str) -> bool {
    let t = title.to_lowercase();

    // Strong indicators that this is NOT music
    const REJECT: &[&str] = &[
        // Reactions / commentary
        "reaction",
        "reacts to",
        "reacting to",
        "review",
        "analysis",
        "explained",
        "breakdown",
        "video essay",
        "deep dive",

        // Podcasts / interviews
        "podcast",
        "interview",
        "conversation with",
        "talk show",

        // Tutorials / education
        "tutorial",
        "how to",
        "how i",
        "guide",
        "walkthrough",
        "lesson",
        "course",

        // Rankings / lists
        "top 10",
        "top 20",
        "top 50",
        "top 100",
        "ranking",
        "tier list",
        "best songs of",

        // Gaming
        "gameplay",
        "playthrough",
        "walkthrough",
        "speedrun",
        "lets play",
        "let's play",

        // Tech / product
        "unboxing",
        "benchmark",
        "comparison",
        "vs.",
        " versus ",
        "review of",

        // Movie / TV
        "trailer",
        "teaser",
        "official trailer",
        "episode",
        "clip from",

        // Misc
        "challenge",
        "prank",
        "vlog",
        "news",
        "announcement",
        "livestream",
        "live stream",
        "webinar",
        "#shorts",
        "shorts",
    ];

    REJECT.iter().any(|s| t.contains(s))
}

fn is_bad_uploader(uploader: &str) -> bool {
    let u = uploader.to_lowercase();

    const REJECT: &[&str] = &[
        // Reaction channels
        "reaction",
        "reacts",
        "reacting",
        "reactions",
        "review",

        // Podcasts
        "podcast",

        // Commentary / drama
        "commentary",
        "drama alert",

        // Generic vloggers
        "vlog",
        "vlogger",

        // Late-night TV
        "jimmy fallon",
        "the tonight show",
        "jimmy kimmel",
        "kimmel",
        "stephen colbert",
        "late show",
        "late late show",
        "conan",

        // News
        "cnn",
        "fox news",
        "bbc news",
        "msnbc",
        "news channel",
    ];

    REJECT.iter().any(|r| u.contains(r))
}

pub fn is_trusted_music_channel(uploader: &str) -> bool {
    let u = uploader.to_lowercase();

    let trusted = [
        // --- Platform Defaults & General ---
        "vevo",
        "music",
        "official",
        "- topic",            // YouTube's auto-generated artist channels
        "audio",
        "visualizer",
        "lyric video",

        // --- Major & Heavyweight Record Labels ---
        "records",
        "label",
        "sony music",
        "universal music",
        "warner music",
        "atlantic records",
        "columbia records",
        "rca records",
        "interscope",
        "def jam",
        "republic records",
        "parlophone",
        "spinnin' records",
        "ultra music",
        "monstercat",
        "astralwerks",
        "epitaph",
        "fueled by ramen",
        "sub pop",
        "domino recording",
        "ninja tune",
        "warp records",
        "mad decent",
        "owsla",

        // --- Curated Tastemakers & Collectives ---
        "majestic casual",
        "thesoundyouneed",
        "chilledcow",         // Legacy Lofi Girl
        "lofi girl",
        "proximity",
        "trap nation",
        "bass nation",
        "chill nation",
        "house nation",
        "ukf",
        "suicideboys",
        "lirical lemon",      // Lyrical Lemonade
        "colorsxstudios",

        // --- Live Performance & Radio Networks ---
        "npr music",
        "colors",
        "kexp",
        "tiny desk",
        "boiler room",
        "cercle",
        "bbc radio",
        "live sessions",
        "mahogany sessions",
        "mixmag",
        "beatport",

        // --- Global & Specialized Multi-Media Houses ---
        "t-series",           // Indian Music Giant
        "zee music",
        "yash raj films",
        "sm entertainment",   // K-Pop Giants
        "hybe labels",
        "jyp entertainment",
        "yg entertainment",
        "bighit",
        "studiopixel",
        "vocaloid",
        "lollapalooza",
        "coachella",
    ];

    trusted.iter().any(|t| u.contains(t))
}
/// Looser fallback for uploaders that don't hit the whitelist.
/// These substrings strongly suggest the channel posts music,
/// even if it's not a major label or a known curator.
pub fn is_music_adjacent(uploader: &str) -> bool {
    let u = uploader.to_lowercase();

    const HINTS: &[&str] = &[
        // Generic music words
        "music", "audio", "song", "songs", "tune", "tunes",
        "melody", "melodies", "track", "tracks", "sound", "sounds",

        // Genres
        "jazz", "blues", "soul", "funk", "rock", "pop", "rap",
        "hip hop", "hip-hop", "r&b", "rnb",
        "metal", "punk", "indie", "alternative", "alt",
        "reggae", "country", "folk", "classical",
        "electronic", "edm", "house", "techno", "trance",
        "dubstep", "drum and bass", "dnb",
        "lo-fi", "lofi", "chill", "chillhop", "chillout",
        "ambient", "synthwave", "vaporwave",

        // Instruments
        "piano", "guitar", "violin", "cello", "bass", "drum",
        "synth", "orchestra", "orchestral", "symphony",

        // Moods / settings
        "café", "cafe", "coffee", "study", "sleep", "focus",
        "relax", "calm", "mood", "vibes", "aesthetic",
        "instrumental", "meditation",

        // Content-structure words
        "playlist", "mix", "mixes", "remix", "cover", "covers",
        "live", "session", "sessions", "concert",

        // Industry words
        "records", "recordings", "label", "studio", "prod",
        "vinyl", "hits", "nation", "entertainment", "media",
    ];

    HINTS.iter().any(|h| u.contains(h))
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "%20".to_string(),
            _ => format!("%{:02X}", c as u32 as u8),
        })
        .collect()
}