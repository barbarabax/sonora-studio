// @codedna
// description: Studio-grade dynamics and modulation effects (compressor, distortion, wah, envelope filter, chorus, flanger) as one sample-accurate processor shared by the browser worklet and the Node export.
//
// 
//
// 
//
// 
//
// 
//
// 
//
// exports: createFxProcessor
// used_by: sonora-studio/public/fx-worklet.js
//                   sonora-studio/stems.mjs
// rules:   The SAME code runs in the AudioWorklet (preview) and in Node (export), so every algorithm must be deterministic, per-sample, independent of the block size, and must not touch DOM or Web Audio APIs. Time constants are in milliseconds/Hz and converted with the sample rate. Order: compressor → distortion → wah → envelope filter → chorus → flanger → delay.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_dsp | Log-domain soft-knee compressor with decoupled ballistics and side-chain high-pass, 2x-oversampled distortion, TPT state-variable wah/envelope filters, Hermite-interpolated chorus/flanger.
import { normalizeFx, delayMs } from './fx.mjs';

const TWO_PI = Math.PI * 2;
const dbToLin = db => 10 ** (db / 20);

/** RBJ biquad, one state per channel (direct form II transposed). */
class Biquad {
  constructor() {
    this.set('lowpass', 1000, 0.7071, 44100);
    this.z1 = [0, 0];
    this.z2 = [0, 0];
  }
  set(type, freq, q, sampleRate) {
    const w0 = (TWO_PI * Math.min(freq, sampleRate * 0.45)) / sampleRate,
      cos = Math.cos(w0),
      alpha = Math.sin(w0) / (2 * q);
    let b0, b1, b2;
    if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x, c) {
    const y = this.b0 * x + this.z1[c];
    this.z1[c] = this.b1 * x - this.a1 * y + this.z2[c];
    this.z2[c] = this.b2 * x - this.a2 * y;
    return y;
  }
}

/**
 * Feed-forward compressor, log domain. Static curve with a quadratic soft knee (Giannoulis, Massberg, Reiss 2012), then the gain
 * reduction in dB is smoothed with separate attack and release ("smooth decoupled peak detector"): no zipper noise and no
 * distortion of the waveform. The detector is stereo-linked and can ignore low frequencies (side-chain high-pass) and use peak or RMS.
 */
class Compressor {
  constructor(sr) {
    this.sr = sr;
    this.hp = new Biquad();
    this.reset();
  }
  reset() {
    this.reduction = 0; // dB, smoothed
    this.power = 0;
    this.meter = 0;
    this.hp.z1 = [0, 0];
    this.hp.z2 = [0, 0];
  }
  set(p) {
    this.p = p;
    this.att = Math.exp(-1 / (p.att * 0.001 * this.sr));
    this.rel = Math.exp(-1 / (p.rel * 0.001 * this.sr));
    this.rms = Math.exp(-1 / (0.01 * this.sr));
    this.makeupDb = p.auto ? -p.thr * (1 - 1 / p.ratio) * 0.5 : p.makeup;
    this.hp.set('highpass', p.schp, 0.7071, this.sr);
  }
  process(L, R, n) {
    const { thr, ratio, knee, mix, mode } = this.p;
    let meter = this.meter;
    for (let i = 0; i < n; i++) {
      const dl = this.hp.run(L[i], 0),
        dr = this.hp.run(R[i], 1);
      let level;
      if (mode === 'rms') {
        this.power = this.rms * this.power + (1 - this.rms) * 0.5 * (dl * dl + dr * dr);
        level = Math.sqrt(this.power);
      } else level = Math.max(Math.abs(dl), Math.abs(dr));
      const xg = 20 * Math.log10(Math.max(level, 1e-9)),
        over = xg - thr;
      let yg;
      if (knee > 0.01 && 2 * over < -knee) yg = xg;
      else if (knee > 0.01 && 2 * Math.abs(over) <= knee)
        yg = xg + ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
      else yg = over > 0 ? thr + over / ratio : xg;
      const target = xg - yg; // wanted reduction, >= 0
      const coeff = target > this.reduction ? this.att : this.rel;
      this.reduction = coeff * this.reduction + (1 - coeff) * target;
      if (this.reduction > meter) meter = this.reduction;
      const gain = dbToLin(this.makeupDb - this.reduction);
      L[i] = L[i] * (1 - mix) + L[i] * gain * mix;
      R[i] = R[i] * (1 - mix) + R[i] * gain * mix;
    }
    this.meter = meter;
  }
}

