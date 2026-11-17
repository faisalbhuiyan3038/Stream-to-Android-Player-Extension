// Audio effects DSP (src/audio-dsp.mjs): limiter, normalizer, gate, channel stage, speed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFx, CEILING, PRESETS, resolveParams, isNeutral } from '../src/audio-dsp.mjs';

const FS = 48000;
const db = x => 20 * Math.log10(x + 1e-12);

// Runs `seconds` of a signal through fx; gen(t, i) returns [L, R] or an array of channels.
function run(fx, seconds, gen, channels = 2) {
  const n = Math.round(seconds * FS / 128) * 128;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const inp = Array.from({ length: channels }, () => new Float32Array(128));
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  for (let off = 0; off < n; off += 128) {
    for (let i = 0; i < 128; i++) {
      const v = gen((off + i) / FS, off + i);
      for (let c = 0; c < channels; c++) inp[c][i] = v[c];
    }
    fx.process(inp, bl, br);
    outL.set(bl, off);
    outR.set(br, off);
  }
  return { outL, outR };
}
const rms = (a, from, to) => {
  let s = 0;
  const i0 = Math.round(from * FS); const i1 = Math.round(to * FS);
  for (let i = i0; i < i1; i++) s += a[i] * a[i];
  return Math.sqrt(s / (i1 - i0));
};
const peakOf = a => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const sine = (f, amp) => t => { const v = amp * Math.sin(2 * Math.PI * f * t); return [v, v]; };
// speech-like: a few partials in the voice band, syllable-rate modulation
const voice = amp => (t) => {
  const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
  const v = amp * env * (0.5 * Math.sin(2 * Math.PI * 450 * t) + 0.3 * Math.sin(2 * Math.PI * 1100 * t) + 0.2 * Math.sin(2 * Math.PI * 2300 * t));
  return [v, v];
};

test('limiter: full-scale input at 200 % boost never exceeds −1 dBFS', () => {
  for (const preset of ['off', 'standard', 'night']) {
    const fx = new AudioFx(FS);
    fx.setParams({ preset, boost: 2 });
    const { outL, outR } = run(fx, 3, (t) => { const v = Math.sin(2 * Math.PI * 80 * t) + 0.3 * Math.sin(2 * Math.PI * 3000 * t); return [v, -v * 0.8]; });
    assert.ok(peakOf(outL) <= CEILING + 1e-6, `${preset} L peak ${peakOf(outL)}`);
    assert.ok(peakOf(outR) <= CEILING + 1e-6, `${preset} R peak ${peakOf(outR)}`);
  }
});

test('limiter: an isolated click is caught by the look-ahead (no overshoot)', () => {
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'off', boost: 2 });
  const { outL } = run(fx, 1, (t, i) => (i === 24000 ? [1, 1] : [0.01, 0.01]));
  assert.ok(peakOf(outL) <= CEILING + 1e-6);
});

test('boost: 200 % doubles a quiet signal that does not reach the limiter', () => {
  const a = new AudioFx(FS); a.setParams({ preset: 'off', boost: 1 });
  const b = new AudioFx(FS); b.setParams({ preset: 'off', boost: 2 });
  const x = run(a, 2, sine(440, 0.1)).outL;
  const y = run(b, 2, sine(440, 0.1)).outL;
  assert.ok(Math.abs(db(rms(y, 1, 2)) - db(rms(x, 1, 2)) - 6.02) < 0.2);
});

test('normalizer: quiet dialogue after a loud scene is brought much closer', () => {
  // 8 s loud (−6 dBFS), then 16 s quiet (−36 dBFS) voice: 30 dB apart at the input
  const gen = t => (t < 8 ? voice(0.5)(t) : voice(0.0158)(t));
  const gap = (preset) => {
    const fx = new AudioFx(FS);
    fx.setParams({ preset, boost: 1 });
    const { outL } = run(fx, 24, gen);
    return db(rms(outL, 5, 8)) - db(rms(outL, 20, 24));
  };
  const off = gap('off');
  assert.ok(off > 28, `input gap ${off}`);
  const standard = gap('standard');
  const dialogue = gap('dialogue');
  const night = gap('night');
  assert.ok(standard < off - 8, `standard ${standard.toFixed(1)} dB`);
  assert.ok(dialogue < 10, `dialogue ${dialogue.toFixed(1)} dB`);
  assert.ok(night < 8, `night ${night.toFixed(1)} dB`);
});

test('normalizer: a sudden loud scene is turned down within a fraction of a second', () => {
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'dialogue', boost: 1 });
  // quiet voice for 10 s (leveler raises it), then a loud burst
  const { outL } = run(fx, 11, t => (t < 10 ? voice(0.02)(t) : voice(0.7)(t)));
  const settled = db(rms(outL, 10.4, 11));
  assert.ok(settled < -8, `level 0.4–1 s into the loud part: ${settled.toFixed(1)} dBFS`);
});

test('normalizer gate: silence and faint room noise are not pumped up', () => {
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'night', boost: 1 });
  let seed = 1;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.001; }; // ~ −70 dBFS
  run(fx, 10, () => { const v = noise(); return [v, v]; });
  assert.ok(Math.abs(fx.levelDb) < 1, `leveler gain ${fx.levelDb}`);
  const { outL } = run(fx, 1, () => [0, 0]);
  assert.ok(peakOf(outL.subarray(Math.round(0.05 * FS))) < 1e-9, 'silence stays silent');
});

