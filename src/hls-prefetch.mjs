// hls.js fragment loader backed by SegmentPrefetcher (src/prefetch.mjs).
// hls.js loads one fragment at a time; this loader, on every fragment request, queues the next
// fragments of the same playlist for parallel download and serves requests from what is already
// downloaded. Anything unusual (byte ranges, init segments, a miss, a failed prefetch) goes to
// hls.js's own loader unchanged.

export function createPrefetchLoader(BaseLoader, getHls, prefetcher, { aheadSeconds = 120, maxAhead = 30 } = {}) {
  function playlistOf(hls, frag) {
    if (!hls || !frag) return null;
    if (frag.type === 'audio') return hls.audioTracks && hls.audioTracks[frag.level] && hls.audioTracks[frag.level].details;
    if (frag.type === 'subtitle') return null;
    return hls.levels && hls.levels[frag.level] && hls.levels[frag.level].details;
  }

  function scheduleAhead(frag) {
    const details = playlistOf(getHls(), frag);
    if (!details || !Array.isArray(details.fragments) || typeof frag.sn !== 'number') return;
    const start = frag.sn - details.startSN + 1;
    const urls = [];
    let seconds = 0;
    for (let i = start; i < details.fragments.length && urls.length < maxAhead && seconds < aheadSeconds; i++) {
      const f = details.fragments[i];
      if (!f || f.byteRange && f.byteRange.length) break; // byte-range playlists: leave to hls.js
      urls.push(f.url);
      seconds += f.duration || 0;
    }
    prefetcher.prefetch(urls);
  }

  return class PrefetchLoader extends BaseLoader {
    load(context, config, callbacks) {
      const frag = context.frag;
      const plain = frag && typeof frag.sn === 'number' && !context.rangeStart && !context.rangeEnd && context.responseType === 'arraybuffer';
      if (!plain) return super.load(context, config, callbacks);

      scheduleAhead(frag);
      const pending = prefetcher.take(context.url);
      if (!pending) return super.load(context, config, callbacks);

      this.context = context;
      this.callbacks = callbacks;
      this.served = true;
      const stats = this.stats;
      stats.loading.start = performance.now();
      pending.then((data) => {
        if (stats.aborted || !this.callbacks) return;
        const t = performance.now();
        stats.loading.first = stats.loading.first || t;
        stats.loading.end = t;
        stats.loaded = stats.total = data.byteLength;
        this.callbacks.onSuccess({ url: context.url, data }, stats, context, null);
      }, () => {
        if (stats.aborted || !this.callbacks) return;
        // Prefetch failed: load normally. hls.js loaders refuse a second load() once
        // stats.loading.start is set, so start from fresh stats.
        this.served = false;
        stats.loading.start = 0;
        stats.loading.first = 0;
        stats.loading.end = 0;
        super.load(context, config, callbacks);
      });
    }

    abort() {
      if (this.served) {
        this.stats.aborted = true;
        if (this.callbacks && this.callbacks.onAbort) this.callbacks.onAbort(this.stats, this.context, null);
        return;
      }
      super.abort();
    }
  };
}
