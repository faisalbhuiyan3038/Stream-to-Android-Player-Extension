// Parallel segment prefetcher for the built-in players (idea from FastStream's DownloadManager):
// segments ahead of the playhead are downloaded by a small pool of parallel requests, so a slow,
// high-latency CDN fills the buffer several times faster than one-request-at-a-time loading.
//
// - Adaptive concurrency: starts at 2 and adds a slot while the measured throughput keeps
//   improving (FastStream's speed test), up to `maxParallel`; a failure removes a slot.
// - Retries with exponential backoff; 403/429 (blocked / rate-limited) stop prefetching for the
//   session so the player's own, sequential loading takes over and the server is left alone.
// - Byte budget: queued work stops when downloaded-but-unused data reaches `maxBytes`; unused
//   entries are evicted oldest first.
// - The player always gets its data: a miss or a failed prefetch makes the caller load normally.

export class SegmentPrefetcher {
  constructor({
    fetchFn = (url, init) => globalThis.fetch(url, init),
    maxParallel = 4,
    maxBytes = 64 * 1024 * 1024,
    retries = 2,
    baseDelay = 500,
    fetchInit = { credentials: 'same-origin' },
    now = () => (globalThis.performance ? performance.now() : Date.now()),
    sleep = ms => new Promise(r => setTimeout(r, ms))
  } = {}) {
    this.fetchFn = fetchFn;
    this.maxParallel = Math.max(1, maxParallel);
    this.parallel = Math.min(2, this.maxParallel);
    this.maxBytes = maxBytes;
    this.retries = retries;
    this.baseDelay = baseDelay;
    this.fetchInit = fetchInit;
    this.now = now;
    this.sleep = sleep;

    this.entries = new Map(); // url -> { promise, state: 'queued'|'loading'|'done'|'failed', bytes, at }
    this.queue = [];          // urls waiting for a slot, in playback order
    this.active = 0;
    this.disabled = false;
    this.stats = { requests: 0, hits: 0, misses: 0, failures: 0, bytes: 0, maxActive: 0 };

    // speed test state
    this.ramping = this.parallel < this.maxParallel;
    this.windowBytes = 0;
    this.windowStart = 0;
    this.windowDone = 0;
    this.lastThroughput = 0;
  }

