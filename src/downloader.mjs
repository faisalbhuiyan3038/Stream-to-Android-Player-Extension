// Download an HLS / DASH stream (or a plain file) inside the browser and turn it into one MP4.
// Shaka Player does the parsing (HLS media/master playlists incl. alternate audio, DASH
// templates/timelines/lists/byte ranges, AES-128 key info) and, for MPEG-TS, the transmuxing;
// this module fetches the segments in parallel, decrypts AES-128, and hands fMP4 to
// src/mp4-merge.mjs. Idea and scope from FastStream's save feature (hls2mp4 / dash2mp4).

import { planMp4, splitSegment } from './mp4-merge.mjs';
import { MemoryStore } from './segment-store.mjs';
import { decodeSubtitleBytes, toWebVtt, parseVttCues, vttTimestampOffset } from './subtitles.mjs';
import { referencesOf, initSegmentOf, aesKeyOf, uriOf, startOf, endOf, byteRange } from './shaka-refs.mjs';

export { initSegmentOf, aesKeyOf, uriOf };

const AUDIO_CODEC = /mp4a|ac-3|ec-3|mp3|opus|flac/i;

// ─── network ─────────────────────────────────────────────────────────────────

export async function fetchBytes(url, { start = 0, end = null, retries = 3, signal, fetchFn = globalThis.fetch, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const headers = {};
  if (start > 0 || end != null) headers.Range = `bytes=${start}-${end == null ? '' : end}`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new Error('Cancelled');
    try {
      const res = await fetchFn(url, { headers, credentials: 'same-origin', signal });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status === 403 || res.status === 404 || res.status === 410) break; // will not get better
    } catch (e) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      lastError = e;
    }
    await delay(500 * Math.pow(2, attempt));
  }
  throw lastError;
}

// Runs `tasks` (functions returning promises) with at most `n` at a time; results in task order.
export async function runPool(tasks, n, onDone = () => {}) {
  const results = new Array(tasks.length);
  let next = 0;
  let failed = null;
  async function worker() {
    while (next < tasks.length && !failed) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
        onDone(i, results[i]);
      } catch (e) {
        failed = failed || e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, worker));
  if (failed) throw failed;
  return results;
}

// ─── AES-128 (HLS) ───────────────────────────────────────────────────────────

// IV from the media sequence number when the playlist gives none (HLS spec 5.2)
export function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  let n = sequence;
  for (let i = 15; i >= 12 && n > 0; i--) { iv[i] = n & 255; n = Math.floor(n / 256); }
  return iv;
}

async function decryptAes128(data, aesKey, sequence) {
  if (!aesKey.cryptoKey && aesKey.fetchKey) await aesKey.fetchKey();
  if (!aesKey.cryptoKey) throw new Error('Could not get the AES-128 key');
  const iv = aesKey.iv || sequenceIv(sequence);
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey.cryptoKey, data);
  return new Uint8Array(plain);
}

// ─── manifest ────────────────────────────────────────────────────────────────

// What the user can choose: video qualities and audio languages of a loaded Shaka manifest
export function describeManifest(manifest) {
  const variants = manifest.variants || [];
  const videos = [];
  const audios = [];
  const seenV = new Set();
  const seenA = new Set();
  for (const v of variants) {
    if (v.video && !seenV.has(v.video.id)) {
      seenV.add(v.video.id);
      videos.push({ id: v.video.id, height: v.video.height || 0, width: v.video.width || 0, bandwidth: v.video.bandwidth || v.bandwidth || 0, codecs: v.video.codecs || '' });
    }
    if (v.audio && !seenA.has(v.audio.id)) {
      seenA.add(v.audio.id);
      audios.push({ id: v.audio.id, language: v.audio.language || 'und', label: v.audio.label || v.audio.originalLanguage || '', bandwidth: v.audio.bandwidth || 0, channels: v.audio.channelsCount || 0 });
    }
  }
  videos.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  audios.sort((a, b) => b.bandwidth - a.bandwidth);
  const drm = variants.some(v => (v.video && v.video.drmInfos && v.video.drmInfos.length) || (v.audio && v.audio.drmInfos && v.audio.drmInfos.length));
  return { videos, audios, drm, duration: manifest.presentationTimeline ? manifest.presentationTimeline.getDuration() : 0, live: manifest.presentationTimeline ? manifest.presentationTimeline.isLive() : false };
}

