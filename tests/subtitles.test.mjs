// Unit tests for src/subtitles.mjs (subtitle → WebVTT conversion used by both web players).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, srtToVtt, assToVtt, ttmlToVtt, timedTextToVtt, toWebVtt,
  decodeSubtitleBytes, vttTime, loadSubtitleAsVtt, parseVttCues, vttTimestampOffset, cuesToSrt
} from '../src/subtitles.mjs';

// cue lines of a VTT document, without the header
const cueLines = vtt => vtt.split('\n').slice(2).filter(Boolean);

test('vttTime', () => {
  assert.equal(vttTime(0), '00:00:00.000');
  assert.equal(vttTime(3723.5), '01:02:03.500');
  assert.equal(vttTime(59.9996), '00:01:00.000');
  assert.equal(vttTime(-1), '00:00:00.000');
});

test('detectFormat: by content first, then by URL / content type', () => {
  assert.equal(detectFormat('﻿WEBVTT\n\n'), 'vtt');
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi'), 'srt');
  assert.equal(detectFormat('[Script Info]\nTitle: x\n'), 'ass');
  assert.equal(detectFormat('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>'), 'ttml');
  assert.equal(detectFormat('<?xml version="1.0"?><transcript><text start="1" dur="2">a</text></transcript>'), 'timedtext');
  assert.equal(detectFormat('<timedtext format="3"><body><p t="0" d="1">a</p></body></timedtext>'), 'timedtext');
  // a .vtt URL that is actually SRT (common): content wins
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi', 'https://x/a.vtt'), 'srt');
  assert.equal(detectFormat('', 'https://x/a.ssa?x=1'), 'ass');
  assert.equal(detectFormat('garbage', 'https://x/a'), 'unknown');
});

test('srtToVtt: timings, markup, entities, alignment', () => {
  const srt = [
    '1', '00:00:01,000 --> 00:00:02,500', '<i>Hello</i> & <font color="red">world</font>', '',
    '2', '00:00:03.000 --> 00:00:04,5', '{\\an8}Top line<br>second', '',
    '3', '00:00:05,000 --> 00:00:06,000', 'a < b --> c'
  ].join('\r\n');
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.deepEqual(cueLines(vtt), [
    '00:00:01.000 --> 00:00:02.500', '<i>Hello</i> &amp; world',
    '00:00:03.000 --> 00:00:04.005 line:5% position:50% align:center', 'Top line', 'second',
    '00:00:05.000 --> 00:00:06.000', 'a &lt; b --&gt; c'
  ]);
});

test('srtToVtt: cues without blank lines between them, BOM, empty and broken cues', () => {
  const srt = '﻿1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:02,000 --> 00:00:03,000\nTwo\n\n3\n00:00:04,000 --> 00:00:05,000\n\n4\nnot a timing\nx\n';
  assert.deepEqual(cueLines(srtToVtt(srt)), [
    '00:00:01.000 --> 00:00:02.000', 'One',
    '00:00:02.000 --> 00:00:03.000', 'Two'
  ]);
});

test('srtToVtt: unbalanced tags are repaired', () => {
  const vtt = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n<i>open <b>both</i> end</b> </u>stray');
  assert.equal(cueLines(vtt)[1], '<i>open <b>both</b></i><b> end</b> stray');
});

test('assToVtt: Format line, commas in text, override tags, drawings, comments, sorting', () => {
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', '',
    '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Second, with a comma',
    'Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\an8\\i1}Hello{\\i0}\\Nworld\\hagain',
    'Comment: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,ignored',
    'Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
    'Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,{\\b1}bold {\\fnArial\\pos(10,20)}<tag> & co'
  ].join('\n');
  assert.deepEqual(cueLines(assToVtt(ass)), [
    '00:00:01.500 --> 00:00:03.250 line:5% position:50% align:center', '<i>Hello</i>', 'world again',
    '00:00:05.000 --> 00:00:06.000', 'Second, with a comma',
    '00:00:09.000 --> 00:00:10.000', '<b>bold &lt;tag&gt; &amp; co</b>'
  ]);
});

test('assToVtt: SSA v4 without a Format line uses the default field order', () => {
  const ssa = '[Events]\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0000,0000,0000,,Old style';
  assert.deepEqual(cueLines(assToVtt(ssa)), ['00:00:01.000 --> 00:00:02.000', 'Old style']);
});

