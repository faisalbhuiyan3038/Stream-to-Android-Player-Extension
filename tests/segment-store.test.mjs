// Unit tests for src/segment-store.mjs. IndexedDB itself is exercised by the browser tests
// (tests/e2e/chromium.test.js, "a long stream waits in IndexedDB"); here: the memory fallback,
// the fallback decision and the clean-up of databases left by closed tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, FileStore, openStore, removeLeftoverStores, removeUnusedStores } from '../src/segment-store.mjs';

test('MemoryStore: put/get/delete, values become Blobs, missing keys fail clearly', async () => {
  const s = new MemoryStore();
  await s.put('a', Uint8Array.from([1, 2, 3]));
  const blob = await s.get('a');
  assert.ok(blob instanceof Blob);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  await s.delete('a');
  await assert.rejects(s.get('a'), /missing/);
  assert.equal(s.kind, 'memory');
});

test('openStore falls back to memory when IndexedDB is unavailable', async () => {
  const s = await openStore(undefined);
  assert.equal(s.kind, 'memory');
  const broken = { open: () => { throw new Error('SecurityError'); } };
  assert.equal((await openStore(broken)).kind, 'memory');
});

test('removeLeftoverStores: only our databases older than the limit (a running download keeps its data)', async () => {
  const now = 1_000_000_000_000;
  const hour = 3600 * 1000;
  const names = [
    `sap-download-${now - 13 * hour}-abc`, // crashed tab, yesterday: removed
    `sap-download-${now - 5 * 60 * 1000}-def`, // another tab downloading right now: kept
    'some-other-db', // not ours: kept
    'sap-download-garbage' // unparseable: kept
  ];
  const deleted = [];
  const idb = {
    databases: async () => names.map(name => ({ name })),
    deleteDatabase: (name) => { deleted.push(name); const r = {}; setTimeout(() => r.onsuccess && r.onsuccess()); return r; }
  };
  assert.equal(await removeLeftoverStores(idb, { now }), 1);
  assert.deepEqual(deleted, [names[0]]);
  assert.equal(await removeLeftoverStores({}, { now }), 0, 'browsers without indexedDB.databases() are left alone');
});

test('removeUnusedStores: a database no live page holds a lock on goes after a minute; without Web Locks only old ones', async () => {
  const now = 1_000_000_000_000;
  const hour = 3600 * 1000;
  const names = [
    `sap-download-${now - 5 * 60 * 1000}-crash`, // left by a crash 5 minutes ago, unlocked: removed
    `sap-download-${now - 5 * 60 * 1000}-live`, // a download tab open right now (locked): kept
    `sap-download-${now - 20 * 1000}-new` // just created, lock maybe not taken yet: kept
  ];
  const fakeIdb = () => {
    const deleted = [];
    return {
      deleted,
      databases: async () => names.map(name => ({ name })),
      deleteDatabase: (name) => { deleted.push(name); const r = {}; setTimeout(() => r.onsuccess && r.onsuccess()); return r; }
    };
  };
  const idb = fakeIdb();
  const locks = { query: async () => ({ held: [{ name: names[1] }], pending: [] }) };
  assert.equal(await removeUnusedStores(idb, { now, locks }), 1);
  assert.deepEqual(idb.deleted, [names[0]]);

  const noLocks = fakeIdb();
  assert.equal(await removeUnusedStores(noLocks, { now, locks: null }), 0, 'within 12 h nothing goes without Web Locks');
  assert.equal(await removeUnusedStores(noLocks, { now: now + 13 * hour, locks: null }), 3);
});

// A tiny in-memory stand-in for FileSystemDirectoryHandle / FileSystemFileHandle (the browser test
// "save straight to a folder" uses the real API). Like Chromium, writes show only after close().
function fakeDir(stats = { closes: 0 }) {
  const entries = new Map();
  const dir = {
    entries,
    stats,
    async getDirectoryHandle(name, { create } = {}) {
      if (!entries.has(name)) { if (!create) throw new DOMException('no', 'NotFoundError'); entries.set(name, fakeDir(stats)); }
      return entries.get(name);
    },
    async getFileHandle(name, { create } = {}) {
      if (!entries.has(name)) { if (!create) throw new DOMException('no', 'NotFoundError'); entries.set(name, { bytes: new Blob([]) }); }
      const file = entries.get(name);
      return {
        getFile: async () => file.bytes,
        createWritable: async () => {
          const parts = [];
          return { write: async b => { parts.push(b); }, close: async () => { stats.closes++; file.bytes = new Blob(parts); }, abort: async () => {} };
        }
      };
    },
    async removeEntry(name) { if (!entries.delete(name)) throw new DOMException('no', 'NotFoundError'); }
  };
  return dir;
}

const bytesOf = async b => [...new Uint8Array(await b.arrayBuffer())];

test('FileStore: segments go into pack files in "<name>.parts"; a pack closes when full or when read', async () => {
  const root = fakeDir();
  root.entries.set('Clip.mp4.parts', fakeDir()); // a leftover of an earlier attempt is replaced
  (await root.getDirectoryHandle('Clip.mp4.parts')).entries.set('old.bin', { bytes: new Blob(['x']) });
  const s = await FileStore.open(root, 'Clip.mp4.parts', { packBytes: 4 });
  assert.equal(s.kind, 'folder');
  const parts = root.entries.get('Clip.mp4.parts');
  assert.ok(!parts.entries.has('old.bin'), 'leftover folder kept');
  await Promise.all([s.put('a', Uint8Array.from([1, 2, 3])), s.put('b', new Blob([Uint8Array.from([4, 5])]))]);
  await s.put('c', Uint8Array.from([6])); // pack 0 is full (5 bytes): c starts pack 1
  assert.deepEqual([...parts.entries.keys()].sort(), ['0.pack', '1.pack']);
  assert.deepEqual(await bytesOf(await s.get('a')), [1, 2, 3]);
  assert.deepEqual(await bytesOf(await s.get('b')), [4, 5]);
  const closes = root.stats.closes;
  assert.deepEqual(await bytesOf(await s.get('c')), [6], 'reading from the open pack closes it');
  assert.equal(root.stats.closes, closes + 1);
  await s.put('d', Uint8Array.from([7, 8]));
  assert.deepEqual(await bytesOf(await s.get('d')), [7, 8]);
  assert.deepEqual((await s.keys()).sort(), ['a', 'b', 'c', 'd']);
  await s.put('a', Uint8Array.from([9])); // replaced: the new copy is read
  assert.deepEqual(await bytesOf(await s.get('a')), [9]);
  await s.delete('b');
  await assert.rejects(s.get('b'), /missing/);
  assert.ok(!parts.entries.has('0.pack'), 'a pack with nothing left in it is removed');
  await s.delete('c');
  assert.ok(!parts.entries.has('1.pack'));
  await s.destroy();
  assert.ok(!root.entries.has('Clip.mp4.parts'), 'parts folder left behind');
});

test('FileStore: 586 small segments cost a handful of closes, not one per segment', async () => {
  const root = fakeDir();
  const s = await FileStore.open(root, 'v.parts', { packBytes: 64 * 1024 });
  const seg = new Uint8Array(1000);
  await Promise.all(Array.from({ length: 586 }, (_, i) => s.put(`raw/0/${i}`, seg)));
  for (let i = 0; i < 586; i += 97) assert.equal((await s.get(`raw/0/${i}`)).size, 1000);
  assert.ok(root.stats.closes <= 10, `${root.stats.closes} closes`);
  await s.destroy();
});
