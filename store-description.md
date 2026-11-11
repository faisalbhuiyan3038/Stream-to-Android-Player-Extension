Firefox addon store supports some markdown, so only those are used below. Chrome doesn't support any markdown at all.

A browser extension to detect streaming videos (M3U8, MPD, MP4) and send them to your preferred media player on Android and Windows, play them in the browser, or save them as MP4. Supports VLC, MPV, MX Player, and other players with command-line arguments.

**Changelog**
1.6
- Download videos as MP4 right in the browser, no extra setup needed. Works on Android too.
- Choose the quality and audio language before downloading. Subtitles are saved inside the MP4 (and optionally as .srt files).
- Duration and quality now show right away, also on sites that protect their video links.
- Faster loading in the built-in player. Videos start and skip ahead much quicker on slow sites.
- Built-in player works much better on phones: bigger buttons, double-tap to skip 10 seconds, quality, subtitle and speed menus, and landscape in fullscreen.
- Built-in player remembers where you stopped and your playback speed.
- More subtitle formats work in the built-in player, with proper language names like "English".
- Streams now show a clean name taken from the page (e.g. "Show Name S01E05").
- Finds more videos, including ones inside embedded players.
- Option to open .m3u8 and .mpd links directly in the built-in player.
- Better whitelist/blacklist matching, and you can add your own detection patterns.
- Settings changes apply to open pages instantly.
- Removed unused permissions.
- Many fixes and improvements.
1.5
- Sends the page's referrer and user agent along with the stream, so more streams play in external players. Cookies can be sent too (off by default).
- Detects subtitles and sends them to the players.
- Pick a quality (1080p, 720p...) before sending a stream.
- Android: choose VLC, MX Player, mpv or the share menu.
- Stream list in the popup, stream count on the toolbar icon, right-click menu and Alt+Shift+P shortcut.
- Floating button can be dragged anywhere and remembers its spot on each site.
- Easier native host setup, and downloading streams with yt-dlp or ffmpeg.
- Fixed streams being missed or old streams staying in the list.
1.4
- Fix Native Host Messaging not launching streams or python script.
- Fix icons not appearing in some websites.
- Instantly apply popup settings. No need to reload page.
1.3
- Added Desktop support.
- Add web video player, copy URL, and ability to open in external video player features to desktop.
- Native Host messaging requires additional setup. Stay tuned for instructions.
1.2
- Fixed overheating, high resource usage issues.
- Added better styling.
- Added popup UI to configure settings.
- Streams show duration (if found).
1.1
- Added multiple streaming detection methods
- Successfully detects streams from sites that were not detected in 1.0
1.0
- Initial release
- Detects streaming videos from many sites successfuly.
- Fails in few sites.

**Features**
**Stream Detection**
- Detects streaming formats: **M3U8 (HLS), DASH (MPD), MP4, MPEG-TS, WebM** and other video files.
- Watches the page's network requests and extracts video sources from <video> and <source> tags.
- Finds subtitle files (VTT, SRT, ASS, TTML) used by the page.
- Filters non-video URLs (e.g., data:, blob:).
- Supports **quality detection** (e.g., 1080p, 4K) from the stream itself.
- Finds videos inside embedded players too.

