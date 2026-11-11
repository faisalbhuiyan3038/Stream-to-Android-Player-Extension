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

test('web player keeps the chosen engine (Vidstack) and passes the subtitles with language labels', async () => {
  await setSettings({ webPlayerEngine: 'vidstack' });
  const page = await openSite('/p/subs');
  await until(async () => (await readItems(page)).length && (await page.$('.sub-badge')));
  await page.click('#video-handler-button');
  const [player] = await Promise.all([ctx.waitForEvent('page'), page.click('.v-action-play')]);
  await until(() => player.url().includes('player.html'));
  assert.match(player.url(), /\/player\.html\?/);
  const subs = JSON.parse(new URL(player.url()).searchParams.get('subs'));
  assert.equal(subs.length, 2);
  // <track label="English"> keeps its label; fr.srt gets its language from the file name
  assert.deepEqual(subs.map(s => `${s.lang}|${s.label}`).sort(), ['en|English', 'fr|French']);
  await player.close();
  await page.close();
});

// Both web players convert SRT (Windows-1252), ASS and TTML to WebVTT and attach them.
const SUBS_MIX = [
  { url: `${ORIGIN}/subs/cp1252.srt`, label: 'SRT', lang: 'fr' },
  { url: `${ORIGIN}/subs/styled.ass`, label: 'ASS', lang: 'en' },
  { url: `${ORIGIN}/subs/caps.ttml`, label: 'TTML', lang: 'de' }
];
const subsQuery = () => `url=${encodeURIComponent(ORIGIN + '/media/real.webm')}&subs=${encodeURIComponent(JSON.stringify(SUBS_MIX))}`;
const readStatus = page => page.evaluate(() => (window._subtitleStatus || []).map(s => `${s.label}:${s.format}:${s.via}`));

test('Vidstack page: SRT (cp1252), ASS and TTML subtitles are converted and loaded', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/player.html?${subsQuery()}`);
  const done = await until(async () => { const s = await readStatus(page); return s.length === 3 && !s.some(x => x.endsWith(':pending')); }, { timeout: 20000 });
  assert.ok(done, `subtitles never processed: ${JSON.stringify(await readStatus(page))}`);
  assert.deepEqual(await readStatus(page), ['SRT:srt:converted', 'ASS:ass:converted', 'TTML:ttml:converted']);
  const tracks = await page.evaluate(() => document.querySelector('media-player').textTracks.toArray().map(t => `${t.label}|${t.language}`));
  assert.deepEqual(tracks, ['SRT|fr', 'ASS|en', 'TTML|de']);
  const firstCue = await until(() => page.evaluate(() => {
    const t = document.querySelector('media-player').textTracks.toArray()[0];
    return t && t.cues.length ? t.cues[0].text : null;
  }), { timeout: 10000 });
  assert.equal(firstCue, 'Café “quoted”');
  await page.close();
});

test('Shaka page: SRT (cp1252), ASS and TTML subtitles are converted and loaded', async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/player-shaka.html?${subsQuery()}`);
  const done = await until(async () => { const s = await readStatus(page); return s.length === 3 && !s.some(x => x.endsWith(':pending')); }, { timeout: 20000 });
  assert.ok(done, `subtitles never processed: ${JSON.stringify(await readStatus(page))}`);
  await until(async () => (await readStatus(page)).every(s => !s.endsWith(':failed')), { timeout: 10000 });
  assert.deepEqual(await readStatus(page), ['SRT:srt:converted', 'ASS:ass:converted', 'TTML:ttml:converted']);
  const labels = await page.evaluate(() => window._shakaPlayer.getTextTracks().map(t => t.label));
  assert.deepEqual(labels, ['SRT', 'ASS', 'TTML']);
  // The first track is shown. Shaka UI draws cues in its own container for HLS/DASH; for a plain
  // file (src= mode, as here) it keeps the browser's native text track. Accept either.
  const cue = await until(() => page.evaluate(() => {
    const box = document.querySelector('.shaka-text-container');
    if (box && box.textContent.trim()) return box.textContent.trim();
    for (const tt of document.getElementById('video').textTracks) {
      if (tt.mode === 'showing' && tt.cues && tt.cues.length) return tt.cues[0].text;
    }
    return null;
  }), { timeout: 10000 });
  assert.equal(cue, 'Café “quoted”');
  // only the selected track is drawn (src= mode used to show every track at once)
  const drawn = await page.evaluate(() => [...document.getElementById('video').textTracks].filter(t => t.mode !== 'disabled').map(t => t.label));
  assert.deepEqual(drawn, ['SRT']);
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

