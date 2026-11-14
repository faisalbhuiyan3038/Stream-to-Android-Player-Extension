// Whole-video download for the built-in players (FastStream's approach): every segment of the
// playing quality is downloaded, in parallel, from the playhead to the end and then from the
// start up to the playhead, into IndexedDB (on disk), while the player streams. The player's
// segment requests are served from it, so after a while nothing waits on the network any more,
// and once everything is in, the video can be saved without downloading it again.
//
// - Independent of the player's own buffer: browsers cap how much video a <video> element may
//   hold (about 150 MB in Chrome), so hls.js / Shaka only buffer a window ahead; this cache is
//   where the rest waits.
// - Never gives up: a failed segment is retried with a growing delay (1 s … 30 s), failures in a
//   row or a 403/429/503 pause everything for a while (Retry-After honoured) and drop to one
//   request at a time, then the speed test ramps up again. The player's own request for a
//   segment always goes ahead immediately.
// - Byte limit (`maxBytes`, also lowered when the browser reports less free quota or a write
//   fails): segments far behind the playhead are dropped to make room for ones ahead; if the
//   whole video does not fit, it keeps a window ahead of the playhead ("window mode").
// - Timers run in a worker (src/timer.mjs) so a background tab keeps its pace.
//
// Engine glue: src/cache-hls.mjs (hls.js fragment loader + plan) and src/cache-shaka.mjs (Shaka
// networking scheme + plan). Plain files are cached as byte ranges (planFile).

import { openStore, removeLeftoverStores } from './segment-store.mjs';
import { setTimer as workerTimer } from './timer.mjs';

export const CACHE_PREFIX = 'sap-cache-';
const MB = 1024 * 1024;

// One key per segment (and byte range). `end` is inclusive, as in an HTTP Range header.
export function segmentKey(url, start = 0, end = null) {
  return (start > 0 || end != null) ? `${url}|${start}-${end == null ? '' : end}` : url;
}

