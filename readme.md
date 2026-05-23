# Stream to Android Player Extension

[![GitHub release](https://img.shields.io/github/v/release/faisalbhuiyan3038/Stream-to-Android-Player-Extension)](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A browser extension to detect streaming videos (M3U8, MP4) and send them to your preferred media player on Android and Windows. Supports VLC, MPV, and other players with command-line arguments.

## Changelog
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

## Installation & Setup

### 1. Browser Extension

* **Firefox**:
  - Download and install the latest version from the [Firefox Add-ons Store](https://addons.mozilla.org/en-US/firefox/addon/stream-to-android-player/).

* **Chrome / Chromium-based Browsers (Edge, Brave, Opera, etc.)**:
  - Download the source code of this extension.
  - Open Chrome and navigate to `chrome://extensions/` (or `edge://extensions/` for Edge).
  - Enable **Developer Mode** using the toggle switch in the top-right corner.
  - Click **Load unpacked** and select the extension directory (the one containing `manifest.json`).
  - Once loaded, copy the **Extension ID** shown on the extension's card (e.g., `abcdefghijklmnopqrstuvwxyzabcdef`). You will need this for the Native Host configuration.

---

### 2. Native Host Setup (Required for Desktop Players)

The native host is a lightweight script that enables the browser extension to communicate with and launch desktop media players like VLC or MPV.

#### Prerequisites (Windows)
- **Python 3**: Make sure [Python](https://www.python.org/downloads/) is installed and added to your system's environment variable `PATH`.

#### Windows Setup Instructions
1. Download the **Native Host** package from [GitHub Releases](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases).
2. Extract the ZIP package to a permanent folder on your computer (do not move or delete this folder after installation, as the registry entries point to it).
3. Navigate to the extracted folder and run `install.bat`.
4. When prompted:
   - **If you only use Firefox**: Press **Enter** to leave the ID blank.
   - **If you use Chrome/Edge**: Paste the **Extension ID** you copied in Step 1 and press **Enter**.
5. Restart your browser or reload the extension in `chrome://extensions/` for the native host to connect.

---

## Usage
1. Navigate to a webpage containing a streaming video (M3U8, MP4, etc.).
2. Click the extension icon in the browser toolbar.
3. Select your desired stream from the detected list.
4. Choose your preferred media player from the sharing menu (Android) or let the native host open it directly (Desktop).

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