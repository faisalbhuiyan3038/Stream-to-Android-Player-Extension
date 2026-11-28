// Chromium incognito windows. The Chrome manifest uses "incognito": "split": an incognito window gets
// its own instance of the background service worker, and our pages (players, download page) load in
// incognito tabs. (In the default "spanning" mode Chromium blocks them there: ERR_BLOCKED_BY_CLIENT.)
// The incognito instance keeps its stream lists in storage.session, never in storage.local.
// Own browser: allowing the extension in incognito reloads it (needs developer mode in the profile).
// Playwright does not expose the incognito profile, so its service worker is driven over CDP.
//   node --test tests/e2e/incognito.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { startServer, ORIGIN } = require('./server');
const { stageExtension } = require('./stage');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ctx, sw, extId, site, EXT, profileDir, cdp, incognitoSession;

async function until(fn, { timeout = 15000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => null);
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

// Evaluates `expression` (may be a promise) in an attached incognito target
let msgId = 0;
const pending = new Map();
function evaluateIn(sessionId, expression) {
  const id = ++msgId;
  const message = JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    cdp.send('Target.sendMessageToTarget', { sessionId, message }).catch(reject);
  });
}
// ... in the incognito instance's service worker
const incognito = expression => evaluateIn(incognitoSession, expression);

before(async () => {
  site = await startServer();
  EXT = stageExtension('chrome');
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-incognito-'));
  ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: process.env.CHROMIUM_BIN || undefined,
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  const first = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  extId = first.url().split('/')[2];
  // "Allow in Incognito" the way chrome://extensions does it; developer mode first, or the reloaded
  // unpacked extension is disabled as an unsupported developer extension
  const page = await ctx.newPage();
  await page.goto('chrome://extensions');
  await page.evaluate(() => new Promise(r => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
  await page.evaluate(id => new Promise(r => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true }, r)), extId);
  // The extension reloads; opening one of its pages wakes the new service worker
  for (let i = 0; i < 40 && !sw; i++) {
    await sleep(500);
    if (await page.goto(`chrome-extension://${extId}/popup.html`).then(() => true, () => false)) {
      await sleep(500);
      sw = ctx.serviceWorkers().find(w => w.url().includes(extId) && w !== first);
    }
  }
  assert.ok(sw, 'extension did not come back after allowing it in incognito');

  // A normal-window stream first, to check that incognito does not touch it
  const normal = await ctx.newPage();
  await normal.goto(`${ORIGIN}/p/secure`);
  await until(() => sw.evaluate(async () => ((await chrome.storage.local.get('detectedStreams')).detectedStreams || []).length > 0));

  // An incognito window on a page with a stream; its background instance is a second worker target
  // (in split mode the normal instance gets null back: the window belongs to the incognito instance)
  await sw.evaluate(async u => { await chrome.windows.create({ incognito: true, url: u }); }, `${ORIGIN}/p/real-hls`);
  cdp = await ctx.newCDPSession(page);
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const m = JSON.parse(message);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error || (m.result && m.result.exceptionDetails)) p.reject(new Error(JSON.stringify(m.error || m.result.exceptionDetails)));
    else p.resolve(m.result.result.value);
  });
  const target = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter(t => t.type === 'service_worker' && t.url.includes(extId));
    const normalCtx = targetInfos.find(t => t.type === 'page' && t.url.includes('/p/secure')).browserContextId;
    return workers.find(t => t.browserContextId !== normalCtx);
  });
  assert.ok(target, 'no incognito instance of the background (split mode not active?)');
  ({ sessionId: incognitoSession } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
});

after(async () => {
  if (ctx) await ctx.close();
  if (site) site.server.close();
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  if (EXT) fs.rmSync(EXT, { recursive: true, force: true });
});

// Calls background `fn` in the incognito instance, waits for the new tab and reports its window and
// whether our page loaded there (its title; a blocked page shows the URL instead)
const openInIncognito = (fn, streamCtx) => incognito(`(async () => {
  const before = new Set((await chrome.tabs.query({})).map(t => t.id));
  await ${fn}(${JSON.stringify({ subtitles: [], ...streamCtx })});
  let tab;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    tab = (await chrome.tabs.query({})).find(t => !before.has(t.id));
    if (tab && tab.status === 'complete' && tab.url.startsWith('chrome-extension://')) break;
  }
  const win = tab && await chrome.windows.get(tab.windowId);
  const result = { incognito: !!(win && win.incognito), title: tab && tab.title, page: tab && new URL(tab.url).pathname };
  if (tab) await chrome.tabs.remove(tab.id);
  return result;
})()`);

const HLS = `${ORIGIN}/hls-real/index.m3u8`;

test('incognito: a second background instance runs for the incognito window', async () => {
  // the attached worker may still be starting (no `chrome` yet) on the first evaluation
  assert.equal(await until(() => incognito('self.chrome ? String(chrome.extension.inIncognitoContext) : ""')), 'true');
  assert.equal(await sw.evaluate(() => chrome.extension.inIncognitoContext), false);
});

