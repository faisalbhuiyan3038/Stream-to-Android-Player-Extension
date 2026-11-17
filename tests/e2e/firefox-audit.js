// Screenshots of the extension's own pages in Firefox (and the same pages in Chromium) for
// Firefox-only layout problems that the Firefox test suite cannot catch (it drives web pages).
//   npm run audit:firefox [-- outDir]     env: SKIP_CHROMIUM=1, ONLY=<regex of page names>, HEADLESS=1
// Firefox's WebDriver may neither open, script nor screenshot moz-extension:// pages, so:
//  - the staged copy has a fixed UUID (pref extensions.webextensions.uuids) and its popup and
//    download page are made web-accessible; a web page navigates to each extension page;
//  - tests/e2e/audit-hook.js (added to the staged pages only) writes measurements to
//    document.title, read from the privileged "chrome" context (geckodriver --allow-system-access);
//  - screenshots are taken of the whole browser window from the chrome context;
//  - the real toolbar popup is opened by pinning and clicking the extension's toolbar button,
//    so its size is the one Firefox really gives it (the panel itself is not in screenshots;
//    the Chromium run saves each popup tab at popup width instead).
// Prints per page: subtitle font size/height, the popup's width. Not a test: nothing is asserted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const { chromium } = require('playwright');
const { startServer, ORIGIN } = require('./server');
const { stageExtension } = require('./stage');

const ADDON_ID = 'faisalbhuiyan@mozilla';
const WIDGET_ID = 'faisalbhuiyan_mozilla-browser-action';
const UUID = '6f1c2a51-6d5e-4c2a-9a59-5a2b0c3d4e5f';
const VIEW = { width: 1280, height: 800 };
const HOOKED = ['popup.html', 'player.html', 'player-shaka.html', 'player-art.html', 'download.html'];
const ONLY = new RegExp(process.env.ONLY || '.'); // e.g. ONLY=popup
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pagesFor(base) {
  const subs = encodeURIComponent(JSON.stringify([{ url: `${ORIGIN}/subs/long.srt`, label: 'English', lang: 'en' }]));
  const hls = encodeURIComponent(`${ORIGIN}/hls-real/index.m3u8`);
  const file = encodeURIComponent(`${ORIGIN}/media/real.webm`);
  const levels = encodeURIComponent('http://127.0.0.1:8099/media/levels.wav');
  const master = encodeURIComponent(`${ORIGIN}/hls-real/master.m3u8`);
  return {
    'shaka-hls': `${base}/player-shaka.html?url=${hls}&subs=${subs}`,
    'shaka-file': `${base}/player-shaka.html?url=${file}&subs=${subs}`,
    'vidstack-hls': `${base}/player.html?url=${hls}&subs=${subs}`,
    'art-hls': `${base}/player-art.html?url=${hls}&subs=${subs}`,
    'popup-tab': `${base}/popup.html`,
    download: `${base}/download.html?url=${hls}&title=Clip&subs=${subs}`,
    // audio effects: a cross-origin WAV without CORS headers (3 s loud, then quiet) and HLS (MSE)
    'audio-shaka-file': `${base}/player-shaka.html?url=${levels}&audit_audio=dialogue`,
    'audio-art-file': `${base}/player-art.html?url=${levels}&audit_audio=dialogue`,
    'audio-vidstack-hls': `${base}/player.html?url=${master}&audit_audio=music`
  };
}

function stageAudited(target) {
  return stageExtension(target, (manifest, dir) => {
    fs.copyFileSync(path.join(__dirname, 'audit-hook.js'), path.join(dir, 'audit-hook.js'));
    for (const f of HOOKED) {
      const file = path.join(dir, f);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('</body>', '<script src="audit-hook.js"></script></body>'));
    }
    if (target === 'firefox') manifest.web_accessible_resources[0].resources.push('popup.html', 'download.html');
  });
}

