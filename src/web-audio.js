// Audio effects for <video>/<audio> elements on web pages (popup Audio tab: "Effects on
// websites", off by default). Same engine and shared `audioFx` settings as the built-in players
// (audio-fx.mjs). Nothing is drawn on the page: the controls are the popup's Audio tab, the
// Alt+Shift+A shortcut (a short toast shows the preset) and the right-click menu.
// Runs in every frame from document_start (embedded players live in iframes).
//
// Reaching every element: media in open and closed shadow roots is found too (their `play`
// events don't leave the root). Media from another server without CORS is silent to Web Audio,
// so while effects are wanted the background adds `Access-Control-Allow-Origin: *` to this
// tab's media responses and such elements are loaded in CORS mode (`crossorigin="anonymous"`;
// before they load where possible, else reloaded once at the same time). If that load fails
// (e.g. the server needs the site's cookies, which anonymous mode doesn't send) the element is
// put back as it was and keeps its normal audio. DRM and sites that route the element through
// their own Web Audio can't be processed here: the popup offers "Process whole tab" (Chromium
// tab capture, offscreen-audio.js); while a tab is captured this script processes nothing.
import { createAudioFx, audioReadable, needsCorsUpgrade, loadAudioSettings, AUDIO_KEY } from './audio-fx.mjs';
import { normalizeSettings } from './audio-presets.mjs';
import { resolveParams, isNeutral } from './audio-dsp.mjs';

const ext = globalThis.browser || globalThis.chrome;
const TOP = window === window.top;

const fxOf = new Map(); // element → createAudioFx() api (Map: the popup's status lists them)
const pending = new Set(); // elements being reloaded in CORS mode
const noCors = new WeakSet(); // CORS load failed: left as they were
const watched = new WeakSet(); // document / shadow roots with our listeners
let settings = null; // extension settings (webAudioFx, enabled, lists)
let fxSettings = normalizeSettings();
let captured = false; // the whole tab is processed by tab capture
let on = false; // effects on websites switched on for this page
let corsReady = null; // promise: the background's CORS rule for this tab is in place
let reportUntil = 0;
let lastActive = false;

// Same rule as content.js siteDisabled (global Enabled switch, per-site lists)
function siteDisabled(s) {
  if (s.enabled === false) return true;
  const name = location.hostname;
  const shared = globalThis.StreamShared;
  if (!name || !shared) return false;
  if (shared.matchesDomainList(name, s.whitelist || [])) return false;
  return shared.matchesDomainList(name, s.blacklist || []);
}

const wanted = () => on && !isNeutral(resolveParams(fxSettings));

// ─── Finding media elements ──────────────────────────────────────────────────

const isMedia = (n) => n instanceof HTMLMediaElement;
const dom = ext.dom;
function shadowOf(el) {
  try {
    if (dom && dom.openOrClosedShadowRoot) return dom.openOrClosedShadowRoot(el) || null; // Chromium
    return el.openOrClosedShadowRoot || el.shadowRoot || null; // Firefox content scripts
  } catch {
    return null;
  }
}

function onAdded(node) {
  if (!(node instanceof Element)) return;
  if (isMedia(node)) prepare(node);
  else if (node.firstElementChild) for (const m of node.querySelectorAll('video, audio')) prepare(m);
  const root = shadowOf(node);
  if (root) watchRoot(root);
}

// `play` doesn't leave a shadow root, so each root gets its own listener and observer
function watchRoot(root) {
  if (watched.has(root)) return;
  watched.add(root);
  root.addEventListener('play', (e) => { if (isMedia(e.target)) attach(e.target); }, true);
  new MutationObserver((records) => {
    if (!wanted() || captured) return;
    for (const r of records) {
      if (r.type === 'attributes') { if (isMedia(r.target)) prepare(r.target); } // src set by a script
      else for (const n of r.addedNodes) onAdded(n);
    }
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  if (wanted()) for (const m of root.querySelectorAll('video, audio')) prepare(m);
}

// Shadow roots attached after their host was inserted: found by a scan of the whole tree,
// at start and on taps/keys (before the click that starts a video)
let lastScan = 0;
let scanTimer = 0;
function deepScan() {
  if (!wanted() || captured) return;
  // at most one scan a second, but always one after the last request (a tap right after a scan)
  const wait = lastScan + 1000 - performance.now();
  if (wait > 0) {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; deepScan(); }, wait);
    return;
  }
  lastScan = performance.now();
  const walk = (root) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = it.nextNode(); el; el = it.nextNode()) {
      if (isMedia(el)) {
        prepare(el);
        if (!el.paused) attach(el);
      }
      const sr = shadowOf(el);
      if (sr) {
        watchRoot(sr);
        walk(sr);
      }
    }
  };
  walk(document);
}

// ─── CORS mode ───────────────────────────────────────────────────────────────
// Playback never depends on it: an element first plays as the site made it, then (once it is
// actually playing, so the site's own play() has resolved) it is loaded again in CORS mode at
// the same position. A server that worked once gets later elements marked before they load (no
// reload). A server that refuses is left alone for the rest of the page. The events of our own
// attempt (abort/emptied of the reload, the error of a refused load) are kept from the page.

