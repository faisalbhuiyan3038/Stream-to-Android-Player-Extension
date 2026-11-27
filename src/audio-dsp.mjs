// Audio effects DSP for the built-in players: runs inside an AudioWorklet (src/audio-worklet.js),
// pure JS without DOM so it is unit-tested in Node (tests/audio-dsp.test.mjs).
//
// Chain per 128-sample quantum, every stage skipped while it is neutral:
//   1. channels   5.1 → stereo downmix with extra centre gain (dialogue), stereo → mid/side
//                 dialogue emphasis, optional mono
//   2. tone EQ    low shelf (bass), presence peak (voice clarity), high shelf (treble)
//   3. leveler    slow loudness normalizer: BS.1770 K-weighted short-term loudness, gain toward a
//                 target, falls fast / rises slowly, gated in silence, speech-weighted upward gain
//   4. compressor fast RMS compressor for what the slow leveler cannot follow
//   5. boost      100–200 %
//   6. limiter    look-ahead peak limiter, ceiling −1 dBFS (nothing clips)

export const PRESETS = {
  off: { normalizer: 0, dialogue: 0, bass: 0, treble: 0 },
  standard: { normalizer: 1, dialogue: 0, bass: 0, treble: 0 },
  cinema: { normalizer: 1, dialogue: 3, bass: 2, treble: 1 },
  dialogue: { normalizer: 3, dialogue: 6, bass: -3, treble: 0 },
  night: { normalizer: 4, dialogue: 4, bass: -4, treble: 0 },
  music: { normalizer: 0, dialogue: 0, bass: 0, treble: 0 }
};
export const PRESET_NAMES = { off: 'Off', standard: 'Standard', cinema: 'Cinema', dialogue: 'Dialogue', night: 'Night', music: 'Music', custom: 'Custom' };
export const NORMALIZER_NAMES = ['Off', 'Light', 'Medium', 'Strong', 'Night'];

// Normalizer strengths: target loudness (LUFS), max upward / downward gain (dB), rise / fall time
// constants (s), compressor threshold (dBFS) and ratio.
const LEVELS = [
  null,
  { target: -20, up: 6, down: 6, rise: 3.0, fall: 0.4, compT: -12, ratio: 2 },
  { target: -19, up: 10, down: 9, rise: 2.0, fall: 0.25, compT: -16, ratio: 3 },
  { target: -18, up: 15, down: 12, rise: 1.2, fall: 0.15, compT: -20, ratio: 4 },
  { target: -18, up: 18, down: 16, rise: 1.0, fall: 0.1, compT: -26, ratio: 6 }
];

export const CEILING = Math.pow(10, -1 / 20); // −1 dBFS
const GATE_LUFS = -50;
const BLOCK = 128;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const dbToGain = db => Math.pow(10, db / 20);

const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// The sound of a preset: the user's saved version (settings.presets: an edited built-in or a
// preset of their own, src/audio-presets.mjs), else the built-in one
export function presetSound(s, id) {
  if (own(s && s.presets, id) && s.presets[id] && typeof s.presets[id] === 'object') return s.presets[id];
  return own(PRESETS, id) ? PRESETS[id] : PRESETS.off;
}

// Settings as stored / sent by the page: { preset, boost, mono, edits, presets } (edits = unsaved
// changes of the preset's sound). Before 1.8: { preset: 'custom', custom: {…} }, still read here
// because the background passes stored settings on as they are.
export function resolveParams(s = {}) {
  const edits = (s.edits && typeof s.edits === 'object') ? s.edits : (s.preset === 'custom' ? s.custom : null);
  const base = edits ? { ...PRESETS.off, ...edits } : presetSound(s, s.preset);
  return {
    normalizer: clamp(Math.round(+base.normalizer || 0), 0, 4),
    dialogue: clamp(+base.dialogue || 0, 0, 12),
    bass: clamp(+base.bass || 0, -12, 12),
    treble: clamp(+base.treble || 0, -12, 12),
    mono: !!s.mono,
    boost: clamp(+s.boost || 1, 1, 2)
  };
}

// True when processing would change nothing (then the page does not route audio through it at all)
export function isNeutral(p) {
  return !p.normalizer && !p.dialogue && !p.bass && !p.treble && !p.mono && p.boost <= 1;
}