test('duration of a playlist that needs the page Referer (analysis request carries it)', async () => {
  site.log.secureReferers.length = 0;
  const page = await openSite('/p/secure');
  const items = await until(async () => { const r = await readItems(page); return r.length === 1 && r[0].duration ? r : null; });
  assert.ok(items, `no duration: ${JSON.stringify(await readItems(page))} referers ${JSON.stringify(site.log.secureReferers)}`);
  assert.equal(items[0].duration, '0:05');
  // the page's request and the background's, both with the page as Referer; the rule is gone after
  assert.ok(site.log.secureReferers.length >= 2 && site.log.secureReferers.every(r => r === `${ORIGIN}/p/secure`), JSON.stringify(site.log.secureReferers));
  const left = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).filter(r => r.id >= 1900000000).length);
  assert.equal(left, 0);
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

// ── phase 1: detection signals, patterns, titles ────────────────────────────

const readSubtitles = page => page.$$eval('.stream-item .stream-subtitle', els => els.map(e => e.textContent));

test('error responses are not listed as streams', async () => {
  const page = await openSite('/p/missing', { settle: 3000 });
  assert.equal((await readItems(page)).length, 0);
  await page.close();
});

test('a stream URL carried in a .php query string is detected', async () => {
  const page = await openSite('/p/proxied');
  const items = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
  assert.ok(items, 'proxied stream not detected');
  assert.match(items[0].url, /proxy\.php\?u=/);
  assert.match(items[0].name, /\(m3u8\)/);
  await page.close();
});

test('"media" requests are detected without a stream-like URL or content type', async () => {
  const page = await openSite('/p/media');
  const items = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
  assert.ok(items, 'media request not detected');
  assert.match(items[0].url, /\/get\?id=7$/);
  await page.close();
});

test('custom detection patterns make an unrecognised URL a stream (and the popup validates them)', async () => {
  let page = await openSite('/p/custom', { settle: 2500 });
  assert.equal((await readItems(page)).length, 0, 'detected without the pattern');
  await page.close();

  await setSettings({ customPatterns: 'm3u8 /\\/api\\/play\\/\\d+/' });
  page = await openSite('/p/custom');
  const items = await until(async () => { const r = await readItems(page); return r.length ? r : null; });
  assert.ok(items, 'pattern did not match');
  assert.match(items[0].name, /\(m3u8\)/);
  await page.close();

  // popup: live validation and saving
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  assert.ok(await until(async () => /api/.test(await popup.inputValue('#custom-patterns'))), 'saved patterns not shown');
  // the status line is filled once the popup has finished starting
  await until(async () => /OK/.test(await popup.textContent('#custom-patterns-status')));
  await popup.fill('#custom-patterns', 'm3u8 /ok/\nbogus /x/\nvideo /([/');
  const status = await popup.textContent('#custom-patterns-status');
  assert.match(status, /Line 2: Unknown type/);
  assert.match(status, /Line 3: Invalid regular expression/);
  await popup.fill('#custom-patterns', 'video /\\/get_file\\//');
  await popup.fill('#blacklist', 'ads.com\n~([');
  assert.match(await popup.textContent('#domain-list-error'), /not a valid rule/);
  await popup.click('#save-lists');
  await sleep(400);
  const saved = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.equal(saved.customPatterns, 'video /\\/get_file\\//');
  assert.deepEqual(saved.blacklist, ['ads.com', '~([']);
  await popup.close();
  await setSettings({ customPatterns: '', blacklist: [] });
});

