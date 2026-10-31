// Browser tests for the Chromium build. Loads a staged copy of the extension with the Chrome
// manifest (tests/e2e/stage.js). Needs a headed browser: run under xvfb on Linux CI.
//   npm run test:e2e                 local site only, no internet
//   E2E_NETWORK=1 npm run test:e2e   also plays real public HLS/DASH streams
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { startServer, ORIGIN } = require('./server');

const { stageExtension } = require('./stage');

let EXT; // staged copy with the Chrome manifest (set in before())
const NETWORK = process.env.E2E_NETWORK === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ctx, sw, extId, site, profileDir;

async function until(fn, { timeout = 10000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

const readItems = page => page.$$eval('.stream-item', els => els.map(e => ({
  name: e.querySelector('.stream-name').textContent,
  quality: (e.querySelector('.quality-badge') || {}).textContent || '',
  duration: (e.querySelector('.duration-badge') || {}).textContent || '',
  subs: (e.querySelector('.sub-badge') || {}).textContent || '',
  variants: [...e.querySelectorAll('.v-quality option')].map(o => o.textContent),
  url: e.dataset.url
})));

async function openSite(route, { settle = 0 } = {}) {
  const page = await ctx.newPage();
  await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded' });
  if (settle) await sleep(settle);
  return page;
}

async function setSettings(partial) {
  await sw.evaluate(async (s) => {
    const r = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(r.settings || {}), ...s } });
  }, partial);
  await sleep(300);
}

const tabIdOf = page => sw.evaluate(async (u) => (await chrome.tabs.query({})).find(t => t.url === u).id, page.url());