test('5.1: dialogue boost raises the centre channel, downmix keeps the sides', () => {
  const center = (amp) => (t) => { const v = amp * Math.sin(2 * Math.PI * 200 * t); return [0, 0, v, 0, 0, 0]; };
  const a = new AudioFx(FS); a.setParams({ preset: 'custom', custom: { dialogue: 0 }, boost: 1 });
  const b = new AudioFx(FS); b.setParams({ preset: 'custom', custom: { dialogue: 6 }, boost: 1 });
  const x = run(a, 1, center(0.1), 6).outL;
  const y = run(b, 1, center(0.1), 6).outL;
  assert.ok(Math.abs(db(rms(x, 0.5, 1)) - db(0.1 * Math.SQRT1_2 / Math.SQRT2)) < 0.3, 'centre at −3 dB in each side');
  assert.ok(Math.abs(db(rms(y, 0.5, 1)) - db(rms(x, 0.5, 1)) - 6) < 0.5);
  const s = run(a, 1, t => [0, 0, 0, 0, 0.1 * Math.sin(2 * Math.PI * 200 * t), 0], 6);
  assert.ok(rms(s.outL, 0.5, 1) > 0.04 && rms(s.outR, 0.5, 1) < 1e-6, 'left surround goes left only');
  assert.equal(a.channels, 6);
});

test('stereo: dialogue boost brings the centre forward (mid up, side down)', () => {
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'custom', custom: { dialogue: 6 }, boost: 1 });
  const mid = run(fx, 1, sine(200, 0.1)).outL;
  const fx2 = new AudioFx(FS);
  fx2.setParams({ preset: 'custom', custom: { dialogue: 6 }, boost: 1 });
  const side = run(fx2, 1, (t) => { const v = 0.1 * Math.sin(2 * Math.PI * 200 * t); return [v, -v]; }).outL;
  const ref = db(0.1 / Math.SQRT2);
  assert.ok(Math.abs(db(rms(mid, 0.5, 1)) - ref - 3) < 0.5);
  assert.ok(Math.abs(db(rms(side, 0.5, 1)) - ref + 3) < 0.5);
});

test('mono: one-sided audio comes out of both channels', () => {
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'off', mono: true, boost: 1 });
  const { outL, outR } = run(fx, 1, t => [0.2 * Math.sin(2 * Math.PI * 300 * t), 0]);
  assert.ok(Math.abs(rms(outL, 0.5, 1) - rms(outR, 0.5, 1)) < 1e-4);
  assert.ok(rms(outR, 0.5, 1) > 0.05);
});

test('neutral settings pass the audio through unchanged (only the limiter delay)', () => {
  const p = resolveParams({ preset: 'off', boost: 1 });
  assert.ok(isNeutral(p));
  assert.ok(!isNeutral(resolveParams({ preset: 'music', boost: 1.5 })));
  assert.ok(!isNeutral(resolveParams({ preset: 'cinema' })));
  const fx = new AudioFx(FS);
  fx.setParams(p);
  const gen = (t, i) => { const v = 0.3 * Math.sin(i * 0.05); return [v, -v]; };
  const { outL } = run(fx, 0.2, gen);
  const d = fx.L - 1;
  for (let i = d; i < outL.length; i += 97) assert.ok(Math.abs(outL[i] - Math.fround(0.3 * Math.sin((i - d) * 0.05))) < 1e-6);
});

test('presets resolve; custom values are clamped; bad input is made safe', () => {
  assert.deepEqual(Object.keys(PRESETS), ['off', 'standard', 'cinema', 'dialogue', 'night', 'music']);
  const c = resolveParams({ preset: 'custom', custom: { normalizer: 9, dialogue: 99, bass: -50 }, boost: 7 });
  assert.equal(c.normalizer, 4);
  assert.equal(c.dialogue, 12);
  assert.equal(c.bass, -12);
  assert.equal(c.boost, 2);
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'night', boost: 2 });
  const { outL } = run(fx, 0.5, (t, i) => (i === 100 ? [NaN, Infinity] : [0.1, 0.1]));
  assert.ok(outL.every(Number.isFinite));
});

test('speed: 60 s of stereo audio with every stage on takes a small fraction of real time', () => {
  const fx = new AudioFx(FS);
  fx.setParams({ preset: 'dialogue', boost: 1.6, mono: false });
  const n = 60 * FS;
  const inp = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < 128; i++) { inp[0][i] = Math.sin(i * 0.1) * 0.3; inp[1][i] = Math.cos(i * 0.07) * 0.3; }
  const l = new Float32Array(128); const r = new Float32Array(128);
  const t0 = performance.now();
  for (let off = 0; off < n; off += 128) fx.process(inp, l, r);
  const ms = performance.now() - t0;
  console.log(`# 60 s of stereo 48 kHz processed in ${ms.toFixed(0)} ms (${(ms / 600).toFixed(2)} % of real time)`);
  assert.ok(ms < 3000, `${ms} ms`);
});