/** 2x oversampling with a 31-tap windowed-sinc half-band FIR (keeps the harmonics of the clipper from aliasing back). */
const HALF = (() => {
  const taps = 31,
    mid = (taps - 1) / 2,
    h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid,
      sinc = x === 0 ? 0.5 : Math.sin((Math.PI * x) / 2) / (Math.PI * x),
      window = 0.54 - 0.46 * Math.cos((TWO_PI * i) / (taps - 1));
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] = (h[i] / sum) * 1; // unity gain at DC at the oversampled rate
  return h;
})();

/** Newest-first history of a signal in a doubled ring buffer, so the FIR reads one contiguous run. */
class History {
  constructor(taps) {
    this.taps = taps;
    this.data = new Float64Array(taps * 2);
    this.p = 0;
  }
  push(v) {
    this.p = (this.p + 1) % this.taps;
    this.data[this.p] = v;
    this.data[this.p + this.taps] = v;
  }
  fir(h) {
    let acc = 0;
    const base = this.p + this.taps;
    for (let k = 0; k < h.length; k++) acc += h[k] * this.data[base - k];
    return acc;
  }
}

/** Distortion with soft, hard and fuzz shapes; the non-linearity runs at twice the sample rate. */
class Distortion {
  constructor(sr) {
    this.sr = sr;
    this.tone = new Biquad();
    this.latency = HALF.length >> 1; // 15 samples at the base rate (30 at 2x)
    this.reset();
  }
  reset() {
    this.up = [new History(HALF.length), new History(HALF.length)];
    this.down = [new History(HALF.length), new History(HALF.length)];
    this.dcIn = [0, 0];
    this.dcOut = [0, 0];
    this.delay = [new Float64Array(this.latency), new Float64Array(this.latency)];
    this.delayPos = 0;
    this.tone.z1 = [0, 0];
    this.tone.z2 = [0, 0];
  }
  set(p) {
    this.p = p;
    this.drive = dbToLin(p.drive);
    this.level = dbToLin(p.level);
    this.tone.set('lowpass', p.tone, 0.7071, this.sr);
  }
  shape(x) {
    switch (this.p.type) {
      case 'hard':
        return Math.max(-1, Math.min(1, x));
      case 'fuzz': // asymmetric: the negative half clips harder, adding even harmonics
        return x >= 0 ? Math.tanh(x) : Math.tanh(x * 1.7) * 0.8;
      default:
        return Math.tanh(x);
    }
  }
  /** One sample of one channel: interpolate to 2x, shape both samples, filter and keep every second one. */
  channel(x, c) {
    this.up[c].push(x);
    const a = this.up[c].fir(HALF) * 2;
    this.up[c].push(0);
    const b = this.up[c].fir(HALF) * 2;
    this.down[c].push(this.shape(a * this.drive));
    this.down[c].push(this.shape(b * this.drive));
    return this.down[c].fir(HALF);
  }
  process(L, R, n) {
    const { mix } = this.p,
      size = this.latency;
    for (let i = 0; i < n; i++) {
      const slot = this.delayPos;
      this.delayPos = (this.delayPos + 1) % size;
      for (const [buffer, c] of [
        [L, 0],
        [R, 1],
      ]) {
        const input = buffer[i];
        const wet0 = this.tone.run(this.channel(input, c), c);
        // remove the DC an asymmetric shape creates (one-pole high-pass at ~7 Hz)
        const wet = wet0 - this.dcIn[c] + 0.999 * this.dcOut[c];
        this.dcIn[c] = wet0;
        this.dcOut[c] = wet;
        // the dry path is delayed by the oversampling filters' latency so the mix stays phase-aligned
        const dry = this.delay[c][slot];
        this.delay[c][slot] = input;
        buffer[i] = dry * (1 - mix) + wet * this.level * mix;
      }
    }
  }
}

/** Zavalishin topology-preserving state-variable filter, band-pass output scaled to unity gain at the centre. */
class Svf {
  constructor() {
    this.s1 = [0, 0];
    this.s2 = [0, 0];
  }
  reset() {
    this.s1 = [0, 0];
    this.s2 = [0, 0];
  }
  band(x, c, fc, q, sr) {
    const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr),
      k = 1 / q,
      a1 = 1 / (1 + g * (g + k)),
      a2 = g * a1,
      a3 = g * a2;
    const v3 = x - this.s2[c],
      v1 = a1 * this.s1[c] + a2 * v3,
      v2 = this.s2[c] + a2 * this.s1[c] + a3 * v3;
    this.s1[c] = 2 * v1 - this.s1[c];
    this.s2[c] = 2 * v2 - this.s2[c];
    return k * v1;
  }
}

