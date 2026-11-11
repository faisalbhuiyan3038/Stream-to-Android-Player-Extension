// Subtitle loading and conversion to WebVTT for the built-in web players.
// Formats: WebVTT (passed through), SRT, ASS/SSA, YouTube timed text (format 1 <text> and srv3 <p t d>),
// TTML/DFXP. No DOM APIs are used, so the module also runs in Node for the unit tests.
// The SRT path is adapted from FastStream (chrome/player/utils/SubtitleUtils.mjs): cue splitting
// without blank lines, '.'-or-',' milliseconds, short millisecond fields, {\anN} alignment tags.

// ─── helpers ─────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[ref.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Cue text must not contain a raw '<' (tag start), '&' (entity) or '-->' (timing line).
function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function vttTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

// Keeps <i>/<b>/<u> properly nested: drops a close tag with no matching open (or an open that is
// already open), and closes whatever is still open at the end. Text is otherwise untouched.
function balanceTags(text) {
  const open = [];
  const out = text.replace(/<(\/?)([ibu])>/g, (m, slash, tag) => {
    if (!slash) {
      if (open.includes(tag)) return '';
      open.push(tag);
      return m;
    }
    const at = open.lastIndexOf(tag);
    if (at === -1) return '';
    // close inner tags first so nesting stays valid, then reopen them
    const inner = open.splice(at);
    inner.shift();
    open.push(...inner);
    return inner.slice().reverse().map(t => `</${t}>`).join('') + `</${tag}>` + inner.map(t => `<${t}>`).join('');
  });
  return out + open.slice().reverse().map(t => `</${t}>`).join('');
}

