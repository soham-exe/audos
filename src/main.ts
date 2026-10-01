import './styles.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open, confirm as tauriConfirm, message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// ── Shared helpers (hoisted for use throughout the file) ──

// Drag state — tracks any in-progress drag so drop handlers can
// distinguish queue reorder, context→user, and external drops.
const dragState = {
    draggingIndex: -1,
    draggingTrack: null as any,
    source: null as 'user-queue' | 'context-queue' | 'external' | null,
};

function clearAllDropIndicators() {
    document.querySelectorAll('.q-item--drop-above, .q-item--drop-below')
        .forEach(el => el.classList.remove('q-item--drop-above', 'q-item--drop-below'));
}

// HTML escape — defends against quotes in track titles breaking innerHTML
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// localStorage key for queue open/closed state
const QUEUE_OPEN_KEY = 'queue_open';

// Global drag source tracking — catches drags from the main track list
// so we can distinguish them from internal queue drags.
document.addEventListener('dragstart', (e) => {
    const target = e.target as HTMLElement;
    // If the drag started inside the queue panel's user-queue section,
    // the item handler already set the source. Don't override it.
    if (target.closest('#queue-panel')) return;
    if (target.closest('.track-row, .album-card, .q-item')) {
        dragState.source = 'external';
    }
});

document.addEventListener('dragend', () => {
    // Only reset if this was an external drag (internal ones reset themselves)
    if (dragState.source === 'external') {
        dragState.source = null;
        dragState.draggingTrack = null;
        clearAllDropIndicators();
    }
});

// ==========================================
// Country list for region selection
// ==========================================
const COUNTRY_OPTIONS: string[] = [
    'Global',           // no region filter — the default
    'United States',
    'United Kingdom',
    'Canada',
    'Australia',
    'India',
    'Bangladesh',
    'Sri Lanka',
    'Nepal',
    'Japan',
    'South Korea',
    'China',
    'Taiwan',
    'Hong Kong',
    'Singapore',
    'Malaysia',
    'Indonesia',
    'Philippines',
    'Thailand',
    'Vietnam',
    'Germany',
    'France',
    'Italy',
    'Spain',
    'Portugal',
    'Netherlands',
    'Belgium',
    'Switzerland',
    'Austria',
    'Sweden',
    'Norway',
    'Denmark',
    'Finland',
    'Poland',
    'Czech Republic',
    'Hungary',
    'Romania',
    'Greece',
    'Ireland',
    'Russia',
    'Ukraine',
    'Turkey',
    'Egypt',
    'Saudi Arabia',
    'United Arab Emirates',
    'Israel',
    'South Africa',
    'Nigeria',
    'Kenya',
    'Ghana',
    'Morocco',
    'Brazil',
    'Mexico',
    'Argentina',
    'Chile',
    'Colombia',
    'Peru',
    'Venezuela',
    'New Zealand',
];

// Cached in-memory copy of the user's selected region
let userRegion: string = localStorage.getItem('audos_region') || 'Global';

import { getCurrentWindow } from '@tauri-apps/api/window';

// Show the window once the splash is in the DOM
requestAnimationFrame(() => {
    getCurrentWindow().show().catch(e => console.warn('[window] show failed:', e));
});
// ==========================================
// Theme System
// ==========================================
type ThemeName = 'paper' | 'midnight' | 'terminal' | 'glacier'| 'nightbloom'|'deep-forest'|'sakura';

// ── Bundled theme backgrounds ─────────────────
// Value can be an image (.jpg/.png/.webp) or a video (.mp4/.webm).
const BUNDLED_THEME_BACKGROUNDS: Partial<Record<ThemeName, string>> = {
    midnight: '/bg/midnight.mp4',
    glacier: '/bg/midnight.mp4',
};

function isVideoPath(path: string): boolean {
    const ext = path.toLowerCase().split('.').pop() || '';
    return ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext);
}

function applyThemeBackground(theme: ThemeName) {
    if (localStorage.getItem('app_background_path')) return;

    const video = document.getElementById('app-bg-video') as HTMLVideoElement | null;

    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
    }
    document.body.classList.remove('has-bg-video');
    document.body.style.backgroundImage = 'none';

    const src = BUNDLED_THEME_BACKGROUNDS[theme];
    if (!src) return;

    if (isVideoPath(src)) {
        if (!video) return;
        video.src = src;
        document.body.classList.add('has-bg-video');
        video.play().catch(e => console.warn('[bg-video] autoplay blocked:', e));
    } else {
        document.body.style.backgroundImage = `url('${src}')`;
    }
}

function renderTrackSkeleton(container: HTMLElement, count = 8) {
    container.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'track-list-skeleton';

    for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'skeleton-track-row';
        row.innerHTML = `
            <div class="skeleton-thumb"></div>
            <div class="skeleton-track-info">
                <div class="skeleton-line" style="width: 55%;"></div>
                <div class="skeleton-line skeleton-line--short" style="width: 30%;"></div>
            </div>
        `;
        list.appendChild(row);
    }

    container.appendChild(list);
}

// ── Skeleton loader ──────────────────────────────
function renderSkeleton(container: HTMLElement, categoryCount = 4, cardsPerRow = 6) {
    for (let i = 0; i < categoryCount; i++) {
        const section = document.createElement('div');
        section.className = 'home-feed-section';

        const title = document.createElement('div');
        title.className = 'skeleton-title';
        section.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'album-carousel';

        for (let j = 0; j < cardsPerRow; j++) {
            const card = document.createElement('div');
            card.className = 'album-card skeleton-card';
            card.innerHTML = `
                <div class="skeleton-art"></div>
                <div class="skeleton-line"></div>
                <div class="skeleton-line skeleton-line--short"></div>
            `;
            grid.appendChild(card);
        }

        section.appendChild(grid);
        container.appendChild(section);
    }
}

// ── Theme loader ──────────────────────────────
function loadTheme(name: ThemeName) {
    document.body.classList.remove('theme-paper', 'theme-midnight','theme-terminal','theme-glacier','theme-nightbloom','theme-sakura','theme-deep-forest');
    document.body.classList.add(`theme-${name}`);
    localStorage.setItem('theme', name);
    const sel = document.getElementById('theme-select') as HTMLSelectElement | null;
    if (sel) sel.value = name;
    applyThemeBackground(name);
}

// ── Boot ──────────────────────────────────────
const savedTheme = (localStorage.getItem('theme') as ThemeName) || 'glacier';
loadTheme(savedTheme);


// ==========================================
// Auto-update system
// ==========================================
// ── Update splash UI helpers ────────────────────────────────
function showUpdateSplash(version: string) {
    document.getElementById('update-splash')?.remove();

    const splash = document.createElement('div');
    splash.id = 'update-splash';
    splash.className = 'update-splash';
    splash.innerHTML = `
        <div class="update-splash-content">
            <img src="/icons/logo.svg" alt="" class="update-splash-logo" />
            <h1 class="update-splash-title">Updating Audos</h1>
            <p class="update-splash-version">Version ${version}</p>
            <div class="update-splash-bar-bg">
                <div class="update-splash-bar-fill is-indeterminate" id="update-bar-fill"></div>
            </div>
            <p class="update-splash-status" id="update-status">Preparing…</p>
            <p class="update-splash-hint">Please don't close the app</p>
        </div>
    `;
    document.body.appendChild(splash);
}

function updateSplashStatus(text: string, pct: number | null) {
    const status = document.getElementById('update-status');
    const bar = document.getElementById('update-bar-fill') as HTMLElement | null;
    if (status) status.textContent = text;

    if (bar) {
        if (pct === null) {
            // Indeterminate — animated sliding bar
            bar.classList.add('is-indeterminate');
            bar.style.width = '';
        } else {
            // Determinate — real progress
            bar.classList.remove('is-indeterminate');
            bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
    }
}

function hideUpdateSplash() {
    const el = document.getElementById('update-splash');
    if (!el) return;
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
}

// ── Update flow ─────────────────────────────────────────────
async function checkForUpdates() {
    try {
        const update = await check();
        if (!update) return;   // no update — silent

        const shouldUpdate = await tauriConfirm(
            `Version ${update.version} is available.\n\nCurrent version: ${update.currentVersion}\n\nUpdate now?`,
            { title: 'Update Available', kind: 'info' }
        );
        if (!shouldUpdate) return;

        // ── Show splash immediately ──
        showUpdateSplash(update.version);

        let downloaded = 0;
        let total = 0;

        await update.downloadAndInstall((event) => {
            if (event.event === 'Started') {
                total = event.data.contentLength ?? 0;
                console.log(`[update] downloading ${total} bytes`);
                updateSplashStatus(
                    total > 0 ? 'Starting download…' : 'Downloading…',
                    total > 0 ? 0 : null
                );
            } else if (event.event === 'Progress') {
                downloaded += event.data.chunkLength;
                if (total > 0) {
                    const pct = (downloaded / total) * 100;
                    updateSplashStatus(`Downloading… ${Math.round(pct)}%`, pct);
                } else {
                    updateSplashStatus('Downloading…', null);
                }
                console.log(`[update] +${event.data.chunkLength} bytes (${downloaded}/${total})`);
            } else if (event.event === 'Finished') {
                console.log('[update] download complete');
                updateSplashStatus('Installing…', 100);
            }
        });

        updateSplashStatus('Restarting…', 100);

        // Give the user a beat to read the final state
        await new Promise(r => setTimeout(r, 900));

        await relaunch();
    } catch (e) {
        console.warn('[update] check failed:', e);
        // If we got as far as showing the splash, remove it so the
        // user isn't stuck on a dead screen.
        hideUpdateSplash();
    }
}

// ==========================================
// yt-dlp readiness
// ==========================================
async function waitForYtDlp(maxMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const ready = await invoke<boolean>('is_yt_dlp_ready');
            if (ready) return;
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    console.warn('[setup] yt-dlp not ready after timeout');
}
// ==========================================
// Types
// ==========================================
interface Track {
    id: number | string;
    source_type: string;
    file_path_or_url: string;
    title: string | null;
    duration: number | null;
    artist_name?: string;
    album_name?: string;
    thumbnail?: string;
    yt_id?: string | null;  // original YouTube ID (survives download)
}

interface YtTrack {
    id: string;
    title: string;
    uploader: string;
    duration: number;
    thumbnail: string;
}

interface Playlist {
    name: string;
    folderPath: string;
    tracks?: string[];
}

// ==========================================
// Offline detection
// ==========================================
let isOnline = navigator.onLine;

/// Ping a lightweight Google endpoint that's designed for connectivity
/// checks. Returns 204 No Content in <50ms on a healthy connection.
/// Using GET (not HEAD) and no-cors so we don't need CORS headers.
async function pingConnectivity(timeoutMs: number): Promise<boolean> {
    if (!navigator.onLine) return false;
    try {
        await fetch('https://www.gstatic.com/generate_204', {
            method: 'GET',
            cache: 'no-store',
            mode: 'no-cors',
            signal: AbortSignal.timeout(timeoutMs),
        });
        return true;
    } catch {
        return false;
    }
}

/// Full connectivity check with a generous timeout.
/// Retries once on failure before reporting offline — a single slow
/// DNS lookup shouldn't flip the whole UI.
async function checkRealConnectivity(): Promise<boolean> {
    if (!navigator.onLine) return false;
    if (await pingConnectivity(5000)) return true;
    // One retry, short delay, in case the first packet was dropped
    await new Promise(r => setTimeout(r, 300));
    return pingConnectivity(5000);
}

/// Fast probe used inside the stream error handler.
/// Also retries once — the error handler already waited for the timeout,
/// so a second attempt costs at most 1.5s more.
async function quickConnectivityCheck(): Promise<boolean> {
    if (!navigator.onLine) return false;
    if (await pingConnectivity(3000)) return true;
    await new Promise(r => setTimeout(r, 200));
    return pingConnectivity(3000);
}

// Consecutive offline reports required before we actually flip the UI.
// Prevents a single slow ping from triggering the offline banner.
let consecutiveOfflineReports = 0;
const OFFLINE_CONFIRMATIONS_REQUIRED = 2;

function applyOnlineState(online: boolean, options?: { force?: boolean }) {
    if (!online && !options?.force) {
        // Debounce: require 2 consecutive "offline" signals
        consecutiveOfflineReports++;
        if (consecutiveOfflineReports < OFFLINE_CONFIRMATIONS_REQUIRED) {
            console.log(`[net] offline signal ${consecutiveOfflineReports}/${OFFLINE_CONFIRMATIONS_REQUIRED} — waiting for confirmation`);
            return;
        }
    }
    if (online) {
        consecutiveOfflineReports = 0;
    }

    const changed = online !== isOnline;
    isOnline = online;

    document.body.classList.toggle('is-offline', !online);

    // If we're not playing a streaming track, none of the resume /
    // offline-pause machinery applies. Local files don't care about
    // the network. Still toggle the body class + home-feed placeholder
    // (those are UI concerns), but skip the playback logic.
    if (!isCurrentTrackStreaming()) {
        if (changed && !online) {
            // Optionally still show the banner + home placeholder
            const feedsContainer = document.getElementById('home-feeds');
            if (feedsContainer && !feedsContainer.querySelector('.offline-placeholder')) {
                feedsContainer.innerHTML = `
                    <div class="offline-placeholder">
                        <img src="/icons/cloud.svg" class="offline-icon" />
                        <p>You're offline</p>
                        <span>Downloaded songs are still available in your library.</span>
                    </div>
                `;
            }
        }
        // Local playback continues, unaffected.
        return;
    }

    if (changed) {
        console.log(`[net] ${online ? 'online' : 'offline'}`);
        if (online) {
            // ── Resume any paused-for-offline playback ──
            if (pausedForOffline && currentTrack) {
                const track = currentTrack;
                console.log(`[net] resuming "${track.title}" at ${resumePosition}s`);

                // Rebuild the source URL (the old one is dead after the error)
                if (track.source_type === 'youtube_stream' && proxyPort) {
                    audio.src = `http://127.0.0.1:${proxyPort}/stream?yt_id=${track.file_path_or_url}`;
                } else if (track.source_type !== 'youtube_stream') {
                    // Local file — just reload it
                    audio.src = convertFileSrc(track.file_path_or_url);
                }

                // Restore position once metadata is loaded, then play
                const onLoaded = () => {
                    audio.removeEventListener('loadedmetadata', onLoaded);
                    try { audio.currentTime = resumePosition; } catch {}
                    audio.play().catch(e => console.warn('[net] resume play failed:', e));
                    isPlaying = true;
                    consecutiveStreamErrors = 0;   // fresh start on resume
                    const playIcon = document.getElementById('play-icon') as HTMLImageElement;
                    if (playIcon) playIcon.src = '/icons/pause.svg';
                    showToast('Resumed', 'success', 2000);
                };
                audio.addEventListener('loadedmetadata', onLoaded, { once: true });

                // If the reload errors again, the error handler will fire
                // and handle it as a fresh offline event.
                pausedForOffline = false;
                resumePosition = 0;
            }

            // Refetch home feed if it was showing an offline placeholder
            if (!isShowingPlaylist && searchInput && searchInput.value.trim() === '') {
                const feedsContainer = document.getElementById('home-feeds');
                const isEmpty = !feedsContainer
                    || feedsContainer.querySelector('.offline-placeholder')
                    || feedsContainer.children.length === 0;
                if (isEmpty) renderHomeView();
            }
        } else {
            // Went offline — capture the current position BEFORE the buffer
            // drains, so we can resume precisely when we come back.
            if (currentTrack && isPlaying && audio.currentTime > 0) {
                resumePosition = audio.currentTime;
                pausedForOffline = true;
                currentTrackInterrupted = true;
                console.log(`[net] offline — will resume "${currentTrack.title}" at ${resumePosition}s`);
            }

            // Swap home feed for a placeholder
            const feedsContainer = document.getElementById('home-feeds');
            if (feedsContainer && !feedsContainer.querySelector('.offline-placeholder')) {
                feedsContainer.innerHTML = `
                    <div class="offline-placeholder">
                        <img src="/icons/cloud.svg" class="offline-icon" />
                        <p>You're offline</p>
                        <span>Downloaded songs are still available in your library.</span>
                    </div>
                `;
            }
        }
    }
}

window.addEventListener('online', () => {
    // Trust the OS event enough to clear the offline state, but verify
    // in the background so a captive portal doesn't leave us stuck.
    consecutiveOfflineReports = 0;
    checkRealConnectivity().then(result => {
        // If verification agrees we're online, clear it. If verification
        // fails, we stay whatever we currently are.
        if (result) applyOnlineState(true, { force: true });
    });
});

window.addEventListener('offline', () => {
    // OS event is authoritative — skip the debounce and go offline
    // immediately. This keeps things snappy when the user really pulls
    // the plug.
    applyOnlineState(false, { force: true });
});

// Periodic check — every 60s, verify we're really online
// (handles Wi-Fi with no internet, captive portals, etc.)
// `force: false` means an isolated failure won't flip the UI;
// it needs two consecutive failures. The OS offline event still
// forces immediately.
setInterval(async () => {
    const real = await checkRealConnectivity();
    applyOnlineState(real);
}, 60_000);

// Initial check on boot — navigator.onLine lies on startup sometimes
checkRealConnectivity().then(applyOnlineState);


// ==========================================
// Toast notifications
// ==========================================
type ToastKind = 'info' | 'success' | 'error';

function getToastContainer(): HTMLElement {
    // Container lives inside the topbar (see index.html). If for some
    // reason it's missing, fall back to appending to body so toasts
    // never silently fail.
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    return container;
}

function showToast(
    message: string,
    kind: ToastKind = 'info',
    duration = 4000
): void {
    const container = getToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast--${kind}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger enter transition on next frame
    requestAnimationFrame(() => {
        requestAnimationFrame(() => toast.classList.add('toast--visible'));
    });

    const dismiss = () => {
        toast.classList.remove('toast--visible');
        setTimeout(() => toast.remove(), 300);
    };

    const timer = setTimeout(dismiss, duration);

    // Click to dismiss early
    toast.addEventListener('click', () => {
        clearTimeout(timer);
        dismiss();
    });
}



// ==========================================
// DOM References
// ==========================================
const searchInput = document.querySelector('.search-bar input') as HTMLInputElement;
const playBtn = document.querySelector('.play-btn') as HTMLButtonElement;
const titleEl = document.querySelector('.now-playing .track-info .title') as HTMLElement;
const artistEl = document.querySelector('.now-playing .track-info .artist') as HTMLElement;
const albumArtEl = document.querySelector('.now-playing .album-art') as HTMLElement;
const progressFill = document.querySelector('.playback-bar .progress-fill') as HTMLElement;
const progressBg = document.querySelector('.playback-bar .progress-bg') as HTMLElement;
const timeCurrent = document.querySelector('.playback-bar .time-current') as HTMLElement;
const timeTotal = document.querySelector('.playback-bar .time-total') as HTMLElement;

// ==========================================
// Core State
// ==========================================
const audio = new Audio();
let currentTracks: Track[] = [];
let displayedTracks: Track[] = [];

// ── Playback queue model (Spotify-style) ────────────────────
// userQueue: tracks the user explicitly added (Play Next / Add to Queue).
//   Plays first, in insertion order, fully user-controlled.
// contextQueue: the source list the user started playing from
//   (playlist, album, home feed category, search results, etc.).
//   Plays after userQueue empties. Radio-extends at the end.
let userQueue: Track[] = [];
let contextQueue: Track[] = [];
let contextIndex = -1;
let contextName = '';
let currentTrack: Track | null = null;

// Snapshot of contextQueue before shuffle, so we can restore original order
let originalContextQueue: Track[] = [];

let shuffleMode: 0 | 1 = 0;
let repeatMode: 0 | 1 | 2 = 0;
let isPlaying = false;
let proxyPort: number | null = null;
let downloadMode = localStorage.getItem('download_mode') || 'manual';

// Remember playback position so we can resume after a network blip
let pausedForOffline = false;
let resumePosition = 0;

// Tracks rapid stream failures to prevent skip-cascades when the network
// dies but the OS hasn't told us yet.
let consecutiveStreamErrors = 0;
let lastStreamErrorAt = 0;
const STREAM_ERROR_WINDOW_MS = 8000;   // errors within 8s count as "consecutive"
const STREAM_ERROR_THRESHOLD = 1;      // 1 strike → treat as network outage

// Set true when the current track's playback was interrupted (network,
// error, offline). `ended` should NOT auto-advance in that case.
let currentTrackInterrupted = false;

// Global rate-limit flag — set when we detect a 429 from the proxy.
// Prevents background prefetch / aggressive fetches until things cool down.
declare global {
    interface Window {
        __audosRateLimited?: boolean;
    }
}
window.__audosRateLimited = false;

/// True if the currently playing track is a streaming (network) track.
/// Used to gate network-event handling so local files aren't affected.
function isCurrentTrackStreaming(): boolean {
    return currentTrack?.source_type === 'youtube_stream';
}

/// Track actually loaded in the <audio> element. Used by prev to detect
/// desync (e.g. offline guard blocked a track but audio didn't move).
let audioLoadedTrack: Track | null = null;



// ==========================================
// Sidebar Collapse
// ==========================================
const sidebarCollapsedKey = 'sidebar_collapsed';

function applySidebarState(collapsed: boolean) {
    const app = document.getElementById('app');
    if (!app) return;
    app.classList.toggle('sidebar-collapsed', collapsed);

    // Update the toggle button's tooltip
    const btn = document.getElementById('toggle-sidebar-btn');
    if (btn) {
        btn.setAttribute('title', collapsed ? 'Expand Library' : 'Collapse Library');
    }
}

// Event delegation — survives sidebar re-renders
document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('#toggle-sidebar-btn')) return;

    const app = document.getElementById('app');
    if (!app) return;

    const isCollapsed = app.classList.contains('sidebar-collapsed');
    applySidebarState(!isCollapsed);
    localStorage.setItem(sidebarCollapsedKey, String(!isCollapsed));
});

