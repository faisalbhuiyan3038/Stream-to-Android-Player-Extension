// Generates tests/e2e/fixtures/clip.webm: a real, playable 30-second VP8 clip (moving square),
// recorded from a canvas with Chromium's MediaRecorder. There is no ffmpeg on the dev machine;
// the browser tests need a real video so the web players can load it and attach subtitles.
//   node tests/e2e/make-fixture.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, 'fixtures', 'clip.webm');

async function makeClip() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext('2d');
    const stream = canvas.captureStream(25);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 60000 });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    const start = performance.now();
    await new Promise(resolve => {
      const draw = () => {
        const t = (performance.now() - start) / 1000;
        g.fillStyle = '#123';
        g.fillRect(0, 0, 320, 180);
        g.fillStyle = '#4caf50';
        g.fillRect(20 + (t * 40) % 260, 70, 40, 40);
        if (t < 30) requestAnimationFrame(draw); else resolve();
      };
      draw();
    });
    rec.stop();
    await done;
    const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  });
  await browser.close();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  return OUT;
}

// ─── fMP4 HLS fixture ────────────────────────────────────────────────────────
// tests/e2e/fixtures/hls/: init.mp4, seg<N>.m4s, index.m3u8. Recorded as H.264 fragmented MP4
// (Chromium's MediaRecorder, which on Windows uses the OS encoder), then split at the top-level
// boxes: ftyp+moov = init segment, each moof+mdat = one media segment. Durations come from
// the fragments' own decode timestamps (tfdt) and the track timescale (mdhd).
const HLS_DIR = path.join(__dirname, 'fixtures', 'hls');

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p, end: p + size, body: p + header });
    p += size;
  }
  return out;
}
const child = (buf, box, type) => boxes(buf, box.body, box.end).find(b => b.type === type);

function trackTimescale(buf, moov) {
  const trak = child(buf, moov, 'trak');
  const mdhd = child(buf, child(buf, trak, 'mdia'), 'mdhd');
  const version = buf[mdhd.body];
  return buf.readUInt32BE(mdhd.body + (version === 1 ? 20 : 12));
}

function fragmentTime(buf, moof) {
  const tfdt = child(buf, child(buf, moof, 'traf'), 'tfdt');
  const version = buf[tfdt.body];
  return version === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4);
}

function splitFmp4(buf) {
  const top = boxes(buf);
  const moovIdx = top.findIndex(b => b.type === 'moov');
  if (moovIdx === -1) throw new Error(`not an MP4: ${top.map(b => b.type).join(',')}`);
  const init = buf.subarray(0, top[moovIdx].end);
  const timescale = trackTimescale(buf, top[moovIdx]);
  const frags = [];
  for (let i = moovIdx + 1; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    const mdat = top[i + 1] && top[i + 1].type === 'mdat' ? top[i + 1] : null;
    if (!mdat) continue;
    frags.push({ data: buf.subarray(top[i].start, mdat.end), t: fragmentTime(buf, top[i]) / timescale });
  }
  return { init, frags };
}

async function makeHls({ seconds = 24, fragmentMs = 2000 } = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const b64 = await page.evaluate(async ({ seconds, fragmentMs }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext('2d');
    const stream = canvas.captureStream(25);
    const rec = new MediaRecorder(stream, {
      mimeType: 'video/mp4;codecs=avc1.42E01E', videoBitsPerSecond: 150000,
      videoKeyFrameIntervalDuration: fragmentMs
    });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(fragmentMs);
    const start = performance.now();
    await new Promise(resolve => {
      const draw = () => {
        const t = (performance.now() - start) / 1000;
        g.fillStyle = '#231';
        g.fillRect(0, 0, 320, 180);
        g.fillStyle = '#ffb300';
        g.fillRect(20 + (t * 40) % 260, 70, 40, 40);
        g.fillStyle = '#fff';
        g.font = '20px sans-serif';
        g.fillText(t.toFixed(1), 10, 30);
        if (t < seconds) requestAnimationFrame(draw); else resolve();
      };
      draw();
    });
    rec.stop();
    await done;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }, { seconds, fragmentMs });
  await browser.close();

  const { init, frags } = splitFmp4(Buffer.from(b64, 'base64'));
  if (frags.length < 3) throw new Error(`only ${frags.length} fragments`);
  fs.rmSync(HLS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(HLS_DIR, 'init.mp4'), init);
  const avg = (frags[frags.length - 1].t - frags[0].t) / Math.max(1, frags.length - 1);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MAP:URI="init.mp4"'];
  let target = 0;
  const segLines = [];
  frags.forEach((f, i) => {
    const dur = i + 1 < frags.length ? frags[i + 1].t - f.t : avg;
    target = Math.max(target, Math.ceil(dur));
    fs.writeFileSync(path.join(HLS_DIR, `seg${i}.m4s`), f.data);
    segLines.push(`#EXTINF:${dur.toFixed(3)},`, `seg${i}.m4s`);
  });
  lines.splice(2, 0, `#EXT-X-TARGETDURATION:${target}`);
  fs.writeFileSync(path.join(HLS_DIR, 'index.m3u8'), [...lines, ...segLines, '#EXT-X-ENDLIST', ''].join('\n'));
  return { dir: HLS_DIR, segments: frags.length };
}

