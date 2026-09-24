use crate::yt_bridge::{get_yt_dlp_path, YtTrack};
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;
use chrono::{Datelike, Local};
use std::sync::OnceLock;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
pub struct CategoryFeed {
    pub category: String,
    pub tracks: Vec<YtTrack>,
}


/// All category definitions, ordered by priority.
/// The frontend requests a slice by index range.


/// Cached shuffled category order. Computed once per app launch.
static CATEGORY_ORDER: OnceLock<Vec<(&'static str, String)>> = OnceLock::new();

fn all_categories(year: i32) -> &'static [(&'static str, String)] {
    CATEGORY_ORDER.get_or_init(|| {
        // Fixed first entry
        let mut categories: Vec<(&'static str, String)> = vec![
            ("Trending Now", format!("trending songs {}", year)),
        ];
        
        // Shuffled pool
        let mut pool: Vec<(&'static str, String)> = vec![
            ("Jazz",             "jazz music".to_string()),
            ("Synthwave",        format!("synthwave music {}", year)),
            ("Lo-Fi",            format!("lo-fi songs {}", year)),
            ("Indie Rock",       format!("indie rock songs {}", year)),
            ("Neo Soul",         format!("neo soul songs {}", year)),
            ("City Pop",         "japanese city pop songs".to_string()),
            ("Live Sessions",    format!("NPR Tiny Desk concert {}", year)),

            ("Pop Hits",         format!("pop songs {}", year)),
            ("K-Pop",            format!("kpop songs {}", year)),
            ("J-Pop",            format!("jpop songs {}", year)),
            ("Latin Pop",        format!("latin pop songs {}", year)),
            ("Alternative Pop",  format!("alternative pop songs {}", year)),

            ("Hip Hop",          format!("hip hop songs {}", year)),
            ("Trap",             format!("trap music {}", year)),
            ("Drill",            format!("drill rap {}", year)),
            ("Underground Rap",  format!("underground rap {}", year)),
            ("Boom Bap",         "boom bap hip hop".to_string()),

            ("Metal",            format!("metal songs {}", year)),
            ("Classic Rock",     "classic rock songs".to_string()),
            ("Alternative Rock", format!("alternative rock {}", year)),
            ("Progressive Rock", "progressive rock songs".to_string()),
            ("Metalcore",        format!("metalcore songs {}", year)),
            ("Post Rock",        "post rock instrumental music".to_string()),

            ("EDM",              format!("EDM songs {}", year)),
            ("House",            format!("house music {}", year)),
            ("Deep House",       format!("deep house {}", year)),
            ("Techno",           format!("techno music {}", year)),
            ("Trance",           format!("trance music {}", year)),
            ("Drum & Bass",      format!("drum and bass {}", year)),
            ("Dubstep",          format!("dubstep songs {}", year)),
            ("Future Bass",      format!("future bass {}", year)),
            ("Chillstep",        "chillstep music".to_string()),

            ("R&B",              format!("R&B songs {}", year)),
            ("Soul",             "soul music".to_string()),
            ("Funk",             "funk music".to_string()),
            ("Blues",            "blues music".to_string()),
            ("Reggae",           "reggae music".to_string()),
            ("Flamenco",         "flamenco music".to_string()),

            ("Ambient",          "ambient music".to_string()),
            ("Study Music",      "study music focus playlist".to_string()),
            ("Coffeehouse",      "coffeehouse music".to_string()),
            ("Piano",            "relaxing piano music".to_string()),
            ("Acoustic",         "acoustic songs".to_string()),
            ("Sleep Music",      "sleep music".to_string()),

            ("Bollywood",        format!("bollywood songs {}", year)),
            ("Punjabi",          format!("punjabi songs {}", year)),
            ("Tamil Hits",       format!("tamil songs {}", year)),
            ("Telugu Hits",      format!("telugu songs {}", year)),
            ("Arabic",           format!("arabic songs {}", year)),

            ("Classical",        "classical music".to_string()),
            ("Violin",           "violin instrumental music".to_string()),
            ("Guitar",           "guitar instrumental music".to_string()),
            ("Orchestral",       "epic orchestral music".to_string()),

            ("Anime Openings",   format!("anime opening songs {}", year)),
            ("Anime OST",        "anime soundtrack music".to_string()),
            ("Video Game OST",   "video game soundtrack".to_string()),
            ("JRPG Music",       "JRPG soundtrack music".to_string()),

            ("Classics",         "80s or 90s classic songs".to_string()),
            ("Hidden Gems",      format!("underrated songs {}", year)),
            ("Viral Songs",      format!("viral songs {}", year)),
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

        // Fixed first + shuffled rest
        categories.extend(pool);
        categories
    })
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

    let mut handles = Vec::new();
    for (name, query) in batch {
        handles.push(tokio::spawn(async move {
            let tracks = fetch_category(&query).await.unwrap_or_default();
            CategoryFeed { category: name, tracks }
        }));
    }

    let mut feeds = Vec::new();
    for h in handles {
        if let Ok(feed) = h.await {
            feeds.push(feed);
        }
    }

    Ok(feeds)
}

#[tauri::command]
pub fn total_categories() -> usize {
    let year = Local::now().year();
    all_categories(year).len()
}


async fn fetch_category(query: &str) -> Result<Vec<YtTrack>, String> {
    let search_url = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
        urlencoding(query)
    );

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
        if line.trim().is_empty() { continue; }

        if let Ok(json) = serde_json::from_str::<Value>(line) {
            let id = json["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() { continue; }

            let title = json["title"].as_str().unwrap_or("").to_string();
            let uploader = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();

            let duration = json["duration"].as_f64().unwrap_or(0.0);

            // Songs only: 60s - 10min
            if duration > 0.0 && (duration < 60.0 || duration > 600.0) {
                continue;
            }

            if is_non_music_content(&title) { continue; }
            if is_bad_uploader(&uploader) { continue; }
            if !is_trusted_music_channel(&uploader) { continue; }

            results.push(YtTrack {
                id: id.clone(),
                title,
                uploader,
                duration: duration as i64,
                thumbnail: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id),
            });

            if results.len() >= 12 { break; }
        }
    }

    Ok(results)
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
fn is_trusted_music_channel(uploader: &str) -> bool {
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


fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "%20".to_string(),
            _ => format!("%{:02X}", c as u32 as u8),
        })
        .collect()
}