// "bytes=100-199" → { start: 100, end: 199 }; no header → { start: 0, end: null }
export function parseRange(header) {
  const m = /bytes=(\d+)-(\d*)/i.exec(header || '');
  if (!m) return { start: 0, end: null };
  return { start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
}

export class StreamCache {
  constructor({
    store,
    fetchFn = (url, init) => globalThis.fetch(url, init),
    maxParallel = 4,
    maxBytes = Infinity,
    memoryBytes = 48 * MB,
    behindSeconds = 60,
    requestTimeout = 120000,
    now = () => Date.now(),
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    fetchInit = { credentials: 'same-origin' },
    onChange = () => {}
  } = {}) {
    this.store = store;
    this.fetchFn = fetchFn;
    this.maxParallel = Math.max(1, maxParallel);
    this.parallel = Math.min(2, this.maxParallel);
    this.maxBytes = maxBytes;
    this.memoryBytes = memoryBytes;
    this.behindSeconds = behindSeconds;
    this.requestTimeout = requestTimeout;
    this.now = now;
    this.setTimer = setTimer;
    this.fetchInit = fetchInit;
    this.onChange = onChange;

    this.items = new Map();   // key → item
    this.plan = [];           // items of the playing quality: init segments first, then by time
    this.planned = new Set(); // their keys
    this.position = 0;
    this.active = 0;
    this.storedBytes = 0;
    this.orphans = new Map(); // key → Blob the player loaded before it was planned (start-up)
    this.orphanBytes = 0;
    this.memory = new Map();  // key → Blob, most recent last (served without a disk read)
    this.memoryUsed = 0;
    this.pausedUntil = 0;
    this.failuresInRow = 0;
    this.windowMode = false;  // the limit was reached: only a window ahead is kept
    this.destroyed = false;
    this.controllers = new Set();
    this.recent = [];         // [time, bytes] of the last few seconds (speed)
    this.stats = { requests: 0, hits: 0, misses: 0, failures: 0, bytes: 0, maxActive: 0, fromPlayer: 0 };

    // speed test (as in src/prefetch.mjs): add a request while throughput keeps improving
    this.ramping = this.parallel < this.maxParallel;
    this.windowBytes = 0;
    this.windowDone = 0;
    this.windowStart = 0;
    this.lastThroughput = 0;
  }

  get name() { return this.store && this.store.name; }

  // segments: [{ url, start?, end?, time, duration, init?, track? }] — the playing quality (and
  // audio rendition). Replaces the previous plan; what is already downloaded stays.
  setPlan(segments) {
    const plan = [];
    const keys = new Set();
    for (const s of segments) {
      if (!s || !s.url) continue;
      const start = s.start || 0;
      const end = s.end == null ? null : s.end;
      const key = segmentKey(s.url, start, end);
      if (keys.has(key)) continue;
      keys.add(key);
      let item = this.items.get(key);
      if (!item) {
        item = { key, url: s.url, start, end, state: 'missing', bytes: 0, tries: 0, retryAt: 0 };
        this.items.set(key, item);
      }
      // loaded by the player before the plan was known (its first segments): kept, not fetched again
      const orphan = this.orphans.get(key);
      if (orphan && item.state === 'missing') {
        item.state = 'loading';
        item.promise = Promise.resolve(orphan);
        this.keep(item, orphan).then(() => { this.changed(); this.pump(); });
      }
      item.init = !!s.init;
      item.time = item.init ? -1 : Number(s.time) || 0;
      item.duration = Number(s.duration) || 0;
      plan.push(item);
    }
    this.orphans.clear();
    this.orphanBytes = 0;
    plan.sort((a, b) => (b.init - a.init) || (a.time - b.time));
    this.plan = plan;
    this.planned = keys;
    // segments of another quality that never finished are forgotten
    for (const [key, item] of this.items) {
      if (!keys.has(key) && item.state === 'missing') this.items.delete(key);
    }
    this.windowMode = false;
    this.changed();
    this.pump();
  }

  // The playhead (seconds, or the chunk position for a plain file)
  setPosition(seconds) {
    if (!Number.isFinite(seconds)) return;
    this.position = seconds;
    if (this.active < this.parallel) this.pump();
  }

  // Order of work: init segments, then from the playhead to the end, then from the start.
  * order() {
    let i = 0;
    for (; i < this.plan.length && this.plan[i].init; i++) yield this.plan[i];
    const first = i;
    let ahead = first;
    while (ahead < this.plan.length && this.plan[ahead].time + this.plan[ahead].duration <= this.position) ahead++;
    for (let j = ahead; j < this.plan.length; j++) yield this.plan[j];
    for (let j = first; j < ahead; j++) yield this.plan[j];
  }

  isAhead(item) {
    return item.init || item.time + item.duration > this.position;
  }

  pump() {
    if (this.destroyed) return;
    const now = this.now();
    if (now < this.pausedUntil) {
      this.wakeAt(this.pausedUntil);
      return;
    }
    let soonest = Infinity;
    for (const item of this.order()) {
      if (this.active >= this.parallel) break;
      if (item.state !== 'missing') continue;
      if (item.retryAt > now) {
        soonest = Math.min(soonest, item.retryAt);
        continue;
      }
      if (this.storedBytes >= this.maxBytes) {
        this.windowMode = true;
        // Room is only made for what comes next; behind the playhead, wait for it to move on
        if (!this.isAhead(item) || !this.makeRoom()) break;
      }
      this.run(item);
    }
    if (soonest < Infinity) this.wakeAt(soonest);
  }

  // Drops downloaded segments that are not needed soon: other qualities first, then the ones
  // furthest behind the playhead. Returns whether there is room now.
  makeRoom() {
    const limit = this.position - this.behindSeconds;
    const candidates = [...this.items.values()]
      .filter(it => it.state === 'done' && !it.init && (!this.planned.has(it.key) || it.time + it.duration < limit))
      .sort((a, b) => (this.planned.has(a.key) - this.planned.has(b.key)) || (a.time - b.time));
    while (candidates.length && this.storedBytes >= this.maxBytes) this.drop(candidates.shift());
    return this.storedBytes < this.maxBytes;
  }

  drop(item) {
    if (item.state === 'done') this.storedBytes -= item.bytes;
    item.state = 'missing';
    item.bytes = 0;
    this.forgetMemory(item.key);
    if (this.store) this.store.delete(item.key).catch(() => {});
    if (!this.planned.has(item.key)) this.items.delete(item.key);
  }

  wakeAt(time) {
    if (this.wakeTime && this.wakeTime <= time && this.wakeTime > this.now()) return;
    if (this.cancelWake) this.cancelWake();
    this.wakeTime = time;
    this.cancelWake = this.setTimer(() => {
      this.wakeTime = 0;
      this.cancelWake = null;
      this.pump();
    }, Math.max(0, time - this.now()));
  }

  async run(item) {
    item.state = 'loading';
    this.active++;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
    if (!this.windowStart) this.windowStart = this.now();
    item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    item.promise.catch(() => {});
    try {
      const data = await this.fetchItem(item);
      if (this.destroyed) return;
      const blob = new Blob([data]);
      item.resolve(blob);
      await this.keep(item, blob);
      this.failuresInRow = 0;
      this.stats.bytes += blob.size;
      this.sample(blob.size);
      this.measure(blob.size);
    } catch (e) {
      if (this.destroyed) return;
      item.state = 'missing';
      item.tries++;
      item.retryAt = this.now() + Math.min(30000, 1000 * Math.pow(2, Math.min(item.tries - 1, 5)));
      item.reject(e);
      this.stats.failures++;
      this.failuresInRow++;
      if (this.parallel > 1) this.parallel--;
      this.ramping = false;
      if (e.status === 403 || e.status === 429 || e.status === 503 || this.failuresInRow >= 4) {
        const backoff = Math.min(60000, 2000 * Math.pow(2, Math.min(this.failuresInRow - 1, 5)));
        this.pausedUntil = this.now() + (e.retryAfter || backoff);
      }
    } finally {
      this.active--;
      if (!this.destroyed) {
        this.changed();
        this.pump();
      }
    }
  }

  // Writes a downloaded segment to the store. A failed write (disk/quota full) lowers the limit
  // to what fits, so the cache carries on as a window ahead of the playhead.
  async keep(item, blob) {
    this.remember(item.key, blob);
    try {
      if (this.store) await this.store.put(item.key, blob);
    } catch (e) {
      this.forgetMemory(item.key);
      item.state = 'missing';
      item.retryAt = this.now() + 30000;
      this.maxBytes = Math.max(64 * MB, this.storedBytes * 0.9);
      this.windowMode = true;
      return;
    }
    if (this.destroyed) return;
    item.state = 'done';
    item.bytes = blob.size;
    item.tries = 0;
    this.storedBytes += blob.size;
  }

  async fetchItem(item) {
    const headers = {};
    const ranged = item.start > 0 || item.end != null;
    if (ranged) headers.Range = `bytes=${item.start}-${item.end == null ? '' : item.end}`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let cancelTimeout = null;
    if (controller) {
      this.controllers.add(controller);
      cancelTimeout = this.setTimer(() => controller.abort(), this.requestTimeout);
    }
    this.stats.requests++;
    try {
      const res = await this.fetchFn(item.url, { ...this.fetchInit, headers, ...(controller ? { signal: controller.signal } : {}) });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        if (after > 0) e.retryAfter = Math.min(300, after) * 1000;
        throw e;
      }
      let data = await res.arrayBuffer();
      // a server that ignores Range sends the whole file
      if (ranged && res.status === 200 && data.byteLength > (item.end == null ? 0 : item.end - item.start + 1)) {
        data = data.slice(item.start, item.end == null ? undefined : item.end + 1);
      }
      return data;
    } finally {
      if (cancelTimeout) cancelTimeout();
      if (controller) this.controllers.delete(controller);
    }
  }

  // The player wants a segment. Returns a promise of an ArrayBuffer (a fresh copy each time) if
  // it is downloaded or on its way — a planned segment not started yet starts now, ahead of
  // everything — else null: the caller loads it itself (and may hand it over with put()).
  get(url, start = 0, end = null) {
    const item = this.items.get(segmentKey(url, start, end));
    if (!item || this.destroyed) {
      this.stats.misses++;
      return null;
    }
    if (item.state === 'done') {
      this.stats.hits++;
      return this.blobOf(item).then(b => b.arrayBuffer());
    }
    if (item.state === 'missing') {
      // one request over the limit is allowed for the player; beyond that it loads by itself
      if (this.active > this.parallel) {
        this.stats.misses++;
        return null;
      }
      this.run(item);
    }
    this.stats.hits++;
    return item.promise.then(b => b.arrayBuffer());
  }

  // A segment the player loaded itself (a miss): kept if it belongs to the plan.
  put(url, start, end, data) {
    const key = segmentKey(url, start || 0, end == null ? null : end);
    const item = this.items.get(key);
    if (this.destroyed || !data) return;
    if (!item) {
      // Before the first plan (the player's start-up), keep a few: they are probably in it
      if (!this.plan.length && this.orphanBytes < 32 * MB) {
        const blob = new Blob([data]);
        this.orphans.set(key, blob);
        this.orphanBytes += blob.size;
      }
      return;
    }
    if (item.state !== 'missing') return;
    const blob = new Blob([data]); // copies now: hls.js may hand the buffer to a worker
    item.state = 'loading';
    item.promise = Promise.resolve(blob);
    this.stats.fromPlayer++;
    this.keep(item, blob).then(() => { this.changed(); this.pump(); });
  }

  // The stored Blob of a downloaded segment (memory or disk). A segment that went missing from
  // the store is marked for download again.
  async blobOf(item) {
    const mem = this.memory.get(item.key);
    if (mem) return mem;
    try {
      return await this.store.get(item.key);
    } catch (e) {
      if (item.state === 'done') {
        this.storedBytes -= item.bytes;
        item.state = 'missing';
        item.bytes = 0;
        this.pump();
      }
      throw e;
    }
  }

  remember(key, blob) {
    this.forgetMemory(key);
    this.memory.set(key, blob);
    this.memoryUsed += blob.size;
    for (const [k, b] of this.memory) {
      if (this.memoryUsed <= this.memoryBytes) break;
      this.memory.delete(k);
      this.memoryUsed -= b.size;
    }
  }

  forgetMemory(key) {
    const b = this.memory.get(key);
    if (b) {
      this.memory.delete(key);
      this.memoryUsed -= b.size;
    }
  }

  sample(bytes) {
    const t = this.now();
    this.recent.push([t, bytes]);
    while (this.recent.length && t - this.recent[0][0] > 5000) this.recent.shift();
  }

  measure(bytes) {
    this.windowBytes += bytes;
    this.windowDone++;
    if (!this.ramping || this.windowDone < this.parallel) return;
    const elapsed = Math.max(1, this.now() - this.windowStart);
    const throughput = this.windowBytes / elapsed;
    if (throughput > this.lastThroughput * 1.1 && this.parallel < this.maxParallel) {
      this.parallel++;
      this.lastThroughput = throughput;
    } else {
      this.ramping = false;
    }
    this.windowBytes = 0;
    this.windowDone = 0;
    this.windowStart = this.now();
  }

  // { done, total, bytes, estimate, speed, complete, windowMode, retrying }
  progress() {
    let done = 0;
    let bytes = 0;
    for (const it of this.plan) {
      if (it.state === 'done') {
        done++;
        bytes += it.bytes;
      }
    }
    const total = this.plan.length;
    const t = this.now();
    const recent = this.recent.filter(([at]) => t - at <= 5000);
    const span = recent.length ? Math.max(1000, t - recent[0][0]) : 1000;
    const speed = recent.reduce((n, [, b]) => n + b, 0) / (span / 1000);
    return {
      done, total, bytes,
      estimate: done ? Math.round(bytes / done * total) : 0,
      speed,
      complete: total > 0 && done === total,
      windowMode: this.windowMode,
      retrying: t < this.pausedUntil
    };
  }

  // The whole plan as one Blob, in plan order (plain files). Null until everything is in.
  async assemble(type = '') {
    if (!this.progress().complete) return null;
    const parts = [];
    for (const it of this.plan) parts.push(await this.blobOf(it));
    return new Blob(parts, type ? { type } : {});
  }

  changed() {
    try { this.onChange(this); } catch { /* UI error */ }
  }

  destroy() {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    if (this.cancelWake) this.cancelWake();
    for (const c of this.controllers) {
      try { c.abort(); } catch { /* done */ }
    }
    this.memory.clear();
    return this.store && this.store.destroy ? this.store.destroy() : Promise.resolve();
  }
}