// Restore state on boot
const savedCollapsed = localStorage.getItem(sidebarCollapsedKey) === 'true';
applySidebarState(savedCollapsed);

// ==========================================
// Playlist State
// ==========================================
let playlists: Playlist[] = JSON.parse(localStorage.getItem('playlists') || '[]');
let activePlaylistIndex = -1;
let isShowingPlaylist = false;

function savePlaylists() {
    localStorage.setItem('playlists', JSON.stringify(playlists));
}


// ==========================================
// History
// ==========================================
function getHistory(): Track[] {
    const today = new Date().toDateString();
    const raw = localStorage.getItem('play_history_full');
    if (!raw) return [];
    try {
        const data = JSON.parse(raw);
        if (data.date !== today) return [];
        return data.tracks || [];
    } catch { return []; }
}

function addToHistory(track: Track) {
    const today = new Date().toDateString();
    const raw = localStorage.getItem('play_history_full');
    let data = raw ? JSON.parse(raw) : { date: today, tracks: [] };
    if (data.date !== today) data = { date: today, tracks: [] };

    const filtered = (data.tracks as Track[]).filter(t => t.file_path_or_url !== track.file_path_or_url);
    data.tracks = [track, ...filtered].slice(0, 500);

    try {
        localStorage.setItem('play_history_full', JSON.stringify(data));
    } catch {
        data.tracks = data.tracks.slice(0, 250);
        try { localStorage.setItem('play_history_full', JSON.stringify(data)); } catch {}
    }
}

// ==========================================
// Queue Logic
// ==========================================

/// Fisher-Yates shuffle of a copy. Does not touch userQueue.
function shuffled<T>(arr: T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/// Start playing a new context (a playlist, album, home feed category,
/// search results, etc.). Clears the user queue — matches Spotify's
/// behavior when you click into a new playlist.
///
/// `tracks` — the full list the user is choosing from
/// `startIndex` — which track in that list they clicked
/// `name` — display name for "Next from: <name>"
function playContext(tracks: Track[], startIndex: number, name: string) {
    if (tracks.length === 0) return;

    originalContextQueue = [...tracks];

    if (shuffleMode === 1) {
        // Shuffle the whole list, but put the clicked track at position 0
        const clicked = tracks[startIndex];
        const rest = tracks.filter((_, i) => i !== startIndex);
        contextQueue = [clicked, ...shuffled(rest)];
        contextIndex = 0;
    } else {
        contextQueue = [...tracks];
        contextIndex = startIndex;
    }

    // NOTE: userQueue is intentionally NOT cleared here. Tracks the user
    // explicitly queued should survive context switches — the queue is
    // their intent, not the context's.

    contextName = name;
    playTrack(contextQueue[contextIndex]);
    refreshQueuePanel();
}

/// Insert a track into the user queue. `next=true` puts it at the
/// front of the queue; otherwise it goes to the end.
function addToQueue(track: Track, next = false) {
    if (next) {
        userQueue.unshift(track);
    } else {
        userQueue.push(track);
    }
    refreshQueuePanel();
}

/// Remove a specific item from the user queue by reference.
function removeFromUserQueue(track: Track) {
    const idx = userQueue.indexOf(track);
    if (idx !== -1) {
        userQueue.splice(idx, 1);
        refreshQueuePanel();
    }
}

// ==========================================
// Playlist Helpers
// ==========================================
function getPlaylistTracks(pl: Playlist): Track[] {
    if (pl.folderPath === 'VIRTUAL_LIKED_SONGS') {
        try {
            return JSON.parse(localStorage.getItem('liked_tracks_full') || '[]');
        } catch { return []; }
    }
    if (pl.folderPath === 'VIRTUAL_DOWNLOADS') {
        return currentTracks.filter(t => t.source_type === 'downloaded_native');
    }

    const norm = (p: string) => p.replace(/\\/g, '/');
    const playlistSet = pl.tracks ? new Set(pl.tracks) : null;

    return currentTracks.filter(t => {
        const isVirtual = playlistSet?.has(t.file_path_or_url) ?? false;
        const isPhysical = t.source_type !== 'youtube_stream'
            && norm(t.file_path_or_url).startsWith(norm(pl.folderPath));
        return isVirtual || isPhysical;
    });
}

// ==========================================
// Sidebar Rendering
// ==========================================
function renderSidebarPlaylist() {
    const listContainer = document.querySelector('.library-list') as HTMLElement;
    if (!listContainer) return;
    listContainer.innerHTML = '';

    if (playlists.length === 0) {
        listContainer.innerHTML = '<p style="color:#a7a7a7;font-size:13px;padding:8px;">No playlists yet. Click ➕ to add a folder.</p>';
        return;
    }

    playlists.forEach((pl, idx) => {
        const count = getPlaylistTracks(pl).length;
        const item = document.createElement('div');
        item.className = 'list-item';
        item.setAttribute('data-name', pl.name);
        if (idx === activePlaylistIndex) item.classList.add('selected');

        const thumbHtml = pl.folderPath === 'VIRTUAL_LIKED_SONGS'
            ? '<div class="item-img item-img--liked">🤍</div>'
            : pl.folderPath === 'VIRTUAL_DOWNLOADS'
            ? '<div class="item-img item-img--downloads"><img src="/icons/downloaded.svg" /></div>'
            : '<div class="item-img item-img--folder"></div>';

        item.innerHTML = `
            ${thumbHtml}
            <div class="item-info">
                <p class="item-title-row">
                    <span class="item-title-text" title="${pl.name}">${pl.name}</span>
                    <span class="item-actions">
                        <button class="rename-pl-btn" data-idx="${idx}" title="Rename">
                            <img src="/icons/edit.svg" />
                        </button>
                        <button class="delete-pl-btn" data-idx="${idx}" title="Remove from Library">
                            <img src="/icons/clear.svg" />
                        </button>
                    </span>
                </p>
                <p class="subtitle item-subtitle">${count} songs</p>
            </div>
        `;

        item.onclick = (e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            activePlaylistIndex = idx;
            isShowingPlaylist = true;
            displayedTracks = getPlaylistTracks(pl);
            renderTracks(displayedTracks, pl.name);
            renderSidebarPlaylist();
        };

        item.querySelector('.rename-pl-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            showRenameModal(pl.name, (newName) => {
                if (!newName || !newName.trim()) return;
                playlists[idx].name = newName.trim();
                savePlaylists();
                renderSidebarPlaylist();
                if (isShowingPlaylist && activePlaylistIndex === idx) {
                    renderTracks(displayedTracks, newName.trim());
                }
            });
        });

        item.querySelector('.delete-pl-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await tauriConfirm(
                `Remove "${pl.name}" from your library? (Local files will NOT be deleted)`,
                { title: 'Remove Playlist', kind: 'warning' }
            );
            if (!confirmed) return;

            playlists.splice(idx, 1);
            savePlaylists();

            if (activePlaylistIndex === idx) {
                activePlaylistIndex = -1;
                isShowingPlaylist = false;
                renderHomeView();
            } else if (activePlaylistIndex > idx) {
                activePlaylistIndex--;
            }
            renderSidebarPlaylist();
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            item.classList.add('drop-hover');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drop-hover'));
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drop-hover');
            const raw = e.dataTransfer?.getData('text/plain');
            if (!raw) return;
            try {
                const data = JSON.parse(raw);
                if (!pl.tracks) pl.tracks = [];
                if (data.action === 'enqueue_playlist') {
                    data.tracks.forEach((track: Track) => {
                        if (!pl.tracks!.includes(track.file_path_or_url)) {
                            pl.tracks!.push(track.file_path_or_url);
                        }
                    });
                } else {
                    if (!pl.tracks.includes(data.file_path_or_url)) {
                        pl.tracks.push(data.file_path_or_url);
                    }
                }
                savePlaylists();
                if (isShowingPlaylist && activePlaylistIndex === idx) {
                    displayedTracks = getPlaylistTracks(pl);
                    renderTracks(displayedTracks, pl.name);
                }
                renderSidebarPlaylist();
            } catch (err) {
                console.error('Drop failed:', err);
            }
        });

        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            document.body.classList.add('is-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    action: 'enqueue_playlist',
                    tracks: getPlaylistTracks(pl)
                }));
            }
            item.style.opacity = '0.5';
        });
        item.addEventListener('dragend', () => {
            document.body.classList.remove('is-dragging');
            item.style.opacity = '1';
        });

        listContainer.appendChild(item);
    });
}

