// Subtitle tracks for the downloaded MP4: 3GPP timed text ('tx3g', ISO/IEC 14496-30 / 3GPP TS
// 26.245), the MP4 subtitle format that ExoPlayer-based Android players (MX Player, Just Player…),
// VLC, mpv/ffmpeg, Windows' player and QuickTime read.
// A tx3g track is a sequence of samples that cover the timeline without gaps or overlaps; each
// sample is one text (empty = nothing shown). Overlapping cues are therefore flattened first.
// src/mp4-merge.mjs places one text fragment next to each video fragment, so a player that seeks
// with the sidx index finds the subtitles of that part of the video in the same place.

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...payloads) {
  const body = concat(payloads);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const u8 = (...v) => new Uint8Array(v);
function u16(v) { return u8((v >>> 8) & 255, v & 255); }
function u32(v) { return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function u64(v) { return concat([u32(Math.floor(v / 4294967296)), u32(v >>> 0)]); }
const fullBox = (type, version, flags, ...payloads) => box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...payloads);

// ISO 639-1 → ISO 639-2/T (what the mdhd language field holds)
const LANG3 = {
  ar: 'ara', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa',
  et: 'est', fa: 'fas', fi: 'fin', fr: 'fra', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun', id: 'ind', is: 'isl',
  it: 'ita', ja: 'jpn', ka: 'kat', kk: 'kaz', km: 'khm', kn: 'kan', ko: 'kor', lt: 'lit', lv: 'lav', mk: 'mkd',
  ml: 'mal', mn: 'mon', mr: 'mar', ms: 'msa', my: 'mya', nb: 'nob', ne: 'nep', nl: 'nld', nn: 'nno', no: 'nor',
  pa: 'pan', pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus', si: 'sin', sk: 'slk', sl: 'slv', sq: 'sqi', sr: 'srp',
  sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', th: 'tha', tl: 'tgl', tr: 'tur', uk: 'ukr', ur: 'urd', uz: 'uzb',
  vi: 'vie', zh: 'zho', fil: 'fil'
};

export function language3(code) {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  if (/^[a-z]{3}$/.test(c)) return c;
  return LANG3[c] || 'und';
}

function packedLanguage(code) {
  const l = language3(code);
  return ((l.charCodeAt(0) - 0x60) << 10) | ((l.charCodeAt(1) - 0x60) << 5) | (l.charCodeAt(2) - 0x60);
}

// Overlapping cues → non-overlapping intervals in whole milliseconds; texts shown at the same time
// are joined with a line break (earlier cue on top).
export function flattenCues(cues) {
  const list = cues
    .map(c => ({ start: Math.max(0, Math.round(c.start * 1000)), end: Math.round(c.end * 1000), text: c.text }))
    .filter(c => c.end > c.start && c.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const times = [...new Set(list.flatMap(c => [c.start, c.end]))].sort((a, b) => a - b);
  const out = [];
  let from = 0;
  for (let i = 0; i + 1 < times.length; i++) {
    const s = times[i];
    const e = times[i + 1];
    while (from < list.length && list[from].end <= s) from++;
    const texts = [];
    for (let k = from; k < list.length && list[k].start <= s; k++) {
      if (list[k].end >= e && !texts.includes(list[k].text)) texts.push(list[k].text);
    }
    if (!texts.length) continue;
    const text = texts.join('\n');
    const last = out[out.length - 1];
    if (last && last.end === s && last.text === text) last.end = e;
    else out.push({ start: s, end: e, text });
  }
  return out;
}

// The 'tx3g' sample entry: centred at the bottom, white text, one default font
function tx3gSampleEntry() {
  const font = enc.encode('Sans-Serif');
  return box('tx3g',
    new Uint8Array(6), u16(1), // SampleEntry: reserved, data_reference_index
    u32(0), // displayFlags
    u8(1, 0xff), // horizontal centre, vertical bottom
    u8(0, 0, 0, 0), // background colour (transparent)
    new Uint8Array(8), // default text box
    u16(0), u16(0), u16(1), u8(0), u8(18), u8(255, 255, 255, 255), // style record
    box('ftab', u16(1), u16(1), u8(font.length), font));
}

// trak of one subtitle track (timescale 1000). `enabled`: the track players show by default.
export function textTrak(id, { language = '', label = '', enabled = false } = {}) {
  const matrix = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const tkhd = fullBox('tkhd', 0, enabled ? 3 : 2,
    u32(0), u32(0), u32(id), u32(0), u32(0), new Uint8Array(8),
    u16(0), u16(2), u16(0), u16(0), // layer, alternate_group 2 (subtitles), volume, reserved
    matrix, u32(0), u32(0));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u16(packedLanguage(language)), u16(0));
  const name = enc.encode(label || 'Subtitles');
  const hdlr = fullBox('hdlr', 0, 0, u32(0), enc.encode('sbtl'), new Uint8Array(12), name, u8(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), tx3gSampleEntry()),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', fullBox('nmhd', 0, 0), dinf, stbl);
  const parts = [tkhd, box('mdia', mdhd, hdlr, minf)];
  if (label) parts.push(box('udta', box('name', enc.encode(label))));
  return box('trak', ...parts);
}

export function textTrex(id) {
  return fullBox('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0));
}

function sampleBytes(text) {
  let t = enc.encode(text || '');
  if (t.length > 65535) t = t.subarray(0, 65535);
  return concat([u16(t.length), t]);
}

// Samples covering [fromMs, toMs) exactly: the flattened cues inside it (cut at the edges) and
// empty samples in between.
export function samplesBetween(flat, fromMs, toMs) {
  const samples = [];
  let cursor = fromMs;
  for (const c of flat) {
    if (c.end <= fromMs) continue;
    if (c.start >= toMs) break;
    const s = Math.max(c.start, fromMs);
    const e = Math.min(c.end, toMs);
    if (s > cursor) samples.push({ duration: s - cursor, text: '' });
    if (e > s) samples.push({ duration: e - s, text: c.text });
    cursor = Math.max(cursor, e);
  }
  if (toMs > cursor) samples.push({ duration: toMs - cursor, text: '' });
  return samples;
}

// One moof+mdat for a text track. The moof uses default-base-is-moof, so it stays valid wherever
// it is placed. Returns { moof, mdat, seqAt } (seqAt: offset of the mfhd sequence number).
export function textFragment(trackId, startMs, samples) {
  const data = samples.map(s => sampleBytes(s.text));
  const mdat = box('mdat', ...data);
  const build = (dataOffset) => box('moof',
    fullBox('mfhd', 0, 0, u32(0)),
    box('traf',
      fullBox('tfhd', 0, 0x020000, u32(trackId)),
      fullBox('tfdt', 1, 0, u64(startMs)),
      fullBox('trun', 0, 0x000301, u32(samples.length), u32(dataOffset),
        ...samples.flatMap((s, i) => [u32(s.duration), u32(data[i].length)]))));
  const size = build(0).length;
  return { moof: build(size + 8), mdat, seqAt: 20 };
}
