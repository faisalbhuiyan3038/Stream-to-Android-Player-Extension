// Unit tests for the pure helpers in background.js and shared.js.
// background.js is a plain script that expects the WebExtension globals, so it is
// evaluated in a vm context with a stub `browser`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Arrays created inside the vm context have a different prototype, so compare loosely
const deepEqual = require('node:assert').deepEqual;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadBackground() {
  const stub = () => new Proxy(function () {}, {
    get: (target, prop) => (Object.prototype.hasOwnProperty.call(target, prop) ? target[prop] : (prop === 'then' ? undefined : stub())),
    apply: () => stub()
  });
  const browser = stub();
  browser.storage = { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, onChanged: stub() };
  browser.runtime = { id: 'test', onStartup: stub(), onMessage: stub(), onInstalled: stub(), getPlatformInfo: () => Promise.resolve({ os: 'win' }), getURL: p => p };
  browser.contextMenus = undefined;
  browser.commands = undefined;
  const context = vm.createContext({
    browser, chrome: browser, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { userAgent: 'TestUA/1.0' }, fetch: () => Promise.reject(new Error('no network in unit tests')), btoa
  });
  // background.js loads shared.js itself (importScripts / manifest scripts); do the same here
  vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), context, { filename: 'shared.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return context;
}

const bg = loadBackground();
const run = code => vm.runInContext(code, bg);

test('parseM3u8: master playlist yields variants', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"', 'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080', '/abs/hi.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"'
  ].join('\n');
  const p = bg.parseM3u8(text, 'https://cdn.example/v/master.m3u8');
  assert.equal(p.isMaster, true);
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].url, 'https://cdn.example/v/low/index.m3u8');
  assert.equal(p.variants[0].height, 480);
  assert.equal(p.variants[0].codecs, 'avc1.4d401e,mp4a.40.2');
  assert.equal(p.variants[1].url, 'https://cdn.example/abs/hi.m3u8');
  assert.equal(p.variants[1].bandwidth, 5000000);
});

test('parseM3u8: media playlist sums EXTINF and finds the segment directory', () => {
  const p = bg.parseM3u8('#EXTM3U\n#EXTINF:4.5,\nseg0.ts\n#EXTINF:5.5,\nseg1.ts\n#EXT-X-ENDLIST', 'https://a.example/x/index.m3u8');
  assert.equal(p.isMaster, false);
  assert.equal(p.duration, 10);
  assert.equal(p.segmentDir, 'https://a.example/x/');
});

test('parseMpd: highest video height and duration', () => {
  const p = bg.parseMpd('<MPD mediaPresentationDuration="PT1H2M3.5S"><Representation height="360"/><Representation height="1080"/></MPD>');
  assert.equal(p.maxHeight, 1080);
  assert.equal(p.duration, 3723.5);
});

test('heightLabel', () => {
  assert.equal(bg.heightLabel(1080), '1080p');
  assert.equal(bg.heightLabel(2160), '4K');
  assert.equal(bg.heightLabel(0), null);
});

test('isSegmentOf: kisskh-style separate hosts match on the file stem', () => {
  const playlist = { url: 'https://hls08.cdnvideo11.shop/hls08/13947/Ep1.v190_index.m3u8' };
  assert.equal(bg.isSegmentOf('https://hls08.streamingcdn5.site/13947/Ep1.v190_index0.ts', playlist), true);
  assert.equal(bg.isSegmentOf('https://hls08.streamingcdn5.site/13947/Ep1.v190_index173.ts', playlist), true);
});

test('isSegmentOf: uses the real segment directory when known', () => {
  const playlist = { url: 'https://a.example/index.m3u8', segmentDir: 'https://cdn.example/s/' };
  assert.equal(bg.isSegmentOf('https://cdn.example/s/000.ts', playlist), true);
  assert.equal(bg.isSegmentOf('https://cdn.example/other/000.ts', playlist), false);
});

test('isSegmentOf: keeps unrelated standalone .ts files', () => {
  const playlist = { url: 'https://a.example/path/show.m3u8' };
  assert.equal(bg.isSegmentOf('https://b.example/live/chunk0001.ts', playlist), false);
  // a playlist at the site root must not swallow every .ts on that host
  assert.equal(bg.isSegmentOf('https://a.example/other.ts', { url: 'https://a.example/master.m3u8' }), false);
  // same non-root directory counts as a segment
  assert.equal(bg.isSegmentOf('https://a.example/path/seg9.ts', playlist), true);
});

