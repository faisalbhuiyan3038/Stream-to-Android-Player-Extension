// Shaka page: Shaka Player with Shaka's own UI (touch-friendly: big controls, double-tap seek,
// quality / captions / language / speed menus, landscape on fullscreen, keyboard shortcuts).
import shaka from 'shaka-player/dist/shaka-player.ui.js';
import 'shaka-player/dist/controls.css';
import { loadSubtitleAsVtt } from './subtitles.mjs';
import { getVideoUrl, getSubtitleList, getTitle } from './page-params.mjs';
import { attachPlaybackMemory, createMemory, closestHeight, makeToast } from './player-memory.mjs';
import { bufferingSettings } from './prefetch.mjs';

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
const video = document.getElementById('video');
const container = document.getElementById('player-container');
const toast = makeToast(document.getElementById('toast'));
const memory = createMemory();

// Subtitle files detected on the source page, passed by the background script as ?subs=[{url,label,lang}]
const subtitles = getSubtitleList(window.location);
const title = getTitle(window.location);
if (title) document.title = title;

function subtitleMime(url) {
  const path = url.toLowerCase().split('?')[0];
  if (path.endsWith('.srt')) return 'text/srt';
  if (path.endsWith('.ass') || path.endsWith('.ssa')) return 'text/x-ssa';
  return 'text/vtt';
}

// Per-subtitle outcome, read by the browser tests: { label, format, via: 'converted'|'direct'|'failed' }
window._subtitleStatus = [];

async function addSubtitles(player) {
  for (const sub of subtitles) {
    const status = { label: sub.label || '', format: '', via: 'pending' };
    window._subtitleStatus.push(status);
    try {
      // Fetch and convert ourselves (SRT, ASS/SSA, TTML, YouTube XML → WebVTT): Shaka's own
      // parsers miss non-UTF-8 files and most ASS styling, and know nothing of YouTube XML.
      const { vtt, format } = await loadSubtitleAsVtt(sub);
      status.format = format;
      const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      await player.addTextTrackAsync(blobUrl, sub.lang || 'und', 'subtitles', 'text/vtt', undefined, sub.label || '');
      status.via = 'converted';
      continue;
    } catch (e) {
      console.warn('Subtitle conversion failed, letting Shaka try the original', sub.url, e);
    }
    try {
      await player.addTextTrackAsync(sub.url, sub.lang || 'und', 'subtitles', subtitleMime(sub.url), undefined, sub.label || '');
      status.via = 'direct';
    } catch (e) {
      status.via = 'failed';
      console.warn('Could not load subtitle', sub.url, e);
    }
  }
  // Shaka 5: selecting a track shows it, selectTextTrack(null) hides captions
  const tracks = player.getTextTracks();
  if (tracks.length > 0) player.selectTextTrack(tracks[0]);
  syncNativeTracks(player);
}

// Plain files (src= mode) use the browser's own text tracks, and every added <track> can end up
// "showing" at once. Keep only Shaka's active one visible, now and after menu changes.
function syncNativeTracks(player) {
  const sync = () => {
    const active = player.getTextTracks().find(t => t.active);
    for (const tt of video.textTracks) {
      if (tt.kind === 'metadata') continue;
      const shouldShow = !!active && tt.label === (active.label || '') && tt.language === (active.language || tt.language);
      // 'hidden' tracks are still drawn by Shaka's UI text displayer, so disable them fully
      if (!shouldShow && tt.mode !== 'disabled') tt.mode = 'disabled';
    }
  };
  sync();
  player.addEventListener('textchanged', sync);
  player.addEventListener('texttrackvisibility', sync);
}

