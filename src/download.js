// Download page: pick quality/audio, download the stream in this tab, save one MP4.
// Opened by the background like the web player (so the page's Referer/Cookie rule applies).
import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { getVideoUrl, getTitle } from './page-params.mjs';
import { describeManifest, downloadManifest, downloadFile, safeFileName } from './downloader.mjs';
import { bufferingSettings } from './prefetch.mjs';
import { openStore, removeLeftoverStores } from './segment-store.mjs';

const $ = id => document.getElementById(id);
const url = getVideoUrl(window.location);
const title = getTitle(window.location);
const mobile = /Android|Mobile/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
const PHONE_WARN_BYTES = 500 * 1024 * 1024;

// Read by the browser tests
const state = window._download = { state: 'starting', error: null, size: 0, duration: 0, tracks: [], name: '' };

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}
function fail(e) {
  state.state = 'error';
  state.error = e && e.message ? e.message : String(e);
  setStatus(state.error, 'error');
  $('start').disabled = true;
  $('cancel').hidden = true;
}
const mb = n => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
const clock = s => { s = Math.round(s); const h = Math.floor(s / 3600); const m = Math.floor(s % 3600 / 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };

async function readSettings() {
  try {
    const api = globalThis.browser || globalThis.chrome;
    return ((await api.storage.local.get('settings')) || {}).settings || {};
  } catch {
    return {};
  }
}

// Segments wait in IndexedDB (on disk) rather than in RAM; one database per download tab,
// deleted when the tab goes away (the saved file is not affected: the browser has it by then).
let storePromise = null;
function getStore() {
  if (!storePromise) {
    storePromise = openStore().then((store) => {
      state.storage = store.kind;
      window.addEventListener('pagehide', () => { store.destroy(); });
      return store;
    });
  }
  return storePromise;
}
removeLeftoverStores().catch(() => {});

function save(result, name) {
  const blob = result.blob;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // keep the blob for "Save again"; it is released when the tab closes
  return href;
}

const isManifest = u => /\.(m3u8|m3u|mpd)(?:[?#]|$)/i.test(u.split('#')[0]) || /\/manifest(\(|\b)/i.test(u);

let storageKind = 'indexeddb';

async function main() {
  // Open the segment storage up front, so the size warning knows where segments will wait
  storageKind = (await getStore()).kind;
  if (!url) return fail(new Error('No video URL given.'));
  $('source').textContent = url;
  const settings = await readSettings();
  const parallel = bufferingSettings(settings, { mobile }).parallel;
  let controller = null;

  if (!isManifest(url)) {
    // A plain file: no choices, just download it
    const ext = (url.split(/[?#]/)[0].match(/\.(mp4|m4v|webm|mkv|mov|ts|mp3|m4a)$/i) || [, 'mp4'])[1].toLowerCase();
    $('name').value = safeFileName(title || decodeURIComponent(url.split(/[?#]/)[0].split('/').pop().replace(/\.[^.]+$/, '')), ext);
    setStatus('Ready.');
    state.state = 'ready';
    $('start').disabled = false;
    $('start').onclick = async () => {
      controller = new AbortController();
      $('start').disabled = true;
      $('cancel').hidden = false;
      $('progress').hidden = false;
      state.state = 'downloading';
      try {
        const result = await downloadFile(url, {
          store: await getStore(),
          signal: controller.signal,
          onProgress: p => {
            $('progress').max = p.total || 1;
            $('progress').value = p.total ? p.done : 0;
            setStatus(`${mb(p.bytes)} downloaded`);
          }
        });
        finish(result, $('name').value, result.type);
      } catch (e) {
        fail(e);
      }
    };
    $('cancel').onclick = () => controller && controller.abort();
    return;
  }

  // A manifest: let Shaka parse it (it also starts buffering a second of video, which is harmless)
  shaka.polyfill.installAll();
  const player = new shaka.Player();
  const video = document.createElement('video');
  video.muted = true;
  await player.attach(video);
  player.configure({ streaming: { bufferingGoal: 1, rebufferingGoal: 0 } });
  try {
    await player.load(url);
  } catch (e) {
    return fail(new Error(`Could not read the stream (${e.code || e.message || e}).`));
  }
  const manifest = player.getManifest();
  const info = describeManifest(manifest);
  // diagnostics (tests, console): what Shaka made of the playlist
  state.manifestDuration = info.duration;
  state.streams = (manifest.variants || []).slice(0, 4).map(v => ({
    video: v.video ? { id: v.video.id, mime: v.video.mimeType, codecs: v.video.codecs } : null,
    audio: v.audio ? { id: v.audio.id, mime: v.audio.mimeType, codecs: v.audio.codecs } : null
  }));
  if (info.live) return fail(new Error('This is a live stream; live streams cannot be downloaded.'));
  if (info.drm) return fail(new Error('This stream is DRM-protected and cannot be downloaded.'));

  $('name').value = safeFileName(title || 'video', 'mp4');
  const quality = $('quality');
  for (const v of info.videos) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = `${v.height ? v.height + 'p' : 'Video'}${v.bandwidth ? ` · ${(v.bandwidth / 1e6).toFixed(1)} Mbit/s` : ''}`;
    quality.appendChild(o);
  }
  const audioSel = $('audio');
  for (const a of info.audios) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = [a.label, a.language !== 'und' ? a.language : '', a.channels ? `${a.channels} ch` : ''].filter(Boolean).join(' · ') || 'Audio';
    audioSel.appendChild(o);
  }
  // Prefer the browser's language for audio
  const lang = (navigator.language || '').split('-')[0];
  const preferred = info.audios.find(a => a.language && a.language.split('-')[0] === lang);
  if (preferred) audioSel.value = String(preferred.id);
  $('quality-field').hidden = info.videos.length === 0;
  $('audio-field').hidden = info.audios.length === 0;
  $('choices').hidden = false;

  const estimate = () => {
    const v = info.videos.find(x => String(x.id) === quality.value);
    const a = info.audios.find(x => String(x.id) === audioSel.value);
    const bits = ((v && v.bandwidth) || 0) + ((a && a.bandwidth) || 0);
    const bytes = bits * info.duration / 8;
    $('estimate').textContent = `${clock(info.duration)}${bytes ? ` · about ${mb(bytes)}` : ''}`;
    // Segments wait on disk (IndexedDB); only if the browser refused that do they wait in RAM
    let warning = '';
    if (storageKind === 'memory' && mobile && bytes > PHONE_WARN_BYTES) {
      warning = 'This browser does not allow storing the download on disk here (private mode?), so the whole video stays in memory until it is saved. On a phone, a lower quality is safer.';
    } else if (bytes > 1024 * 1024 * 1024) {
      warning = `Needs about ${mb(bytes * 2)} of free storage while it downloads (the segments, then the saved file).`;
    }
    $('warning').hidden = !warning;
    $('warning').textContent = warning;
  };
  quality.onchange = estimate;
  audioSel.onchange = estimate;
  estimate();

  setStatus('Ready.');
  state.state = 'ready';
  $('start').disabled = false;
  $('start').onclick = async () => {
    controller = new AbortController();
    $('start').disabled = true;
    quality.disabled = true;
    audioSel.disabled = true;
    $('cancel').hidden = false;
    $('progress').hidden = false;
    state.state = 'downloading';
    try {
      const result = await downloadManifest({
        store: await getStore(),
        shaka, manifest, parallel, signal: controller.signal,
        choice: {
          videoId: info.videos.length ? Number(quality.value) : null,
          audioId: info.audios.length ? Number(audioSel.value) : null
        },
        onProgress: p => {
          $('progress').max = p.total;
          $('progress').value = p.done;
          const speed = p.seconds > 0 ? ` · ${mb(p.bytes / p.seconds)}/s` : '';
          setStatus(`Segment ${p.done} of ${p.total} · ${mb(p.bytes)}${speed}`);
        }
      });
      player.destroy().catch(() => {});
      setStatus('Putting the MP4 together…');
      finish(result, $('name').value, 'video/mp4');
    } catch (e) {
      fail(e.message === 'Cancelled' || (controller && controller.signal.aborted) ? new Error('Cancelled.') : e);
      if (controller && controller.signal.aborted) state.state = 'cancelled';
    }
  };
  $('cancel').onclick = () => controller && controller.abort();
}

function finish(result, name, type) {
  const fileName = name && name.trim() ? name.trim() : 'video.mp4';
  save(result, fileName, type);
  Object.assign(state, { state: 'done', size: result.size, duration: result.duration || 0, tracks: result.tracks || [], name: fileName, peakHeld: result.peakHeld, storage: result.storage });
  $('cancel').hidden = true;
  $('progress').value = $('progress').max;
  setStatus(`Saved ${fileName} (${mb(result.size)}${result.duration ? `, ${clock(result.duration)}` : ''}).`, 'done');
  $('again').hidden = false;
  $('again').onclick = () => save(result, fileName, type);
}

main().catch(fail);
