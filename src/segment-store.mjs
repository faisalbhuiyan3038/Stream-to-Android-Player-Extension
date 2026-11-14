// Where the downloader keeps segments while a download runs: an IndexedDB database per download
// (idea from FastStream's FSBlob). Values are Blobs, which Chrome and Firefox keep on disk, so a
// long video does not have to fit in RAM; the final file is a Blob made of slices of them.
// If IndexedDB is unavailable (some private-browsing modes, storage blocked), MemoryStore keeps
// the same API in RAM.

const PREFIX = 'sap-download-';

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IdbStore {
  constructor(db, name) {
    this.db = db;
    this.name = name;
    this.kind = 'indexeddb';
  }

  static async open(idb = globalThis.indexedDB, { prefix = PREFIX } = {}) {
    if (!idb) throw new Error('IndexedDB is not available');
    const name = prefix + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const open = idb.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('segments');
    const db = await req(open);
    const store = new IdbStore(db, name);
    store.idb = idb;
    return store;
  }

  // A database another page of the extension created (the player's whole-video cache, read by the
  // download page). Rejects if it does not exist (any more): nothing is created.
  static async openExisting(name, idb = globalThis.indexedDB) {
    if (!idb) throw new Error('IndexedDB is not available');
    const open = idb.open(name);
    let created = false;
    open.onupgradeneeded = () => { created = true; open.transaction.abort(); };
    let db;
    try {
      db = await req(open);
    } catch (e) {
      if (created) idb.deleteDatabase(name);
      throw new Error(`storage ${name} does not exist`);
    }
    if (!db.objectStoreNames.contains('segments')) {
      db.close();
      throw new Error(`storage ${name} does not exist`);
    }
    const store = new IdbStore(db, name);
    store.idb = idb;
    return store;
  }

  tx(mode) {
    return this.db.transaction('segments', mode).objectStore('segments');
  }

  // data: Uint8Array or Blob. Resolves once it is written (the caller can drop its copy).
  async put(key, data) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const t = this.db.transaction('segments', 'readwrite');
    t.objectStore('segments').put(blob, key);
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB write aborted (storage full?)'));
    });
  }

  async get(key) {
    const v = await req(this.tx('readonly').get(key));
    if (!v) throw new Error(`segment ${key} is missing from storage`);
    return v;
  }

  async delete(key) {
    await req(this.tx('readwrite').delete(key));
  }

  async destroy() {
    try { this.db.close(); } catch { /* already closed */ }
    await new Promise(resolve => {
      const r = this.idb.deleteDatabase(this.name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
}

export class MemoryStore {
  constructor() {
    this.map = new Map();
    this.kind = 'memory';
  }

  async put(key, data) { this.map.set(key, data instanceof Blob ? data : new Blob([data])); }

  async get(key) {
    const v = this.map.get(key);
    if (!v) throw new Error(`segment ${key} is missing from storage`);
    return v;
  }

  async delete(key) { this.map.delete(key); }

  async destroy() { this.map.clear(); }
}

// IndexedDB if possible, memory otherwise
export async function openStore(idb = globalThis.indexedDB, options = {}) {
  try {
    return await IdbStore.open(idb, options);
  } catch (e) {
    console.warn('Download storage falls back to memory:', e && e.message);
    return new MemoryStore();
  }
}

// Databases left behind by downloads whose tab was closed or crashed. Only ones older than
// `minAgeMs` go: a download running in another tab right now must keep its data.
// `inUse(name)`: databases a live page still says it uses (see stream-cache.mjs) are kept whatever
// their age.
export async function removeLeftoverStores(idb = globalThis.indexedDB, { minAgeMs = 12 * 3600 * 1000, now = Date.now(), prefix = PREFIX, inUse = () => false } = {}) {
  if (!idb || typeof idb.databases !== 'function') return 0;
  let removed = 0;
  for (const { name } of await idb.databases()) {
    if (!name || !name.startsWith(prefix)) continue;
    const created = parseInt(name.slice(prefix.length), 10);
    if (!(created > 0) || now - created < minAgeMs || inUse(name)) continue;
    await new Promise(resolve => {
      const r = idb.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
    removed++;
  }
  return removed;
}
