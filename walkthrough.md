# Stream to Android Player v1.2 — Walkthrough

## Changes Made

### Performance Fixes ([background.js](file:///m:/.temp/Stream-to-Android-Player-Extension/background.js))

| Problem | Fix |
|---|---|
| `onBeforeRequest` re-fetched **every XHR** URL to check for `#EXTM3U` | **Removed entirely** — `onHeadersReceived` catches streams via content-type |
| `setInterval` in `onActivated` leaked intervals on tab switches | **Replaced with MutationObserver** in content.js — no more polling |
| Unbounded stream accumulation | **Configurable cap** (default 50, adjustable 10–100) |
| `sendMessage` called on every detection | **Debounced** — batches updates with 500ms delay |
| All URLs processed (ads, tracking, images) | **Skip-list filtering** — 30+ non-video extensions and tracking patterns skipped |

### Video Naming ([background.js](file:///m:/.temp/Stream-to-Android-Player-Extension/background.js#L108-L147))

- [cleanStreamName()](file:///m:/.temp/Stream-to-Android-Player-Extension/background.js#110-132) decodes URIs, strips extensions/params, replaces `-_.` with spaces, Title Cases
- Stream type appended: [(m3u8)](file:///m:/.temp/Stream-to-Android-Player-Extension/content.js#126-135), [(mp4)](file:///m:/.temp/Stream-to-Android-Player-Extension/content.js#126-135), [(ts)](file:///m:/.temp/Stream-to-Android-Player-Extension/content.js#126-135), etc.
- Page title shown as truncated (~60 char) subtitle
- Duplicate names auto-numbered `#2`, `#3`…
- Togglable via "Clean stream names" setting — when off, shows raw URL filenames

### Content Script ([content.js](file:///m:/.temp/Stream-to-Android-Player-Extension/content.js))

- **MutationObserver** watches for `<video>`/`<source>` elements added to DOM
- 1-second debounce prevents rapid-fire scanning
- Improved stream menu: two-line layout (name + subtitle), quality badge, HTML-escaped output

### Popup UI (new files)

- [popup.html](file:///m:/.temp/Stream-to-Android-Player-Extension/popup.html) / [popup.css](file:///m:/.temp/Stream-to-Android-Player-Extension/popup.css) / [popup.js](file:///m:/.temp/Stream-to-Android-Player-Extension/popup.js)
- **Settings**: Global toggle, per-site toggle, clean names toggle, max streams slider, whitelist/blacklist
- All persisted via `browser.storage.local`
- Dark theme with green accents matching the overlay aesthetic

### Manifest ([manifest.json](file:///m:/.temp/Stream-to-Android-Player-Extension/manifest.json))

- Version bumped to **1.2**
- Added `default_popup`, `storage` permission
- Removed unused `webRequestBlocking`

## Files Changed

| File | Action |
|---|---|
| [background.js](file:///m:/.temp/Stream-to-Android-Player-Extension/background.js) | Rewritten (277→400 lines) |
| [content.js](file:///m:/.temp/Stream-to-Android-Player-Extension/content.js) | Rewritten (136→215 lines) |
| [styles.css](file:///m:/.temp/Stream-to-Android-Player-Extension/styles.css) | Updated (backdrop blur, scrollbar, shadows) |
| [manifest.json](file:///m:/.temp/Stream-to-Android-Player-Extension/manifest.json) | Updated (popup, permissions) |
| [popup.html](file:///m:/.temp/Stream-to-Android-Player-Extension/popup.html) | **New** |
| [popup.css](file:///m:/.temp/Stream-to-Android-Player-Extension/popup.css) | **New** |
| [popup.js](file:///m:/.temp/Stream-to-Android-Player-Extension/popup.js) | **New** |

## Verification

Manual testing required — load via `about:debugging` → Load Temporary Add-on → select [manifest.json](file:///m:/.temp/Stream-to-Android-Player-Extension/manifest.json). Test on video-heavy sites and verify:
1. CPU/memory stays reasonable (check `about:performance`)
2. Streams detected and named properly
3. Popup toggles and settings work
4. Share/download buttons function
