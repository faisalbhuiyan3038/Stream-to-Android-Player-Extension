import 'vidstack/styles/defaults.css';
import 'vidstack/styles/community-skin/video.css';
import 'vidstack/define/media-player.js';
import 'vidstack/define/media-community-skin.js';
import { isHLSProvider } from 'vidstack';
import Hls from 'hls.js';
import { loadSubtitleAsVtt } from './subtitles.mjs';
import { getVideoUrl, getSubtitleList, getTitle } from './page-params.mjs';
import { attachPlaybackMemory, lockOrientationOnFullscreen, makeToast } from './player-memory.mjs';
import { SegmentPrefetcher, bufferingSettings } from './prefetch.mjs';
import { createPrefetchLoader } from './hls-prefetch.mjs';

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
  const buffering = bufferingSettings(await readSettings(), { mobile: isMobile() });
  let hlsProvider = null;
  const prefetcher = buffering.enabled
    ? new SegmentPrefetcher({ maxParallel: buffering.parallel, maxBytes: buffering.prefetchBytes })
    : null;
  window._prefetch = prefetcher; // read by the browser tests

  // HLS: hand our locally bundled Hls class to the provider so no CDN
  // fetch is attempted (extension CSP blocks external scripts).
  player.addEventListener('provider-change', (event) => {
    const provider = event.detail;
    if (isHLSProvider(provider)) {
      hlsProvider = provider;
      provider.library = Hls;
      if (prefetcher) {
        // "Faster buffering": parallel fragment downloads + a deeper buffer
        provider.config = {
          fLoader: createPrefetchLoader(Hls.DefaultConfig.loader, () => hlsProvider && hlsProvider.instance, prefetcher, { aheadSeconds: buffering.bufferAhead }),
          maxBufferLength: buffering.bufferAhead,
          maxMaxBufferLength: buffering.bufferAhead * 2,
          maxBufferSize: buffering.maxBufferBytes,
          backBufferLength: 30
        };
      }
    }
  });

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
        toast,
        setRate: r => { player.playbackRate = r; },
        seek: t => { player.currentTime = t; }
      });
      lockOrientationOnFullscreen(video);
    }
    addSubtitles().finally(() => {
      player.play().catch((e) => {
        console.log('Autoplay blocked:', e.message);
      });
    });
  }, { once: true });
}