test('incognito: streams found there stay in memory (storage.session), apart from the normal window\'s', async () => {
  const found = await until(() => incognito(`storageReady.then(() => [...detectedStreams.values()].flat().map(s => s.url))`)
    .then(urls => urls.includes(HLS) && urls));
  assert.ok(found, 'incognito stream not detected');
  const session = await until(() => incognito(`chrome.storage.session.get('detectedStreams:incognito').then(r => JSON.stringify(r))`)
    .then(j => j.includes(HLS) && j));
  assert.ok(session, 'incognito streams not in storage.session');
  const local = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.ok(!local.includes(HLS), 'an incognito stream was written to storage.local');
  assert.ok(local.includes('/secure/index.m3u8'), 'the normal window\'s stream list was overwritten');
});

test('incognito: the download page opens in the incognito window, with and without a header rule', async () => {
  for (const referer of [`${ORIGIN}/p/real-hls`, undefined]) {
    const r = await openInIncognito('openDownloadPage', { url: HLS, referer });
    assert.deepEqual(r, { incognito: true, title: 'Download', page: '/download.html' }, `referer ${referer}`);
  }
});

test('incognito: the web player opens in the incognito window, with and without a header rule', async () => {
  for (const referer of [`${ORIGIN}/p/real-hls`, undefined]) {
    const r = await openInIncognito('openWebPlayer', { url: HLS, referer });
    assert.equal(r.incognito, true, `referer ${referer}: ${JSON.stringify(r)}`);
    assert.equal(r.title, 'Web Player', `not loaded (referer ${referer}): ${JSON.stringify(r)}`);
  }
});

test('incognito: the page Referer reaches the CDN from the incognito download page', async () => {
  site.log.secureReferers.length = 0;
  const r = await openInIncognito('openDownloadPage', { url: `${ORIGIN}/secure/index.m3u8`, referer: `${ORIGIN}/p/secure` });
  assert.equal(r.incognito, true);
  assert.equal(r.title, 'Download');
  // the page fetches the manifest after it has loaded
  await until(() => site.log.secureReferers.length > 0, { timeout: 10000 }).catch(() => {});
  assert.ok(site.log.secureReferers.includes(`${ORIGIN}/p/secure`), `referers seen: ${JSON.stringify(site.log.secureReferers)}`);
});

test('normal window: the download page still opens there', async () => {
  const r = await sw.evaluate(async (url) => {
    const before = new Set((await chrome.tabs.query({})).map(t => t.id));
    await openDownloadPage({ url, subtitles: [], referer: 'http://localhost:8099/p/real-hls' });
    let tab;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      tab = (await chrome.tabs.query({})).find(t => !before.has(t.id));
      if (tab && tab.status === 'complete' && tab.url.startsWith('chrome-extension://')) break;
    }
    const win = await chrome.windows.get(tab.windowId);
    return { incognito: win.incognito, title: tab.title };
  }, HLS);
  assert.deepEqual(r, { incognito: false, title: 'Download' });
});

test('incognito: "save straight to a folder" is offered (with the memory note) and writes the MP4 there', async () => {
  // a download page in the incognito window, attached over CDP like the worker
  await incognito(`openDownloadPage(${JSON.stringify({ url: HLS, subtitles: [], title: 'Private Clip' })})`);
  const target = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const normalCtx = targetInfos.find(t => t.type === 'page' && t.url.includes('/p/secure')).browserContextId;
    return targetInfos.find(t => t.type === 'page' && t.url.includes('download.html') && t.url.includes('Private') && t.browserContextId !== normalCtx);
  });
  assert.ok(target, 'incognito download page not found');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  const inPage = expression => evaluateIn(sessionId, expression);
  assert.ok(await until(() => inPage(`window._download && window._download.state === 'ready'`)), 'download page not ready');
  const offer = await inPage(`({ shown: !document.getElementById('folder-field').hidden, note: document.getElementById('folder-note').textContent })`);
  assert.equal(offer.shown, true);
  assert.match(offer.note, /Incognito windows keep downloads in memory/);
  // the picker replaced by a folder of the page's own file system (same handle API)
  await inPage(`(async () => {
    const root = await navigator.storage.getDirectory();
    window.showDirectoryPicker = async () => root.getDirectoryHandle('picked', { create: true });
    document.getElementById('to-folder').checked = true;
    document.getElementById('start').click();
  })()`);
  const done = await until(() => inPage(`['done', 'error'].includes(window._download.state) && JSON.stringify(window._download)`), { timeout: 30000 });
  assert.equal(JSON.parse(done).state, 'done', done);
  const names = await inPage(`(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
    const out = [];
    for await (const [name, h] of dir.entries()) out.push(name + ':' + (h.kind === 'file' ? (await h.getFile()).size : 'dir'));
    return out;
  })()`);
  assert.equal(names.length, 1, JSON.stringify(names));
  assert.match(names[0], /^Private Clip\.mp4:\d+$/);
  assert.ok(Number(names[0].split(':')[1]) > 100000, JSON.stringify(names));
});