class Wah {
  constructor(sr) {
    this.sr = sr;
    this.svf = new Svf();
    this.phase = 0;
  }
  reset() {
    this.svf.reset();
    this.phase = 0;
  }
  set(p) {
    this.p = { ...p, hi: Math.max(p.hi, p.lo * 1.2) };
  }
  process(L, R, n) {
    const { rate, lo, hi, q, mix } = this.p;
    for (let i = 0; i < n; i++) {
      const sweep = 0.5 + 0.5 * Math.sin(TWO_PI * this.phase);
      this.phase += rate / this.sr;
      if (this.phase >= 1) this.phase -= 1;
      const fc = lo * (hi / lo) ** sweep;
      L[i] = L[i] * (1 - mix) + this.svf.band(L[i], 0, fc, q, this.sr) * mix * 1.6;
      R[i] = R[i] * (1 - mix) + this.svf.band(R[i], 1, fc, q, this.sr) * mix * 1.6;
    }
  }
}

/** Envelope filter: the louder the playing, the higher (or lower) the filter's centre frequency. */
class EnvelopeFilter {
  constructor(sr) {
    this.sr = sr;
    this.svf = new Svf();
    this.env = 0;
  }
  reset() {
    this.svf.reset();
    this.env = 0;
  }
  set(p) {
    this.p = { ...p, hi: Math.max(p.hi, p.lo * 1.2) };
    this.att = Math.exp(-1 / (p.att * 0.001 * this.sr));
    this.rel = Math.exp(-1 / (p.rel * 0.001 * this.sr));
    this.gain = 1 + p.sens * 19;
  }
  process(L, R, n) {
    const { lo, hi, q, mix, dir } = this.p;
    for (let i = 0; i < n; i++) {
      const level = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const coeff = level > this.env ? this.att : this.rel;
      this.env = coeff * this.env + (1 - coeff) * level;
      let amount = Math.min(1, this.env * this.gain);
      if (dir === 'down') amount = 1 - amount;
      const fc = lo * (hi / lo) ** amount;
      L[i] = L[i] * (1 - mix) + this.svf.band(L[i], 0, fc, q, this.sr) * mix * 1.6;
      R[i] = R[i] * (1 - mix) + this.svf.band(R[i], 1, fc, q, this.sr) * mix * 1.6;
    }
  }
}

/** Modulated delay with cubic Hermite interpolation; used with feedback as a flanger and with several voices as a chorus. */
class ModDelay {
  constructor(sr, voices, maxMs) {
    this.sr = sr;
    this.voices = voices;
    this.size = Math.ceil((maxMs / 1000) * sr) + 8;
    this.buffer = [new Float32Array(this.size), new Float32Array(this.size)];
    this.write = 0;
    this.phase = 0;
    this.fbState = [0, 0];
  }
  reset() {
    this.buffer[0].fill(0);
    this.buffer[1].fill(0);
    this.write = 0;
    this.phase = 0;
    this.fbState = [0, 0];
  }
  read(c, delaySamples) {
    const b = this.buffer[c],
      pos = this.write - delaySamples,
      i1 = Math.floor(pos),
      f = pos - i1;
    const at = k => b[((((i1 + k) % this.size) + this.size) % this.size) | 0];
    const y0 = at(-1),
      y1 = at(0),
      y2 = at(1),
      y3 = at(2);
    const c1 = 0.5 * (y2 - y0),
      c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3,
      c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }
  process(L, R, n, { rate, depth, delay, mix, fb = 0 }) {
    const data = [L, R];
    for (let i = 0; i < n; i++) {
      this.phase += rate / this.sr;
      if (this.phase >= 1) this.phase -= 1;
      for (let c = 0; c < 2; c++) {
        const dry = data[c][i];
        let wet = 0;
        for (let v = 0; v < this.voices; v++) {
          // voices are spread evenly in phase; the right channel is a quarter cycle apart for width
          const lfo = Math.sin(TWO_PI * (this.phase + v / this.voices + (c ? 0.25 : 0)));
          const ms = Math.max(0.05, delay + depth * lfo);
          wet += this.read(c, (ms / 1000) * this.sr);
        }
        wet /= this.voices;
        this.buffer[c][this.write] = dry + (fb ? fb * wet : 0);
        data[c][i] = dry * (1 - mix) + wet * mix;
      }
      this.write = (this.write + 1) % this.size;
    }
  }
}