test('isSubtitleUrl', () => {
  assert.equal(bg.isSubtitleUrl('https://x/a.VTT?token=1', ''), true);
  assert.equal(bg.isSubtitleUrl('https://x/sub', 'text/vtt; charset=utf-8'), true);
  assert.equal(bg.isSubtitleUrl('https://x/a.mp4', 'video/mp4'), false);
});

test('fillTemplate: drops tokens with empty placeholders, repeats {sub}', () => {
  const tokens = ['--referrer={referer}', '--sub-file={sub}', '--title={title}', '{url}'];
  const vars = { url: 'http://u', referer: '', title: 'T' };
  deepEqual(bg.fillTemplate(tokens, vars, ['s1', 's2']).slice(), ['--sub-file=s1', '--sub-file=s2', '--title=T', 'http://u']);
  deepEqual(bg.fillTemplate(tokens, { ...vars, referer: 'R' }, []).slice(), ['--referrer=R', '--title=T', 'http://u']);
});

test('tokenizeTemplate: respects double quotes', () => {
  deepEqual(bg.tokenizeTemplate('--a "b c" {url}').slice(), ['--a', 'b c', '{url}']);
  deepEqual(bg.tokenizeTemplate('--opt="x y"').slice(), ['--opt=x y']);
});

test('buildNativeCommand picks the preset from the executable name', () => {
  const ctx = { url: 'http://u/v.m3u8', referer: 'http://page/', ua: 'UA', title: 'Title', cookie: '', subtitles: [{ url: 'http://s/en.vtt' }] };
  run(`settings.externalPlayerPath = 'C:\\\\Program Files\\\\mpv\\\\mpv.exe'; settings.nativeArgsTemplate = '';`);
  const mpv = bg.buildNativeCommand(ctx);
  assert.equal(mpv[0], 'C:\\Program Files\\mpv\\mpv.exe');
  deepEqual(mpv.slice(1).slice(), ['--referrer=http://page/', '--user-agent=UA', '--force-media-title=Title', '--sub-file=http://s/en.vtt', 'http://u/v.m3u8']);

  run(`settings.externalPlayerPath = '"C:\\\\VLC\\\\vlc.exe"';`);
  const vlc = bg.buildNativeCommand({ ...ctx, subtitles: [] });
  assert.equal(vlc[0], 'C:\\VLC\\vlc.exe');
  assert.ok(vlc.includes('--http-referrer=http://page/'));

  run(`settings.externalPlayerPath = 'C:\\\\other\\\\player.exe';`);
  deepEqual(bg.buildNativeCommand(ctx).slice(1).slice(), ['http://u/v.m3u8']);

  run(`settings.externalPlayerPath = ''; settings.nativeArgsTemplate = '--x {url}';`);
  deepEqual(bg.buildNativeCommand(ctx).slice(), ['mpv', '--x', 'http://u/v.m3u8']);

  run(`settings.nativeArgsTemplate = '';`);
  const withCookie = bg.buildNativeCommand({ ...ctx, cookie: 'a=b' });
  assert.ok(withCookie.includes('--http-header-fields=Cookie: a=b'));
});

test('shouldSkipUrl / isStreamUrl keep .ts as a stream pattern', () => {
  assert.equal(bg.isStreamUrl('https://x.example/live/chunk0001.ts'), true);
  assert.equal(bg.shouldSkipUrl('https://x.example/live/chunk0001.ts'), false);
  assert.equal(bg.shouldSkipUrl('https://x.example/app.js'), true);
});

// ── shared.js ────────────────────────────────────────────────────────────────

const shared = (() => {
  const ctx = vm.createContext({ URL, encodeURIComponent });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), ctx);
  return ctx.StreamShared;
})();

