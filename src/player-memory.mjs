// Playback memory shared by both web players: resume position per video, preferred speed,
// preferred quality height. Stored in the extension origin's localStorage (works in Chrome
// and Firefox, desktop and Android). `storage` is injectable for the unit tests.

const POS_KEY = 'sap.positions';   // { [videoKey]: { t: seconds, d: duration, at: epoch ms } }
const RATE_KEY = 'sap.rate';       // number
const HEIGHT_KEY = 'sap.height';   // number (preferred video height, set when the user picks a quality)
const MAX_ENTRIES = 200;
const MIN_RESUME = 10;             // do not resume in the first 10 s …
const END_MARGIN = 15;             // … nor in the last 15 s (it is finished)

// Same video across sessions: signed CDN URLs change their query string every time, so the
// key is origin + path. Paths that are only a generic file name ("index.m3u8") keep the query.
export function videoKey(url) {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || '';
    const generic = /^(index|master|playlist|manifest|video|stream|chunklist)[^/]*\.(m3u8|mpd)$/i.test(file) && u.pathname.split('/').length <= 2;
    return u.origin + u.pathname + (generic ? u.search : '');
  } catch {
    return String(url || '');
  }
}

function readJson(storage, key, fallback) {
  try {
    const v = JSON.parse(storage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export function createMemory(storage = globalThis.localStorage, now = () => Date.now()) {
  return {
    // Position worth resuming at, or 0
    resumePosition(url, duration) {
      const entry = readJson(storage, POS_KEY, {})[videoKey(url)];
      if (!entry || !(entry.t >= MIN_RESUME)) return 0;
      const d = Number.isFinite(duration) && duration > 0 ? duration : entry.d;
      if (Number.isFinite(d) && d > 0 && entry.t > d - END_MARGIN) return 0;
      return entry.t;
    },
    savePosition(url, time, duration) {
      const all = readJson(storage, POS_KEY, {});
      const key = videoKey(url);
      const finished = Number.isFinite(duration) && duration > 0 && time > duration - END_MARGIN;
      if (finished || !(time >= MIN_RESUME)) {
        if (all[key]) { delete all[key]; writeJson(storage, POS_KEY, all); }
        return;
      }
      all[key] = { t: Math.floor(time), d: Number.isFinite(duration) ? Math.floor(duration) : null, at: now() };
      const keys = Object.keys(all);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX_ENTRIES).forEach(k => delete all[k]);
      }
      writeJson(storage, POS_KEY, all);
    },
    forget(url) {
      const all = readJson(storage, POS_KEY, {});
      delete all[videoKey(url)];
      writeJson(storage, POS_KEY, all);
    },
    rate() {
      const r = Number(readJson(storage, RATE_KEY, 1));
      return r >= 0.25 && r <= 4 ? r : 1;
    },
    setRate(r) { if (r >= 0.25 && r <= 4) writeJson(storage, RATE_KEY, r); },
    preferredHeight() { return Number(readJson(storage, HEIGHT_KEY, 0)) || 0; },
    setPreferredHeight(h) { writeJson(storage, HEIGHT_KEY, h > 0 ? h : 0); }
  };
}

// Of `heights`, the one closest to `preferred` (ties: the lower one), or null.
export function closestHeight(heights, preferred) {
  if (!preferred || !heights.length) return null;
  return heights.slice().sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b)[0];
}

export function formatClock(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Wires a <video> element to the memory: resumes (with a "Start over" toast), saves every few
// seconds and on pause/hide, and keeps the chosen playback speed. Players reset the rate to 1
// while they load, so rate changes are only recorded once the remembered rate has been applied
// (`applyRate`, also returned for players that finish loading later). `setRate` lets a player
// apply it through its own API so its state stays in sync.
// Returns { detach, applyRate }.
export function attachPlaybackMemory(video, url, {
  memory = createMemory(), toast = null,
  setRate = r => { video.playbackRate = r; },
  seek = t => { video.currentTime = t; }
} = {}) {
  let resumed = false;
  let lastSave = 0;
  let rateApplied = false;
  const save = () => memory.savePosition(url, video.currentTime, video.duration);

  const applyRate = () => {
    const rate = memory.rate();
    if (video.playbackRate !== rate) setRate(rate);
    // the player's own reset may still be queued: start listening a moment later
    setTimeout(() => { rateApplied = true; }, 300);
  };

  const onMeta = () => {
    applyRate();
    if (resumed) return;
    resumed = true;
    const at = memory.resumePosition(url, video.duration);
    if (at > 0) {
      seek(at);
      if (toast) toast(`Resumed at ${formatClock(at)}`, 'Start over', () => { seek(0); memory.forget(url); });
    }
  };
  const onTime = () => {
    const t = Date.now();
    if (t - lastSave > 5000) { lastSave = t; save(); }
  };
  const onRate = () => { if (rateApplied) memory.setRate(video.playbackRate); };
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };

  if (video.readyState >= 1) onMeta();
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('pause', save);
  video.addEventListener('ended', save);
  video.addEventListener('ratechange', onRate);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', save);
  const detach = () => {
    video.removeEventListener('loadedmetadata', onMeta);
    video.removeEventListener('timeupdate', onTime);
    video.removeEventListener('pause', save);
    video.removeEventListener('ended', save);
    video.removeEventListener('ratechange', onRate);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', save);
  };
  return { detach, applyRate };
}

// Minimal toast in #toast: message + optional action button, hides after `ms`.
export function makeToast(el, ms = 10000) {
  let timer;
  return (message, actionLabel, action) => {
    if (!el) return;
    el.replaceChildren();
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (actionLabel && action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', () => { action(); el.classList.remove('visible'); });
      el.appendChild(b);
    }
    el.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove('visible'), ms);
  };
}

// Fullscreen on a phone: turn to landscape for landscape videos (best effort; needs fullscreen).
export function lockOrientationOnFullscreen(video) {
  document.addEventListener('fullscreenchange', () => {
    const o = screen.orientation;
    if (!o || !o.lock) return;
    if (document.fullscreenElement) {
      if (video.videoWidth > video.videoHeight) o.lock('landscape').catch(() => {});
    } else if (o.unlock) {
      try { o.unlock(); } catch { /* not locked */ }
    }
  });
}