function showRenameModal(initialValue: string, onSubmit: (value: string) => void) {
    // Remove any existing
    document.getElementById('rename-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rename-modal';
    overlay.className = 'modal-overlay';

    const card = document.createElement('div');
    card.className = 'modal-card';

    const label = document.createElement('p');
    label.textContent = 'Rename playlist';
    label.className = 'modal-label';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = initialValue;
    input.className = 'modal-input';

    const btnRow = document.createElement('div');
    btnRow.className = 'modal-btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'modal-btn';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'modal-btn modal-btn--primary';

    const close = () => overlay.remove();

    cancelBtn.onclick = close;
    saveBtn.onclick = () => {
        onSubmit(input.value);
        close();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            onSubmit(input.value);
            close();
        }
        if (e.key === 'Escape') close();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    card.appendChild(label);
    card.appendChild(input);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus + select
    setTimeout(() => {
        input.focus();
        input.select();
    }, 30);
}

// ==========================================
// Home View — multi-category feed
// ==========================================
interface CategoryFeed {
    category: string;
    tracks: YtTrack[];
}

// ── Home feed cache ──────────────────────────────────────
// Only stores categories the user has actually loaded.
// Grows as the user clicks "Load More" — never pre-fetches.
let homeFeedCache: CategoryFeed[] = [];
let homeFeedTotalCount = 0;
let homeFeedTimestamp = 0;
const HOME_FEED_TTL_MS = 30 * 60 * 1000;  // 30 minutes

let homeRenderToken = 0;
let loadedCategoryCount = 0;
let totalCategoryCount = 0;
let loadingMore = false;

const INITIAL_BATCH_SIZE = 1;
const LOAD_MORE_BATCH_SIZE = 2;
const BACKGROUND_BATCH_SIZE = 2;

// Highest category index that's been prefetched (or is being prefetched)
let prefetchingUpTo = 0;

function isHomeCacheValid(): boolean {
    return homeFeedCache.length > 0
        && Date.now() - homeFeedTimestamp < HOME_FEED_TTL_MS;
}

function clearHomeCache() {
    homeFeedCache = [];
    homeFeedTotalCount = 0;
    homeFeedTimestamp = 0;
}

function renderHomeView() {
    const myToken = ++homeRenderToken;

    isShowingPlaylist = false;
    activePlaylistIndex = -1;
    if (searchInput) searchInput.value = '';

    document.querySelectorAll('#sidebar .list-item').forEach(item => {
        item.classList.remove('selected');
    });

    const mainContentArea = document.getElementById('main-content-area');
    if (!mainContentArea) return;
    mainContentArea.innerHTML = '';

    // ─── Greeting ───────────────────────────────────────────
    const greeting = document.createElement('h2');
    greeting.className = 'section-title';
    greeting.style.fontSize = '32px';
    greeting.style.marginBottom = '24px';
    const hour = new Date().getHours();
    greeting.textContent = hour < 12 ? 'Good morning'
                       : hour < 18 ? 'Good afternoon'
                       : 'Good evening';
    mainContentArea.appendChild(greeting);
    // Refresh feed button
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh feed';
    refreshBtn.className = 'refresh-feed-btn';
    refreshBtn.onclick = () => {
        clearHomeCache();
        renderHomeView();
    };
    mainContentArea.appendChild(refreshBtn);

    // ─── Quick access tiles ─────────────────────────────────
    if (playlists.length > 0) {
        const quickGrid = document.createElement('div');
        quickGrid.className = 'quick-grid';

        playlists.slice(0, 8).forEach((pl) => {
            const tracks = getPlaylistTracks(pl);
            const trackWithThumb = tracks.find(t => t.thumbnail);
            const thumbUrl = trackWithThumb?.thumbnail || '';

            const item = document.createElement('div');
            item.className = 'quick-item';

            let imgHtml = '';
            if (pl.folderPath === 'VIRTUAL_LIKED_SONGS') {
                imgHtml = `<div class="img item-img--liked">🤍</div>`;
            } else if (pl.folderPath === 'VIRTUAL_DOWNLOADS') {
                imgHtml = `<div class="img item-img--downloads"><img src="/icons/downloaded.svg" /></div>`;
            } else if (thumbUrl) {
                imgHtml = `<div class="img" style="background: url('${thumbUrl}') center/cover;"></div>`;
            } else {
                imgHtml = `<div class="img item-img--folder"></div>`;
            }

            item.innerHTML = `${imgHtml}<span>${pl.name}</span>`;

            item.onclick = () => {
                activePlaylistIndex = playlists.findIndex(p => p.folderPath === pl.folderPath);
                isShowingPlaylist = true;
                displayedTracks = tracks;
                renderTracks(displayedTracks, pl.name);
                renderSidebarPlaylist();
            };

            quickGrid.appendChild(item);
        });

        mainContentArea.appendChild(quickGrid);
    }

    // ─── Feeds container ────────────────────────────────────
    const feedsContainer = document.createElement('div');
    feedsContainer.id = 'home-feeds';
    mainContentArea.appendChild(feedsContainer);

    // Reset per-render state (but NOT the cache)
    loadedCategoryCount = 0;
    loadingMore = false;
    prefetchingUpTo = 0;

    feedsContainer.innerHTML = '';
    renderSkeleton(feedsContainer, INITIAL_BATCH_SIZE, 6);
    // Hide splash once the home view is actually on screen
    const splash = document.getElementById('splash');
    if (splash && !splash.classList.contains('hidden')) {
        splash.classList.add('hidden');
        setTimeout(() => splash.remove(), 350);
    }

    // ────────────────────────────────────────────────────────
    // renderFeeds: builds the DOM for a set of categories
    // ────────────────────────────────────────────────────────
    const renderFeeds = (feeds: CategoryFeed[], container: HTMLElement) => {
        feeds.forEach((feed) => {
            if (!feed.tracks || feed.tracks.length < 3) return;

            const section = document.createElement('div');
            section.className = 'home-feed-section';

            const sectionTitle = document.createElement('h2');
            sectionTitle.className = 'section-title';
            sectionTitle.style.margin = '32px 0 16px 0';
            sectionTitle.textContent = feed.category;
            section.appendChild(sectionTitle);

            const grid = document.createElement('div');
            grid.className = 'album-carousel';

            const allTracks: Track[] = feed.tracks.map(t => ({
                id: t.id,
                source_type: 'youtube_stream',
                file_path_or_url: t.id,
                title: t.title,
                artist_name: t.uploader,
                duration: t.duration,
                thumbnail: t.thumbnail
            }));

            feed.tracks.forEach((t, i) => {
                const card = document.createElement('div');
                card.className = 'album-card';
                card.setAttribute('data-source', 'youtube_stream');
                card.innerHTML = `
                    <div class="album-art" style="background-image: url('${t.thumbnail}');"></div>
                    <div class="album-title">${t.title}</div>
                    <div class="album-artist">${t.uploader}</div>
                `;
                card.onclick = () => {
                    playContext(allTracks, i, feed.category);
                };
                grid.appendChild(card);
            });

            section.appendChild(grid);
            container.appendChild(section);
        });
    };

    // ────────────────────────────────────────────────────────
    // updateLoadMoreButton: renders the "Load More" button
    // ────────────────────────────────────────────────────────
    const updateLoadMoreButton = (container: HTMLElement) => {
        container.querySelector('.load-more-btn')?.remove();

        const total = homeFeedTotalCount || totalCategoryCount;
        if (total > 0 && loadedCategoryCount >= total) return;

        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.textContent = '↓ Load more';
        btn.className = 'load-more-btn';

        btn.onmouseenter = () => {
            btn.style.borderColor = 'var(--line-strong)';
            btn.style.background = 'var(--paper)';
            btn.style.color = 'var(--text)';
        };
        btn.onmouseleave = () => {
            btn.style.borderColor = 'var(--line)';
            btn.style.background = 'transparent';
            btn.style.color = 'var(--text-dim)';
        };
        btn.onclick = async () => {
            btn.textContent = 'Loading...';
            btn.disabled = true;
            await loadBatch(
                loadedCategoryCount,
                loadedCategoryCount + LOAD_MORE_BATCH_SIZE,
                true
            );
            // Prefetch the next background batch after the visible one renders
            setTimeout(() => {
                prefetchBatch(loadedCategoryCount, loadedCategoryCount + BACKGROUND_BATCH_SIZE);
            }, 1500);
        };
        container.appendChild(btn);
    };

    // ────────────────────────────────────────────────────────
    // loadBatch: fetches [start, end) OR serves from cache
    // ────────────────────────────────────────────────────────
    const loadBatch = async (start: number, end: number, append = false) => {
        if (loadingMore) return;
        loadingMore = true;

        try {
            // ── Fast path: cache covers this range ──
            if (isHomeCacheValid() && start < homeFeedCache.length) {
                const cachedEnd = Math.min(end, homeFeedCache.length);
                const cachedSlice = homeFeedCache.slice(start, cachedEnd);

                if (myToken !== homeRenderToken) return;

                totalCategoryCount = homeFeedTotalCount;

                // Cache covers the entire requested range
                if (cachedEnd >= end) {
                    if (!append) {
                        feedsContainer.innerHTML = '';
                        renderFeeds(cachedSlice, feedsContainer);
                    } else {
                        renderFeeds(cachedSlice, feedsContainer);
                    }
                    loadedCategoryCount = cachedEnd;
                    updateLoadMoreButton(feedsContainer);
                    return;
                }

                // Cache covers part of the range — fetch the gap
                const gapBatch = await invoke<CategoryFeed[]>('fetch_home_feed', {
                    start: cachedEnd,
                    end
                });
                if (myToken !== homeRenderToken) return;

                homeFeedCache.push(...gapBatch);
                homeFeedTimestamp = Date.now();

                if (!append) feedsContainer.innerHTML = '';
                renderFeeds(
                    append ? gapBatch : [...cachedSlice, ...gapBatch],
                    feedsContainer
                );
                loadedCategoryCount = end;
                updateLoadMoreButton(feedsContainer);
                return;
            }

            // ── Slow path: fetch fresh from Rust ──
            const [feeds, total] = await Promise.all([
                invoke<CategoryFeed[]>('fetch_home_feed', { start, end }),
                homeFeedTotalCount === 0
                    ? invoke<number>('total_categories')
                    : Promise.resolve(homeFeedTotalCount)
            ]);

            if (myToken !== homeRenderToken) return;

            homeFeedTotalCount = total;
            totalCategoryCount = total;

            // Populate cache
            if (start === 0) {
                homeFeedCache = [...feeds];
                homeFeedTimestamp = Date.now();
            } else {
                homeFeedCache.push(...feeds);
                homeFeedTimestamp = Date.now();
            }

            // Clear once before the loop (only for fresh, non-append loads)
            if (!append) feedsContainer.innerHTML = '';

            // Stream categories to the UI as each one arrives
            for (const feed of feeds) {
                if (myToken !== homeRenderToken) return;
                renderFeeds([feed], feedsContainer);
                // Let the browser paint between categories
                await new Promise(r => requestAnimationFrame(r));
            }

            loadedCategoryCount = end;
            updateLoadMoreButton(feedsContainer);
        } catch (e) {
            if (myToken !== homeRenderToken) return;
            console.error('[home] Batch failed:', e);
            if (!append) {
                feedsContainer.innerHTML = `<p class="feed-error">Couldn't load feed! — ${e}</p>`;
            }
        } finally {
            if (myToken === homeRenderToken) {
                loadingMore = false;
            }
        }
    };

    // ────────────────────────────────────────────────────────
    // prefetchBatch: fetches and caches categories silently
    // without rendering them. Runs in the background after the
    // visible batch finishes.
    // ────────────────────────────────────────────────────────
    const prefetchBatch = async (start: number, end: number) => {
        if (myToken !== homeRenderToken) return;
        if (start >= end) return;
        if (start < prefetchingUpTo) return; // already prefetched or in flight

        prefetchingUpTo = end;
        console.log(`[home] prefetching categories ${start}..${end}`);

        try {
            const feeds = await invoke<CategoryFeed[]>('fetch_home_feed', { start, end });
            if (myToken !== homeRenderToken) return;

            // Merge into cache — replace existing entries by category name
            for (const feed of feeds) {
                const existing = homeFeedCache.findIndex(f => f.category === feed.category);
                if (existing === -1) {
                    homeFeedCache.push(feed);
                } else {
                    homeFeedCache[existing] = feed;
                }
            }
            homeFeedTimestamp = Date.now();

            console.log(`[home] prefetched categories ${start}..${end}`);
        } catch (e) {
            console.warn(`[home] prefetch ${start}..${end} failed:`, e);
        }
    };
    
    // ────────────────────────────────────────────────────────
    // Initial render
    // ────────────────────────────────────────────────────────
        if (isHomeCacheValid()) {
        // Instant render from cache
        console.log(`[home] Rendering from cache (${homeFeedCache.length} categories)`);
        totalCategoryCount = homeFeedTotalCount;

        // Render everything currently cached
        feedsContainer.innerHTML = '';
        renderFeeds(homeFeedCache, feedsContainer);
        loadedCategoryCount = homeFeedCache.length;
        updateLoadMoreButton(feedsContainer);

        // Kick off a background prefetch for whatever comes next
        setTimeout(() => {
            prefetchBatch(loadedCategoryCount, loadedCategoryCount + BACKGROUND_BATCH_SIZE);
        }, 6000);
    } else {
        // No valid cache — fetch a small initial batch for a fast first paint
        console.log('[home] Cache miss — fetching initial batch');
        loadBatch(0, INITIAL_BATCH_SIZE).then(() => {
            // Once the initial 3 render, quietly fetch the next 8
            setTimeout(() => {
                prefetchBatch(INITIAL_BATCH_SIZE, INITIAL_BATCH_SIZE + BACKGROUND_BATCH_SIZE);
            }, 6000);
        });
    }
}

// ==========================================
// Library Fetch
// ==========================================
async function fetchAndRenderTracks() {
    try {
        const tracks: Track[] = await invoke('get_tracks');

        const hasDownloads = tracks.some(t => t.source_type === 'downloaded_native');
        if (hasDownloads && !playlists.some(p => p.folderPath === 'VIRTUAL_DOWNLOADS')) {
            const likedIdx = playlists.findIndex(p => p.folderPath === 'VIRTUAL_LIKED_SONGS');
            const newPl = { name: 'Downloads', folderPath: 'VIRTUAL_DOWNLOADS' };
            if (likedIdx !== -1) playlists.splice(likedIdx + 1, 0, newPl);
            else playlists.unshift(newPl);
            savePlaylists();
        }

        currentTracks = tracks;

        // Re-hydrate queues with fresh object references
        const currentPath = currentTrack?.file_path_or_url;
        if (currentPath) {
            const rehydrate = (t: Track) =>
                currentTracks.find(x => x.file_path_or_url === t.file_path_or_url) ?? t;

            userQueue = userQueue.map(rehydrate);
            contextQueue = contextQueue.map(rehydrate);
            originalContextQueue = originalContextQueue.map(rehydrate);
            if (currentTrack) {
                const fresh = rehydrate(currentTrack);
                currentTrack = fresh;
                const cIdx = contextQueue.indexOf(fresh);
                if (cIdx !== -1) contextIndex = cIdx;
            }
        }

        renderSidebarPlaylist();

        if (isShowingPlaylist && activePlaylistIndex >= 0 && searchInput.value.trim() === '') {
            const pl = playlists[activePlaylistIndex];
            displayedTracks = getPlaylistTracks(pl);
            renderTracks(displayedTracks, pl.name);
        } else if (searchInput.value.trim() === '') {
            renderHomeView();
        }
    } catch (e) {
        console.error('Failed to fetch tracks:', e);
    }
}

// ==========================================
// Download
// ==========================================
/// After a successful download, replace every occurrence of this yt_id
/// across liked/playlists/queue/history with the downloaded version.
/// Uses yt_id as the identity key so duplicate rows can't survive.
function migrateTrackEverywhere(ytId: string, localPath: string) {
    // ── Liked Songs ──
    try {
        const liked: Track[] = JSON.parse(localStorage.getItem('liked_tracks_full') || '[]');
        let changed = false;
        for (const t of liked) {
            if (t.source_type === 'youtube_stream' && t.file_path_or_url === ytId) {
                t.source_type = 'downloaded_native';
                t.file_path_or_url = localPath;
                changed = true;
            }
        }
        if (changed) {
            localStorage.setItem('liked_tracks_full', JSON.stringify(liked));
        }
    } catch (e) { console.error('[migrate] liked failed:', e); }

    // ── Playlists (user-saved track IDs) ──
    let playlistsChanged = false;
    for (const pl of playlists) {
        if (pl.tracks) {
            for (let i = 0; i < pl.tracks.length; i++) {
                if (pl.tracks[i] === ytId) {
                    pl.tracks[i] = localPath;
                    playlistsChanged = true;
                }
            }
        }
    }
    if (playlistsChanged) savePlaylists();

    // ── History ──
    try {
        const raw = localStorage.getItem('play_history_full');
        if (raw) {
            const data = JSON.parse(raw);
            let histChanged = false;
            for (const t of (data.tracks || [])) {
                if (t.source_type === 'youtube_stream' && t.file_path_or_url === ytId) {
                    t.source_type = 'downloaded_native';
                    t.file_path_or_url = localPath;
                    histChanged = true;
                }
            }
            if (histChanged) localStorage.setItem('play_history_full', JSON.stringify(data));
        }
    } catch (e) { console.error('[migrate] history failed:', e); }

    // ── Both queues + currently playing ──
    let queueChanged = false;
    const migrate = (t: Track) => {
        if (t.source_type === 'youtube_stream' && t.file_path_or_url === ytId) {
            t.source_type = 'downloaded_native';
            t.file_path_or_url = localPath;
            queueChanged = true;
        }
    };
    for (const t of userQueue) migrate(t);
    for (const t of contextQueue) migrate(t);
    for (const t of originalContextQueue) migrate(t);
    if (currentTrack) migrate(currentTrack);
    if (queueChanged) refreshQueuePanel();
}

async function triggerDownload(track: Track, btnEl?: HTMLElement) {
    if (btnEl) {
        btnEl.className = 'track-row-dl-btn track-row-dl-btn--loading';
        btnEl.innerHTML = '<img src="/icons/spinner.svg" />';
    }

    // Remember the original yt_id before we mutate the track object
    const ytId = track.file_path_or_url;

    try {
        const localPath: string = await invoke('download_yt_track', {
            ytId,
            title: track.title,
            artist: track.artist_name || track.title,
            thumbnail: track.thumbnail || "",
            duration: track.duration
        });

        // Migrate every reference to this yt_id across the app
        migrateTrackEverywhere(ytId, localPath);

        // Update the object the caller passed us too
        track.source_type = 'downloaded_native';
        track.file_path_or_url = localPath;

        if (btnEl) {
            btnEl.className = 'track-row-dl-btn track-row-dl-btn--success';
            btnEl.innerHTML = '<img src="/icons/downloaded.svg" />';
            // Fade the whole row's download button out after the swap
            setTimeout(() => { btnEl.style.opacity = '0'; }, 800);
        }

        if (!playlists.some(p => p.folderPath === 'VIRTUAL_DOWNLOADS')) {
            const likedIdx = playlists.findIndex(p => p.folderPath === 'VIRTUAL_LIKED_SONGS');
            const newPl = { name: 'Downloads', folderPath: 'VIRTUAL_DOWNLOADS' };
            if (likedIdx !== -1) playlists.splice(likedIdx + 1, 0, newPl);
            else playlists.unshift(newPl);
            savePlaylists();
        }

        await fetchAndRenderTracks();
        showToast('Downloaded!', 'success', 2500);
    } catch (e) {
        console.error("Download failed", e);
        if (btnEl) {
            btnEl.className = 'track-row-dl-btn track-row-dl-btn--error';
            btnEl.innerHTML = '<img src="/icons/error.svg" />';
        }
        showToast(String(e), 'error', 6000);
    }
}

// ==========================================
// Track List Rendering (virtualized)
// ==========================================
const ROW_HEIGHT = parseInt(
    getComputedStyle(document.documentElement)
        .getPropertyValue('--track-row-height').trim()
) || 60;
const ROW_GAP = parseInt(
    getComputedStyle(document.documentElement)
        .getPropertyValue('--track-row-gap-y').trim()
) || 10;
const ITEM_HEIGHT = ROW_HEIGHT + ROW_GAP;

function renderTracks(tracks: Track[], titleOverride?: string) {
    const mainContentArea = document.getElementById('main-content-area');
    if (!mainContentArea) return;
    mainContentArea.innerHTML = '';

    const header = document.createElement('h2');
    header.className = 'section-title';
    header.textContent = titleOverride || (tracks.length > 0 ? "Results" : "No results found");
    mainContentArea.appendChild(header);

    if (tracks.length === 0) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color: var(--text-faint); font-family: var(--font-mono); font-size: 12px; margin-top: 20px;';
        empty.textContent = 'Nothing here yet.';
        mainContentArea.appendChild(empty);
        return;
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'track-list';

    const BUFFER = 50;
    listDiv.style.height = `${tracks.length * ITEM_HEIGHT}px`;

    listDiv.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (isShowingPlaylist && activePlaylistIndex >= 0) {
            listDiv.classList.add('drop-hover');
        }
    });
    listDiv.addEventListener('dragleave', (e) => {
        if (e.target === listDiv) listDiv.classList.remove('drop-hover');
    });
    listDiv.addEventListener('drop', (e) => {
        e.preventDefault();
        listDiv.classList.remove('drop-hover');
        if (!isShowingPlaylist || activePlaylistIndex < 0) return;

        const raw = e.dataTransfer?.getData('text/plain');
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            const pl = playlists[activePlaylistIndex];
            if (!pl.tracks) pl.tracks = [];
            if (data.action === 'enqueue_playlist') {
                data.tracks.forEach((t: Track) => {
                    if (!pl.tracks!.includes(t.file_path_or_url)) pl.tracks!.push(t.file_path_or_url);
                });
            } else {
                if (!pl.tracks.includes(data.file_path_or_url)) pl.tracks.push(data.file_path_or_url);
            }
            savePlaylists();
            displayedTracks = getPlaylistTracks(pl);
            renderTracks(displayedTracks, pl.name);
            renderSidebarPlaylist();
        } catch (err) {
            console.error('Playlist drop failed:', err);
        }
    });

    mainContentArea.appendChild(listDiv);

    const domCache: (HTMLElement | null)[] = new Array(tracks.length).fill(null);
    const currentlyRendered = new Set<number>();

    function createTrackElement(track: Track, index: number) {
    const item = document.createElement('div');
    item.className = 'track-row';
    item.style.top = `${index * ITEM_HEIGHT}px`;
    item.setAttribute('data-source', track.source_type);

    // ── Index number (001, 002, 003 — visible only when theme sets
    //    --track-index-width > 0) ──
    const indexEl = document.createElement('span');
    indexEl.className = 'track-row-index';
    indexEl.textContent = String(index + 1).padStart(3, '0');
    item.appendChild(indexEl);

    // ── Currently playing marker (themed via --track-playing-text) ──
    if (currentTrack && currentTrack.file_path_or_url === track.file_path_or_url) {
        item.classList.add('track-row--playing');
    }

    const thumb = document.createElement('div');
    thumb.className = 'track-row-thumb';
    if (track.thumbnail) {
        thumb.innerHTML = `<img src="${track.thumbnail}" referrerpolicy="no-referrer" />`;
    } else {
        thumb.innerHTML = '<img src="/icons/music-note.svg" class="track-row-thumb-placeholder" />';
    }
    item.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'track-row-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'track-row-title-row';

    let prefixImg = '';
    if (track.source_type === 'youtube_stream') {
        prefixImg = '<img src="/icons/cloud.svg" class="track-row-prefix-icon track-row-prefix-icon--cloud" />';
    } else if (track.source_type === 'downloaded_native') {
        prefixImg = '<img src="/icons/downloaded.svg" class="track-row-prefix-icon track-row-prefix-icon--downloaded" />';
    }

    titleRow.innerHTML = `${prefixImg}<span>${track.title || 'Unknown Title'}</span>`;

    const subtitle = document.createElement('div');
    subtitle.className = 'track-row-subtitle';
    subtitle.textContent = track.artist_name || 'Unknown Artist';

    info.appendChild(titleRow);
    info.appendChild(subtitle);
    item.appendChild(info);

    if (track.source_type === 'youtube_stream' && downloadMode === 'manual') {
        const ytId = track.file_path_or_url;
        const alreadyDownloaded = currentTracks.some(
            t => t.source_type === 'downloaded_native' && t.yt_id === ytId
        );

        if (alreadyDownloaded) {
            const badge = document.createElement('span');
            badge.className = 'track-row-dl-badge';
            badge.title = 'Already downloaded';
            badge.innerHTML = '<img src="/icons/downloaded.svg" />';
            item.appendChild(badge);
        } else {
            const dlBtn = document.createElement('button');
            dlBtn.className = 'track-row-dl-btn';
            dlBtn.innerHTML = '<img src="/icons/download.svg" />';
            dlBtn.onclick = (e) => { e.stopPropagation(); triggerDownload(track, dlBtn); };
            item.appendChild(dlBtn);
        }
    }

    item.onclick = () => {
        const ctxName = isShowingPlaylist && activePlaylistIndex >= 0
            ? playlists[activePlaylistIndex]?.name ?? 'Playlist'
            : 'Results';
        playContext(tracks, index, ctxName);
    };

    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
        document.body.classList.add('is-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', JSON.stringify(track));
        }
        item.style.opacity = '0.5';
    });
    item.addEventListener('dragend', () => {
        document.body.classList.remove('is-dragging');
        item.style.opacity = '1';
    });

    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, track);
    });

    return item;
}

    const scrollContainer = mainContentArea.parentElement || window;

    function handleVirtualScroll() {
        requestAnimationFrame(() => {
            const scrollTop = (scrollContainer as any).scrollTop || window.scrollY || 0;
            const viewportHeight = (scrollContainer as any).clientHeight || window.innerHeight;

            const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
            const endIndex = Math.min(tracks.length - 1, Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + BUFFER);

            for (const idx of currentlyRendered) {
                if (idx < startIndex || idx > endIndex) {
                    const node = domCache[idx];
                    if (node?.parentNode) node.parentNode.removeChild(node);
                    currentlyRendered.delete(idx);
                }
            }

            for (let i = startIndex; i <= endIndex; i++) {
                if (!currentlyRendered.has(i)) {
                    if (!domCache[i]) domCache[i] = createTrackElement(tracks[i], i);
                    listDiv.appendChild(domCache[i]!);
                    currentlyRendered.add(i);
                }
            }
        });
    }

    if ((scrollContainer as any)._virtualScrollHandler) {
        scrollContainer.removeEventListener('scroll', (scrollContainer as any)._virtualScrollHandler);
    }
    (scrollContainer as any)._virtualScrollHandler = handleVirtualScroll;
    scrollContainer.addEventListener('scroll', handleVirtualScroll, { passive: true });

    handleVirtualScroll();
}

