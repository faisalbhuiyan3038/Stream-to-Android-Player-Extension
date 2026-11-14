// What both player pages do with the whole-video cache (src/stream-cache.mjs) besides feeding
// it to their engine: plain files as byte ranges, and "Save" once everything is in.
import { planFile } from './stream-cache.mjs';
import { safeFileName } from './downloader.mjs';

// A plain file: download it as 4 MB ranges, ordered from the playhead. Resolves to the file plan
// ({ total, type, segments }) or null when the server does not do byte ranges.
export async function startFileCache(cache, video, url) {
  const plan = await planFile(url);
  if (!plan) return null;
  cache.setPlan(plan.segments);
  const count = plan.segments.length;
  const onTime = () => {
    if (video.duration > 0 && Number.isFinite(video.duration)) cache.setPosition(video.currentTime / video.duration * count);
  };
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('seeking', onTime);
  return plan;
}

// Calls `whenDone` once, when every planned segment is in
export function onComplete(cache, whenDone) {
  let fired = false;
  const prev = cache.onChange;
  cache.onChange = (c) => {
    prev(c);
    if (!fired && c.progress().complete) {
      fired = true;
      Promise.resolve().then(whenDone).catch(e => console.warn('[cache] after completion:', e));
    }
  };
}

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

// HLS / DASH: the download page builds the MP4 from the cached segments (opened by the
// background with this tab's Referer/Cookie rule, so anything missing can still be fetched).
// choice: { height, bandwidth, audioLanguage } of what is playing.
export async function saveStreamFromCache(cache, { url, title, choice = {}, partial = false }) {
  const subs = new URLSearchParams(globalThis.location.search).get('subs') || '';
  const message = { type: 'saveFromPlayer', url, title: title || '', subs, cache: cache.name || '' };
  if (partial) message.partial = '1';
  if (choice.height) message.vh = choice.height;
  if (choice.bandwidth) message.vbw = choice.bandwidth;
  if (choice.audioLanguage) message.alang = choice.audioLanguage;
  const res = await extensionApi().runtime.sendMessage(message);
  if (res && res.success === false) throw new Error(res.error || 'Could not open the download page');
  return res;
}

// A plain file: the cached ranges are the file; it is saved straight away
export async function saveFileFromCache(cache, plan, { url, title }) {
  const blob = await cache.assemble(plan.type);
  if (!blob) throw new Error('The video is not completely loaded yet');
  const path = url.split(/[?#]/)[0];
  const ext = (path.match(/\.(mp4|m4v|webm|mkv|mov|ts|mp3|m4a)$/i) || [, 'mp4'])[1].toLowerCase();
  const fallback = decodeURIComponent(path.split('/').pop().replace(/\.[^.]+$/, '') || 'video');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = safeFileName(title || fallback, ext);
  document.body.appendChild(a);
  a.click();
  a.remove();
  return a.download;
}

// Save, from the badge, at any time (FastStream's Save works before the download is complete too):
// - complete: saved now;
// - "Whole video" while loading: saved the moment the download finishes (the player is fetching
//   the rest already, a second download would compete with it), unless the storage limit was
//   reached — then it is saved now, the download page reading what is stored and fetching the rest;
// - "Loaded part" (streams only): the part downloaded so far, gaps joined.
// saveNow(mode) does the saving ('whole' | 'partial').
export function attachSaver(cache, badge, saveNow) {
  const run = async (mode, button) => {
    if (button) button.disabled = true;
    try {
      await saveNow(mode);
    } finally {
      if (button) button.disabled = false;
    }
  };
  const prev = cache.onChange;
  cache.onChange = (c) => {
    prev(c);
    if (badge.pending && c.progress().complete) {
      badge.pending = false;
      run('whole');
    }
  };
  return (mode, button) => {
    const p = cache.progress();
    if (mode === 'partial' || p.complete || p.windowMode) return run(mode, button);
    badge.pending = true;
  };
}

// What Save does in every player. filePlan: the plain-file plan (null for HLS/DASH).
// choice: what is playing (preselected on the download page). Returns the saved file name when
// the file was saved right here.
export async function saveCached(cache, { filePlan, url, title, choice, mode = 'whole' }) {
  if (filePlan) {
    if (cache.progress().complete) return saveFileFromCache(cache, filePlan, { url, title });
    // not all of it could be kept (storage limit): the download page downloads the file
    await saveStreamFromCache(cache, { url, title });
    return null;
  }
  await saveStreamFromCache(cache, { url, title, choice, partial: mode === 'partial' });
  return null;
}
