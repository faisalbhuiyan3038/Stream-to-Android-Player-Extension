# TASKS.md — FastStream-inspired improvements

Source of ideas: the FastStream codebase (`E:\Programming\FastStream-main`, read-only reference). Per the project owner's decision, code may be copied or adapted from it where useful (it has no root LICENSE file); it is live-tested and stable, so prefer adapting it over rewriting, and improve it where needed.
Targets: every output path — Android player hand-off, desktop player hand-off, built-in web players (Vidstack, Shaka), downloads.
Rules for every phase: unit/e2e tests where the harness allows, `npm test` green, PROJECT.md updated (features table, known issues), nothing marked WORKING without evidence.
Android caveat: no device/emulator here. Android web-player work is verified with Chromium mobile emulation (touch, DPR, portrait + landscape); real-device behaviour stays UNTESTED in PROJECT.md until someone runs it.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

> **NOTE (2026-11-06): real Android device pending.** The owner will connect an Android phone (USB debugging + Firefox) later. Then: run `tests/e2e/firefox.test.js` on it via geckodriver's Android support (`moz:firefoxOptions.androidPackage`, adb at `E:\platform-tools\adb.exe`) and re-check the phase 5 player layout on the device. Until then Android results come from Chromium mobile emulation only and stay UNTESTED in PROJECT.md.