test('ttmlToVtt: clock times, offsets, frames, ticks, dur, <br/>, namespaces, entities', () => {
  const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
<tt:body><tt:div>
<tt:p begin="00:00:01.000" end="00:00:02.500">First<tt:br/>line &amp; <tt:span>more</tt:span></tt:p>
<tt:p begin="3s" dur="1500ms">Second</tt:p>
<tt:p begin="40000000t" end="50000000t">Ticks</tt:p>
</tt:div></tt:body></tt:tt>`;
  assert.deepEqual(cueLines(ttmlToVtt(ttml)), [
    '00:00:01.000 --> 00:00:02.500', 'First', 'line &amp; more',
    '00:00:03.000 --> 00:00:04.500', 'Second',
    '00:00:04.000 --> 00:00:05.000', 'Ticks'
  ]);
  const frames = '<tt frameRate="25"><body><p begin="00:00:01:05" end="00:00:02:00">F</p></body></tt>';
  assert.deepEqual(cueLines(ttmlToVtt(frames)), ['00:00:01.200 --> 00:00:02.000', 'F']);
});

test('timedTextToVtt: YouTube format 1 and srv3', () => {
  const v1 = '<transcript><text start="1.5" dur="2">It&#39;s &amp;amp; <b>x</b></text><text start="4">no dur</text></transcript>';
  assert.deepEqual(cueLines(timedTextToVtt(v1)), [
    '00:00:01.500 --> 00:00:03.500', "It's &amp;amp; x",
    '00:00:04.000 --> 00:00:06.000', 'no dur'
  ]);
  const srv3 = '<timedtext format="3"><body><p t="1000" d="1500"><s>Hi</s><s> there</s></p></body></timedtext>';
  assert.deepEqual(cueLines(timedTextToVtt(srv3)), ['00:00:01.000 --> 00:00:02.500', 'Hi there']);
});

test('toWebVtt: VTT passes through, unknown throws', () => {
  const r = toWebVtt('WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nX\r\n');
  assert.equal(r.format, 'vtt');
  assert.equal(r.vtt, 'WEBVTT\n\n00:00.000 --> 00:01.000\nX\n');
  assert.throws(() => toWebVtt('hello'), /Unrecognised/);
});

test('decodeSubtitleBytes: UTF-8, BOMs and Windows-1252 fallback', () => {
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode('Café')), 'Café');
  const cp1252 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94]); // Café “q”
  assert.equal(decodeSubtitleBytes(cp1252), 'Café “q”');
  const utf16 = Uint8Array.from([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
  assert.equal(decodeSubtitleBytes(utf16), 'Hi');
});

test('loadSubtitleAsVtt: fetches, decodes and converts; HTTP errors throw', async () => {
  const body = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  const fakeFetch = async url => ({
    ok: !url.includes('missing'), status: url.includes('missing') ? 404 : 200,
    headers: { get: () => 'text/plain' },
    arrayBuffer: async () => body.buffer
  });
  const r = await loadSubtitleAsVtt({ url: 'https://x/a.srt' }, fakeFetch);
  assert.equal(r.format, 'srt');
  assert.match(r.vtt, /00:00:01.000 --> 00:00:02.000\nHi/);
  await assert.rejects(loadSubtitleAsVtt({ url: 'https://x/missing.srt' }, fakeFetch), /HTTP 404/);
});

test('parseVttCues: times, markup dropped, entities decoded, blocks without timing skipped', () => {
  const vtt = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\nNOTE hi\n\n1\n00:01.500 --> 00:00:03.000 line:90%\n<i>Hello</i> &amp; <c.yellow>bye</c>\nsecond\n\n01:00:00.000 --> 01:00:01.250\nLate\n\n00:05.000 --> 00:04.000\nbackwards\n';
  assert.deepEqual(parseVttCues(vtt), [
    { start: 1.5, end: 3, text: 'Hello & bye\nsecond' },
    { start: 3600, end: 3601.25, text: 'Late' }
  ]);
});

test('vttTimestampOffset and cuesToSrt', () => {
  assert.equal(vttTimestampOffset('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n'), 10);
  assert.equal(vttTimestampOffset('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:02.000,MPEGTS:270000\n'), 1);
  assert.equal(vttTimestampOffset('WEBVTT\n\n00:01.000 --> 00:02.000\nx\n'), null);
  assert.equal(cuesToSrt([{ start: 61.5, end: 62, text: 'B' }, { start: 1, end: 2.25, text: 'A\na' }]),
    '1\n00:00:01,000 --> 00:00:02,250\nA\na\n\n2\n00:01:01,500 --> 00:01:02,000\nB\n');
});

test('sanitizeVttForHtml keeps <i>/<b>/<u>, drops other tags and escapes stray brackets', async () => {
  const { sanitizeVttForHtml, sanitizeCueLine } = await import('../src/subtitles.mjs');
  assert.equal(sanitizeCueLine('<i>Hi</i> <b>there</b>'), '<i>Hi</i> <b>there</b>');
  assert.equal(sanitizeCueLine('<v Bob>Hello</v> <c.yellow>x</c>'), 'Hello x');
  assert.equal(sanitizeCueLine('<img src=x onerror=alert(1)>a < b > c'), 'a &lt; b &gt; c');
  assert.equal(sanitizeCueLine('<i class="x">no</i>'), 'no</i>');
  const out = sanitizeVttForHtml('WEBVTT\n\nNOTE hi\n\n1\n00:00.000 --> 00:01.000\n<script>x</script><u>ok</u>\n');
  assert.equal(out, 'WEBVTT\n\n1\n00:00.000 --> 00:01.000\nx<u>ok</u>\n');
});
