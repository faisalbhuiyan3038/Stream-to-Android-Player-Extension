import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamCache, segmentKey, parseRange, planFile } from '../src/stream-cache.mjs';
import { MemoryStore } from '../src/segment-store.mjs';
import { hlsPlan, pickLevelIndex } from '../src/cache-hls.mjs';
import { pickVariant } from '../src/cache-shaka.mjs';

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 30) { for (let i = 0; i < n; i++) await tick(); }

// A fake clock with timers that fire when the test advances time
function clock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer(fn, ms) {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return () => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); };
    },
    async advance(ms) {
      t += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > t) break;
        timers.shift().fn();
        await settle();
      }
      await settle();
    }
  };
}

// A fake server: `respond(url, init)` decides per request; requests are logged
function server(respond = () => ({ status: 200 })) {
  const log = [];
  const fetchFn = async (url, init = {}) => {
    log.push({ url, range: init.headers && init.headers.Range });
    const r = respond(url, init, log.length) || { status: 200 };
    const body = r.body || new TextEncoder().encode(`data:${url}:${(init.headers && init.headers.Range) || ''}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: k => (r.headers || {})[k.toLowerCase()] || null },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    };
  };
  return { log, fetchFn };
}

const segs = (n, dur = 2, prefix = 'https://cdn/s') => Array.from({ length: n }, (_, i) => ({ url: `${prefix}${i}.m4s`, time: i * dur, duration: dur }));
const text = async p => new TextDecoder().decode(await p);

test('segment keys and Range headers', () => {
  assert.equal(segmentKey('u'), 'u');
  assert.equal(segmentKey('u', 0, 99), 'u|0-99');
  assert.equal(segmentKey('u', 100, null), 'u|100-');
  assert.deepEqual(parseRange('bytes=10-20'), { start: 10, end: 20 });
  assert.deepEqual(parseRange('bytes=10-'), { start: 10, end: null });
  assert.deepEqual(parseRange(undefined), { start: 0, end: null });
});

test('downloads everything: init first, from the playhead to the end, then from the start', async () => {
  const c = clock();
  const s = server();
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPosition(10);
  cache.setPlan([{ url: 'https://cdn/init.mp4', init: true }, ...segs(10)]);
  await settle(200);
  const order = s.log.map(r => r.url.split('/').pop());
  assert.deepEqual(order, ['init.mp4', 's5.m4s', 's6.m4s', 's7.m4s', 's8.m4s', 's9.m4s', 's0.m4s', 's1.m4s', 's2.m4s', 's3.m4s', 's4.m4s']);
  const p = cache.progress();
  assert.equal(p.complete, true);
  assert.equal(p.done, 11);
});

test('runs several requests at once and ramps up while it gets faster', async () => {
  const c = clock();
  let inFlight = 0;
  let max = 0;
  const fetchFn = async (url) => {
    inFlight++;
    max = Math.max(max, inFlight);
    await settle(3);
    inFlight--;
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(1000) };
  };
  let elapsed = 0;
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn, maxParallel: 4, now: () => (elapsed += 1), setTimer: c.setTimer });
  cache.setPlan(segs(40));
  await settle(400);
  assert.equal(cache.progress().complete, true);
  assert.ok(max >= 2, `max in flight ${max}`);
  assert.ok(max <= 4);
});

test('never gives up on a failing segment: retries with a growing delay until it works', async () => {
  const c = clock();
  let failures = 0;
  const s = server((url) => {
    if (url.endsWith('s1.m4s') && failures < 6) { failures++; return { status: 500 }; }
    return { status: 200 };
  });
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(3));
  await settle(100);
  assert.equal(cache.progress().done, 2, 'the others are not held up');
  for (let i = 0; i < 20 && !cache.progress().complete; i++) await c.advance(30000);
  assert.equal(cache.progress().complete, true);
  assert.equal(failures, 6);
  assert.equal(cache.stats.failures, 6);
});

test('429 / 403 pause all downloads (Retry-After honoured), then it carries on', async () => {
  const c = clock();
  let limited = true;
  const s = server((url) => (limited && url.endsWith('s2.m4s') ? { status: 429, headers: { 'retry-after': '20' } } : { status: 200 }));
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(6));
  await settle(100);
  const before = s.log.length;
  assert.equal(cache.progress().retrying, true);
  await c.advance(10000);
  assert.equal(s.log.length, before, 'nothing requested while paused');
  limited = false;
  await c.advance(11000);
  for (let i = 0; i < 5 && !cache.progress().complete; i++) await c.advance(5000);
  assert.equal(cache.progress().complete, true);
});

test('the player gets cached segments, in-flight ones, and starts a planned one at once', async () => {
  const c = clock();
  const s = server();
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(5));
  await settle(100);
  assert.equal(await text(cache.get('https://cdn/s3.m4s')), 'data:https://cdn/s3.m4s:');
  assert.equal(cache.get('https://cdn/other.m4s'), null, 'not planned: the player loads it itself');
  // a second copy is a fresh buffer (hls.js may transfer the first one to a worker)
  const a = await cache.get('https://cdn/s0.m4s');
  const b = await cache.get('https://cdn/s0.m4s');
  assert.notEqual(a, b);
  assert.equal(cache.stats.hits, 3);
});

test('a planned segment the player wants jumps the queue', async () => {
  const c = clock();
  const resolvers = [];
  const fetchFn = (url) => new Promise((resolve) => resolvers.push({ url, resolve }));
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(10));
  await settle();
  assert.equal(resolvers.length, 1);
  const wanted = cache.get('https://cdn/s7.m4s');
  assert.ok(wanted);
  await settle();
  assert.equal(resolvers[1].url, 'https://cdn/s7.m4s', 'started at once, beside the running one');
  resolvers[1].resolve({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('seven').buffer });
  assert.equal(await text(wanted), 'seven');
});

test('segments the player loaded itself are kept (put)', async () => {
  const c = clock();
  const s = server(() => ({ status: 500 }));
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(2));
  await settle(50);
  cache.put('https://cdn/s1.m4s', 0, null, new TextEncoder().encode('from player'));
  cache.put('https://cdn/unplanned.m4s', 0, null, new Uint8Array(4));
  await settle(50);
  assert.equal(await text(cache.get('https://cdn/s1.m4s')), 'from player');
  assert.equal(cache.items.has('https://cdn/unplanned.m4s'), false);
});

test('byte ranges: Range header sent, a server that ignores it is sliced', async () => {
  const c = clock();
  const whole = new TextEncoder().encode('0123456789');
  const s = server(() => ({ status: 200, body: whole }));
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan([{ url: 'https://cdn/f.mp4', start: 2, end: 5, time: 0, duration: 1 }]);
  await settle(50);
  assert.equal(s.log[0].range, 'bytes=2-5');
  assert.equal(await text(cache.get('https://cdn/f.mp4', 2, 5)), '2345');
});

test('storage limit: drops segments far behind the playhead, keeps a window ahead', async () => {
  const c = clock();
  const body = new Uint8Array(100);
  const s = server(() => ({ status: 200, body }));
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, maxBytes: 500, behindSeconds: 4, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(20)); // 2 s each, 100 bytes each
  await settle(200);
  assert.equal(cache.progress().done, 5, 'stops at the limit');
  assert.equal(cache.progress().windowMode, true);
  cache.setPosition(20); // segments ending before 16 s may go
  await settle(200);
  const done = cache.plan.filter(i => i.state === 'done').map(i => i.time);
  assert.ok(cache.storedBytes <= 500, `stored ${cache.storedBytes}`);
  assert.ok(done.every(t => t >= 20 || t + 2 >= 16), `kept ${done}`);
  assert.ok(done.includes(20), `segment at the playhead downloaded: ${done}`);
});

test('a write that fails (disk full) lowers the limit instead of stopping', async () => {
  const c = clock();
  const store = new MemoryStore();
  let writes = 0;
  const put = store.put.bind(store);
  store.put = async (k, v) => { if (++writes === 3) throw new Error('QuotaExceededError'); return put(k, v); };
  const s = server();
  const cache = new StreamCache({ store, fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(4));
  await settle(100);
  assert.equal(cache.windowMode, true);
  assert.ok(cache.maxBytes < Infinity);
});

test('a new quality: what is downloaded stays, unfinished ones of the old quality are forgotten', async () => {
  const c = clock();
  const s = server();
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.setPlan(segs(3, 2, 'https://cdn/low'));
  await settle(100);
  cache.setPlan(segs(3, 2, 'https://cdn/high'));
  await settle(100);
  assert.equal(cache.progress().complete, true);
  assert.equal(cache.progress().total, 3);
  assert.ok(cache.get('https://cdn/low0.m4s'), 'old quality still served if asked for');
});

test('assemble() joins a plain file in order once complete', async () => {
  const c = clock();
  const data = new TextEncoder().encode('abcdefghij');
  const s = server((url, init) => {
    const { start, end } = parseRange(init.headers && init.headers.Range);
    return { status: 206, body: data.subarray(start, end + 1) };
  });
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 2, now: c.now, setTimer: c.setTimer });
  cache.setPosition(2);
  cache.setPlan([0, 4, 8].map((st, i) => ({ url: 'https://cdn/f.mp4', start: st, end: Math.min(9, st + 3), time: i, duration: 1 })));
  await settle(100);
  const blob = await cache.assemble('video/mp4');
  assert.equal(await blob.text(), 'abcdefghij');
  assert.equal(blob.type, 'video/mp4');
});

test('planFile: byte-range chunks from the size in Content-Range; null without range support', async () => {
  const ranged = server(() => ({ status: 206, headers: { 'content-range': 'bytes 0-0/10485760', 'content-type': 'video/mp4' } }));
  const plan = await planFile('https://cdn/f.mp4', { fetchFn: ranged.fetchFn, chunkBytes: 4 * 1024 * 1024 });
  assert.equal(plan.total, 10485760);
  assert.equal(plan.segments.length, 3);
  assert.deepEqual(plan.segments[2], { url: 'https://cdn/f.mp4', start: 8388608, end: 10485759, time: 2, duration: 1 });
  const plain = server(() => ({ status: 200 }));
  assert.equal(await planFile('https://cdn/f.mp4', { fetchFn: plain.fetchFn }), null);
});

test('hlsPlan: fragments of the playing level (+ init, byte ranges) and of an alternate audio rendition', () => {
  const init = { url: 'https://cdn/v/init.mp4', byteRangeStartOffset: 0, byteRangeEndOffset: 800 };
  const hls = {
    loadLevel: 1, currentLevel: 1,
    levels: [{}, { details: { fragments: [
      { url: 'https://cdn/v/a.m4s', start: 0, duration: 4, initSegment: init },
      { url: 'https://cdn/v/a.m4s', start: 4, duration: 4, initSegment: init, byteRangeStartOffset: 1000, byteRangeEndOffset: 2000 }
    ] } }],
    audioTrack: 0,
    audioTracks: [{ url: 'https://cdn/a.m3u8', details: { fragments: [{ url: 'https://cdn/a/0.aac', start: 0, duration: 4 }] } }]
  };
  const plan = hlsPlan(hls);
  assert.deepEqual(plan.map(p => [p.url.split('/').slice(-2).join('/'), p.start, p.end, p.init || false]), [
    ['v/init.mp4', 0, 799, true],
    ['v/a.m4s', undefined, undefined, false],
    ['v/init.mp4', 0, 799, true],
    ['v/a.m4s', 1000, 1999, false],
    ['a/0.aac', undefined, undefined, false]
  ]);
  hls.audioTracks[0].url = undefined; // muxed audio
  assert.equal(hlsPlan(hls).length, 4);
});

test('quality pick: closest height, highest bitrate among equals', () => {
  const levels = [{ height: 360, bitrate: 1 }, { height: 720, bitrate: 2 }, { height: 720, bitrate: 3 }, { height: 1080, bitrate: 5 }];
  assert.equal(pickLevelIndex(levels, 800), 2);
  assert.equal(pickLevelIndex(levels, 2000), 3);
  assert.equal(pickLevelIndex([], 720), -1);
  const variants = [{ height: 480, bandwidth: 1 }, { height: 1080, bandwidth: 4 }, { height: 1080, bandwidth: 6 }];
  assert.equal(pickVariant(variants, 1200).bandwidth, 6);
  assert.equal(pickVariant([{ bandwidth: 1 }], 720), null);
});

test('segments the player loaded before the first plan are adopted, not fetched again', async () => {
  const c = clock();
  const s = server();
  const cache = new StreamCache({ store: new MemoryStore(), fetchFn: s.fetchFn, maxParallel: 1, now: c.now, setTimer: c.setTimer });
  cache.put('https://cdn/s0.m4s', 0, null, new TextEncoder().encode('early'));
  cache.setPlan(segs(3));
  await settle(100);
  assert.equal(cache.progress().complete, true);
  assert.deepEqual(s.log.map(r => r.url), ['https://cdn/s1.m4s', 'https://cdn/s2.m4s']);
  assert.equal(await text(cache.get('https://cdn/s0.m4s')), 'early');
});