/**
 * Delay with feedback. The repeats pass through a low-pass and a high-pass inside the loop (each one darker and thinner, like tape or
 * an analogue delay); in ping-pong mode the repeats alternate between left and right. The wet signal is added on top of the dry one.
 */
class FeedbackDelay {
  constructor(sr) {
    this.sr = sr;
    this.size = Math.ceil(2.1 * sr);
    this.lp = new Biquad();
    this.hp = new Biquad();
    this.reset();
  }
  reset() {
    this.buffer = [new Float32Array(this.size), new Float32Array(this.size)];
    this.write = 0;
    for (const f of [this.lp, this.hp]) {
      f.z1 = [0, 0];
      f.z2 = [0, 0];
    }
  }
  set(p, bpm) {
    this.p = p;
    this.samples = (delayMs({ delay: p }, bpm) / 1000) * this.sr;
    this.lp.set('lowpass', p.tone, 0.7071, this.sr);
    this.hp.set('highpass', p.lowcut, 0.7071, this.sr);
  }
  read(c) {
    const pos = this.write - this.samples,
      i0 = Math.floor(pos),
      f = pos - i0,
      b = this.buffer[c];
    const at = k => b[(((i0 + k) % this.size) + this.size) % this.size];
    return at(0) * (1 - f) + at(1) * f;
  }
  process(L, R, n) {
    const { fb, mix, pingpong } = this.p;
    for (let i = 0; i < n; i++) {
      const dl = this.read(0),
        dr = this.read(1);
      const inL = L[i],
        inR = R[i];
      // feedback path: filtered, then scaled
      const fl = this.hp.run(this.lp.run(dl, 0), 0) * fb,
        fr = this.hp.run(this.lp.run(dr, 1), 1) * fb;
      if (pingpong) {
        this.buffer[0][this.write] = (inL + inR) * 0.5 + fr;
        this.buffer[1][this.write] = fl;
      } else {
        this.buffer[0][this.write] = inL + fl;
        this.buffer[1][this.write] = inR + fr;
      }
      this.write = (this.write + 1) % this.size;
      L[i] = inL + dl * mix;
      R[i] = inR + dr * mix;
    }
  }
}

/** The whole chain for one track. `process` works in place on two Float32Arrays of any length (state carries over between calls). */
export function createFxProcessor(sampleRate) {
  const comp = new Compressor(sampleRate),
    dist = new Distortion(sampleRate),
    wah = new Wah(sampleRate),
    env = new EnvelopeFilter(sampleRate),
    chorus = new ModDelay(sampleRate, 3, 45),
    flanger = new ModDelay(sampleRate, 1, 25),
    echo = new FeedbackDelay(sampleRate);
  let on = {},
    fx = null;
  return {
    /** `bpm` is the song's tempo, used when the delay is locked to a note value. */
    setParams(raw, bpm = 100) {
      fx = normalizeFx({ ...(raw || {}) });
      on = {
        comp: fx.comp.on,
        dist: fx.dist.on,
        wah: fx.wah.on,
        env: fx.env.on,
        chorus: fx.chorus.on,
        flanger: fx.flanger.on,
        delay: fx.delay.on,
      };
      comp.set(fx.comp);
      dist.set(fx.dist);
      wah.set(fx.wah);
      env.set(fx.env);
      echo.set(fx.delay, bpm);
    },
    reset() {
      for (const x of [comp, dist, wah, env, chorus, flanger, echo]) x.reset();
    },
    process(L, R, n = L.length) {
      if (!fx) return;
      if (on.comp) comp.process(L, R, n);
      if (on.dist) dist.process(L, R, n);
      if (on.wah) wah.process(L, R, n);
      if (on.env) env.process(L, R, n);
      if (on.chorus) chorus.process(L, R, n, fx.chorus);
      if (on.flanger) flanger.process(L, R, n, fx.flanger);
      if (on.delay) echo.process(L, R, n);
    },
    /** Largest gain reduction in dB since the last call (for the meter). */
    takeReduction() {
      const value = comp.meter;
      comp.meter = 0;
      return value;
    },
  };
}
