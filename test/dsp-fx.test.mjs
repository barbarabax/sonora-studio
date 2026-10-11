import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFxProcessor } from '../public/dsp-fx.mjs';

const SR = 44100;
const db = v => 20 * Math.log10(v);
const sine = (hz, peakDb, seconds) => {
  const n = Math.round(SR * seconds),
    out = new Float32Array(n),
    a = 10 ** (peakDb / 20);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
};
const run = (fx, input, block = input.length) => {
  const p = createFxProcessor(SR);
  p.setParams(fx);
  const L = Float32Array.from(input),
    R = Float32Array.from(input);
  for (let i = 0; i < L.length; i += block) {
    const end = Math.min(L.length, i + block);
    p.process(L.subarray(i, end), R.subarray(i, end), end - i);
  }
  return { L, R, p };
};
const peak = (x, from, to) => {
  let m = 0;
  for (let i = Math.round(from); i < Math.round(to); i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};

test('compressor follows the static curve: 4:1 above the threshold, untouched below', () => {
  const comp = {
    on: true,
    thr: -18,
    ratio: 4,
    att: 1,
    rel: 100,
    knee: 0,
    auto: false,
    makeup: 0,
    mix: 1,
    schp: 20,
  };
  for (const [input, expected] of [
    [-30, -30],
    [-18, -18],
    [-6, -15],
    [0, -13.5],
  ]) {
    const { L } = run({ comp }, sine(1000, input, 1));
    const measured = db(peak(L, SR * 0.7, SR));
    assert.ok(
      Math.abs(measured - expected) < 0.4,
      `${input} dB in → ${measured.toFixed(2)} dB out (expected ${expected})`
    );
  }
});

test('compressor knee is smooth and auto make-up restores part of the level', () => {
  const soft = {
    on: true,
    thr: -18,
    ratio: 4,
    att: 1,
    rel: 100,
    knee: 12,
    auto: false,
    makeup: 0,
    mix: 1,
    schp: 20,
  };
  const atThreshold = db(peak(run({ comp: soft }, sine(1000, -18, 1)).L, SR * 0.7, SR));
  assert.ok(
    atThreshold < -18.2 && atThreshold > -20.5,
    `soft knee starts bending at the threshold (${atThreshold.toFixed(2)})`
  );
  const auto = db(peak(run({ comp: { ...soft, knee: 0, auto: true } }, sine(1000, -6, 1)).L, SR * 0.7, SR));
  assert.ok(
    auto > -15 + 3 && auto < -15 + 9,
    `automatic make-up lifts the compressed level (${auto.toFixed(2)})`
  );
  const half = run({ comp: { ...soft, knee: 0, mix: 0.5 } }, sine(1000, -6, 1));
  const wet = peak(half.L, SR * 0.7, SR);
  assert.ok(wet > 10 ** (-15 / 20) && wet < 10 ** (-6 / 20), 'parallel mix sits between compressed and dry');
});

test('compressor ballistics: the reduction reaches 63% of the step within the attack time and releases with the release time', () => {
  const comp = {
    on: true,
    thr: -30,
    ratio: 100,
    att: 20,
    rel: 200,
    knee: 0,
    auto: false,
    makeup: 0,
    mix: 1,
    schp: 20,
  };
  const n = SR * 2,
    x = new Float32Array(n);
  for (let i = 0; i < n; i++)
    x[i] = (i > SR * 0.2 && i < SR * 1.0 ? 0.5 : 0.001) * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const { L } = run({ comp }, x);
  const gain = (center, width = 200) =>
    peak(L, center - width, center + width) / peak(x, center - width, center + width);
  const full = gain(Math.round(SR * 0.95)); // settled attenuation
  const early = gain(Math.round(SR * 0.2 + 0.02 * SR)); // one attack time after the step
  assert.ok(full < 0.1, `settles to heavy reduction (${full})`);
  assert.ok(early > full * 1.5 && early < 1.001, 'still moving one attack time after the step');
  const late = gain(Math.round(SR * 1.0 + 0.8 * SR), 400);
  assert.ok(late > 0.8, `released after the signal drops (${late})`);
});

test('every effect gives the same samples whatever the block size', () => {
  const fx = {
    comp: { on: true, thr: -24, ratio: 5, knee: 8, mode: 'rms' },
    dist: { on: true, type: 'fuzz', drive: 15, mix: 0.7 },
    wah: { on: true, rate: 2 },
    env: { on: true, dir: 'down' },
    chorus: { on: true },
    flanger: { on: true, fb: -0.6 },
  };
  const x = Float32Array.from(
    { length: 9000 },
    (_, i) => 0.6 * Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.31)
  );
  const whole = run(fx, x).L;
  for (const block of [1, 128, 500, 1999]) {
    const chunked = run(fx, x, block).L;
    for (let i = 0; i < x.length; i++)
      if (chunked[i] !== whole[i]) assert.fail(`block ${block} differs at sample ${i}`);
  }
});

