// Local test site used by the browser tests. Nothing here needs the internet.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8099;
const ORIGIN = `http://localhost:${PORT}`;
const ALT_ORIGIN = `http://127.0.0.1:${PORT}`; // a different host, like a separate CDN

const MEDIA = (type) => type;

function page(title, body) {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function startServer() {
  const log = { secureReferers: [], cookies: [], segments: [], big: [], flaky: {} };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', ...extra });
      res.end(body);
    };
    const html = (title, body) => send(200, 'text/html', page(title, body));
    const m3u8 = body => send(200, 'application/vnd.apple.mpegurl', body);

    // ── pages ────────────────────────────────────────────────
    if (url === '/p/blank') return html('Blank', 'blank');
    if (url === '/p/early') return html('Early', `<script>fetch('/hls/early.m3u8')</script>`);
    if (url === '/p/video') return html('Video', `<video src="${ORIGIN}/media/clip_1080p.mp4" controls></video>`);
    if (url === '/p/ts-only') return html('TS only', `<script>fetch('/live/chunk0001.ts')</script>`);
    if (url === '/p/segments') {
      return html('Segments', `<script>
        fetch('/seg/index.m3u8').then(() => setTimeout(() => {
          fetch('${ALT_ORIGIN}/seg/index0.ts'); fetch('${ALT_ORIGIN}/seg/index1.ts');
        }, 300));</script>`);
    }
    if (url === '/p/ts-before-playlist') {
      // segments arrive first, the playlist after: the playlist must evict them
      return html('TS first', `<script>
        fetch('${ALT_ORIGIN}/seg/index0.ts').then(() => setTimeout(() => fetch('/seg/index.m3u8'), 300));</script>`);
    }
    if (url === '/p/master') return html('Master', `<script>fetch('/master/master.m3u8')</script>`);
    if (url === '/p/subs') {
      return html('Subs', `<video src="${ORIGIN}/media/clip_720p.mp4" controls>
        <track src="${ORIGIN}/subs/en.vtt" label="English" srclang="en" default></video>
        <script>fetch('/subs/fr.srt')</script>`);
    }
    if (url === '/p/secure') return html('Secure', `<script>fetch('/secure/index.m3u8')</script>`);
    if (url === '/p/dash') return html('Dash', `<script>fetch('/dash/manifest.mpd')</script>`);
    if (url === '/p/dash-real') return html('Dash Real', `<script>fetch('/dash-real/manifest.mpd')</script>`);
    // Phase 1 fixtures
    if (url === '/p/titled') {
      return html('Watch Dark Matter Season 1 Episode 5 Online Free - Localhost', `<script>fetch('/hls/early.m3u8')</script>`);
    }
    if (url === '/p/missing') return html('Missing', `<script>fetch('/hls/missing.m3u8')</script>`);
    if (url === '/p/proxied') {
      return html('Proxied', `<script>fetch('/proxy.php?u=' + encodeURIComponent('${ORIGIN}/hls/early.m3u8'))</script>`);
    }
    if (url === '/p/custom') return html('Custom', `<script>fetch('/api/play/42')</script>`);
    if (url === '/p/media') return html('Media', `<video src="${ORIGIN}/get?id=7" controls muted></video>`);
    if (url === '/p/late-title') {
      return html('localhost', `<script>setTimeout(() => { document.title = 'Big Buck Bunny (2008) - Localhost'; }, 1500); fetch('/hls/early.m3u8')</script>`);
    }
    // A real fMP4 HLS stream (tests/e2e/fixtures/hls, made by make-fixture.js). Under /slow-hls/
    // every segment answers after 400 ms, like a distant CDN; each request is logged with its
    // start/end time so tests can see how many ran at once.
    const hlsMatch = /^\/(hls-real|slow-hls|crawl-hls)\/([\w.-]+)$/.exec(url);
    if (hlsMatch) {
      const file = path.join(__dirname, 'fixtures', 'hls', hlsMatch[2]);
      if (!fs.existsSync(file)) return send(404, 'text/plain', 'run npm run make-fixture');
            const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : /\.(bin|key)$/.test(file) ? 'application/octet-stream' : 'video/mp4';
      const isSegment = file.endsWith('.m4s');
      if (hlsMatch[1] !== 'hls-real' && isSegment) {
        const entry = { file: hlsMatch[2], start: Date.now(), end: 0 };
        log.segments.push(entry);
        // crawl-hls: 1.2 s per segment, slow enough to act while the whole video is loading
        return setTimeout(() => { entry.end = Date.now(); send(200, type, fs.readFileSync(file)); }, hlsMatch[1] === 'crawl-hls' ? 1200 : 400);
      }
      return send(200, type, fs.readFileSync(file));
    }

    // The fixture as DASH (the same fMP4 segments): video + separate audio AdaptationSets,
    // SegmentList with a SegmentTimeline built from the HLS playlists' durations
    if (url === '/dash-real/manifest.mpd') {
      const read = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'hls', name), 'utf8').split(/\r?\n/);
      const entries = (lines) => {
        const out = [];
        for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXTINF:')) out.push({ d: Math.round(parseFloat(lines[i].slice(8)) * 1000), uri: lines[i + 1] });
        return out;
      };
      const v = entries(read('index.m3u8'));
      const a = entries(read('audio.m3u8'));
      const total = v.reduce((n, e) => n + e.d, 0) / 1000;
      const list = (es, init) => `<SegmentList timescale="1000"><Initialization sourceURL="${ORIGIN}/hls-real/${init}"/><SegmentTimeline>${es.map(e => `<S d="${e.d}"/>`).join('')}</SegmentTimeline>${es.map(e => `<SegmentURL media="${ORIGIN}/hls-real/${e.uri}"/>`).join('')}</SegmentList>`;
      return send(200, 'application/dash+xml', `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${total.toFixed(3)}S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
<Period id="0">
<AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true"><Representation id="v360" bandwidth="250000" width="320" height="180" codecs="avc1.42e01e">${list(v, 'init.mp4')}</Representation></AdaptationSet>
<AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en"><Representation id="a" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="48000">${list(a, 'a-init.mp4')}</Representation></AdaptationSet>
</Period>
</MPD>`);
    }

    // Two qualities of the fixture stream (same media, different addresses): 360p and 720p
    if (url === '/multi-hls/master.m3u8') {
      return m3u8(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,CODECS="avc1.42e01e"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,CODECS="avc1.42e01e"
high.m3u8
`);
    }
    const multiMatch = /^\/multi-hls\/(low|high)\.m3u8$/.exec(url);
    if (multiMatch) {
      const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'hls', 'index.m3u8'), 'utf8');
      return m3u8(src.split(/\r?\n/).map(l => l.replace('URI="init.mp4"', `URI="${ORIGIN}/hls-real/init.mp4"`)
        .replace(/^(seg\d+\.m4s)$/, `${ORIGIN}/hls-real/$1?q=${multiMatch[1]}`)).join('\n'));
    }

    // The fixture stream on an unreliable server: every segment fails twice (503, then 429 with
    // Retry-After: 1) before it is served. The whole-video download must still get all of them.
    const flakyMatch = /^\/flaky-hls\/([\w.-]+)$/.exec(url);
    if (flakyMatch) {
      const file = path.join(__dirname, 'fixtures', 'hls', flakyMatch[1]);
      if (!fs.existsSync(file)) return send(404, 'text/plain', 'missing');
      if (file.endsWith('.m4s')) {
        const n = log.flaky[flakyMatch[1]] = (log.flaky[flakyMatch[1]] || 0) + 1;
        if (n === 1) return send(503, 'text/plain', 'busy');
        if (n === 2) return send(429, 'text/plain', 'slow down', { 'retry-after': '1' });
      }
      return send(200, file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', fs.readFileSync(file));
    }

    // The fixture stream with a subtitle track in the master playlist: two WebVTT segments with
    // X-TIMESTAMP-MAP (the second one repeats a cue that spans the segment boundary)
    if (url === '/hls-subs/master.m3u8') {
      return m3u8(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="de",DEFAULT=YES,AUTOSELECT=YES,URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=320x180,CODECS="avc1.42e01e",SUBTITLES="subs"
/hls-real/index.m3u8
`);
    }
    if (url === '/hls-subs/subs.m3u8') {
      return m3u8(`#EXTM3U
#EXT-X-TARGETDURATION:12
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:12,
sub0.vtt
#EXTINF:12,
sub1.vtt
#EXT-X-ENDLIST
`);
    }
    const subSeg = /^\/hls-subs\/sub([01])\.vtt$/.exec(url);
    if (subSeg) {
      const head = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:10.000\n\n';
      const border = '00:11.000 --> 00:13.000\n\u00dcber die Grenze\n';
      return send(200, 'text/vtt', head + (subSeg[1] === '0'
        ? '00:01.000 --> 00:03.000\nGuten <i>Tag</i>\n\n' + border
        : border + '\n00:20.000 --> 00:22.000\nAuf Wiedersehen\n'));
    }

    // A long stream for the downloader's memory test: the 12 fixture segments repeated 5 times
    // (60 segments), each followed by a 1 MB 'free' box, ~61 MB in total
    if (url === '/big-hls/index.m3u8') {
      const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'hls', 'index.m3u8'), 'utf8').split(/\r?\n/);
      const head = src.filter(l => l.startsWith('#EXT') && !l.startsWith('#EXTINF') && !l.startsWith('#EXT-X-ENDLIST'))
        .map(l => l.replace('URI="init.mp4"', `URI="${ORIGIN}/hls-real/init.mp4"`));
      const pairs = [];
      for (let i = 0; i < src.length; i++) if (src[i].startsWith('#EXTINF')) pairs.push([src[i], src[i + 1]]);
      const body = [];
      for (let r = 0; r < 5; r++) for (const [inf, seg] of pairs) body.push(inf, `pad/${seg}?r=${r}`);
      return m3u8([...head, ...body, '#EXT-X-ENDLIST', ''].join('\n'));
    }
    const padMatch = /^\/big-hls\/pad\/(seg\d+\.m4s)$/.exec(url);
    if (padMatch) {
      log.big.push(req.url);
      const seg = fs.readFileSync(path.join(__dirname, 'fixtures', 'hls', padMatch[1]));
      const free = Buffer.alloc(1024 * 1024);
      free.writeUInt32BE(free.length, 0);
      free.write('free', 4, 'latin1');
      return send(200, 'video/mp4', Buffer.concat([seg, free]));
    }

    if (url === '/p/real-hls') {
      return html('Watch Test Clip Episode 2 Online Free - Localhost', `<script>fetch('/hls-real/index.m3u8')</script>`);
    }

    // A phone-style page (viewport meta), for the mobile layout audit
    if (url === '/p/mobile') {
      return send(200, 'text/html', `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mobile</title></head>
        <body style="margin:0;font-family:sans-serif"><h1 style="font-size:20px;padding:12px">Episode page</h1>
        <video src="${ORIGIN}/media/clip_720p.mp4" style="width:100%"></video><script>fetch('/master/master.m3u8')</script></body></html>`);
    }

    // Phase 4 fixtures
    // an embed: the stream is only in the iframe's DOM (no request), on another host
    if (url === '/p/iframe') return html('Iframe', `<iframe src="${ALT_ORIGIN}/p/inner" width="400" height="300"></iframe>`);
    if (url === '/p/inner') return html('Inner', `<div data-source="${ALT_ORIGIN}/hls/frame.m3u8"></div>`);
    // a playlist fetched by the page's service worker (webRequest tabId -1)
    if (url === '/p/sw') {
      return html('Worker', `<script>
        navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
          .then(reg => setTimeout(() => reg.active.postMessage('go'), 300));</script>`);
    }
    if (url === '/sw.js') {
      return send(200, 'application/javascript', `
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
        self.addEventListener('message', e => { if (e.data === 'go') fetch('/hls/sw.m3u8'); });`);
    }
    if (url === '/hls/sw.m3u8' || url === '/hls/frame.m3u8') return m3u8('#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
    // a playlist that needs the page's cookie
    if (url === '/p/cookie') return html('Cookie', `<script>document.cookie = 'sap=yes; path=/'; fetch('/cookie/index.m3u8')</script>`);
    if (url === '/cookie/index.m3u8') {
      log.cookies.push(req.headers.cookie || null);
      if (!/(^|;\s*)sap=yes/.test(req.headers.cookie || '')) return send(403, 'text/plain', 'cookie required');
      return m3u8('#EXTM3U\n#EXTINF:5.0,\ns0.ts\n#EXT-X-ENDLIST\n');
    }
    if (url === '/proxy.php') return m3u8('#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
    if (url === '/api/play/42') return send(200, 'text/plain', '#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
    if (url === '/get') return send(200, 'application/octet-stream', 'x');

    // ── media ────────────────────────────────────────────────
    // A real, playable 3 s WebM (tests/e2e/fixtures/clip.webm, made by make-fixture.js)
    if (url === '/media/real.webm') {
      const file = path.join(__dirname, 'fixtures', 'clip.webm');
      if (!fs.existsSync(file)) return send(404, 'text/plain', 'run npm run make-fixture');
      const data = fs.readFileSync(file);
      // Byte ranges, so the browser can seek (resume tests)
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? +range[1] : 0;
        const end = range[2] ? Math.min(+range[2], data.length - 1) : data.length - 1;
        return send(206, 'video/webm', data.subarray(start, end + 1), {
          'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${data.length}`
        });
      }
      return send(200, 'video/webm', data, { 'accept-ranges': 'bytes' });
    }
    if (url.startsWith('/media/')) return send(200, 'video/mp4', 'x');
    if (url === '/live/chunk0001.ts') return send(200, 'video/mp2t', 'x');
    if (url.startsWith('/seg/index') && url.endsWith('.ts')) return send(200, 'video/mp2t', 'x');
    if (url === '/hls/early.m3u8') return m3u8('#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST\n');
    if (url === '/seg/index.m3u8') {
      return m3u8(`#EXTM3U\n#EXTINF:4.0,\n${ALT_ORIGIN}/seg/index0.ts\n#EXTINF:4.0,\n${ALT_ORIGIN}/seg/index1.ts\n#EXT-X-ENDLIST\n`);
    }
    if (url === '/master/master.m3u8') {
      return m3u8([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480', 'v480/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028"', 'v1080/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720', 'v720/index.m3u8',
        ''
      ].join('\n'));
    }
    if (/^\/master\/v\d+\/index\.m3u8$/.test(url)) {
      return m3u8('#EXTM3U\n#EXTINF:30.0,\ns0.ts\n#EXTINF:30.0,\ns1.ts\n#EXT-X-ENDLIST\n');
    }
    if (url === '/secure/index.m3u8') {
      log.secureReferers.push(req.headers.referer || null);
      if (!req.headers.referer || !req.headers.referer.startsWith(`${ORIGIN}/p/`)) {
        return send(403, 'text/plain', 'referer required');
      }
      return m3u8('#EXTM3U\n#EXTINF:5.0,\ns0.ts\n#EXT-X-ENDLIST\n');
    }
    if (url === '/dash/manifest.mpd') {
      return send(200, 'application/dash+xml', `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT0H1M30S" type="static"><Period><AdaptationSet>
<Representation id="a" bandwidth="500000" width="640" height="360"/>
<Representation id="b" bandwidth="4000000" width="1920" height="1080"/>
</AdaptationSet></Period></MPD>`);
    }

    // ── subtitles ────────────────────────────────────────────
    if (url === '/subs/en.vtt') return send(200, 'text/vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n');
    if (url === '/subs/fr.srt') return send(200, 'application/x-subrip', '1\n00:00:00,000 --> 00:00:02,000\nBonjour\n');
    // Windows-1252 bytes ("Café “quoted”"), no charset: must not turn into U+FFFD
    if (url === '/subs/cp1252.srt') {
      const text = Buffer.concat([
        Buffer.from('1\r\n00:00:00,000 --> 00:00:03,000\r\nCaf'), Buffer.from([0xe9, 0x20, 0x93]),
        Buffer.from('quoted'), Buffer.from([0x94, 0x0d, 0x0a])
      ]);
      return send(200, 'application/octet-stream', text);
    }
    if (url === '/subs/styled.ass') {
      return send(200, 'text/plain', [
        '[Script Info]', 'ScriptType: v4.00+', '', '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\i1}Styled{\\i0} line, with comma'
      ].join('\n'));
    }
    if (url === '/subs/caps.ttml') {
      return send(200, 'application/ttml+xml', '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>' +
        '<p begin="00:00:00.000" end="00:00:03.000">TTML caption</p></div></body></tt>');
    }

    send(404, 'text/plain', 'not found');
  });
  return new Promise(resolve => server.listen(PORT, () => resolve({ server, log, ORIGIN, ALT_ORIGIN, MEDIA })));
}

module.exports = { startServer, ORIGIN, ALT_ORIGIN, PORT };
