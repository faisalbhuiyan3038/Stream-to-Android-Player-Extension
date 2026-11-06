// Unit tests for src/segment-store.mjs. IndexedDB itself is exercised by the browser tests
// (tests/e2e/chromium.test.js, "a long stream waits in IndexedDB"); here: the memory fallback,
// the fallback decision and the clean-up of databases left by closed tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, openStore, removeLeftoverStores } from '../src/segment-store.mjs';

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
