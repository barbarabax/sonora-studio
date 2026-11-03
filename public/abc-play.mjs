// @codedna
// description: Turns a YuE2 ABC plan into notes and chords, draws them as a piano roll and plays them with simple WebAudio sounds.
//
// exports: keyAccidentals | chordMidis | parseScore | drawRoll | playScore
// used_by: public/abc-edit.mjs
//                   public/midi-io.mjs
//                   public/yue2-ui.mjs
// rules:   parseScore is pure (no DOM, no audio) and reads the subset of ABC that YuE2 writes: header M/L/Q/K, voices, notes with octave marks, accidentals, durations, ties, rests (z) and bar rests (Z), "chord" symbols, [chords], bar lines. Anything it does not understand is skipped, never thrown. Chords come from the first voice only (the singer).
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-11 | s_20261011_yue2 | Created to let the user see and hear the plan before spending a generation.
// Codex | OpenAI | 2026-10-15 | Pause the score without firing onEnd, so playback can resume at its current position.
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const MAJOR_FIFTHS = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  'F#': 6,
  'C#': 7,
  F: -1,
  Bb: -2,
  Eb: -3,
  Ab: -4,
  Db: -5,
  Gb: -6,
  Cb: -7,
};
const MODE_FIFTHS = {
  '': 0,
  maj: 0,
  major: 0,
  ion: 0,
  mix: -1,
  dor: -2,
  m: -3,
  min: -3,
  minor: -3,
  aeo: -3,
  phr: -4,
  lyd: 1,
  loc: -5,
};

