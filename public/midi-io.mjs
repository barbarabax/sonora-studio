// @codedna
// description: MIDI files and YuE2 plans: a plan saved as a .mid (voice, instrument, chords, sections) and a .mid read back as a plan.
//
// exports: planToMidi | readMidi | guessKey | guessChord | midiToPlan
// used_by: public/yue2-ui.mjs
// related: public/abc-play.mjs parseScore — what is written; public/abc-edit.mjs writeBar — how bars are written back
// rules:   Pure functions, no DOM. A plan is on a 1/16 grid: imported notes are snapped to it, the voice keeps one note at a time (the highest),
//          notes crossing a bar line are split and tied. Chords are guessed per bar from all tracks; the key from the whole file.
// agent:   claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_midi | Created for the YuE2 score editor (idea from YuE2-Studio / YuE2-ComfyUI's MIDI import).
import { parseScore, chordMidis } from './abc-play.mjs';
import { writeBar } from './abc-edit.mjs';
import { lyricSectionLines } from './chord-bed.mjs';

const PPQ = 480;

/* ---------- writing ---------- */
const vlq = n => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const text = s => [...new TextEncoder().encode(s)];
function track(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let last = 0;
  for (const e of events) {
    bytes.push(...vlq(Math.max(0, e.tick - last)), ...e.data);
    last = e.tick;
  }
  bytes.push(0, 0xff, 0x2f, 0);
  return [
    0x4d,
    0x54,
    0x72,
    0x6b,
    (bytes.length >>> 24) & 255,
    (bytes.length >>> 16) & 255,
    (bytes.length >>> 8) & 255,
    bytes.length & 255,
    ...bytes,
  ];
}
const meta = (tick, type, data, order = 0) => ({
  tick,
  order,
  data: [0xff, type, ...vlq(data.length), ...data],
});
const noteEvents = (channel, midi, from, to, velocity) => [
  { tick: from, order: 2, data: [0x90 | channel, midi, velocity] },
  { tick: to, order: 1, data: [0x80 | channel, midi, 0] },
];

