// Builds one playable MP4 file from fragmented-MP4 streams (HLS fMP4, DASH, or TS that Shaka's
// transmuxer turned into fMP4): an init segment + media fragments for video and, optionally, a
// separate audio stream. The result is a fragmented MP4 that every common player opens:
//   ftyp · moov (all tracks, mvex with mehd = total duration) · sidx (index → seekable in
//   ExoPlayer-based Android players, VLC, mpv, browsers) · moof+mdat … in time order
// Fragments are copied byte for byte; only a few fields are rewritten in place (track IDs,
// decode times, sequence numbers, absolute data offsets), so their internal offsets stay valid.
// Timestamps are shifted so the file starts at 0, and jumps (HLS discontinuities) are closed so
// the timeline is continuous.
// Plays the role of FastStream's hls2mp4/mp4merger (which write a progressive moov file); the
// fragmented layout + sidx needs far less code and keeps memory use flat when streaming to disk.

import { flattenCues, textTrak, textTrex, samplesBetween, textFragment } from './mp4-text.mjs';

// ─── reading ─────────────────────────────────────────────────────────────────

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function readBoxes(b, start = 0, end = b.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type: type4(b, p + 4), start: p, end: p + size, body: p + hdr });
    p += size;
  }
  return out;
}

const children = (b, box) => readBoxes(b, box.body, box.end);
const child = (b, box, type) => children(b, box).find(x => x.type === type);
const childrenOf = (b, box, type) => children(b, box).filter(x => x.type === type);

function trackInfo(b, trak) {
  const tkhd = child(b, trak, 'tkhd');
  const tkhdVersion = b[tkhd.body];
  const idOffset = tkhd.body + (tkhdVersion === 1 ? 20 : 12);
  const mdia = child(b, trak, 'mdia');
  const mdhd = child(b, mdia, 'mdhd');
  const mdhdVersion = b[mdhd.body];
  const timescale = u32(b, mdhd.body + (mdhdVersion === 1 ? 20 : 12));
  const hdlr = child(b, mdia, 'hdlr');
  const handler = hdlr ? type4(b, hdlr.body + 8) : '';
  return { id: u32(b, idOffset), timescale, handler, trak, idOffset: idOffset - trak.start };
}

// Init segment: tracks with their timescale, handler ('vide'/'soun') and trex defaults
export function parseInit(b) {
  const top = readBoxes(b);
  const moov = top.find(x => x.type === 'moov');
  if (!moov) throw new Error('init segment has no moov');
  const ftyp = top.find(x => x.type === 'ftyp');
  const mvhd = child(b, moov, 'mvhd');
  const mvhdVersion = b[mvhd.body];
  const mvhdTimescale = u32(b, mvhd.body + (mvhdVersion === 1 ? 20 : 12));
  const tracks = childrenOf(b, moov, 'trak').map(t => ({ ...trackInfo(b, t), bytes: b.subarray(t.start, t.end) }));
  const mvex = child(b, moov, 'mvex');
  for (const trex of mvex ? childrenOf(b, mvex, 'trex') : []) {
    const id = u32(b, trex.body + 4);
    const track = tracks.find(t => t.id === id);
    if (track) {
      track.trex = {
        bytes: b.subarray(trex.start, trex.end),
        defaultDuration: u32(b, trex.body + 12)
      };
    }
  }
  return {
    ftyp: ftyp ? b.subarray(ftyp.start, ftyp.end) : null,
    mvhd: b.subarray(mvhd.start, mvhd.end),
    mvhdTimescale,
    tracks
  };
}