before(async () => {
  site = await startServer();
  EXT = stageExtension('chrome');
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-e2e-'));
  const headless = process.env.HEADLESS === '1';
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: headless ? 'chromium' : undefined,
    headless,
    permissions: ['clipboard-read', 'clipboard-write'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  extId = sw.url().split('/')[2];
});

after(async () => {
  if (ctx) await ctx.close();
  if (site) site.server.close();
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  if (EXT) fs.rmSync(EXT, { recursive: true, force: true });
});

// ── detection ────────────────────────────────────────────────────────────────

test('detects an m3u8 fetched at page load (first tab after start, then repeated)', async () => {
  for (let i = 0; i < 3; i++) {
    const page = await openSite(`/p/early?n=${i}`);
    const items = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
    assert.ok(items && items.length === 1, `round ${i}: expected 1 stream, got ${JSON.stringify(items)}`);
    assert.equal(items[0].duration, '0:10');
    await page.close();
  }
});

test('detects <video src> and parses quality from the URL', async () => {
  const page = await openSite('/p/video');
  const items = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
  assert.equal(items[0].quality, '1080p');
  await page.close();
});

test('keeps a standalone .ts stream', async () => {
  const page = await openSite('/p/ts-only');
  const items = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
  assert.equal(items.length, 1);
  assert.match(items[0].name, /\(ts\)/);
  await page.close();
});

test('hides .ts segments that belong to a detected playlist (separate host too)', async () => {
  const page = await openSite('/p/segments');
  await until(async () => (await readItems(page)).length >= 1);
  await sleep(2500); // segments are requested 300 ms after the playlist
  const items = await readItems(page);
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.match(items[0].name, /\(m3u8\)/);
  await page.close();
});

test('removes .ts segments that arrived before their playlist', async () => {
  const page = await openSite('/p/ts-before-playlist');
  await until(async () => (await readItems(page)).length >= 1);
  await sleep(2500);
  const items = await readItems(page);
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.match(items[0].name, /\(m3u8\)/);
  await page.close();
});

test('master playlist: real quality, variants and duration', async () => {
  const page = await openSite('/p/master');
  const items = await until(async () => {
    const r = await readItems(page);
    return r.length && r[0].variants.length && r[0].duration ? r : null;
  });
  assert.ok(items, 'variants/duration never arrived');
  assert.equal(items[0].quality, '1080p');
  assert.deepEqual(items[0].variants, ['Auto', '1080p', '720p', '480p']);
  assert.equal(items[0].duration, '1:00');
  await page.close();
});

test('MPD: quality and duration from the manifest', async () => {
  const page = await openSite('/p/dash');
  const items = await until(async () => {
    const r = await readItems(page);
    return r.length && r[0].duration ? r : null;
  });
  assert.equal(items[0].quality, '1080p');
  assert.equal(items[0].duration, '1:30');
  await page.close();
});

test('navigating to a new page clears the previous page streams and badge', async () => {
  const page = await openSite('/p/video');
  await until(async () => (await readItems(page)).length === 1);
  const tabId = await tabIdOf(page);
  assert.equal(await sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '1');
  await page.goto(ORIGIN + '/p/blank');
  await sleep(1500);
  const stored = await sw.evaluate(async id => ((await chrome.storage.local.get('detectedStreams')).detectedStreams || []).find(e => e[0] === id), tabId);
  assert.ok(!stored || stored[1].length === 0, 'old streams still stored');
  assert.equal(await sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '');
  await page.close();
});

// ── subtitles ────────────────────────────────────────────────────────────────

test('collects <track> and network subtitles and shows a CC badge', async () => {
  const page = await openSite('/p/subs');
  const items = await until(async () => {
    const r = await readItems(page);
    return r.length && r[0].subs === 'CC 2' ? r : null;
  });
  assert.ok(items, 'CC 2 badge never appeared');
  await page.close();
});

test('web player opens the Shaka page with subs when subtitles exist (even if Vidstack is chosen)', async () => {
  await setSettings({ webPlayerEngine: 'vidstack' });
  const page = await openSite('/p/subs');
  await until(async () => (await readItems(page)).length && (await page.$('.sub-badge')));
  await page.click('#video-handler-button');
  const [player] = await Promise.all([ctx.waitForEvent('page'), page.click('.v-action-play')]);
  await until(() => player.url().includes('player-shaka.html'));
  assert.match(player.url(), /player-shaka\.html/);
  const subs = JSON.parse(new URL(player.url()).searchParams.get('subs'));
  assert.equal(subs.length, 2);
  await player.close();
  await page.close();
});

// ── header forwarding ────────────────────────────────────────────────────────

test('captures the page Referer / User-Agent on the stream', async () => {
  const page = await openSite('/p/secure');
  await until(async () => (await readItems(page)).length === 1);
  const tabId = await tabIdOf(page);
  const stream = await sw.evaluate(async id => ((await chrome.storage.local.get('detectedStreams')).detectedStreams.find(e => e[0] === id) || [0, []])[1][0], tabId);
  assert.equal(stream.headers.referer, `${ORIGIN}/p/secure`);
  assert.ok(stream.headers.userAgent.length > 10);
  await page.close();
});

test('built-in web player sends the page Referer to the CDN (declarativeNetRequest rule)', async () => {
  await setSettings({ webPlayerEngine: 'shaka' });
  site.log.secureReferers.length = 0;
  const page = await openSite('/p/secure');
  await until(async () => (await readItems(page)).length === 1);
  site.log.secureReferers.length = 0; // forget the page's own request
  await page.click('#video-handler-button');
  const [player] = await Promise.all([ctx.waitForEvent('page'), page.click('.v-action-play')]);
  await until(() => site.log.secureReferers.length > 0, { timeout: 15000 });
  assert.ok(site.log.secureReferers.length > 0, 'player never requested the playlist');
  assert.equal(site.log.secureReferers[0], `${ORIGIN}/p/secure`, 'Referer was not rewritten');
  await player.close();
  await page.close();
});

test('native launch command carries referrer, user agent, title (mpv preset) and subtitles', async () => {
  await setSettings({ externalPlayerPath: 'C:\\Tools\\mpv.exe', nativeArgsTemplate: '' });
  const page = await openSite('/p/subs');
  await until(async () => (await readItems(page)).length && (await page.$('.sub-badge')));
  const tabId = await tabIdOf(page);
  const cmd = await sw.evaluate(async (id) => buildNativeCommand(await buildContext(id, 'http://localhost:8099/media/clip_720p.mp4', 'http://localhost:8099/media/clip_720p.mp4')), tabId);
  assert.equal(cmd[0], 'C:\\Tools\\mpv.exe');
  assert.ok(cmd.includes(`--referrer=${ORIGIN}/p/subs`), JSON.stringify(cmd));
  assert.ok(cmd.some(a => a.startsWith('--user-agent=')));
  assert.ok(cmd.includes('--force-media-title=Subs'));
  assert.equal(cmd.filter(a => a.startsWith('--sub-file=')).length, 2);
  assert.ok(!cmd.some(a => a.includes('Cookie')), 'cookies must not be forwarded by default');
  assert.equal(cmd[cmd.length - 1], 'http://localhost:8099/media/clip_720p.mp4');

  await setSettings({ externalPlayerPath: 'C:\\Tools\\vlc.exe' });
  const vlc = await sw.evaluate(async (id) => buildNativeCommand(await buildContext(id, 'http://x/y.mp4', 'http://x/y.mp4')), tabId);
  assert.ok(vlc.includes(`--http-referrer=${ORIGIN}/p/subs`), JSON.stringify(vlc));

  await setSettings({ nativeArgsTemplate: '--custom "{title}" {url}' });
  const real = 'http://localhost:8099/media/clip_720p.mp4';
  const custom = await sw.evaluate(async ([id, u]) => buildNativeCommand(await buildContext(id, u, u)), [tabId, real]);
  assert.deepEqual(custom.slice(1), ['--custom', 'Subs', real]);
  await setSettings({ externalPlayerPath: '', nativeArgsTemplate: '' });
  await page.close();
});

// ── players ──────────────────────────────────────────────────────────────────

test('DASH streams are routed to the Shaka page (button and direct Vidstack link)', async () => {
  await setSettings({ webPlayerEngine: 'vidstack' });
  const page = await openSite('/p/dash');
  await until(async () => (await readItems(page)).length === 1);
  await page.click('#video-handler-button');
  const [player] = await Promise.all([ctx.waitForEvent('page'), page.click('.v-action-play')]);
  await until(() => player.url().includes('player-shaka.html'));
  assert.match(player.url(), /player-shaka\.html/);
  await player.close();

  const direct = await ctx.newPage();
  await direct.goto(`chrome-extension://${extId}/player.html?url=${encodeURIComponent('http://example.com/a.mpd')}`);
  await until(() => direct.url().includes('player-shaka.html'));
  assert.match(direct.url(), /player-shaka\.html\?url=/);
  await direct.close();
  await page.close();
});

test('popup lists the streams of a tab', async () => {
  const page = await openSite('/p/master');
  await until(async () => { const r = await readItems(page); return r.length && r[0].variants.length; });
  const tabId = await tabIdOf(page);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await popup.waitForSelector('.stream-row');
  assert.equal(await popup.locator('.stream-row').count(), 1);
  assert.equal(await popup.locator('.stream-row .badge.quality').textContent(), '1080p');
  assert.equal(await popup.locator('.stream-row select option').count(), 4);
  await popup.click('.row-btn[title="Copy URL"]');
  await sleep(300);
  assert.match(await popup.evaluate(() => navigator.clipboard.readText()), /master\.m3u8$/);
  await popup.close();
  await page.close();
});

test('selecting a quality variant changes the URL that is copied', async () => {
  const page = await openSite('/p/master');
  await until(async () => { const r = await readItems(page); return r.length && r[0].variants.length; });
  await page.click('#video-handler-button');
  await page.selectOption('.v-quality', { label: '720p' });
  await page.click('.v-action-copy');
  await sleep(300);
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /v720\/index\.m3u8$/);
  await page.close();
});

