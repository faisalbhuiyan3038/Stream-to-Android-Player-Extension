// Unit tests for the helpers of src/downloader.mjs (the full flow runs in tests/e2e/chromium.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sniffSegment, sequenceIv, runPool, safeFileName, describeManifest, uriOf, initSegmentOf, aesKeyOf, fetchBytes, downloadManifest } from '../src/downloader.mjs';
import { MemoryStore } from '../src/segment-store.mjs';

test('sniffSegment: TS, fMP4, ADTS/AAC (with ID3), MP3, unknown', () => {
  const ts = new Uint8Array(376); ts[0] = 0x47; ts[188] = 0x47;
  assert.equal(sniffSegment(ts), 'ts');
  const moof = Uint8Array.from([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffSegment(moof), 'fmp4');
  const styp = Uint8Array.from([0, 0, 0, 16, 0x73, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffSegment(styp), 'fmp4');
  assert.equal(sniffSegment(Uint8Array.from([0xff, 0xf1, 0x50, 0x80])), 'aac');
  const id3 = new Uint8Array(20); id3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]); id3.set([0xff, 0xf9], 10);
  assert.equal(sniffSegment(id3), 'aac');
  assert.equal(sniffSegment(Uint8Array.from([0xff, 0xfb, 0x90, 0x64])), 'mp3');
  assert.equal(sniffSegment(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), 'unknown');
  assert.equal(sniffSegment(null), 'unknown');
});

test('sequenceIv: big-endian media sequence number in the last bytes', () => {
  assert.deepEqual([...sequenceIv(0)], new Array(16).fill(0));
  assert.deepEqual([...sequenceIv(258)].slice(12), [0, 0, 1, 2]);
});