## Phase 1 — Detection & metadata (small, unit-testable) — DONE 2026-11-06 (unit 41/41, Chromium 30/30, Firefox 8/8)
- [x] 1.1 Clean page titles → nicer names: strip site name, split season/episode, drop filler words. Unicode-aware (FastStream's version strips all non-ASCII, which destroys CJK/Cyrillic titles) and separator-aware (`-`, `|`, `–`). Used for list label, Android intent title, download filename, native `{title}`.
- [x] 1.2 More detection signals: ignore 4xx/5xx/204 responses; `media` resource type → MP4; stream URL embedded in a query parameter (`?src=https://…/x.m3u8`). Note: such URLs were already matched by substring; the real gap was `.php`/`.html` proxy URLs being dropped by the extension filter, plus 404s and resource-timing errors being listed — all fixed.
- [x] 1.3 Safer domain matching for allow/block lists: hostname-suffix match instead of `String.includes` (fixes `ads.com` vs `roads.com.au`); optional rule prefixes `!` (negate) `~` (regex) `-` (exact host), as in FastStream's auto-enable list.
- [x] 1.4 User-defined detection patterns: setting with `type /regex/flags` lines (types: m3u8, mpd, mp4, subtitle…), compiled once into a combined matcher; popup textarea + validation feedback.

## Phase 2 — Subtitles — DONE 2026-11-06 (unit 54/54, Chromium 32/32, Firefox 13/13; Firefox player pages not scriptable, so conversion there is untested)
- [x] 2.1 `toVtt()` converters: SRT, ASS/SSA (styles stripped, basic tags mapped), YouTube/timedtext XML, TTML-lite → WebVTT. Pure functions in a shared module with unit tests.
- [x] 2.2 Wire into Vidstack page (currently no subtitle support) and Shaka (replaces the UNTESTED `.ass` path with conversion).
- [x] 2.3 Subtitle label/language heuristics from file names (`.en.srt`, `_eng`, `English`).

## Phase 3 — Open direct stream links in the web player — DONE 2026-11-06 (unit 58/58, Chromium 33/33, Firefox 14/14)
- [x] 3.1 Settings `openStreamLinks` + `openMp4Links` (default off): `declarativeNetRequest` dynamic redirect of `main_frame` `.m3u8`/`.mpd` (and optional `.mp4`) to the right web player, excluding our own pages. Chrome + Firefox (web_accessible_resources / permissions check).
- [x] 3.2 Popup toggle + tests (navigate to a local `.m3u8`, land on player page; URL travels in the `#fragment` because a regexSubstitution cannot percent-encode).

## Phase 4 — Header & frame hardening — DONE 2026-11-06 (unit 58/58, Chromium 36/36, Firefox 16/16)
- [x] 4.1 Header rule for the web player. CHANGED from the plan: kept tab-scoped instead of per-URL 5 s rules (FastStream's downloader announces every request; hls.js/Shaka fetch segments on unknown hosts themselves). Fixed instead: the rule leaked to any site the player tab navigated to (now removed on every http(s) navigation, eviction-safe), and Cookie is now forwarded when "Forward cookies" is on. `Sec-Fetch-*`/`Sec-CH-UA*` not imitated (risk of breaking more CDNs than it fixes).
- [x] 4.2 Frames: DOM scan in all frames with the iframe URL as Referer; service-worker requests (tabId -1) attributed to the tab by initiator origin. A full frame tree (FastStream's FrameHolder) was not needed for our per-tab list.
- [x] 4.3 Header cache: already bounded (400) and deleted on response; now also deleted on request errors.

## Phase 5 — Web players usable on Android (portrait + landscape) — DONE 2026-11-06 in Chromium phone emulation (unit 63/63, Chromium 36/36, mobile 9/9, Firefox 16/16); real device pending
Outcome: Shaka page rebuilt on Shaka UI (touch controls, double-tap seek, quality/captions/language/speed/PiP menus, landscape on fullscreen); Vidstack page layout + 48px buttons (its skin already had double-tap seek); shared player-common.css (dvh, safe areas); resume/speed/quality memory (src/player-memory.mjs); popup + in-page menu touch sizes; Android popup gets the engine choice; tests/e2e/mobile.test.js + `npm run audit:mobile`.
- [x] 5.1 Audit `player.html`/`player-shaka.html`/controls under Chromium mobile emulation (Pixel-class, portrait and landscape): screenshots, overflow, tap-target size (≥44px), safe-area insets, dynamic viewport units.
- [x] 5.2 Responsive layout + touch controls: larger seek bar thumb, auto-hiding controls with tap-to-toggle, double-tap left/right = ±10 s, long-press 2× speed (optional), no hover-only UI.
- [x] 5.3 Fullscreen + orientation: fullscreen button, `screen.orientation.lock('landscape')` best-effort, rotate handling, `playsinline`, PiP where available.
- [x] 5.4 Quality / audio / subtitle menus as bottom sheets on narrow screens.
- [x] 5.5 Floating button + in-page menu + popup on small screens (already partly done: long-press drag); verify in emulation both orientations.
- [x] 5.6 Playback QoL shared by both players: remember position per URL, remember preferred quality, playback-speed menu, keyboard shortcuts for desktop.
- [x] 5.7 Emulated-mobile e2e tests (Playwright `devices`, `hasTouch`, rotate viewport).

## Phase 6 — Parallel segment prefetch in the web players — DONE 2026-11-06 (unit 70/70, Chromium 38/38, mobile 9/9, Firefox 16/16)
- [x] 6.1 Design: Shaka → its built-in `segmentPrefetchLimit` + `bufferingGoal` (no plugin needed); hls.js → custom `fLoader` (src/hls-prefetch.mjs) over src/prefetch.mjs.
- [x] 6.2 Downloader pool: adaptive concurrency (FastStream-style speed test, 2 → max), retry with exponential backoff, 403/429 stop, byte budget, urgent take() gets an extra slot.
- [x] 6.3 Settings: fastBuffering (on), fastBufferingParallel (4), bufferAheadSeconds (auto: 120 s desktop / 60 s phone); phone memory budgets 24 MB prefetch / 80 MB buffer (desktop 64 / 200).
- [x] 6.4 Throttled real fMP4 HLS fixture (400 ms/segment): time to buffer 20 s — Vidstack 5.4 s → 1.7 s, Shaka 12.9 s → 2.2 s; video playable in both modes.

## Phase 7 — Download to MP4 inside the browser (no native host) — DONE 2026-11-06 (unit 81/81, Chromium 43/43 + network TS test, mobile 10/10, Firefox 16/16)
CHANGED from 7.1: Shaka (already bundled) parses HLS/DASH, gives AES-128 key info and transmuxes TS; output is fragmented MP4 + sidx (src/mp4-merge.mjs) instead of FastStream's progressive-moov writer — same players open it, far less code, flat memory. Memory: see 7.5 — segments now wait in IndexedDB on disk, not RAM.
- [x] 7.1 DECIDED: adapt FastStream `hls2mp4/` (HLS2MP4, MP4Generator, transmuxer) + `dash2mp4/mp4merger` (progressive MP4 with moov, separate audio merge, discontinuity handling) rather than mux.js (fragmented-MP4 only, no audio merge). First check whether esbuild can import `TSDemuxer`/`MP4Remuxer` from the `hls.js` package source instead of copying FastStream's 1.2 MB custom `hls.mjs`; if not, extract just those files. Use mp4box (already a FastStream dependency) for the fMP4 merge path.
- [x] 7.2 Stream-to-disk (File System Access API / `downloads` API fallback / Blob), progress + cancel, quality selection.
- [x] 7.3 UI entry points (content menu, popup, player page), notifications, Android-aware limits.
- [x] 7.4 Tests with a local HLS fixture; check output with ffprobe if available.

- [x] 7.5 (added 2026-11-06, owner request) Segments wait in IndexedDB instead of RAM (src/segment-store.mjs, FastStream FSBlob idea); the MP4 is assembled from Blob slices (planMp4 works on moof headers only). Measured: 60.8 MB file, 4.1 MB peak held in RAM; tab database removed on close.

## Phase 8 — Wrap-up
- [x] 8.1 PROJECT.md and readme sync, version bump (1.6), packaging check, CI workflow updated (browser tests on Windows), final regression of all suites, settings migration for existing ⬇️ users (native yt-dlp kept).

## Dropped (explicitly out of scope)
Manual source editor (user decision); YouTube client, audio EQ, colour filters, VAD, SponsorBlock, VPN mirror, site-specific Panopto/Bilibili/Facebook/Instagram integrations.