// ── settings ─────────────────────────────────────────────────────────────────

test('settings: blacklist, enabled, cleanNames and maxStreams', async () => {
  await setSettings({ blacklist: ['localhost'] });
  let page = await openSite('/p/video', { settle: 3000 });
  assert.equal((await readItems(page)).length, 0, 'blacklisted site still detected');
  await page.close();

  await setSettings({ blacklist: [], enabled: false });
  page = await openSite('/p/video', { settle: 3000 });
  assert.equal((await readItems(page)).length, 0, 'disabled extension still detected');
  await page.close();

  await setSettings({ enabled: true, cleanNames: false });
  page = await openSite('/p/early?raw', {});
  const raw = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
  assert.equal(raw[0].name, 'early.m3u8');
  await page.close();

  await setSettings({ cleanNames: true, maxStreams: 1 });
  page = await openSite('/p/early?cap', {});
  await until(async () => (await readItems(page)).length === 1);
  await page.evaluate(() => { fetch('/hls/early.m3u8?a=1'); fetch('/master/master.m3u8'); });
  await sleep(2500);
  assert.equal((await readItems(page)).length, 1);
  await page.close();
  await setSettings({ maxStreams: 50 });
});

test('external player errors are reported (native without permission, VLC HTTP down)', async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await setSettings({ desktopExternalMethod: 'native' });
  const native = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'openExternalPlayer', url: 'http://localhost:8099/media/a.mp4' }));
  assert.equal(native.success, false);
  assert.match(native.error, /nativeMessaging permission/);
  await setSettings({ desktopExternalMethod: 'vlc_http', vlcHttpPassword: 'x' });
  const vlc = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'openExternalPlayer', url: 'http://localhost:8099/media/a.mp4' }));
  assert.equal(vlc.success, false);
  await setSettings({ desktopExternalMethod: 'protocol' });
  await popup.close();
});

