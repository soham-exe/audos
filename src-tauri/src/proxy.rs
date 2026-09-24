use axum::{
    extract::Query,
    http::{HeaderMap, HeaderName, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use reqwest::Client;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

use crate::yt_bridge::get_stream_url;


// ── Stream URL cache ──────────────────────────────────────
// yt-dlp extracts a signed CDN URL that's valid for ~6 hours.
// We cache it for 1 hour to avoid redundant extractions, and
// invalidate on 403 to handle expiry.

struct CachedUrl {
    url: String,
    fetched_at: Instant,
}

static URL_CACHE: OnceLock<Mutex<HashMap<String, CachedUrl>>> = OnceLock::new();

fn url_cache() -> &'static Mutex<HashMap<String, CachedUrl>> {
    URL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn get_stream_url_cached(yt_id: &str) -> Result<String, String> {
    // Check cache first (1-hour TTL)
    {
        let cache = url_cache().lock().unwrap();
        if let Some(entry) = cache.get(yt_id) {
            if entry.fetched_at.elapsed() < Duration::from_secs(3600) {
                return Ok(entry.url.clone());
            }
        }
    }

    // Cache miss — extract fresh
    let url = get_stream_url(yt_id).await?;

    {
        let mut cache = url_cache().lock().unwrap();
        cache.insert(yt_id.to_string(), CachedUrl {
            url: url.clone(),
            fetched_at: Instant::now(),
        });
    }

    Ok(url)
}

fn invalidate_cached_url(yt_id: &str) {
    url_cache().lock().unwrap().remove(yt_id);
}

// ── Proxy server ─────────────────────────────────────────

pub async fn start_proxy() -> Result<u16, String> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers(Any);

    let app = Router::new()
        .route("/stream", get(stream_handler))
        .layer(cors);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    Ok(port)
}

async fn stream_handler(
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let yt_id = match params.get("yt_id") {
        Some(id) => id.clone(),
        None => return (StatusCode::BAD_REQUEST, "Missing yt_id").into_response(),
    };

    // Browser sends Range headers for byte-range requests (seeking, buffering)
    let range = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Shared client with a real User-Agent
    // (YouTube's CDN 403s requests with default UA)
    let client = match Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Client build failed").into_response()
        }
    };

    // ── First attempt ──
    let url = match get_stream_url_cached(&yt_id).await {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[proxy] get_stream_url failed: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to get stream url").into_response();
        }
    };

    let mut req = client.get(&url);
    if let Some(ref r) = range {
        req = req.header(reqwest::header::RANGE, r);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[proxy] upstream request failed: {}", e);
            return (StatusCode::BAD_GATEWAY, "Upstream error").into_response();
        }
    };

    // ── Retry once on 403 with a fresh URL ──
    let resp = if resp.status() == StatusCode::FORBIDDEN {
        eprintln!("[proxy] 403 from CDN, refreshing URL and retrying");
        invalidate_cached_url(&yt_id);

        let fresh_url = match get_stream_url_cached(&yt_id).await {
            Ok(u) => u,
            Err(_) => {
                return (StatusCode::BAD_GATEWAY, "Failed to refresh stream url").into_response();
            }
        };

        let mut retry = client.get(&fresh_url);
        if let Some(ref r) = range {
            retry = retry.header(reqwest::header::RANGE, r);
        }

        match retry.send().await {
            Ok(r) => r,
            Err(_) => return (StatusCode::BAD_GATEWAY, "Retry failed").into_response(),
        }
    } else {
        resp
    };

    // ── Build the response ──
    let mut response_builder = axum::http::Response::builder().status(resp.status().as_u16());

    let headers_to_copy = [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
    ];
    for (name, value) in resp.headers() {
        if headers_to_copy.contains(&name.as_str()) {
            if let Ok(hname) = HeaderName::from_bytes(name.as_ref()) {
                response_builder = response_builder.header(hname, value.as_bytes());
            }
        }
    }

    let body = axum::body::Body::from_stream(resp.bytes_stream());
    response_builder
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Body error").into_response())
}