test('buildAndroidIntent: explicit package, title and VLC subtitle', () => {
  const url = shared.buildAndroidIntent('https://h.example/v/a.m3u8', 'My Show', 'vlc', 'https://h.example/s.vtt');
  assert.equal(url, 'intent://h.example/v/a.m3u8#Intent;scheme=https;action=android.intent.action.VIEW;type=video/*;package=org.videolan.vlc;S.title=My%20Show;S.subtitles_location=https%3A%2F%2Fh.example%2Fs.vtt;end');
});

test('buildAndroidIntent: generic chooser has no package and ignores subtitles for other players', () => {
  const auto = shared.buildAndroidIntent('http://h/a.mp4', '', 'auto', 'http://s/x.vtt');
  assert.ok(!auto.includes('package=') && !auto.includes('subtitles_location'));
  const mx = shared.buildAndroidIntent('http://h/a.mp4', 'T', 'mx', 'http://s/x.vtt');
  assert.ok(mx.includes('package=com.mxtech.videoplayer.ad;') && !mx.includes('subtitles_location'));
});

test('formatDuration', () => {
  assert.equal(shared.formatDuration(65), '1:05');
  assert.equal(shared.formatDuration(3723), '1:02:03');
  assert.equal(shared.formatDuration(0), '');
});

test('buildProtocolUrl: encoded by default, raw on request, tolerant scheme spelling', () => {
  const url = 'https://h.example/a/b.m3u8?x=1&y=2';
  assert.equal(bg.buildProtocolUrl('vlc://', url, 'encoded'), 'vlc://https%3A%2F%2Fh.example%2Fa%2Fb.m3u8%3Fx%3D1%26y%3D2');
  assert.equal(bg.buildProtocolUrl('vlc', url, undefined), 'vlc://https%3A%2F%2Fh.example%2Fa%2Fb.m3u8%3Fx%3D1%26y%3D2');
  assert.equal(bg.buildProtocolUrl('mpv:', url, 'raw'), `mpv://${url}`);
  assert.equal(bg.buildProtocolUrl('', url, 'raw'), `vlc://${url}`);
});

test('default external method is native messaging', () => {
  assert.equal(run('settings.desktopExternalMethod'), 'native');
  assert.equal(run('settings.protocolUrlFormat'), 'encoded');
});
// ── 1.6 settings migration ──────────────────────────────────────────────────

test('migration: users who had the ⬇️ (native yt-dlp) on keep the native downloader', async () => {
  const loadWith = async (stored) => {
    const ctxBg = (() => {
      const stub = () => new Proxy(function () {}, {
        get: (target, prop) => (Object.prototype.hasOwnProperty.call(target, prop) ? target[prop] : (prop === 'then' ? undefined : stub())),
        apply: () => stub()
      });
      const browser = stub();
      const saved = [];
      browser.storage = { local: { get: () => Promise.resolve({ settings: stored }), set: (v) => { saved.push(v); return Promise.resolve(); }, remove: () => Promise.resolve() }, onChanged: stub() };
      browser.runtime = { id: 'test', onStartup: stub(), onMessage: stub(), onInstalled: stub(), getPlatformInfo: () => Promise.resolve({ os: 'win' }), getURL: p => p };
      browser.contextMenus = undefined;
      browser.commands = undefined;
      const c = vm.createContext({ browser, chrome: browser, console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, navigator: { userAgent: 'T' }, fetch: () => Promise.reject(new Error('x')), btoa });
      vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8'), c);
      vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), c);
      c.__saved = saved;
      return c;
    })();
    await vm.runInContext('settingsReady', ctxBg);
    return vm.runInContext('settings.downloadMethod', ctxBg);
  };
  assert.equal(await loadWith({ showDownloadIcon: true }), 'native');
  assert.equal(await loadWith({ showDownloadIcon: false }), 'browser');
  assert.equal(await loadWith({ showDownloadIcon: true, downloadMethod: 'browser' }), 'browser');
  assert.equal(await loadWith(undefined), 'browser');
});

// ── Phase 3: direct stream links → web player ───────────────────────────────