// Media segment → its moof+mdat pairs with what we need to rewrite them.
// Other top-level boxes (styp, sidx, prft, emsg) are dropped.
export function parseFragments(b, tracksById) {
  const top = readBoxes(b);
  const frags = [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    // the data may be in more than one mdat; take everything up to the next moof
    let j = i + 1;
    while (j < top.length && top[j].type !== 'moof') j++;
    const moof = top[i];
    const end = top[j - 1].end;
    const frag = { start: moof.start, end, trafs: [], seqOffset: -1 };
    const mfhd = child(b, moof, 'mfhd');
    if (mfhd) frag.seqOffset = mfhd.body + 4;
    for (const traf of childrenOf(b, moof, 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      const tfhdFlags = u32(b, tfhd.body) & 0xffffff;
      const trackId = u32(b, tfhd.body + 4);
      let o = tfhd.body + 8;
      const baseDataOffsetAt = tfhdFlags & 0x01 ? o : -1;
      if (tfhdFlags & 0x01) o += 8;
      if (tfhdFlags & 0x02) o += 4;
      const tfhdDefaultDuration = tfhdFlags & 0x08 ? u32(b, o) : null;
      const track = tracksById.get(trackId);
      const fallbackDuration = tfhdDefaultDuration != null ? tfhdDefaultDuration : (track && track.trex ? track.trex.defaultDuration : 0);

      const tfdt = child(b, traf, 'tfdt');
      const tfdtVersion = tfdt ? b[tfdt.body] : 0;
      const decodeTime = tfdt ? (tfdtVersion === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : null;

      let duration = 0;
      for (const trun of childrenOf(b, traf, 'trun')) {
        const flags = u32(b, trun.body) & 0xffffff;
        const count = u32(b, trun.body + 4);
        let p = trun.body + 8;
        if (flags & 0x001) p += 4;
        if (flags & 0x004) p += 4;
        const per = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
        if (flags & 0x100) {
          for (let k = 0; k < count; k++) duration += u32(b, p + k * per);
        } else {
          duration += count * fallbackDuration;
        }
      }
      frag.trafs.push({
        trackId,
        idAt: tfhd.body + 4,
        baseDataOffsetAt,
        tfdtAt: tfdt ? tfdt.body + 4 : -1,
        tfdtVersion,
        decodeTime,
        duration
      });
    }
    frags.push(frag);
    i = j - 1;
  }
  return frags;
}

// ─── writing ─────────────────────────────────────────────────────────────────

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
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function setU32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
function setU64(b, o, v) { setU32(b, o, Math.floor(v / 4294967296)); setU32(b, o + 4, v >>> 0); }

function withTrackId(bytes, offset, id) {
  const copy = bytes.slice();
  setU32(copy, offset, id);
  return copy;
}

// ─── assembly ────────────────────────────────────────────────────────────────

// Splits a media segment into fragments: each `moof` (copied, because it gets rewritten) and the
// byte range of everything after it up to the next moof (mdat …), which is never changed and can
// stay wherever the caller keeps it (memory, or a Blob in IndexedDB).
export function splitSegment(b) {
  const top = readBoxes(b);
  const out = [];
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    let j = i + 1;
    while (j < top.length && top[j].type !== 'moof') j++;
    out.push({ moof: b.slice(top[i].start, top[i].end), moofOffset: top[i].start, restStart: top[i].end, restEnd: top[j - 1].end });
    i = j - 1;
  }
  return out;
}

// Plans one MP4 from fMP4 sources without touching their media data.
// sources: [{ init: Uint8Array, fragments: [{ moof: Uint8Array, rest: any, restSize, moofOffset }] }]
// (`rest` is opaque: a Uint8Array or a Blob slice; it is only passed through).
// Returns { header: [ftyp, moov, sidx], body: [{ moof, rest }] in file order, size, duration, tracks }.
// The moofs are rewritten in place: track IDs, decode times, sequence numbers, absolute offsets.
// text: subtitle tracks to add, [{ cues: [{start, end, text}] (seconds), language, label, base }].
// base 'output' (default): cue times count from the start of the file (sidecar subtitle files);
// 'media': times on the sources' media timeline (HLS WebVTT with X-TIMESTAMP-MAP), shifted like
// the media.
export function planMp4(sources, { text = [] } = {}) {
  if (!sources.some(s => s && s.init)) throw new Error('nothing to write');
  const usable = sources.filter(s => s && s.init && s.fragments && s.fragments.length);
  if (!usable.length) throw new Error('no media fragments found');

  // 1. Tracks, renumbered so IDs are unique across sources
  let nextId = 1;
  const outTracks = [];
  const sourceMaps = [];
  let ftyp = null;
  let mvhd = null;
  let mvhdTimescale = 1000;
  for (const src of usable) {
    const init = parseInit(src.init);
    if (!ftyp && init.ftyp) ftyp = init.ftyp;
    if (!mvhd) { mvhd = init.mvhd.slice(); mvhdTimescale = init.mvhdTimescale; }
    const map = new Map();
    for (const t of init.tracks) {
      const id = nextId++;
      const out = {
        id,
        timescale: t.timescale,
        handler: t.handler,
        trakBytes: withTrackId(t.bytes, t.idOffset, id),
        trexBytes: t.trex ? withTrackId(t.trex.bytes, 12, id) : null,
        lastEnd: null,
        shift: null
      };
      outTracks.push(out);
      map.set(t.id, out);
    }
    sourceMaps.push({ src, map, byId: new Map(init.tracks.map(t => [t.id, t])) });
  }

  // 2. Fragments: parse each moof (offsets are relative to the moof)
  const frags = [];
  sourceMaps.forEach(({ src, map, byId }, srcIndex) => {
    for (const f of src.fragments) {
      const parsed = parseFragments(f.moof, byId)[0];
      if (!parsed || !parsed.trafs.length || parsed.trafs.some(t => !map.get(t.trackId))) continue;
      frags.push({
        moof: f.moof,
        rest: f.rest,
        size: f.moof.length + f.restSize,
        moofOffset: f.moofOffset,
        seqAt: parsed.seqOffset,
        trafs: parsed.trafs.map(t => ({ ...t, out: map.get(t.trackId) })),
        srcIndex
      });
    }
  });
  if (!frags.length) throw new Error('no media fragments found');

  // 3. Common zero: the earliest decode time over all tracks
  let zero = Infinity;
  for (const f of frags) for (const t of f.trafs) if (t.decodeTime != null) zero = Math.min(zero, t.decodeTime / t.out.timescale);
  if (!isFinite(zero)) zero = 0;

  // 4. Track id, continuous decode time (shifted to the common zero; a jump of more than 1 s or
  //    backwards — an HLS discontinuity — is closed)
  for (const f of frags) {
    for (const t of f.trafs) {
      const tr = t.out;
      setU32(f.moof, t.idAt, tr.id);
      if (t.tfdtAt < 0 || t.decodeTime == null) continue;
      if (tr.shift == null) tr.shift = Math.round(zero * tr.timescale);
      let time = t.decodeTime - tr.shift;
      if (tr.lastEnd != null) {
        const tolerance = tr.timescale; // 1 s
        if (time < tr.lastEnd - tolerance / 10 || time > tr.lastEnd + tolerance) {
          tr.shift += time - tr.lastEnd;
          time = tr.lastEnd;
        }
      }
      if (time < 0) { tr.shift += time; time = 0; }
      if (t.tfdtVersion === 1) setU64(f.moof, t.tfdtAt, time);
      else {
        if (time > 0xffffffff) throw new Error('decode time does not fit a version 0 tfdt');
        setU32(f.moof, t.tfdtAt, time);
      }
      t.outTime = time / tr.timescale;
      tr.lastEnd = time + t.duration;
    }
    f.time = f.trafs[0].outTime != null ? f.trafs[0].outTime : 0;
  }

  // 5. Time order (stable: first source before later ones on ties), sequence numbers
  frags.sort((a, b) => a.time - b.time || a.srcIndex - b.srcIndex);

  const duration = Math.max(...outTracks.map(t => (t.lastEnd || 0) / t.timescale));
  const primary = outTracks.find(t => t.handler === 'vide') || outTracks[0];

  // 5b. Subtitle tracks: one text fragment right after each fragment of the primary track,
  //     covering the time up to the next one (so a seek through the sidx finds them)
  const textTracks = text.filter(t => t && t.cues && t.cues.length);
  if (textTracks.length) {
    const bounds = [0]; // ms
    const boundTimes = [0]; // the primary fragment's exact time, so the text sorts right after it
    for (const f of frags) {
      if (!f.trafs.some(t => t.out === primary)) continue;
      const ms = Math.round(f.time * 1000);
      if (ms > bounds[bounds.length - 1]) { bounds.push(ms); boundTimes.push(f.time); }
    }
    const endMs = Math.round(duration * 1000);
    if (endMs > bounds[bounds.length - 1]) bounds.push(endMs);
    const pieces = [];
    textTracks.forEach((t, k) => {
      const id = nextId++;
      const shift = t.base === 'media' ? zero : 0;
      const flat = flattenCues(t.cues.map(c => ({ start: c.start - shift, end: c.end - shift, text: c.text })));
      outTracks.push({ id, timescale: 1000, handler: 'sbtl', trakBytes: textTrak(id, { language: t.language, label: t.label, enabled: k === 0 }), trexBytes: textTrex(id), lastEnd: endMs, text: true });
      for (let i = 0; i + 1 < bounds.length; i++) {
        const frag = textFragment(id, bounds[i], samplesBetween(flat, bounds[i], bounds[i + 1]));
        pieces.push({ moof: frag.moof, rest: frag.mdat, size: frag.moof.length + frag.mdat.length, seqAt: frag.seqAt, trafs: [], time: boundTimes[i], srcIndex: 1e9 + k });
      }
    });
    frags.push(...pieces);
    frags.sort((a, b) => a.time - b.time || a.srcIndex - b.srcIndex);
  }
  frags.forEach((f, i) => { if (f.seqAt >= 0) setU32(f.moof, f.seqAt, i + 1); });

  // 6. moov: mvhd (next_track_ID), every trak, mvex (mehd with the total duration, every trex)
  const mvhdVersion = mvhd[8];
  setU32(mvhd, 8 + (mvhdVersion === 1 ? 108 : 96), nextId);
  const mehdTime = new Uint8Array(8);
  setU64(mehdTime, 0, Math.round(duration * mvhdTimescale));
  const mehd = box('mehd', new Uint8Array([1, 0, 0, 0]), mehdTime);
  const trexes = outTracks.map(t => t.trexBytes || box('trex', (() => {
    const x = new Uint8Array(24);
    setU32(x, 4, t.id); setU32(x, 8, 1);
    return x;
  })()));
  const moov = box('moov', mvhd, ...outTracks.map(t => t.trakBytes), box('mvex', mehd, ...trexes));
  if (!ftyp) ftyp = box('ftyp', new TextEncoder().encode('isom'), new Uint8Array([0, 0, 2, 0]), new TextEncoder().encode('isomiso6mp41'));

  // 7. sidx on the primary track (video if any): one reference per primary fragment
  const starts = [];
  frags.forEach((f, i) => { if (f.trafs.some(t => t.out === primary)) starts.push(i); });
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const refs = starts.map((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : frags.length;
    let size = 0;
    for (let i = s; i < e; i++) size += frags[i].size;
    const t0 = frags[s].time;
    const t1 = k + 1 < starts.length ? frags[starts[k + 1]].time : duration;
    return { size, duration: Math.max(0, Math.round((t1 - t0) * primary.timescale)) };
  });
  const sidxBody = new Uint8Array(32 + 12 * refs.length);
  sidxBody[0] = 1; // version 1, flags 0
  setU32(sidxBody, 4, primary.id);
  setU32(sidxBody, 8, primary.timescale);
  setU64(sidxBody, 12, 0); // earliest presentation time
  setU64(sidxBody, 20, 0); // first offset: the first moof follows directly
  sidxBody[30] = (refs.length >> 8) & 255;
  sidxBody[31] = refs.length & 255;
  refs.forEach((r, k) => {
    const o = 32 + 12 * k;
    setU32(sidxBody, o, r.size & 0x7fffffff);
    setU32(sidxBody, o + 4, r.duration);
    setU32(sidxBody, o + 8, 0x90000000); // starts_with_SAP = 1, SAP_type = 1
  });
  const sidx = box('sidx', sidxBody);

  // 8. Absolute data offsets (rare: tfhd base-data-offset-present) now point into the new file
  let pos = ftyp.length + moov.length + sidx.length;
  for (const f of frags) {
    for (const t of f.trafs) {
      if (t.baseDataOffsetAt < 0) continue;
      const orig = u64(f.moof, t.baseDataOffsetAt);
      setU64(f.moof, t.baseDataOffsetAt, pos + (orig - f.moofOffset));
    }
    pos += f.size;
  }

  return {
    header: [ftyp, moov, sidx],
    body: frags.map(f => ({ moof: f.moof, rest: f.rest })),
    size: pos,
    duration,
    zero, // media time (s) that became 0 in the file
    tracks: outTracks.map(t => ({ id: t.id, handler: t.handler, timescale: t.timescale }))
  };
}

// In-memory convenience: sources [{ init, segments: Uint8Array[] }] → { parts, size, duration, tracks }.
// `inPlace`: the media data of the result points into the segment buffers (no copy).
export function buildMp4(sources, { inPlace = false, text = [] } = {}) {
  const plan = planMp4(sources.filter(Boolean).map(s => ({
    init: s.init,
    fragments: (s.segments || []).flatMap(seg => splitSegment(seg).map(f => {
      const rest = inPlace ? seg.subarray(f.restStart, f.restEnd) : seg.slice(f.restStart, f.restEnd);
      return { moof: f.moof, rest, restSize: rest.length, moofOffset: f.moofOffset };
    }))
  })), { text });
  const parts = [...plan.header, ...plan.body.flatMap(f => [f.moof, f.rest])];
  return { parts, size: plan.size, duration: plan.duration, tracks: plan.tracks };
}