// ── floating button ──────────────────────────────────────────────────────────

const resetLayout = () => sw.evaluate(() => chrome.storage.local.remove('buttonLayout'));
const layoutOf = () => sw.evaluate(async () => (await chrome.storage.local.get('buttonLayout')).buttonLayout);

async function pageWithButton(route = '/p/video') {
  const page = await openSite(route);
  await page.locator('#video-handler-button').waitFor({ state: 'visible', timeout: 10000 });
  return page;
}

test('button: drag moves it, snaps to a side, remembers the spot per site and survives a reload', async () => {
  await resetLayout();
  const page = await pageWithButton();
  const box = await page.locator('#video-handler-button').boundingBox();
  assert.ok(box.x > 1100 && box.y > 600, 'starts in the bottom-right corner');
  await page.mouse.move(box.x + 24, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 8 });
  await page.mouse.move(60, 150, { steps: 8 });
  await page.mouse.up();
  await sleep(300);

  const layout = await layoutOf();
  assert.equal(layout.sites.localhost.side, 'left');
  assert.ok(layout.sites.localhost.yRatio > 0.1 && layout.sites.localhost.yRatio < 0.35, JSON.stringify(layout));
  assert.equal(await page.locator('#video-handler-menu').isVisible(), false, 'ending a drag must not open the menu');
  const moved = await page.locator('#video-handler-button').boundingBox();
  assert.ok(moved.x < 100 && moved.y < 250, `snapped to the left edge: ${JSON.stringify(moved)}`);

  await page.reload();
  await page.locator('#video-handler-button').waitFor({ state: 'visible', timeout: 10000 });
  const again = await page.locator('#video-handler-button').boundingBox();
  assert.ok(again.x < 100, 'position restored after reload');
  await resetLayout();
  await page.close();
});

test('button: a plain click still toggles the menu', async () => {
  await resetLayout();
  const page = await pageWithButton();
  await page.click('#video-handler-button');
  assert.equal(await page.locator('#video-handler-menu').isVisible(), true);
  await sleep(350);
  await page.click('#video-handler-button');
  assert.equal(await page.locator('#video-handler-menu').isVisible(), false);
  await page.close();
});

test('button: the menu opens fully inside the viewport from all four corners', async () => {
  const page = await pageWithButton();
  const vp = page.viewportSize();
  for (const [side, yRatio] of [['left', 0], ['right', 0], ['left', 1], ['right', 1]]) {
    await sw.evaluate(l => chrome.storage.local.set({ buttonLayout: { global: l, sites: {} } }), { side, yRatio });
    await sleep(400);
    await page.click('#video-handler-button');
    const m = await page.locator('#video-handler-menu').boundingBox();
    assert.ok(m, `${side}/${yRatio}: menu not visible`);
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.width <= vp.width && m.y + m.height <= vp.height, `${side}/${yRatio}: menu outside viewport ${JSON.stringify(m)}`);
    await sleep(350);
    await page.click('#video-handler-button');
    await sleep(350);
  }
  await resetLayout();
  await page.close();
});

