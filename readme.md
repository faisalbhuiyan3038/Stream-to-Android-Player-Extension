# Stream to Android Player Extension

[![GitHub release](https://img.shields.io/github/v/release/faisalbhuiyan3038/Stream-to-Android-Player-Extension)](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A browser extension to detect streaming videos (M3U8, MP4) and send them to your preferred media player on Android and Windows. Supports VLC, MPV, and other players with command-line arguments.

## Changelog
### 1.5
- **Referer / User-Agent forwarding**: the page's headers are sent along with the stream to the built-in players (Referer/Origin rewrite), mpv/VLC (native host, `--referrer`, `--user-agent`, VLC HTTP) and optionally cookies (off by default).
- **Subtitles**: `.vtt` / `.srt` files and `<track>` elements are detected, shown as a `CC n` badge and loaded in the Shaka player (press `C` to cycle). They are also passed to mpv/VLC (`--sub-file`) and to VLC on Android.
- **Quality picker**: master HLS playlists are parsed; the real resolution is shown and you can send a specific variant (1080p, 720p, ...) to any action. Duration is now also read for master playlists and `.mpd` manifests.
- **Android**: choose the player (VLC, MX Player, MX Player Pro, mpv-android or the system chooser), bigger touch targets, tap action setting.
- **Popup stream list**, toolbar badge with the stream count, context menu on links/videos, `Alt+Shift+P` shortcut (desktop), notifications instead of `alert()` for errors.
- **Native host v2**: no more generated `.bat` for the normal path (arguments are passed safely as a list), argument templates (`{url} {referer} {ua} {title} {cookie} {sub}`), download with yt-dlp / ffmpeg, a "Test native host" button, `install.sh` for Linux/macOS.
- DASH links opened in the Vidstack player are now handed to Shaka (Vidstack 0.6 cannot play DASH).
- Fixes: streams requested while a page loads are no longer lost, stale streams no longer survive a navigation, `.ts` segments that belong to a detected playlist are hidden (standalone `.ts` streams are still listed), the stream button now also appears when the page script loads late.
- Tests: unit, native host and browser (Chromium + Firefox) tests, GitHub Actions workflow, cross-platform packaging.
- **Floating button**: drag it anywhere (long-press on touch); it snaps to a side edge, remembers the spot per site, and the menu opens towards the side with room. Popup: corner picker, *Reset button position*, and visibility *Always / Fade when idle / Hidden*. It also hides while a video is fullscreen.
- **Protocol handler**: links are now percent-encoded (lc://https%3A%2F%2F...) so browsers cannot mangle them; a ready-made handler for Windows/Linux and a setup guide are in [docs/PROTOCOL_HANDLER.md](docs/PROTOCOL_HANDLER.md), which also explains how to switch on VLC's web interface. **Native Messaging is now the default method.**
### 1.4
- Fix Native Host Messaging not launching streams or python script.
- Fix icons not appearing in some websites.
- Instantly apply popup settings. No need to reload page.
### 1.3
- Added Desktop support.
- Add web video player, copy URL, and ability to open in external video player features to desktop.
- Native Host messaging requires additional setup. Stay tuned for instructions.
### 1.2
- Fixed overheating, high resource usage issues.
- Added better styling.
- Added popup UI to configure settings.
- Streams show duration (if found).
### 1.1
- Added multiple streaming detection methods
- Successfully detects streams from sites that were not detected in 1.0
### 1.0
- Initial release
- Detects streaming videos from many sites successfuly.
- Fails in few sites.

## Features
### **Stream Detection**
- Detects streaming formats: **M3U8 (HLS), MP4, DASH (MPD), MPEG-TS, WebM, H.264/AVC, H.265/HEVC**. 
- Extracts video sources from `<video>` and `<source>` tags.
- Filters non-video URLs (e.g., `data:`, `blob:`).
- Supports **quality detection** (e.g., 1080p, 4K) via URL patterns.

### **Player Support**
- **Android**: VLC, MX Player, and other players via **Web Share API**.
- **Desktop**: VLC, MPV, and other players via:
  - **Native Messaging** (browser-to-app communication).
  - **Protocol Handlers** (e.g., `vlc://`, `mpv://`).
  - **VLC HTTP Interface** (remote control).
- **In-Browser Playback**: Shaka Player (HLS/DASH/MP4) and Vidstack.

### **Platform Support**
- **Android**: Web Share API integration.
- **Desktop**: Windows, macOS, Linux (native messaging/protocol handlers).
- **Browsers**: Chrome, Firefox, Edge.

### **UI/UX**
- **Toolbar Icon**: Quick access to extension settings.
- **Popup UI**:
  - Toggle extension on/off.
  - Configure **whitelists/blacklists** for domains.
  - Set **maximum stream count** (e.g., limit to 5 streams).
  - Customize **default actions** (e.g., "Share" on Android, "Copy" on Desktop).
- **Stream Menu**:
  - Displays detected streams with **quality badges** (e.g., "1080p").
  - Shows **duration** (if available).
  - Supports **keyboard shortcuts** (e.g., fullscreen).
- **Notifications**: Alerts for errors (e.g., failed player launches).

### **Customization**
- **Player Preferences**: Choose VLC, MPV, or custom player paths.
- **Keyboard Shortcuts**: Fullscreen, play/pause, volume control (in-browser player).
- **Advanced Options**:
  - **Subtitles**: Supported via Shaka Player (WebVTT, TTML).
  - **Quality Selection**: Auto-detected from stream metadata.
  - **Casting**: Indirectly supported via external players (e.g., VLC Chromecast).

## Installation
1. **Browser Extension**:
   - Download the latest release from [Firefox Store](https://addons.mozilla.org/en-US/firefox/addon/stream-to-android-player/).

2. **Native Host Setup** (Required for desktop):
   - Download the **Native Host** zip from [GitHub Releases](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases/tag/v1.0.0).
   - Follow the setup instructions below for your OS.

## Usage
1. Navigate to a webpage with a streaming video.
2. Click the extension icon in the toolbar.
3. Select the detected stream from the list.
4. Choose your preferred media player from the sharing menu (Android) or let the native host open it directly (desktop).

## Native Host Setup
The native host is required to open streams directly in VLC, MPV, or other players on desktop.

### Windows
1. Download the **Native Host** zip from [GitHub Releases](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases/tag/v1.0.0).
2. Extract the zip file.
3. Run `native-host\install.bat` (no administrator rights needed; it only writes to your user registry). For Chrome/Edge/Brave pass or enter the extension ID shown in `chrome://extensions`.
4. Restart your browser, then choose *Native Messaging* under *External Player Integration* in the popup and press *Test native host*.

### Linux / macOS
Run `native-host/install.sh [chromium-extension-id]` (needs `python3`). Not covered by the automated browser tests yet.

### Optional arguments and downloads
In the popup you can set the player path, an argument template and a download folder. The download button needs `yt-dlp` (preferred) or `ffmpeg` on your PATH.

### Supported Players
- **VLC**: Works out of the box.
- **MPV**: Works out of the box.
- **Other Players**: May work if they support the same command-line arguments as VLC/MPV.

## Troubleshooting
### **Extension Issues**
- **Extension icon not appearing**:
  - Ensure the extension is loaded correctly in **Developer Mode**.
  - Refresh the webpage or restart the browser.

- **Streams not detected**:
  - The website may use a **non-standard format** (e.g., DRM-protected streams).
  - Check the extension popup for **error logs**.
  - Try **whitelisting** the domain in settings.

- **Popup UI not responding**:
  - Disable and re-enable the extension.
  - Clear browser cache and reload.

### **Player Issues**
- **Android (Web Share API)**:
  - Ensure **VLC/MX Player** is installed.
  - Grant **storage permissions** to the player app.
  - Restart the browser if sharing fails.

- **Desktop (Native Host)**:
  - Ensure the **native host is installed** (check `chrome://extensions` or `about:addons`).
  - Verify **browser permissions** for native messaging.
  - Restart the browser and system if needed.

- **VLC/MPV not launching**:
  - Check if the **player path is correct** in extension settings.
  - Ensure **protocol handlers** (e.g., `vlc://`) are registered.
  - For **VLC HTTP Interface**, verify the password in settings.

- **In-Browser Playback**:
  - Ensure **Shaka Player/Vidstack** is enabled in settings.
  - Check for **CORS errors** in the browser console.

## License
This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.