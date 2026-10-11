// @codedna
// description: Shared definition of the per-track effects (EQ, filters, saturation, stereo width, echo, reverb) used by the mixer preview and the server mixdown.
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
// exports: FX_DEFAULT | NOTES | delayMs | DSP_BLOCKS | ROOMS | normalizeFx | fxActive | dspActive | echoTaps | saturationCurve | widthMatrix | reverbImpulse | verbMix
// used_by: sonora-studio/public/dsp-fx.mjs
//                   sonora-studio/public/mixer-ui.mjs
//                   sonora-studio/public/timeline-ui.mjs
//                   sonora-studio/stems.mjs
// rules:   Pure functions only (runs in the browser and in Node). The preview (Web Audio) and the export (ffmpeg) must apply the same effects in the same order: EQ → high/low-pass → saturation → stereo width → echo → reverb. The impulse response is deterministic, so both sides convolve with the same noise.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_fx | Per-track effects with identical parameters for Web Audio and ffmpeg.

/** Neutral settings: every effect is off. */
export const FX_DEFAULT = Object.freeze({
  low: 0, // dB, low shelf at 120 Hz
  mid: 0, // dB, peak at 1 kHz
  high: 0, // dB, high shelf at 8 kHz
  hp: 20, // Hz, high-pass (20 = off)
  lp: 20000, // Hz, low-pass (20000 = off)
  sat: 0, // 0-1 tanh saturation
  width: 1, // 0 = mono, 1 = unchanged, 2 = wide
  echo: 0, // 0-1 level of the repeats
  echoMs: 300, // delay of the first repeat
  verb: 0, // 0-1 reverb level
  room: 'medium', // small | medium | large
  shift: 0, // ms, nudges the whole track in time (not an effect: used to line up recordings)
  // Dynamics and modulation, processed by public/dsp-fx.mjs: each block is switched on with `on`.
  comp: Object.freeze({
    on: false,
    thr: -18,
    ratio: 3,
    att: 10,
    rel: 120,
    knee: 6,
    auto: true,
    makeup: 0,
    mix: 1,
    mode: 'peak',
    schp: 80,
  }),
  dist: Object.freeze({ on: false, type: 'soft', drive: 12, tone: 8000, level: 0, mix: 1 }),
  wah: Object.freeze({ on: false, rate: 1.5, lo: 350, hi: 2200, q: 4, mix: 1 }),
  env: Object.freeze({ on: false, sens: 0.6, lo: 200, hi: 3500, q: 3, att: 5, rel: 120, dir: 'up', mix: 1 }),
  chorus: Object.freeze({ on: false, rate: 0.8, depth: 3, delay: 14, mix: 0.5 }),
  flanger: Object.freeze({ on: false, rate: 0.25, depth: 2, delay: 2.5, fb: 0.5, mix: 0.5 }),
  // Delay with feedback: free time in ms or locked to the song's tempo with a note value; optional ping-pong between the ears.
  delay: Object.freeze({
    on: false,
    mode: 'sync',
    note: '1/8.',
    ms: 375,
    fb: 0.4,
    tone: 5000,
    lowcut: 120,
    pingpong: false,
    mix: 0.35,
  }),
});

/** Note values for a tempo-synced delay, in beats (a beat is a quarter note). */
export const NOTES = Object.freeze({
  '1/2': 2,
  '1/4': 1,
  '1/4.': 1.5,
  '1/4t': 2 / 3,
  '1/8': 0.5,
  '1/8.': 0.75,
  '1/8t': 1 / 3,
  '1/16': 0.25,
  '1/16.': 0.375,
  '1/16t': 1 / 6,
});

/** Delay time in milliseconds: the note value at `bpm` when synced, otherwise the free time. */
export function delayMs(raw, bpm = 100) {
  const d = normalizeFx(raw).delay,
    tempo = Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? bpm : 100;
  return Math.min(2000, Math.max(20, d.mode === 'sync' ? (60000 / tempo) * NOTES[d.note] : d.ms));
}

/** Ranges and allowed words of the dynamics/modulation blocks. */
export const DSP_BLOCKS = Object.freeze({
  comp: {
    thr: [-60, 0],
    ratio: [1, 20],
    att: [0.1, 100],
    rel: [10, 1000],
    knee: [0, 24],
    makeup: [-12, 24],
    mix: [0, 1],
    schp: [20, 300],
    mode: ['peak', 'rms'],
  },
  dist: { drive: [0, 40], tone: [500, 16000], level: [-24, 12], mix: [0, 1], type: ['soft', 'hard', 'fuzz'] },
  wah: { rate: [0.1, 8], lo: [200, 1000], hi: [800, 4000], q: [1, 12], mix: [0, 1] },
  env: {
    sens: [0, 1],
    lo: [100, 1000],
    hi: [500, 6000],
    q: [1, 12],
    att: [1, 100],
    rel: [10, 1000],
    mix: [0, 1],
    dir: ['up', 'down'],
  },
  chorus: { rate: [0.05, 5], depth: [0, 8], delay: [5, 30], mix: [0, 1] },
  flanger: { rate: [0.05, 5], depth: [0, 6], delay: [0.3, 10], fb: [-0.95, 0.95], mix: [0, 1] },
  delay: {
    mode: ['sync', 'free'],
    note: Object.keys(NOTES),
    ms: [20, 1500],
    fb: [0, 0.92],
    tone: [500, 16000],
    lowcut: [20, 1000],
    mix: [0, 1],
  },
});