test('extreme settings stay finite and bounded', () => {
  const fx = {
    comp: { on: true, thr: -60, ratio: 20, att: 0.1, rel: 10, knee: 24, makeup: 24, auto: false },
    dist: { on: true, drive: 40, level: 12, type: 'hard' },
    wah: { on: true, q: 12, rate: 8 },
    env: { on: true, q: 12, sens: 1 },
    chorus: { on: true, depth: 8, mix: 1 },
    flanger: { on: true, fb: 0.95, depth: 6, mix: 1 },
  };
  let seed = 7;
  const noise = Float32Array.from({ length: 60000 }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  });
  const { L, R } = run(fx, noise, 256);
  for (let i = 0; i < L.length; i++) {
    assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `non-finite sample at ${i}`);
    assert.ok(Math.abs(L[i]) < 1000, `runaway level at ${i}`);
  }
});

test('modulation effects are transparent at mix 0, and distortion keeps its dry path aligned', () => {
  const x = sine(440, -6, 0.2);
  for (const name of ['chorus', 'flanger', 'wah', 'env']) {
    const { L } = run({ [name]: { on: true, mix: 0 } }, x);
    for (let i = 0; i < x.length; i++)
      if (Math.abs(L[i] - x[i]) > 1e-6) assert.fail(`${name} not transparent at ${i}`);
  }
  const { L } = run({ dist: { on: true, mix: 0 } }, x);
  // dry is delayed by the oversampling latency (15 samples)
  for (let i = 15; i < x.length; i++)
    if (Math.abs(L[i] - x[i - 15]) > 1e-6) assert.fail(`dry path misaligned at ${i}`);
  const hard = run(
    { dist: { on: true, type: 'hard', drive: 30, level: 0, tone: 16000 } },
    sine(440, -6, 0.2)
  ).L;
  assert.ok(peak(hard, 2000, hard.length) < 1.2, 'hard clip stays near full scale');
});

test('the envelope filter and the wah really move the sound', () => {
  let seed = 3;
  const noise = Float32Array.from({ length: SR }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return ((seed / 4294967296) * 2 - 1) * 0.5;
  });
  const wah = run({ wah: { on: true, rate: 2, q: 6, mix: 1 } }, noise).L;
  const windows = [];
  for (let s = 0; s + 2000 <= wah.length; s += 2000) windows.push(peak(wah, s, s + 2000));
  assert.ok(Math.max(...windows) / Math.min(...windows) > 1.2, 'the wah level swings with its sweep');
  const loud = Float32Array.from(noise, (v, i) => (i > SR / 2 ? v : v * 0.02));
  const env = run({ env: { on: true, sens: 0.9, q: 6, mix: 1, lo: 200, hi: 4000 } }, loud).L;
  assert.ok(peak(env, SR * 0.75, SR) > peak(env, 0, SR * 0.4) * 3, 'a louder input opens the filter');
});

test('delay: repeats arrive at the set time with the feedback gain, ping-pong alternates ears, sync follows the tempo', () => {
  const impulse = new Float32Array(SR * 2);
  impulse[10] = 1;
  const base = { on: true, mode: 'free', ms: 100, fb: 0.5, tone: 16000, lowcut: 20, pingpong: false, mix: 1 };
  const { L } = run({ delay: base }, impulse);
  const at = ms => Math.round((SR * ms) / 1000) + 10;
  const near = (x, i) => Math.max(...Array.from({ length: 7 }, (_, k) => Math.abs(x[i - 3 + k])));
  assert.ok(near(L, at(100)) > 0.8, 'first repeat at 100 ms at full level');
  assert.ok(
    near(L, at(200)) > 0.3 && near(L, at(200)) < 0.6,
    'second repeat at 200 ms is about half as loud (feedback 0.5)'
  );
  assert.ok(near(L, at(150)) < 0.05, 'nothing between the repeats');
  const ping = run({ delay: { ...base, pingpong: true } }, impulse);
  assert.ok(near(ping.L, at(100)) > 0.6, 'first repeat starts on the left');
  assert.ok(near(ping.R, at(100)) < 0.05 && near(ping.R, at(200)) > 0.3, 'the second repeat is on the right');
  // 1/8 note at 120 BPM is 250 ms; a dotted eighth is 375 ms.
  const synced = (note, bpm) => {
    const p = createFxProcessor(SR);
    p.setParams({ delay: { ...base, mode: 'sync', note, fb: 0 } }, bpm);
    const a = Float32Array.from(impulse),
      b = Float32Array.from(impulse);
    p.process(a, b, a.length);
    return a;
  };
  assert.ok(near(synced('1/8', 120), at(250)) > 0.8);
  assert.ok(near(synced('1/8.', 120), at(375)) > 0.4);
  assert.ok(near(synced('1/4', 60), at(1000)) > 0.8);
  // feedback filters make the repeats duller
  const dull = run({ delay: { ...base, tone: 800, fb: 0.7 } }, sine(5000, -6, 0.5));
  const bright = run({ delay: { ...base, tone: 16000, fb: 0.7 } }, sine(5000, -6, 0.5));
  assert.ok(peak(dull.L, SR * 0.3, SR * 0.5) < peak(bright.L, SR * 0.3, SR * 0.5) * 0.7);
});
