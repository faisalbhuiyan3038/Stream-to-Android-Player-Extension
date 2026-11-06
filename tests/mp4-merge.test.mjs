// Unit tests for src/mp4-merge.mjs, on the real fMP4 HLS fixture (tests/e2e/fixtures/hls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMp4, readBoxes, parseInit, parseFragments } from '../src/mp4-merge.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e', 'fixtures', 'hls');
const read = f => new Uint8Array(fs.readFileSync(path.join(dir, f)));
const init = read('init.mp4');
const segNames = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').split('\n').filter(l => l.endsWith('.m4s'));
const segs = segNames.map(read);
const join = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// tfdt (seconds) of every traf of `trackId` in a built file
function decodeTimes(file, trackId) {
  const moov = readBoxes(file).find(b => b.type === 'moov');
  const info = parseInit(file.subarray(0, moov.end));
  const byId = new Map(info.tracks.map(t => [t.id, t]));
  const ts = byId.get(trackId).timescale;
  return parseFragments(file, byId).flatMap(f => f.trafs.filter(t => t.trackId === trackId).map(t => ({ start: t.decodeTime / ts, end: (t.decodeTime + t.duration) / ts })));
}

test('single fMP4 stream: ftyp, moov with mehd, sidx with one entry per segment, then the fragments', () => {
  const out = buildMp4([{ init, segments: segs }]);
  const file = join(out.parts);
  assert.equal(file.length, out.size);
  assert.deepEqual(readBoxes(file).map(b => b.type).slice(0, 3), ['ftyp', 'moov', 'sidx']);
  assert.equal(readBoxes(file).filter(b => b.type === 'moof').length, segs.length);
  assert.ok(Math.abs(out.duration - 24) < 1.5, `duration ${out.duration}`);
  assert.deepEqual(out.tracks.map(t => t.handler), ['vide']);

  // sidx: reference count and sizes add up to the fragment bytes
  const sidx = readBoxes(file).find(b => b.type === 'sidx');
  const count = (file[sidx.body + 30] << 8) | file[sidx.body + 31];
  assert.equal(count, segs.length);
  let total = 0;
  for (let k = 0; k < count; k++) {
    const o = sidx.body + 32 + 12 * k;
    total += ((file[o] << 24) | (file[o + 1] << 16) | (file[o + 2] << 8) | file[o + 3]) & 0x7fffffff;
  }
  assert.equal(total, file.length - sidx.end);

  // timeline starts at 0 and is continuous
  const times = decodeTimes(file, 1);
  assert.equal(times[0].start, 0);
  for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i].start - times[i - 1].end) < 0.05, `gap before fragment ${i}`);
});

test('a timestamp jump (HLS discontinuity) is closed', () => {
  // shift every fragment from segment 6 on by +100 s by rewriting its tfdt in a copy
  const shifted = segs.map((s, i) => {
    if (i < 6) return s;
    const copy = s.slice();
    const info = parseInit(init);
    const frags = parseFragments(copy, new Map(info.tracks.map(t => [t.id, t])));
    const ts = info.tracks[0].timescale;
    for (const f of frags) for (const t of f.trafs) {
      const v = t.decodeTime + 100 * ts;
      const o = t.tfdtAt;
      if (t.tfdtVersion === 1) {
        const hi = Math.floor(v / 4294967296);
        const lo = v >>> 0;
        copy.set([hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255], o);
      } else {
        copy.set([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], o);
      }
    }
    return copy;
  });
  const out = buildMp4([{ init, segments: shifted }]);
  assert.ok(out.duration < 30, `the jump was kept: ${out.duration}`);
  const times = decodeTimes(join(out.parts), 1);
  for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i].start - times[i - 1].end) < 0.05, `gap before fragment ${i}`);
});

test('two sources (video + a second stream): unique track IDs, both traks, interleaved by time', () => {
  const out = buildMp4([{ init, segments: segs }, { init, segments: segs.slice(0, 6) }]);
  const file = join(out.parts);
  assert.deepEqual(out.tracks.map(t => t.id), [1, 2]);
  const moov = readBoxes(file).find(b => b.type === 'moov');
  const info = parseInit(file.subarray(0, moov.end));
  assert.deepEqual(info.tracks.map(t => t.id), [1, 2]);
  const second = decodeTimes(file, 2);
  assert.equal(second.length, 6);
  assert.equal(second[0].start, 0);
  // fragments are in time order: the second track's fragments sit between the first's
  const order = parseFragments(file, new Map(info.tracks.map(t => [t.id, t]))).map(f => f.trafs[0].trackId);
  assert.deepEqual(order.slice(0, 4), [1, 2, 1, 2]);
  // the next_track_ID of mvhd is past both tracks
  const mvhd = readBoxes(file, moov.body, moov.end).find(b => b.type === 'mvhd');
  const v = file[mvhd.body];
  const at = mvhd.body + (v === 1 ? 108 : 96);
  assert.equal((file[at] << 24) | (file[at + 1] << 16) | (file[at + 2] << 8) | file[at + 3], 3);
});

test('rejects input without media', () => {
  assert.throws(() => buildMp4([]), /nothing to write/);
  assert.throws(() => buildMp4([{ init, segments: [new Uint8Array(16)] }]), /no media fragments/);
  assert.throws(() => buildMp4([{ init: new Uint8Array(16), segments: segs }]), /no moov/);
});