**Player Support**
- **Android**: VLC, MX Player, mpv, or any player through the share menu.
- **Desktop**: VLC, MPV, and other players via:
  - **Native Messaging** (browser-to-app communication).
  - **Protocol Handlers** (e.g., vlc://, mpv://).
  - **VLC HTTP Interface** (remote control).
- **In-Browser Playback**: Shaka Player (HLS/DASH/MP4) and Vidstack, made for both desktop and phones.

**Download**
- Save videos as **MP4** right in the browser, on desktop and Android. No extra setup needed.
- Choose the quality and audio language first.
- On desktop you can also download with yt-dlp or ffmpeg through the native host.

**Platform Support**
- **Android**: Firefox for Android.
- **Desktop**: Windows. Linux and macOS should work but are not tested yet.
- **Browsers**: Chrome and Firefox. Other Chromium browsers (Edge, Brave) should work but are not tested yet.

**UI/UX**
- **Toolbar Icon**: Quick access to extension settings.
- **Popup UI**:
  - Toggle extension on/off.
  - Configure **whitelists/blacklists** for domains, and add your own detection patterns.
  - Set **maximum stream count** (e.g., limit to 5 streams).
  - Customize **default actions** (e.g., "Share" on Android, "Copy" on Desktop).
- **Stream Menu**:
  - A floating ▶️ button on the page (drag it anywhere) and a stream count on the toolbar icon.
  - Displays detected streams with **quality badges** (e.g., "1080p"), **duration** and a subtitle count.
  - **Right-click menu** on links and videos, and the **Alt+Shift+P** shortcut to send the first stream.
- **Notifications**: Alerts for errors (e.g., failed player launches).

**Customization**
- **Player Preferences**: Choose VLC, MPV, or custom player paths.
- **Keyboard Shortcuts**: Fullscreen, play/pause, volume control (in-browser player).
- **Advanced Options**:
  - **Subtitles**: VTT, SRT, ASS and TTML in the built-in players, and sent to VLC/MPV.
  - **Quality Selection**: Auto-detected from stream metadata; pick one before playing or downloading.
  - **Resume**: The built-in player remembers where you stopped.

**Installation**
1. **Browser Extension**:
   - Firefox and Firefox for Android: [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/stream-to-android-player/).
   - Chrome, Edge and other Chromium browsers: [Chrome Web Store](https://chromewebstore.google.com/detail/oamkakadoiomoidknbdmeipejacdkhml).

2. **Native Host Setup** (Optional, desktop only. Only needed to open streams directly in VLC/MPV or download with yt-dlp. The built-in player and downloader work without it):
   - Download the **Native Host** zip from [GitHub Releases](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases/tag/native-host-v2.0.0).
   - Follow the setup instructions below for your OS.

**Usage**
1. Navigate to a webpage with a streaming video.
2. Click the extension icon in the toolbar.
3. Select the detected stream from the list.
4. Choose your preferred media player from the sharing menu (Android), let the native host open it directly (desktop), play it in the browser, or press ⬇️ to save it as MP4.

**Native Host Setup**
The native host is needed to open streams directly in VLC, MPV, or other players on desktop.

**Windows**
1. Download the **Native Host** zip from [GitHub Releases](https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension/releases/tag/native-host-v2.0.0).
2. Extract the zip file.
3. Run the install.bat file (no Administrator rights needed).
4. Restart your browser, then choose Native Messaging in the extension popup and press Test native host.

**Linux / macOS**
1. Download and extract the same zip.
2. In a terminal in the extracted folder, run: bash install.sh (for Chrome/Edge add your extension ID: bash install.sh <extension-id>).
3. Restart your browser and test it from the popup as above.

Note: Linux/macOS is not tested manually, so if you face issues, send an email or leave a review and I will look into it.

On Windows, Chrome/Edge also need the extension ID: run install.bat <extension-id> (the ID is shown on the extensions page).

**Supported Players**
- **VLC**: Works out of the box.
- **MPV**: Works out of the box.
- **Other Players**: May work if they support the same command-line arguments as VLC/MPV.

**Troubleshooting**
**Extension Issues**
- **Floating button not appearing**:
  - Play the video first; many sites only load the stream when playback starts.
  - Check that the extension and the site are switched on in the popup.
  - Refresh the webpage or restart the browser.

- **Streams not detected**:
  - The website may use a **non-standard format** (e.g., DRM-protected streams).
  - Add your own detection pattern in the popup (e.g. "m3u8 /videoplayback/" lists every address containing "videoplayback" as an HLS stream).
  - Try **whitelisting** the domain in settings.

- **Popup UI not responding**:
  - Disable and re-enable the extension.
  - Clear browser cache and reload.

**Player Issues**
- **Android (Web Share API)**:
  - Ensure **VLC/MX Player** is installed.
  - Grant **storage permissions** to the player app.
  - Restart the browser if sharing fails.

- **Desktop (Native Host)**:
  - Ensure the **native host is installed** (check chrome://extensions or about:addons).
  - Verify **browser permissions** for native messaging.
  - Restart the browser and system if needed.

- **VLC/MPV not launching**:
  - Check if the **player path is correct** in extension settings.
  - Ensure **protocol handlers** (e.g., vlc://) are registered.
  - For **VLC HTTP Interface**, verify the password in settings.

- **In-Browser Playback**:
  - Try the other player (Shaka Player/Vidstack) in settings.
  - Open the video from the stream list on its page, not from a copied link, so the site's details are sent along.

- **Downloads**:
  - Keep the download tab open until it says the file is saved.
  - Make sure there is enough free storage (about twice the video's size).
  - Protected (DRM) videos and live streams cannot be downloaded.
