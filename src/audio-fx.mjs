// Audio effects for a player's <video> (normalizer, dialogue boost, tone, volume boost up to
// 200 %, presets). The DSP runs in an AudioWorklet (src/audio-worklet.js → audio-worklet.bundle.js).
//
// Cost rules: nothing is created while the effects are Off (the browser plays the audio as
// usual); once created, choosing Off again routes the audio straight to the output and drops the
// worklet; the AudioContext is suspended while the video is paused.
// Safety rules: the video is only routed through Web Audio when the context is running (a
// suspended one would silence the video, e.g. before the first click under an autoplay policy)
// and when its audio is readable (Firefox gives silence for a cross-origin file without the
// crossorigin attribute — the pages set it; blob:/MSE sources are always fine).
//
// Settings live in storage.local `audioFx` (shape and presets: src/audio-presets.mjs); the last
// choice is used by the next video, and changes from the popup reach open players at once.
import { resolveParams, isNeutral } from './audio-dsp.mjs';
import { normalizeSettings, presetLabel, presetName, selectPreset, nextPreset } from './audio-presets.mjs';

export const AUDIO_KEY = 'audioFx';

const storageApi = () => {
  const api = globalThis.browser || globalThis.chrome;
  return api && api.storage && api.storage.local ? api : null;
};
const isFirefox = () => {
  const api = globalThis.browser;
  return !!(api && api.runtime && typeof api.runtime.getBrowserInfo === 'function');
};

export async function loadAudioSettings() {
  const api = storageApi();
  if (!api) return normalizeSettings();
  try {
    const r = await api.storage.local.get(AUDIO_KEY);
    return normalizeSettings(r && r[AUDIO_KEY]);
  } catch {
    return normalizeSettings();
  }
}

// Whether Web Audio may read this element's audio (see the header)
export function audioReadable(video, here = globalThis.location) {
  if (video.mediaKeys) return false; // DRM (EME): Web Audio only gets silence
  if (video.srcObject) return true;
  const src = video.currentSrc || video.src || '';
  if (!src) return false;
  if (/^(blob|data|mediasource|chrome-extension|moz-extension|safari-web-extension):/i.test(src)) return true;
  if (video.crossOrigin === 'anonymous' || video.crossOrigin === 'use-credentials') return true;
  const extensionPage = !!here && /-extension:$/.test(here.protocol);
  // Chromium: extension pages with host permissions read cross-origin media; a web page
  // (web-audio.bundle.js) only reads its own origin's files, in every browser
  if (extensionPage) return !isFirefox();
  try { return !!here && new URL(src, here.href).origin === here.origin; } catch { return false; }
}

// Web pages: whether loading this element's media again in CORS mode would make it readable
// (web-audio.js has the background add `Access-Control-Allow-Origin: *` to the tab's media
// responses first). Never for DRM, live streams (srcObject), elements that already chose a CORS
// mode, or sources that are readable anyway.
export function needsCorsUpgrade(video, here = globalThis.location) {
  if (video.mediaKeys || video.srcObject || video.hasAttribute('crossorigin')) return false;
  const src = video.currentSrc || video.src || '';
  return /^https?:/i.test(src) && !audioReadable(video, here);
}

// Firefox needs the attribute before the source is loaded (plain files only; MSE is a blob:)
export const needsCrossOriginAttr = isFirefox;
export function prepareVideoForAudio(video) {
  if (isFirefox() && !video.hasAttribute('crossorigin')) video.crossOrigin = 'anonymous';
}

// Firefox content script (web-audio.bundle.js): objects handed to the page's AudioWorklet must be
// cloned into the page first, else "The object could not be cloned"; elsewhere a no-op
const toPage = (o) => (typeof cloneInto === 'function' ? cloneInto(o, window) : o);

