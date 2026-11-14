// hls.js glue for the whole-video cache (src/stream-cache.mjs): a fragment loader that serves
// fragments (and init segments) from the cache, and the plan = every fragment of the playing
// level and audio rendition.

// Byte range of an hls.js fragment / init segment as { start, end (inclusive) }, or {} for none
function rangeOf(seg) {
  const s = seg.byteRangeStartOffset;
  const e = seg.byteRangeEndOffset;
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e - 1 } : {};
}

export function hlsPlan(hls) {
  const out = [];
  const add = (details, track) => {
    if (!details || !Array.isArray(details.fragments)) return;
    for (const f of details.fragments) {
      if (!f) continue;
      if (f.initSegment && f.initSegment.url) out.push({ url: f.initSegment.url, ...rangeOf(f.initSegment), init: true, track });
      out.push({ url: f.url, ...rangeOf(f), time: f.start, duration: f.duration, track });
    }
  };
  const index = hls.loadLevel >= 0 ? hls.loadLevel : hls.currentLevel;
  const level = hls.levels && hls.levels[index];
  add(level && level.details, 'main');
  const audio = hls.audioTracks && hls.audioTracks[hls.audioTrack];
  // an audio rendition without a URI is carried in the main stream
  if (audio && audio.url && audio.details) add(audio.details, 'audio');
  return out;
}

// The level to play and download: the one closest to `height`, the highest bitrate among equals
export function pickLevelIndex(levels, height) {
  let best = -1;
  for (let i = 0; i < (levels || []).length; i++) {
    const l = levels[i];
    if (!l || !l.height) continue;
    if (best < 0) { best = i; continue; }
    const d = Math.abs(l.height - height);
    const bd = Math.abs(levels[best].height - height);
    if (d < bd || (d === bd && (l.bitrate || 0) > (levels[best].bitrate || 0))) best = i;
  }
  return best;
}

// The height FastStream aims for when no quality was chosen: the screen's pixel height
export function desiredHeight(preferred = 0) {
  if (preferred > 0) return preferred;
  const h = (globalThis.innerHeight || 720) * (globalThis.devicePixelRatio || 1) * 1.1;
  return Math.max(360, Math.round(h));
}

export function createCacheLoader(BaseLoader, getCache) {
  return class CacheLoader extends BaseLoader {
    load(context, config, callbacks) {
      const cache = getCache();
      if (!cache || !context.frag || context.responseType !== 'arraybuffer') return super.load(context, config, callbacks);
      const start = context.rangeStart || 0;
      const end = context.rangeEnd ? context.rangeEnd - 1 : null;
      // A miss is loaded by hls.js's own loader and handed to the cache
      const viaNetwork = () => super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          try { cache.put(context.url, start, end, response.data); } catch { /* not cached */ }
          callbacks.onSuccess(response, stats, ctx, details);
        }
      });
      const pending = cache.get(context.url, start, end);
      if (!pending) return viaNetwork();

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
        // hls.js loaders refuse a second load() once stats.loading.start is set
        this.served = false;
        stats.loading.start = 0;
        stats.loading.first = 0;
        stats.loading.end = 0;
        viaNetwork();
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
