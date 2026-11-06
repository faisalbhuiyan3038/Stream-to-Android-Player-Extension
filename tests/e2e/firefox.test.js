// Browser tests for the Firefox build (Selenium + geckodriver). Firefox extension pages
// cannot be scripted through WebDriver, so these tests cover the content script and
// the background logic through the page UI.
//   npm run test:e2e:firefox
//   E2E_NATIVE=1 npm run test:e2e:firefox   also launches a program through the native host
//                                           (needs native-host/install.bat or install.sh run once)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Builder, By, Origin } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { startServer, ORIGIN } = require('./server');

const { stageExtension } = require('./stage');

const NATIVE = process.env.E2E_NATIVE === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let driver, site, stageDir, markerDir;

// Staged copy with the Firefox manifest. For the native test it also makes nativeMessaging a
// normal permission (WebDriver cannot click the grant prompt) and pre-selects the native
// method with a template that records the arguments it was launched with.
function stageFirefox() {
  return stageExtension('firefox', (manifest, dir) => {
    // Settings cannot be changed from the test (no scripting of extension pages), so the one
    // custom pattern the "custom pattern" test needs is preset in the staged copy. It only matches /api/play/<n>.
    const file = path.join(dir, 'background.js');
    // Same for "open stream links": no other test navigates to a stream file directly.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace("customPatterns: ''", `customPatterns: ${JSON.stringify('m3u8 /\\/api\\/play\\/\\d+/')}`)
      .replace('openStreamLinks: false', 'openStreamLinks: true'));
    if (!NATIVE) return;
    manifest.permissions.push('nativeMessaging');
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-ff-marker-'));
    const marker = path.join(markerDir, 'marker.json');
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const code = `import sys,json;open(r'${marker}','w').write(json.dumps(sys.argv[1:]))`;
    let bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
    bg = bg.replace("desktopExternalMethod: 'native'", "desktopExternalMethod: 'native'")
      .replace("externalPlayerPath: ''", `externalPlayerPath: ${JSON.stringify(py)}`)
      .replace("nativeArgsTemplate: ''", `nativeArgsTemplate: ${JSON.stringify(`-c "${code}" {referer} {title} {url}`)}`);
    fs.writeFileSync(path.join(dir, 'background.js'), bg);
  });
}
before(async () => {
  site = await startServer();
  stageDir = stageFirefox();
  const options = new firefox.Options();
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  else if (process.platform === 'win32') options.setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  if (process.env.HEADLESS === '1') options.addArguments('-headless');
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).build();
  await driver.installAddon(stageDir, true);
  // Give the freshly installed extension time to register its listeners and content scripts
  await driver.get(ORIGIN + '/p/blank');
  await sleep(2000);
});

