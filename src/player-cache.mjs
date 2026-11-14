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
export async function saveStreamFromCache(cache, { url, title, choice = {} }) {
  const subs = new URLSearchParams(globalThis.location.search).get('subs') || '';
  const message = { type: 'saveFromPlayer', url, title: title || '', subs, cache: cache.name || '' };
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
