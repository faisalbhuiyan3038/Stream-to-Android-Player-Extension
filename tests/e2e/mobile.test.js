// Phone tests: the extension's pages under Chromium mobile emulation (Pixel-class viewport,
// touch, DPR 2.75, Android user agent), portrait and landscape.
//   npm run test:e2e:mobile
// This is emulation: it checks layout, touch targets and touch gestures in Chromium's engine.
// Firefox for Android on a real device is not covered (see TASKS.md note).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { startServer, ORIGIN } = require('./server');
const { stageExtension } = require('./stage');
const { VIEWS, MIN, PHONE, measure } = require('./mobile-audit');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ctx, sw, extId, site, profileDir, EXT;

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

before(async () => {
  site = await startServer();
  EXT = stageExtension('chrome');
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-mobile-e2e-'));
  ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: process.env.CHROMIUM_BIN || undefined, // a preinstalled Chromium when Playwright's own is missing
    headless: process.env.HEADLESS === '1',
    ...PHONE,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required']
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

const media = () => encodeURIComponent(`${ORIGIN}/media/real.webm`);
const subs = () => encodeURIComponent(JSON.stringify([{ url: `${ORIGIN}/subs/cp1252.srt`, label: 'French', lang: 'fr' }]));
const playerUrl = (page, extra = '') => `chrome-extension://${extId}/${page}?url=${media()}&subs=${subs()}${extra}`;

async function openAt(url, view) {
  const page = await ctx.newPage();
  await page.setViewportSize(view);
  await page.goto(url);
  return page;
}

// ── layout ───────────────────────────────────────────────────────────────────

for (const [engine, file] of [['Vidstack', 'player.html'], ['Shaka', 'player-shaka.html']]) {
  for (const [orient, view] of Object.entries(VIEWS)) {
    test(`${engine} player, ${orient}: fits the screen, controls are thumb-sized`, async () => {
      const page = await openAt(playerUrl(file), view);
      await until(() => page.evaluate(() => { const s = window._subtitleStatus || []; return s.length === 1 && s[0].via !== 'pending'; }), { timeout: 15000 });
      await page.touchscreen.tap(view.width / 2, view.height / 3); // show the controls
      await sleep(500);
      const r = await page.evaluate(measure, MIN);
      assert.equal(r.overflowX, false, 'horizontal overflow');
      assert.deepEqual(r.small, [], 'controls smaller than 40px');
      // the video fills the width (portrait) or the height (landscape), centred
      const box = await page.evaluate(() => { const v = document.querySelector('video'); const b = v.getBoundingClientRect(); return { w: b.width, h: b.height }; });
      assert.ok(box.w >= view.width - 2 && box.h >= view.height * 0.9, `video box ${JSON.stringify(box)}`);
      await page.close();
    });
  }
}

test('popup on a phone: no horizontal overflow, thumb-sized controls (portrait and landscape)', async () => {
  for (const view of Object.values(VIEWS)) {
    const page = await openAt(`chrome-extension://${extId}/popup.html`, view);
    await sleep(800);
    const r = await page.evaluate(measure, MIN);
    assert.equal(r.overflowX, false, `overflow at ${view.width}x${view.height}`);
    assert.deepEqual(r.small, [], `small controls at ${view.width}x${view.height}`);
    await page.close();
  }
});

test('download page on a phone: fits, thumb-sized controls, quality choice shown (portrait and landscape)', async () => {
  for (const view of Object.values(VIEWS)) {
    // with page subtitles, so the subtitle choices are measured too
    const subs = encodeURIComponent(JSON.stringify([{ url: `${ORIGIN}/subs/fr.srt`, label: 'French', lang: 'fr' }]));
    const page = await openAt(`chrome-extension://${extId}/download.html?url=${encodeURIComponent(`${ORIGIN}/hls-real/master.m3u8`)}&title=Clip&subs=${subs}`, view);
    assert.ok(await until(() => page.evaluate(() => window._download && window._download.state === 'ready'), { timeout: 15000 }), 'not ready');
    const r = await page.evaluate(measure, MIN);
    assert.equal(r.overflowX, false, `overflow at ${view.width}x${view.height}`);
    assert.deepEqual(r.small, [], `small controls at ${view.width}x${view.height}`);
    assert.equal(await page.isVisible('#quality'), true);
    assert.equal(await page.isVisible('#subs-files'), true);
    await page.close();
  }
});

test('in-page stream menu on a phone page: opens with a tap, stays on screen, thumb-sized', async () => {
  for (const view of Object.values(VIEWS)) {
    const page = await openAt(`${ORIGIN}/p/mobile`, view);
    await until(() => page.evaluate(() => document.querySelectorAll('.stream-item').length >= 1));
    const btn = await page.$('#video-handler-button');
    const b = await btn.boundingBox();
    assert.ok(b.width >= MIN && b.height >= MIN, `floating button ${b.width}x${b.height}`);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await until(() => page.evaluate(() => getComputedStyle(document.getElementById('video-handler-menu')).display !== 'none'));
    const menu = await page.evaluate(() => { const r = document.getElementById('video-handler-menu').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
    assert.ok(menu.l >= 0 && menu.t >= 0 && menu.r <= view.width && menu.b <= view.height, `menu off screen: ${JSON.stringify(menu)}`);
    const r = await page.evaluate(measure, MIN);
    assert.equal(r.overflowX, false);
    assert.deepEqual(r.small, [], `small controls at ${view.width}x${view.height}`);
    await page.close();
  }
});

// ── gestures and memory ─────────────────────────────────────────────────────

test('Shaka: double-tap on the right half seeks forward 10 s', async () => {
  const view = VIEWS.landscape;
  const page = await openAt(playerUrl('player-shaka.html'), view);
  await until(() => page.evaluate(() => { const v = document.getElementById('video'); return v.readyState >= 2 && v.duration > 20; }), { timeout: 15000 });
  await page.evaluate(() => { const v = document.getElementById('video'); v.pause(); v.currentTime = 2; });
  await until(() => page.evaluate(() => !document.getElementById('video').seeking));
  const before = await page.evaluate(() => document.getElementById('video').currentTime);
  const x = view.width * 0.85;
  const y = view.height * 0.4;
  await page.touchscreen.tap(x, y);
  await sleep(120);
  await page.touchscreen.tap(x, y);
  const after = await until(async () => {
    const t = await page.evaluate(() => document.getElementById('video').currentTime);
    return t >= before + 8 ? t : null;
  }, { timeout: 4000 });
  assert.ok(after, `double tap did not seek: before ${before}, now ${await page.evaluate(() => document.getElementById('video').currentTime)}`);
  await page.close();
});

for (const [engine, file] of [['Vidstack', 'player.html'], ['Shaka', 'player-shaka.html']]) {
  test(`${engine}: resumes where you stopped, with "Start over"; playback speed is remembered`, async () => {
    // Seed the memory (extension origin localStorage) as if the video had been left at 0:12
    const seed = await ctx.newPage();
    await seed.goto(`chrome-extension://${extId}/popup.html`);
    await seed.evaluate((url) => {
      localStorage.setItem('sap.positions', JSON.stringify({ [url]: { t: 12, d: 30, at: Date.now() } }));
      localStorage.setItem('sap.rate', '1.5');
    }, `${ORIGIN}/media/real.webm`);
    await seed.close();

    const page = await openAt(playerUrl(file), VIEWS.portrait);
    assert.ok(await until(() => page.evaluate(() => document.getElementById('toast').classList.contains('visible')), { timeout: 15000 }), 'no resume notice');
    assert.match(await page.textContent('#toast'), /Resumed at 0:12/);
    const t = await until(async () => {
      const v = await page.evaluate(() => { const el = document.querySelector('video'); return el ? el.currentTime : 0; });
      return v >= 11.5 ? v : null;
    }, { timeout: 5000 });
    assert.ok(t, 'did not resume at 0:12');
    assert.equal(await page.evaluate(() => document.querySelector('video').playbackRate), 1.5);
    await page.click('#toast button');
    assert.ok(await until(() => page.evaluate(() => document.querySelector('video').currentTime < 3)), '"Start over" did not go back');
    await page.close();

    const check = await ctx.newPage();
    await check.goto(`chrome-extension://${extId}/popup.html`);
    const stored = await check.evaluate((url) => JSON.parse(localStorage.getItem('sap.positions') || '{}')[url] || null, `${ORIGIN}/media/real.webm`);
    assert.equal(stored, null, '"Start over" should forget the position');
    await check.evaluate(() => localStorage.removeItem('sap.rate'));
    await check.close();
  });
}