test('page titles are cleaned for the list, and updated when the title changes later', async () => {
  let page = await openSite('/p/titled');
  await until(async () => (await readSubtitles(page)).length > 0);
  assert.deepEqual(await readSubtitles(page), ['Dark Matter S01E05']);
  await page.close();

  page = await openSite('/p/late-title');
  await until(async () => (await readItems(page)).length === 1);
  const better = await until(async () => (await readSubtitles(page))[0] === 'Big Buck Bunny (2008)', { timeout: 8000 });
  assert.ok(better, `title never refreshed: ${JSON.stringify(await readSubtitles(page))}`);
  await page.close();
});

test('whitelist/blacklist use whole-label matching', async () => {
  await setSettings({ blacklist: ['host'] }); // "localhost" must not match the label "host"
  let page = await openSite('/p/video');
  assert.equal((await until(async () => { const r = await readItems(page); return r.length ? r : null; }) || []).length, 1);
  await page.close();

  await setSettings({ blacklist: ['example.com', '-localhost'] });
  page = await openSite('/p/video', { settle: 3000 });
  assert.equal((await readItems(page)).length, 0, 'exact rule did not block localhost');
  await page.close();

  await setSettings({ blacklist: ['localhost', '!localhost'] });
  page = await openSite('/p/video');
  assert.equal((await until(async () => { const r = await readItems(page); return r.length ? r : null; }) || []).length, 1, 'exception ignored');
  await page.close();
  await setSettings({ blacklist: [] });
});

// ── phase 3: direct stream links open in the web player ──────────────────────

// Navigates a fresh tab to `url` and returns where it ended up (redirects to extension pages
// abort Playwright's own navigation bookkeeping, so the URL is polled instead).
async function landOn(url, expect) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'commit' }).catch(() => {});
  if (expect) await until(() => expect.test(page.url()), { timeout: 8000 });
  else await sleep(2000);
  return page;
}

test('direct .m3u8 / .mpd links open in the web player when enabled (and only then)', async () => {
  await setSettings({ openStreamLinks: false, openMp4Links: false, webPlayerEngine: 'vidstack' });
  let page = await landOn(`${ORIGIN}/hls/early.m3u8`);
  assert.equal(page.url(), `${ORIGIN}/hls/early.m3u8`, 'redirected while the option is off');
  await page.close();

  await setSettings({ openStreamLinks: true });
  await sleep(500); // dynamic rules are updated asynchronously
  page = await landOn(`${ORIGIN}/hls/early.m3u8?t=1`, /player\.html/);
  assert.equal(page.url(), `chrome-extension://${extId}/player.html#${ORIGIN}/hls/early.m3u8?t=1`);
  // the page really took the URL from its fragment
  const src = await until(() => page.evaluate(() => document.querySelector('media-player').src || null));
  assert.match(JSON.stringify(src), /hls\/early\.m3u8\?t=1/);
  await page.close();

  page = await landOn(`${ORIGIN}/dash/manifest.mpd`, /player-shaka\.html/);
  assert.equal(page.url(), `chrome-extension://${extId}/player-shaka.html#${ORIGIN}/dash/manifest.mpd`);
  await page.close();

  // a page that merely mentions a stream in its query string is left alone
  page = await landOn(`${ORIGIN}/p/blank?next=a.m3u8`);
  assert.equal(page.url(), `${ORIGIN}/p/blank?next=a.m3u8`);
  await page.close();

  // .mp4 only with its own option; then with the Shaka engine
  page = await landOn(`${ORIGIN}/media/clip_720p.mp4`);
  assert.equal(page.url(), `${ORIGIN}/media/clip_720p.mp4`, '.mp4 redirected without its option');
  await page.close();
  await setSettings({ openMp4Links: true, webPlayerEngine: 'shaka' });
  await sleep(500);
  page = await landOn(`${ORIGIN}/media/clip_720p.mp4`, /player-shaka\.html/);
  assert.match(page.url(), /player-shaka\.html#http:\/\/localhost:8099\/media\/clip_720p\.mp4$/);
  await page.close();

  await setSettings({ openStreamLinks: false, openMp4Links: false, webPlayerEngine: 'vidstack' });
  await sleep(500);
  const left = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).map(r => r.id));
  assert.deepEqual(left, []);
});