async function firefoxRun(OUT, report) {
  const ext = stageAudited('firefox');
  const options = new firefox.Options();
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  else if (process.platform === 'win32') options.setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  if (process.env.HEADLESS === '1') options.addArguments('-headless');
  options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }));
  options.setPreference('media.autoplay.default', 0);
  options.windowSize(VIEW);
  // geckodriver's --allow-system-access permits the chrome context
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  const chrome = async (fn) => {
    await driver.setContext(firefox.Context.CHROME);
    try { return await fn(); } finally { await driver.setContext(firefox.Context.CONTENT); }
  };
  const shot = name => chrome(async () => fs.writeFileSync(path.join(OUT, `firefox-${name}.png`), await driver.takeScreenshot(), 'base64'));
  try {
    await driver.installAddon(ext, true);
    await sleep(1500);
    for (const [name, url] of Object.entries(pagesFor(`moz-extension://${UUID}`)).filter(([n]) => ONLY.test(n))) {
      await driver.get(`${ORIGIN}/p/blank`);
      await driver.executeScript('location.href = arguments[0]', url);
      await sleep(name.startsWith('popup') ? 1500 : name.startsWith('audio') ? 11000 : 7000);
      const title = await chrome(() => driver.executeScript('return gBrowser.selectedBrowser.contentTitle'));
      report[`firefox ${name}`] = title.startsWith('AUDIT ') ? JSON.parse(title.slice(6)) : { title };
      await shot(name);
    }

    // The real toolbar popup on a page with a stream
    await driver.get(`${ORIGIN}/p/real-hls`);
    await sleep(3000);
    report['firefox popup (toolbar)'] = await chrome(async () => {
      const how = await driver.executeScript(`
        CustomizableUI.addWidgetToArea('${WIDGET_ID}', CustomizableUI.AREA_NAVBAR);
        const item = document.getElementById('${WIDGET_ID}');
        if (!item) return 'no toolbar item';
        const button = item.querySelector('.unified-extensions-item-action-button') || item;
        button.doCommand ? button.doCommand() : button.click();
        return item.tagName + ' ' + button.tagName;`);
      await sleep(2500);
      const r = await driver.executeScript(`
        const b = document.querySelector('browser.webextension-popup-browser, browser[webextension-view-type="popup"]');
        if (!b) return { error: 'no popup browser (${how.replace(/'/g, '')})' };
        const rect = b.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), title: b.contentTitle };`);
      fs.writeFileSync(path.join(OUT, 'firefox-popup-toolbar.png'), await driver.takeScreenshot(), 'base64');
      if (r.title && r.title.startsWith('AUDIT ')) { r.page = JSON.parse(r.title.slice(6)); delete r.title; }
      return r;
    });
  } finally {
    await driver.quit();
    fs.rmSync(ext, { recursive: true, force: true });
  }
}

async function chromiumRun(OUT, report) {
  const ext = stageAudited('chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-ffaudit-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_BIN || undefined,
    headless: false, viewport: VIEW,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required']
  });
  try {
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    for (const [name, url] of Object.entries(pagesFor(`chrome-extension://${id}`)).filter(([n]) => ONLY.test(n))) {
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForTimeout(name.startsWith('popup') ? 1500 : name.startsWith('audio') ? 11000 : 7000);
      const title = await page.title();
      report[`chromium ${name}`] = title.startsWith('AUDIT ') ? JSON.parse(title.slice(6)) : { title };
      await page.screenshot({ path: path.join(OUT, `chromium-${name}.png`) });
      if (name.startsWith('popup')) {
        // each tab at the popup's own size (Firefox's screenshots cannot show the popup panel)
        for (const tab of await page.$$eval('.tabs .tab', els => els.filter(e => e.offsetParent).map(e => e.id))) {
          await page.click(`#${tab}`);
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          await page.screenshot({ path: path.join(OUT, `chromium-popup-${tab}.png`), fullPage: true, clip: { x: 0, y: 0, width: 380, height } });
        }
      }
      await page.close();
    }
  } finally {
    await ctx.close();
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sap-ffaudit-'));
  fs.mkdirSync(OUT, { recursive: true });
  const site = await startServer();
  const report = {};
  try {
    await firefoxRun(OUT, report);
    if (process.env.SKIP_CHROMIUM !== '1') await chromiumRun(OUT, report);
  } finally {
    site.server.close();
  }
  console.log(`screenshots: ${OUT}`);
  for (const [k, r] of Object.entries(report)) console.log(`\n${k}: ${JSON.stringify(r)}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