// Remembered quality: when the user picks a quality in the menu (ABR off), the height is saved
// and applied to the next video (closest available height).
function applyPreferredQuality(player) {
  const preferred = memory.preferredHeight();
  const variants = player.getVariantTracks().filter(v => v.height);
  const height = closestHeight([...new Set(variants.map(v => v.height))], preferred);
  if (!height) return;
  const pick = variants.filter(v => v.height === height).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  player.configure({ abr: { enabled: false } });
  player.selectVariantTrack(pick, true);
}
function watchQualityChoice(player) {
  player.addEventListener('variantchanged', () => {
    if (player.getConfiguration().abr.enabled) return; // automatic switches are not a preference
    const active = player.getVariantTracks().find(v => v.active);
    if (active && active.height) memory.setPreferredHeight(active.height);
  });
  player.addEventListener('abrstatuschanged', (e) => {
    if (e.newStatus) memory.setPreferredHeight(0); // back to "Auto"
  });
}

function cycleCaptions(player) {
  const tracks = player.getTextTracks();
  if (tracks.length === 0) return;
  const active = tracks.findIndex(t => t.active);
  if (active === -1) player.selectTextTrack(tracks[0]);
  else if (active < tracks.length - 1) player.selectTextTrack(tracks[active + 1]);
  else player.selectTextTrack(null);
  const now = player.getTextTracks().find(t => t.active);
  toast(now ? `Captions: ${now.label || now.language || 'on'}` : 'Captions off');
}

async function init() {
  if (!videoUrl) {
    errorEl.textContent = 'No video URL provided.';
    return;
  }

  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    errorEl.textContent = 'Browser not supported for Shaka Player.';
    return;
  }

  const player = new shaka.Player();
  await player.attach(video);
  const ui = new shaka.ui.Overlay(player, container, video);
  ui.configure({
    seekOnTaps: true,              // double-tap left/right = -/+ 10 s
    tapSeekDistance: 10,
    doubleClickForFullscreen: true,
    enableFullscreenOnRotation: true,
    forceLandscapeOnFullscreen: true,
    enableKeyboardPlaybackControls: true,
    overflowMenuButtons: ['captions', 'quality', 'language', 'playback_rate', 'picture_in_picture', 'loop', 'statistics']
  });

  // Exposed for the browser tests (and handy in the console)
  window._shakaPlayer = player;
  window._shakaUi = ui;

  player.addEventListener('error', (event) => {
    const detail = event.detail;
    console.error('Shaka error:', detail);
    errorEl.textContent = `Playback error (${detail.code}): ${detail.message}`;
  });

  // "Faster buffering": Shaka has parallel segment prefetch built in (segmentPrefetchLimit
  // segments per stream ahead of the playhead) and a configurable buffer depth.
  const buffering = bufferingSettings(await readSettings(), { mobile: isMobile() });
  window._buffering = buffering; // read by the browser tests
  player.configure({
    streaming: {
      retryParameters: { maxAttempts: 4, baseDelay: 100, backoffFactor: 2, fuzzFactor: 0.5, timeout: 0 },
      ...(buffering.enabled ? {
        segmentPrefetchLimit: buffering.parallel,
        bufferingGoal: buffering.bufferAhead,
        bufferBehind: 30
      } : {})
    }
  });

  // 'c' cycles subtitle tracks (Shaka's own keys: space, arrows, m, f)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) cycleCaptions(player);
  });

  // Shaka's rate controller reverts direct playbackRate writes; trickPlay is what its own speed menu uses
  const playback = attachPlaybackMemory(video, videoUrl, {
    memory, toast,
    setRate: r => { try { if (r === 1) player.cancelTrickPlay(); else player.trickPlay(r, false); } catch { video.playbackRate = r; } }
  });

  try {
    await player.load(videoUrl);
    playback.applyRate(); // Shaka sets the rate to 1 during load
    applyPreferredQuality(player);
    watchQualityChoice(player);
    await addSubtitles(player);
    video.play().catch(e => console.log('Autoplay blocked:', e.message));
  } catch (e) {
    console.error('Failed to load stream:', e);
    errorEl.textContent = `Failed to load: ${e.message || JSON.stringify(e)}`;
  }
}

init();