// ── phase 4: frames, service workers, header rules ──────────────────────────

const streamsOf = tabId => sw.evaluate(async id => ((await chrome.storage.local.get('detectedStreams')).detectedStreams || []).find(e => e[0] === id)?.[1] || [], tabId);

test('a stream inside a cross-origin iframe is found, with the iframe as Referer', async () => {
  const page = await openSite('/p/iframe');
  const tabId = await tabIdOf(page);
  const found = await until(async () => (await streamsOf(tabId)).find(s => s.url.endsWith('/hls/frame.m3u8')), { timeout: 12000 });
  assert.ok(found, 'iframe stream not detected');
  assert.equal(found.headers.referer, 'http://127.0.0.1:8099/p/inner');
  await page.close();
});

test('a playlist fetched by the page\'s service worker is attributed to the tab', async () => {
  const page = await openSite('/p/sw');
  const items = await until(async () => { const r = await readItems(page); return r.find(i => /sw\.m3u8/.test(i.url)) ? r : null; }, { timeout: 12000 });
  assert.ok(items, 'service-worker request not detected');
  await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); });
  await page.close();
});

test('player header rule: cookies forwarded when enabled, rule removed when the tab leaves the player', async () => {
  await setSettings({ webPlayerEngine: 'shaka', forwardCookies: true });
  site.log.cookies.length = 0;
  const page = await openSite('/p/cookie');
  await until(async () => (await readItems(page)).length === 1);
  site.log.cookies.length = 0; // forget the page's own request
  await page.click('#video-handler-button');
  const [player] = await Promise.all([ctx.waitForEvent('page'), page.click('.v-action-play')]);
  await until(() => site.log.cookies.length > 0, { timeout: 15000 });
  assert.ok(site.log.cookies.length > 0, 'player never requested the playlist');
  assert.match(site.log.cookies[0] || '', /sap=yes/, 'Cookie was not forwarded to the player request');

  await until(() => player.url().includes('player-shaka.html'));
  const playerTab = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find(t => t.url === u).id, player.url());
  const ruleIds = () => sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map(r => r.id));
  assert.ok((await ruleIds()).includes(playerTab + 1), 'no header rule while the player is open');
  await player.goto(`${ORIGIN}/p/blank`);
  assert.ok(await until(async () => !(await ruleIds()).includes(playerTab + 1)), 'rule survived navigating away');
  await player.close();
  await page.close();
  await setSettings({ forwardCookies: false });
});

// ── phase 6: faster buffering (parallel segment downloads) ──────────────────

