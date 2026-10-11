// @codedna
// description: Audio Lab DSP shared with the Python engine: filter coefficients, reverb impulse and BS.1770 loudness.
//
//
// 
//
// 
//
// 
//
// exports: EQ_BANDS | EQ_Q | EQ_RANGE | HIGH_PASS_HZ | BUTTERWORTH_Q | COMPRESSORS | REVERBS | IR_LOWPASS | IR_HIGHPASS | WET_LOWPASS | NEUTRAL | biquad | qToDb | impulse | integratedLufs
// used_by: sonora-studio/public/audio-lab-ui.mjs
// rules:   Must stay numerically identical to audio_lab_dsp.py (test/audio_lab_dsp_test.py cross-checks it).
// agent:   Claude - 2026-10-04 - Real-time Audio Lab chain matching the offline master.
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_Q = 1.4,
  EQ_RANGE = 12,
  HIGH_PASS_HZ = 30,
  BUTTERWORTH_Q = Math.SQRT1_2;
// threshold dB, ratio, attack ms, release ms
export const COMPRESSORS = { gentle: [-18, 2, 12, 160], tight: [-22, 3.5, 8, 140], punch: [-24, 5, 4, 90] };
// decay s, wet mix
export const REVERBS = { small: [0.3, 0.12], studio: [0.5, 0.18], large: [0.8, 0.25] };
export const IR_LOWPASS = [2000, 5],
  IR_HIGHPASS = [150, 3],
  WET_LOWPASS = [2500, 4];
export const NEUTRAL = {
  eq: EQ_BANDS.map(() => 0),
  compressor: 'off',
  reverb: 'off',
  width: 1,
  targetLufs: -14,
  ceiling: -1,
  metadata: 'keep',
};

// RBJ cookbook biquads, in the form the Web Audio API uses. Returns normalised [b0,b1,b2,a1,a2].
export function biquad(type, f, rate, { q = BUTTERWORTH_Q, gain = 0 } = {}) {
  const w = (2 * Math.PI * f) / rate,
    c = Math.cos(w),
    alpha = Math.sin(w) / (2 * q),
    A = 10 ** (gain / 40);
  let b, a;
  if (type === 'peaking') {
    b = [1 + alpha * A, -2 * c, 1 - alpha * A];
    a = [1 + alpha / A, -2 * c, 1 - alpha / A];
  } else if (type === 'lowpass') {
    b = [(1 - c) / 2, 1 - c, (1 - c) / 2];
    a = [1 + alpha, -2 * c, 1 - alpha];
  } else if (type === 'highpass') {
    b = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    a = [1 + alpha, -2 * c, 1 - alpha];
  } else if (type === 'highshelf') {
    const s = 2 * Math.sqrt(A) * alpha;
    b = [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s)];
    a = [A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s];
  } else throw new Error('Unsupported filter: ' + type);
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
}
// Web Audio lowpass/highpass take Q in dB.
export const qToDb = q => 20 * Math.log10(q);
function filter(data, [b0, b1, b2, a1, a2]) {
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i],
      y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
  return data;
}
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Deterministic filtered-noise impulse response, unit energy.
export function impulse(rate, mode) {
  const [decay] = REVERBS[mode],
    n = Math.max(1, Math.floor(rate * (decay + 0.15))),
    random = mulberry32(42),
    ir = new Float64Array(n);
  for (let i = 0; i < n; i++)
    ir[i] = (random() * 2 - 1) * Math.pow(1 - (n > 1 ? i / (n - 1) : 0), decay * 2.5);
  for (let k = 0; k < IR_LOWPASS[1]; k++) filter(ir, biquad('lowpass', IR_LOWPASS[0], rate));
  for (let k = 0; k < IR_HIGHPASS[1]; k++) filter(ir, biquad('highpass', IR_HIGHPASS[0], rate));
  let energy = 0;
  for (const v of ir) energy += v * v;
  energy = Math.sqrt(energy) || 1;
  for (let i = 0; i < n; i++) ir[i] /= energy;
  return ir;
}
// ITU-R BS.1770-4 integrated loudness, same filters, blocks and gates as pyloudnorm's default meter.
export function integratedLufs(channels, rate) {
  const block = 0.4,
    step = 0.25,
    count = channels[0].length,
    T = count / rate;
  if (T < block) return null;
  const blocks = Math.round((T - block) / (block * step)) + 1,
    z = channels.map(() => new Float64Array(blocks));
  channels.forEach((source, ch) => {
    const data = Float64Array.from(source);
    filter(data, biquad('highshelf', 1500, rate, { gain: 4 }));
    filter(data, biquad('highpass', 38, rate, { q: 0.5 }));
    const sum = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) sum[i + 1] = sum[i] + data[i] * data[i];
    for (let j = 0; j < blocks; j++) {
      const lo = Math.min(count, Math.trunc(block * (j * step) * rate)),
        hi = Math.min(count, Math.trunc(block * (j * step + 1) * rate));
      z[ch][j] = (sum[hi] - sum[lo]) / (block * rate);
    }
  });
  const loud = j => -0.691 + 10 * Math.log10(z.reduce((s, c) => s + c[j], 0));
  const mean = list => z.map(c => list.reduce((s, j) => s + c[j], 0) / list.length);
  let gated = [...Array(blocks).keys()].filter(j => loud(j) >= -70);
  if (!gated.length) return null;
  const relative = -0.691 + 10 * Math.log10(mean(gated).reduce((s, v) => s + v, 0)) - 10;
  gated = gated.filter(j => loud(j) > relative && loud(j) > -70);
  if (!gated.length) return null;
  return -0.691 + 10 * Math.log10(mean(gated).reduce((s, v) => s + v, 0));
}
