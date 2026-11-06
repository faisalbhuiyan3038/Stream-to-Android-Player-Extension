// Unit tests for src/prefetch.mjs (parallel segment prefetcher).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentPrefetcher, bufferingSettings } from '../src/prefetch.mjs';

// A fake network: each URL resolves after `latency` ms (virtual clock), `failures` maps url -> status list
function fakeNet({ latency = 100, size = 1000, statuses = {} } = {}) {
  let clock = 0;
  const timers = [];
  const net = {
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
    now: () => clock,
    sleep: ms => new Promise(r => timers.push({ at: clock + ms, r })),
    fetchFn: (url) => {
      net.calls.push(url);
      net.inFlight++;
      net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
      const list = statuses[url];
      const status = list && list.length ? list.shift() : 200;
      return new Promise(r => timers.push({
        at: clock + latency,
        r: () => {
          net.inFlight--;
          r({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => new ArrayBuffer(size) });
        }
      }));
    },
    // advance the virtual clock until nothing is pending
    async run(limit = 100000) {
      for (let i = 0; i < limit; i++) {
        await new Promise(r => setImmediate(r));
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at);
        const t = timers.shift();
        clock = Math.max(clock, t.at);
        t.r();
      }
    }
  };
  return net;
}

const urls = n => Array.from({ length: n }, (_, i) => `https://cdn/seg${i}.ts`);

test('downloads ahead in parallel and hands the bytes over once', async () => {
  const net = fakeNet();
  const p = new SegmentPrefetcher({ fetchFn: net.fetchFn, maxParallel: 4, now: net.now, sleep: net.sleep });
  p.prefetch(urls(8));
  await net.run();
  assert.equal(net.calls.length, 8);
  assert.ok(net.maxInFlight >= 2, `max in flight ${net.maxInFlight}`);
  assert.ok(net.maxInFlight <= 4);
  const data = await p.take('https://cdn/seg0.ts');
  assert.equal(data.byteLength, 1000);
  assert.equal(p.take('https://cdn/seg0.ts'), null, 'second take is a miss (memory freed)');
  assert.equal(p.take('https://cdn/other.ts'), null);
});

test('speed test ramps concurrency up while throughput improves, never above the maximum', async () => {
  const net = fakeNet({ latency: 100 });
  const p = new SegmentPrefetcher({ fetchFn: net.fetchFn, maxParallel: 6, now: net.now, sleep: net.sleep });
  assert.equal(p.parallel, 2);
  p.prefetch(urls(40));
  await net.run();
  assert.ok(p.parallel > 2, `parallel stayed at ${p.parallel}`);
  assert.ok(net.maxInFlight <= 6);
});

test('failures are retried with backoff; a permanent failure is a miss and costs a slot', async () => {
  const net = fakeNet({ statuses: { 'https://cdn/seg1.ts': [500, 200], 'https://cdn/seg2.ts': [500, 500, 500] } });
  const p = new SegmentPrefetcher({ fetchFn: net.fetchFn, maxParallel: 3, retries: 2, now: net.now, sleep: net.sleep });
  p.prefetch(urls(3));
  await net.run();
  assert.equal((await p.take('https://cdn/seg1.ts')).byteLength, 1000, 'retried and succeeded');
  assert.equal(p.take('https://cdn/seg2.ts'), null, 'gave up: the player loads it itself');
  assert.equal(net.calls.filter(u => u.endsWith('seg2.ts')).length, 3);
  assert.equal(p.stats.failures, 1);
});

test('403/429 stop prefetching for the session', async () => {
  const net = fakeNet({ statuses: { 'https://cdn/seg0.ts': [429] } });
  const p = new SegmentPrefetcher({ fetchFn: net.fetchFn, maxParallel: 1, now: net.now, sleep: net.sleep });
  p.prefetch(urls(5));
  await net.run();
  assert.equal(p.disabled, true);
  assert.equal(net.calls.length, 1, 'nothing else was requested after the 429');
  p.prefetch(['https://cdn/later.ts']);
  await net.run();
  assert.equal(net.calls.length, 1);
});

test('byte budget: stops downloading when unused data fills it, evicts the oldest', async () => {
  const net = fakeNet({ size: 1000 });
  const p = new SegmentPrefetcher({ fetchFn: net.fetchFn, maxParallel: 1, maxBytes: 3000, now: net.now, sleep: net.sleep });
  p.prefetch(urls(10));
  await net.run();
  assert.equal(p.storedBytes(), 3000);
  assert.equal(net.calls.length, 3, 'kept downloading past the budget');
  // the player consumes one: room for one more
  await p.take('https://cdn/seg0.ts');
  p.prefetch(urls(10).slice(1));
  await net.run();
  assert.equal(net.calls.length, 4);
  // a seek elsewhere: the old, unwanted downloads are evicted to make room
  p.prefetch(['https://cdn/seg90.ts', 'https://cdn/seg91.ts']);
  await net.run();
  assert.ok(net.calls.includes('https://cdn/seg91.ts'));
  assert.equal(p.take('https://cdn/seg1.ts'), null, 'stale download kept');
});

test('a seek drops queued work that is no longer wanted; take() of a queued URL starts it at once', async () => {
  const net = fakeNet();
  const p = new SegmentPrefetcher({ fetchFn: net.fetchFn, maxParallel: 1, now: net.now, sleep: net.sleep });
  p.prefetch(urls(6)); // seg0 starts, 1..5 queued
  p.prefetch(['https://cdn/seg50.ts', 'https://cdn/seg51.ts']); // user seeked
  assert.deepEqual(p.queue, ['https://cdn/seg50.ts', 'https://cdn/seg51.ts']);
  const promise = p.take('https://cdn/seg51.ts'); // wanted right now: jumps the queue (one extra slot)
  assert.ok(promise, 'queued entry should start immediately');
  await net.run();
  assert.equal((await promise).byteLength, 1000);
  assert.ok(!net.calls.includes('https://cdn/seg3.ts'), 'dropped segments were still fetched');
});

test('bufferingSettings: defaults, limits and the phone budget', () => {
  const d = bufferingSettings({});
  assert.deepEqual([d.enabled, d.parallel, d.bufferAhead], [true, 4, 120]);
  const m = bufferingSettings({}, { mobile: true });
  assert.equal(m.bufferAhead, 60);
  assert.ok(m.prefetchBytes < d.prefetchBytes && m.maxBufferBytes < d.maxBufferBytes);
  const x = bufferingSettings({ fastBuffering: false, fastBufferingParallel: 50, bufferAheadSeconds: 5 });
  assert.deepEqual([x.enabled, x.parallel, x.bufferAhead], [false, 8, 10]);
});