// Subtitle tracks listed in the manifest (HLS EXT-X-MEDIA TYPE=SUBTITLES, DASH text
// AdaptationSets). Only text formats (WebVTT, TTML, SRT) can be read; subtitles inside fMP4
// segments (wvtt/stpp) are skipped.
export function textStreamsOf(manifest) {
  return (manifest.textStreams || [])
    // fMP4 subtitles and CEA-608/708 captions (carried inside the video) cannot be read here
    .filter(t => !/mp4|cea-[67]/i.test(t.mimeType || '') && !/^(wvtt|stpp)/i.test(t.codecs || ''))
    .map(t => ({ id: t.id, language: t.language || 'und', label: t.label || t.originalLanguage || t.language || 'Subtitles', stream: t }));
}

// Segment addresses of a stream (to recognise subtitle segments the page fetched one by one)
export async function segmentUrisOf(stream) {
  return (await referencesOf(stream)).map(r => uriOf(r));
}

// Downloads every segment of a manifest text stream and returns
// { cues, base } for planMp4 (base 'media' when the segments carry an X-TIMESTAMP-MAP).
export async function loadTextStream(stream, { signal, fetchFn, parallel = 4 } = {}) {
  const refs = await referencesOf(stream);
  const texts = await runPool(refs.map(ref => async () => {
    const bytes = await fetchBytes(uriOf(ref), { ...byteRange(ref), signal, fetchFn, retries: 2 });
    return decodeSubtitleBytes(bytes);
  }), parallel);
  const cues = [];
  const seen = new Set();
  let base = 'output';
  for (const raw of texts) {
    if (!raw || !raw.trim()) continue;
    const { vtt } = toWebVtt(raw, { contentType: stream.mimeType || '' });
    const offset = vttTimestampOffset(raw);
    if (offset != null) base = 'media';
    for (const c of parseVttCues(vtt)) {
      const cue = offset != null ? { start: c.start + offset, end: c.end + offset, text: c.text } : c;
      // a cue that spans two segments is repeated in both
      const key = `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(cue);
    }
  }
  return { cues, base };
}

function findStream(manifest, kind, id) {
  for (const v of manifest.variants || []) {
    if (v[kind] && v[kind].id === id) return v[kind];
  }
  return null;
}

// What a downloaded segment is, from its first bytes. (Shaka labels TS variants "video/mp4"
// because it plans to transmux them, so the MIME type cannot be trusted.)
export function sniffSegment(b) {
  if (!b || b.length < 4) return 'unknown';
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'ts';
  let o = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length > 10) {
    // ID3 tag before raw audio
    o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  }
  if (b[o] === 0xff && (b[o + 1] & 0xf6) === 0xf0) return 'aac';
  if (b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0) return 'mp3';
  if (b.length >= 8) {
    const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (['ftyp', 'styp', 'moof', 'sidx', 'emsg', 'prft', 'moov', 'free'].includes(t)) return 'fmp4';
  }
  return 'unknown';
}

// ─── download ────────────────────────────────────────────────────────────────

// What the downloader itself holds in RAM at a time (segments in flight, the one being
// converted or scanned). Reported as `peakHeld`; the browser tests check it stays flat.
function heldCounter() {
  const c = { now: 0, peak: 0 };
  c.add = n => { c.now += n; if (c.now > c.peak) c.peak = c.now; };
  c.sub = n => { c.now -= n; };
  return c;
}

// A stored segment as fragments: the moofs in memory (small), the media data as slices of the
// stored Blob (on disk with IndexedDB). Only one segment is read into RAM at a time.
async function fragmentsOf(blob, held) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  held.add(buf.length);
  const frags = splitSegment(buf).map(f => ({
    moof: f.moof,
    rest: blob.slice(f.restStart, f.restEnd),
    restSize: f.restEnd - f.restStart,
    moofOffset: f.moofOffset
  }));
  held.sub(buf.length);
  return frags;
}

// shaka: the Shaka namespace (for transmuxers). manifest: player.getManifest().
// choice: { videoId, audioId }. store: where segments wait (segment-store.mjs; IndexedDB in the
// download page). text: subtitle tracks for the file (see planMp4).
// Returns { blob, size, duration, tracks, peakHeld, storage }.
// keep(uri, range): only segments it accepts are downloaded (a partial save of what a player has
// already loaded; gaps are closed by the merger like discontinuities).
export async function downloadManifest({ shaka, manifest, choice, parallel = 4, signal, onProgress = () => {}, fetchFn, store = new MemoryStore(), text = [], keep = null }) {
  const video = choice.videoId != null ? findStream(manifest, 'video', choice.videoId) : null;
  const audio = choice.audioId != null ? findStream(manifest, 'audio', choice.audioId) : null;
  if (!video && !audio) throw new Error('Nothing selected to download');
  if ([video, audio].some(s => s && s.drmInfos && s.drmInfos.length)) {
    throw new Error('This stream is DRM-protected and cannot be downloaded.');
  }

  // Jobs: one per stream. Muxed MPEG-TS (one stream carrying video and audio) is transmuxed
  // twice from the same bytes: once for the video track, once for the audio track.
  const jobs = [];
  if (video) {
    jobs.push({ stream: video, contentType: 'video' });
    // Possibly muxed audio (kept only if the segments turn out to be TS; an fMP4 init already
    // describes both tracks)
    if (!audio && AUDIO_CODEC.test(video.codecs || '')) jobs.push({ stream: video, contentType: 'audio', sameBytesAs: 0 });
  }
  if (audio) jobs.push({ stream: audio, contentType: 'audio' });
  jobs.forEach((job, n) => { job.index = n; });

  for (const job of jobs) {
    if (job.sameBytesAs != null) continue;
    job.refs = await referencesOf(job.stream);
    if (!job.refs.length) throw new Error('The playlist has no segments');
    // position in the playlist of each ref (the AES-128 IV comes from it)
    job.nums = job.refs.map((r, n) => n);
    if (keep) {
      const kept = job.refs.map((ref, n) => [ref, n]).filter(([ref]) => keep(uriOf(ref), byteRange(ref)));
      job.refs = kept.map(([ref]) => ref);
      job.nums = kept.map(([, n]) => n);
      if (!job.refs.length) throw new Error('Nothing of this stream has been loaded yet');
    }
  }
  const total = jobs.filter(j => j.sameBytesAs == null).reduce((n, j) => n + j.refs.length, 0);
  let done = 0;
  let bytes = 0;
  const started = Date.now();
  const held = heldCounter();
  const report = () => onProgress({ done, total, bytes, seconds: (Date.now() - started) / 1000 });
  const rawKey = (job, i) => `raw/${job.index}/${i}`;

  // 1. Download (and decrypt) every segment, several at a time; each goes to the store at once
  for (const job of jobs) {
    if (job.sameBytesAs != null) continue;
    const initRef = initSegmentOf(shaka, job.refs[0]);
    job.init = initRef ? await fetchBytes(uriOf(initRef), { ...byteRange(initRef), signal, fetchFn }) : null;
    // an EXT-X-KEY before the EXT-X-MAP encrypts the init segment too
    const initKey = initRef && aesKeyOf(initRef);
    if (job.init && initKey) job.init = await decryptAes128(job.init, initKey, initKey.firstMediaSequenceNumber);
    await runPool(job.refs.map((ref, i) => async () => {
      let data = await fetchBytes(uriOf(ref), { ...byteRange(ref), signal, fetchFn });
      held.add(data.length);
      const key = aesKeyOf(ref);
      if (key) {
        const plain = await decryptAes128(data, key, key.firstMediaSequenceNumber + job.nums[i]);
        held.add(plain.length);
        held.sub(data.length);
        data = plain;
      }
      if (i === 0) job.kind = sniffSegment(data);
      await store.put(rawKey(job, i), data);
      held.sub(data.length);
      return data.length;
    }), parallel, (i, n) => { done++; bytes += n; report(); });
  }

  // 2. Fragments per output stream. fMP4: straight from the store. MPEG-TS / raw AAC / MP3:
  //    converted one segment at a time (Shaka's transmuxers), the result stored again.
  const sources = [];
  for (const job of jobs) {
    if (job.sameBytesAs != null) continue; // handled with its source below
    const sharing = jobs.filter(j => j === job || j.sameBytesAs === job.index);
    if (job.kind === 'fmp4' || job.kind === 'unknown') {
      if (!job.init) throw new Error(job.kind === 'unknown' ? 'Unsupported segment format' : 'fMP4 stream without an initialization segment');
      const fragments = [];
      for (let i = 0; i < job.refs.length; i++) fragments.push(...await fragmentsOf(await store.get(rawKey(job, i)), held));
      sources[job.index] = { init: job.init, fragments };
      continue; // a muxed-audio sibling has nothing to add: the fMP4 init already has both tracks
    }
    const codecs = job.stream.codecs ? `; codecs="${job.stream.codecs}"` : '';
    const Transmuxer = job.kind === 'ts' ? shaka.transmuxer.TsTransmuxer
      : job.kind === 'mp3' ? shaka.transmuxer.Mp3Transmuxer : shaka.transmuxer.AacTransmuxer;
    const mime = job.kind === 'ts' ? `video/mp2t${codecs}` : job.kind === 'mp3' ? 'audio/mpeg' : 'audio/aac';
    const outs = sharing.map(j => ({ job: j, tx: new Transmuxer(mime), init: null, fragments: [] }));
    for (let i = 0; i < job.refs.length; i++) {
      if (signal && signal.aborted) throw new Error('Cancelled');
      const ref = job.refs[i];
      const raw = new Uint8Array(await (await store.get(rawKey(job, i))).arrayBuffer());
      held.add(raw.length);
      for (const o of outs) {
        const out = await o.tx.transmux(raw, o.job.stream, ref, endOf(ref) - startOf(ref), o.job.contentType);
        const data = out && out.data ? out.data : out;
        if (out && out.init && !o.init) o.init = out.init;
        if (!data || !data.length) continue;
        held.add(data.length);
        const key = `frag/${o.job.index}/${i}`;
        await store.put(key, data);
        held.sub(data.length);
        o.fragments.push(...await fragmentsOf(await store.get(key), held));
      }
      held.sub(raw.length);
      await store.delete(rawKey(job, i));
    }
    for (const o of outs) {
      o.tx.destroy();
      if (!o.init || !o.fragments.length) {
        if (o.job.sameBytesAs != null) continue; // no audio in the TS after all
        throw new Error(`Could not convert the ${o.job.contentType} stream`);
      }
      sources[o.job.index] = { init: o.init, fragments: o.fragments };
    }
  }

  // 3. One MP4: the small rewritten headers + slices of the stored media data
  const plan = planMp4(sources.filter(Boolean), { text });
  const blob = new Blob([...plan.header, ...plan.body.flatMap(f => [f.moof, f.rest])], { type: 'video/mp4' });
  if (blob.size !== plan.size) throw new Error(`Assembled ${blob.size} bytes, expected ${plan.size}`);
  return { blob, size: plan.size, duration: plan.duration, zero: plan.zero, tracks: plan.tracks, peakHeld: held.peak, storage: store.kind || 'memory' };
}

// A plain media file (mp4, webm, …): streamed into the store in chunks of up to 4 MB.
export async function downloadFile(url, { signal, onProgress = () => {}, fetchFn = globalThis.fetch, store = new MemoryStore(), chunkBytes = 4 * 1024 * 1024 } = {}) {
  const res = await fetchFn(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const started = Date.now();
  const held = heldCounter();
  const keys = [];
  let pending = [];
  let pendingBytes = 0;
  let bytes = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const key = `file/${keys.length}`;
    await store.put(key, new Blob(pending));
    keys.push(key);
    held.sub(pendingBytes);
    pending = [];
    pendingBytes = 0;
  };
  const take = async (chunk) => {
    pending.push(chunk);
    pendingBytes += chunk.length;
    bytes += chunk.length;
    held.add(chunk.length);
    onProgress({ done: total ? bytes : 0, total, bytes, seconds: (Date.now() - started) / 1000 });
    if (pendingBytes >= chunkBytes) await flush();
  };
  if (!res.body || !res.body.getReader) {
    await take(new Uint8Array(await res.arrayBuffer()));
  } else {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await take(value);
    }
  }
  await flush();
  const blob = new Blob(await Promise.all(keys.map(k => store.get(k))), { type });
  return { blob, size: blob.size, type, peakHeld: held.peak, storage: store.kind || 'memory' };
}

// "Show Name S01E02" → "Show Name S01E02.mp4", without characters file systems reject
export function safeFileName(title, ext) {
  const base = String(title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';
  return `${base}.${ext}`;
}
