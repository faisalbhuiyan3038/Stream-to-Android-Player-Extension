// Shaka glue for the whole-video cache (src/stream-cache.mjs): a networking scheme for http(s)
// that serves media segments from the cache (everything else goes to Shaka's own fetch plugin),
// and the plan = every segment of the playing variant's video and audio streams.
import { referencesOf, initSegmentOf, uriOf, startOf, endOf, byteRange } from './shaka-refs.mjs';
import { parseRange } from './stream-cache.mjs';

export function registerCacheScheme(shaka, getCache) {
  const NE = shaka.net.NetworkingEngine;
  const base = shaka.net.HttpFetchPlugin && shaka.net.HttpFetchPlugin.isSupported()
    ? shaka.net.HttpFetchPlugin.parse
    : shaka.net.HttpXHRPlugin.parse;
  const aborted = () => new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.PLAYER, shaka.util.Error.Code.OPERATION_ABORTED);

  const plugin = (uri, request, requestType, progressUpdated, headersReceived, config) => {
    const cache = getCache();
    const network = () => base(uri, request, requestType, progressUpdated, headersReceived, config);
    if (!cache || requestType !== NE.RequestType.SEGMENT) return network();
    const headers = request.headers || {};
    const { start, end } = parseRange(headers.Range || headers.range);
    const viaNetwork = () => network().chain((response) => {
      try { cache.put(uri, start, end, response.data); } catch { /* not cached */ }
      return response;
    });
    const pending = cache.get(uri, start, end);
    if (!pending) return viaNetwork();

    const t0 = Date.now();
    let fallback = null;
    let rejectAbort = null;
    let done = false;
    const promise = new Promise((resolve, reject) => {
      rejectAbort = reject;
      pending.then((data) => {
        done = true;
        resolve({ uri, originalUri: uri, data, status: 200, headers: {}, timeMs: Date.now() - t0, fromCache: false, originalRequest: request });
      }, () => {
        if (done) return;
        // the cache could not deliver it: load it normally
        fallback = viaNetwork();
        fallback.promise.then(resolve, reject);
      });
    });
    return new shaka.util.AbortableOperation(promise, () => {
      if (fallback) return fallback.abort();
      if (!done) {
        done = true;
        rejectAbort(aborted());
      }
      return Promise.resolve();
    });
  };
  NE.registerScheme('http', plugin, NE.PluginPriority.APPLICATION, true);
  NE.registerScheme('https', plugin, NE.PluginPriority.APPLICATION, true);
}

// Segments of the active variant (video + audio streams, init segments included)
export async function shakaPlan(shaka, player) {
  const manifest = player.getManifest();
  const active = player.getVariantTracks().find(t => t.active);
  if (!manifest || !active) return [];
  let video = null;
  let audio = null;
  for (const v of manifest.variants || []) {
    if (!video && v.video && active.videoId != null && v.video.id === active.videoId) video = v.video;
    if (!audio && v.audio && active.audioId != null && v.audio.id === active.audioId) audio = v.audio;
  }
  const out = [];
  for (const [track, stream] of [['video', video], ['audio', audio]]) {
    if (!stream) continue;
    for (const ref of await referencesOf(stream)) {
      const init = initSegmentOf(shaka, ref);
      if (init) out.push({ url: uriOf(init), ...byteRange(init), init: true, track });
      const t = startOf(ref);
      out.push({ url: uriOf(ref), ...byteRange(ref), time: t, duration: endOf(ref) - t, track });
    }
  }
  return out;
}

// Shaka variant to play and download: closest to `height`, the highest bandwidth among equals
export function pickVariant(variants, height) {
  const list = variants.filter(v => v.height);
  if (!list.length) return null;
  const heights = [...new Set(list.map(v => v.height))];
  const h = heights.reduce((best, x) => Math.abs(x - height) < Math.abs(best - height) ? x : best, heights[0]);
  return list.filter(v => v.height === h).sort((a, b) => b.bandwidth - a.bandwidth)[0];
}
