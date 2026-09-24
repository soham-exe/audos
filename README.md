<div align="center">

# Audos

**Your music, mapped.**

A local-first desktop music player with YouTube streaming, offline downloads, and a themeable interface.

[![Latest Release](https://img.shields.io/github/v/release/soham-exe/audos?style=flat-square&color=d8432e)](https://github.com/soham-exe/audos/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/gpl-3.0)
[![Platform](https://img.shields.io/badge/platform-Windows-informational?style=flat-square)](https://github.com/soham-exe/audos/releases/latest)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?style=flat-square)](https://tauri.app)

[**Download**](https://github.com/soham-exe/audos/releases/latest) · [**Themes**](THEMES.md) · [**Report a bug**](https://github.com/soham-exe/audos/issues)

</div>

---

## What it is

Audos is a desktop music player that treats your local library and YouTube as one collection. Scan a folder on your disk, search YouTube for anything you don't have, and mix them into playlists that live side by side. No accounts, no cloud, no telemetry — everything runs on your machine.

It's built with [Tauri 2](https://tauri.app) (Rust + a webview) and [yt-dlp](https://github.com/yt-dlp/yt-dlp) for the streaming side.

---

## Features

### Library
- **Scan local folders** for MP3, FLAC, M4A, WAV, OGG, Opus, AAC, WMA
- **Reads ID3 tags** — title, artist, album, embedded cover art
- **Auto-detects** new and removed files, cleans up missing entries
- **Virtual playlists** — Liked Songs and Downloads, populated automatically

### Streaming
- **Search YouTube** directly from the search bar
- **Stream without downloading** — plays through a local proxy so seeking and buffering work correctly
- **Auto-download mode** — save tracks as you play them
- **Manual download mode** — decide track by track
- **Radio mode** — when the queue runs out, Audos fetches related tracks and keeps playing

### Playback
- **Queue system** with drag-to-reorder, drag-to-append, and click-to-jump
- **Shuffle** and **repeat** (off / all / one)
- **Volume control** with mute toggle
- **Keyboard shortcuts** — Space to play/pause, Ctrl+←/→ for prev/next, Ctrl+/ to focus search

### Interface
- **Five themes** — Paper, Midnight, Nord, Terminal, Glacier
- **Custom background** — use any image or video as the app backdrop
- **Custom profile picture** — pick any image
- **Themeable from top to bottom** — see [THEMES.md](THEMES.md) for the authoring guide
- **Collapsible sidebar** for a minimal layout

### Under the hood
- **Local SQLite database** for your library — instant startup, offline search
- **Virtualized track list** — handles libraries of any size without lag
- **Auto-updates** — signed installers, verified via Ed25519, delivered from GitHub Releases
- **Self-contained** — yt-dlp is downloaded and updated automatically on first run

---

## Download

### Windows

**[⬇ Download the latest installer](https://github.com/soham-exe/audos/releases/latest)**

Two installer formats are available:

| Format | Best for |
|---|---|
| **`Audos_x64-setup.exe`** | Most users. Fast install, clean uninstall. **Recommended.** |
| **`Audos_x64_en-US.msi`** | Corporate environments, system-wide installs, group policy deployment. |

Both are signed. Windows SmartScreen may warn on first run since the app isn't code-signed with a commercial certificate — click **More info → Run anyway**.

### Requirements

- **Windows 10 or 11** (64-bit)
- ~150 MB of disk space (~40 MB for the app, ~100 MB for the yt-dlp binary downloaded on first run)
- An internet connection (for streaming, updating, and yt-dlp setup)

macOS and Linux builds aren't available yet. The code is cross-platform — the build is just not configured for those targets.

---

## First launch

When you open Audos for the first time:

1. It downloads **yt-dlp** (~100 MB) into `%APPDATA%\com.audos.app\`. This is a one-time setup; subsequent launches are instant.
2. It creates a local **SQLite database** for your library.
3. The home feed starts loading — trending songs, jazz, lo-fi, and other categories appear as they fetch.

**To add your own music:**

- Click the **➕** button in the sidebar → pick a folder. Audos scans it recursively.
- Tracks appear under the folder name in your library.

**To find something new:**

- Type in the search bar. Audos searches your library first, then falls back to YouTube.
- Click any result to play. If you like it, click the download icon to save it locally.

**To customize:**

- Right-click the profile button (top-right corner) for themes, download mode, background image/video, and profile picture.

---

## Building from source

Only needed if you want to modify the app or build your own installer.

### Prerequisites

- [Node.js](https://nodejs.org) 18 or newer
- [Rust](https://rustup.rs) (stable toolchain)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload
- [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (pre-installed on Windows 10/11)

### Dev

```powershell
git clone https://github.com/soham-exe/audos.git
cd audos
npm install
npm run tauri dev
```

First run compiles the Rust dependencies — expect 3-5 minutes. Subsequent runs are fast.

### Build a release installer

```powershell
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/`:

- `msi/Audos_X.Y.Z_x64_en-US.msi`
- `nsis/Audos_X.Y.Z_x64-setup.exe`

Signing for auto-updates requires a private key. See [RELEASING.md](RELEASING.md) if you're maintaining a fork and want auto-updates working.

---

## How updates work

Audos checks for updates 5 seconds after launch, silently. If a new version is available, you get a dialog. If you accept, it downloads, verifies the Ed25519 signature, installs, and relaunches.

- **Endpoint:** `https://github.com/soham-exe/audos/releases/latest/download/latest.json`
- **Signature scheme:** minisign (Ed25519), verified against a public key baked into the app
- **Failure mode:** silent. If the network is down or GitHub is unreachable, nothing happens — the app keeps working.

Updates only flow from versions that ship with the updater. If you're on an ancient build, you'll need to install the newest one manually.

---

## Themes

Audos ships with five:

| Theme | Description |
|---|---|
| **Paper** | Warm off-white default. Editorial feel. |
| **Midnight** | Deep dark with warm orange accents and translucent panels. |
| **Nord** | Cool blue-gray palette, low contrast. |
| **Terminal** | Flat, monospace, phosphor green. |
| **Glacier** | Teal-slate with semi-translucent panels. |

Writing your own is a single CSS file plus three registrations. See **[THEMES.md](THEMES.md)** for the complete token reference, structural patterns, icon filter cookbook, and troubleshooting.

---

## Project layout

```
audos/
├── src/                    Frontend (TypeScript, no framework)
│   ├── main.ts             All UI logic
│   ├── styles.css          Base stylesheet + design tokens
│   └── themes/             Per-theme overrides
├── src-tauri/              Backend (Rust)
│   ├── src/
│   │   ├── lib.rs          App setup and command registry
│   │   ├── db.rs           SQLite
│   │   ├── scanner.rs      Local file scanning
│   │   ├── download.rs     yt-dlp downloads
│   │   ├── home_feed.rs    Home page categories
│   │   ├── radio.rs        Related-track fetching
│   │   ├── proxy.rs        Local HTTP proxy for streaming
│   │   ├── yt_bridge.rs    yt-dlp search + stream URLs
│   │   └── yt_setup.rs     yt-dlp download/verify
│   ├── icons/              App icons (generated)
│   └── tauri.conf.json     App config, updater endpoint, pubkey
├── public/                 Static assets (icons, backgrounds)
├── .github/workflows/      CI/CD
└──THEMES.md               Theme authoring guide
```

---

## Privacy

Audos collects nothing. No accounts, no analytics, no telemetry, no phone-home.

- Your library database lives at `%APPDATA%\com.audos.app\audos.db`
- Downloads and yt-dlp live in the same folder
- The only outbound requests are:
  - **yt-dlp** — to YouTube, when you search or stream
  - **Updater** — to GitHub Releases, 5 seconds after launch, once per session
  - **yt-dlp auto-update** — to GitHub, once every 30 days (when yt-dlp binary is older than that)

Everything else is local.

---

## Troubleshooting

**CMD window flashes on launch**
This shouldn't happen in v0.1.2 or later. If you see it, you're on an older build. Update.

**Tracks won't play / streams hang**
Usually a yt-dlp issue. Delete `%APPDATA%\com.audos.app\yt-dlp.exe` and restart Audos — it re-downloads a fresh copy.

**Update dialog never appears**
Check that `https://github.com/soham-exe/audos/releases/latest/download/latest.json` loads in a browser. If it 404s, either no release is published, or you're behind a network that blocks GitHub.

**Icons look wrong / app icon is stale**
Windows caches exe icons. Uninstall, reboot, reinstall. See below for the full procedure.
### Failure 6 — Windows shows the old app icon

**Symptom:** You changed the icon, rebuilt, reinstalled — but Explorer and the
taskbar still show the old one.

**Cause:** Windows caches exe icons aggressively.

**Fix:**

1. Uninstall Audos
2. Clear the icon cache:

   ```powershell
   Stop-Process -Name explorer -Force
   Remove-Item "$env:LOCALAPPDATA\IconCache.db" -Force -ErrorAction SilentlyContinue
   Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*.db" -Force -ErrorAction SilentlyContinue
   Start-Process explorer
   ```

3. Reboot (the only 100% reliable purge)
4. Reinstall

Alternatively, try `ie4uinit.exe -show` — sometimes sufficient, sometimes not.

---


## Contributing

Issues and pull requests are welcome. Before opening a PR:

- Test on Windows 10 and 11 if you can
- Run `npm run tauri dev` and confirm nothing in the app breaks
- For theme additions, follow the three registration edits in [THEMES.md](THEMES.md)
- For Rust changes, run `cargo check` in `src-tauri/` before committing

There's no formal contribution guide — just be reasonable and explain your reasoning in the PR.

---

## License

**GNU General Public License v3.0**

Audos is free software. You can use, modify, and redistribute it, including commercially, as long as any derivative work is also GPL-3.0 and you provide source. See [LICENSE](LICENSE) for the full text.

**In practice:** fork it, change it, ship it — just keep it open. You can't take this code and make a closed-source product from it.

---

## Credits

Built by [@soham-exe](https://github.com/soham-exe).

Standing on the shoulders of:

- [Tauri](https://tauri.app) — the desktop framework
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — the streaming workhorse
- [Swapy](https://swapy.tahazsh.com) — drag-to-reorder in the queue
- [Axum](https://github.com/tokio-rs/axum) — the local HTTP proxy
- [rusqlite](https://github.com/rusqlite/rusqlite) — the library database

---

<div align="center">

**If Audos is useful to you, [star the repo](https://github.com/soham-exe/audos). It helps.**

</div>