// Tests for native-host/host.py (protocol v2). No browser needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = path.resolve(__dirname, '..', 'native-host', 'host.py');
const PY = process.platform === 'win32' ? 'python' : 'python3';

// Sends framed messages to a fresh host process and returns the framed replies.
function talk(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', d => chunks.push(d));
    child.on('error', reject);
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      const replies = [];
      let offset = 0;
      while (offset + 4 <= buf.length) {
        const len = buf.readUInt32LE(offset);
        replies.push(JSON.parse(buf.slice(offset + 4, offset + 4 + len).toString('utf8')));
        offset += 4 + len;
      }
      resolve(replies);
    });
    for (const m of messages) {
      const body = Buffer.from(JSON.stringify(m), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([head, body]));
    }
    child.stdin.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('ping reports version and tools', async () => {
  const [reply] = await talk([{ action: 'ping' }]);
  assert.equal(reply.status, 'ok');
  assert.equal(reply.version, 2);
  assert.equal(typeof reply.ytdlp, 'boolean');
  assert.equal(typeof reply.ffmpeg, 'boolean');
});

test('launch starts the program with the exact argv (legacy "command" key too)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-'));
  const marker = path.join(dir, 'marker.json');
  const script = `import json,sys; open(sys.argv[1],'w').write(json.dumps(sys.argv[2:]))`;
  const tricky = ['a b', 'x&y', '%PATH%', 'q"uote', 'semi;colon', 'ünï'];
  const replies = await talk([{ command: [PY, '-c', script, marker, ...tricky] }]);
  assert.equal(replies[0].status, 'launched', JSON.stringify(replies));
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await sleep(100);
  assert.ok(fs.existsSync(marker), 'program never ran');
  await sleep(200);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), tricky);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects bad requests with an error reply instead of crashing', async () => {
  const replies = await talk([
    { action: 'nope' },
    { action: 'launch', command: [] },
    { action: 'launch', command: 'notalist' },
    { action: 'launch', command: [''] },
    { action: 'download', url: 'file:///etc/passwd' },
    { action: 'ping' }
  ]);
  assert.equal(replies.length, 6);
  for (const r of replies.slice(0, 5)) assert.equal(r.status, 'error', JSON.stringify(r));
  assert.equal(replies[5].status, 'ok', 'host must keep serving after errors');
});

test('missing executable gives an error reply', async () => {
  const [reply] = await talk([{ action: 'launch', command: ['definitely-not-a-real-player-xyz', 'http://a/b'] }]);
  assert.equal(reply.status, 'error');
});

test('bat_quote neutralises cmd.exe metacharacters (scheduler fallback)', () => {
  const code = `
import sys; sys.path.insert(0, r'${path.dirname(HOST).replace(/\\/g, '\\\\')}')
import host
print(host.build_bat_line(['C:\\\\Program Files\\\\vlc.exe', '--meta-title=a "b" & calc', 'http://x/y?a=1&b=%TEMP%', 'C:\\\\dir\\\\']), end='')`;
  const out = spawnSync(PY, ['-c', code], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const line = out.stdout;
  assert.ok(line.startsWith('@start "" "C:\\Program Files\\vlc.exe"'), line);
  assert.ok(line.includes('"--meta-title=a \'b\' & calc"'), 'quotes must be replaced, & stays inside quotes: ' + line);
  assert.ok(line.includes('%%TEMP%%'), 'percent signs must be doubled: ' + line);
  assert.ok(line.includes('"C:\\dir\\\\"'), 'trailing backslash must be doubled: ' + line);
  assert.ok(!/\r|\n.+/.test(line.trimEnd()), 'single line only');
});

test('download builds a yt-dlp / ffmpeg command with forwarded headers', () => {
  const code = `
import sys, shutil, json; sys.path.insert(0, r'${path.dirname(HOST).replace(/\\/g, '\\\\')}')
import host, tempfile
fake = {'yt-dlp': r'C:\\\\t\\\\yt-dlp.exe'}
host.shutil.which = lambda *names: next((fake[n] for n in names if n in fake), None)
d = tempfile.mkdtemp()
cmd, tool = host.build_download_command({'url': 'https://h/p.m3u8', 'title': 'A: B/C?', 'dir': d, 'headers': {'referer': 'https://r/', 'userAgent': 'UA', 'cookie': 'k=v'}})
print(json.dumps([tool, cmd]))
fake.clear(); fake['ffmpeg'] = 'ffmpeg'
cmd2, tool2 = host.build_download_command({'url': 'https://h/p.m3u8', 'title': 't', 'dir': d, 'headers': {'referer': 'https://r/'}})
print(json.dumps([tool2, cmd2]))
fake.clear()
try:
    host.build_download_command({'url': 'https://h/p.m3u8', 'dir': d})
except RuntimeError as e:
    print(json.dumps(['none', str(e)]))`;
  const out = spawnSync(PY, ['-c', code], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const [ytdlp, ffmpeg, none] = out.stdout.trim().split(/\r?\n/).map(l => JSON.parse(l));
  assert.equal(ytdlp[0], 'yt-dlp');
  assert.ok(ytdlp[1].includes('--referer') && ytdlp[1].includes('https://r/'));
  assert.ok(ytdlp[1].includes('Cookie:k=v'));
  assert.ok(path.basename(ytdlp[1][ytdlp[1].indexOf('-o') + 1]).startsWith('A_ B_C_'), 'title must be sanitised: ' + ytdlp[1].join(' '));
  assert.equal(ffmpeg[0], 'ffmpeg');
  assert.ok(ffmpeg[1].includes('-headers') && ffmpeg[1][ffmpeg[1].indexOf('-headers') + 1].includes('Referer: https://r/'));
  assert.equal(none[0], 'none');
  assert.match(none[1], /yt-dlp nor ffmpeg/);
});