// canRead: web-audio.js holds the source back while it reloads the element in CORS mode (a
// source node made from the no-CORS copy would stay silent if that reload had to be undone)
export function createAudioFx(video, { notify = () => {}, workletUrl = 'audio-worklet.bundle.js', canRead = audioReadable } = {}) {
  let settings = normalizeSettings();
  let ctx = null;
  let source = null;
  let node = null;
  let nodePromise = null;
  let moduleLoaded = false;
  let mode = 'off'; // off | waiting | unreadable | active | bypass | error
  let errorText = '';
  let lastState = null;
  let reporting = false;
  let pausedByUs = false;
  let suspendTimer = 0;
  let waitingForGesture = false;
  let lastWritten = '';
  let saveTimer = 0;
  let touched = false;
  const listeners = new Set();

  const params = () => resolveParams(settings);
  let enabled = true; // false: web page whose "Audio effects on websites" was switched off
  const wanted = () => enabled && !isNeutral(params());
  const emit = () => { for (const fn of listeners) { try { fn(api.status()); } catch (e) { console.warn(e); } } };

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const st = storageApi();
      if (!st) return;
      lastWritten = JSON.stringify(settings);
      st.storage.local.set({ [AUDIO_KEY]: settings }).catch(() => {});
    }, 300);
  }

  async function ensureContext() {
    if (!ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is not available');
      ctx = new Ctx({ latencyHint: 'balanced' });
      ctx.addEventListener('statechange', () => {
        // suspended by the browser (not by us) while playing: try again, else wait for a tap
        if (ctx.state === 'suspended' && !pausedByUs && !video.paused) {
          ctx.resume().catch(() => {});
        }
        emit();
      });
    }
    if (ctx.state !== 'running' && !video.paused) {
      await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 400))]);
    }
    return ctx;
  }

  async function ensureNode() {
    if (node) return node;
    if (!nodePromise) {
      nodePromise = (async () => {
        if (!moduleLoaded) {
          await ctx.audioWorklet.addModule(new URL(workletUrl, location.href).href);
          moduleLoaded = true;
        }
        const n = new AudioWorkletNode(ctx, 'sap-fx', toPage({
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCountMode: 'max',
          channelInterpretation: 'speakers',
          processorOptions: { params: params() }
        }));
        n.port.onmessage = (e) => { lastState = e.data; emit(); };
        if (reporting) n.port.postMessage(toPage({ report: true }));
        node = n;
        return n;
      })().finally(() => { nodePromise = null; });
    }
    return nodePromise;
  }

  function waitForGesture() {
    if (waitingForGesture) return;
    waitingForGesture = true;
    const retry = () => {
      document.removeEventListener('pointerdown', retry, true);
      document.removeEventListener('keydown', retry, true);
      video.removeEventListener('play', retry);
      waitingForGesture = false;
      if (ctx) ctx.resume().catch(() => {}).finally(() => apply());
      else apply();
    };
    document.addEventListener('pointerdown', retry, true);
    document.addEventListener('keydown', retry, true);
    video.addEventListener('play', retry);
  }

  let applying = Promise.resolve();
  function apply() {
    applying = applying.then(applyNow, applyNow);
    return applying;
  }
  async function applyNow() {
    try {
      if (!wanted()) {
        if (source) {
          // straight to the output; the worklet is dropped (no processing at all)
          if (node) {
            source.disconnect();
            node.disconnect();
            node.port.postMessage(toPage({ end: true }));
            node = null;
            source.connect(ctx.destination);
          }
          mode = 'bypass';
        } else {
          mode = 'off';
        }
        lastState = null;
        return;
      }
      if (!source) {
        if (!canRead(video)) {
          mode = 'unreadable';
          return;
        }
        await ensureContext();
        if (ctx.state !== 'running') {
          // routing now would silence the video: keep the browser's own audio until a tap/play
          mode = 'waiting';
          waitForGesture();
          return;
        }
        source = ctx.createMediaElementSource(video);
        source.connect(ctx.destination); // never silent, even if the worklet fails to load
        if (video.paused) onPause();
      }
      const n = await ensureNode();
      n.port.postMessage(toPage({ params: params() }));
      if (mode !== 'active') {
        source.disconnect();
        source.connect(n);
        n.connect(ctx.destination);
      }
      mode = 'active';
      errorText = '';
    } catch (e) {
      console.warn('[audio] effects unavailable:', e);
      errorText = String((e && e.message) || e);
      mode = 'error';
      if (source && ctx) {
        try { source.disconnect(); source.connect(ctx.destination); } catch { /* already */ }
      }
    } finally {
      emit();
    }
  }

  // Pause → suspend the context after a moment (no audio thread work while paused)
  const onPause = () => {
    clearTimeout(suspendTimer);
    if (!ctx) return;
    suspendTimer = setTimeout(() => {
      if (ctx && video.paused && ctx.state === 'running') {
        pausedByUs = true;
        ctx.suspend().catch(() => {});
      }
    }, 1500);
  };
  const onPlay = () => {
    clearTimeout(suspendTimer);
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {}).finally(() => { pausedByUs = false; emit(); });
    } else pausedByUs = false;
  };
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onPause);
  video.addEventListener('play', onPlay);
  video.addEventListener('playing', onPlay);
  // a new source (e.g. the local copy of a fully loaded file) may make the audio readable
  video.addEventListener('loadedmetadata', () => { if (mode === 'unreadable' || mode === 'off') apply(); });

  // Changes from the popup or another player tab
  const st = storageApi();
  if (st && st.storage.onChanged) {
    st.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[AUDIO_KEY]) return;
      const next = changes[AUDIO_KEY].newValue;
      if (!next || JSON.stringify(next) === lastWritten) return;
      settings = normalizeSettings(next);
      touched = true;
      apply();
    });
  }

  const api = {
    get settings() { return settings; },
    status() {
      const p = params();
      return {
        mode,
        settings,
        params: p,
        active: mode === 'active',
        wanted: enabled && !isNeutral(p),
        presetName: presetLabel(settings),
        state: lastState,
        contextState: ctx ? ctx.state : 'none',
        latency: ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0,
        error: errorText
      };
    },
    // partial: { preset?, boost?, mono?, edits?, presets? } (the operations in audio-presets.mjs)
    set(partial, { quiet = false } = {}) {
      touched = true;
      settings = normalizeSettings({ ...settings, ...partial });
      save();
      const done = apply();
      if (!quiet) emit();
      return done;
    },
    setEnabled(on) {
      enabled = !!on;
      return apply();
    },
    // try again (the element's audio may have become readable)
    refresh: () => apply(),
    setPreset(name) {
      return api.set(selectPreset(name));
    },
    cyclePreset() {
      const next = nextPreset(settings);
      api.setPreset(next);
      notify(`Audio: ${presetName(settings, next)}`);
    },
    boostBy(delta) {
      const boost = Math.min(2, Math.max(1, Math.round((settings.boost + delta) * 20) / 20));
      api.set({ boost });
      notify(`Volume boost ${Math.round(boost * 100)}%`);
    },
    report(on) {
      reporting = !!on;
      if (node) node.port.postMessage(toPage({ report: reporting }));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Test hook: output level (and input level) over `ms`, measured with analysers tapped off
    // the graph (not connected to the speakers)
    async measure(ms = 1000) {
      if (!ctx || !source) return null;
      const tap = (from) => {
        const a = ctx.createAnalyser();
        a.fftSize = 2048;
        from.connect(a);
        return a;
      };
      const ain = tap(source);
      const aout = tap(node || source);
      const buf = new Float32Array(2048);
      const acc = { in: { sum: 0, n: 0, peak: 0 }, out: { sum: 0, n: 0, peak: 0 } };
      const read = (a, o) => {
        a.getFloatTimeDomainData(buf);
        for (const x of buf) { o.sum += x * x; o.n++; if (Math.abs(x) > o.peak) o.peak = Math.abs(x); }
      };
      const end = performance.now() + ms;
      while (performance.now() < end) {
        await new Promise(r => setTimeout(r, 40));
        read(ain, acc.in);
        read(aout, acc.out);
      }
      ain.disconnect();
      aout.disconnect();
      const fin = o => ({ rms: Math.sqrt(o.sum / Math.max(1, o.n)), peak: o.peak });
      return { in: fin(acc.in), out: fin(acc.out), mode };
    },
    // a choice made before the saved settings arrive wins over them
    ready: loadAudioSettings().then((s) => { if (!touched) settings = s; return apply(); })
  };
  return api;
}
