// Offscreen document (Chromium only): "Process whole tab" from the popup's Audio tab. The
// captured tab's audio (chrome.tabCapture stream id from the popup, via background.js) goes
// through the same AudioWorklet as everywhere else and out to the speakers. A captured tab is
// muted by Chrome, so the stream is always played back, straight through while the settings are
// neutral. Used for what the page's own Web Audio can't read: DRM, a site's own audio graph.
// Offscreen documents only have chrome.runtime: the background sends the `audioFx` settings.
import { normalizeSettings } from './audio-presets.mjs';
import { resolveParams, isNeutral } from './audio-dsp.mjs';

const graphs = new Map(); // tabId → { ctx, stream, source, node }
let settings = normalizeSettings();

function route(g) {
  const params = resolveParams(settings);
  const fx = !isNeutral(params);
  g.node.port.postMessage({ params });
  if (g.fx === fx) return;
  g.source.disconnect();
  g.node.disconnect();
  if (fx) {
    g.source.connect(g.node);
    g.node.connect(g.ctx.destination);
  } else {
    g.source.connect(g.ctx.destination);
  }
  g.fx = fx;
}

async function start(tabId, streamId) {
  stop(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  try {
    await ctx.audioWorklet.addModule('audio-worklet.bundle.js');
    const node = new AudioWorkletNode(ctx, 'sap-fx', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      processorOptions: { params: resolveParams(settings) }
    });
    const g = { ctx, stream, source: ctx.createMediaStreamSource(stream), node, fx: null };
    graphs.set(tabId, g);
    route(g);
    await ctx.resume();
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    ctx.close().catch(() => {});
    graphs.delete(tabId);
    throw e;
  }
  for (const t of stream.getAudioTracks()) {
    t.addEventListener('ended', () => {
      stop(tabId);
      chrome.runtime.sendMessage({ type: 'audioCaptureEnded', tabId }).catch(() => {});
    });
  }
}

function stop(tabId) {
  const g = graphs.get(tabId);
  if (!g) return;
  graphs.delete(tabId);
  for (const t of g.stream.getTracks()) t.stop(); // the tab plays its own audio again
  g.node.port.postMessage({ end: true });
  g.ctx.close().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'offscreenAudioSettings' || (msg.type === 'offscreenCaptureStart' && msg.settings)) {
    settings = normalizeSettings(msg.settings);
    for (const g of graphs.values()) route(g);
  }
  if (msg.type === 'offscreenCaptureStart') {
    start(msg.tabId, msg.streamId).then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'offscreenCaptureStop') {
    stop(msg.tabId);
    sendResponse({ ok: true });
  }
  return false;
});
