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