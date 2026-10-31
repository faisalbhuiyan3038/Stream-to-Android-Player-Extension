# PROJECT.md — Stream to Android Player Extension

> Last updated: 2026-10-31 · Branch: `chrome-mv3-latest` · Version: 1.5 (all three manifests) · Main branch: `firefox`
> **VERIFIED** = confirmed by running code/tests in this repo. **INFERRED** = concluded from reading code only.
> Feature statuses: **WORKING** (verified by an automated test or a manual run, evidence given), **PARTIAL**, **BROKEN**, **DEAD**, **UNTESTED** (implemented, but nothing could exercise it here).
> History: v1.4 was audited and live-tested on 2026-10-30/31; the 2026-10-31 work then implemented the 8 proposals (reliability, tests/CI, header forwarding, Android player picker, playlist/quality parsing, subtitles, popup/badge/menu/shortcut, native host v2). This file describes the state after that work.

## 1. Project Overview

A cross-browser (Chrome/Edge MV3, Firefox MV3, Firefox for Android) WebExtension by Faisal Bhuiyan (MIT per README; there is no `LICENSE` file). It detects streaming video URLs (HLS `.m3u8`, DASH `.mpd`, MP4, bare `.ts`, …) on web pages through `webRequest` headers, DOM scanning and resource-timing, lists them in a floating ▶️ button/menu, the toolbar popup and a toolbar badge, and lets the user: share/open them in an Android player (explicit VLC / MX Player / mpv-android intents or the system chooser), copy the URL, play them in a bundled in-browser player (Vidstack or Shaka), open them in a desktop player (VLC/mpv via protocol handler, VLC HTTP interface or a Python native-messaging host) or download them with yt-dlp/ffmpeg through that host. The page's Referer/Origin/User-Agent (and optionally cookies), detected subtitles (`.vtt`/`.srt`, `<track>`) and the chosen HLS quality variant are forwarded where the target supports them. Stack: vanilla JS (no framework), esbuild bundling of Vidstack/hls.js/Shaka, Python 3 for the native host, Node `node:test` + Playwright (Chromium) + Selenium (Firefox) for tests. Maturity: small hobby project with a real test suite now; Firefox release is on AMO (v1.4 published, v1.5 not yet released).

## 2. Architecture

### 2.1 Directory map