// Records `seconds` of a tone as fragmented MP4 audio (AAC if the browser can, else Opus)
async function recordAudioFmp4(seconds, fragmentMs) {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const { b64, mime } = await page.evaluate(async ({ seconds, fragmentMs }) => {
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const mime = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(fragmentMs);
    await new Promise(r => setTimeout(r, seconds * 1000));
    rec.stop();
    await done;
    osc.stop();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { b64: btoa(s), mime };
  }, { seconds, fragmentMs });
  await browser.close();
  return { data: Buffer.from(b64, 'base64'), mime };
}

function writeMediaPlaylist(name, prefix, init, frags) {
  const avg = (frags[frags.length - 1].t - frags[0].t) / Math.max(1, frags.length - 1);
  fs.writeFileSync(path.join(HLS_DIR, `${prefix}init.mp4`), init);
  const segLines = [];
  let target = 0;
  frags.forEach((f, i) => {
    const dur = i + 1 < frags.length ? frags[i + 1].t - f.t : avg;
    target = Math.max(target, Math.ceil(dur));
    fs.writeFileSync(path.join(HLS_DIR, `${prefix}seg${i}.m4s`), f.data);
    segLines.push(`#EXTINF:${dur.toFixed(3)},`, `${prefix}seg${i}.m4s`);
  });
  fs.writeFileSync(path.join(HLS_DIR, name), ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-MAP:URI="${prefix}init.mp4"`, ...segLines, '#EXT-X-ENDLIST', ''].join('\n'));
}

// Separate audio rendition + master playlist (video index.m3u8 + audio group), and an
// AES-128 encrypted copy of the video playlist (enc.m3u8, enc.key), both in HLS_DIR.
async function makeHlsExtras({ seconds = 24, fragmentMs = 2000 } = {}) {
  const crypto = require('crypto');
  const { data, mime } = await recordAudioFmp4(seconds, fragmentMs);
  const audio = splitFmp4(data);
  writeMediaPlaylist('audio.m3u8', 'a-', audio.init, audio.frags);
  const audioCodec = /opus/.test(mime) ? 'opus' : 'mp4a.40.2';
  fs.writeFileSync(path.join(HLS_DIR, 'master.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:7',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=320x180,CODECS="avc1.42e01e,${audioCodec}",AUDIO="aud"`,
    'index.m3u8', ''
  ].join('\n'));

  // AES-128: every segment (and the init segment) encrypted whole, CBC + PKCS7, explicit IV
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  // (named enc.key: this Chromium build answers a fetch of exactly /hls-real/key.bin with an empty 204)
  fs.writeFileSync(path.join(HLS_DIR, 'enc.key'), key);
  const enc = buf => { const c = crypto.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([c.update(buf), c.final()]); };
  const src = fs.readFileSync(path.join(HLS_DIR, 'index.m3u8'), 'utf8').split('\n');
  const out = [];
  for (const line of src) {
    if (line.startsWith('#EXT-X-MAP')) {
      // MAP first: a KEY before the MAP would mean the init segment is encrypted too; it stays clear
      out.push(line);
      out.push(`#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x${iv.toString('hex')}`);
    } else if (line.endsWith('.m4s')) {
      fs.writeFileSync(path.join(HLS_DIR, `enc-${line}`), enc(fs.readFileSync(path.join(HLS_DIR, line))));
      out.push(`enc-${line}`);
    } else {
      out.push(line);
    }
  }
  fs.writeFileSync(path.join(HLS_DIR, 'enc.m3u8'), out.join('\n'));
  return { audioMime: mime, audioSegments: audio.frags.length };
}

if (require.main === module) {
  const which = process.argv[2] || 'all';
  (async () => {
    if (which === 'all' || which === 'webm') {
      const p = await makeClip();
      console.log(`[OK] ${p} (${fs.statSync(p).size} bytes)`);
    }
    if (which === 'all' || which === 'hls') {
      const r = await makeHls();
      console.log(`[OK] ${r.dir} (${r.segments} segments)`);
    }
    if (which === 'all' || which === 'hls' || which === 'hls-extras') {
      const x = await makeHlsExtras();
      console.log(`[OK] audio rendition (${x.audioMime}, ${x.audioSegments} segments), master.m3u8, enc.m3u8 + enc.key`);
    }
  })().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { makeClip, makeHls, splitFmp4, OUT, HLS_DIR };
