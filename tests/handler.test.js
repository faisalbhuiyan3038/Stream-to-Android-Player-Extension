// Tests for native-host/protocol-handler/handler.py (link parsing; nothing is launched).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const DIR = path.resolve(__dirname, '..', 'native-host', 'protocol-handler');
const PY = process.platform === 'win32' ? 'python' : 'python3';

// Runs a snippet with `handler` imported and returns its stdout as JSON.
function py(snippet) {
  const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(DIR)}); sys.dont_write_bytecode = True\nimport handler\n${snippet}`;
  const out = spawnSync(PY, ['-B', '-c', code], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

const URL_ = 'https://hls03.cdn.example/path/a%20b/index.m3u8?token=a&x=1#frag';

test('parses the encoded form (extension default) back to the exact URL', () => {
  const link = 'vlc://' + encodeURIComponent(URL_);
  const [scheme, url] = py(`s, rest = handler.split_link(${JSON.stringify(link)}); print(json.dumps([s, handler.extract_url(rest)]))`);
  assert.equal(scheme, 'vlc');
  assert.equal(url, URL_);
});

test('a trailing slash added by a browser is dropped for the encoded form', () => {
  const link = 'vlc://' + encodeURIComponent('https://h.example/v.m3u8') + '/';
  const [, url] = py(`s, rest = handler.split_link(${JSON.stringify(link)}); print(json.dumps([s, handler.extract_url(rest)]))`);
  assert.equal(url, 'https://h.example/v.m3u8');
});

test('parses the raw form and the browser-mangled raw form', () => {
  const raw = py(`print(json.dumps(handler.extract_url(handler.split_link('vlc://https://h.example/a/b.m3u8?x=1')[1])))`);
  assert.equal(raw, 'https://h.example/a/b.m3u8?x=1');
  const mangled = py(`print(json.dumps(handler.extract_url(handler.split_link('vlc://https//h.example/a/b.m3u8')[1])))`);
  assert.equal(mangled, 'https://h.example/a/b.m3u8');
  const lostSlash = py(`print(json.dumps(handler.extract_url(handler.split_link('mpv://http:/h.example/a.mp4')[1])))`);
  assert.equal(lostSlash, 'http://h.example/a.mp4');
});

test('quotes around the link (Windows passes "%1") are ignored, scheme is case-insensitive', () => {
  const [scheme] = py(`print(json.dumps(handler.split_link('"VLC://https%3A%2F%2Fh.example%2Fa"')))`);
  assert.equal(scheme, 'vlc');
});

test('rejects things that are not http(s) URLs', () => {
  const r = py(`
res = []
for rest in ['file%3A%2F%2F%2Fetc%2Fpasswd', 'javascript:alert(1)', '', 'ftp://x/y']:
    try:
        handler.extract_url(rest); res.append('accepted')
    except ValueError:
        res.append('rejected')
print(json.dumps(res))`);
  assert.deepEqual(r, ['rejected', 'rejected', 'rejected', 'rejected']);
});

test('main() launches the right player with the decoded URL and refuses unknown schemes', () => {
  const r = py(`
calls = []
handler.launch = lambda name, url: calls.append([name, url]) or '/fake/' + name
handler.log = lambda m: None
ok = handler.main(['handler.py', 'mpv://' + 'https%3A%2F%2Fh.example%2Fa.m3u8'])
bad = handler.main(['handler.py', 'evil://https%3A%2F%2Fh.example%2Fa.m3u8'])
nourl = handler.main(['handler.py', 'vlc://notaurl'])
print(json.dumps([ok, bad, nourl, calls]))`);
  assert.deepEqual(r, [0, 1, 1, [['mpv', 'https://h.example/a.m3u8']]]);
});

test('VLC_PATH overrides the search', () => {
  const found = py(`import os, sys; os.environ['VLC_PATH'] = sys.executable; print(json.dumps(handler.find_player('vlc') == sys.executable))`);
  assert.equal(found, true);
});