/** Letter -> +1/-1 for a key signature such as D, Bm, F#m, Eb, Gmix. */
export function keyAccidentals(key) {
  const match = /^\s*([A-G])([#b]?)\s*([A-Za-z]*)/.exec(key || 'C');
  const accidentals = {};
  if (!match) return accidentals;
  const tonic = MAJOR_FIFTHS[match[1] + match[2]];
  const mode =
    MODE_FIFTHS[(match[3] || '').toLowerCase().slice(0, 5)] ??
    MODE_FIFTHS[(match[3] || '').toLowerCase().slice(0, 3)] ??
    0;
  const fifths = (tonic ?? 0) + mode;
  if (fifths > 0) SHARP_ORDER.slice(0, Math.min(fifths, 7)).forEach(l => (accidentals[l] = 1));
  if (fifths < 0) FLAT_ORDER.slice(0, Math.min(-fifths, 7)).forEach(l => (accidentals[l] = -1));
  return accidentals;
}

/**
 * The MIDI notes of a chord symbol around middle C, and its bass note. Understands major, minor, 5, sus2/sus4, aug, dim,
 * dim7, m7b5, 6, 7, maj7, 9, maj9, m9, add9, 7sus4 and a slash bass (G/B). Returns null for something that is not a chord.
 */
export function chordMidis(symbol) {
  const match = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(String(symbol));
  if (!match) return null;
  const pitch = (letter, accidental) =>
    (LETTER[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
  const root = pitch(match[1], match[2]);
  const q = match[3] || '';
  if (/^5$/.test(q))
    return { bass: 36 + root, notes: [60 + root, 67 + root].map(n => (n > 71 ? n - 12 : n)) };
  let intervals = [0, 4, 7];
  const minor = /^(m|min|-)(?!aj)/.test(q);
  if (minor) intervals = [0, 3, 7];
  if (/^(dim|°|o(?!ct))/.test(q)) intervals = [0, 3, 6];
  if (/^(ø|m7b5)/.test(q)) intervals = [0, 3, 6];
  if (/^(aug|\+)/.test(q)) intervals = [0, 4, 8];
  if (/sus2/.test(q)) intervals = [0, 2, 7];
  else if (/sus/.test(q)) intervals = [0, 5, 7];
  if (/b5/.test(q) && !/^m7b5/.test(q)) intervals = intervals.map(n => (n === 7 ? 6 : n));
  if (/(#5|\+5)/.test(q)) intervals = intervals.map(n => (n === 7 ? 8 : n));
  const extra = [];
  const q2 = q.replace(/add\d+/g, ''); // "add9" adds a ninth but no seventh
  if (/^(dim|°)7/.test(q2)) extra.push(9);
  else if (/^(ø|m7b5)/.test(q2)) extra.push(10);
  else if (/maj(7|9|11|13)|M7|Δ/.test(q2)) extra.push(11);
  else if (/7|9|11|13/.test(q2)) extra.push(10);
  else if (/6/.test(q2)) extra.push(9);
  if (/9/.test(q)) extra.push(14);
  if (/b9/.test(q)) extra.push(13);
  const all = [...new Set([...intervals, ...extra])];
  const bassPitch = match[4] ? pitch(match[4], match[5]) : root;
  return { bass: 36 + bassPitch, notes: all.map(n => 60 + root + n).map(n => (n > 76 ? n - 12 : n)) };
}

/**
 * Parse a plan into { bpm, secondsPerUnit, barUnits, length, voices: [{ name, notes: [{ start, dur, midi }] }],
 * chords: [{ start, dur, symbol }], sections: [{ name, start }] }. Times are in L: units until the end; use `seconds` to convert.
 */
export function parseScore(abc) {
  const text = String(abc || '').replace(/\r\n/g, '\n');
  const head = { L: '1/8', M: '4/4', Q: '1/4=100', K: 'C' };
  const lines = text.split('\n');
  const voices = new Map();
  const order = [];
  const chords = [];
  const sections = [];
  let inBody = false,
    current = null,
    singer = null,
    barUnits = 16,
    unit = 1 / 16,
    memory = {},
    key = {};
  const ratio = value => {
    const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(value);
    return m ? Number(m[1]) / Number(m[2]) : null;
  };
  const voice = name => {
    if (!voices.has(name)) {
      voices.set(name, { name, notes: [], cursor: 0, tied: null });
      order.push(name);
    }
    return voices.get(name);
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!inBody) {
      const h = /^([A-Za-z]):\s*(.*)$/.exec(line);
      if (!h) continue;
      if (h[1] === 'V') {
        const name = /^(\S+)/.exec(h[2])?.[1];
        if (name) {
          voice(name);
          singer ||= name;
        }
      } else head[h[1]] = h[2];
      if (h[1] === 'K') {
        inBody = true;
        unit = ratio(head.L) || 1 / 16;
        const meter = ratio(head.M) || 1;
        barUnits = Math.max(1, Math.round(meter / unit));
        key = keyAccidentals(head.K);
        current = voice(singer || 'Voice');
        singer ||= current.name;
      }
      continue;
    }
    if (!line.trim()) continue;
    const comment = /^%\s*(.+)$/.exec(line);
    if (comment) {
      sections.push({ name: comment[1].trim(), start: voice(singer).cursor });
      continue;
    }
    const v = /^V:\s*(\S+)/.exec(line);
    if (v) {
      current = voice(v[1]);
      continue;
    }
    if (/^[A-Za-z]:/.test(line)) continue;
    const v0 = current;
    let i = 0;
    const duration = () => {
      let multiplier = 1;
      const digits = /^\d+/.exec(line.slice(i));
      if (digits) {
        multiplier = Number(digits[0]);
        i += digits[0].length;
      }
      while (line[i] === '/') {
        i++;
        const d = /^\d+/.exec(line.slice(i));
        multiplier /= d ? Number(d[0]) : 2;
        if (d) i += d[0].length;
      }
      return multiplier;
    };
    const readPitch = () => {
      let accidental = null;
      if (line.startsWith('^^', i) || line.startsWith('__', i)) {
        accidental = line[i] === '^' ? 2 : -2;
        i += 2;
      } else if ('^_='.includes(line[i])) {
        accidental = line[i] === '^' ? 1 : line[i] === '_' ? -1 : 0;
        i++;
      }
      const letter = line[i];
      if (!/[A-Ga-g]/.test(letter || '')) return null;
      i++;
      let octave = letter === letter.toLowerCase() ? 5 : 4;
      while (line[i] === ',' || line[i] === "'") octave += line[i++] === "'" ? 1 : -1;
      const upper = letter.toUpperCase();
      const id = upper + octave;
      if (accidental !== null) memory[id] = accidental;
      const shift = id in memory ? memory[id] : (key[upper] ?? 0);
      return 12 * (octave + 1) + LETTER[upper] + shift;
    };
    const place = (midis, units) => {
      const start = v0.cursor;
      let last = null;
      for (const midi of midis) {
        const open =
          v0.tied && v0.tied.midi === midi && Math.abs(v0.tied.start + v0.tied.dur - start) < 1e-6
            ? v0.tied
            : null;
        if (open) {
          open.dur += units;
          last = open;
        } else {
          last = { start, dur: units, midi };
          v0.notes.push(last);
        }
      }
      v0.cursor += units;
      return last;
    };
    while (i < line.length) {
      const c = line[i];
      if (c === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) break;
        const symbol = line.slice(i + 1, close);
        if (v0.name === singer && chordMidis(symbol) && /^[A-G]/.test(symbol))
          chords.push({ start: v0.cursor, symbol });
        i = close + 1;
      } else if (c === '[' && /[A-Ga-g^_=]/.test(line[i + 1] || '')) {
        const close = line.indexOf(']', i);
        if (close < 0) break;
        const inner = line.slice(i + 1, close);
        const midis = [];
        let j = 0;
        while (j < inner.length) {
          const m = /^([\^_=]*)([A-Ga-g])([,']*)/.exec(inner.slice(j));
          if (!m) {
            j++;
            continue;
          }
          const letter = m[2];
          let octave = letter === letter.toLowerCase() ? 5 : 4;
          for (const mark of m[3]) octave += mark === "'" ? 1 : -1;
          const upper = letter.toUpperCase();
          const accidental = m[1]
            ? m[1][0] === '^'
              ? m[1].length
              : m[1][0] === '_'
                ? -m[1].length
                : 0
            : (key[upper] ?? 0);
          midis.push(12 * (octave + 1) + LETTER[upper] + accidental);
          j += m[0].length;
          while (/[\d/]/.test(inner[j] || '')) j++;
        }
        i = close + 1;
        const units = duration();
        if (midis.length) place(midis, units);
        v0.tied = null;
      } else if (/[\^_=A-Ga-g]/.test(c)) {
        const midi = readPitch();
        if (midi === null) {
          i++;
          continue;
        }
        const units = duration();
        const tie = line[i] === '-';
        if (tie) i++;
        const note = place([midi], units);
        v0.tied = tie ? note : null;
      } else if (c === 'z' || c === 'x') {
        i++;
        v0.cursor += duration();
        v0.tied = null;
      } else if (c === 'Z' || c === 'X') {
        i++;
        v0.cursor += barUnits * duration();
        v0.tied = null;
      } else if (c === '|') {
        memory = {};
        i++;
      } else if (c === '{') {
        const close = line.indexOf('}', i);
        i = close < 0 ? line.length : close + 1;
      } else i++;
    }
  }
  const tempo = /^\s*(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)/.exec(head.Q);
  const bpm = tempo ? Number(tempo[3]) : Number(/(\d+)/.exec(head.Q)?.[1]) || 100;
  const beat = tempo ? Number(tempo[1]) / Number(tempo[2]) : 1 / 4;
  const secondsPerUnit = (60 / bpm) * (unit / beat);
  const length = Math.max(0, ...[...voices.values()].map(x => x.cursor));
  chords.sort((a, b) => a.start - b.start);
  chords.forEach((chord, index) => (chord.dur = (chords[index + 1]?.start ?? length) - chord.start));
  return {
    bpm,
    secondsPerUnit,
    barUnits,
    length,
    seconds: length * secondsPerUnit,
    key: head.K.trim(),
    meter: head.M.trim(),
    voices: order.map(name => ({ name, notes: voices.get(name).notes })).filter(x => x.notes.length),
    chords,
    sections,
  };
}

const COLORS = ['#edb191', '#7f9a8a', '#8a8fb5'];
/** Draw the plan as a piano roll with chord names; returns { pxPerSecond, width, height } so a playhead can be placed. */
export function drawRoll(canvas, score, { pxPerSecond = 14, height = 150 } = {}) {
  const width = Math.max(300, Math.ceil(score.seconds * pxPerSecond) + 20);
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const all = score.voices.flatMap(v => v.notes.map(n => n.midi));
  const low = all.length ? Math.min(...all) - 1 : 48,
    high = all.length ? Math.max(...all) + 1 : 84;
  // a taller roll (the big editor window) gets larger text and thicker notes
  const text = height > 200 ? 14 : 10,
    bar = height > 200 ? 8 : 4;
  const top = text * 2 - 2,
    area = height - top - bar;
  const y = midi => top + ((high - midi) / Math.max(1, high - low)) * area;
  const x = units => units * score.secondsPerUnit * pxPerSecond;
  ctx.font = `${text}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  // bars and sections
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let u = 0; u <= score.length; u += score.barUnits) {
    ctx.beginPath();
    ctx.moveTo(x(u) + 0.5, top);
    ctx.lineTo(x(u) + 0.5, height);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (const section of score.sections) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(x(section.start) + 0.5, 0);
    ctx.lineTo(x(section.start) + 0.5, height);
    ctx.stroke();
    ctx.fillText(section.name, x(section.start) + 3, 0);
  }
  // chord names
  ctx.fillStyle = '#f2e3d8';
  ctx.font = `bold ${text}px system-ui, sans-serif`;
  for (const chord of score.chords) ctx.fillText(chord.symbol, x(chord.start) + 2, text - 1);
  // notes: the singer last, so it stays on top
  [...score.voices].reverse().forEach((voice, reverseIndex) => {
    const index = score.voices.length - 1 - reverseIndex;
    ctx.fillStyle = COLORS[index % COLORS.length] + (index === 0 ? '' : '99');
    for (const note of voice.notes)
      ctx.fillRect(x(note.start), y(note.midi) - bar / 2, Math.max(2, x(note.dur) - 1), bar);
  });
  return { pxPerSecond, width, height };
}

/**
 * Play the plan with simple sounds: the singer's melody (triangle), the instrument voice (sine), chord pads and a bass.
 * Notes are scheduled a little ahead of time, so a long plan never creates thousands of nodes at once.
 * Returns { stop(), pause(), position() } (position in seconds). Pause releases scheduled sounds without ending the score.
 */
export function playScore(score, { ctx, from = 0, volume = 0.5, onEnd = () => {} }) {
  const events = [];
  const unit = score.secondsPerUnit;
  const midiHz = midi => 440 * 2 ** ((midi - 69) / 12);
  score.voices.forEach((voice, index) => {
    for (const note of voice.notes)
      events.push({
        t: note.start * unit,
        d: Math.max(0.06, note.dur * unit),
        hz: midiHz(note.midi),
        type: index === 0 ? 'triangle' : 'sine',
        gain: index === 0 ? 0.22 : 0.1,
      });
  });
  for (const chord of score.chords) {
    const voicing = chordMidis(chord.symbol);
    if (!voicing) continue;
    const t = chord.start * unit,
      d = Math.max(0.1, chord.dur * unit);
    for (const midi of voicing.notes)
      events.push({ t, d, hz: midiHz(midi - 12), type: 'triangle', gain: 0.045 });
    events.push({ t, d, hz: midiHz(voicing.bass), type: 'sine', gain: 0.13 });
  }
  events.sort((a, b) => a.t - b.t);
  const end = score.seconds + 0.5;
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  const origin = ctx.currentTime + 0.1 - from;
  let next = events.findIndex(e => e.t + e.d > from);
  if (next < 0) next = events.length;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const horizon = ctx.currentTime - origin + 1.5;
    while (next < events.length && events[next].t <= horizon) {
      const e = events[next++];
      const start = Math.max(origin + e.t, ctx.currentTime);
      const stop = origin + e.t + e.d;
      if (stop <= start) continue;
      const osc = ctx.createOscillator(),
        env = ctx.createGain();
      osc.type = e.type;
      osc.frequency.value = e.hz;
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(e.gain, start + 0.02);
      env.gain.setValueAtTime(e.gain, Math.max(start + 0.02, stop - 0.06));
      env.gain.linearRampToValueAtTime(0, stop);
      osc.connect(env).connect(master);
      osc.start(start);
      osc.stop(stop + 0.02);
    }
    if (ctx.currentTime - origin > end) finish();
  };
  const timer = setInterval(schedule, 120);
  const finish = (notify = true) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    setTimeout(() => master.disconnect(), 300);
    if (notify) onEnd();
  };
  schedule();
  const position = () => Math.max(0, ctx.currentTime - origin);
  return {
    stop: () => finish(),
    pause: () => {
      const at = position();
      finish(false);
      return at;
    },
    position,
  };
}