function buildVtt(cues) {
  const out = ['WEBVTT', ''];
  cues
    .filter(c => c.text && c.text.trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .forEach(c => {
      out.push(`${vttTime(c.start)} --> ${vttTime(c.end)}${c.settings ? ' ' + c.settings : ''}`);
      out.push(c.text.replace(/\n{2,}/g, '\n').trim());
      out.push('');
    });
  return out.join('\n');
}

// {\anN} numpad alignment (ASS and many SRT files) → WebVTT cue settings
const ALIGNMENT = {
  1: 'line:95% position:5% align:start',
  2: 'line:95% position:50% align:center',
  3: 'line:95% position:95% align:end',
  4: 'line:50% position:5% align:start',
  5: 'line:50% position:50% align:center',
  6: 'line:50% position:95% align:end',
  7: 'line:5% position:5% align:start',
  8: 'line:5% position:50% align:center',
  9: 'line:5% position:95% align:end'
};

// ─── format detection ────────────────────────────────────────────────────────

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const SRT_TIMING = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?\s*--?>\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;

export function detectFormat(text, url = '', contentType = '') {
  const t = stripBom(String(text || '')).trimStart();
  if (/^WEBVTT/.test(t)) return 'vtt';
  if (/^\[Script Info\]/im.test(t) || /^\[(V4\+?|V4) Styles\]/im.test(t) || /^Dialogue:\s*\d*\s*,/m.test(t)) return 'ass';
  if (/<tt[\s>:]/i.test(t) || /<(\w+:)?tt\b/i.test(t)) return 'ttml';
  if (/<transcript[\s>]/i.test(t) || /<timedtext[\s>]/i.test(t)) return 'timedtext';
  if (SRT_TIMING.test(t)) return 'srt';
  const path = String(url).toLowerCase().split(/[?#]/)[0];
  const ct = String(contentType).toLowerCase();
  if (path.endsWith('.vtt') || ct.includes('text/vtt')) return 'vtt';
  if (path.endsWith('.srt') || ct.includes('subrip')) return 'srt';
  if (path.endsWith('.ass') || path.endsWith('.ssa')) return 'ass';
  if (/\.(ttml|dfxp)$/.test(path) || ct.includes('ttml')) return 'ttml';
  return 'unknown';
}

// ─── SRT ─────────────────────────────────────────────────────────────────────

function srtSeconds(h, m, s, ms) {
  // Short millisecond fields are a number of milliseconds (",5" is 5 ms, as ffmpeg and VLC read them)
  return (+h || 0) * 3600 + (+m) * 60 + (+s) + (ms ? +ms : 0) / 1000;
}

// Splits SRT text into cue blocks at blank lines and also at a timing line that has no
// blank line before it (with its sequence number). From FastStream's splitAtCueStarts.
function splitSrtBlocks(text) {
  const blocks = [];
  for (const block of text.split(/\n[ \t ]*\n+/)) {
    const lines = block.split('\n');
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!SRT_TIMING.test(lines[i]) || !/-->|->/.test(lines[i])) continue;
      const cueStart = i > start && /^\d+$/.test(lines[i - 1].trim()) ? i - 1 : i;
      if (cueStart > start) {
        blocks.push(lines.slice(start, cueStart).join('\n'));
        start = cueStart;
      }
    }
    blocks.push(lines.slice(start).join('\n'));
  }
  return blocks.map(b => b.replace(/\s+$/, '')).filter(Boolean);
}

// Basic SRT markup → WebVTT: <i>/<b>/<u> kept, <font> and other tags dropped, {\anN} → settings.
function convertSrtText(raw) {
  let settings = '';
  let text = raw.replace(/\{\\?an(\d)\}/gi, (m, n) => { settings = settings || ALIGNMENT[n] || ''; return ''; });
  text = text
    .replace(/\{\\([ibu])1\}/gi, '<$1>').replace(/\{\\([ibu])0?\}/gi, '</$1>')
    .replace(/\{([ibu])\}/gi, '<$1>').replace(/\{\/([ibu])\}/gi, '</$1>')
    .replace(/\\h/g, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n');
  // Escape everything, then restore the three formatting tags WebVTT shares with SRT
  // Only things shaped like tags (<font …>, </span>) are dropped; "a < b" is text
  text = escapeText(decodeEntities(text.replace(/<(?!\/?[ibu]>)\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>/gi, '')))
    .replace(/&lt;(\/?)([ibu])&gt;/gi, (m, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
  return { text: balanceTags(text), settings };
}

export function srtToVtt(input) {
  const text = stripBom(String(input)).replace(/\r\n?/g, '\n').trim();
  const cues = [];
  for (const block of splitSrtBlocks(text)) {
    const lines = block.split('\n');
    const idx = lines.findIndex(l => SRT_TIMING.test(l));
    if (idx === -1) continue;
    const m = SRT_TIMING.exec(lines[idx]);
    const body = lines.slice(idx + 1).join('\n');
    if (!body.trim()) continue;
    const { text: cueText, settings } = convertSrtText(body);
    cues.push({ start: srtSeconds(m[1], m[2], m[3], m[4]), end: srtSeconds(m[5], m[6], m[7], m[8]), text: cueText, settings });
  }
  return buildVtt(cues);
}

// ─── ASS / SSA ───────────────────────────────────────────────────────────────

function assSeconds(t) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t.trim());
  if (!m) return NaN;
  // ASS uses centiseconds: "0:00:01.50" is 1.5 s
  const frac = m[4] ? +m[4] / Math.pow(10, m[4].length) : 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + frac;
}

function convertAssText(raw) {
  let settings = '';
  let drawing = false; // text after {\p1} is vector drawing commands until {\p0}
  let text = '';
  // Walk text and override blocks in order: keep italic/bold/underline and alignment, drop the rest
  for (const part of raw.split(/(\{[^}]*\})/)) {
    if (!part.startsWith('{') || !part.endsWith('}')) {
      if (!drawing) text += part;
      continue;
    }
    for (const tag of part.slice(1, -1).split('\\').filter(Boolean)) {
      let mm;
      if ((mm = /^an(\d)$/.exec(tag))) settings = settings || ALIGNMENT[mm[1]] || '';
      else if ((mm = /^([ibu])(\d+)?$/.exec(tag))) {
        const on = mm[2] !== undefined && +mm[2] !== 0;
        text += on ? `\u0001${mm[1]}\u0002` : `\u0001/${mm[1]}\u0002`;
      } else if ((mm = /^p(\d+)$/.exec(tag))) drawing = +mm[1] > 0;
    }
  }
  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  text = escapeText(text).replace(/\u0001(\/?[ibu])\u0002/g, '<$1>');
  return { text: balanceTags(text), settings };
}

export function assToVtt(input) {
  const lines = stripBom(String(input)).replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let format = null;
  const cues = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(trimmed)) {
      format = trimmed.replace(/^format\s*:/i, '').split(',').map(s => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue; // Comment:, Picture:, … are ignored
    const fields = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const body = trimmed.replace(/^dialogue\s*:\s*/i, '');
    const parts = [];
    let rest = body;
    for (let i = 0; i < fields.length - 1; i++) {
      const comma = rest.indexOf(',');
      if (comma === -1) break;
      parts.push(rest.slice(0, comma));
      rest = rest.slice(comma + 1);
    }
    parts.push(rest); // the Text field may itself contain commas
    const get = name => parts[fields.indexOf(name)];
    const start = assSeconds(get('start') || '');
    const end = assSeconds(get('end') || '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const { text, settings } = convertAssText(get('text') || '');
    if (text.trim()) cues.push({ start, end, text, settings });
  }
  return buildVtt(cues);
}

// ─── XML formats (TTML/DFXP, YouTube timed text) ─────────────────────────────

function xmlText(inner) {
  const text = inner
    .replace(/<\s*(?:\w+:)?br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]*\n[ \t]*/g, '\n');
  return escapeText(decodeEntities(text).replace(/[ \t]+/g, ' ').trim());
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)(?:\\w+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}

// TTML time expressions: clock (HH:MM:SS(.fff) or HH:MM:SS:FF) or offset (1.5s, 1500ms, 2m, 90t, 25f)
function ttmlSeconds(value, { frameRate = 30, tickRate = 1 } = {}) {
  if (value == null) return NaN;
  const v = value.trim();
  let m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? +('0.' + m[4]) : 0);
  m = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.\d+)?$/.exec(v);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / frameRate;
  m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(v);
  if (m) {
    const n = +m[1];
    return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, f: n / frameRate, t: n / tickRate }[m[2]];
  }
  return NaN;
}

