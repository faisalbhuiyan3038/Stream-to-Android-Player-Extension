import 'vidstack/styles/defaults.css';
import 'vidstack/styles/community-skin/video.css';
import 'vidstack/define/media-player.js';
import 'vidstack/define/media-community-skin.js';
import { isHLSProvider } from 'vidstack';
import Hls from 'hls.js';
import { loadSubtitleAsVtt } from './subtitles.mjs';
import { getVideoUrl, getSubtitleList, getTitle } from './page-params.mjs';
import { attachPlaybackMemory, lockOrientationOnFullscreen, makeToast, createMemory } from './player-memory.mjs';
import { SegmentPrefetcher, bufferingSettings } from './prefetch.mjs';
import { createPrefetchLoader } from './hls-prefetch.mjs';
import { openPlayerCache } from './stream-cache.mjs';
import { createCacheLoader, hlsPlan, pickLevelIndex, desiredHeight } from './cache-hls.mjs';
import { createCacheBadge, throttle } from './cache-ui.mjs';
import { startFileCache, onComplete, saveCached, attachSaver } from './player-cache.mjs';

// The extension's settings (player pages are extension pages, so storage is available)
async function readSettings() {
  try {
    const api = globalThis.browser || globalThis.chrome;
    const r = await api.storage.local.get('settings');
    return (r && r.settings) || {};
  } catch {
    return {};
  }
}

const isMobile = () => /Android|Mobile/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;

const videoUrl = getVideoUrl(window.location);
const errorEl = document.getElementById('error-message');
const player = document.querySelector('media-player');
const toast = makeToast(document.getElementById('toast'));
const title = getTitle(window.location);
if (title) {
  document.title = title;
  player.setAttribute('title', title);
}

// Subtitle files detected on the source page, passed by the background script as ?subs=[{url,label,lang}]
const subtitles = getSubtitleList(window.location);

// Per-subtitle outcome, read by the browser tests: { label, format, via: 'converted'|'failed' }
window._subtitleStatus = [];

// Every format is converted to WebVTT first (src/subtitles.mjs) and handed over as text,
// so the result does not depend on Vidstack's own parsers or on CORS for the subtitle host.
async function addSubtitles() {
  let first = true;
  for (const sub of subtitles) {
    const status = { label: sub.label || '', format: '', via: 'pending' };
    window._subtitleStatus.push(status);
    try {
      const { vtt, format } = await loadSubtitleAsVtt(sub);
      status.format = format;
      player.textTracks.add({
        content: vtt,
        type: 'vtt',
        kind: 'subtitles',
        label: sub.label || sub.lang || `Subtitles ${window._subtitleStatus.length}`,
        language: sub.lang || 'und',
        default: first
      });
      first = false;
      status.via = 'converted';
    } catch (e) {
      status.via = 'failed';
      console.warn('Could not load subtitle', sub.url, e);
    }
  }
}

// Detect stream type from URL
function getStreamType(url) {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'hls';
  if (lower.endsWith('.mpd')) return 'dash';
  return 'native'; // mp4, webm, ts, etc.
}

if (!videoUrl) {
  errorEl.textContent = 'No video URL provided.';
  player.style.display = 'none';
} else {
  const streamType = getStreamType(videoUrl);

  if (streamType === 'dash') {
    // Vidstack 0.6.x has no DASH provider (the old dash.js attach never fired
    // and left an empty player), so hand DASH streams to the Shaka page.
    window.location.replace('player-shaka.html' + window.location.search + window.location.hash);
  } else {
    start();
  }
}