// ==========================================
// Context Menu
// ==========================================
function showContextMenu(x: number, y: number, track: Track) {
    document.getElementById('track-context-menu')?.remove();

    const menu = document.createElement('div');
    menu.id = 'track-context-menu';
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;   // dynamic — stays
    menu.style.top = `${y}px`;    // dynamic — stays

    const items: { label: string; action: () => void; danger?: boolean }[] = [
        { label: 'Play Next', action: () => addToQueue(track, true) },
        { label: 'Add to Queue', action: () => addToQueue(track, false) },
        { label: 'Delete from Database', action: () => deleteTrackFromDatabase(track), danger: true },
    ];

    items.forEach(({ label, action, danger }) => {
        const row = document.createElement('div');
        row.className = 'context-menu-row' + (danger ? ' context-menu-row--danger' : '');
        row.textContent = label;
        row.onclick = () => { action(); menu.remove(); };
        menu.appendChild(row);
    });

    document.body.appendChild(menu);

    const closeMenu = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

async function deleteTrackFromDatabase(track: Track) {
    console.log('[delete] called for:', track.file_path_or_url);

    const confirmed = await tauriConfirm(
        `Delete "${track.title || 'Unknown'}" from the database?`,
        { title: 'Confirm Delete', kind: 'warning' }
    );
    console.log('[delete] confirmed:', confirmed);
    if (!confirmed) return;

    try {
        console.log('[delete] invoking delete_track_cmd...');
        await invoke('delete_track_cmd', { filePathOrUrl: track.file_path_or_url });
        console.log('[delete] DB delete succeeded');

        // ── Remove from Liked Songs (localStorage) ──
        try {
            const liked: Track[] = JSON.parse(localStorage.getItem('liked_tracks_full') || '[]');
            const filtered = liked.filter(t => t.file_path_or_url !== track.file_path_or_url);
            if (filtered.length !== liked.length) {
                localStorage.setItem('liked_tracks_full', JSON.stringify(filtered));
                console.log(`[delete] Removed from Liked Songs (${liked.length} → ${filtered.length})`);
            }
        } catch (e) {
            console.error('[delete] Failed to update Liked Songs:', e);
        }

        // ── Remove from in-memory state ──
        currentTracks = currentTracks.filter(t => t.file_path_or_url !== track.file_path_or_url);
        userQueue = userQueue.filter(t => t.file_path_or_url !== track.file_path_or_url);
        contextQueue = contextQueue.filter(t => t.file_path_or_url !== track.file_path_or_url);
        originalContextQueue = originalContextQueue.filter(t => t.file_path_or_url !== track.file_path_or_url);

        for (const pl of playlists) {
            if (pl.tracks) {
                pl.tracks = pl.tracks.filter(id => id !== track.file_path_or_url);
            }
        }
        savePlaylists();

        if (currentTrack?.file_path_or_url === track.file_path_or_url) {
            currentTrack = null;
            audio.pause();
        }

        console.log('[delete] calling fetchAndRenderTracks...');
        await fetchAndRenderTracks();
        console.log('[delete] done');

        refreshQueuePanel();
    } catch (e) {
        console.error("[delete] failed:", e);
        await tauriMessage(`Failed to delete track: ${e}`, { title: 'Delete Error', kind: 'error' });
    }
}

// ==========================================
// Search
// ==========================================
let searchTimeout: any = null;

searchInput.addEventListener('input', (e) => {
    const query = (e.target as HTMLInputElement).value.trim();
    if (searchTimeout) clearTimeout(searchTimeout);

    if (query === '') {
        if (isShowingPlaylist && activePlaylistIndex >= 0) {
            const pl = playlists[activePlaylistIndex];
            displayedTracks = getPlaylistTracks(pl);
            renderTracks(displayedTracks, pl.name);
        } else {
            renderHomeView();
        }
        return;
    }

    searchTimeout = setTimeout(async () => {
        const q = query.toLowerCase();
        const localMatches = currentTracks.filter(t =>
            (t.title && t.title.toLowerCase().includes(q)) ||
            (t.artist_name && t.artist_name.toLowerCase().includes(q))
        );

        displayedTracks = [...localMatches];
        isShowingPlaylist = false;
        renderTracks(displayedTracks, localMatches.length > 0 ? 'Local Search Results' : 'Searching Online...');

        if (localMatches.length === 0) {
        const mainContentArea = document.getElementById('main-content-area');
        if (mainContentArea) {
            // Keep the "Searching YouTube..." header visible
            mainContentArea.innerHTML = '';

            const header = document.createElement('h2');
            header.className = 'section-title';
            header.textContent = 'Searching Online...';
            mainContentArea.appendChild(header);

            // Skeleton list goes below the header
            const skeletonWrapper = document.createElement('div');
            mainContentArea.appendChild(skeletonWrapper);
            renderTrackSkeleton(skeletonWrapper, 8);
        }

        try {
            const ytResults: YtTrack[] = await invoke('search_youtube', { query });

            const ytTracks: Track[] = ytResults.slice(0, 10).map(yt => ({
                id: yt.id,
                source_type: 'youtube_stream',
                file_path_or_url: yt.id,
                title: yt.title,
                artist_name: yt.uploader,
                duration: yt.duration,
                thumbnail: yt.thumbnail
            }));

            displayedTracks = [...ytTracks];
            renderTracks(displayedTracks, 'Online Results');
        } catch (err) {
            console.error('Online search failed:', err);
            renderTracks([], 'No results found (Online Error)');
        }
    }
    }, 500);
});

// ==========================================
// Playback
// ==========================================
async function playTrack(track: Track) {
    if (!track) return;

    currentTrack = track;

    // Block streaming tracks when offline — but still update the UI so
    // the player bar reflects the new track selection.
    if (track.source_type === 'youtube_stream' && !isOnline) {
        titleEl.textContent = track.title || 'Unknown Title';
        artistEl.textContent = track.artist_name || 'Unknown Artist';
        if (track.thumbnail) {
            albumArtEl.style.backgroundImage = `url('${track.thumbnail}')`;
            albumArtEl.style.backgroundSize = 'cover';
            albumArtEl.style.backgroundPosition = 'center';
        } else {
            albumArtEl.style.backgroundImage = 'none';
            albumArtEl.style.backgroundColor = 'var(--panel-strong)';
        }
        updateLikeButton(track);

        audio.pause();
        albumArtEl.classList.remove('loading', 'ready');
        isPlaying = false;
        const playIcon = document.getElementById('play-icon') as HTMLImageElement;
        if (playIcon) playIcon.src = '/icons/play.svg';

        resumePosition = 0;
        pausedForOffline = true;

        showToast('You\'re offline — this track can\'t be streamed', 'error', 4000);
        refreshQueuePanel();
        return;
    }

    addToHistory(track);

    currentTrackInterrupted = false;

    if (track.source_type !== 'youtube_stream') {
        pausedForOffline = false;
        resumePosition = 0;
        consecutiveStreamErrors = 0;
    }

    albumArtEl.classList.remove('loading', 'ready');
    albumArtEl.classList.add('loading');

    const clearThumbLoading = () => {
        albumArtEl.classList.remove('loading');
        albumArtEl.classList.add('ready');
    };

    if (track.source_type === 'youtube_stream') {
        if (!proxyPort) {
            albumArtEl.classList.remove('loading');
            await tauriMessage("Proxy server is not ready yet.", {
                title: 'Player Starting',
                kind: 'warning',
            });
            return;
        }

        audio.src = `http://127.0.0.1:${proxyPort}/stream?yt_id=${track.file_path_or_url}`;
        if (downloadMode === 'auto') triggerDownload(track);
    } else {
        audio.src = convertFileSrc(track.file_path_or_url);
    }

    // The audio element now holds this track
    audioLoadedTrack = track;

    const onCanPlay = () => {
        clearThumbLoading();
        // Playback is healthy — reset the failure counter
        consecutiveStreamErrors = 0;
    };
    audio.addEventListener('canplay', onCanPlay, { once: true });
    audio.addEventListener('error', async () => {
        albumArtEl.classList.remove('loading');

        // Local files have no network — any "error" here is a decode
        // problem, not a connectivity problem. Log and bail.
        if (track.source_type !== 'youtube_stream') {
            console.warn('[play] local file error — ignoring network logic');
            return;
        }

        // Mark this playback as interrupted — prevents `ended` from
        // auto-advancing on a truncated buffer.
        currentTrackInterrupted = true;

        // ── Immediate offline short-circuit ──
        if (!isOnline) {
            console.warn('[play] stream error while offline — pausing to resume later');
            resumePosition = audio.currentTime || 0;
            pausedForOffline = true;
            audio.pause();
            isPlaying = false;
            const playIcon = document.getElementById('play-icon') as HTMLImageElement;
            if (playIcon) playIcon.src = '/icons/play.svg';
            showToast('Lost connection — will resume when you\'re back online', 'info', 5000);
            return;
        }

        // ── Consecutive-error counter ──
        // Prevents cascade when the network dies but the OS hasn't told us.
        const now = Date.now();
        if (now - lastStreamErrorAt > STREAM_ERROR_WINDOW_MS) {
            consecutiveStreamErrors = 0;   // reset if errors are spread apart
        }
        consecutiveStreamErrors++;
        lastStreamErrorAt = now;

        console.warn(`[play] stream error #${consecutiveStreamErrors}`);

        // If we've hit the threshold, run a real connectivity check.
        // If it fails, this is a network outage — pause, don't skip.
        if (consecutiveStreamErrors >= STREAM_ERROR_THRESHOLD) {
            console.warn('[play] too many rapid errors — verifying connectivity');
            const stillOnline = await quickConnectivityCheck();

            if (!stillOnline) {
                console.warn('[play] connectivity check failed — treating as offline');
                // Force our state to offline so subsequent logic agrees
                applyOnlineState(false, { force: true });
                resumePosition = audio.currentTime || 0;
                pausedForOffline = true;
                audio.pause();
                isPlaying = false;
                const playIcon = document.getElementById('play-icon') as HTMLImageElement;
                if (playIcon) playIcon.src = '/icons/play.svg';
                showToast('Lost connection — will resume when you\'re back online', 'info', 5000);
                return;
            }

            // We ARE online, but something's rate-limiting us. Cool down.
            console.warn('[play] online but rate-limited — cooling down');
            window.__audosRateLimited = true;
            setTimeout(() => { window.__audosRateLimited = false; }, 60_000);
            consecutiveStreamErrors = 0;   // reset before trying alt

            // Fall through to try the alternative below
        }

        // ── Only try the alternative for YouTube streams ──
        if (track.source_type !== 'youtube_stream') return;

        try {
            const alt = await invoke<YtTrack | null>('find_alternative', {
                title: track.title || '',
                artist: track.artist_name || '',
                duration: track.duration || 0,
            });

            if (!alt) {
                console.warn('[play] no alternative found, skipping');
                // Guard against runaway skipping: only auto-advance if
                // we're not in a failure cascade.
                if (consecutiveStreamErrors < STREAM_ERROR_THRESHOLD) {
                    setTimeout(() => goNextTrack(true), 300);
                } else {
                    console.warn('[play] suppressing auto-skip during failure cascade');
                }
                return;
            }

            console.log(`[play] playing alternative ${alt.id}: ${alt.title}`);

            const altTrack: Track = {
                id: alt.id,
                source_type: 'youtube_stream',
                file_path_or_url: alt.id,
                title: alt.title,
                artist_name: alt.uploader,
                duration: alt.duration,
                thumbnail: alt.thumbnail,
            };

            // Swap the current track in whichever queue holds it
            const uIdx = userQueue.indexOf(track);
            if (uIdx !== -1) {
                userQueue[uIdx] = altTrack;
            } else if (contextIndex >= 0 && contextQueue[contextIndex] === track) {
                contextQueue[contextIndex] = altTrack;
            }
            currentTrack = altTrack;
            audioLoadedTrack = altTrack;

            audio.src = `http://127.0.0.1:${proxyPort}/stream?yt_id=${alt.id}`;
            audio.play().catch(e => console.error('[play] alt playback failed:', e));
        } catch (e) {
            console.error('[play] alternative search failed:', e);
            if (consecutiveStreamErrors < STREAM_ERROR_THRESHOLD) {
                setTimeout(() => goNextTrack(true), 300);
            } else {
                console.warn('[play] suppressing auto-skip during failure cascade');
            }
        }
    }, { once: true });

    audio.play().catch(e => console.error("Playback error:", e));

    // Reset failure counter as soon as audio actually starts flowing
    audio.addEventListener('playing', () => {
        consecutiveStreamErrors = 0;
    }, { once: true });
    // ── Prefetch the next track's stream URL in the background ──
    if (proxyPort && !window.__audosRateLimited) {
        const nextTrack = userQueue[0]
            ?? (contextIndex + 1 < contextQueue.length ? contextQueue[contextIndex + 1] : null);

        if (nextTrack && nextTrack.source_type === 'youtube_stream') {
            setTimeout(() => {
                // Bail if the queue changed under us
                const stillNext = userQueue[0] ?? (contextIndex + 1 < contextQueue.length ? contextQueue[contextIndex + 1] : null);
                if (stillNext?.id !== nextTrack.id) return;
                if (window.__audosRateLimited) return;

                fetch(`http://127.0.0.1:${proxyPort}/stream?yt_id=${nextTrack.file_path_or_url}`, {
                    headers: { 'Range': 'bytes=0-1023' }
                }).catch(() => {});
            }, 4000);
        }
    }
    isPlaying = true;

    const playIcon = document.getElementById('play-icon') as HTMLImageElement;
    if (playIcon) playIcon.src = '/icons/pause.svg';

        titleEl.textContent = track.title || 'Unknown Title';
    artistEl.textContent = track.artist_name || 'Unknown Artist';

    // Update Windows media controls
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || 'Unknown Title',
            artist: track.artist_name || 'Unknown Artist',
            album: track.album_name || '',
            artwork: track.thumbnail ? [
                { src: track.thumbnail, sizes: '480x360', type: 'image/jpeg' }
            ] : []
        });

        navigator.mediaSession.setActionHandler('play', () => togglePlay());
        navigator.mediaSession.setActionHandler('pause', () => togglePlay());
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            if (contextIndex > 0) {
                contextIndex--;
                playTrack(contextQueue[contextIndex]);
                refreshQueuePanel();
            }
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => goNextTrack(true));
    }

    const playerBackdrop = document.getElementById('player-backdrop') as HTMLElement;
    const playerBar = document.getElementById('player-bar') as HTMLElement;

    if (track.thumbnail) {
        // Mini album art in the now-playing block
        albumArtEl.style.backgroundImage = `url('${track.thumbnail}')`;
        albumArtEl.style.backgroundSize = 'cover';
        albumArtEl.style.backgroundPosition = 'center';

        // Blurred card backdrop
        if (playerBackdrop) {
            playerBackdrop.style.backgroundImage = `url('${track.thumbnail}')`;
            playerBackdrop.classList.add('visible');
        }

        // Switch the player card to white-on-image theme
        if (playerBar) playerBar.classList.add('has-track');
    } else {
        albumArtEl.style.backgroundImage = 'none';
        albumArtEl.style.backgroundColor = 'var(--panel-strong)';

        if (playerBackdrop) {
            playerBackdrop.style.backgroundImage = 'none';
            playerBackdrop.classList.remove('visible');
        }
        if (playerBar) playerBar.classList.remove('has-track');
    }

    updateLikeButton(track);
    refreshQueuePanel();
    maybeExtendQueue();
}
// ==========================================
// Context auto-extension (radio mode)
// ==========================================
let extendingQueue = false;
const QUEUE_EXTEND_THRESHOLD = 2;
const MAX_AUTO_QUEUE = 200;