/** The plan as a type-1 MIDI file: tempo/meter/sections, the voice, the instrument and the chords on three tracks. */
export function planToMidi(abc) {
  const score = parseScore(abc);
  if (!score.voices.some(v => v.notes.length) && !score.chords.length)
    throw new Error('The plan has no notes or chords to save.');
  const ticks = units => Math.round(((units * score.secondsPerUnit * score.bpm) / 60) * PPQ);
  const [num, den] = String(score.meter || '4/4')
    .split('/')
    .map(Number);
  const mpq = Math.round(60000000 / score.bpm);
  const head = [
    meta(0, 0x51, [(mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255]),
    meta(0, 0x58, [num || 4, Math.log2(den || 4), 24, 8]),
    meta(0, 0x03, text('Sonora YuE2')),
    ...score.sections.map(s => meta(ticks(s.start), 0x06, text(s.name))),
  ];
  const tracks = [track(head)];
  score.voices.forEach((voice, i) => {
    const channel = i;
    const events = [
      meta(0, 0x03, text(i === 0 ? 'Vocal' : `Instrument ${i}`)),
      { tick: 0, order: 0, data: [0xc0 | channel, i === 0 ? 73 : 0] },
    ];
    for (const n of voice.notes)
      events.push(...noteEvents(channel, n.midi, ticks(n.start), ticks(n.start + n.dur), i === 0 ? 100 : 80));
    tracks.push(track(events));
  });
  const chords = [meta(0, 0x03, text('Chords')), { tick: 0, order: 0, data: [0xc0 | 15, 48] }];
  for (const c of score.chords) {
    const voicing = chordMidis(c.symbol);
    if (!voicing) continue;
    for (const midi of [voicing.bass, ...voicing.notes])
      chords.push(...noteEvents(15, midi, ticks(c.start), ticks(c.start + c.dur), 55));
    chords.push(meta(ticks(c.start), 0x01, text(c.symbol)));
  }
  tracks.push(track(chords));
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, PPQ >> 8, PPQ & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}

/* ---------- reading ---------- */
/** { ppq, bpm, meter: [num, den], markers: [{ tick, text }], tracks: [{ name, channel, program, drums, notes: [{ tick, end, midi, velocity }] }] } */
export function readMidi(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = at => String.fromCharCode(...data.subarray(at, at + 4));
  if (data.length < 14 || tag(0) !== 'MThd') throw new Error('Not a MIDI file.');
  const count = view.getUint16(10);
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI file: not supported.');
  const result = { ppq: division, bpm: 120, meter: [4, 4], markers: [], tracks: [] };
  let at = 8 + view.getUint32(4);
  for (let t = 0; t < count && at + 8 <= data.length; t++) {
    if (tag(at) !== 'MTrk') throw new Error('Corrupted MIDI file.');
    const end = at + 8 + view.getUint32(at + 4);
    let p = at + 8,
      tick = 0,
      status = 0;
    const open = new Map();
    const tr = { name: '', channel: null, program: 0, drums: false, notes: [] };
    const readVlq = () => {
      let v = 0,
        b;
      do {
        b = data[p++];
        v = (v << 7) | (b & 0x7f);
      } while (b & 0x80 && p < end);
      return v;
    };
    while (p < end) {
      tick += readVlq();
      let s = data[p];
      if (s & 0x80) p++;
      else s = status;
      if (s === 0xff) {
        const type = data[p++];
        const len = readVlq();
        const body = data.subarray(p, p + len);
        p += len;
        const words = new TextDecoder().decode(body);
        if (type === 0x03 && !tr.name) tr.name = words;
        if (type === 0x06) result.markers.push({ tick, text: words });
        if (type === 0x51 && len === 3 && result.bpm === 120 && tick === 0)
          result.bpm = Math.round(60000000 / ((body[0] << 16) | (body[1] << 8) | body[2]));
        if (type === 0x58 && len >= 2 && tick === 0) result.meter = [body[0], 2 ** body[1]];
        continue;
      }
      if (s === 0xf0 || s === 0xf7) {
        p += readVlq();
        continue;
      }
      status = s;
      const kind = s & 0xf0,
        channel = s & 15;
      const a = data[p++],
        b = kind === 0xc0 || kind === 0xd0 ? 0 : data[p++];
      if (kind === 0xc0) tr.program = a;
      if (kind === 0x90 && b > 0) {
        tr.channel ??= channel;
        if (channel === 9) tr.drums = true;
        open.set(channel * 128 + a, { tick, velocity: b });
      } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
        const started = open.get(channel * 128 + a);
        if (started) {
          open.delete(channel * 128 + a);
          if (tick > started.tick)
            tr.notes.push({ tick: started.tick, end: tick, midi: a, velocity: started.velocity });
        }
      }
    }
    tr.notes.sort((x, y) => x.tick - y.tick || y.midi - x.midi);
    if (tr.notes.length) result.tracks.push(tr);
    at = end;
  }
  if (!result.tracks.length) throw new Error('The MIDI file contains no notes.');
  return result;
}