after(async () => {
  if (driver) await driver.quit();
  if (site) site.server.close();
  for (const d of [stageDir, markerDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

async function until(fn, { timeout = 12000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

const readItems = () => driver.executeScript(() => [...document.querySelectorAll('.stream-item')].map(e => ({
  name: e.querySelector('.stream-name').textContent,
  quality: (e.querySelector('.quality-badge') || {}).textContent || '',
  duration: (e.querySelector('.duration-badge') || {}).textContent || '',
  subs: (e.querySelector('.sub-badge') || {}).textContent || '',
  variants: [...e.querySelectorAll('.v-quality option')].map(o => o.textContent),
  url: e.dataset.url
})));

async function open(route) {
  await driver.get(ORIGIN + route);
}

test('detects an m3u8 fetched at page load', async () => {
  await open('/p/early');
  const items = await until(async () => { const r = await readItems(); return r.length ? r : null; });
  assert.equal(items.length, 1);
  assert.equal(items[0].duration, '0:10');
});

test('detects <video src> with URL quality', async () => {
  await open('/p/video');
  const items = await until(async () => { const r = await readItems(); return r.length ? r : null; });
  assert.equal(items[0].quality, '1080p');
});

test('keeps a standalone .ts and hides playlist segments', async () => {
  await open('/p/ts-only');
  const ts = await until(async () => { const r = await readItems(); return r.length ? r : null; });
  assert.equal(ts.length, 1);
  await open('/p/segments');
  await until(async () => (await readItems()).length >= 1);
  await sleep(2500);
  const items = await readItems();
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.match(items[0].name, /\(m3u8\)/);
});

test('master playlist: quality, variants and duration', async () => {
  await open('/p/master');
  const items = await until(async () => { const r = await readItems(); return r.length && r[0].variants.length && r[0].duration ? r : null; });
  assert.ok(items, 'variants/duration never arrived');
  assert.equal(items[0].quality, '1080p');
  assert.deepEqual(items[0].variants, ['Auto', '1080p', '720p', '480p']);
  assert.equal(items[0].duration, '1:00');
});

test('subtitles: <track> and network subtitles give a CC badge', async () => {
  await open('/p/subs');
  const items = await until(async () => { const r = await readItems(); return r.length && r[0].subs === 'CC 2' ? r : null; });
  assert.ok(items, 'CC 2 never appeared');
});

// ── phase 1: detection signals, patterns, titles (same scenarios as the Chromium suite) ──

const readSubtitles = () => driver.executeScript(() => [...document.querySelectorAll('.stream-item .stream-subtitle')].map(e => e.textContent));

test('error responses are not listed as streams', async () => {
  await open('/p/missing');
  await sleep(3000);
  assert.equal((await readItems()).length, 0);
});

test('a stream URL carried in a .php query string is detected', async () => {
  await open('/p/proxied');
  const items = await until(async () => { const r = await readItems(); return r.length ? r : null; });
  assert.ok(items, 'proxied stream not detected');
  assert.match(items[0].name, /\(m3u8\)/);
});

test('"media" requests are detected without a stream-like URL or content type', async () => {
  await open('/p/media');
  const items = await until(async () => { const r = await readItems(); return r.length ? r : null; });
  assert.ok(items, 'media request not detected');
});

test('a custom detection pattern makes an unrecognised URL a stream', async () => {
  await open('/p/custom');
  const items = await until(async () => { const r = await readItems(); return r.length ? r : null; });
  assert.ok(items, 'pattern did not match');
  assert.match(items[0].name, /\(m3u8\)/);
});

test('page titles are cleaned, and refreshed when the page sets its title late', async () => {
  await open('/p/titled');
  await until(async () => (await readSubtitles()).length > 0);
  assert.deepEqual(await readSubtitles(), ['Dark Matter S01E05']);

  await open('/p/late-title');
  await until(async () => (await readItems()).length === 1);
  const better = await until(async () => (await readSubtitles())[0] === 'Big Buck Bunny (2008)', { timeout: 8000 });
  assert.ok(better, `title never refreshed: ${JSON.stringify(await readSubtitles())}`);
});

test('a direct .m3u8 / .mpd link opens in the web player (option preset on)', async () => {
  await open('/hls/early.m3u8?t=1');
  const hls = await until(async () => { const u = await driver.getCurrentUrl(); return /^moz-extension:\/\/.+\/player\.html#/.test(u) ? u : null; }, { timeout: 8000 });
  assert.ok(hls, `not redirected: ${await driver.getCurrentUrl()}`);
  assert.ok(hls.endsWith(`#${ORIGIN}/hls/early.m3u8?t=1`), hls);
  await open('/dash/manifest.mpd');
  const dash = await until(async () => { const u = await driver.getCurrentUrl(); return /player-shaka\.html#/.test(u) ? u : null; }, { timeout: 8000 });
  assert.ok(dash, `DASH not redirected: ${await driver.getCurrentUrl()}`);
  await open('/p/blank?next=a.m3u8');
  await sleep(1000);
  assert.equal(await driver.getCurrentUrl(), `${ORIGIN}/p/blank?next=a.m3u8`);
});

test('a stream inside a cross-origin iframe is found (all-frames DOM scan)', async () => {
  await open('/p/iframe');
  const items = await until(async () => { const r = await readItems(); return r.find(i => /frame\.m3u8$/.test(i.url)) ? r : null; });
  assert.ok(items, `iframe stream not detected: ${JSON.stringify(await readItems())}`);
});

test('a playlist fetched by the page\'s service worker is attributed to the tab', async () => {
  await open('/p/sw');
  const items = await until(async () => { const r = await readItems(); return r.find(i => /sw\.m3u8$/.test(i.url)) ? r : null; });
  assert.ok(items, `service-worker request not detected: ${JSON.stringify(await readItems())}`);
  await driver.executeScript(() => navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
});

test('navigating away clears the stream list', async () => {
  await open('/p/video');
  await until(async () => (await readItems()).length === 1);
  await open('/p/blank');
  await sleep(1500);
  assert.equal((await readItems()).length, 0);
});

test('▶️ opens a player tab for the stream', async () => {
  await open('/p/video');
  await until(async () => (await readItems()).length === 1);
  const before = (await driver.getAllWindowHandles()).length;
  await driver.executeScript(() => document.getElementById('video-handler-button').click());
  await driver.executeScript(() => document.querySelector('.v-action-play').click());
  const opened = await until(async () => (await driver.getAllWindowHandles()).length > before);
  assert.ok(opened, 'no player tab opened');
  const handles = await driver.getAllWindowHandles();
  await driver.switchTo().window(handles[0]);
});

test('button: drag moves it to the left edge and the spot is remembered after a reload', async () => {
  // own URL: re-opening the exact URL the previous test left open is a reload in Firefox, not a navigation
  await open('/p/video?drag');
  await until(async () => (await readItems()).length === 1);
  const rect = () => driver.executeScript(() => {
    const r = document.getElementById('video-handler-button').getBoundingClientRect();
    const b = document.getElementById('video-handler-button');
    return { x: r.x, y: r.y, vw: document.documentElement.clientWidth, vh: window.innerHeight, display: b.style.display, items: document.querySelectorAll('.stream-item').length, t: performance.now() | 0 };
  });
  // The list items exist a moment before the button is shown and positioned
  await until(async () => (await rect()).display === 'flex');
  const start = await rect();
  assert.ok(start.x > start.vw / 2, `starts on the right: ${JSON.stringify(start)}`);
  const button = await driver.findElement(By.id('video-handler-button'));
  await driver.actions().move({ origin: button }).press().move({ origin: Origin.POINTER, x: -Math.round(start.vw * 0.8), y: -Math.round(start.vh * 0.6) }).release().perform();
  await until(async () => (await rect()).x < start.vw / 4);
  const moved = await rect();
  assert.ok(moved.x < moved.vw / 4 && moved.y < start.y - 100, `moved: ${JSON.stringify(moved)}`);
  assert.equal(await driver.executeScript(() => getComputedStyle(document.getElementById('video-handler-menu')).display), 'none', 'a drag must not open the menu');

  await driver.navigate().refresh();
  await until(async () => (await readItems()).length === 1);
  await until(async () => { const r = await rect(); return r.display === 'flex' && r.x < r.vw / 4; });
  const restored = await rect();
  assert.ok(restored.x < restored.vw / 4, `restored: ${JSON.stringify(restored)}`);
});
test('native host: launches a program with referrer, title and url', { skip: !NATIVE && 'set E2E_NATIVE=1' }, async () => {
  await open('/p/early');
  await until(async () => (await readItems()).length === 1);
  await driver.executeScript(() => document.getElementById('video-handler-button').click());
  await driver.executeScript(() => document.querySelector('.v-action-share').click());
  const marker = path.join(markerDir, 'marker.json');
  const found = await until(() => fs.existsSync(marker) && fs.statSync(marker).size > 0, { timeout: 20000 });
  assert.ok(found, 'the native host never started the program');
  const args = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(args[0], `${ORIGIN}/p/early`, 'referer');
  assert.equal(args[1], 'Early', 'title');
  assert.equal(args[2], `${ORIGIN}/hls/early.m3u8`, 'url');
});