  storedBytes() {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === 'done') n += e.bytes;
    return n;
  }

  // Queue `urls` (in playback order) for download. Already known URLs are skipped; queued URLs
  // that are no longer wanted (the user seeked elsewhere) are dropped.
  prefetch(urls) {
    if (this.disabled) return;
    const wanted = new Set(urls);
    this.wanted = wanted;
    this.queue = this.queue.filter(u => {
      if (wanted.has(u)) return true;
      this.entries.delete(u); // never started
      return false;
    });
    // Over budget: downloads that are no longer wanted (after a seek) go first, oldest first
    if (this.storedBytes() >= this.maxBytes) this.evict(wanted);
    for (const url of urls) {
      if (this.entries.has(url)) continue;
      const entry = { state: 'queued', bytes: 0, at: this.now() };
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      entry.promise.catch(() => {}); // a failed prefetch is not an unhandled rejection
      this.entries.set(url, entry);
      this.queue.push(url);
    }
    this.pump();
  }

  // The player wants `url`: returns a promise of its bytes if it is downloaded or on the way,
  // else null (the caller loads it itself). A returned entry is forgotten (memory is freed).
  take(url) {
    const e = this.entries.get(url);
    if (!e || e.state === 'failed') {
      this.stats.misses++;
      return null;
    }
    if (e.state === 'queued') {
      // Not started: start it now, ahead of the queue (one slot over the limit is allowed)
      this.queue = this.queue.filter(u => u !== url);
      this.queue.unshift(url);
      this.pump(true);
      if (e.state === 'queued') {
        // no slot at all: the player loads it itself rather than waiting behind prefetches
        this.queue = this.queue.filter(u => u !== url);
        this.entries.delete(url);
        this.stats.misses++;
        return null;
      }
    }
    this.stats.hits++;
    this.entries.delete(url);
    return e.promise;
  }

  clear() {
    this.queue = [];
    for (const [url, e] of this.entries) if (e.state !== 'loading') this.entries.delete(url);
  }

  // `force`: the player needs the head of the queue now; it may use one slot over the limit and
  // ignores the byte budget.
  pump(force = false) {
    while (this.queue.length && (this.active < this.parallel || (force && this.active <= this.maxParallel))) {
      // Budget full: drop downloads that are no longer wanted (after a seek); if what is left is
      // all still wanted, wait for the player to consume some. (Evicting wanted data to download
      // more would throw away segments the player is about to need.)
      if (!force && this.storedBytes() >= this.maxBytes) {
        this.evict(this.wanted || new Set());
        if (this.storedBytes() >= this.maxBytes) return;
      }
      force = false;
      const url = this.queue.shift();
      const entry = this.entries.get(url);
      if (!entry) continue;
      this.run(url, entry);
    }
  }

  // Drops finished downloads that are not in `wanted`, oldest first, until under budget
  evict(wanted) {
    const done = [...this.entries]
      .filter(([url, e]) => e.state === 'done' && !wanted.has(url))
      .sort((a, b) => a[1].at - b[1].at);
    while (done.length && this.storedBytes() >= this.maxBytes) {
      this.entries.delete(done.shift()[0]);
    }
  }

  async run(url, entry) {
    entry.state = 'loading';
    this.active++;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
    if (!this.windowStart) this.windowStart = this.now();
    let attempt = 0;
    try {
      for (;;) {
        this.stats.requests++;
        let res;
        try {
          res = await this.fetchFn(url, this.fetchInit);
        } catch (e) {
          res = null;
        }
        if (res && res.ok) {
          const data = await res.arrayBuffer();
          entry.bytes = data.byteLength;
          entry.state = 'done';
          entry.at = this.now();
          this.stats.bytes += data.byteLength;
          entry.resolve(data);
          this.measure(data.byteLength);
          return;
        }
        if (res && (res.status === 403 || res.status === 429)) {
          // Blocked or rate-limited: stop prefetching, let the player load on its own
          this.disabled = true;
          this.queue = [];
          throw new Error(`HTTP ${res.status}`);
        }
        if (attempt >= this.retries) throw new Error(res ? `HTTP ${res.status}` : 'network error');
        await this.sleep(this.baseDelay * Math.pow(2, attempt++));
      }
    } catch (e) {
      entry.state = 'failed';
      this.stats.failures++;
      entry.reject(e);
      // a failure costs a slot (FastStream drops a downloader on failure)
      if (this.parallel > 1) this.parallel--;
      this.ramping = false;
    } finally {
      this.active--;
      this.pump();
    }
  }

  // Speed test: after every `parallel` completions, compare throughput with the previous window
  // and add a slot while it improves by more than 10%.
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
}

// Reads the user's buffering settings for a player page. Phones get a smaller memory budget.
export function bufferingSettings(settings = {}, { mobile = false } = {}) {
  const enabled = settings.fastBuffering !== false;
  const parallel = Math.min(8, Math.max(1, Number(settings.fastBufferingParallel) || 4));
  const ahead = Math.min(600, Math.max(10, Number(settings.bufferAheadSeconds) || (mobile ? 60 : 120)));
  // Whole-video download while watching (src/stream-cache.mjs), on by default; limit in GB
  const wholeVideo = settings.cacheWholeVideo !== false;
  const limitGB = Number(settings.cacheLimitGB) > 0 ? Number(settings.cacheLimitGB) : (mobile ? 3 : 8);
  return {
    enabled,
    wholeVideo,
    cacheBytes: limitGB * 1024 * 1024 * 1024,
    parallel,
    bufferAhead: ahead,
    prefetchBytes: (mobile ? 24 : 64) * 1024 * 1024,
    maxBufferBytes: (mobile ? 80 : 200) * 1024 * 1024
  };
}