async function maybeExtendQueue() {
    if (extendingQueue) return;
    if (!currentTrack) return;

    // Only count context tracks — user queue is user-controlled
    const remaining = contextQueue.length - contextIndex - 1;
    if (remaining > QUEUE_EXTEND_THRESHOLD) return;
    if (contextQueue.length >= MAX_AUTO_QUEUE) {
        console.log('[radio] Context at max size, not extending');
        return;
    }

    const lastTrack = contextQueue[contextQueue.length - 1];
    if (!lastTrack || lastTrack.source_type !== 'youtube_stream') {
        console.log('[radio] Context ends with non-YT track, skipping extension');
        return;
    }

    extendingQueue = true;
    console.log(`[radio] Context running low (${remaining} left), extending from: ${lastTrack.title}`);

    try {
        const related: YtTrack[] = await invoke('fetch_related_tracks', {
            ytId: lastTrack.file_path_or_url
        });

        if (!related || related.length === 0) {
            console.log('[radio] No related tracks returned');
            return;
        }

        const existingIds = new Set(contextQueue.map(t => t.file_path_or_url));
        const fresh = related.filter(t => !existingIds.has(t.id));

        if (fresh.length === 0) {
            console.log('[radio] All related tracks already in context');
            return;
        }

        const newTracks: Track[] = fresh.map(t => ({
            id: t.id,
            source_type: 'youtube_stream',
            file_path_or_url: t.id,
            title: t.title,
            artist_name: t.uploader,
            duration: t.duration,
            thumbnail: t.thumbnail
        }));

        contextQueue.push(...newTracks);
        console.log(`[radio] Appended ${newTracks.length} tracks to context`);
        refreshQueuePanel();
    } catch (e) {
        console.error('[radio] Failed to extend context:', e);
    } finally {
        extendingQueue = false;
    }
}

function togglePlay() {
    const playIcon = document.getElementById('play-icon') as HTMLImageElement;
    if (audio.src) {
        if (isPlaying) {
            audio.pause();
            if (playIcon) playIcon.src = '/icons/play.svg';
        } else {
            audio.play();
            if (playIcon) playIcon.src = '/icons/pause.svg';
        }
        isPlaying = !isPlaying;
    }
}

playBtn.addEventListener('click', togglePlay);

// ==========================================
// Shuffle / Repeat / Next / Prev
// ==========================================
const shuffleBtn = document.getElementById('btn-shuffle') as HTMLButtonElement;
const repeatBtn = document.getElementById('btn-repeat') as HTMLButtonElement;

if (shuffleBtn) {
    shuffleBtn.addEventListener('click', () => {
        shuffleMode = ((shuffleMode + 1) % 2) as 0 | 1;

        shuffleBtn.classList.toggle('active', shuffleMode === 1);
        const img = shuffleBtn.querySelector('img');
        if (img) img.src = '/icons/shuffle.svg';

        if (contextQueue.length === 0) return;

        const currentlyPlaying = currentTrack;

        if (shuffleMode === 1) {
            // Remember the original order
            if (originalContextQueue.length === 0) originalContextQueue = [...contextQueue];
            // Shuffle everything after the current track
            const idx = currentlyPlaying ? contextQueue.indexOf(currentlyPlaying) : -1;
            const before = contextQueue.slice(0, Math.max(0, idx + 1));
            const after = contextQueue.slice(Math.max(0, idx + 1));
            contextQueue = [...before, ...shuffled(after)];
        } else {
            // Restore original order, keeping current track active
            contextQueue = [...originalContextQueue];
            if (currentlyPlaying) {
                const newIdx = contextQueue.indexOf(currentlyPlaying);
                if (newIdx !== -1) contextIndex = newIdx;
            }
        }
        refreshQueuePanel();
    });
}

if (repeatBtn) {
    repeatBtn.addEventListener('click', () => {
        repeatMode = ((repeatMode + 1) % 3) as 0 | 1 | 2;
        const img = repeatBtn.querySelector('img');

        if (repeatMode === 0) {
            repeatBtn.classList.remove('active', 'repeat-one');
            if (img) img.src = '/icons/repeat.svg';
        } else if (repeatMode === 1) {
            repeatBtn.classList.add('active');
            repeatBtn.classList.remove('repeat-one');
            if (img) img.src = '/icons/repeat-all.svg';
        } else {
            repeatBtn.classList.add('active', 'repeat-one');
            if (img) img.src = '/icons/repeat-one.svg';
        }
    });
}

async function goNextTrack(forceNext = false) {
    const isRepeatOne = document.getElementById('btn-repeat')?.classList.contains('repeat-one');
    const isRepeatAll = document.getElementById('btn-repeat')?.classList.contains('active') && !isRepeatOne;

    if (!forceNext && isRepeatOne) {
        audio.currentTime = 0;
        audio.play();
        return;
    }

    // ── 1. User queue first ──
    if (userQueue.length > 0) {
        const next = userQueue.shift()!;
        playTrack(next);
        refreshQueuePanel();
        return;
    }

    // ── 2. Then context ──
    if (contextIndex + 1 < contextQueue.length) {
        contextIndex++;
        playTrack(contextQueue[contextIndex]);
        refreshQueuePanel();
        return;
    }

    // ── 3. End of context → repeat-all loops back ──
    if (isRepeatAll && contextQueue.length > 0) {
        if (shuffleMode > 0) {
            const source = originalContextQueue.length > 0 ? originalContextQueue : contextQueue;
            contextQueue = shuffled(source);
        }
        contextIndex = 0;
        playTrack(contextQueue[0]);
        refreshQueuePanel();
        return;
    }

    // ── 4. Radio-extend the context ──
    const lastTrack = contextQueue[contextQueue.length - 1];
    if (!lastTrack || lastTrack.source_type !== 'youtube_stream') {
        console.log('[radio] Nothing to extend from');
        return;
    }

    console.log('[radio] End of context, fetching more...');

    try {
        const related: YtTrack[] = await invoke('fetch_related_tracks', {
            ytId: lastTrack.file_path_or_url
        });

        if (!related || related.length === 0) {
            console.log('[radio] No more related tracks found');
            return;
        }

        const existingIds = new Set(contextQueue.map(t => t.file_path_or_url));
        const fresh = related.filter(t => !existingIds.has(t.id));
        if (fresh.length === 0) return;

        const newTracks: Track[] = fresh.map(t => ({
            id: t.id,
            source_type: 'youtube_stream',
            file_path_or_url: t.id,
            title: t.title,
            artist_name: t.uploader,
            duration: t.duration,
            thumbnail: t.thumbnail
        }));

        contextQueue.push(...newTracks);
        refreshQueuePanel();

        // Advance to the first new track
        contextIndex++;
        playTrack(contextQueue[contextIndex]);
    } catch (e) {
        console.error('[radio] Extension failed:', e);
    }
}