// A plain file (mp4, webm, …) as byte-range chunks. Null if the server does not do ranges.
// Each chunk's "time" is its index; the caller maps the playhead to it (position / duration × count).
export async function planFile(url, { fetchFn = (u, i) => globalThis.fetch(u, i), chunkBytes = 4 * MB } = {}) {
  let res;
  try {
    res = await fetchFn(url, { credentials: 'same-origin', headers: { Range: 'bytes=0-0' } });
  } catch {
    return null;
  }
  try { if (res.body && res.body.cancel) res.body.cancel().catch(() => {}); } catch { /* no body */ }
  if (res.status !== 206) return null;
  const total = Number((/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '') || [])[1]);
  if (!(total > 0)) return null;
  const segments = [];
  for (let start = 0, i = 0; start < total; start += chunkBytes, i++) {
    segments.push({ url, start, end: Math.min(total, start + chunkBytes) - 1, time: i, duration: 1 });
  }
  return { total, type: res.headers.get('content-type') || '', segments };
}

// ─── for the player pages ────────────────────────────────────────────────────

// Each player holds a Web Lock named after its cache database while it is open, so another
// player's cleanup can tell a live cache from one left behind by a closed or crashed tab.
function holdLock(name) {
  try {
    if (globalThis.navigator && navigator.locks) navigator.locks.request(name, () => new Promise(() => {})).catch(() => {});
  } catch { /* no Web Locks */ }
}