test('buildLinkRedirectRules: rules per setting, DASH always on Shaka, engine respected', () => {
  const page = p => `chrome-extension://id/${p}`;
  const rules = s => JSON.parse(JSON.stringify(bg.buildLinkRedirectRules(s, page)));
  assert.equal(rules({ openStreamLinks: false, openMp4Links: false }).length, 0);
  const hls = rules({ openStreamLinks: true, webPlayerEngine: 'vidstack' });
  assert.deepEqual(hls.map(r => r.id), [1001, 1002]);
  assert.equal(hls[0].action.redirect.regexSubstitution, 'chrome-extension://id/player.html#\\0');
  assert.equal(hls[1].action.redirect.regexSubstitution, 'chrome-extension://id/player-shaka.html#\\0');
  assert.deepEqual(hls[0].condition.resourceTypes, ['main_frame']);
  const shaka = rules({ openStreamLinks: true, openMp4Links: true, webPlayerEngine: 'shaka' });
  assert.deepEqual(shaka.map(r => r.id), [1001, 1002, 1003]);
  assert.ok(shaka.every(r => r.action.redirect.regexSubstitution.includes('player-shaka.html')));
});

test('link rule regex: only the URL path decides, query strings do not', () => {
  const [hls, dash] = bg.buildLinkRedirectRules({ openStreamLinks: true }, p => p);
  const [, , mp4] = bg.buildLinkRedirectRules({ openStreamLinks: true, openMp4Links: true }, p => p);
  const re = r => new RegExp(r.condition.regexFilter, 'i'); // RE2 and JS agree on this subset
  assert.ok(re(hls).test('https://cdn.example/v/master.m3u8'));
  assert.ok(re(hls).test('https://cdn.example/v/MASTER.M3U8?token=1#t=5'));
  assert.ok(re(dash).test('http://cdn.example/a/manifest.mpd?x=1'));
  assert.ok(re(mp4).test('https://cdn.example/clip.mp4'));
  assert.ok(!re(hls).test('https://site.example/page.html?next=a.m3u8'));
  assert.ok(!re(hls).test('https://site.example/watch#a.m3u8'));
  assert.ok(!re(hls).test('https://site.example/a.m3u8.html'));
  assert.ok(!re(hls).test('chrome-extension://id/player.html?url=https%3A%2F%2Fx%2Fa.m3u8'));
});

// ── Phase 2: subtitle language / label ──────────────────────────────────────

test('describeSubtitle: language from file name, query string or <track>, readable label', () => {
  const d = (url, label, lang) => { const r = shared.describeSubtitle(url, label, lang); return `${r.lang}|${r.label}`; };
  assert.equal(d('https://x/Show.S01E02.en.srt'), 'en|English');
  assert.equal(d('https://x/movie.pt-BR.vtt'), 'pt-BR|Portuguese (BR)');
  assert.equal(d('https://x/subs_eng.vtt'), 'en|English');
  assert.equal(d('https://x/English.srt'), 'en|English');
  assert.equal(d('https://x/en.srt'), 'en|English');
  assert.equal(d('https://x/api/sub?id=4&lang=fr'), 'fr|French');
  assert.equal(d('https://x/Ep1.v190.chi.srt'), 'zh|Chinese');
  // two-letter words inside a name are not languages
  assert.equal(d('https://x/do_it.srt'), '|do_it.srt');
  // a <track> label and srclang win
  assert.equal(d('https://x/a.vtt', 'Director commentary', 'de'), 'de|Director commentary');
  assert.equal(d('https://x/a.vtt', '', 'ja'), 'ja|Japanese');
  // unknown srclang values are kept as they are
  assert.equal(d('https://x/a.vtt', 'Custom', 'xx-custom'), 'xx-custom|Custom');
});

// ── Phase 1: domain rules ────────────────────────────────────────────────────

test('domain rules: whole-label suffix match, not substring', () => {
  assert.equal(shared.matchesDomainList('roads.com.au', ['ads.com']), false);
  assert.equal(shared.matchesDomainList('ads.com', ['ads.com']), true);
  assert.equal(shared.matchesDomainList('x.y.ads.com', ['ads.com']), true);
  assert.equal(shared.matchesDomainList('www.youtube.com', ['youtube']), true);
  assert.equal(shared.matchesDomainList('notyoutube.com', ['youtube']), false);
  assert.equal(shared.matchesDomainList('localhost', ['localhost']), true);
  // entries typed as URLs or with wildcards are normalised
  assert.equal(shared.matchesDomainList('a.example.org', ['https://example.org/path']), true);
  assert.equal(shared.matchesDomainList('a.example.org', ['*.example.org']), true);
  assert.equal(shared.matchesDomainList('', ['example.org']), false);
});

