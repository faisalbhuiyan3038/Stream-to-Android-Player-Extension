// Download page: pick quality/audio, download the stream in this tab, save one MP4.
// Opened by the background like the web player (so the page's Referer/Cookie rule applies).
import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { getVideoUrl, getTitle, getSubtitleList } from './page-params.mjs';
import { describeManifest, downloadManifest, downloadFile, safeFileName, textStreamsOf, loadTextStream, segmentUrisOf } from './downloader.mjs';
import { loadSubtitleAsVtt, parseVttCues, cuesToSrt } from './subtitles.mjs';
import { bufferingSettings } from './prefetch.mjs';
import { openStore, removeLeftoverStores, IdbStore } from './segment-store.mjs';
import { segmentKey, parseRange } from './stream-cache.mjs';
import { registerCacheScheme } from './cache-shaka.mjs';

const $ = id => document.getElementById(id);
const url = getVideoUrl(window.location);
const title = getTitle(window.location);
const mobile = /Android|Mobile/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
const PHONE_WARN_BYTES = 500 * 1024 * 1024;

// Read by the browser tests
const state = window._download = { state: 'starting', error: null, size: 0, duration: 0, tracks: [], name: '', subtitles: [], subtitleErrors: [], fromCache: 0, fromNetwork: 0 };

// "Save" in a player: the segments it already downloaded wait in its cache database
// (src/stream-cache.mjs); they are read from there, anything missing comes from the network.
// The player also says what it plays (vh/vbw/alang), which is preselected, and the download starts
// at once (autostart).
const params = new URLSearchParams(window.location.search);
let cacheStore = null;
// partial=1: only what the player has loaded so far (like FastStream's Alt+Save); gaps are joined
const partial = params.get('partial') === '1';
let cachedKeys = new Set();
const cacheReady = params.get('cache')
  ? IdbStore.openExisting(params.get('cache')).then(async (s) => {
    cacheStore = s;
    state.cache = s.name;
    if (partial) cachedKeys = new Set(await s.keys());
  }).catch(() => { state.cache = null; })
  : Promise.resolve();

// Shaka reads the stream here too (to list qualities, it buffers a second): from the cache as well
registerCacheScheme(shaka, () => cacheStore && {
  get: (u, start, end) => cacheStore.get(segmentKey(u, start, end)).then(b => b.arrayBuffer()),
  put: () => {}
});

async function cachedFetch(u, init = {}) {
  if (cacheStore) {
    const { start, end } = parseRange(init.headers && (init.headers.Range || init.headers.range));
    try {
      const blob = await cacheStore.get(segmentKey(u, start, end));
      state.fromCache++;
      return new Response(blob, { status: 200 });
    } catch { /* not in the cache */ }
  }
  state.fromNetwork++;
  return globalThis.fetch(u, init);
}

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

// ─── subtitles ───────────────────────────────────────────────────────────────
// Two sources: subtitle files the extension found on the page (?subs=, the same list the players
// get) and subtitle tracks listed in the HLS/DASH manifest. Both go into the MP4 as text tracks;
// a plain video file is saved as it is, so its subtitles can only be .srt files.
let subtitleChoices = [];

function showSubtitleChoices(list, { embed }) {
  subtitleChoices = list;
  state.subtitleChoices = list.map(c => ({ label: c.label, language: c.language, source: c.source }));
  if (!list.length) return;
  $('subs-list').replaceChildren(...list.map((c, i) => {
    const row = document.createElement('label');
    row.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    input.dataset.index = String(i);
    const text = document.createElement('span');
    text.textContent = [c.label, c.language && c.language !== 'und' && c.language !== c.label ? c.language : ''].filter(Boolean).join(' · ');
    row.append(input, text);
    return row;
  }));
  $('subs-files-row').hidden = !embed;
  $('subs-note').textContent = embed
    ? 'Added to the MP4 as subtitle tracks (VLC, MX Player, mpv and most video players show them; browsers do not).'
    : 'This video is saved as it is, so the subtitles are saved next to it as .srt files.';
  $('subs-field').hidden = false;
}

const chosenSubtitles = () => [...$('subs-list').querySelectorAll('input:checked')].map(i => subtitleChoices[Number(i.dataset.index)]);