export function ttmlToVtt(input) {
  const xml = stripBom(String(input));
  const root = /<(?:\w+:)?tt\b([^>]*)>/i.exec(xml);
  const rootAttrs = root ? root[1] : '';
  // TTML defaults: frameRate 30; tickRate = frameRate when a frame rate is declared, else 1
  const declaredFps = +(attr(rootAttrs, 'frameRate') || 0);
  let fps = declaredFps || 30;
  const mul = attr(rootAttrs, 'frameRateMultiplier');
  if (mul) {
    const [a, b] = mul.split(/\s+/).map(Number);
    if (a && b) fps = fps * a / b;
  }
  const opts = {
    frameRate: fps,
    tickRate: +(attr(rootAttrs, 'tickRate') || 0) || (declaredFps ? fps : 1)
  };
  const cues = [];
  const re = /<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const begin = ttmlSeconds(attr(m[1], 'begin'), opts);
    let end = ttmlSeconds(attr(m[1], 'end'), opts);
    if (!Number.isFinite(end)) end = begin + ttmlSeconds(attr(m[1], 'dur'), opts);
    if (!Number.isFinite(begin) || !Number.isFinite(end)) continue;
    cues.push({ start: begin, end, text: xmlText(m[2]) });
  }
  return buildVtt(cues);
}