test('button: popup corner select and reset change the position', async () => {
  await resetLayout();
  const page = await pageWithButton();
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.selectOption('#button-corner', 'top-left');
  await sleep(500);
  const box = await page.locator('#video-handler-button').boundingBox();
  assert.ok(box.x < 100 && box.y < 100, `top-left applied live: ${JSON.stringify(box)}`);
  await popup.click('#reset-button-position');
  await sleep(500);
  const back = await page.locator('#video-handler-button').boundingBox();
  assert.ok(back.x > 1100 && back.y > 600, `reset to bottom-right: ${JSON.stringify(back)}`);
  assert.deepEqual(await layoutOf(), { global: { side: 'right', yRatio: 1 }, sites: {} });
  await popup.close();
  await page.close();
});

test('button: visibility "never" hides it, "fade" dims it when idle and wakes on hover', async () => {
  await setSettings({ buttonVisibility: 'never' });
  let page = await openSite('/p/video', { settle: 3000 });
  assert.equal(await page.locator('#video-handler-button').isVisible(), false, 'never');
  await page.close();

  await setSettings({ buttonVisibility: 'fade' });
  page = await pageWithButton();
  const faded = () => page.evaluate(() => document.getElementById('video-handler-button').classList.contains('v-faded'));
  assert.equal(await faded(), false, 'awake at first');
  await sleep(3600);
  assert.equal(await faded(), true, 'faded after idle');
  await page.hover('#video-handler-button');
  assert.equal(await faded(), false, 'wakes on hover');
  await page.close();
  await setSettings({ buttonVisibility: 'always' });
});

test('button: hidden while an element is fullscreen', async () => {
  const page = await pageWithButton();
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'fs-test';
    b.textContent = 'fs';
    b.onclick = () => document.documentElement.requestFullscreen();
    document.body.appendChild(b);
  });
  await page.click('#fs-test');
  await until(() => page.evaluate(() => !!document.fullscreenElement));
  await sleep(300);
  const display = () => page.evaluate(() => document.getElementById('video-handler-button').style.display);
  assert.equal(await display(), 'none');
  await page.evaluate(() => document.exitFullscreen());
  await until(async () => (await display()) === 'flex');
  assert.equal(await display(), 'flex');
  await page.close();
});

// ── real streams (internet) ──────────────────────────────────────────────────

const MUX = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const DASH = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';

for (const [name, file, selector, url] of [
  ['Vidstack HLS', 'player.html', 'video', MUX],
  ['Shaka HLS', 'player-shaka.html', '#video', MUX],
  ['Shaka DASH', 'player-shaka.html', '#video', DASH],
  ['Vidstack link with DASH (redirects to Shaka)', 'player.html', '#video', DASH]
]) {
  test(`plays ${name}`, { skip: !NETWORK && 'set E2E_NETWORK=1' }, async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/${file}?url=${encodeURIComponent(url)}`);
    const ok = await until(() => page.evaluate(s => { const v = document.querySelector(s); return v && v.currentTime > 0.5 && v.videoWidth > 0; }, selector), { timeout: 25000 });
    assert.ok(ok, `${name} did not start playing`);
    await page.close();
  });
}

test('Shaka loads VTT and SRT subtitles passed by the extension', { skip: !NETWORK && 'set E2E_NETWORK=1' }, async () => {
  const subs = [{ url: `${ORIGIN}/subs/en.vtt`, label: 'English', lang: 'en' }, { url: `${ORIGIN}/subs/fr.srt`, label: 'French', lang: 'fr' }];
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/player-shaka.html?url=${encodeURIComponent(MUX)}&subs=${encodeURIComponent(JSON.stringify(subs))}`);
  const tracks = await until(() => page.evaluate(() => window._shakaPlayer && window._shakaPlayer.getTextTracks().length === 2 ? window._shakaPlayer.getTextTracks().map(t => t.label) : null), { timeout: 25000 });
  assert.deepEqual(tracks, ['English', 'French']);
  await until(() => page.evaluate(() => window._shakaPlayer.getTextTracks().some(t => t.active && t.label === 'English')));
  await page.locator('#btn-cc').waitFor({ state: 'visible' });
  await page.keyboard.press('c'); // cycles to the next caption track
  await sleep(300);
  assert.equal(await page.evaluate(() => window._shakaPlayer.getTextTracks().find(t => t.active).label), 'French');
  await page.close();
});
