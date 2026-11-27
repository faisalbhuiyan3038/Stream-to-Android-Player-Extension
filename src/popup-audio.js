// The popup's Audio tab: the players' panel (src/audio-ui.mjs) shown inline. Its `fx` is the
// shared `audioFx` settings (so the players, websites and the offscreen capture follow at once)
// plus a live status of the current tab, read from web-audio.js (`__sapAudio`) in every frame
// twice a second while the tab is shown. Offers "Process whole tab" (Chromium tab capture,
// src/offscreen-audio.js) for what the page's Web Audio can't read.
import { createAudioPanel } from './audio-ui.mjs';
import { loadAudioSettings, AUDIO_KEY } from './audio-fx.mjs';
import { normalizeSettings, presetLabel, selectPreset } from './audio-presets.mjs';
import { resolveParams, isNeutral } from './audio-dsp.mjs';
import css from '../audio-ui.css';

const ext = globalThis.browser || globalThis.chrome;
const canCapture = !!(globalThis.chrome && chrome.tabCapture && chrome.tabCapture.getMediaStreamId);

const style = document.createElement('style');
style.textContent = `${css}
.sap-audio-menu.sap-audio-inline { position: static; width: auto; max-height: none; overflow: visible; padding: 12px 0 4px; background: none; box-shadow: none; }
.audio-capture { margin-top: 8px; }
.audio-capture .save-btn { width: 100%; }`;
document.head.appendChild(style);

const panelEl = document.getElementById('audio-panel');
const tabPanel = document.getElementById('panel-audio');
const captureBox = document.getElementById('audio-capture');
const captureText = document.getElementById('audio-capture-text');
const captureBtn = document.getElementById('audio-capture-btn');

let settings = normalizeSettings();
let webOn = false;
let tabId = null;
let page = { reachable: false, frames: [], audible: false, captured: false };
let lastWritten = '';
let saveTimer = 0;
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(fx.status()); };

// The most telling frame: something playing, then anything found
function mainFrame(frames) {
  const found = frames.filter(f => f.mode !== 'none');
  return found.find(f => f.playing) || found[0] || null;
}

function describePage(f) {
  if (!webOn) return 'Off on websites: only the built-in players use these settings';
  if (page.captured) return 'Whole tab processed';
  if (!page.reachable) return "Effects can't run on this page";
  if (!f) return page.audible ? 'The audio on this tab is not from a video or audio element' : 'Nothing playing on this tab';
  if (f.mode === 'loading') return 'Preparing the video…';
  if (f.mode === 'unreadable') {
    if (f.drm) return "DRM-protected: the page's audio can't be processed";
    if (f.noCors) return "This video's server refuses it";
    return 'Starts once the video loads';
  }
  if (f.mode === 'error') return 'This site processes its own audio';
  return ''; // active / waiting / bypass: the panel's own wording
}

const fx = {
  get settings() { return settings; },
  status() {
    const params = resolveParams(settings);
    const wanted = !isNeutral(params);
    const f = mainFrame(page.frames);
    const text = wanted || !webOn ? describePage(f) : '';
    return {
      mode: f ? f.mode : 'none',
      settings,
      params,
      wanted,
      active: !!f && f.mode === 'active',
      presetName: presetLabel(settings),
      state: f && f.mode === 'active' ? f.state : null,
      text
    };
  },
  set(partial) {
    settings = normalizeSettings({ ...settings, ...partial });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      lastWritten = JSON.stringify(settings);
      ext.storage.local.set({ [AUDIO_KEY]: settings }).catch(() => {});
    }, 150);
    emit();
  },
  setPreset(name) { fx.set(selectPreset(name)); },
  report() {},
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
};

const panel = createAudioPanel(panelEl, { fx });
fx.subscribe((st) => { panel.render(st); renderCapture(); });

function renderCapture() {
  const f = mainFrame(page.frames);
  const stuck = !!f && (f.drm || f.noCors || f.mode === 'error');
  const show = canCapture && webOn && tabId != null && (page.captured || (fx.status().wanted && (stuck || (!f && page.audible))));
  captureBox.hidden = !show;
  if (!show) return;
  captureBtn.textContent = page.captured ? 'Stop processing whole tab' : 'Process whole tab';
  captureText.textContent = page.captured
    ? "The tab's whole sound goes through the effects; Chrome shows that the tab is shared."
    : "Runs the tab's whole sound through the effects instead. Chrome shows that the tab is shared while this is on.";
}

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  try {
    if (page.captured) {
      await ext.runtime.sendMessage({ type: 'audioCaptureStop', tabId });
    } else {
      // the popup counts as the user invoking the extension on this tab
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError || !id) reject(new Error((chrome.runtime.lastError || {}).message || 'No stream'));
          else resolve(id);
        });
      });
      const res = await ext.runtime.sendMessage({ type: 'audioCaptureStart', tabId, streamId });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Capture failed');
    }
  } catch (e) {
    captureText.textContent = `Could not process the tab: ${e.message}`;
  } finally {
    captureBtn.disabled = false;
    poll();
  }
});

async function poll() {
  if (tabId == null) return;
  const next = { reachable: false, frames: [], audible: false, captured: false };
  try {
    const results = await ext.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const a = globalThis.__sapAudio;
        if (!a) return null;
        a.report();
        return a.status();
      }
    });
    next.reachable = true;
    next.frames = results.map(r => r && r.result).filter(Boolean);
  } catch { /* browser pages, the store, file:// without access */ }
  try { next.audible = !!(await ext.tabs.get(tabId)).audible; } catch { /* closed */ }
  if (canCapture) {
    next.captured = !!((await ext.runtime.sendMessage({ type: 'audioCaptureState', tabId }).catch(() => null)) || {}).captured;
  }
  page = next;
  emit();
}

async function currentTabId() {
  // popup.html?tabId=N inspects another tab (used by the automated tests)
  const forced = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
  if (Number.isInteger(forced)) return forced;
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function init() {
  const [a, s, id] = await Promise.all([
    loadAudioSettings(),
    ext.storage.local.get('settings').then(r => (r && r.settings) || {}, () => ({})),
    currentTabId().catch(() => null)
  ]);
  settings = a;
  webOn = !!s.webAudioFx;
  tabId = id;
  emit();
  poll();
  setInterval(() => { if (!tabPanel.hidden) poll(); }, 500);
}

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[AUDIO_KEY] && changes[AUDIO_KEY].newValue && JSON.stringify(changes[AUDIO_KEY].newValue) !== lastWritten) {
    settings = normalizeSettings(changes[AUDIO_KEY].newValue);
    emit();
  }
  if (changes.settings) {
    webOn = !!(changes.settings.newValue || {}).webAudioFx;
    emit();
  }
});

init();
