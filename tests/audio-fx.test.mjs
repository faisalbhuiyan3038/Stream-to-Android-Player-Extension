// Audio effects glue (src/audio-fx.mjs): which videos Web Audio may read, the web-page on/off switch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioReadable, needsCorsUpgrade, createAudioFx } from '../src/audio-fx.mjs';

const page = { protocol: 'https:', href: 'https://site.example/watch', origin: 'https://site.example' };
const extPage = { protocol: 'chrome-extension:', href: 'chrome-extension://id/player.html', origin: 'chrome-extension://id' };
const video = (props) => ({
  crossOrigin: null, currentSrc: '', src: '', ...props,
  hasAttribute(name) { return name === 'crossorigin' && this.crossOrigin != null; }
});

test('web page: only unreadable http(s) media without a CORS mode of its own is reloaded in CORS mode', () => {
  assert.equal(needsCorsUpgrade(video({ currentSrc: 'https://cdn.example/v.mp4' }), page), true);
  assert.equal(needsCorsUpgrade(video({ currentSrc: 'http://cdn.example/live.m3u8' }), page), true); // native HLS
  assert.equal(needsCorsUpgrade(video({ currentSrc: 'https://site.example/v.mp4' }), page), false); // readable already
  assert.equal(needsCorsUpgrade(video({ currentSrc: 'blob:https://site.example/1' }), page), false); // MSE
  assert.equal(needsCorsUpgrade(video({ currentSrc: 'https://cdn.example/v.mp4', crossOrigin: 'use-credentials' }), page), false); // the site's own CORS
  assert.equal(needsCorsUpgrade(video({ currentSrc: 'https://cdn.example/v.mp4', mediaKeys: {} }), page), false); // DRM
  assert.equal(needsCorsUpgrade(video({ srcObject: {} }), page), false);
  assert.equal(needsCorsUpgrade(video({}), page), false);
});

test('web page: own-origin, blob/MSE and CORS videos are readable; other origins and DRM are not', () => {
  assert.equal(audioReadable(video({ currentSrc: 'https://site.example/v.mp4' }), page), true);
  assert.equal(audioReadable(video({ currentSrc: '/v.mp4' }), page), true);
  assert.equal(audioReadable(video({ currentSrc: 'blob:https://site.example/1' }), page), true);
  assert.equal(audioReadable(video({ srcObject: {} }), page), true);
  assert.equal(audioReadable(video({ currentSrc: 'https://cdn.example/v.mp4' }), page), false);
  assert.equal(audioReadable(video({ currentSrc: 'https://cdn.example/v.mp4', crossOrigin: 'anonymous' }), page), true);
  assert.equal(audioReadable(video({ currentSrc: 'blob:https://site.example/1', mediaKeys: {} }), page), false);
  assert.equal(audioReadable(video({}), page), false);
});

test('extension page in Chromium: cross-origin files stay readable (host permissions)', () => {
  assert.equal(audioReadable(video({ currentSrc: 'https://cdn.example/v.mp4' }), extPage), true);
});

test('setEnabled(false) turns the effects off without touching the saved choice', async () => {
  const fake = { addEventListener() {}, paused: true, currentSrc: '', src: '' };
  const fx = createAudioFx(fake);
  await fx.ready;
  fx.set({ preset: 'night' }, { quiet: true });
  assert.equal(fx.status().wanted, true);
  await fx.setEnabled(false);
  assert.equal(fx.status().wanted, false);
  assert.equal(fx.status().mode, 'off');
  assert.equal(fx.settings.preset, 'night');
  await fx.setEnabled(true);
  assert.equal(fx.status().mode, 'unreadable'); // no source: nothing is routed
});