const nextBtn = document.getElementById('btn-next') as HTMLButtonElement;
const prevBtn = document.getElementById('btn-prev') as HTMLButtonElement;

if (nextBtn) nextBtn.addEventListener('click', () => goNextTrack(true));

if (prevBtn) {
    prevBtn.addEventListener('click', () => {
        // If the audio element is playing a different track than our UI
        // state (e.g. offline guard blocked a stream), re-select what's
        // actually loaded.
        if (audioLoadedTrack && audioLoadedTrack !== currentTrack) {
            playTrack(audioLoadedTrack);
            return;
        }

        // Standard: restart if we're past the 3s mark
        if (audio.currentTime > 3) {
            audio.currentTime = 0;
            audio.play();
            return;
        }

        // Otherwise, step back in context only (Spotify behavior —
        // user queue items don't get "un-played")
        if (contextIndex > 0) {
            contextIndex--;
            playTrack(contextQueue[contextIndex]);
            refreshQueuePanel();
        }
    });
}

// ==========================================
// Queue Panel
// ==========================================
const queueBtn = document.getElementById('btn-queue') as HTMLButtonElement;

function renderQueuePanel() {
    const existing = document.getElementById('queue-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'queue-panel';

    // ── Peek content (only shown when the column is collapsed) ──
    // Shows a vertical mini-stack: current track on top, then the next
    // few upcoming tracks, then a badge and the expand button pinned
    // to the bottom.
    const peek = document.createElement('div');
    peek.className = 'queue-peek';

    // ── Thumb strip ──
    const strip = document.createElement('div');
    strip.className = 'queue-peek-strip';

    // Current track first, then up to 6 upcoming
    const peekTracks: (Track | null)[] = [
        currentTrack ?? null,
        ...userQueue.slice(0, 6),
        ...(contextIndex >= 0
            ? contextQueue.slice(contextIndex + 1, contextIndex + 7)
            : [])
    ].slice(0, 7);

    const seen = new Set<string>();
    peekTracks.forEach((t, i) => {
        // De-dupe by URL to avoid showing the same song twice
        if (t) {
            const key = t.file_path_or_url;
            if (seen.has(key)) return;
            seen.add(key);
        }

        const cell = document.createElement('div');
        cell.className = 'queue-peek-cell' + (i === 0 && t ? ' queue-peek-cell--current' : '');

        if (t?.thumbnail) {
            cell.style.backgroundImage = `url('${t.thumbnail}')`;
        } else {
            cell.innerHTML = `<img src="/icons/music-note.svg" />`;
        }

        strip.appendChild(cell);
    });

    // If nothing is playing, show a single muted placeholder
    if (peekTracks.length === 0) {
        const cell = document.createElement('div');
        cell.className = 'queue-peek-cell queue-peek-cell--empty';
        cell.innerHTML = `<img src="/icons/queue.svg" />`;
        strip.appendChild(cell);
    }

    peek.appendChild(strip);

    // ── Footer: badge + expand button pinned at the bottom ──
    const footer = document.createElement('div');
    footer.className = 'queue-peek-footer';

    const upcoming = userQueue.length + (contextQueue.length - Math.max(0, contextIndex + 1));
    if (upcoming > 0) {
        const badge = document.createElement('div');
        badge.className = 'queue-peek-badge';
        badge.textContent = String(upcoming);
        footer.appendChild(badge);
    }

    const expandBtn = document.createElement('button');
    expandBtn.className = 'queue-peek-expand';
    expandBtn.title = 'Open queue';
    expandBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
    `;
    expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyQueueState(true);
        localStorage.setItem(QUEUE_OPEN_KEY, 'true');
    });
    footer.appendChild(expandBtn);

    peek.appendChild(footer);

    panel.appendChild(peek);

    // ── Header ──
    const titleRow = document.createElement('div');
    titleRow.className = 'queue-header';

    const upcomingCount = userQueue.length + (contextQueue.length - Math.max(0, contextIndex + 1));
    titleRow.innerHTML = `
        <h3>Queue</h3>
        <span class="queue-count">${upcomingCount} tracks</span>
    `;

    const headerActions = document.createElement('div');
    headerActions.className = 'queue-header-actions';

    if (upcomingCount > 0) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'queue-clear-btn';
        clearBtn.textContent = 'Clear';
        clearBtn.onclick = () => {
            userQueue = [];
            contextQueue = [];
            originalContextQueue = [];
            contextIndex = -1;
            currentTrack = null;
            audioLoadedTrack = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            refreshQueuePanel();
        };
        headerActions.appendChild(clearBtn);
    }

    // Collapse button — mirrors the peek expand button, rotates 180°
    // when the queue is open so the chevron always points "inward".
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'queue-collapse-btn';
    collapseBtn.title = 'Collapse queue';
    collapseBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
    `;
    collapseBtn.addEventListener('click', () => {
        applyQueueState(false);
        localStorage.setItem(QUEUE_OPEN_KEY, 'false');
    });
    headerActions.appendChild(collapseBtn);

    titleRow.appendChild(headerActions);
    panel.appendChild(titleRow);

    // ── Now Playing ──
    if (currentTrack) {
        const nowSection = document.createElement('div');
        nowSection.className = 'queue-section queue-section--now';
        nowSection.innerHTML = `<div class="queue-section-title">Now playing</div>`;
        nowSection.appendChild(buildQueueItem(currentTrack, {
            draggable: false,
            removable: false,
            onClick: () => {},
        }));
        panel.appendChild(nowSection);
    }

    // ── Next in queue (userQueue) ──
    if (userQueue.length > 0) {
        const userSection = document.createElement('div');
        userSection.className = 'queue-section queue-section--user';

        const headerRow = document.createElement('div');
        headerRow.className = 'queue-section-header';
        headerRow.innerHTML = `
            <div class="queue-section-title">Next in queue</div>
            <div class="queue-section-count">${userQueue.length}</div>
        `;
        userSection.appendChild(headerRow);

        const list = document.createElement('div');
        list.className = 'queue-list';
        list.dataset.section = 'user';

        userQueue.forEach((track, idx) => {
            list.appendChild(buildQueueItem(track, {
                draggable: true,
                removable: true,
                index: idx,
                onClick: () => {
                    // Clicking a user-queued item promotes it to current
                    // and removes it from the queue.
                    userQueue.splice(idx, 1);
                    playTrack(track);
                    refreshQueuePanel();
                },
                onRemove: () => {
                    userQueue.splice(idx, 1);
                    refreshQueuePanel();
                },
            }));
        });

        // Drop zone for external drags (from main view)
        let dragDepth = 0;
        const setActive = (on: boolean) => userSection.classList.toggle('drag-over', on);
        userSection.addEventListener('dragenter', (e) => {
            if (!e.dataTransfer?.types.includes('text/plain')) return;
            e.preventDefault();
            dragDepth++;
            setActive(true);
        });
        userSection.addEventListener('dragover', (e) => {
            // Ignore internal user-queue reorder drags — those are
            // handled by the individual items.
            if (dragState.source === 'user-queue') return;

            const hasTrackData =
                e.dataTransfer?.types.includes('application/x-audos-context-to-user') ||
                e.dataTransfer?.types.includes('text/plain');
            if (!hasTrackData) return;

            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';

            // Only paint the end-line when the cursor is below the last
            // item — otherwise the item handler will manage the indicator.
            const items = userSection.querySelectorAll('.q-item');
            if (items.length === 0) return;

            const last = items[items.length - 1] as HTMLElement;
            const lastRect = last.getBoundingClientRect();
            if (e.clientY > lastRect.bottom) {
                clearAllDropIndicators();
                last.classList.add('q-item--drop-below');
            }
        });
        userSection.addEventListener('dragleave', () => {
            dragDepth--;
            if (dragDepth <= 0) {
                dragDepth = 0;
                setActive(false);
                clearAllDropIndicators();
            }
        });
        userSection.addEventListener('drop', (e) => {
            dragDepth = 0;
            setActive(false);

            // Ignore internal reorder drags — those go to the item's own
            // drop handler (which fires first because it's a child).
            if (e.dataTransfer?.types.includes('application/x-audos-queue-reorder')) return;
            // Context-to-user drag is also internal but has its own MIME
            const ctxRaw = e.dataTransfer?.getData('application/x-audos-context-to-user');
            if (ctxRaw) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    const dropped = JSON.parse(ctxRaw) as Track;
                    if (dropped?.file_path_or_url) {
                        addToQueue(dropped, false);
                    }
                } catch (err) {
                    console.error('[Queue Drop] Context parse failed:', err);
                }
                return;
            }

            // External drop (e.g. from the main track list)
            const raw = e.dataTransfer?.getData('text/plain');
            if (!raw) return;
            if (raw.includes('"queue-reorder"')) return;
            e.preventDefault();
            e.stopPropagation();
            try {
                const dropped = JSON.parse(raw) as Track;
                if (!dropped?.file_path_or_url) return;
                addToQueue(dropped, false);
            } catch (err) {
                console.error('[Queue Drop] Parse failed:', err);
            }
        });

        userSection.appendChild(list);
        panel.appendChild(userSection);
    } else {
        // Empty placeholder for user queue
        const emptySection = document.createElement('div');
        emptySection.className = 'queue-section queue-section--user';
        emptySection.innerHTML = `<div class="queue-section-title">Next in queue</div>`;
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = 'Nothing queued up';
        emptySection.appendChild(empty);

        let dragDepth = 0;
        const setActive = (on: boolean) => emptySection.classList.toggle('drag-over', on);
        emptySection.addEventListener('dragenter', (e) => {
            if (!e.dataTransfer?.types.includes('text/plain')) return;
            e.preventDefault(); dragDepth++; setActive(true);
        });
        emptySection.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('text/plain')) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        emptySection.addEventListener('dragleave', () => {
            dragDepth--; if (dragDepth <= 0) { dragDepth = 0; setActive(false); }
        });
        emptySection.addEventListener('drop', (e) => {
            dragDepth = 0; setActive(false);

            if (e.dataTransfer?.types.includes('application/x-audos-queue-reorder')) return;

            const ctxRaw = e.dataTransfer?.getData('application/x-audos-context-to-user');
            if (ctxRaw) {
                e.preventDefault(); e.stopPropagation();
                try {
                    const dropped = JSON.parse(ctxRaw) as Track;
                    if (dropped?.file_path_or_url) addToQueue(dropped, false);
                } catch (err) { console.error('[Queue Drop] Context parse failed:', err); }
                return;
            }

            const raw = e.dataTransfer?.getData('text/plain');
            if (!raw || raw.includes('"queue-reorder"')) return;
            e.preventDefault(); e.stopPropagation();
            try {
                const dropped = JSON.parse(raw) as Track;
                if (!dropped?.file_path_or_url) return;
                addToQueue(dropped, false);
            } catch (err) { console.error('[Queue Drop] Parse failed:', err); }
        });

        panel.appendChild(emptySection);
    }

    // ── Next from: <contextName> (contextQueue) ──
    const contextUpcoming = contextIndex >= 0 ? contextQueue.slice(contextIndex + 1) : [];
    if (contextUpcoming.length > 0) {
        const ctxSection = document.createElement('div');
        ctxSection.className = 'queue-section queue-section--context';

        const headerRow = document.createElement('div');
        headerRow.className = 'queue-section-header';
        headerRow.innerHTML = `
            <div class="queue-section-title">Next from: ${contextName || 'Queue'}</div>
            <div class="queue-section-count">${contextUpcoming.length}</div>
        `;
        ctxSection.appendChild(headerRow);

        const list = document.createElement('div');
        list.className = 'queue-list';

        contextUpcoming.slice(0, 50).forEach((track) => {
            list.appendChild(buildQueueItem(track, {
                draggable: false,
                removable: false,
                onClick: () => {
                    const ci = contextQueue.indexOf(track);
                    if (ci !== -1) {
                        contextIndex = ci;
                        playTrack(track);
                        refreshQueuePanel();
                    }
                },
                onContextMenu: (e) => showQueueItemContextMenu(e, track, 'context'),
            }));
        });

        ctxSection.appendChild(list);
        panel.appendChild(ctxSection);
    }

    // Click anywhere in peek mode to open
    panel.addEventListener('click', (e) => {
        const app = document.getElementById('app');
        if (!app) return;
        if (app.classList.contains('queue-open')) return;
        if ((e.target as HTMLElement).closest('button')) return;

        applyQueueState(true);
        localStorage.setItem(QUEUE_OPEN_KEY, 'true');
    });

    document.getElementById('app')!.appendChild(panel);
}

// ── Build a single queue row ──
interface QueueItemOpts {
    draggable: boolean;
    removable: boolean;
    index?: number;
    onClick: () => void;
    onRemove?: () => void;
    onContextMenu?: (e: MouseEvent) => void;
}