// Highest number of segment requests that were in flight at the same moment
function maxConcurrent(segments) {
  const events = [];
  for (const s of segments) { events.push([s.start, 1]); events.push([s.end || Infinity, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of events) { cur += d; max = Math.max(max, cur); }
  return max;
}

// Opens a player on the throttled HLS fixture and measures how long 20 s of video take to buffer
async function bufferRun(file, enabled) {
  await setSettings({ fastBuffering: enabled, fastBufferingParallel: 4, bufferAheadSeconds: 60 });
  site.log.segments.length = 0;
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`chrome-extension://${extId}/${file}?url=${encodeURIComponent(`${ORIGIN}/slow-hls/index.m3u8`)}`);
  const ok = await until(() => page.evaluate(() => {
    const v = document.querySelector('video');
    return v && v.buffered.length && v.buffered.end(v.buffered.length - 1) >= 20;
  }), { timeout: 30000 });
  const ms = Date.now() - t0;
  const playable = await page.evaluate(() => document.querySelector('video').readyState >= 3);
  const info = { ms, conc: maxConcurrent(site.log.segments), playable, prefetch: await page.evaluate(() => window._prefetch ? window._prefetch.stats : null) };
  await page.close();
  assert.ok(ok, `${file} never buffered 20 s (${JSON.stringify(info)})`);
  return info;
}

test('faster buffering: Vidstack/hls.js loads segments in parallel and buffers sooner on a slow CDN', async (t) => {
  const off = await bufferRun('player.html', false);
  const on = await bufferRun('player.html', true);
  t.diagnostic(`vidstack off: ${off.ms} ms, ${off.conc} at once; on: ${on.ms} ms, ${on.conc} at once, hits ${on.prefetch && on.prefetch.hits}`);
  assert.equal(off.conc, 1, `hls.js alone should load one segment at a time: ${JSON.stringify(off)}`);
  assert.ok(on.conc >= 2, `no parallel downloads: ${JSON.stringify(on)}`);
  assert.ok(on.playable && off.playable, 'video not playable');
  assert.ok(on.prefetch && on.prefetch.hits > 0, `player never used a prefetched segment: ${JSON.stringify(on.prefetch)}`);
  assert.ok(on.ms < off.ms * 0.75, `not faster: on ${on.ms} ms vs off ${off.ms} ms`);
});

test('faster buffering: Shaka prefetches segments in parallel', async (t) => {
  const off = await bufferRun('player-shaka.html', false);
  const on = await bufferRun('player-shaka.html', true);
  t.diagnostic(`shaka off: ${off.ms} ms, ${off.conc} at once; on: ${on.ms} ms, ${on.conc} at once`);
  assert.ok(on.conc > off.conc, `no extra parallelism: on ${on.conc}, off ${off.conc}`);
  assert.ok(on.playable, 'video not playable');
  assert.ok(on.ms < off.ms, `not faster: on ${on.ms} ms vs off ${off.ms} ms`);
  await setSettings({ fastBuffering: true, bufferAheadSeconds: 0 });
});

// ── phase 7: download to MP4 in the browser ──────────────────────────────────

const boxTypes = buf => {
  const out = [];
  for (let p = 0; p + 8 <= buf.length;) {
    const size = buf.readUInt32BE(p);
    out.push(buf.toString('latin1', p + 4, p + 8));
    if (size < 8) break;
    p += size;
  }
  return out;
};

// Opens download.html for `mediaUrl`, presses Download, returns { state, file (Buffer), name }
async function downloadVia(mediaUrl, title = 'Test Clip', extra = '') {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/download.html?url=${encodeURIComponent(mediaUrl)}&title=${encodeURIComponent(title)}${extra}`);
  const ready = await until(() => page.evaluate(() => window._download && ['ready', 'error'].includes(window._download.state) && window._download), { timeout: 20000 });
  assert.equal(ready && ready.state, 'ready', `not ready: ${JSON.stringify(ready)}`);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#start')]);
  const file = path.join(os.tmpdir(), `sap-dl-${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(file);
  const state = await page.evaluate(() => window._download);
  const data = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  await page.close();
  return { state, data, name: download.suggestedFilename() };
}

// Plays a downloaded file in a normal web page: duration, a seek, decoded audio
async function probeMedia(data, type) {
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/p/blank`);
  return await page.evaluate(async ({ b64, type }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([bytes], { type }));
    document.body.appendChild(v);
    await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('media error ' + (v.error && v.error.code))); });
    const duration = v.duration;
    v.currentTime = 15;
    await new Promise(r => { v.onseeked = r; setTimeout(r, 5000); });
    const seekedTo = v.currentTime;
    v.currentTime = 0;
    await v.play().catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    v.pause();
    return { duration, seekedTo, audioBytes: v.webkitAudioDecodedByteCount || 0, videoBytes: v.webkitVideoDecodedByteCount || 0 };
  }, { b64: data.toString('base64'), type }).finally(() => page.close());
}

test('download: fMP4 HLS becomes one seekable MP4 (ftyp, moov, sidx, fragments)', async () => {
  const { state, data, name } = await downloadVia(`${ORIGIN}/hls-real/index.m3u8`, 'Test Clip S01E02');
  assert.equal(state.state, 'done', JSON.stringify(state));
  assert.equal(name, 'Test Clip S01E02.mp4');
  assert.deepEqual(boxTypes(data).slice(0, 3), ['ftyp', 'moov', 'sidx']);
  assert.equal(boxTypes(data).filter(t => t === 'moof').length, 12);
  assert.deepEqual(state.tracks.map(t => t.handler), ['vide']);
  const media = await probeMedia(data, 'video/mp4');
  assert.ok(Math.abs(media.duration - 24) < 1.5, `duration ${media.duration}`);
  assert.ok(Math.abs(media.seekedTo - 15) < 1, `seek landed at ${media.seekedTo}`);
  assert.ok(media.videoBytes > 0, 'no video decoded');
});

test('download: separate audio rendition is merged into the same MP4 (and plays)', async () => {
  const { state, data } = await downloadVia(`${ORIGIN}/hls-real/master.m3u8`);
  assert.equal(state.state, 'done', JSON.stringify(state));
  assert.deepEqual(state.tracks.map(t => t.handler).sort(), ['soun', 'vide']);
  const media = await probeMedia(data, 'video/mp4');
  assert.ok(Math.abs(media.duration - 24) < 1.5, `duration ${media.duration}`);
  assert.ok(media.audioBytes > 0, 'audio was not decoded');
  assert.ok(media.videoBytes > 0, 'video was not decoded');
});

// Text samples of the tx3g tracks of an MP4: { trackId: [texts in file order] }
function tx3gTexts(buf) {
  const boxes = (start, end) => {
    const out = [];
    for (let p = start; p + 8 <= end;) {
      const size = buf.readUInt32BE(p);
      if (size < 8) break;
      out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, end: p + size, body: p + 8 });
      p += size;
    }
    return out;
  };
  const top = boxes(0, buf.length);
  const moov = top.find(b => b.type === 'moov');
  const textIds = boxes(moov.body, moov.end).filter(b => b.type === 'trak').filter(t => {
    const mdia = boxes(t.body, t.end).find(b => b.type === 'mdia');
    const hdlr = boxes(mdia.body, mdia.end).find(b => b.type === 'hdlr');
    return buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) === 'sbtl';
  }).map(t => buf.readUInt32BE(boxes(t.body, t.end).find(b => b.type === 'tkhd').body + 12));
  const texts = Object.fromEntries(textIds.map(id => [id, []]));
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    const traf = boxes(top[i].body, top[i].end).find(b => b.type === 'traf');
    const tfhd = boxes(traf.body, traf.end).find(b => b.type === 'tfhd');
    const id = buf.readUInt32BE(tfhd.body + 4);
    if (!texts[id]) continue;
    const trun = boxes(traf.body, traf.end).find(b => b.type === 'trun');
    const count = buf.readUInt32BE(trun.body + 4);
    let p = top[i].start + buf.readInt32BE(trun.body + 8);
    for (let k = 0; k < count; k++) {
      const size = buf.readUInt32BE(trun.body + 12 + k * 8 + 4);
      const len = buf.readUInt16BE(p);
      if (len) texts[id].push(buf.toString('utf8', p + 2, p + 2 + len));
      p += size;
    }
  }
  return texts;
}

test('download: subtitles go into the MP4 as text tracks (page files + manifest track) and as .srt', async () => {
  const subs = JSON.stringify([{ url: `${ORIGIN}/subs/fr.srt`, label: 'French', lang: 'fr' }, { url: `${ORIGIN}/subs/cp1252.srt`, label: 'Old SRT', lang: '' }]);
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/download.html?url=${encodeURIComponent(`${ORIGIN}/hls-subs/master.m3u8`)}&title=Subbed&subs=${encodeURIComponent(subs)}`);
  const ready = await until(() => page.evaluate(() => window._download && ['ready', 'error'].includes(window._download.state) && window._download), { timeout: 20000 });
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.deepEqual(ready.subtitleChoices.map(c => [c.source, c.label, c.language]),
    [['manifest', 'Deutsch', 'de'], ['file', 'French', 'fr'], ['file', 'Old SRT', 'und']]);
  assert.equal(await page.isVisible('#subs-field'), true);
  await page.check('#subs-files');
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.click('#start');
  const done = await until(() => page.evaluate(() => ['done', 'error'].includes(window._download.state) && window._download), { timeout: 30000 });
  assert.equal(done.state, 'done', JSON.stringify(done));
  await until(() => downloads.length >= 4, { timeout: 10000 });
  const names = downloads.map(d => d.suggestedFilename());
  assert.deepEqual(names, ['Subbed.mp4', 'Subbed.de.srt', 'Subbed.fr.srt', 'Subbed.Old_SRT.srt']);
  const read = async d => { const f = path.join(os.tmpdir(), `sap-dl-${Date.now()}-${d.suggestedFilename()}`); await d.saveAs(f); const b = fs.readFileSync(f); fs.rmSync(f, { force: true }); return b; };
  const mp4 = await read(downloads[0]);
  assert.deepEqual(done.tracks.map(t => t.handler), ['vide', 'sbtl', 'sbtl', 'sbtl']);
  assert.deepEqual(done.subtitles.map(t => [t.label, t.cues, t.base]), [['Deutsch', 3, 'media'], ['French', 1, 'output'], ['Old SRT', 1, 'output']]);
  const texts = Object.values(tx3gTexts(mp4)).map(list => [...new Set(list)]);
  assert.deepEqual(texts, [['Guten Tag', 'Über die Grenze', 'Auf Wiedersehen'], ['Bonjour'], ['Café “quoted”']]);
  const srt = (await read(downloads[1])).toString('utf8');
  assert.match(srt, /00:00:01,000 --> 00:00:03,000\r?\nGuten Tag/);
  assert.match(srt, /00:00:11,000 --> 00:00:13,000\r?\n\u00dcber die Grenze\r?\n\r?\n3\r?\n/);
  // the video still plays
  const media = await probeMedia(mp4, 'video/mp4');
  assert.ok(Math.abs(media.duration - 24) < 1.5, `duration ${media.duration}`);
  assert.ok(media.videoBytes > 0, 'no video decoded');
  await page.close();
});