async function start() {
  const mobile = isMobile();
  const buffering = bufferingSettings(await readSettings(), { mobile });
  const streamType = getStreamType(videoUrl);
  const memory = createMemory();
  let hlsProvider = null;
  let hls = null;
  let badge = null;
  let filePlan = null;

  // Whole-video download while watching (FastStream-style, src/stream-cache.mjs): every segment
  // of the playing quality goes to IndexedDB, and hls.js is served from there.
  let cache = null;
  if (buffering.wholeVideo) {
    const update = throttle(c => { if (badge) badge.update(c.progress()); }, 500);
    cache = await openPlayerCache({ maxBytes: buffering.cacheBytes, parallel: buffering.parallel, mobile, onChange: update })
      .catch((e) => { console.warn('Whole-video download unavailable:', e); return null; });
  }
  window._cache = cache; // read by the browser tests
  const prefetcher = !cache && buffering.enabled
    ? new SegmentPrefetcher({ maxParallel: buffering.parallel, maxBytes: buffering.prefetchBytes })
    : null;
  window._prefetch = prefetcher; // read by the browser tests

  // hls.js with the cache: play (and download) one quality, the one closest to the screen size or
  // to the quality picked last time; the quality menu changes it, and the download follows.
  function attachCache(instance) {
    hls = instance;
    window._hls = instance;
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      if (instance.levels.length < 2) return;
      const index = pickLevelIndex(instance.levels, desiredHeight(memory.preferredHeight()));
      if (index >= 0) {
        instance.startLevel = index;
        instance.currentLevel = index;
      }
    });
    const replan = () => cache.setPlan(hlsPlan(instance));
    for (const ev of [Hls.Events.LEVEL_LOADED, Hls.Events.LEVEL_SWITCHED, Hls.Events.AUDIO_TRACK_LOADED, Hls.Events.AUDIO_TRACK_SWITCHED]) {
      instance.on(ev, replan);
    }
  }

  // HLS: hand our locally bundled Hls class to the provider so no CDN
  // fetch is attempted (extension CSP blocks external scripts).
  player.addEventListener('provider-change', (event) => {
    const provider = event.detail;
    if (isHLSProvider(provider)) {
      hlsProvider = provider;
      provider.library = Hls;
      const depth = {
        maxBufferLength: buffering.bufferAhead,
        maxMaxBufferLength: buffering.bufferAhead * 2,
        maxBufferSize: buffering.maxBufferBytes,
        backBufferLength: 30
      };
      if (cache) {
        provider.config = { fLoader: createCacheLoader(Hls.DefaultConfig.loader, () => cache), ...depth };
        provider.onInstance(attachCache);
      } else if (prefetcher) {
        // "Faster buffering": parallel fragment downloads + a deeper buffer
        provider.config = {
          fLoader: createPrefetchLoader(Hls.DefaultConfig.loader, () => hlsProvider && hlsProvider.instance, prefetcher, { aheadSeconds: buffering.bufferAhead }),
          ...depth
        };
      }
    }
  });

  async function saveNow(mode) {
    try {
      const level = hls && hls.levels[hls.currentLevel];
      const audio = hls && hls.audioTracks && hls.audioTracks[hls.audioTrack];
      const name = await saveCached(cache, {
        filePlan, url: videoUrl, title, mode,
        choice: { height: level && level.height, bandwidth: level && level.bitrate, audioLanguage: audio && audio.lang }
      });
      if (name) toast(`Saved ${name}`);
    } catch (e) {
      toast(`Could not save: ${e.message || e}`);
    }
  }

  player.src = videoUrl;

  // Tracks are added once the source can play, so a source change during start-up
  // cannot drop them; then autoplay.
  player.addEventListener('can-play', () => {
    // The skin brings double-tap seek and tap-to-pause; resume position, remembered speed and
    // landscape-on-fullscreen are ours (shared with the Shaka page).
    const video = player.querySelector('video');
    if (video) {
      // the rate goes through Vidstack's own state, which would otherwise put it back to 1
      attachPlaybackMemory(video, videoUrl, {
        memory,
        toast,
        setRate: r => { player.playbackRate = r; },
        seek: t => { player.currentTime = t; }
      });
      lockOrientationOnFullscreen(video);
    }
    if (cache && video) startCacheUi(video);
    addSubtitles().finally(() => {
      player.play().catch((e) => {
        console.log('Autoplay blocked:', e.message);
      });
    });
  }, { once: true });

  function startCacheUi(video) {
    let saver = null;
    badge = createCacheBadge(player, video, { onSave: (mode, b) => saver(mode, b), canSavePart: () => !filePlan });
    saver = attachSaver(cache, badge, saveNow);
    badge.update(cache.progress());
    if (streamType === 'hls') {
      const onTime = () => cache.setPosition(video.currentTime);
      video.addEventListener('timeupdate', onTime);
      video.addEventListener('seeking', onTime);
      return;
    }
    // A plain file: cached as byte ranges; once all of it is in, playback switches to the local
    // copy, so nothing depends on the network any more.
    startFileCache(cache, video, videoUrl).then((plan) => {
      filePlan = plan;
      window._filePlan = plan;
      if (!plan) {
        badge.destroy();
        badge = null;
        return;
      }
      onComplete(cache, () => switchToLocalCopy(video, plan));
    });
  }

  async function switchToLocalCopy(video, plan) {
    const blob = await cache.assemble(plan.type);
    if (!blob) return;
    const at = video.currentTime;
    const paused = video.paused;
    const rate = video.playbackRate;
    video.src = URL.createObjectURL(blob);
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
    video.currentTime = at;
    video.playbackRate = rate;
    if (!paused) video.play().catch(() => {});
    window._playingLocalCopy = true;
  }
}