/* ---------- harmony ---------- */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const correlate = (a, b) => {
  const ma = a.reduce((s, x) => s + x, 0) / 12,
    mb = b.reduce((s, x) => s + x, 0) / 12;
  let n = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : 0;
};
/** The key (Krumhansl-Schmuckler) from a 12-bin pitch-class weight: 'Em', 'Bb'… */
export function guessKey(weights) {
  let best = { score: -2, name: 'C' };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = i => weights[(i + tonic) % 12];
    const w = Array.from({ length: 12 }, (_, i) => rotated(i));
    const major = correlate(w, MAJOR_PROFILE),
      minor = correlate(w, MINOR_PROFILE);
    if (major > best.score) best = { score: major, name: MAJOR_KEYS[tonic] };
    if (minor > best.score) best = { score: minor, name: MINOR_KEYS[tonic] };
  }
  return best.name;
}
const CHORD_SHAPES = [
  ['', [0, 4, 7]],
  ['m', [0, 3, 7]],
  ['7', [0, 4, 7, 10]],
  ['maj7', [0, 4, 7, 11]],
  ['m7', [0, 3, 7, 10]],
  ['dim', [0, 3, 6]],
  ['sus4', [0, 5, 7]],
];
/** The chord that best explains a bar's pitch-class weights (bass = lowest pitch class, favoured as root), or null when silent. */
export function guessChord(weights, bass, flats) {
  const total = weights.reduce((s, x) => s + x, 0);
  if (!total) return null;
  const names = flats
    ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
    : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  let best = { score: -Infinity, name: null };
  for (let root = 0; root < 12; root++)
    for (const [suffix, shape] of CHORD_SHAPES) {
      const tones = new Set(shape.map(i => (root + i) % 12));
      let inside = 0;
      for (let pc = 0; pc < 12; pc++) if (tones.has(pc)) inside += weights[pc];
      // explained weight, minus what is left out, minus a little for bigger chords; the bass on the root helps
      const score =
        inside -
        (total - inside) * 1.2 -
        shape.length * 0.04 * total +
        (bass === root ? 0.15 * total : 0) +
        (weights[root] ? 0.05 * total : 0);
      if (score > best.score) best = { score, name: names[root] + suffix };
    }
  return best.name;
}

/* ---------- MIDI -> plan ---------- */
/**
 * A YuE2 plan from a MIDI file.
 * @param midi   readMidi(...) result
 * @param options { vocal: track index (the melody to sing), instrument: track index or -1, lyrics: to cut the parts like the text, bars: max bars }
 */