const goodHosts = new Set();
const badHosts = new Set();
const failOf = new Map(); // element in a CORS attempt → undo
const quiet = new Set(); // element whose abort/emptied come from our reload

function ensureCorsRule() {
  if (!corsReady) {
    corsReady = ext.runtime.sendMessage({ type: 'audioCors' }).then(r => !!(r && r.ok), () => false);
  }
  return corsReady;
}

function hostOf(el) {
  const src = el.currentSrc || el.getAttribute('src') || (el.querySelector('source[src]') || { src: '' }).src;
  if (!src) return '';
  try {
    const u = new URL(src, location.href);
    return /^https?:$/.test(u.protocol) ? u.host : '';
  } catch {
    return '';
  }
}

// Before an element starts loading, the attribute is enough (the request is made in CORS mode)
const notLoadedYet = (el) => el.networkState === el.NETWORK_EMPTY || el.networkState === el.NETWORK_NO_SOURCE;
// play() asked for, not playing yet: its promise is still pending (a load() now would reject it)
const starting = (el) => !el.paused && el.readyState < el.HAVE_FUTURE_DATA;

function prepare(el) {
  if (!wanted() || captured || noCors.has(el) || pending.has(el) || el.hasAttribute('crossorigin') || el.mediaKeys) return;
  const host = hostOf(el);
  if (!host || host === location.host || badHosts.has(host)) return;
  if (notLoadedYet(el)) {
    if (!goodHosts.has(host)) return; // first element of a server: it plays first, then the reload
    pending.add(el);
    el.crossOrigin = 'anonymous';
    settle(el, host, null);
    return;
  }
  if (!needsCorsUpgrade(el)) return;
  pending.add(el);
  ensureCorsRule().then((ok) => {
    if (!ok || el.hasAttribute('crossorigin') || !needsCorsUpgrade(el)) {
      pending.delete(el);
      return;
    }
    if (el.paused || starting(el)) {
      // only a playing element is reloaded: a play() asked for meanwhile has resolved by then
      el.addEventListener('playing', () => setTimeout(() => {
        if (!el.hasAttribute('crossorigin') && needsCorsUpgrade(el)) reload(el, host);
        else pending.delete(el);
      }, 0), { once: true });
    } else {
      reload(el, host);
    }
  });
}

// load() again in CORS mode with the same position, speed and play state
function reload(el, host) {
  const state = { time: el.currentTime, rate: el.playbackRate, paused: el.paused };
  el.crossOrigin = 'anonymous';
  quiet.add(el);
  el.addEventListener('loadstart', () => quiet.delete(el), { once: true });
  el.load();
  settle(el, host, state);
}

// Watch the CORS-mode load: metadata → readable; an error → undo
function settle(el, host, state) {
  let over = false;
  const done = (ok) => {
    if (over) return;
    over = true;
    el.removeEventListener('loadedmetadata', good);
    el.removeEventListener('error', bad, true);
    failOf.delete(el);
    pending.delete(el);
    if (ok) {
      goodHosts.add(host);
      if (state) restore(el, state);
    } else {
      badHosts.add(host);
      noCors.add(el);
      const back = state || { time: 0, rate: el.playbackRate, paused: true }; // never started by us
      el.removeAttribute('crossorigin');
      quiet.add(el);
      el.addEventListener('loadstart', () => quiet.delete(el), { once: true });
      el.load();
      el.addEventListener('loadedmetadata', () => restore(el, back), { once: true });
    }
    const fx = fxOf.get(el);
    if (fx) fx.refresh();
  };
  const good = () => done(true);
  const bad = () => done(false); // capture: a failing <source> child fires on itself
  failOf.set(el, bad);
  el.addEventListener('loadedmetadata', good);
  el.addEventListener('error', bad, true);
}

function restore(el, { time, rate, paused }) {
  if (time > 0) el.currentTime = time;
  el.playbackRate = rate;
  if (!paused) el.play().catch(() => {});
}

// Registered at document_start, before the page's scripts: our listeners come first. (Inside a
// shadow root these events don't reach the window; there the element's own listener undoes.)
window.addEventListener('error', (e) => {
  const t = e.target;
  const el = t instanceof HTMLSourceElement ? t.parentElement : t;
  const fail = failOf.get(el);
  if (!fail) return;
  e.stopImmediatePropagation();
  fail();
}, true);
for (const type of ['abort', 'emptied']) {
  window.addEventListener(type, (e) => { if (quiet.has(e.target)) e.stopImmediatePropagation(); }, true);
}

// ─── Effects per element ─────────────────────────────────────────────────────

const canRead = (el) => !pending.has(el) && audioReadable(el);

