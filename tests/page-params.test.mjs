// Unit tests for src/page-params.mjs (what a web-player page reads from its own URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVideoUrl, getSubtitleList } from '../src/page-params.mjs';

const loc = href => { const u = new URL(href); return { search: u.search, hash: u.hash }; };

test('getVideoUrl: ?url= from the extension, #raw-url from a redirected link', () => {
  assert.equal(getVideoUrl(loc('chrome-extension://id/player.html?url=' + encodeURIComponent('https://c/a.m3u8?t=1&x=2'))), 'https://c/a.m3u8?t=1&x=2');
  // regexSubstitution puts the raw URL (with its own query) after '#'
  assert.equal(getVideoUrl({ search: '', hash: '#https://c/a.m3u8?t=1&x=2' }), 'https://c/a.m3u8?t=1&x=2');
  // the original URL's own fragment survives
  assert.equal(getVideoUrl({ search: '', hash: '#https://c/a.m3u8#t=10' }), 'https://c/a.m3u8#t=10');
  assert.equal(getVideoUrl({ search: '', hash: '#' + encodeURIComponent('https://c/a.mpd') }), 'https://c/a.mpd');
  assert.equal(getVideoUrl({ search: '', hash: '#javascript:alert(1)' }), '');
  assert.equal(getVideoUrl({ search: '', hash: '' }), '');
  // ?url= wins over a fragment
  assert.equal(getVideoUrl({ search: '?url=https%3A%2F%2Fq%2Fa.mp4', hash: '#https://h/b.mp4' }), 'https://q/a.mp4');
});

test('getSubtitleList: valid entries only, malformed JSON ignored', () => {
  const subs = [{ url: 'https://s/en.vtt', label: 'English' }, { label: 'no url' }, null];
  assert.deepEqual(getSubtitleList({ search: '?subs=' + encodeURIComponent(JSON.stringify(subs)) }), [{ url: 'https://s/en.vtt', label: 'English' }]);
  assert.deepEqual(getSubtitleList({ search: '?subs=%7Bbroken' }), []);
  assert.deepEqual(getSubtitleList({ search: '?subs=' + encodeURIComponent('{"url":"x"}') }), []);
  assert.deepEqual(getSubtitleList({ search: '' }), []);
});