test('runPool: keeps order, respects the limit, fails fast', async () => {
  let active = 0;
  let max = 0;
  const tasks = Array.from({ length: 10 }, (_, i) => async () => {
    active++; max = Math.max(max, active);
    await new Promise(r => setTimeout(r, 5 + (i % 3) * 5));
    active--;
    return i * 2;
  });
  const done = [];
  assert.deepEqual(await runPool(tasks, 3, i => done.push(i)), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.ok(max <= 3 && max >= 2, `max ${max}`);
  assert.equal(done.length, 10);
  await assert.rejects(runPool([async () => 1, async () => { throw new Error('boom'); }], 2), /boom/);
});

test('fetchBytes: range header, retries, gives up on 403/404', async () => {
  const calls = [];
  const responses = [{ ok: false, status: 500 }, { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(4) }];
  const fetchFn = async (url, init) => { calls.push(init.headers.Range); return responses.shift(); };
  const data = await fetchBytes('https://x/s.mp4', { start: 100, end: 199, fetchFn, delay: async () => {} });
  assert.equal(data.length, 4);
  assert.deepEqual(calls, ['bytes=100-199', 'bytes=100-199']);
  let n = 0;
  await assert.rejects(fetchBytes('https://x/gone', { fetchFn: async () => { n++; return { ok: false, status: 404 }; }, delay: async () => {} }), /HTTP 404/);
  assert.equal(n, 1, 'a 404 is not retried');
});

test('safeFileName: strips characters file systems reject', () => {
  assert.equal(safeFileName('Show: Part 1/2 "Final"?', 'mp4'), 'Show Part 1 2 Final.mp4');
  assert.equal(safeFileName('', 'webm'), 'video.webm');
  assert.equal(safeFileName('进击的巨人 E05', 'mp4'), '进击的巨人 E05.mp4');
});

test('describeManifest: unique qualities (best first), audio languages, DRM and live flags', () => {
  const v = (id, height, bandwidth) => ({ id, height, width: height * 16 / 9, bandwidth, codecs: 'avc1' });
  const a = (id, language, bandwidth) => ({ id, language, bandwidth, channelsCount: 2 });
  const manifest = {
    variants: [
      { video: v(1, 480, 1e6), audio: a(10, 'en', 128e3) },
      { video: v(2, 1080, 5e6), audio: a(10, 'en', 128e3) },
      { video: v(2, 1080, 5e6), audio: a(11, 'fr', 96e3) }
    ],
    presentationTimeline: { getDuration: () => 600, isLive: () => false }
  };
  const d = describeManifest(manifest);
  assert.deepEqual(d.videos.map(x => x.height), [1080, 480]);
  assert.deepEqual(d.audios.map(x => x.language), ['en', 'fr']);
  assert.equal(d.duration, 600);
  assert.equal(d.drm, false);
  manifest.variants[0].video.drmInfos = [{ keySystem: 'com.widevine.alpha' }];
  assert.equal(describeManifest(manifest).drm, true);
});

test('Shaka reference helpers work with minified field names', () => {
  class InitSegmentReference { constructor(uris) { this.a = uris; this.b = 0; } }
  const shaka = { media: { InitSegmentReference } };
  const init = new InitSegmentReference(() => ['https://cdn/init.mp4']);
  const key = { blockCipherMode: 'CBC', firstMediaSequenceNumber: 5, iv: null };
  const ref = { x: init, y: key, getUris: () => ['https://cdn/seg1.m4s'] };
  assert.equal(initSegmentOf(shaka, ref), init);
  assert.equal(uriOf(init), 'https://cdn/init.mp4');
  assert.equal(uriOf(ref), 'https://cdn/seg1.m4s');
  assert.equal(aesKeyOf(ref), key);
  assert.equal(aesKeyOf({ getUris: () => [] }), null);
  assert.equal(initSegmentOf(shaka, { getUris: () => [] }), null);
});

// ─── segments already in a player's cache ────────────────────────────────────
// A player's Save hands its cache to the download page. Unencrypted cached segments must be used
// as they are (the MP4 made of slices of them), not copied into the page's own store: a second
// copy of a long video on disk is what can fill it.
{
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e', 'fixtures', 'hls');
  const read = f => new Uint8Array(fs.readFileSync(path.join(fixtures, f)));
  const segNames = fs.readFileSync(path.join(fixtures, 'index.m3u8'), 'utf8').split(/\r?\n/).filter(l => l.endsWith('.m4s'));
  const files = new Map([['init.mp4', read('init.mp4')], ...segNames.map(n => [n, read(n)])]);

  // the shape of Shaka's manifest the downloader reads; `encrypted`: segment index → AES key
  const manifestOf = (encrypted = new Map()) => {
    const initRef = { getUris: () => ['init.mp4'], startByte: 0, endByte: null };
    const refs = segNames.map((n, i) => ({
      getUris: () => [n], getStartTime: () => i * 2, getEndTime: () => i * 2 + 2,
      startByte: 0, endByte: null, initSegmentReference: initRef, aesKey: encrypted.get(i) || null
    }));
    const video = { id: 1, codecs: 'avc1.42e01e', createSegmentIndex: async () => {}, segmentIndex: refs };
    return { variants: [{ video }] };
  };
  const counted = (bytesOf) => {
    const asked = [];
    const fetchFn = async (u) => { asked.push(u); return new Response(bytesOf(u)); };
    return { asked, fetchFn };
  };
  const bytesOfBlob = async b => new Uint8Array(await b.arrayBuffer());

  test('downloadManifest: cached segments are used in place, not copied into the store', async () => {
    const plain = counted(u => files.get(u));
    const fromNetwork = await downloadManifest({ shaka: {}, manifest: manifestOf(), choice: { videoId: 1 }, fetchFn: plain.fetchFn, store: new MemoryStore() });
    assert.equal(fromNetwork.stored, segNames.length);

    const net = counted(u => files.get(u));
    const store = new MemoryStore();
    const asked = [];
    const cachedBlob = async (u, range) => { asked.push([u, range]); return new Blob([files.get(u)]); };
    const fromCache = await downloadManifest({ shaka: {}, manifest: manifestOf(), choice: { videoId: 1 }, fetchFn: net.fetchFn, store, cachedBlob });
    assert.equal(fromCache.stored, 0, 'nothing copied');
    assert.deepEqual(await store.keys(), []);
    assert.deepEqual(net.asked, ['init.mp4'], 'only the init segment from the network');
    assert.deepEqual(asked[0], [segNames[0], { start: 0, end: null }]);
    assert.deepEqual(await bytesOfBlob(fromCache.blob), await bytesOfBlob(fromNetwork.blob), 'the same file');
  });

  test('downloadManifest: a cache miss is fetched and stored; an encrypted segment is never taken from the cache as it is', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(16));
    const cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt', 'decrypt']);
    const iv = new Uint8Array(16);
    const aesKey = { cryptoKey, iv, blockCipherMode: 'CBC', firstMediaSequenceNumber: 0 };
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, files.get(segNames[1])));
    const bytesOf = u => (u === segNames[1] ? cipher : files.get(u));
    const reference = await downloadManifest({ shaka: {}, manifest: manifestOf(), choice: { videoId: 1 }, fetchFn: counted(u => files.get(u)).fetchFn });

    const net = counted(bytesOf);
    const asked = [];
    const cachedBlob = async (u) => { asked.push(u); return u === segNames[2] ? null : new Blob([bytesOf(u)]); };
    const out = await downloadManifest({ shaka: {}, manifest: manifestOf(new Map([[1, aesKey]])), choice: { videoId: 1 }, fetchFn: net.fetchFn, store: new MemoryStore(), cachedBlob });
    assert.ok(!asked.includes(segNames[1]), 'the encrypted segment goes through fetch + decrypt');
    assert.deepEqual(net.asked.sort(), ['init.mp4', segNames[1], segNames[2]].sort());
    assert.equal(out.stored, 2, 'the decrypted segment and the cache miss');
    assert.deepEqual(await bytesOfBlob(out.blob), await bytesOfBlob(reference.blob));
  });
}