export function midiToPlan(midi, { vocal = 0, instrument = -1, lyrics = '', maxBars = 200 } = {}) {
  const [num, den] = midi.meter;
  const barUnits = Math.round((num * 16) / den);
  if (!barUnits || barUnits > 48) throw new Error('MIDI file meter not supported.');
  const unit = midi.ppq / 4;
  const snap = tick => Math.round(tick / unit);
  const voiceTrack = midi.tracks[vocal];
  if (!voiceTrack) throw new Error('Choose the voice track.');
  // the voice: one note at a time, the highest, on the 1/16 grid
  const voice = [];
  for (const n of voiceTrack.notes) {
    const start = snap(n.tick),
      end = Math.max(start + 1, snap(n.end));
    const last = voice.at(-1);
    if (last && start < last.end) {
      if (start === last.start) {
        if (n.midi > last.midi) Object.assign(last, { midi: n.midi });
        continue;
      }
      last.end = start;
    }
    voice.push({ start, end, midi: n.midi });
  }
  // the instrument: notes starting together become one stack, each held until the next onset
  const insTrack = instrument >= 0 ? midi.tracks[instrument] : null;
  const ins = [];
  if (insTrack) {
    const groups = new Map();
    for (const n of insTrack.notes) {
      const start = snap(n.tick);
      const g = groups.get(start) || { start, end: start + 1, midis: [] };
      g.end = Math.max(g.end, snap(n.end));
      if (!g.midis.includes(n.midi)) g.midis.push(n.midi);
      groups.set(start, g);
    }
    const ordered = [...groups.values()].sort((a, b) => a.start - b.start);
    ordered.forEach((g, i) => {
      g.end = Math.min(g.end, ordered[i + 1]?.start ?? g.end);
      if (g.end > g.start) ins.push({ ...g, midis: g.midis.sort((a, b) => a - b).slice(-4) });
    });
  }
  const lastUnit = Math.max(...voice.map(n => n.end), ...ins.map(n => n.end), 1);
  const bars = Math.min(maxBars, Math.ceil(lastUnit / barUnits));
  // key and chords from every pitched track
  const keyWeights = Array(12).fill(0);
  const barWeights = Array.from({ length: bars }, () => Array(12).fill(0));
  const barBass = Array(bars).fill(null);
  for (const t of midi.tracks) {
    if (t.drums) continue;
    for (const n of t.notes) {
      const start = snap(n.tick),
        end = Math.max(start + 1, snap(n.end));
      keyWeights[n.midi % 12] += end - start;
      for (let b = Math.floor(start / barUnits); b < Math.min(bars, Math.ceil(end / barUnits)); b++) {
        const overlap = Math.min(end, (b + 1) * barUnits) - Math.max(start, b * barUnits);
        if (overlap <= 0) continue;
        barWeights[b][n.midi % 12] += overlap;
        if (t !== voiceTrack && (barBass[b] === null || n.midi < barBass[b].midi))
          barBass[b] = { midi: n.midi };
      }
    }
  }
  const key = guessKey(keyWeights);
  const flats = /b/.test(key) || ['F', 'Dm', 'Gm', 'Cm', 'Fm'].includes(key);
  const chords = barWeights.map((w, b) => guessChord(w, barBass[b] ? barBass[b].midi % 12 : null, flats));
  // the notes of one bar as items, notes crossing the bar line split and tied
  const barItems = (events, b, make) => {
    const from = b * barUnits,
      to = from + barUnits;
    const items = [];
    let cursor = from;
    for (const e of events) {
      if (e.end <= from || e.start >= to) continue;
      const start = Math.max(e.start, from),
        end = Math.min(e.end, to);
      if (start > cursor) items.push({ kind: 'rest', units: start - cursor });
      if (end > Math.max(start, cursor))
        items.push({ ...make(e), units: end - Math.max(start, cursor), tie: e.end > to });
      cursor = Math.max(cursor, end);
    }
    if (cursor < to) items.push({ kind: 'rest', units: to - cursor });
    return items;
  };
  // parts: the MIDI markers, else the lyrics' tags with their lengths (as the chord bed does), else blocks of 8 bars
  const known = [
    'intro',
    'verse',
    'pre-chorus',
    'chorus',
    'bridge',
    'outro',
    'interlude',
    'solo',
    'instrumental',
  ];
  let parts = midi.markers
    .map(m => ({
      bar: Math.floor(snap(m.tick) / barUnits),
      name: m.text.toLowerCase().replace(/[^a-z-]/g, ''),
    }))
    .filter(m => known.includes(m.name) && m.bar < bars);
  if (!parts.length && lyrics.trim()) {
    let bar = 0;
    parts = [];
    for (const s of lyricSectionLines(lyrics)) {
      if (bar >= bars) break;
      parts.push({ bar, name: s.label });
      bar += s.lines ? Math.min(16, Math.max(1, Math.ceil((s.lines * 2) / 4)) * 4) : 4;
    }
  }
  if (!parts.length) for (let bar = 0; bar < bars; bar += 8) parts.push({ bar, name: 'verse' });
  if (parts[0].bar !== 0) parts.unshift({ bar: 0, name: 'intro' });
  let abc = `X:1\nT:\nM:${num}/${den}\nL:1/16\nQ:1/4=${midi.bpm}\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:${key}\n`;
  parts.forEach((part, i) => {
    const end = Math.min(bars, parts[i + 1]?.bar ?? bars);
    if (end <= part.bar) return;
    abc += `% ${part.name}\n`;
    for (let row = part.bar; row < end; row += 4) {
      const rowBars = Array.from({ length: Math.min(4, end - row) }, (_, k) => row + k);
      const vocalBars = rowBars.map(b => {
        const items = barItems(voice, b, e => ({ kind: 'note', midi: e.midi }));
        return writeBar(chords[b] ? [{ kind: 'label', text: chords[b] }, ...items] : items, key);
      });
      const insBars = rowBars.map(b =>
        insTrack
          ? writeBar(
              barItems(ins, b, e =>
                e.midis.length === 1 ? { kind: 'note', midi: e.midis[0] } : { kind: 'stack', midis: e.midis }
              ),
              key
            )
          : `z${barUnits}`
      );
      abc += `V: Vocal\n${vocalBars.join('|')}|\nV: Ins\n${insBars.join('|')}|\n`;
    }
  });
  return { abc, key, bpm: midi.bpm, bars, chords: chords.filter(Boolean) };
}