| Path | Purpose |
|---|---|
| `background.js` | MV3 service worker (Chrome) / event page (Firefox). Detection (`webRequest`), per-tab stream/subtitle store, header capture, playlist analysis, settings, actions (web player, external player, download), badge, context menu, shortcut, notifications. |
| `content.js` | Content script on `<all_urls>`: scans the DOM (+ resource timing), renders the floating button/menu (quality picker, CC badge, actions), pulls the stream list on load, handles `streamDetected`/`streamsCleared`. The button is draggable (pointer events; long-press on touch), snaps to a side edge, position stored as `{side, yRatio}` in `storage.local` key `buttonLayout` (`{global, sites:{host}}`); the menu is placed next to it; visibility modes `always`/`fade`/`never`; hidden in fullscreen. |
| `shared.js` | Helpers used by `content.js` **and** the popup: `formatDuration`, Android intent builder (`buildAndroidIntent`, `shareToAndroid`). Exposes `globalThis.StreamShared`. |
| `styles.css` | Content-script CSS for the floating button/menu (row styles are injected by `content.js`). |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup: stream list for the current tab, Android settings, desktop settings (player path, argument template, download dir, cookies, native test), white/blacklists. `popup.html?tabId=N` inspects another tab (used by tests). |
| `player.html` + `player.bundle.{js,css}` | Vidstack player page (generated from `src/player.js`; DASH URLs redirect to the Shaka page). |
| `player-shaka.html` + `player-shaka.bundle.js` + `player-shaka-controls.js` | Shaka page (bundle from `src/player-shaka.js`; hand-written controls incl. captions button/`C` key). Accepts `?url=…&subs=[{url,label,lang}]`. |
| `src/player.js`, `src/player-shaka.js` | esbuild entry points for the two bundles. |
| `manifest.chrome.json`, `manifest.firefox.json` | Source-of-truth MV3 manifests (service worker vs `background.scripts`; Firefox adds gecko id `faisalbhuiyan@mozilla`). |
| `manifest.json` | Active manifest, a copy of one of the above made by `npm run target:*`. **At the time of writing it holds the Firefox manifest** (`background.scripts`), so loading the repo root unpacked in Chrome fails until `npm run target:chrome` is run; the tests are unaffected (they stage their own copy). Tracked in git. |
| `scripts/build-extension.js` | `--target=chrome|firefox` switches `manifest.json`; `--package` writes `releases/Stream-to-Player-v<ver>-{chrome,firefox}.zip` with `adm-zip` (cross-platform; VERIFIED, 19 entries each). |
| `native-host/protocol-handler/` | OS handler for `vlc://` / `mpv://` links (`handler.py`, `register-windows.bat`, `unregister-windows.bat`, `register-linux.sh`). Optional alternative to the native host; see `docs/PROTOCOL_HANDLER.md`. |
| `docs/PROTOCOL_HANDLER.md` | Guide: registering the protocol handler (Windows/Linux/macOS) and switching on VLC's HTTP interface. |
| `native-host/` | Native messaging host: `host.py` (protocol v2), `host.bat` (python/python3/py launcher), `install.bat`/`uninstall.bat` (Windows registry), `install.sh` (Linux/macOS), `chrome_manifest.json` (template), `firefox_manifest.json` (**installed artifact**: the Firefox registry entry points at this file, and it contains an absolute path of the author's machine). |
| `tests/` | `unit.test.js` (background/shared helpers in a `vm`), `host.test.js` (native host over stdio), `handler.test.js` (protocol-handler link parsing), `e2e/server.js` (local test site), `e2e/stage.js` (builds a per-browser copy of the extension, so tests do not depend on which manifest `manifest.json` holds), `e2e/chromium.test.js`, `e2e/firefox.test.js`. |
| `.github/workflows/ci.yml` | CI: build + unit/host tests on Ubuntu and Windows, packaging check, Chromium browser tests under `xvfb`. (UNTESTED on GitHub: written but never run there.) |
| `icons/` | Extension icons. |
| `releases/` | Committed release zips (v1.1–v1.4, native host v1.0.0). |
| `backlog/plan.git`, `backlog/done.git` | Misnamed Markdown notes from the first AI-assisted session; historical. |
| `readme.md` | User docs + changelog (updated for 1.5). |
| `package.json`, `package-lock.json` | Scripts and dependencies (esbuild bundling; test tooling in devDependencies). |

### 2.2 Key architectural decisions
- **One codebase, two manifests**: `const browser = chrome` shim at the top of `background.js`, `content.js`, `popup.js`.
- **No remote code**: players are bundled locally with esbuild.
- **State in `storage.local`**: `settings`, `detectedStreams` (serialised `Map` tabId → streams), `detectedSubtitles`; cleared on `runtime.onStartup`. The map survives MV3 worker eviction.
- **Per-tab serialisation** (`runExclusive` in `background.js`): every mutation of a tab's list (add, analyse, clear, remove) goes through one promise chain, so concurrent detections cannot overwrite each other.
- **Navigation handling**: a `webRequest.onBeforeRequest` (`main_frame`) clears the tab's streams and records `pendingNav`; DOM scans from the *old* document (message or `executeScript` result) are dropped (`isStaleDocument`). The background tells the content script when it cleared (`streamsCleared`), and `getStreams` filters by `stream.pageUrl`, because browsers deliver `webRequest` events to the background asynchronously (a new page's content script can ask before the clear arrives; observed in Firefox).
- **Safety nets for missed requests**: the content script re-reads `performance.getEntriesByType('resource')` and pulls `getStreams` on load (the extension's listeners are not live in the first ~second after browser start / install; observed in Chromium).
- **Header forwarding**: `onBeforeSendHeaders` (with `extraHeaders` on Chromium, plain on Firefox) captures Referer/Origin/User-Agent/Cookie per `requestId`; stored on each stream as `headers` (cookie only if the setting is on). The built-in player tab is opened as `about:blank`, a `declarativeNetRequest` **session rule** (`tabIds:[tab]`, id `tabId+1`) rewrites Referer/Origin for it, then the tab navigates to the player page.
- **`.ts` handling**: `.ts` stays a stream pattern (some sites serve bare `.ts`), but a `.ts` is hidden when it is a segment of a detected m3u8 (`isSegmentOf`: playlist's real segment directory, same file stem, or same non-root directory).
- **Native host is optional** but is the default external method (`desktopExternalMethod: 'native'`): `nativeMessaging` is an *optional* permission requested from the popup (needs a user gesture). Existing users keep the method they saved.
- **Protocol links** are built by `buildProtocolUrl` and percent-encoded by default (`protocolUrlFormat: 'encoded'`, `'raw'` keeps `vlc://https://…`); `handler.py` accepts encoded, raw and browser-mangled forms.

### 2.3 Data flow
1. **Network path**: `onBeforeSendHeaders` (remember headers) → `onHeadersReceived` → `shouldSkipUrl` → subtitle? (`isSubtitleUrl` → `addSubtitle`) else `isStreamUrl`/`isStreamContent` → `addStream`.
2. **DOM path**: content script (MutationObserver, 1 s debounce; `<video>`, `<source>`, `<track>`, `[data-source]`, resource timing) → `videoSourcesFound` → `ingestDomSources`; background also scans on tab `complete`/activation via `scripting.executeScript`.
3. `addStream`: honours `enabled`, `maxStreams`, white/blacklist (substring on hostname), skips our player tabs/extension pages, dedups, hides playlist segments, stores `{url,name,displayName,type,quality,duration,pageTitle,pageUrl,headers}`, updates the badge, debounces (500 ms) `streamDetected` to the tab, then asynchronously `analyzeStream`: m3u8 → duration (sum of `#EXTINF`), master playlist → variants + real quality + duration of first variant + `segmentDir`; mpd → highest `height` + duration.
4. **Actions** (content menu, popup, context menu, shortcut) → background `buildContext` (stream + headers + subtitles) → `runAction`: `browser` (Shaka forced for DASH or when subtitles exist) / `external` (protocol, `vlc_http` with `&option=http-referrer=…`, or native) / `download` / `copy`. Failures raise a notification.
5. **Native command** is built from a preset by executable name (mpv/vlc) or a user template (`{url} {referer} {ua} {title} {cookie} {sub}`); tokens with empty placeholders are dropped, `{sub}` repeats per subtitle.

Message types to the background: `videoSourcesFound`, `getStreams` (`tabId` from popup, `docUrl` from content), `getSettings`, `updateSettings`, `getStreamCount`, `openWebPlayer`, `openExternalPlayer`, `downloadStream`, `nativePing`. Background → content: `streamDetected`, `streamsCleared`.

### 2.4 Native host protocol v2 (`native-host/host.py`)
Length-prefixed JSON on stdio. `{"action":"ping"}` → `{status:"ok",version:2,os,python,ytdlp,ffmpeg}`; `{"action":"launch","command":[exe,…]}` (a bare `command` key also works) → `{status:"launched",method:"direct"|"scheduler"}`; `{"action":"download",url,title,dir,headers}` → picks yt-dlp, else ffmpeg, runs in a new console. Errors reply `{status:"error",error}` and the host keeps serving. Windows launch: `Popen` with `DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`; if the browser's job object forbids breakaway it falls back to a one-shot `schtasks` task running a generated `.bat` whose arguments are sanitised (`bat_quote`: `%`→`%%`, `"`→`'`, trailing `\` doubled).

## 3. Features

| Feature | Status | Entry Point | Evidence / Notes |
|---|---|---|---|
| Detection via `webRequest` + DOM + resource timing (Chromium) | **WORKING** | `background.js`, `content.js` | `tests/e2e/chromium.test.js` (18 local tests pass, 5 more with `E2E_NETWORK=1`). |
| Detection (Firefox) | **WORKING** | same | `tests/e2e/firefox.test.js` (8 tests pass 3/3 final runs incl. native). |
| kisskh.co episode | **WORKING (manual, Chromium)** | — | Final run: one m3u8 `Ep1 V190 Index` (44:39), stray `.ts` no longer listed, `.en.srt` subtitle found (`CC 1`), headers `referer https://kisskh.co/`, player opened on Shaka and played. Not run in Firefox. |
| Early-request / first-tab detection | **WORKING** | `content.js` resource timing | Test "detects an m3u8 fetched at page load" (first tab after start). Previously failed in Chromium (listeners not live yet). |
| Stale streams cleared on navigation | **WORKING** | `background.js` `pendingNav`, `streamsCleared` | Chromium + Firefox "navigating away…" tests. |
| `.ts` handling | **WORKING** | `isSegmentOf` | Standalone `.ts` kept; segments hidden (separate host, and segments-before-playlist) in both browsers; 4 unit tests. |
| Master-playlist variants / real quality / duration; MPD quality+duration | **WORKING** | `analyzeStream` | Both browsers; unit tests for parsers. |
| Quality picker (send chosen variant) | **WORKING (Chromium)** | `content.js` `.v-quality` | Test "selecting a quality variant changes the URL that is copied". |
| Subtitle detection + `CC n` badge | **WORKING** | `addSubtitle`, `ingestDomSources` | Both browsers; kisskh real `.srt`. |
| Subtitles in Shaka (VTT, SRT) + captions button / `C` | **WORKING** | `src/player-shaka.js`, `player-shaka-controls.js` | Network test; Shaka 5.1.5 needs MIME `text/srt` (not `application/x-subrip`) and has no `setTextTrackVisibility`. `.ass`/`.ssa` (`text/x-ssa`) **UNTESTED**. |
| Header capture + built-in player Referer/Origin rewrite | **WORKING (Chromium)** | `setPlayerHeaderRule` | Test: local server 403s without the page Referer; player request carried it. Firefox: not run (extension pages cannot be scripted via WebDriver). |
| Web player — Vidstack (HLS/MP4) | **WORKING** | `src/player.js` | Chromium network test; Firefox screenshot (earlier audit). |
| Web player — DASH | **WORKING via Shaka** | `openWebPlayer`, `src/player.js` | Vidstack has no DASH provider (earlier BROKEN); DASH now routes to Shaka from the button and redirects from `player.html?url=*.mpd` (tests). |
| Web player — Shaka (HLS/DASH/MP4) + controls | **WORKING** | `src/player-shaka.js` | Chromium network tests; Firefox screenshots (earlier audit). |
| Copy URL / row tap | **WORKING (Chromium)** | `content.js` | Tests. |
| Popup stream list + actions | **WORKING (Chromium)** | `popup.js` `renderStreamList` | Test (list, badges, variant select, copy). Firefox popup **UNTESTED**. |
| Toolbar badge | **WORKING (Chromium)** | `updateBadge` | Test reads `action.getBadgeText`. |
| Floating button: drag, snap, remember per site, menu placement | **WORKING** | `content.js` (`setupButtonDrag`, `applyButtonPosition`, `positionMenu`) | Chromium: mouse drag, stored `buttonLayout`, restore after reload, plain click still toggles, menu inside the viewport from all 4 corners. Firefox: drag + restore. Touch long-press drag **UNTESTED** (no touch device). |
| Floating button: popup corner/reset, visibility `always`/`fade`/`never`, hidden in fullscreen | **WORKING (Chromium)** | `popup.js` `initButtonPositionControls`, `content.js` `updateButtonVisibility` | Tests apply the corner live from the popup, reset, fade after 3 s and wake on hover, `never`, and fullscreen. |
| Native host: ping/launch/download command/validation | **WORKING** | `native-host/host.py` | `tests/host.test.js` (6 pass): argv with quotes/`&`/`%`/unicode preserved, errors don't crash host, `bat_quote`, yt-dlp/ffmpeg command building. Actual yt-dlp/ffmpeg download **UNTESTED** (tools not run). |
| Native messaging from Firefox (full chain) | **WORKING** | `background.js` `nativeSend` → `host.py` | `E2E_NATIVE=1` Firefox test: click 🖥️ → host started a program with `[referer, title, url]` (3/3 runs). Uses the author's existing HKCU registration. Which launch method (direct vs scheduler) Firefox took was not recorded. |
| Native messaging from Chromium | **UNTESTED** | same | Needs the HKCU Chromium/Chrome registration (blocked in the audit session); `install.bat <extension-id>` writes it. |
| External: VLC HTTP | **PARTIAL** | `handleOpenExternalPlayer` | Returned `{success:true}` in the v1.4 audit when VLC was started with `--extraintf=http --http-password=…`. The author could not make it work from the VLC preferences: setup steps (Web interface + Lua HTTP password + restart) are now documented in `docs/PROTOCOL_HANDLER.md`. The `&option=http-referrer/user-agent` parameters are **UNTESTED** against VLC. |
| External: protocol handler | **PARTIAL** | `buildProtocolUrl`, `native-host/protocol-handler/handler.py` | The extension now opens `vlc://https%3A%2F%2F…` (unit-tested). `handler.py` parsing is unit-tested (7 tests) and a manual run launched VLC with the decoded URL (VLC `--` command line verified). Registering it in the OS (`register-windows.bat` / `register-linux.sh`) and the browser prompt flow are **UNTESTED**; the author's earlier failure was simply that no handler was registered. |
| Android: player picker, intents, bigger touch targets | **UNTESTED** | `shared.js`, `content.js`, `popup.js` | Intent string format is unit-tested (`tests/unit.test.js`), but no Android device/emulator was available. Web intents can only carry string extras: title for all players, **one** subtitle (`S.subtitles_location`) for VLC only; headers/multiple subtitles cannot be passed on Android. |
| Context menu (link/video/audio), `Alt+Shift+P` shortcut | **UNTESTED** | `background.js` bottom | Not automatable with the current harness; contextMenus does not exist on Firefox Android (guarded). |
| Notifications for action failures | **UNTESTED** | `notify()` | Called on every failed action; not asserted. |
| Download button (⬇️) | **UNTESTED end-to-end** | `handleDownload`, `host.py` | Command construction unit-tested only. |
| `install.sh` (Linux/macOS) | **UNTESTED** | `native-host/install.sh` | Written; not run. |
| Build, package | **WORKING** | `npm run build`, `npm run package` | Both run; zips inspected. |
| CI workflow | **UNTESTED** | `.github/workflows/ci.yml` | Never executed on GitHub. |

## 4. Local Setup Guide

Prerequisites (VERIFIED on the audit machine): Node.js 24, npm 11, Python 3.9 (native host + host tests), Windows 11. Chromium tests use Playwright's Chromium (branded Chrome ≥137 ignores `--load-extension`); Firefox tests need Firefox + geckodriver (Selenium Manager downloads it).

1. Clone and install:
   ```
   git clone https://github.com/faisalbhuiyan3038/Stream-to-Android-Player-Extension.git
   cd Stream-to-Android-Player-Extension
   git checkout chrome-mv3-latest
   npm ci
   ```
2. (Only after editing `src/*.js`) rebuild bundles: `npm run build` (VERIFIED).
3. Pick the manifest: `npm run target:chrome` or `npm run target:firefox` (overwrites `manifest.json`).
4. Load unpacked: Chrome/Edge `chrome://extensions` → Developer mode → *Load unpacked* → repo root; Firefox `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`.
5. Native host (optional, desktop): Windows `native-host\install.bat [chromium-extension-id]` (Firefox is always registered; blank ID skips Chromium browsers), Linux/macOS `native-host/install.sh [id]`; restart the browser; popup → *External Player Integration* → *Native Messaging* → grant permission → *Test native host*.
6. Release zips: `npm run package`.

### Environment variables
None required. Test-only: `E2E_NETWORK=1` (also play real public HLS/DASH streams), `E2E_NATIVE=1` (Firefox: launch a program through the installed native host), `HEADLESS=1`, `FIREFOX_BIN`, `PYTHON`.

### Ports / names
| Item | Value |
|---|---|
| Local test site | `http://localhost:8099` (and `127.0.0.1:8099` as a second host), `tests/e2e/server.js` |
| VLC HTTP interface | `http://localhost:8080/requests/status.xml` (hard-coded) |
| Native host name | `stream_player_host` |
| Firefox extension id | `faisalbhuiyan@mozilla` |

### Troubleshooting
- Wrong manifest for the browser → rerun step 3.
- "nativeMessaging permission not granted" → popup → Native Messaging → *Grant Permission* (needs a click).
- "Native host is not installed for this browser" → run the installer for that browser and restart it; Chrome/Edge need the extension ID of the loaded extension (it changes with the unpacked folder path).
- Firefox native tests via WebDriver: the staged extension makes `nativeMessaging` a normal permission because WebDriver cannot click the permission prompt.
- `install.bat` used to create stray files `Firefox` and `Written` (unescaped `>` in `echo`); fixed in 1.5 — delete any existing ones.

## 5. Development Workflow

- **Dev loop**: edit root files → reload the extension. Player code: edit `src/*.js` → `npm run build`.
- **Tests**: `npm test` (unit + native host + protocol handler, 30 tests, no browser) · `npm run test:e2e` (Chromium, headed; 24 local tests, +5 with `E2E_NETWORK=1`; on Linux use `xvfb-run -a`) · `npm run test:e2e:firefox` (8 tests, 9th with `E2E_NATIVE=1`). Last results: unit/host/handler 30/30, Chromium 29/29 (network on), Firefox 9/9 (native on).
- **Add a setting**: default in `background.js` `settings`, `popup.js` `defaults`, `content.js` `defaultSettings` (if the content script reads it), control in `popup.html`, listener in `popup.js`.
- **Add a web-player engine**: `src/` entry + HTML + esbuild script + `EXTENSION_FILES` in `scripts/build-extension.js` + branch in `openWebPlayer`.
- **Add a packaged file**: list it in `EXTENSION_FILES` and in the file list of `tests/e2e/firefox.test.js` (`FILES`), and add it to the manifest if needed.
- **Version bump**: both `manifest.*.json` (and `manifest.json` via `npm run target:*`); `package.json` version is informational.

## 6. Known Issues & Technical Debt (prioritised)

1. **Android is unverified.** No device/emulator test of intents, `package=` targeting, `S.subtitles_location`, popup share path (iframe `intent://` from a popup may not work on Firefox Android; `navigator.share` fallback). Web intents cannot carry headers or several subtitles.
2. **Chromium native messaging, context menu, shortcut, notifications, download (yt-dlp/ffmpeg), `install.sh`, `.ass` subtitles and CI** are implemented but unexercised (see §3).
3. **Startup race**: right after browser start/install, the extension's `webRequest` listeners are not live for ~1 s; the DOM/resource-timing safety net recovers stream URLs but not their captured request headers (falls back to the page URL as Referer) or content-type-only detections.
4. **Heuristics**: `VIDEO_PATTERNS`/`SKIP_PATTERNS` are plain substrings (`manifest`, `/media/`, `analytics`, `pixel` …); domain lists use `String.includes` (`ads.com` also matches `roads.com.au`).
5. **Protocol handler**: the extension now sends `vlc://<percent-encoded URL>` and ships `native-host/protocol-handler/handler.py`, but registration in the OS and the browser's first-use prompt are untested; macOS has no registration helper (needs an app bundle). `vlc_http` host/port are hard-coded, and its setup in VLC is easy to miss (see `docs/PROTOCOL_HANDLER.md`).
6. **Native host details**: Windows breakaway-vs-scheduler path is selected at runtime (reply field `method`) and not recorded by the tests; scheduler fallback leaves a `StreamPlayerLaunch` task and `%TEMP%\stream_player_launch.bat` (arguments sanitised but lossy: `"`→`'`). `firefox_manifest.json` in the repo holds a machine-specific path and is the file the Firefox registry key points to — do not reset it to a placeholder. The Chromium host manifest still needs the extension ID typed in (no pinned key).
7. **Vidstack** (0.6, legacy): no DASH, no subtitle wiring; the background forces Shaka for DASH and whenever subtitles exist, which overrides the user's engine choice.
8. **Dependencies**: production dependencies audit clean (VERIFIED `npm audit --omit=dev`); dev dependencies report 2 issues (1 low, 1 high).
9. **Hygiene**: bundles (~2.5 MB) and release zips are committed; no `LICENSE` file though README links one; README feature list still overstates some things (e.g. Edge/macOS support, "Casting"); mojibake in a few old comments; `backlog/*.git` misnamed.
10. **Duplicated logic**: DOM source scan exists in `content.js` and in `background.js extractVideoSources`; settings defaults in three files.
11. **Cookies**: forwarded only when "Forward cookies" is on, but then stored unencrypted in `storage.local` with the stream record.

## 7. Maintenance Protocol (For LLMs/Agents)

> ⚠️ **MANDATORY MAINTENANCE PROTOCOL FOR AI AGENTS**
> This document is the single source of truth for this project. If you are an LLM or 
> AI agent working in this repository, you MUST update PROJECT.md whenever ANY of the 
> following occurs:
> - A feature is added, changed, fixed, or removed
> - A file/directory is created, moved, renamed, or deleted in a way that affects 
>   the Architecture section
> - The setup process, dependencies, environment variables, or run commands change
> - A user workflow or developer workflow changes
> - A known issue is resolved or a new one is discovered
> 
> Update the relevant section(s) immediately after completing the change — not in a 
> later session. Keep the Features table statuses accurate. Never leave this document 
> stale. If you are unsure whether a change affects this document, update it anyway.

## Appendix — How this was verified, and limits

- Browsers driven: Playwright Chromium (extension loaded from the repo root), Firefox 158 via Selenium with a staged copy built from `manifest.firefox.json` (the repo is never edited by the tests). Firefox extension pages cannot be scripted by WebDriver, so Firefox tests cover the content script and the background via the page UI; the Firefox native test uses a staged copy that also makes `nativeMessaging` a normal permission and presets the native method/template.
- Real site: kisskh.co (no Cloudflare challenge appeared in headed Chromium).
- Not available here: Android device, macOS/Linux, branded Chrome/Edge with the extension, a registered Chromium native host, yt-dlp/ffmpeg runs, GitHub Actions.
- Bugs found *by* the new tests and fixed: first-tab/early request missed after browser start (resource-timing + pull fallback), stale streams re-added by outgoing-document scans, player-tab requests listed as page streams, stale list delivered before the navigation-clear event reached the background (Firefox), Shaka 5 API differences (`setTextTrackVisibility`, `text/srt`), `install.bat` creating stray files.
