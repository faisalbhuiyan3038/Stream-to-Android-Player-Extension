// Local test site used by the browser tests. Nothing here needs the internet.
const http = require('http');

const PORT = 8099;
const ORIGIN = `http://localhost:${PORT}`;
const ALT_ORIGIN = `http://127.0.0.1:${PORT}`; // a different host, like a separate CDN

const MEDIA = (type) => type;

function page(title, body) {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function startServer() {
  const log = { secureReferers: [] };
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

    // ── media ────────────────────────────────────────────────
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

    send(404, 'text/plain', 'not found');
  });
  return new Promise(resolve => server.listen(PORT, () => resolve({ server, log, ORIGIN, ALT_ORIGIN, MEDIA })));
}

module.exports = { startServer, ORIGIN, ALT_ORIGIN, PORT };