function attach(el) {
  if (!on || !isMedia(el)) return;
  prepare(el);
  if (fxOf.has(el)) return;
  const fx = createAudioFx(el, { workletUrl: ext.runtime.getURL('audio-worklet.bundle.js'), canRead });
  if (captured) fx.setEnabled(false);
  fxOf.set(el, fx);
  fx.subscribe(reportActive);
  // a new source (another episode, an ad ending) may need CORS mode too
  el.addEventListener('loadstart', () => prepare(el));
}

function applyState() {
  // kept even when detached: an element re-inserted later can't get a second source node
  for (const fx of fxOf.values()) fx.setEnabled(on && !captured);
  if (wanted() && !captured) {
    deepScan();
    for (const el of fxOf.keys()) prepare(el);
  }
  reportActive();
}

function applySettings(s) {
  settings = s || {};
  const next = !!settings.webAudioFx && !siteDisabled(settings);
  if (next === on) return applyState();
  on = next;
  if (on) {
    watchRoot(document);
    lastScan = 0;
  }
  applyState();
}

// The toolbar badge shows when effects run on the tab
function reportActive() {
  const active = [...fxOf.values()].some(fx => fx.status().active);
  if (active === lastActive) return;
  lastActive = active;
  ext.runtime.sendMessage({ type: 'audioActive', active }).catch(() => {});
}

// ─── Status for the popup's Audio tab (read with scripting.executeScript) ───

function pick() {
  let best = null;
  let score = -1;
  for (const [el, fx] of fxOf) {
    if (!el.isConnected && el.paused) continue;
    const r = el.getBoundingClientRect();
    const s = (el.paused ? 0 : 1e9) + r.width * r.height;
    if (s > score) { best = [el, fx]; score = s; }
  }
  return best;
}

globalThis.__sapAudio = {
  status() {
    const found = pick();
    const base = { on, captured, top: TOP, frame: location.hostname };
    if (!found) return { ...base, mode: 'none' };
    const [el, fx] = found;
    if (performance.now() < reportUntil) fx.report(true);
    const st = fx.status();
    return {
      ...base,
      mode: pending.has(el) ? 'loading' : st.mode,
      error: st.error,
      state: st.state,
      playing: !el.paused,
      drm: !!el.mediaKeys,
      noCors: noCors.has(el),
      kind: el.localName
    };
  },
  // test hook: every element's state, and levels in/out of one (by id or tag name)
  elements() {
    return [...fxOf].map(([el, fx]) => ({ id: el.id || el.localName, mode: pending.has(el) ? 'loading' : fx.status().mode, noCors: noCors.has(el), paused: el.paused, time: el.currentTime }));
  },
  measure(ms, id) {
    const found = [...fxOf].find(([el]) => (el.id || el.localName) === id);
    return found ? found[1].measure(ms) : null;
  },
  // the popup polls while open; the readout stops 2 s after the last poll
  report() {
    reportUntil = performance.now() + 2000;
    const found = pick();
    if (found) found[1].report(true);
    setTimeout(() => {
      if (performance.now() >= reportUntil) for (const fx of fxOf.values()) fx.report(false);
    }, 2100);
  }
};

// ─── Toast (Alt+Shift+A) ─────────────────────────────────────────────────────

let toastHost = null;
let toastTimer = 0;
function toast(text) {
  if (!TOP) return;
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = toastHost.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .t { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); padding: 8px 16px;
        border-radius: 18px; background: rgba(20, 20, 28, 0.9); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.4);
        font: 600 14px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        transition: opacity .2s; opacity: 0; white-space: nowrap; }
      .t.show { opacity: 1; }
      @media (prefers-reduced-motion: reduce) { .t { transition: none; } }
    </style><div class="t" role="status" aria-live="polite"></div>`;
  }
  // a fullscreen container has no room for other elements: go inside it
  const fs = document.fullscreenElement;
  const parent = fs && !(fs instanceof HTMLMediaElement) ? fs : document.documentElement;
  if (toastHost.parentNode !== parent) parent.appendChild(toastHost);
  const t = toastHost.shadowRoot.querySelector('.t');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

document.addEventListener('pointerdown', deepScan, { capture: true, passive: true });
document.addEventListener('keydown', deepScan, { capture: true, passive: true });
document.addEventListener('DOMContentLoaded', () => deepScan());
window.addEventListener('load', () => deepScan());

ext.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'audioToast') toast(msg.text);
  else if (msg.type === 'audioCaptured') {
    captured = !!msg.on;
    applyState();
  }
});

Promise.all([
  ext.storage.local.get('settings').then(r => r && r.settings, () => null),
  loadAudioSettings()
]).then(async ([s, a]) => {
  fxSettings = a;
  // only asked when the feature is on (no message from every frame of every page otherwise)
  if (s && s.webAudioFx) captured = await ext.runtime.sendMessage({ type: 'audioCaptureState' }).then(r => !!(r && r.captured), () => false);
  applySettings(s);
});
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[AUDIO_KEY]) fxSettings = normalizeSettings(changes[AUDIO_KEY].newValue);
  if (changes.settings) applySettings(changes.settings.newValue);
  else if (changes[AUDIO_KEY] && settings) applyState();
});