async function cleanupLeftovers() {
  let held = null;
  try {
    if (navigator.locks && navigator.locks.query) {
      const q = await navigator.locks.query();
      held = new Set([...(q.held || []), ...(q.pending || [])].map(l => l.name));
    }
  } catch { /* no Web Locks */ }
  await removeLeftoverStores(globalThis.indexedDB, {
    prefix: CACHE_PREFIX,
    minAgeMs: held ? 60 * 1000 : 48 * 3600 * 1000,
    inUse: name => !!held && held.has(name)
  });
}

// Opens the player's cache: an IndexedDB database of its own (deleted when the page goes away),
// with the byte limit lowered to what the browser says is free.
export async function openPlayerCache({ maxBytes, parallel = 4, mobile = false, onChange } = {}) {
  const store = await openStore(globalThis.indexedDB, { prefix: CACHE_PREFIX });
  if (store.kind === 'indexeddb') holdLock(store.name);
  cleanupLeftovers().catch(() => {});
  let limit = maxBytes || (mobile ? 3 : 8) * 1024 * MB;
  if (store.kind !== 'indexeddb') limit = Math.min(limit, (mobile ? 300 : 1500) * MB); // RAM
  try {
    const est = await navigator.storage.estimate();
    if (est && est.quota) limit = Math.min(limit, Math.max(64 * MB, (est.quota - (est.usage || 0)) * 0.8));
  } catch { /* no estimate */ }
  const cache = new StreamCache({ store, maxParallel: parallel, maxBytes: limit, setTimer: workerTimer, onChange });
  globalThis.addEventListener('pagehide', () => { cache.destroy(); });
  return cache;
}