export function timedTextToVtt(input) {
  const xml = stripBom(String(input));
  const cues = [];
  let m;
  // Format 1: <text start="1.2" dur="2.5">…</text> (seconds)
  const re1 = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  while ((m = re1.exec(xml))) {
    const start = parseFloat(attr(m[1], 'start'));
    const dur = parseFloat(attr(m[1], 'dur') || '0');
    if (Number.isFinite(start)) cues.push({ start, end: start + (Number.isFinite(dur) && dur > 0 ? dur : 2), text: xmlText(m[2]) });
  }
  // srv3: <p t="1200" d="2500">…</p> (milliseconds)
  const re3 = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  while ((m = re3.exec(xml))) {
    const t = parseFloat(attr(m[1], 't'));
    const d = parseFloat(attr(m[1], 'd') || '0');
    if (Number.isFinite(t)) cues.push({ start: t / 1000, end: (t + (d > 0 ? d : 2000)) / 1000, text: xmlText(m[2]) });
  }
  return buildVtt(cues);
}

// ─── entry points ────────────────────────────────────────────────────────────

// Returns { vtt, format }. Throws when the text is not a subtitle format we know.
export function toWebVtt(text, { url = '', contentType = '' } = {}) {
  const format = detectFormat(text, url, contentType);
  const clean = stripBom(String(text));
  switch (format) {
    case 'vtt': return { vtt: clean.replace(/\r\n?/g, '\n'), format };
    case 'srt': return { vtt: srtToVtt(clean), format };
    case 'ass': return { vtt: assToVtt(clean), format };
    case 'ttml': return { vtt: ttmlToVtt(clean), format };
    case 'timedtext': return { vtt: timedTextToVtt(clean), format };
    default: throw new Error('Unrecognised subtitle format');
  }
}

// ─── cues (for the downloader: embedded MP4 text tracks, .srt files) ─────────

function parseVttTime(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

// WebVTT → [{ start, end, text }] in seconds, text without markup (tags dropped, entities decoded).
export function parseVttCues(vtt) {
  const cues = [];
  const blocks = stripBom(String(vtt)).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex(l => l.includes('-->'));
    if (at === -1) continue;
    const [a, rest] = lines[at].split('-->');
    const start = parseVttTime(a);
    const end = parseVttTime((rest || '').trim().split(/\s+/)[0] || '');
    if (!(end > start)) continue;
    const text = lines.slice(at + 1).join('\n')
      .replace(/<[^>]*>/g, '')
      .split('\n').map(l => decodeEntities(l).trim()).filter(Boolean).join('\n');
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

// HLS WebVTT segments: X-TIMESTAMP-MAP=MPEGTS:<90 kHz>,LOCAL:<time> maps cue times onto the media
// timeline. Returns the offset in seconds to add to cue times (media time), or null when absent.
export function vttTimestampOffset(vtt) {
  const m = /X-TIMESTAMP-MAP=([^\n]*)/i.exec(String(vtt).slice(0, 2000));
  if (!m) return null;
  const mpegts = /MPEGTS:(\d+)/i.exec(m[1]);
  const local = /LOCAL:([\d:.]+)/i.exec(m[1]);
  const localSec = local ? parseVttTime(local[1]) : 0;
  return (mpegts ? parseInt(mpegts[1], 10) / 90000 : 0) - (Number.isFinite(localSec) ? localSec : 0);
}

export function cuesToSrt(cues) {
  const t = sec => vttTime(sec).replace('.', ',');
  return cues
    .filter(c => c.end > c.start && c.text)
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${t(c.start)} --> ${t(c.end)}\n${c.text}\n`)
    .join('\n');
}

// Subtitle files are often not UTF-8 (old SRTs are Windows-1252). Honour a BOM, try strict
// UTF-8, and fall back to Windows-1252, which never fails.
export function decodeSubtitleBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// Fetches one subtitle ({url,label,lang}) and returns { vtt, format }.
export async function loadSubtitleAsVtt(sub, fetchFn = globalThis.fetch) {
  const res = await fetchFn(sub.url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = decodeSubtitleBytes(await res.arrayBuffer());
  return toWebVtt(text, { url: sub.url, contentType: res.headers.get('content-type') || '' });
}