function lockSubtitleChoices() {
  for (const input of $('subs-field').querySelectorAll('input')) input.disabled = true;
}

// Loads the chosen subtitles as cues. A subtitle that fails is skipped (and named), not fatal.
async function loadChosenSubtitles({ signal, parallel }) {
  const out = [];
  for (const c of chosenSubtitles()) {
    try {
      let cues;
      let base = 'output';
      if (c.source === 'manifest') {
        ({ cues, base } = await loadTextStream(c.stream, { signal, parallel, fetchFn: cachedFetch }));
      } else {
        cues = parseVttCues((await loadSubtitleAsVtt(c.sub)).vtt);
      }
      if (!cues.length) throw new Error('no cues');
      out.push({ cues, base, language: c.language, label: c.label });
    } catch (e) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      state.subtitleErrors.push(`${c.label}: ${e.message || e}`);
    }
  }
  state.subtitles = out.map(t => ({ label: t.label, language: t.language, cues: t.cues.length, base: t.base }));
  return out;
}

// "Show S01E02.mp4" + English → "Show S01E02.en.srt" (the label when there is no language)
// zero: the media time that became 0 in the MP4 (for cues on the media timeline)
function saveSrtFiles(tracks, videoName, zero = 0) {
  const stem = videoName.replace(/\.[^.]+$/, '') || 'video';
  const used = new Set();
  for (const t of tracks) {
    const base = (t.language && t.language !== 'und' ? t.language : t.label || 'subtitles').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    let tag = base;
    for (let n = 2; used.has(tag); n++) tag = `${base}_${n}`;
    used.add(tag);
    const shift = t.base === 'media' ? zero : 0;
    const cues = shift ? t.cues.map(c => ({ start: c.start - shift, end: c.end - shift, text: c.text })).filter(c => c.end > 0) : t.cues;
    const blob = new Blob(['\ufeff' + cuesToSrt(cues)], { type: 'application/x-subrip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stem}.${tag}.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  state.srtFiles = tracks.length;
}

function pageSubtitles() {
  return getSubtitleList(window.location).map(s => ({ source: 'file', label: s.label || 'Subtitles', language: s.lang || 'und', sub: s }));
}

const isManifest = u => /\.(m3u8|m3u|mpd)(?:[?#]|$)/i.test(u.split('#')[0]) || /\/manifest(\(|\b)/i.test(u);

let storageKind = 'indexeddb';

async function main() {
  // Open the segment storage up front, so the size warning knows where segments will wait
  storageKind = (await getStore()).kind;
  await cacheReady;
  if (!url) return fail(new Error('No video URL given.'));
  $('source').textContent = url;
  const settings = await readSettings();
  const parallel = bufferingSettings(settings, { mobile }).parallel;
  let controller = null;

  if (!isManifest(url)) {
    // A plain file: no choices, just download it
    const ext = (url.split(/[?#]/)[0].match(/\.(mp4|m4v|webm|mkv|mov|ts|mp3|m4a)$/i) || [, 'mp4'])[1].toLowerCase();
    $('name').value = safeFileName(title || decodeURIComponent(url.split(/[?#]/)[0].split('/').pop().replace(/\.[^.]+$/, '')), ext);
    showSubtitleChoices(pageSubtitles(), { embed: false });
    setStatus('Ready.');
    state.state = 'ready';
    $('start').disabled = false;
    $('start').onclick = async () => {
      controller = new AbortController();
      $('start').disabled = true;
      $('cancel').hidden = false;
      $('progress').hidden = false;
      state.state = 'downloading';
      lockSubtitleChoices();
      try {
        const subs = await loadChosenSubtitles({ signal: controller.signal, parallel });
        const result = await downloadFile(url, {
          store: await getStore(),
          signal: controller.signal,
          onProgress: p => {
            $('progress').max = p.total || 1;
            $('progress').value = p.total ? p.done : 0;
            setStatus(`${mb(p.bytes)} downloaded`);
          }
        });
        finish(result, $('name').value, result.type, subs, true);
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

  $('name').value = safeFileName(partial ? `${title || 'video'} (part)` : (title || 'video'), 'mp4');
  if (partial) {
    state.partial = true;
    $('warning').hidden = false;
  }
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
  // What the player was playing (and has in its cache)
  const vh = Number(params.get('vh')) || 0;
  if (vh) {
    const vbw = Number(params.get('vbw')) || 0;
    const same = info.videos.filter(v => v.height === vh).sort((a, b) => Math.abs(a.bandwidth - vbw) - Math.abs(b.bandwidth - vbw));
    if (same.length) quality.value = String(same[0].id);
  }
  const alang = params.get('alang');
  if (alang) {
    const a = info.audios.find(x => x.language === alang) || info.audios.find(x => x.language && x.language.split('-')[0] === alang.split('-')[0]);
    if (a) audioSel.value = String(a.id);
  }
  $('quality-field').hidden = info.videos.length === 0;
  $('audio-field').hidden = info.audios.length === 0;
  $('choices').hidden = false;

  // Subtitles: the manifest's own text tracks, then the files found on the page (minus the
  // segments of those manifest tracks, which the page may have fetched one by one)
  const fromManifest = textStreamsOf(manifest);
  const manifestUris = new Set();
  for (const t of fromManifest) {
    try { for (const u of await segmentUrisOf(t.stream)) manifestUris.add(u); } catch { /* listed anyway */ }
  }
  showSubtitleChoices([
    ...fromManifest.map(t => ({ source: 'manifest', label: t.label, language: t.language, stream: t.stream })),
    ...pageSubtitles().filter(c => !manifestUris.has(c.sub.url))
  ], { embed: true });

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
    if (partial) warning = 'Only the part the player has loaded so far is saved; missing stretches are skipped.';
    $('warning').hidden = !warning;
    $('warning').textContent = warning;
  };
  quality.onchange = estimate;
  audioSel.onchange = estimate;
  estimate();

  setStatus('Ready.');
  state.state = 'ready';
  $('start').disabled = false;
  if (params.get('autostart') === '1') setTimeout(() => $('start').click(), 0);
  $('start').onclick = async () => {
    controller = new AbortController();
    $('start').disabled = true;
    quality.disabled = true;
    audioSel.disabled = true;
    lockSubtitleChoices();
    $('cancel').hidden = false;
    $('progress').hidden = false;
    state.state = 'downloading';
    try {
      let text = [];
      if (chosenSubtitles().length) {
        setStatus('Loading subtitles…');
        text = await loadChosenSubtitles({ signal: controller.signal, parallel });
      }
      const result = await downloadManifest({
        text,
        store: await getStore(),
        shaka, manifest, parallel, signal: controller.signal, fetchFn: cachedFetch,
        keep: partial && cacheStore ? (u, r) => cachedKeys.has(segmentKey(u, r.start, r.end)) : null,
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
      finish(result, $('name').value, 'video/mp4', text, $('subs-files').checked);
    } catch (e) {
      fail(e.message === 'Cancelled' || (controller && controller.signal.aborted) ? new Error('Cancelled.') : e);
      if (controller && controller.signal.aborted) state.state = 'cancelled';
    }
  };
  $('cancel').onclick = () => controller && controller.abort();
}

function finish(result, name, type, subtitles = [], srtFiles = false) {
  const fileName = name && name.trim() ? name.trim() : 'video.mp4';
  save(result, fileName, type);
  if (srtFiles && subtitles.length) saveSrtFiles(subtitles, fileName, result.zero || 0);
  Object.assign(state, { state: 'done', size: result.size, duration: result.duration || 0, tracks: result.tracks || [], name: fileName, peakHeld: result.peakHeld, storage: result.storage });
  $('cancel').hidden = true;
  $('progress').value = $('progress').max;
  const embedded = (result.tracks || []).filter(t => t.handler === 'sbtl').length;
  const subNote = [
    embedded ? `${embedded} subtitle track${embedded > 1 ? 's' : ''} inside` : '',
    srtFiles && subtitles.length ? `${subtitles.length} .srt file${subtitles.length > 1 ? 's' : ''}` : '',
    state.subtitleErrors.length ? `skipped ${state.subtitleErrors.join('; ')}` : ''
  ].filter(Boolean).join(' · ');
  setStatus(`Saved ${fileName} (${mb(result.size)}${result.duration ? `, ${clock(result.duration)}` : ''}).${subNote ? ` Subtitles: ${subNote}.` : ''}`, 'done');
  $('again').hidden = false;
  $('again').onclick = () => save(result, fileName, type);
}

main().catch(fail);
