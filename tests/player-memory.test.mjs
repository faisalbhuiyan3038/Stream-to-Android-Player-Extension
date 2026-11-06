// Unit tests for src/player-memory.mjs (resume position, speed, preferred quality).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoKey, createMemory, closestHeight, formatClock } from '../src/player-memory.mjs';

const fakeStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
};

test('videoKey: signed query strings do not split one video into many', () => {
  assert.equal(videoKey('https://cdn.example/show/ep1/master.m3u8?token=a&exp=1'), videoKey('https://cdn.example/show/ep1/master.m3u8?token=b&exp=2'));
  // a generic file at the root keeps its query (it is the only thing telling videos apart)
  assert.notEqual(videoKey('https://cdn.example/index.m3u8?id=1'), videoKey('https://cdn.example/index.m3u8?id=2'));
  assert.equal(videoKey('not a url'), 'not a url');
});

test('resume position: saved mid-video, not at the start or the end', () => {
  let now = 1000;
  const mem = createMemory(fakeStorage(), () => now);
  const url = 'https://c/v.mp4';
  mem.savePosition(url, 5, 600);
  assert.equal(mem.resumePosition(url, 600), 0, 'first 10 s are not worth resuming');
  mem.savePosition(url, 125.7, 600);
  assert.equal(mem.resumePosition(url, 600), 125);
  assert.equal(mem.resumePosition(url, NaN), 125, 'uses the stored duration when the new one is unknown');
  mem.savePosition(url, 590, 600);
  assert.equal(mem.resumePosition(url, 600), 0, 'finished videos start over');
  mem.savePosition(url, 300, 600);
  mem.forget(url);
  assert.equal(mem.resumePosition(url, 600), 0);
  // live / unknown duration: still resumable
  mem.savePosition(url, 42, Infinity);
  assert.equal(mem.resumePosition(url, Infinity), 42);
});

test('resume position: at most 200 entries, oldest dropped first', () => {
  let now = 0;
  const storage = fakeStorage();
  const mem = createMemory(storage, () => ++now);
  for (let i = 0; i < 205; i++) mem.savePosition(`https://c/${i}.mp4`, 60, 600);
  const all = JSON.parse(storage.getItem('sap.positions'));
  assert.equal(Object.keys(all).length, 200);
  assert.equal(mem.resumePosition('https://c/0.mp4', 600), 0);
  assert.equal(mem.resumePosition('https://c/204.mp4', 600), 60);
});

test('speed and preferred quality are remembered; bad values ignored', () => {
  const mem = createMemory(fakeStorage());
  assert.equal(mem.rate(), 1);
  mem.setRate(1.5);
  assert.equal(mem.rate(), 1.5);
  mem.setRate(99);
  assert.equal(mem.rate(), 1.5);
  assert.equal(mem.preferredHeight(), 0);
  mem.setPreferredHeight(720);
  assert.equal(mem.preferredHeight(), 720);
  mem.setPreferredHeight(0);
  assert.equal(mem.preferredHeight(), 0);
  // broken JSON in storage does not throw
  const s = fakeStorage();
  s.setItem('sap.rate', '{oops');
  s.setItem('sap.positions', 'nope');
  const m2 = createMemory(s);
  assert.equal(m2.rate(), 1);
  assert.equal(m2.resumePosition('https://c/x.mp4', 100), 0);
});

test('closestHeight and formatClock', () => {
  assert.equal(closestHeight([360, 720, 1080], 700), 720);
  assert.equal(closestHeight([480, 720], 600), 480, 'ties go to the lower height');
  assert.equal(closestHeight([], 720), null);
  assert.equal(closestHeight([720], 0), null);
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
});