test('domain rules: exact (-), regex (~) and exception (!) prefixes', () => {
  assert.equal(shared.matchesDomainList('www.example.com', ['-example.com']), false);
  assert.equal(shared.matchesDomainList('example.com', ['-example.com']), true);
  assert.equal(shared.matchesDomainList('cdn12.site.net', ['~^cdn\\d+\\.']), true);
  assert.equal(shared.matchesDomainList('cdn.site.net', ['~^cdn\\d+\\.']), false);
  assert.equal(shared.matchesDomainList('good.example.com', ['example.com', '!good.example.com']), false);
  assert.equal(shared.matchesDomainList('bad.example.com', ['example.com', '!good.example.com']), true);
  // an invalid regex is ignored and reported, never thrown
  assert.equal(shared.matchesDomainList('a.com', ['~([']), false);
  assert.equal(shared.validateDomainList(['ok.com', '~([', '# note']).length, 1);
});

test('isDomainAllowed: whitelist beats blacklist, rules use the shared matcher', () => {
  run(`settings.whitelist = ['video.ads.com']; settings.blacklist = ['ads.com'];`);
  assert.equal(bg.isDomainAllowed('video.ads.com'), true);
  assert.equal(bg.isDomainAllowed('www.ads.com'), false);
  assert.equal(bg.isDomainAllowed('roads.com.au'), true);
  run(`settings.whitelist = []; settings.blacklist = [];`);
});

// ── Phase 1: custom patterns ─────────────────────────────────────────────────

test('custom patterns: parse types, flags, comments and errors', () => {
  const text = [
    '# my sites', 'm3u8 /cdn\\.example\\.com\\/play\\/\\d+/i', 'hls /x\\/manifest/', '// c',
    'video /\\/get_file\\//g', 'bogus /a/', 'mp4 nonsense', 'mpd //', 'ts /([/'
  ].join('\n');
  const { rules, errors } = shared.parseCustomPatterns(text);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].type, 'm3u8');
  assert.equal(rules[1].type, 'm3u8'); // alias
  assert.equal(rules[2].re.flags, ''); // g stripped so repeated tests are stateless
  deepEqual(errors.map(e => e.line), [6, 7, 8, 9]);
  assert.equal(shared.matchCustomPattern(text, 'https://CDN.example.com/play/42'), 'm3u8');
  assert.equal(shared.matchCustomPattern(text, 'https://a/get_file/1'), 'video');
  assert.equal(shared.matchCustomPattern(text, 'https://a/get_file/1'), 'video'); // twice: no lastIndex state
  assert.equal(shared.matchCustomPattern(text, 'https://nothing.example/'), null);
});

// ── Phase 1: classification ──────────────────────────────────────────────────

test('classifyUrl: custom patterns override the built-in filters', () => {
  run(`settings.customPatterns = 'm3u8 /cdn\\\\.example\\\\.com\\\\/play\\\\/\\\\d+/\\nsubtitle /captions\\\\/\\\\d+/';`);
  const stream = bg.classifyUrl('https://cdn.example.com/play/42/index.php', '', 'xmlhttprequest');
  assert.equal(stream.kind, 'stream');
  assert.equal(stream.type, 'm3u8');
  assert.equal(bg.classifyUrl('https://a.example/captions/7/en', '', 'xmlhttprequest').kind, 'subtitle');
  assert.equal(bg.classifyUrl('https://cdn.example.com/play/x/index.php', '', 'xmlhttprequest'), null);
  run(`settings.customPatterns = '';`);
  assert.equal(bg.classifyUrl('https://cdn.example.com/play/42/index.php', '', 'xmlhttprequest'), null);
});

