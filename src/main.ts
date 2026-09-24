import './styles.css';
import { createSwapy } from 'swapy';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open, confirm as tauriConfirm, message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// ==========================================
// Theme System
// ==========================================
type ThemeName = 'paper' | 'midnight' | 'nord' |'terminal'|'glacier';

function loadTheme(name: ThemeName) {
    document.body.classList.remove('theme-paper', 'theme-midnight', 'theme-nord','theme-terminal','theme-glacier');
    document.body.classList.add(`theme-${name}`);
    localStorage.setItem('theme', name);
    const sel = document.getElementById('theme-select') as HTMLSelectElement | null;
    if (sel) sel.value = name;
}

const savedTheme = (localStorage.getItem('theme') as ThemeName) || 'paper';
loadTheme(savedTheme);

// ==========================================
// Auto-update system
// ==========================================
async function checkForUpdates() {
    try {
        const update = await check();
        if (!update) return;   // no update available — silent

        const shouldUpdate = await tauriConfirm(
            `Version ${update.version} is available.\n\nCurrent version: ${update.currentVersion}\n\nUpdate now?`,
            { title: 'Update Available', kind: 'info' }
        );
        if (!shouldUpdate) return;

        await update.downloadAndInstall((event) => {
            if (event.event === 'Started') {
                console.log(`[update] downloading ${event.data.contentLength} bytes`);
            } else if (event.event === 'Progress') {
                console.log(`[update] +${event.data.chunkLength} bytes`);
            } else if (event.event === 'Finished') {
                console.log('[update] download complete');
            }
        });

        await tauriMessage('Update installed. Audos will restart.', {
            title: 'Update Complete',
            kind: 'info',
        });
        await relaunch();
    } catch (e) {
        // Silent fail — don't bug the user about update errors
        // (offline, network issues, DNS, etc.)
        console.warn('[update] check failed:', e);
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
let queue: Track[] = [];
let originalQueue: Track[] = [];
let currentIndex = -1;
let shuffleMode: 0 | 1 = 0;
let repeatMode: 0 | 1 | 2 = 0;
let isPlaying = false;
let proxyPort: number | null = null;
let downloadMode = localStorage.getItem('download_mode') || 'stream';



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
function applyShuffle(currentTrack: Track | undefined, tracks: Track[]): Track[] {
    let remaining = currentTrack ? tracks.filter(t => t !== currentTrack) : [...tracks];

    if (shuffleMode === 1) {
        for (let i = remaining.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
        }
    }

    return currentTrack ? [currentTrack, ...remaining] : remaining;
}

function setQueue(newQueue: Track[], startIndex = 0) {
    originalQueue = [...newQueue];

    if (shuffleMode > 0) {
        const currentTrack = newQueue[startIndex];
        queue = applyShuffle(currentTrack, newQueue);
        currentIndex = currentTrack ? 0 : -1;
    } else {
        queue = [...newQueue];
        currentIndex = startIndex;
    }
    refreshQueuePanel();
}

function addToQueue(track: Track, next = false) {
    if (next) {
        queue.splice(currentIndex + 1, 0, track);
    } else {
        queue.push(track);
    }
    originalQueue.push(track);
    refreshQueuePanel();
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
const BATCH_SIZE = 8;

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

    feedsContainer.innerHTML = '<p class="feed-loading">Loading your feed...</p>';

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
                card.innerHTML = `
                    <div class="album-art" style="background-image: url('${t.thumbnail}');"></div>
                    <div class="album-title">${t.title}</div>
                    <div class="album-artist">${t.uploader}</div>
                `;
                card.onclick = () => {
                    setQueue(allTracks, i);
                    playTrack(currentIndex);
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
                loadedCategoryCount + BATCH_SIZE,
                true
            );
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

            if (!append) feedsContainer.innerHTML = '';
            renderFeeds(feeds, feedsContainer);
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
    } else {
        // No valid cache — fetch the first batch
        console.log('[home] Cache miss — fetching fresh');
        loadBatch(0, BATCH_SIZE);
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

        // Re-hydrate queue with fresh object references
        const currentPath = queue[currentIndex]?.file_path_or_url;
        if (currentPath) {
            queue = queue.map(qt => currentTracks.find(t => t.file_path_or_url === qt.file_path_or_url) ?? qt);
            originalQueue = originalQueue.map(qt => currentTracks.find(t => t.file_path_or_url === qt.file_path_or_url) ?? qt);
            currentIndex = queue.findIndex(t => t.file_path_or_url === currentPath);
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
async function triggerDownload(track: Track, btnEl?: HTMLElement) {
    if (btnEl) {
        btnEl.className = 'track-row-dl-btn track-row-dl-btn--loading';
        btnEl.innerHTML = '<img src="/icons/spinner.svg" />';
    }
    try {
        const localPath: string = await invoke('download_yt_track', {
            ytId: track.file_path_or_url,
            title: track.title,
            artist: track.artist_name || track.title,
            thumbnail: track.thumbnail || "",
            duration: track.duration
        });

        track.source_type = 'downloaded_native';
        track.file_path_or_url = localPath;

        if (btnEl) {
            btnEl.className = 'track-row-dl-btn track-row-dl-btn--success';
            btnEl.innerHTML = '<img src="/icons/downloaded.svg" />';
        }

        if (!playlists.some(p => p.folderPath === 'VIRTUAL_DOWNLOADS')) {
            const likedIdx = playlists.findIndex(p => p.folderPath === 'VIRTUAL_LIKED_SONGS');
            const newPl = { name: 'Downloads', folderPath: 'VIRTUAL_DOWNLOADS' };
            if (likedIdx !== -1) playlists.splice(likedIdx + 1, 0, newPl);
            else playlists.unshift(newPl);
            savePlaylists();
        }

        await fetchAndRenderTracks();
    } catch (e) {
        console.error("Download failed", e);
        if (btnEl) {
            btnEl.className = 'track-row-dl-btn track-row-dl-btn--error';
            btnEl.innerHTML = '<img src="/icons/error.svg" />';
        }
        await tauriMessage(`Download failed: ${e}`, { title: 'Download Error', kind: 'error' });
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

    // ── Index number (001, 002, 003 — visible only when theme sets
    //    --track-index-width > 0) ──
    const indexEl = document.createElement('span');
    indexEl.className = 'track-row-index';
    indexEl.textContent = String(index + 1).padStart(3, '0');
    item.appendChild(indexEl);

    // ── Currently playing marker (themed via --track-playing-text) ──
    if (currentIndex !== -1 && queue[currentIndex]?.file_path_or_url === track.file_path_or_url) {
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
        const dlBtn = document.createElement('button');
        dlBtn.className = 'track-row-dl-btn';
        dlBtn.innerHTML = '<img src="/icons/download.svg" />';
        dlBtn.onclick = (e) => { e.stopPropagation(); triggerDownload(track, dlBtn); };
        item.appendChild(dlBtn);
    }

    item.onclick = () => {
        setQueue(tracks, index);
        playTrack(currentIndex);
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
        queue = queue.filter(t => t.file_path_or_url !== track.file_path_or_url);
        originalQueue = originalQueue.filter(t => t.file_path_or_url !== track.file_path_or_url);

        for (const pl of playlists) {
            if (pl.tracks) {
                pl.tracks = pl.tracks.filter(id => id !== track.file_path_or_url);
            }
        }
        savePlaylists();

        if (currentIndex !== -1 && queue[currentIndex]?.file_path_or_url === track.file_path_or_url) {
            currentIndex = -1;
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
        renderTracks(displayedTracks, localMatches.length > 0 ? 'Search Results' : 'Searching YouTube...');

        if (localMatches.length === 0) {
            try {
                const ytResults: YtTrack[] = await invoke('search_youtube', { query });

                // Cap at 10 and map to Track
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
                renderTracks(displayedTracks, 'YouTube Results');
            } catch (err) {
                console.error('YouTube search failed:', err);
                renderTracks([], 'No results found (YouTube Error)');
            }
        }
    }, 500);
});

// ==========================================
// Playback
// ==========================================
async function playTrack(index: number) {
    if (index < 0 || index >= queue.length) return;

    currentIndex = index;
    const track = queue[index];

    addToHistory(track);

    if (track.source_type === 'youtube_stream') {
        if (!proxyPort) {
            await tauriMessage("Proxy server is not ready yet. Please wait a moment and try again.", {
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

    audio.play().catch(e => console.error("Playback error:", e));
    isPlaying = true;

    const playIcon = document.getElementById('play-icon') as HTMLImageElement;
    if (playIcon) playIcon.src = '/icons/pause.svg';

    titleEl.textContent = track.title || 'Unknown Title';
    artistEl.textContent = track.artist_name || 'Unknown Artist';

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
// Queue auto-extension (radio mode)
// ==========================================
let extendingQueue = false;
const QUEUE_EXTEND_THRESHOLD = 2;   // extend when 2 or fewer tracks remain
const MAX_AUTO_QUEUE = 200;          // hard cap to prevent infinite growth

async function maybeExtendQueue() {
    if (extendingQueue) return;
    if (currentIndex < 0) return;

    const remaining = queue.length - currentIndex - 1;
    if (remaining > QUEUE_EXTEND_THRESHOLD) return;
    if (queue.length >= MAX_AUTO_QUEUE) {
        console.log('[radio] Queue at max size, not extending');
        return;
    }

    // Only extend for YouTube tracks — local files don't have a "mix"
    const lastTrack = queue[queue.length - 1];
    if (!lastTrack || lastTrack.source_type !== 'youtube_stream') {
        console.log('[radio] Queue ends with non-YT track, skipping extension');
        return;
    }

    extendingQueue = true;
    console.log(`[radio] Queue running low (${remaining} left), extending from: ${lastTrack.title}`);

    try {
        const related: YtTrack[] = await invoke('fetch_related_tracks', {
            ytId: lastTrack.file_path_or_url
        });

        if (!related || related.length === 0) {
            console.log('[radio] No related tracks returned');
            return;
        }

        // Filter out tracks already in the queue (by yt id)
        const existingIds = new Set(queue.map(t => t.file_path_or_url));
        const fresh = related.filter(t => !existingIds.has(t.id));

        if (fresh.length === 0) {
            console.log('[radio] All related tracks already in queue');
            return;
        }

        // Convert to Track objects and append
        const newTracks: Track[] = fresh.map(t => ({
            id: t.id,
            source_type: 'youtube_stream',
            file_path_or_url: t.id,
            title: t.title,
            artist_name: t.uploader,
            duration: t.duration,
            thumbnail: t.thumbnail
        }));

        queue.push(...newTracks);
        originalQueue.push(...newTracks);

        console.log(`[radio] Appended ${newTracks.length} tracks to queue`);
        refreshQueuePanel();
    } catch (e) {
        console.error('[radio] Failed to extend queue:', e);
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

        if (shuffleMode === 1 && queue.length > 0) {
            if (originalQueue.length === 0) originalQueue = [...queue];
            const currentTrack = queue[currentIndex];
            queue = applyShuffle(currentTrack, originalQueue);
            currentIndex = currentTrack ? 0 : -1;
            refreshQueuePanel();
        } else if (shuffleMode === 0 && originalQueue.length > 0) {
            const currentTrack = queue[currentIndex];
            queue = [...originalQueue];
            currentIndex = currentTrack
                ? queue.findIndex(t => t.file_path_or_url === currentTrack.file_path_or_url)
                : -1;
            if (currentIndex === -1) currentIndex = 0;
            refreshQueuePanel();
        }
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

    if (currentIndex + 1 < queue.length) {
        playTrack(currentIndex + 1);
        return;
    }

    // We're at the end of the queue.
    // For repeat-all, loop back to start.
    if (isRepeatAll && queue.length > 0) {
        if (shuffleMode > 0) {
            queue = applyShuffle(undefined, originalQueue.length > 0 ? originalQueue : queue);
            refreshQueuePanel();
        }
        playTrack(0);
        return;
    }

    // Otherwise, try to extend the queue from the last track's YouTube mix.
    const lastTrack = queue[queue.length - 1];
    if (!lastTrack || lastTrack.source_type !== 'youtube_stream') {
        console.log('[radio] Nothing to extend from');
        return;
    }

    console.log('[radio] End of queue reached, fetching more...');

    try {
        const related: YtTrack[] = await invoke('fetch_related_tracks', {
            ytId: lastTrack.file_path_or_url
        });

        if (!related || related.length === 0) {
            console.log('[radio] No more related tracks found');
            return;
        }

        const existingIds = new Set(queue.map(t => t.file_path_or_url));
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

        queue.push(...newTracks);
        originalQueue.push(...newTracks);
        refreshQueuePanel();

        // Now play the first new track
        playTrack(currentIndex + 1);
    } catch (e) {
        console.error('[radio] Extension failed:', e);
    }
}

const nextBtn = document.getElementById('btn-next') as HTMLButtonElement;
const prevBtn = document.getElementById('btn-prev') as HTMLButtonElement;

if (nextBtn) nextBtn.addEventListener('click', () => goNextTrack(true));

if (prevBtn) {
    prevBtn.addEventListener('click', () => {
        if (audio.currentTime > 3) {
            audio.currentTime = 0;
            audio.play();
        } else {
            const prev = currentIndex - 1;
            if (prev >= 0) playTrack(prev);
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

    const titleRow = document.createElement('div');
    titleRow.className = 'queue-header';

    titleRow.innerHTML = `
        <h3>Queue</h3>
        <span class="queue-count">${queue.length} tracks</span>
    `;

    if (queue.length > 0) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'queue-clear-btn';
        clearBtn.textContent = 'Clear';
        clearBtn.onclick = () => { queue = []; originalQueue = []; currentIndex = -1; refreshQueuePanel(); };
        titleRow.appendChild(clearBtn);
    }
    panel.appendChild(titleRow);

    if (queue.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'queue-empty';
        empty.textContent = 'Drag songs here';
        panel.appendChild(empty);
    }

    const listEl = document.createElement('div');
    listEl.id = 'queue-list';
    listEl.setAttribute('data-swapy-container', 'true');

    const startIndex = Math.max(0, currentIndex);
    const upcomingTracks = queue.slice(startIndex, startIndex + 51);

    upcomingTracks.forEach((track, localIdx) => {
        const realIdx = startIndex + localIdx;
        const isCurrent = realIdx === currentIndex;

        const slot = document.createElement('div');
        slot.setAttribute('data-swapy-slot', `slot-${localIdx}`);

        const item = document.createElement('div');
        item.className = 'q-item' + (isCurrent ? ' q-item--current' : '');
        item.setAttribute('data-swapy-item', `item-${track.id}-${realIdx}`);

        const handle = document.createElement('div');
        handle.className = 'q-handle';
        handle.setAttribute('data-swapy-handle', 'true');
        handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="3" cy="3.5" r="1.4"/><circle cx="7" cy="3.5" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="12.5" r="1.4"/><circle cx="7" cy="12.5" r="1.4"/></svg>`;

        const thumb = document.createElement('div');
        thumb.className = 'q-thumb';
        if (track.thumbnail) thumb.style.backgroundImage = `url('${track.thumbnail}')`;

        const info = document.createElement('div');
        info.className = 'q-info';
        info.innerHTML = `
            <div class="q-title">${track.title || 'Unknown'}</div>
            <div class="q-artist">${track.artist_name || ''}</div>
        `;

        info.onclick = () => playTrack(realIdx);

        item.appendChild(handle);
        item.appendChild(thumb);
        item.appendChild(info);
        slot.appendChild(item);
        listEl.appendChild(slot);
    });

    panel.appendChild(listEl);

    // Drop zone (unchanged logic)
    let dragDepth = 0;
    const setDropActive = (active: boolean) => panel.classList.toggle('queue-drop-active', active);

    panel.addEventListener('dragenter', (e: DragEvent) => {
        e.preventDefault(); dragDepth++;
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
    }, true);
    panel.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }, true);
    panel.addEventListener('dragleave', () => {
        dragDepth--; if (dragDepth <= 0) { dragDepth = 0; setDropActive(false); }
    }, true);
    panel.addEventListener('drop', (e: DragEvent) => {
        dragDepth = 0; setDropActive(false);
        const raw = e.dataTransfer?.getData('text/plain');
        if (!raw || raw.includes('queue-reorder')) return;
        e.preventDefault(); e.stopPropagation();
        try {
            const dropped = JSON.parse(raw) as Track;
            if (!dropped?.file_path_or_url) return;
            const insertPosition = currentIndex >= 0 ? currentIndex + 1 : queue.length;
            queue.splice(insertPosition, 0, dropped);
            originalQueue.push(dropped);
            refreshQueuePanel();
        } catch (err) { console.error('[Queue Drop] Parse failed:', err); }
    }, true);

    document.getElementById('app')!.appendChild(panel);

    if (upcomingTracks.length > 0) {
        const swapy = createSwapy(listEl, { animation: 'dynamic' });
        swapy.onSwapEnd(() => {
            const nodes = listEl.querySelectorAll('[data-swapy-item]');
            const currentPlayingTrack = queue[currentIndex];
            const newlySortedSlice: Track[] = [];
            nodes.forEach((node) => {
                const originalRealIdx = parseInt(node.getAttribute('data-swapy-item')!.split('-').pop()!);
                const t = queue[originalRealIdx];
                if (t) newlySortedSlice.push(t);
            });
            queue.splice(startIndex, newlySortedSlice.length, ...newlySortedSlice);
            if (shuffleMode === 0) originalQueue = [...queue];
            if (currentPlayingTrack) currentIndex = queue.findIndex(t => t === currentPlayingTrack);
            refreshQueuePanel();
        });
    }
}

function refreshQueuePanel() {
    const app = document.getElementById('app');
    if (!app) return;

    // Only refresh if the queue is currently open
    if (!app.classList.contains('queue-open')) return;

    const panel = document.getElementById('queue-panel');
    if (panel) panel.remove();
    renderQueuePanel();
}

if (queueBtn) {
    queueBtn.addEventListener('click', () => {
        const app = document.getElementById('app');
        if (!app) return;

        const isOpen = app.classList.contains('queue-open');

        if (isOpen) {
            // Close: remove class first (triggers grid collapse + panel fade out)
            app.classList.remove('queue-open');
            queueBtn.classList.remove('active');

            // Remove the panel after the transition finishes
            setTimeout(() => {
                const panel = document.getElementById('queue-panel');
                if (panel && !app.classList.contains('queue-open')) {
                    panel.remove();
                }
            }, 320);
        } else {
            // Open: create panel (or recreate if it was destroyed), then add class
            let panel = document.getElementById('queue-panel');
            if (!panel) {
                renderQueuePanel();
            }
            // Force a layout read so the transition triggers
            void app.offsetWidth;
            app.classList.add('queue-open');
            queueBtn.classList.add('active');
        }
    });
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
});

audio.addEventListener('ended', () => goNextTrack(false));

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
        if (currentIndex === -1 || queue.length === 0) return;
        const track = queue[currentIndex];
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

    if (!savedPath) return;

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
    menu.style.left = `${e.clientX - 150}px`;
    menu.style.top = `${e.clientY}px`;

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
        <option value="paper">Paper (default)</option>
        <option value="midnight">Midnight</option>
        <option value="nord">Nord</option>
        <option value="terminal">Terminal</option>
        <option value="glacier">Glacier</option>
    `;
    themeSelect.value = savedTheme;
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

    // Silent update check — 5 seconds after launch so it doesn't
    // compete with yt-dlp setup and the home feed for network
    setTimeout(checkForUpdates, 5000);
    
    (async () => {
        // Wait for yt-dlp to be ready before the home feed tries
        // to hit YouTube. On a warm launch this returns in ~1 frame.
        await waitForYtDlp();

        const physicalPlaylists = playlists.filter(p => p.folderPath && !p.folderPath.startsWith('VIRTUAL_'));
        for (const pl of physicalPlaylists) {
            try {
                await invoke('scan_directory', { path: pl.folderPath });
            } catch (e) {
                console.error("Startup scan failed:", pl.folderPath);
            }
        }
        await fetchAndRenderTracks();
    })();

    setupKeybindings();
});