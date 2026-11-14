// Renders the extension UI under Chromium mobile emulation and reports layout problems.
//   node tests/e2e/mobile-audit.js [outDir]
// Pages: Vidstack player, Shaka player, the in-page floating menu, the popup. Each in portrait
// (393x851) and landscape (851x393), DPR 2.75, touch. Writes PNG screenshots and prints, per page:
// horizontal overflow, and every visible control smaller than 40x40 CSS px (Android's 48dp
// guideline minus a little slack), with its label.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { startServer, ORIGIN } = require('./server');
const { stageExtension } = require('./stage');

const VIEWS = { portrait: { width: 393, height: 851 }, landscape: { width: 851, height: 393 } };
const MIN = 40;
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
// Context options for a Pixel-class phone (Chromium only: isMobile is not supported by Firefox)
const PHONE = { viewport: VIEWS.portrait, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75, userAgent: MOBILE_UA };

// Visible interactive elements (also inside open shadow roots) smaller than MIN px
const measure = (min) => {
  const out = { overflowX: document.documentElement.scrollWidth > window.innerWidth + 1, small: [], vw: innerWidth, vh: innerHeight };
  const seen = new Set();
  const walk = (root) => {
    for (const el of root.querySelectorAll('button, [role="button"], input, select, a[href], media-play-button, media-mute-button, media-fullscreen-button, media-caption-button, media-settings-menu-button, media-time-slider, media-volume-slider, media-seek-button')) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      // A checkbox/radio inside a <label>: the whole label is the tap target
      const label = el.matches('input[type=checkbox], input[type=radio]') && el.closest('label');
      if (label) {
        const lr = label.getBoundingClientRect();
        if (lr.width >= min && lr.height >= min) continue;
      }
      // Sliders: the thumb is the target; native range inputs only need a visible track, custom
      // sliders need a tall enough hit area
      const isNativeRange = el.matches('input[type=range]');
      const isSlider = isNativeRange || el.matches('media-time-slider, media-volume-slider');
      const tooSmall = isSlider ? r.height < (isNativeRange ? 6 : 24) : (r.width < min || r.height < min);
      if (tooSmall) out.small.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 30)}"`);
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return out;
};

async function main() {
  const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sap-mobile-'));
  const site = await startServer();
  const ext = stageExtension('chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-mobile-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_BIN || undefined, // a preinstalled Chromium when Playwright's own is missing
    headless: false, ...PHONE,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const subs = encodeURIComponent(JSON.stringify([{ url: `${ORIGIN}/subs/cp1252.srt`, label: 'French', lang: 'fr' }, { url: `${ORIGIN}/subs/styled.ass`, label: 'English', lang: 'en' }]));
  const media = encodeURIComponent(`${ORIGIN}/media/real.webm`);
  const pages = {
    vidstack: `chrome-extension://${id}/player.html?url=${media}&subs=${subs}`,
    shaka: `chrome-extension://${id}/player-shaka.html?url=${media}&subs=${subs}`,
    popup: `chrome-extension://${id}/popup.html`,
    menu: `${ORIGIN}/p/mobile`
  };
  const report = {};
  for (const [name, url] of Object.entries(pages)) {
    for (const [orient, view] of Object.entries(VIEWS)) {
      const page = await ctx.newPage();
      await page.setViewportSize(view);
      await page.goto(url);
      await page.waitForTimeout(name === 'menu' ? 2500 : 3000);
      if (name === 'menu') await page.click('#video-handler-button').catch(() => {});
      // tap once so auto-hiding controls are visible
      if (name === 'vidstack' || name === 'shaka') await page.mouse.click(view.width / 2, view.height / 2).catch(() => {});
      await page.waitForTimeout(600);
      const file = path.join(OUT, `${name}-${orient}.png`);
      await page.screenshot({ path: file });
      report[`${name}-${orient}`] = await page.evaluate(measure, MIN);
      await page.close();
    }
  }
  await ctx.close();
  site.server.close();
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`screenshots: ${OUT}`);
  for (const [k, r] of Object.entries(report)) {
    console.log(`\n${k} (${r.vw}x${r.vh})${r.overflowX ? '  HORIZONTAL OVERFLOW' : ''}`);
    for (const s of r.small) console.log(`  small: ${s}`);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { VIEWS, MIN, PHONE, measure };