test('classifyUrl: stream URL carried in a query parameter', () => {
  const proxied = 'https://proxy.example/get.php?u=' + encodeURIComponent('https://cdn.example/v/master.m3u8?t=1');
  // plain "shouldSkipUrl" rejects every .php URL; the embedded stream makes it a stream anyway
  assert.equal(bg.shouldSkipUrl(proxied), true);
  const found = bg.classifyUrl(proxied, '', 'xmlhttprequest');
  assert.equal(found.kind, 'stream');
  assert.equal(found.type, 'm3u8');
  assert.equal(bg.classifyUrl('https://proxy.example/get.php?u=' + encodeURIComponent('https://cdn.example/clip.mp4'), '', '').type, 'mp4');
  // a tracker that merely mentions a video is still a tracker
  assert.equal(bg.classifyUrl('https://analytics.example/collect.php?v=' + encodeURIComponent('https://cdn.example/clip.mp4'), '', ''), null);
  // ordinary query parameters are not mistaken for streams
  assert.equal(bg.classifyUrl('https://site.example/page.php?next=' + encodeURIComponent('https://other.example/index.html'), '', ''), null);
});

test('classifyUrl: "media" requests are streams unless they are audio', () => {
  assert.equal(bg.classifyUrl('https://cdn.example/get?id=42&sig=abcdef', 'video/mp4', 'media').kind, 'stream');
  assert.equal(bg.classifyUrl('https://cdn.example/get?id=42&sig=abcdef', '', 'media').kind, 'stream');
  assert.equal(bg.classifyUrl('https://cdn.example/get?id=42&sig=abcdef', 'audio/mpeg', 'media'), null);
  assert.equal(bg.classifyUrl('https://cdn.example/get?id=42&sig=abcdef', '', 'xmlhttprequest'), null);
  assert.equal(bg.classifyUrl('blob:https://cdn.example/1234', '', 'media'), null);
  assert.equal(bg.getStreamType('https://cdn.example/get?id=42', 'video/mp4'), 'mp4');
});

test('isUsableStatus: errors and empty responses are ignored', () => {
  for (const code of [404, 403, 500, 204]) assert.equal(bg.isUsableStatus(code), false);
  for (const code of [200, 206, 301, 302, 304, undefined]) assert.equal(bg.isUsableStatus(code), true);
});

// ── Phase 1: page titles ─────────────────────────────────────────────────────

test('cleanPageTitle: site name, filler and episode numbers', () => {
  const t = (title, host) => shared.cleanPageTitle(title, host).title;
  assert.equal(t('Watch Dark Matter Season 1 Episode 5 Online Free - KissKH', 'kisskh.co'), 'Dark Matter S01E05');
  assert.equal(t('Dark Matter S01E05 | Netflix', 'www.netflix.com'), 'Dark Matter S01E05');
  assert.equal(t('Dark Matter - Episode 12 - Watch Online Free', 'example.org'), 'Dark Matter E12');
  assert.equal(t('Big Buck Bunny (2008) - Example Movies', 'examplemovies.net'), 'Big Buck Bunny (2008)');
  assert.equal(t('Chapter 3: The Return', 'learn.example.edu'), 'Chapter 3: The Return');
  const info = shared.cleanPageTitle('Dark Matter Season 2 Episode 7 - Site', 'site.tv');
  assert.deepEqual([info.name, info.season, info.episode], ['Dark Matter', 2, 7]);
});

test('cleanPageTitle: real titles that look like filler survive', () => {
  const t = (title, host) => shared.cleanPageTitle(title, host).title;
  assert.equal(t('Born Free', 'example.com'), 'Born Free');
  assert.equal(t('Free Guy', 'example.com'), 'Free Guy');
  assert.equal(t('Watch Born Free Online Free', 'example.com'), 'Born Free');
  assert.equal(t('The Online Dating Show', 'example.com'), 'The Online Dating Show');
});

test('cleanPageTitle: non-Latin titles are kept, URL-like or empty titles give nothing', () => {
  const t = (title, host) => shared.cleanPageTitle(title, host).title;
  assert.equal(t('进击的巨人 第一季 - bilibili', 'www.bilibili.com'), '进击的巨人 第一季');
  assert.equal(t('Тихий Дон — серия 3 | rutube', 'rutube.ru'), 'Тихий Дон E03');
  assert.equal(t('', 'example.com'), '');
  assert.equal(t('https://example.com/watch?v=1', 'example.com'), '');
  // a title that is only the site name is no use as a name: callers fall back to the file name
  assert.equal(t('KissKH', 'kisskh.co'), '');
});