test('download: AES-128 encrypted HLS is decrypted', async () => {
  const { state, data } = await downloadVia(`${ORIGIN}/hls-real/enc.m3u8`);
  assert.equal(state.state, 'done', JSON.stringify(state));
  const media = await probeMedia(data, 'video/mp4');
  assert.ok(Math.abs(media.duration - 24) < 1.5, `duration ${media.duration}`);
  assert.ok(media.videoBytes > 0, 'decrypted video did not decode');
});

test('download: MPEG-TS HLS with muxed audio is transmuxed into one MP4 (network)', { skip: !NETWORK && 'set E2E_NETWORK=1', timeout: 300000 }, async () => {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/download.html?url=${encodeURIComponent('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8')}&title=BBB`);
  assert.ok(await until(() => page.evaluate(() => window._download && window._download.state === 'ready'), { timeout: 30000 }), 'not ready');
  // lowest quality keeps the download small
  const values = await page.$$eval('#quality option', os => os.map(o => o.value));
  await page.selectOption('#quality', values[values.length - 1]);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 280000 }), page.click('#start')]);
  const file = path.join(os.tmpdir(), `sap-ts-${Date.now()}.mp4`);
  await download.saveAs(file);
  const state = await page.evaluate(() => window._download);
  await page.close();
  const data = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  assert.deepEqual(state.tracks.map(t => t.handler).sort(), ['soun', 'vide']);
  assert.deepEqual(boxTypes(data).slice(0, 3), ['ftyp', 'moov', 'sidx']);
  const media = await probeMedia(data, 'video/mp4');
  assert.ok(Math.abs(media.duration - state.manifestDuration) < 2, `duration ${media.duration} vs playlist ${state.manifestDuration}`);
  assert.ok(Math.abs(media.seekedTo - 15) < 1.5, `seek landed at ${media.seekedTo}`);
  assert.ok(media.audioBytes > 0 && media.videoBytes > 0, `not decoded: ${JSON.stringify(media)}`);
});

test('download: a long stream waits in IndexedDB, not RAM, and the storage is removed with the tab', async (t) => {
  const { state, data } = await downloadVia(`${ORIGIN}/big-hls/index.m3u8`, 'Big');
  assert.equal(state.state, 'done', JSON.stringify(state));
  assert.equal(state.storage, 'indexeddb');
  assert.ok(data.length > 60 * 1024 * 1024, `file only ${data.length} bytes`);
  assert.equal(data.length, state.size);
  assert.deepEqual(boxTypes(data).slice(0, 3), ['ftyp', 'moov', 'sidx']);
  assert.equal(boxTypes(data).filter(t => t === 'moof').length, 60);
  assert.equal(boxTypes(data).filter(t => t === 'free').length, 60, 'media data (incl. padding) was not carried over');
  assert.ok(Math.abs(state.duration - 120) < 3, `duration ${state.duration}`);
  t.diagnostic(`file ${(data.length / 1048576).toFixed(1)} MB, held at most ${(state.peakHeld / 1048576).toFixed(1)} MB, storage ${state.storage}`);
  // What the downloader itself held at once: a few segments, not the 61 MB file
  assert.ok(state.peakHeld < 12 * 1024 * 1024, `held ${(state.peakHeld / 1048576).toFixed(1)} MB at once`);
  // the tab's database is deleted when the tab closes (downloadVia closed it)
  const left = await until(async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/popup.html`);
    const names = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => n.startsWith('sap-download-')));
    await page.close();
    return names.length === 0 ? true : null;
  }, { timeout: 8000, interval: 500 });
  assert.ok(left, 'download databases were left behind');
});

test('download: a plain file is saved as it is', async () => {
  const { state, data, name } = await downloadVia(`${ORIGIN}/media/real.webm`, 'Plain');
  assert.equal(state.state, 'done', JSON.stringify(state));
  assert.equal(name, 'Plain.webm');
  assert.ok(data.equals(fs.readFileSync(path.join(__dirname, 'fixtures', 'clip.webm'))));
});

test('⬇️ in the page menu opens the downloader with the stream and its cleaned title', async () => {
  await setSettings({ showDownloadIcon: true, downloadMethod: 'browser' });
  const page = await openSite('/p/real-hls');
  await until(async () => (await readItems(page)).length === 1);
  await page.click('#video-handler-button');
  const [dl] = await Promise.all([ctx.waitForEvent('page'), page.click('.v-action-download')]);
  await until(() => dl.url().includes('download.html'));
  const params = new URL(dl.url()).searchParams;
  assert.equal(params.get('url'), `${ORIGIN}/hls-real/index.m3u8`);
  assert.equal(params.get('title'), 'Test Clip E02');
  await dl.close();
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
