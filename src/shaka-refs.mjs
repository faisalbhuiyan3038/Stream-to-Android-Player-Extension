// Reading Shaka's parsed segment references (used by the downloader and by the Shaka player's
// whole-video cache). Shaka's compiled build renames internal fields; only methods (getUris,
// getStartTime, …) and extern types keep their names, so a few things are found by shape.

export async function referencesOf(stream) {
  await stream.createSegmentIndex();
  const refs = [];
  for (const r of stream.segmentIndex) if (r) refs.push(r);
  return refs;
}

// Shaka's compiled build renames internal fields; only methods (getUris, getStartTime, …) and
// extern types keep their names. The init segment is found by its exported class, the AES-128
// key by the field names of its extern type.
export function initSegmentOf(shaka, ref) {
  if (!ref) return null;
  if (ref.initSegmentReference) return ref.initSegmentReference; // uncompiled / future builds
  const Init = shaka && shaka.media && shaka.media.InitSegmentReference;
  return Object.values(ref).find(v => v && typeof v === 'object' && Init && v instanceof Init) || null;
}

export function aesKeyOf(ref) {
  if (!ref) return null;
  if (ref.aesKey) return ref.aesKey;
  return Object.values(ref).find(v => v && typeof v === 'object' && 'blockCipherMode' in v && 'firstMediaSequenceNumber' in v) || null;
}

// First URI of a reference. SegmentReference exports getUris(); InitSegmentReference does not, but
// keeps the URI list as a function (its constructor's `uris` argument) in a renamed field.
export function uriOf(ref) {
  if (typeof ref.getUris === 'function') return ref.getUris()[0];
  for (const v of Object.values(ref)) {
    if (typeof v !== 'function') continue;
    try {
      const list = v.call(ref);
      if (Array.isArray(list) && list.length && typeof list[0] === 'string') return list[0];
    } catch { /* not the URI getter */ }
  }
  throw new Error('Could not find the segment address');
}

export const startOf = ref => (typeof ref.getStartTime === 'function' ? ref.getStartTime() : ref.startTime);
export const endOf = ref => (typeof ref.getEndTime === 'function' ? ref.getEndTime() : ref.endTime);
export const byteRange = ref => ({
  start: (typeof ref.getStartByte === 'function' ? ref.getStartByte() : ref.startByte) || 0,
  end: typeof ref.getEndByte === 'function' ? ref.getEndByte() : (ref.endByte == null ? null : ref.endByte)
});