function buildQueueItem(track: Track, opts: QueueItemOpts): HTMLElement {
    const item = document.createElement('div');
    item.className = 'q-item';
    if (opts.draggable) item.classList.add('q-item--draggable');
    else item.classList.add('q-item--context');
    item.setAttribute('data-source', track.source_type);

    // Drag handle (or spacer for alignment)
    if (opts.draggable) {
        const handle = document.createElement('div');
        handle.className = 'q-handle';
        handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="3" cy="3.5" r="1.4"/><circle cx="7" cy="3.5" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="12.5" r="1.4"/><circle cx="7" cy="12.5" r="1.4"/></svg>`;
        item.appendChild(handle);

        // Native HTML5 drag
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            if (!e.dataTransfer) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-audos-queue-reorder', String(opts.index));
            e.dataTransfer.setData('text/plain', JSON.stringify({ 'queue-reorder': true, index: opts.index }));
            item.classList.add('q-item--dragging');
            dragState.draggingIndex = opts.index ?? -1;
            dragState.draggingTrack = track;
            dragState.source = 'user-queue';
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('q-item--dragging');
            clearAllDropIndicators();
            dragState.draggingIndex = -1;
            dragState.draggingTrack = null;
            dragState.source = null;
        });

        // Drop indicators — top half vs bottom half of the item
        item.addEventListener('dragover', (e) => {
            // React to any drag that carries a track: internal user-queue
            // reorders, context→user drops, and external drops from the
            // main track list.
            const src = dragState.source;
            if (src !== 'user-queue' && src !== 'context-queue' && src !== 'external') {
                // Fallback: some browsers won't have fired our global
                // dragstart yet — sniff the MIME types instead.
                const types = e.dataTransfer?.types ?? [];
                const hasTrack =
                    types.includes('application/x-audos-queue-reorder') ||
                    types.includes('application/x-audos-context-to-user') ||
                    types.includes('text/plain');
                if (!hasTrack) return;
            }

            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = src === 'user-queue' ? 'move' : 'copy';
            }

            const rect = item.getBoundingClientRect();
            const isTopHalf = (e.clientY - rect.top) < rect.height / 2;

            clearAllDropIndicators();
            if (isTopHalf) item.classList.add('q-item--drop-above');
            else item.classList.add('q-item--drop-below');
        });
        item.addEventListener('dragleave', (e) => {
            // Only clear if we've really left the item
            if (!item.contains(e.relatedTarget as Node)) {
                item.classList.remove('q-item--drop-above', 'q-item--drop-below');
            }
        });
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const rect = item.getBoundingClientRect();
            const isTopHalf = (e.clientY - rect.top) < rect.height / 2;
            const dropIndex = (opts.index ?? 0) + (isTopHalf ? 0 : 1);

            // ── Internal reorder ──
            if (dragState.source === 'user-queue') {
                const from = dragState.draggingIndex;
                clearAllDropIndicators();
                if (from === -1) return;

                let to = dropIndex;
                if (from === to || from === to - 1) return;

                const [moved] = userQueue.splice(from, 1);
                if (from < to) to -= 1;
                userQueue.splice(to, 0, moved);
                refreshQueuePanel();
                return;
            }

            // ── Context drag → insert into user queue ──
            if (dragState.source === 'context-queue') {
                const track = dragState.draggingTrack as Track | null;
                clearAllDropIndicators();
                if (!track) return;
                userQueue.splice(dropIndex, 0, track);
                refreshQueuePanel();
                return;
            }

            // ── External drag (main track list, playlist item, etc.) ──
            const raw = e.dataTransfer?.getData('text/plain');
            clearAllDropIndicators();
            if (!raw) return;
            try {
                const dropped = JSON.parse(raw) as Track;
                if (!dropped?.file_path_or_url) return;
                userQueue.splice(dropIndex, 0, dropped);
                refreshQueuePanel();
            } catch (err) {
                console.error('[Queue Drop] External parse failed:', err);
            }
        });
    } else {
        // Context / now-playing rows don't have a handle, so we skip the
        // spacer entirely — the thumb sits flush against the left edge
        // of the row, matching Spotify's layout.

        // Context items are draggable into the user-queue section.
        // Note: only when they have an onContextMenu set — that's our
        // signal that this is a context-queue item (not the "now playing"
        // display row, which should stay inert).
        if (opts.onContextMenu) {
            item.draggable = true;
            item.classList.add('q-item--draggable-context');
            item.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer) return;
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData(
                    'application/x-audos-context-to-user',
                    JSON.stringify(track)
                );
                e.dataTransfer.setData('text/plain', JSON.stringify(track));
                item.classList.add('q-item--dragging');
                dragState.draggingTrack = track;
                dragState.source = 'context-queue';
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('q-item--dragging');
                clearAllDropIndicators();
                dragState.draggingTrack = null;
                dragState.source = null;
            });
        }
    }

    // Thumb
    const thumb = document.createElement('div');
    thumb.className = 'q-thumb';
    if (track.thumbnail) thumb.style.backgroundImage = `url('${track.thumbnail}')`;
    item.appendChild(thumb);

    // Info
    const info = document.createElement('div');
    info.className = 'q-info';
    info.innerHTML = `
        <div class="q-title">${escapeHtml(track.title || 'Unknown')}</div>
        <div class="q-artist">${escapeHtml(track.artist_name || '')}</div>
    `;
    item.appendChild(info);

    // Click anywhere on the row (except interactive controls) triggers
    // the primary action.
    item.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.q-remove-btn')) return;
        if (target.closest('.q-handle')) return;
        opts.onClick();
    });

    // Remove button
    if (opts.removable) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'q-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove from queue';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            opts.onRemove?.();
        };
        item.appendChild(removeBtn);
    }

    // Right-click context menu
    if (opts.onContextMenu) {
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            opts.onContextMenu!(e);
        });
    }

    return item;
}

// ── Right-click menu on queue items ──
function showQueueItemContextMenu(
    e: MouseEvent,
    track: Track,
    source: 'user' | 'context'
) {
    document.getElementById('queue-item-menu')?.remove();

    const menu = document.createElement('div');
    menu.id = 'queue-item-menu';
    menu.className = 'context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const makeRow = (label: string, action: () => void, danger = false) => {
        const row = document.createElement('div');
        row.className = 'context-menu-row' + (danger ? ' context-menu-row--danger' : '');
        row.textContent = label;
        row.onclick = () => { action(); menu.remove(); };
        menu.appendChild(row);
    };

    if (source === 'user') {
        makeRow('Play Now', () => {
            const idx = userQueue.indexOf(track);
            if (idx !== -1) userQueue.splice(idx, 1);
            playTrack(track);
            refreshQueuePanel();
        });
        makeRow('Play Next', () => {
            const idx = userQueue.indexOf(track);
            if (idx !== -1) userQueue.splice(idx, 1);
            userQueue.unshift(track);
            refreshQueuePanel();
        });
        makeRow('Move to End', () => {
            const idx = userQueue.indexOf(track);
            if (idx !== -1) userQueue.splice(idx, 1);
            userQueue.push(track);
            refreshQueuePanel();
        });
        makeRow('Remove from Queue', () => {
            removeFromUserQueue(track);
        }, true);
    } else {
        makeRow('Play Next', () => addToQueue(track, true));
        makeRow('Add to Queue', () => addToQueue(track, false));
    }

    document.body.appendChild(menu);

    const closeMenu = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function refreshQueuePanel() {
    const app = document.getElementById('app');
    if (!app) return;

    const panel = document.getElementById('queue-panel');
    if (panel) panel.remove();
    renderQueuePanel();
}

// ── Queue toggle (mirrors sidebar behavior) ──
// The panel is always in the DOM. We just toggle `queue-open`, which
// collapses the column to peek width or expands to full width.
function applyQueueState(open: boolean) {
    const app = document.getElementById('app');
    if (!app) return;

    app.classList.toggle('queue-open', open);
    queueBtn?.classList.toggle('active', open);

    // Always re-render — the peek content and full panel need to reflect
    // the current state (which section the user sees depends on CSS).
    renderQueuePanel();
}

if (queueBtn) {
    queueBtn.addEventListener('click', () => {
        const app = document.getElementById('app');
        if (!app) return;

        const willOpen = !app.classList.contains('queue-open');
        applyQueueState(willOpen);
        localStorage.setItem(QUEUE_OPEN_KEY, String(willOpen));
    });
}

// Restore queue state on boot
const savedQueueOpen = localStorage.getItem(QUEUE_OPEN_KEY) === 'true';
if (savedQueueOpen) {
    requestAnimationFrame(() => applyQueueState(true));
}

// ==========================================
// Progress Bar + Volume
// ==========================================
function formatTime(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

audio.addEventListener('timeupdate', () => {
    const current = audio.currentTime;
    const duration = audio.duration;

    timeCurrent.textContent = formatTime(current);
    timeTotal.textContent = formatTime(duration);

    if (duration > 0) {
        const percent = (current / duration) * 100;
        progressFill.style.width = `${percent}%`;
        const handle = document.getElementById('progress-handle');
        if (handle) handle.style.left = `${percent}%`;
    }

    // Keep a rolling "last known position" so we can resume accurately.
    // Only update while actively playing — don't clobber a paused-for-offline
    // position with a stale 0 from a paused element.
    if (isPlaying && current > 0) {
        resumePosition = current;
    }
});

audio.addEventListener('ended', () => {
    const track = currentTrack;

    if (!track || track.source_type !== 'youtube_stream') {
        goNextTrack(false);
        return;
    }

    if (currentTrackInterrupted) {
        console.warn('[play] ended fired on interrupted track — not advancing');
        return;
    }

    if (track.duration && track.duration > 0) {
        const played = audio.currentTime || 0;
        const expected = track.duration;
        if (played < expected - 5) {
            console.warn(`[play] ended at ${played}s of ${expected}s — treating as truncated`);
            currentTrackInterrupted = true;
            pausedForOffline = true;
            resumePosition = played;
            return;
        }
    }

    goNextTrack(false);
});

progressBg.addEventListener('click', (e) => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const rect = progressBg.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = percent * audio.duration;
    progressFill.style.width = `${percent * 100}%`;
    const handle = document.getElementById('progress-handle');
    if (handle) handle.style.left = `${percent * 100}%`;
});
let isSeeking = false;

progressBg.addEventListener('mousedown', (e) => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    isSeeking = true;
    seekTo(e);
});

document.addEventListener('mousemove', (e) => {
    if (isSeeking) seekTo(e);
});

document.addEventListener('mouseup', () => {
    isSeeking = false;
});

function seekTo(e: MouseEvent) {
    const rect = progressBg.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = percent * audio.duration;
    progressFill.style.width = `${percent * 100}%`;
    const handle = document.getElementById('progress-handle');
    if (handle) handle.style.left = `${percent * 100}%`;
}

const volumeBg = document.querySelector('.extra-controls .volume-bg') as HTMLElement;
const volumeFill = document.querySelector('.extra-controls .volume-fill') as HTMLElement;
const volumeBtn = document.getElementById('btn-volume') as HTMLButtonElement;
const volumeIcon = document.getElementById('volume-icon') as HTMLImageElement;

if (volumeFill) volumeFill.style.width = '100%';
audio.volume = 1.0;
let lastVolume = 1.0;

if (volumeBtn && volumeIcon) {
    volumeBtn.addEventListener('click', () => {
        if (audio.volume > 0) {
            lastVolume = audio.volume;
            audio.volume = 0;
            volumeIcon.src = '/icons/volume-mute.svg';
            if (volumeFill) volumeFill.style.width = '0%';
        } else {
            audio.volume = lastVolume > 0 ? lastVolume : 1.0;
            volumeIcon.src = '/icons/volume.svg';
            if (volumeFill) volumeFill.style.width = `${audio.volume * 100}%`;
        }
    });
}

if (volumeBg) {
    let isDraggingVolume = false;

    const updateVolume = (e: MouseEvent) => {
        const rect = volumeBg.getBoundingClientRect();
        let percent = (e.clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));
        audio.volume = percent;
        if (volumeFill) volumeFill.style.width = `${percent * 100}%`;
        if (volumeIcon) {
            volumeIcon.src = percent === 0 ? '/icons/volume-mute.svg' : '/icons/volume.svg';
        }
    };

    volumeBg.addEventListener('mousedown', (e) => {
        isDraggingVolume = true;
        updateVolume(e);
    });

    document.addEventListener('mousemove', (e) => {
        if (isDraggingVolume) updateVolume(e);
    });

    document.addEventListener('mouseup', () => { isDraggingVolume = false; });
}

// ==========================================
// Folder Scanning
// ==========================================
const addFolderBtnEl = document.getElementById('add-folder-btn') as HTMLButtonElement;
if (addFolderBtnEl) {
    addFolderBtnEl.addEventListener('click', async () => {
        try {
            const selected = await open({ directory: true, multiple: false }) as string | null;
            if (!selected) return;

            const folderName = selected.replace(/\\/g, '/').split('/').filter(Boolean).pop() || selected;
            if (!playlists.some(p => p.folderPath === selected)) {
                playlists.push({ name: folderName, folderPath: selected });
                savePlaylists();
            }

            await invoke('scan_directory', { path: selected });
            await fetchAndRenderTracks();

            const newIdx = playlists.findIndex(p => p.folderPath === selected);
            if (newIdx >= 0) {
                activePlaylistIndex = newIdx;
                isShowingPlaylist = true;
                displayedTracks = getPlaylistTracks(playlists[newIdx]);
                renderTracks(displayedTracks, playlists[newIdx].name);
                renderSidebarPlaylist();
            }
        } catch (e) {
            console.error('Error picking folder:', e);
        }
    });
}

const refreshLibBtn = document.getElementById('refresh-lib-btn') as HTMLButtonElement;
if (refreshLibBtn) {
    refreshLibBtn.addEventListener('click', async () => {
        const icon = refreshLibBtn.querySelector('img');
        if (icon) (icon as HTMLElement).style.opacity = '0.3';

        try {
            await invoke('cleanup_deleted_files_cmd');
        } catch (e) {
            console.error('Cleanup failed:', e);
        }

        const physicalPlaylists = playlists.filter(p => p.folderPath && !p.folderPath.startsWith('VIRTUAL_'));
        for (const pl of physicalPlaylists) {
            try {
                await invoke('scan_directory', { path: pl.folderPath });
            } catch (e) {
                console.error('Scan failed:', pl.folderPath);
            }
        }

        await fetchAndRenderTracks();
        if (icon) (icon as HTMLElement).style.opacity = '0.8';
    });
}

// ==========================================
// Misc Buttons
// ==========================================
const clearBtn = document.querySelector('.search-bar .clear-icon') as HTMLImageElement;
if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
    });
}

const homeBtn = document.querySelector('.home-btn') as HTMLButtonElement;
if (homeBtn) {
    homeBtn.addEventListener('click', renderHomeView);
}

// ==========================================
// Library Tabs
// ==========================================
const libraryTabs = document.querySelectorAll('.library-filters .chip');
libraryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        libraryTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const activeTab = (tab as HTMLElement).dataset.tab;
        const listContainer = document.querySelector('.library-list') as HTMLElement;
        if (!listContainer) return;

        if (activeTab === 'playlists') {
            renderSidebarPlaylist();
        } else if (activeTab === 'artists') {
            listContainer.innerHTML = '';
            const artists = [...new Set(currentTracks.filter(t => t.artist_name).map(t => t.artist_name!))];
            if (artists.length === 0) {
                listContainer.innerHTML = '<p style="color: var(--text-faint); padding: 8px; font-size: 13px;">No artists found.</p>';
                return;
            }
            artists.sort().forEach(artist => {
                const item = document.createElement('div');
                item.className = 'list-item';
                item.innerHTML = `
                    <div class="item-img item-img--artist">
                        <img src="/icons/music-note.svg" />
                    </div>
                    <div class="item-info">
                        <p class="title">${artist}</p>
                        <p class="subtitle">Artist</p>
                    </div>
                `;
                item.onclick = () => {
                    isShowingPlaylist = false;
                    displayedTracks = currentTracks.filter(t => t.artist_name === artist);
                    renderTracks(displayedTracks, artist);
                };
                listContainer.appendChild(item);
            });
        } else if (activeTab === 'albums') {
            listContainer.innerHTML = '';
            const albums = [...new Set(currentTracks.filter(t => t.album_name).map(t => t.album_name!))];
            if (albums.length === 0) {
                listContainer.innerHTML = '<p style="color: var(--text-faint); padding: 8px; font-size: 13px;">No albums found.</p>';
                return;
            }
            albums.sort().forEach(album => {
                const albumTracks = currentTracks.filter(t => t.album_name === album);
                const thumb = albumTracks.find(t => t.thumbnail)?.thumbnail;
                const item = document.createElement('div');
                item.className = 'list-item';
                item.innerHTML = `
                    <div class="item-img item-img--album" ${thumb ? `style="background: url('${thumb}') center/cover;"` : ''}>
                        ${!thumb ? '<img src="/icons/music-note.svg" />' : ''}
                    </div>
                    <div class="item-info">
                        <p class="title">${album}</p>
                        <p class="subtitle">Album • ${albumTracks.length} songs</p>
                    </div>
                `;
                item.onclick = () => {
                    isShowingPlaylist = false;
                    displayedTracks = albumTracks;
                    renderTracks(displayedTracks, album);
                };
                listContainer.appendChild(item);
            });
        }
    });
});

// ==========================================
// Keybindings
// ==========================================
function setupKeybindings() {
    document.addEventListener('keydown', (e) => {
        const isSearchFocused = document.activeElement === searchInput;

        if (e.code === 'Space' && !isSearchFocused) {
            e.preventDefault();
            document.getElementById('btn-play')?.click();
        }
        if (e.ctrlKey && e.code === 'ArrowRight') {
            e.preventDefault();
            document.getElementById('btn-next')?.click();
        }
        if (e.ctrlKey && e.code === 'ArrowLeft') {
            e.preventDefault();
            document.getElementById('btn-prev')?.click();
        }
        if (e.ctrlKey && e.key === '/') {
            e.preventDefault();
            searchInput?.focus();
        }
    });
}

// ==========================================
// Like Button
// ==========================================
const likeBtn = document.getElementById('btn-like') as HTMLButtonElement;
const likeIcon = document.getElementById('like-icon') as HTMLImageElement;

function updateLikeButton(track: Track) {
    if (!likeIcon) return;
    const liked: Track[] = JSON.parse(localStorage.getItem('liked_tracks_full') || '[]');
    const isLiked = liked.some(t => t.file_path_or_url === track.file_path_or_url);
    likeIcon.classList.toggle('liked', isLiked);
}

if (likeBtn) {
    likeBtn.addEventListener('click', () => {
        if (!currentTrack) return;
        const track = currentTrack;
        let liked: Track[] = JSON.parse(localStorage.getItem('liked_tracks_full') || '[]');

        const existingIndex = liked.findIndex(t => t.file_path_or_url === track.file_path_or_url);

        if (existingIndex !== -1) {
            liked.splice(existingIndex, 1);
        } else {
            liked.unshift(track);
            if (!playlists.some(p => p.folderPath === 'VIRTUAL_LIKED_SONGS')) {
                playlists.unshift({ name: 'Liked Songs', folderPath: 'VIRTUAL_LIKED_SONGS' });
                savePlaylists();
            }
        }

        try {
            localStorage.setItem('liked_tracks_full', JSON.stringify(liked));
        } catch (e) {
            console.error('Failed to save likes:', e);
        }

        updateLikeButton(track);
        renderSidebarPlaylist();

        if (isShowingPlaylist && activePlaylistIndex >= 0 && playlists[activePlaylistIndex].folderPath === 'VIRTUAL_LIKED_SONGS') {
            displayedTracks = getPlaylistTracks(playlists[activePlaylistIndex]);
            renderTracks(displayedTracks, 'Liked Songs');
        }
    });
}

// ==========================================
// Profile Button
// ==========================================
const profileBtn = document.getElementById('profile-btn');

function loadProfilePicture() {
    const savedPicPath = localStorage.getItem('profile_picture_path');
    if (savedPicPath && profileBtn) {
        profileBtn.style.backgroundImage = `url('${convertFileSrc(savedPicPath)}')`;
        profileBtn.style.backgroundSize = 'cover';
        profileBtn.style.backgroundPosition = 'center';
    }
}

function loadAppBackground() {
    const savedPath = localStorage.getItem('app_background_path');
    const video = document.getElementById('app-bg-video') as HTMLVideoElement | null;

    // Always start from a clean slate
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
    }
    document.body.classList.remove('has-bg-video');
    document.body.style.backgroundImage = 'none';

        if (!savedPath) {
        const currentTheme = (localStorage.getItem('theme') as ThemeName) || 'glacier';
        applyThemeBackground(currentTheme);
        return;
    }

    if (isVideoFile(savedPath)) {
        if (!video) return;
        video.src = convertFileSrc(savedPath);
        document.body.classList.add('has-bg-video');
        video.play().catch(e => console.warn('[bg-video] autoplay blocked:', e));
    } else {
        document.body.style.backgroundImage = `url('${convertFileSrc(savedPath)}')`;
    }
}

function isVideoFile(path: string): boolean {
    const ext = path.toLowerCase().split('.').pop() || '';
    return ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext);
}

loadProfilePicture();
loadAppBackground();

profileBtn?.addEventListener('click', () => {
    const historyTracks = getHistory();
    isShowingPlaylist = false;
    renderTracks(historyTracks, "Recently Played (Today)");
});

profileBtn?.addEventListener('contextmenu', (e) => {
    e.preventDefault();

    document.getElementById('track-context-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'track-context-menu';
    menu.className = 'context-menu context-menu--profile';
    const MENU_WIDTH = 220;
    const MARGIN = 8;

    let left = e.clientX - 150;
    let top = e.clientY;

    const maxLeft = window.innerWidth - MENU_WIDTH - MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < MARGIN) left = MARGIN;

    // Estimate height — adjust if you add more items to the menu
    const estimatedHeight = 380;
    const maxTop = window.innerHeight - estimatedHeight - MARGIN;
    if (top > maxTop) top = maxTop;
    if (top < MARGIN) top = MARGIN;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const makeRow = (label: string, onClick: () => void) => {
        const row = document.createElement('div');
        row.className = 'context-menu-row';
        row.textContent = label;
        row.onclick = () => { onClick(); menu.remove(); };
        return row;
    };

    menu.appendChild(makeRow('History', () => {
        const historyTracks = getHistory();
        isShowingPlaylist = false;
        renderTracks(historyTracks, "Recently Played (Today)");
    }));

    const sep1 = document.createElement('div');
    sep1.className = 'context-menu-sep';
    menu.appendChild(sep1);

    menu.appendChild(makeRow('Change Picture', async () => {
        try {
            const selected = await open({
                title: 'Select Profile Picture',
                multiple: false,
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
            });
            if (selected && typeof selected === 'string') {
                localStorage.setItem('profile_picture_path', selected);
                if (profileBtn) {
                    profileBtn.style.backgroundImage = `url('${convertFileSrc(selected)}')`;
                    profileBtn.style.backgroundSize = 'cover';
                    profileBtn.style.backgroundPosition = 'center';
                }
            }
        } catch (err) { console.error('Profile pic error:', err); }
    }));

    menu.appendChild(makeRow('Change Background', async () => {
        try {
            const selected = await open({
                title: 'Select Background Image or Video',
                multiple: false,
                filters: [
                    { name: 'Images & Videos',
                    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov', 'm4v', 'ogv'] },
                    { name: 'Images',
                    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
                    { name: 'Videos',
                    extensions: ['mp4', 'webm', 'mov', 'm4v', 'ogv'] }
                ]
            });
            if (selected && typeof selected === 'string') {
                localStorage.setItem('app_background_path', selected);
                loadAppBackground();
            }
        } catch (err) { console.error('Background error:', err); }
    }));

    menu.appendChild(makeRow('Reset to Defaults', () => {
        localStorage.removeItem('profile_picture_path');
        localStorage.removeItem('app_background_path');
        if (profileBtn) {
            profileBtn.style.backgroundImage = 'none';
            profileBtn.style.backgroundColor = 'var(--text)';
        }
        loadAppBackground();   // handles both image and video reset
        document.body.style.backgroundColor = '';
    }));

        // ── Region picker ──
    const sepRegion = document.createElement('div');
    sepRegion.className = 'context-menu-sep';
    menu.appendChild(sepRegion);

    const regionHeader = document.createElement('div');
    regionHeader.className = 'context-menu-header';
    regionHeader.textContent = 'Region';
    menu.appendChild(regionHeader);

    const regionRow = document.createElement('div');
    regionRow.className = 'context-menu-field';

    const regionInput = document.createElement('input');
    regionInput.type = 'text';
    regionInput.className = 'region-input';
    regionInput.placeholder = 'Type to search…';
    regionInput.value = userRegion;
    regionInput.setAttribute('list', 'region-datalist');

    const regionDatalist = document.createElement('datalist');
    regionDatalist.id = 'region-datalist';
    for (const c of COUNTRY_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = c;
        regionDatalist.appendChild(opt);
    }

    const commitRegion = async (raw: string) => {
        const value = raw.trim();

        // Empty or unrecognized → default to Global
        const finalValue = COUNTRY_OPTIONS.includes(value) ? value : 'Global';

        if (finalValue === userRegion) return;

        userRegion = finalValue;
        localStorage.setItem('audos_region', finalValue);

        try {
            await invoke('set_user_region', { region: finalValue });
        } catch (e) {
            console.warn('[region] failed to set in backend:', e);
        }

        // Clear the frontend cache AND tell the user we refreshed
        clearHomeCache();

        // If we're on the home view, re-render immediately
        if (!isShowingPlaylist && searchInput.value.trim() === '') {
            renderHomeView();
        }
    };

    // Given whatever the user typed, find the best matching country.
    // Preference order:
    //   1. Exact match (case-insensitive)
    //   2. Starts-with match (first in list)
    //   3. Contains match (first in list)
    //   4. null if nothing matches
    const findBestMatch = (input: string): string | null => {
        const q = input.trim().toLowerCase();
        if (!q) return null;

        const exact = COUNTRY_OPTIONS.find(c => c.toLowerCase() === q);
        if (exact) return exact;

        const startsWith = COUNTRY_OPTIONS.find(c => c.toLowerCase().startsWith(q));
        if (startsWith) return startsWith;

        const contains = COUNTRY_OPTIONS.find(c => c.toLowerCase().includes(q));
        if (contains) return contains;

        return null;
    };

    regionInput.addEventListener('change', () => {
        // Only commit on change if what's typed is a real match.
        // Otherwise leave it — the user might still be typing.
        const match = findBestMatch(regionInput.value);
        if (match) {
            regionInput.value = match;
            commitRegion(match);
        }
    });

    regionInput.addEventListener('blur', () => {
        // On blur, snap to a match if possible; if not, reset to current region
        const match = findBestMatch(regionInput.value);
        if (match) {
            regionInput.value = match;
            commitRegion(match);
        } else {
            regionInput.value = userRegion;
        }
    });

    regionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const match = findBestMatch(regionInput.value);
            if (match) {
                regionInput.value = match;
                commitRegion(match);
            } else {
                // Nothing matched — revert and don't commit
                regionInput.value = userRegion;
            }
            regionInput.blur();
        }
        if (e.key === 'Escape') {
            regionInput.value = userRegion;
            regionInput.blur();
        }
    });

    regionRow.appendChild(regionInput);
    regionRow.appendChild(regionDatalist);
    menu.appendChild(regionRow);

    // ── Theme picker ──
    const sep2 = document.createElement('div');
    sep2.className = 'context-menu-sep';
    menu.appendChild(sep2);

    const themeHeader = document.createElement('div');
    themeHeader.className = 'context-menu-header';
    themeHeader.textContent = 'Theme';
    menu.appendChild(themeHeader);

    const themeRow = document.createElement('div');
    themeRow.className = 'context-menu-field';
    const themeSelect = document.createElement('select');
    themeSelect.className = 'theme-select';
    themeSelect.id = 'theme-select';
    themeSelect.innerHTML = `
        <option value="paper">Paper</option>
        <option value="midnight">Midnight</option>
        <option value="terminal">Terminal</option>
        <option value="glacier">Glacier</option>
        <option value="nightbloom">NightBloom</option>
        <option value="sakura">Sakura</option>
        <option value="deep-forest">Deep-Forest</option>
    `;
    themeSelect.value = (localStorage.getItem('theme') as ThemeName) || 'glacier';
    themeSelect.onchange = (ev) => loadTheme((ev.target as HTMLSelectElement).value as ThemeName);
    themeRow.appendChild(themeSelect);
    menu.appendChild(themeRow);

    // ── Download mode ──
    const sep3 = document.createElement('div');
    sep3.className = 'context-menu-sep';
    menu.appendChild(sep3);

    const dlHeader = document.createElement('div');
    dlHeader.className = 'context-menu-header';
    dlHeader.textContent = 'Download Mode';
    menu.appendChild(dlHeader);

    const dlRow = document.createElement('div');
    dlRow.className = 'context-menu-field';
    const selectMode = document.createElement('select');
    selectMode.className = 'theme-select';
    selectMode.innerHTML = `
        <option value="stream" ${downloadMode === 'stream' ? 'selected' : ''}>Stream Only</option>
        <option value="manual" ${downloadMode === 'manual' ? 'selected' : ''}>Manual Download</option>
        <option value="auto" ${downloadMode === 'auto' ? 'selected' : ''}>Auto-Download</option>
    `;
    selectMode.onchange = (ev) => {
        downloadMode = (ev.target as HTMLSelectElement).value;
        localStorage.setItem('download_mode', downloadMode);
        renderTracks(displayedTracks);
    };
    dlRow.appendChild(selectMode);
    menu.appendChild(dlRow);

    document.body.appendChild(menu);

    const closeMenu = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
});

/// One-time cleanup: if a liked track and a downloaded track have the same
/// title+artist, merge them (the downloaded one wins). This fixes the
/// duplicate state from before yt_id tracking existed.
async function deduplicateDownloads() {
    const tracks: Track[] = await invoke('get_tracks');
    const downloaded = tracks.filter(t => t.source_type === 'downloaded_native');
    if (downloaded.length === 0) return;

    // Map downloaded (title|artist) -> local path
    const dlMap = new Map<string, string>();
    for (const d of downloaded) {
        const key = `${(d.title || '').toLowerCase()}|${(d.artist_name || '').toLowerCase()}`;
        dlMap.set(key, d.file_path_or_url);
    }

    let changed = false;

    // Fix liked
    try {
        const liked: Track[] = JSON.parse(localStorage.getItem('liked_tracks_full') || '[]');
        const filtered: Track[] = [];
        const seen = new Set<string>();
        for (const t of liked) {
            const key = `${(t.title || '').toLowerCase()}|${(t.artist_name || '').toLowerCase()}`;
            if (t.source_type === 'youtube_stream' && dlMap.has(key)) {
                // Replace with downloaded version
                const localPath = dlMap.get(key)!;
                if (!seen.has(localPath)) {
                    filtered.push({ ...t, source_type: 'downloaded_native', file_path_or_url: localPath });
                    seen.add(localPath);
                }
                changed = true;
            } else {
                const id = t.file_path_or_url;
                if (!seen.has(id)) {
                    filtered.push(t);
                    seen.add(id);
                }
            }
        }
        if (changed) {
            localStorage.setItem('liked_tracks_full', JSON.stringify(filtered));
            console.log('[dedup] cleaned liked songs');
        }
    } catch (e) { console.error('[dedup] liked failed:', e); }

    // Fix playlists
    if (changed) {
        for (const pl of playlists) {
            if (!pl.tracks) continue;
            const newTracks: string[] = [];
            const seen = new Set<string>();
            for (const id of pl.tracks) {
                // Find the track in currentTracks to check title/artist
                const t = tracks.find(x => x.file_path_or_url === id);
                if (t) {
                    const key = `${(t.title || '').toLowerCase()}|${(t.artist_name || '').toLowerCase()}`;
                    if (t.source_type === 'youtube_stream' && dlMap.has(key)) {
                        const lp = dlMap.get(key)!;
                        if (!seen.has(lp)) { newTracks.push(lp); seen.add(lp); }
                        continue;
                    }
                }
                if (!seen.has(id)) { newTracks.push(id); seen.add(id); }
            }
            pl.tracks = newTracks;
        }
        savePlaylists();
        console.log('[dedup] cleaned playlists');
    }
}

// ==========================================
// Init
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    const getPort = async () => {
        try {
            proxyPort = await invoke('get_proxy_port');
        } catch {
            setTimeout(getPort, 500);
        }
    };
    getPort();

    setTimeout(checkForUpdates, 5000);
    // Safety net — hide splash after 15s no matter what
    setTimeout(() => {
        const splash = document.getElementById('splash');
        if (splash && !splash.classList.contains('hidden')) {
            console.warn('[setup] splash timeout — hiding anyway');
            splash.classList.add('hidden');
            setTimeout(() => splash.remove(), 350);
        }
    }, 15000);

    (async () => {
    
    // Wait for yt-dlp, scan playlists, render home
    await waitForYtDlp();
    await deduplicateDownloads();
    // Now do the background work — splash is already gone
    const physicalPlaylists = playlists.filter(p => p.folderPath && !p.folderPath.startsWith('VIRTUAL_'));
    for (const pl of physicalPlaylists) {
        try {
            await invoke('scan_directory', { path: pl.folderPath });
        } catch (e) {
            console.error("Startup scan failed:", pl.folderPath);
        }
    }
    // Push the saved region to the Rust backend so queries are region-aware
    try {
        await invoke('set_user_region', { region: userRegion });
    } catch (e) {
        console.warn('[region] failed to send to backend:', e);
    }

    await fetchAndRenderTracks();
    // Render the queue panel once so peek has content
    renderQueuePanel();
})();
    setupKeybindings();
});