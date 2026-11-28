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

  async keys() {
    return req(this.tx('readonly').getAllKeys());
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

  async keys() { return [...this.map.keys()]; }

  async destroy() { this.map.clear(); }
}

// Segments in a folder the user picked (File System Access, Chromium desktop): nothing waits in
// RAM or browser storage, which matters in incognito windows (Chromium keeps their IndexedDB in
// memory). They are appended to "pack" files of about `packBytes` in a "<name>.parts" folder that
// destroy() removes. Packs, not one file per segment: in a real folder every close() of a writable
// costs Chromium a Safe Browsing hash, a move of its .crswap file and a Mark-of-the-Web, measured
// at ~0.9 s per file on Windows (586 segments of 0.9 MB: 538 s; the same bytes in 9 packs of
// 64 MB: 33 s). A pack is only read once closed (its writes are invisible until then) and is never
// written again, so a File from it stays readable (a written file makes older Files throw
// NotReadableError).
export class FileStore {
  constructor(parent, dir, name, packBytes) {
    this.parent = parent;
    this.dir = dir;
    this.name = name;
    this.packBytes = packBytes;
    this.entries = new Map(); // key -> { pack, offset, size }
    this.packs = [];
    this.open = null; // the pack being written
    this.chain = Promise.resolve(); // puts and closes run one at a time
    this.kind = 'folder';
  }

  // parent: a FileSystemDirectoryHandle (showDirectoryPicker); a leftover folder of that name
  // (an earlier attempt) is replaced
  static async open(parent, name, { packBytes = 64 * 1024 * 1024 } = {}) {
    await parent.removeEntry(name, { recursive: true }).catch(() => {});
    return new FileStore(parent, await parent.getDirectoryHandle(name, { create: true }), name, packBytes);
  }

  queue(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  put(key, data) {
    return this.queue(async () => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      if (!this.open) {
        const file = `${this.packs.length}.pack`;
        const handle = await this.dir.getFileHandle(file, { create: true });
        this.open = { file, handle, writable: await handle.createWritable(), size: 0, live: 0, closing: null, closed: null };
        this.packs.push(this.open);
      }
      const pack = this.open;
      try {
        await pack.writable.write(blob);
      } catch (e) {
        this.open = null;
        await pack.writable.abort().catch(() => {});
        throw e;
      }
      const old = this.entries.get(key);
      this.entries.set(key, { pack, offset: pack.size, size: blob.size });
      pack.size += blob.size;
      pack.live++;
      if (old) this.release(old.pack);
      // closing takes a while (see above): the next put starts a new pack meanwhile
      if (pack.size >= this.packBytes) this.close(pack);
    });
  }

  close(pack) {
    if (this.open === pack) this.open = null;
    if (!pack.closing) {
      pack.closing = pack.writable.close().then(async () => {
        pack.closed = await pack.handle.getFile();
        if (!pack.live) await this.dir.removeEntry(pack.file).catch(() => {});
      });
      pack.closing.catch(() => {});
    }
    return pack.closing;
  }

  release(pack) {
    pack.live--;
    if (!pack.live && pack.closed) this.dir.removeEntry(pack.file).catch(() => {});
  }

  async get(key) {
    // waits for puts already queued; a key in the pack still being written closes that pack
    const entry = await this.queue(() => {
      const e = this.entries.get(key);
      if (e && !e.pack.closing) this.close(e.pack);
      return e;
    });
    if (!entry) throw new Error(`segment ${key} is missing from storage`);
    await entry.pack.closing;
    return entry.pack.closed.slice(entry.offset, entry.offset + entry.size);
  }

  async delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.release(entry.pack);
  }

  async keys() { return [...this.entries.keys()]; }

  async destroy() {
    this.entries.clear();
    await this.chain;
    if (this.open) { await this.open.writable.abort().catch(() => {}); this.open = null; }
    await Promise.all(this.packs.map(p => p.closing && p.closing.catch(() => {})));
    await this.parent.removeEntry(this.name, { recursive: true }).catch(() => {});
  }
}

// IndexedDB if possible, memory otherwise. An IndexedDB store holds a Web Lock named after its
// database while the page lives, so cleanup elsewhere can tell it from a crashed tab's leftover.
export async function openStore(idb = globalThis.indexedDB, options = {}) {
  try {
    const store = await IdbStore.open(idb, options);
    holdStoreLock(store.name);
    return store;
  } catch (e) {
    console.warn('Download storage falls back to memory:', e && e.message);
    return new MemoryStore();
  }
}

export function holdStoreLock(name, locks = globalThis.navigator && navigator.locks) {
  try {
    if (locks) locks.request(name, () => new Promise(() => {})).catch(() => {});
  } catch { /* no Web Locks */ }
}

// Leftovers of closed or crashed tabs: databases no live page holds a lock on go after a minute
// (a page takes its lock right after creating the database). Without Web Locks only old ones go
// (`fallbackAgeMs`), so a download running in another tab is never touched.
// The background runs the same rule at browser start (background.js `removeLeftoverDatabases`).
export async function removeUnusedStores(idb = globalThis.indexedDB, { prefix = PREFIX, fallbackAgeMs = 12 * 3600 * 1000, locks = globalThis.navigator && navigator.locks, now = Date.now() } = {}) {
  let held = null;
  try {
    if (locks && locks.query) {
      const q = await locks.query();
      held = new Set([...(q.held || []), ...(q.pending || [])].map(l => l.name));
    }
  } catch { /* no Web Locks */ }
  return removeLeftoverStores(idb, {
    prefix,
    now,
    minAgeMs: held ? 60 * 1000 : fallbackAgeMs,
    inUse: name => !!held && held.has(name)
  });
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