function normalizeBlock(name, raw) {
  const def = FX_DEFAULT[name],
    ranges = DSP_BLOCKS[name],
    r = raw && typeof raw === 'object' ? raw : {};
  const out = { on: r.on === true };
  for (const key of Object.keys(def)) {
    if (key === 'on') continue;
    const range = ranges[key];
    if (typeof def[key] === 'boolean') out[key] = typeof r[key] === 'boolean' ? r[key] : def[key];
    else if (typeof def[key] === 'string') out[key] = range.includes(r[key]) ? r[key] : def[key];
    else out[key] = clamp(r[key], range[0], range[1], def[key]);
  }
  return out;
}

export const ROOMS = Object.freeze({ small: 0.6, medium: 1.4, large: 2.8 });

const clamp = (v, lo, hi, fallback) =>
  Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback;

/** Clamps every field to its range and fills the missing ones; unknown keys are dropped. */
export function normalizeFx(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const d = FX_DEFAULT;
  return {
    low: clamp(f.low, -12, 12, d.low),
    mid: clamp(f.mid, -12, 12, d.mid),
    high: clamp(f.high, -12, 12, d.high),
    hp: clamp(f.hp, 20, 1000, d.hp),
    lp: clamp(f.lp, 1000, 20000, d.lp),
    sat: clamp(f.sat, 0, 1, d.sat),
    width: clamp(f.width, 0, 2, d.width),
    echo: clamp(f.echo, 0, 1, d.echo),
    echoMs: clamp(f.echoMs, 50, 800, d.echoMs),
    verb: clamp(f.verb, 0, 1, d.verb),
    room: Object.hasOwn(ROOMS, f.room) ? f.room : d.room,
    shift: clamp(f.shift, -300, 300, d.shift),
    comp: normalizeBlock('comp', f.comp),
    dist: normalizeBlock('dist', f.dist),
    wah: normalizeBlock('wah', f.wah),
    env: normalizeBlock('env', f.env),
    chorus: normalizeBlock('chorus', f.chorus),
    flanger: normalizeBlock('flanger', f.flanger),
    delay: normalizeBlock('delay', f.delay),
  };
}

/** True when at least one effect is switched on. */
export function fxActive(raw) {
  const f = normalizeFx(raw);
  return (
    f.low !== 0 ||
    f.mid !== 0 ||
    f.high !== 0 ||
    f.hp > 20 ||
    f.lp < 20000 ||
    f.sat > 0 ||
    f.width !== 1 ||
    f.echo > 0 ||
    f.verb > 0 ||
    dspActive(f)
  );
}

/** True when the dynamics/modulation processor has something to do. */
export function dspActive(raw) {
  const f = normalizeFx(raw);
  return f.comp.on || f.dist.on || f.wah.on || f.env.on || f.chorus.on || f.flanger.on || f.delay.on;
}

/** Echo repeats: three taps at 1x, 2x and 3x the delay, each quieter than the previous (decay 0.6). */
export function echoTaps(raw) {
  const f = normalizeFx(raw);
  return [1, 2, 3].map(n => ({ ms: Math.round(f.echoMs * n), gain: f.echo * 0.6 ** n }));
}

/** Shape of the saturation: tanh(k·x)/tanh(k), so a full-scale signal stays at full scale. */
export function saturationCurve(raw, points = 4096) {
  const k = 1 + normalizeFx(raw).sat * 9;
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return { k, curve };
}

/** Stereo width as a matrix: L' = a·L + b·R, R' = b·L + a·R (width 1 = identity, 0 = mono, 2 = exaggerated sides). */
export function widthMatrix(raw) {
  const w = normalizeFx(raw).width;
  return { a: (1 + w) / 2, b: (1 - w) / 2 };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic stereo impulse response of a room: decaying noise (−60 dB at the room's length) after a 10 ms pre-delay,
 * normalised to unit energy so the wet signal has about the loudness of the dry one. Same arrays in the browser and on the server.
 */
export function reverbImpulse(room = 'medium', sampleRate = 44100) {
  const seconds = ROOMS[room] ?? ROOMS.medium;
  const length = Math.floor(seconds * sampleRate),
    pre = Math.floor(0.01 * sampleRate);
  const seed = { small: 11, medium: 23, large: 47 }[room] ?? 23;
  const left = new Float32Array(length),
    right = new Float32Array(length);
  for (const [channel, offset] of [
    [left, 0],
    [right, 7919],
  ]) {
    const random = mulberry32(seed + offset);
    let energy = 0;
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / sampleRate;
      const v = (random() * 2 - 1) * Math.exp((-t * Math.log(1000)) / seconds);
      channel[i] = v;
      energy += v * v;
    }
    const norm = 1 / Math.sqrt(energy || 1);
    for (let i = pre; i < length; i++) channel[i] *= norm;
  }
  return { left, right, sampleRate, length };
}

/** Equal-power crossfade between the dry sound and the reverb, so raising the reverb does not make the track quieter. */
export function verbMix(raw) {
  const m = normalizeFx(raw).verb;
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) };
}