// ── biquads (RBJ cookbook), direct form II transposed, float64 state ──
class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = new Float64Array(2);
    this.z2 = new Float64Array(2);
  }
  set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x, ch) {
    const y = this.b0 * x + this.z1[ch];
    this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch];
    this.z2[ch] = this.b2 * x - this.a2 * y;
    return y;
  }
  flush() {
    for (let c = 0; c < 2; c++) {
      if (Math.abs(this.z1[c]) < 1e-18) this.z1[c] = 0;
      if (Math.abs(this.z2[c]) < 1e-18) this.z2[c] = 0;
    }
  }
}

function shelf(bq, fs, f0, db, high) {
  const A = Math.pow(10, db / 40);
  const w = 2 * Math.PI * f0 / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / 2 * Math.SQRT2; // S = 1
  const k = 2 * Math.sqrt(A) * alpha;
  if (high) {
    bq.set(A * ((A + 1) + (A - 1) * cos + k), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - k),
      (A + 1) - (A - 1) * cos + k, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - k);
  } else {
    bq.set(A * ((A + 1) - (A - 1) * cos + k), 2 * A * ((A - 1) - (A + 1) * cos), A * ((A + 1) - (A - 1) * cos - k),
      (A + 1) + (A - 1) * cos + k, -2 * ((A - 1) + (A + 1) * cos), (A + 1) + (A - 1) * cos - k);
  }
}
function peak(bq, fs, f0, db, q) {
  const A = Math.pow(10, db / 40);
  const w = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  bq.set(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
}
function pass(bq, fs, f0, q, high) {
  const w = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  if (high) bq.set((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  else bq.set((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}
// ITU-R BS.1770 K-weighting (pre-filter shelf + RLB high-pass), for any sample rate
function kWeighting(fs) {
  const s = new Biquad();
  let K = Math.tan(Math.PI * 1681.974450955533 / fs);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  s.set(Vh + Vb * K / Q + K * K, 2 * (K * K - Vh), Vh - Vb * K / Q + K * K, 1 + K / Q + K * K, 2 * (K * K - 1), 1 - K / Q + K * K);
  const h = new Biquad();
  K = Math.tan(Math.PI * 38.13547087602444 / fs);
  Q = 0.5003270373238773;
  const a0 = 1 + K / Q + K * K;
  h.set(a0, -2 * a0, a0, a0, 2 * (K * K - 1), 1 - K / Q + K * K); // b = [1, −2, 1]
  return [s, h];
}

export class AudioFx {
  constructor(sampleRate = 48000) {
    this.fs = sampleRate;
    this.p = resolveParams({});
    // smoothed (per block) versions of the parameters
    this.cur = { dialogue: 0, bass: 0, treble: 0, boost: 1, mono: 0 };
    this.eqLow = new Biquad();
    this.eqMid = new Biquad();
    this.eqHigh = new Biquad();
    this.eqKey = '';
    [this.k1, this.k2] = kWeighting(sampleRate);
    this.sp1 = new Biquad();
    this.sp2 = new Biquad();
    pass(this.sp1, sampleRate, 300, Math.SQRT1_2, true);
    pass(this.sp2, sampleRate, 3400, Math.SQRT1_2, false);
    // leveler: ring of block energies, 400 ms short-term and 100 ms fast windows
    this.stN = Math.max(1, Math.round(0.4 * sampleRate / BLOCK));
    this.fastN = Math.max(1, Math.round(0.1 * sampleRate / BLOCK));
    this.ring = new Float64Array(this.stN);
    this.speechRing = new Float64Array(this.stN);
    this.ringPos = 0;
    this.levelDb = 0; // current leveler gain
    this.gatedFor = 0; // seconds below the gate
    this.loudness = -70;
    this.speech = 0;
    // compressor
    this.rms = 0;
    this.compDb = 0;
    this.rmsCoef = 1 - Math.exp(-1 / (0.01 * sampleRate));
    this.compAtt8 = 1 - Math.exp(-8 / (0.005 * sampleRate));
    this.compRel8 = 1 - Math.exp(-8 / (0.15 * sampleRate));
    this.compGain = 1;
    // limiter: look-ahead L samples (delay L − 1), min-hold over L, moving average over L, release
    const L = Math.max(2, Math.round(0.003 * sampleRate));
    this.L = L;
    this.delay = [new Float32Array(L), new Float32Array(L)];
    this.dPos = 0;
    this.req = new Float64Array(L); // gain requests in the hold window (ring)
    this.dqIdx = new Int32Array(L + 1); // monotonic deque of sample counters
    this.dqVal = new Float64Array(L + 1);
    this.dqHead = 0;
    this.dqLen = 0;
    this.avgRing = new Float64Array(L).fill(1);
    this.avgSum = L;
    this.avgPos = 0;
    this.n = 0;
    this.env = 1;
    this.limRel = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.minEnv = 1; // lowest limiter gain since last read (state readout)
    this.channels = 2;
    this.smoothBlock = 1 - Math.exp(-BLOCK / (0.05 * sampleRate)); // 50 ms parameter smoothing
    this.recomputed = 0;
  }

  // resolved parameters (resolveParams), or stored settings ({ preset, boost, custom, mono })
  setParams(p) {
    this.p = p && p.preset === undefined ? { ...resolveParams({}), ...p } : resolveParams(p);
  }

  // Readout for the panel
  state() {
    const s = {
      channels: this.channels,
      levelerDb: Math.round(this.levelDb * 10) / 10,
      compressorDb: Math.round(this.compDb * 10) / 10,
      limiterDb: Math.round(20 * Math.log10(Math.max(1e-6, this.minEnv)) * 10) / 10,
      loudness: Math.round(this.loudness * 10) / 10,
      speech: Math.round(this.speech * 100) / 100
    };
    this.minEnv = this.env;
    return s;
  }

  updateEq() {
    const c = this.cur;
    const presence = c.dialogue * 0.6;
    const key = `${c.bass.toFixed(2)}|${presence.toFixed(2)}|${c.treble.toFixed(2)}`;
    if (key === this.eqKey) return;
    this.eqKey = key;
    shelf(this.eqLow, this.fs, 150, c.bass, false);
    peak(this.eqMid, this.fs, 2500, presence, 1.0);
    shelf(this.eqHigh, this.fs, 7000, c.treble, true);
    this.recomputed++;
  }

  smooth() {
    const a = this.smoothBlock;
    const c = this.cur;
    const p = this.p;
    const step = (from, to) => (Math.abs(to - from) < 0.01 ? to : from + (to - from) * a);
    c.dialogue = step(c.dialogue, p.dialogue);
    c.bass = step(c.bass, p.bass);
    c.treble = step(c.treble, p.treble);
    c.boost = Math.abs(p.boost - c.boost) < 0.0005 ? p.boost : c.boost + (p.boost - c.boost) * a;
    c.mono = step(c.mono, p.mono ? 1 : 0);
  }

  // input: array of Float32Array channels (may be empty = silence); outL/outR: Float32Array(n)
  process(input, outL, outR) {
    const n = outL.length;
    const chs = input ? input.length : 0;
    if (chs) this.channels = chs;
    this.smooth();
    const c = this.cur;
    const p = this.p;

    // 1. channels
    const dlg = c.dialogue;
    if (chs === 0) {
      outL.fill(0);
      outR.fill(0);
    } else if (chs >= 6) {
      const [L, R, C, LFE, SL, SR] = input;
      const cg = Math.SQRT1_2 * dbToGain(dlg);
      for (let i = 0; i < n; i++) {
        const mid = C[i] * cg + LFE[i] * 0.5;
        outL[i] = L[i] + mid + SL[i] * Math.SQRT1_2;
        outR[i] = R[i] + mid + SR[i] * Math.SQRT1_2;
      }
    } else if (chs === 1) {
      outL.set(input[0]);
      outR.set(input[0]);
    } else {
      const [L, R] = input;
      const ls = chs === 4 ? input[2] : null;
      const rs = chs === 4 ? input[3] : null;
      if (dlg > 0.001) {
        const mg = dbToGain(dlg / 2);
        const sg = dbToGain(-dlg / 2);
        for (let i = 0; i < n; i++) {
          const l = ls ? L[i] + ls[i] * Math.SQRT1_2 : L[i];
          const r = rs ? R[i] + rs[i] * Math.SQRT1_2 : R[i];
          const m = (l + r) * 0.5 * mg;
          const s = (l - r) * 0.5 * sg;
          outL[i] = m + s;
          outR[i] = m - s;
        }
      } else if (ls) {
        for (let i = 0; i < n; i++) {
          outL[i] = L[i] + ls[i] * Math.SQRT1_2;
          outR[i] = R[i] + rs[i] * Math.SQRT1_2;
        }
      } else {
        outL.set(L);
        outR.set(R);
      }
    }
    if (c.mono > 0.001) {
      const k = c.mono;
      for (let i = 0; i < n; i++) {
        const m = (outL[i] + outR[i]) * 0.5;
        outL[i] += (m - outL[i]) * k;
        outR[i] += (m - outR[i]) * k;
      }
    }

    // 2. tone
    const eqOn = Math.abs(c.bass) > 0.01 || Math.abs(c.treble) > 0.01 || dlg > 0.01;
    if (eqOn) {
      this.updateEq();
      const lo = this.eqLow; const mi = this.eqMid; const hi = this.eqHigh;
      const useLo = Math.abs(c.bass) > 0.01; const useMi = dlg > 0.01; const useHi = Math.abs(c.treble) > 0.01;
      for (let i = 0; i < n; i++) {
        let l = outL[i];
        let r = outR[i];
        if (useLo) { l = lo.run(l, 0); r = lo.run(r, 1); }
        if (useMi) { l = mi.run(l, 0); r = mi.run(r, 1); }
        if (useHi) { l = hi.run(l, 0); r = hi.run(r, 1); }
        outL[i] = l;
        outR[i] = r;
      }
      lo.flush(); mi.flush(); hi.flush();
    }

    // 3. leveler (gain decided per block from the loudness so far, interpolated across the block)
    const lv = LEVELS[p.normalizer];
    const startDb = this.levelDb;
    if (lv) {
      let e = 0;
      let es = 0;
      const k1 = this.k1; const k2 = this.k2; const s1 = this.sp1; const s2 = this.sp2;
      for (let i = 0; i < n; i++) {
        const m = (outL[i] + outR[i]) * 0.5;
        const kw = k2.run(k1.run(m, 0), 0);
        e += kw * kw;
        const sp = s2.run(s1.run(m, 0), 0);
        es += sp * sp;
      }
      k1.flush(); k2.flush(); s1.flush(); s2.flush();
      this.ring[this.ringPos] = e / n;
      this.speechRing[this.ringPos] = es / n;
      this.ringPos = (this.ringPos + 1) % this.stN;
      let st = 0; let sp = 0; let fast = 0;
      for (let j = 0; j < this.stN; j++) { st += this.ring[j]; sp += this.speechRing[j]; }
      for (let j = 1; j <= this.fastN; j++) fast += this.ring[(this.ringPos - j + this.stN) % this.stN];
      st /= this.stN;
      fast /= this.fastN;
      // mono sum of a centred stereo signal: BS.1770 counts both channels → ×2
      const stLufs = -0.691 + 10 * Math.log10(2 * st + 1e-20);
      const fastLufs = -0.691 + 10 * Math.log10(2 * fast + 1e-20);
      this.loudness = stLufs;
      const level = Math.max(stLufs, fastLufs - 3); // a sudden loud scene is caught within ~100 ms
      const dt = n / this.fs;
      if (stLufs < GATE_LUFS) {
        // silence / room noise: hold the gain (the next line of dialogue starts at the right level);
        // after 3 s drift slowly back toward 0 dB so hiss is never pumped up
        this.gatedFor += dt;
        if (this.gatedFor > 3) this.levelDb += (0 - this.levelDb) * (1 - Math.exp(-dt / 4));
      } else {
        this.gatedFor = 0;
        this.speech = clamp(sp / (st + 1e-20), 0, 1);
        // upward gain counts fully for speech-like sound, less for music/ambience
        const upMax = lv.up * (0.5 + 0.5 * clamp((this.speech - 0.25) / 0.4, 0, 1));
        const want = clamp(lv.target - level, -lv.down, upMax);
        const tau = want < this.levelDb ? lv.fall : lv.rise;
        this.levelDb += (want - this.levelDb) * (1 - Math.exp(-dt / tau));
      }
    } else {
      this.levelDb += (0 - this.levelDb) * 0.05; // fade out after switching off
      if (Math.abs(this.levelDb) < 0.01) this.levelDb = 0;
    }
    const endDb = this.levelDb;
    const levelOn = Math.abs(startDb) > 0.001 || Math.abs(endDb) > 0.001;

    // 4. compressor (+ 3.) and 5. boost, sample by sample
    const g0 = dbToGain(startDb);
    const g1 = dbToGain(endDb);
    const boost0 = this.lastBoost === undefined ? c.boost : this.lastBoost;
    const boost1 = c.boost;
    this.lastBoost = boost1;
    const comp = lv ? lv : null;
    const knee = 6;
    let cg = this.compGain;
    let cgStep = 0;
    if (levelOn || comp || boost0 !== 1 || boost1 !== 1) {
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n;
        let l = outL[i] * (g0 + (g1 - g0) * t);
        let r = outR[i] * (g0 + (g1 - g0) * t);
        if (comp) {
          const x = (l * l + r * r) * 0.5;
          this.rms += (x - this.rms) * this.rmsCoef;
          if ((i & 7) === 0) {
            // gain computer every 8 samples (logs are the costly part), ramped in between
            const lev = 10 * Math.log10(this.rms + 1e-20);
            const over = lev - comp.compT;
            let red = 0;
            if (over > knee / 2) red = over * (1 - 1 / comp.ratio);
            else if (over > -knee / 2) red = (1 - 1 / comp.ratio) * (over + knee / 2) * (over + knee / 2) / (2 * knee);
            const target = -red;
            this.compDb += (target - this.compDb) * (target < this.compDb ? this.compAtt8 : this.compRel8);
            const next = dbToGain(this.compDb);
            cgStep = (next - cg) / 8;
          }
          cg += cgStep;
          l *= cg;
          r *= cg;
        } else if (this.compDb !== 0) {
          this.compDb = 0;
        }
        const b = boost0 + (boost1 - boost0) * t;
        outL[i] = l * b;
        outR[i] = r * b;
      }
    }
    this.compGain = comp ? cg : 1;

    // 6. look-ahead limiter (always on: it costs little and guarantees no clipping)
    this.limit(outL, outR, n);
  }

  limit(outL, outR, n) {
    const L = this.L;
    const dl = this.delay[0];
    const dr = this.delay[1];
    const qi = this.dqIdx;
    const qv = this.dqVal;
    const cap = L + 1;
    let env = this.env;
    let minEnv = this.minEnv;
    for (let i = 0; i < n; i++) {
      const l = outL[i];
      const r = outR[i];
      const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      const req = a > CEILING ? CEILING / a : 1;
      const k = this.n++;
      // sliding minimum of the requests over the last L samples
      while (this.dqLen && qv[(this.dqHead + this.dqLen - 1) % cap] >= req) this.dqLen--;
      qi[(this.dqHead + this.dqLen) % cap] = k;
      qv[(this.dqHead + this.dqLen) % cap] = req;
      this.dqLen++;
      while (qi[this.dqHead] <= k - L) { this.dqHead = (this.dqHead + 1) % cap; this.dqLen--; }
      const hold = qv[this.dqHead];
      // moving average of the hold over L samples: a smooth ramp that is down in time
      this.avgSum += hold - this.avgRing[this.avgPos];
      this.avgRing[this.avgPos] = hold;
      this.avgPos = (this.avgPos + 1) % L;
      if (this.avgPos === 0) { let s = 0; for (let j = 0; j < L; j++) s += this.avgRing[j]; this.avgSum = s; }
      const g = this.avgSum / L;
      env = g < env ? g : env + (g - env) * this.limRel;
      if (env < minEnv) minEnv = env;
      // delay line: out = input from L − 1 samples ago
      const pos = this.dPos;
      const dL = dl[pos];
      const dR = dr[pos];
      dl[pos] = l;
      dr[pos] = r;
      this.dPos = (pos + 1) % (L - 1);
      let ol = dL * env;
      let or = dR * env;
      // float safety (and NaN guard)
      if (!(ol <= CEILING)) ol = ol > 0 ? CEILING : (ol === ol ? ol : 0);
      if (!(ol >= -CEILING)) ol = ol === ol ? -CEILING : 0;
      if (!(or <= CEILING)) or = or > 0 ? CEILING : (or === or ? or : 0);
      if (!(or >= -CEILING)) or = or === or ? -CEILING : 0;
      outL[i] = ol;
      outR[i] = or;
    }
    this.env = env;
    this.minEnv = minEnv;
  }
}
