// @codedna
// description: Edits the structure of a YuE2 ABC plan for people who do not read ABC: shorten a section, set the tempo, make the instrument follow the chords, split the text in parts.
//
// exports: INSTRUMENT_STYLES | sectionStats | trimSection | setTempo | sectionSlices | revoiceInstrument | noteName | durationLabel | readPart | editBar | changeItems | transposeScore | locateNote | writeBar
// used_by: public/cover-lyrics.mjs
//                   public/midi-io.mjs
//                   public/yue2-ui.mjs
// rules:   Pure functions, no DOM; every function returns a new string and throws an Italian Error when the plan cannot be edited safely. Bars are counted per voice and per section; a multi-bar rest (Z4) counts as 4 bars. The singer is the FIRST voice, the instrument is the next one. revoiceInstrument only replaces instrument bars that contain notes: silent bars (z, Z) stay silent, the singer is never touched. Notes are written with explicit accidentals against the key signature, so the plan sounds the same in any key.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-12 | s_20261012_yue2 | Created after the user found the intro too long, the instrument repeating the first chords, and the ABC text unreadable.
import { parseScore, chordMidis, keyAccidentals } from './abc-play.mjs';
import { isChord } from './abc-plan.mjs';
import { keyInfo } from './chord-presets.mjs';

export const INSTRUMENT_STYLES = [
  { id: 'arpeggio', label: 'Arpeggio (chord notes one after another)' },
  { id: 'bass', label: 'Bass (low note of the chord)' },
  { id: 'chords', label: 'Full chords (hits on the beat)' },
];

const normalize = abc =>
  String(abc || '')
    .split(String.fromCharCode(13, 10))
    .join(String.fromCharCode(10));

/** The bars of one music line: [{ start, end, sepEnd, text, count }]. count = bars it lasts (Z4 = 4, empty = 0). */
function splitBars(line) {
  const segments = [];
  const make = (start, end, sepEnd) => {
    const text = line.slice(start, end);
    const bare = text.replace(/"[^"]*"/g, '').trim();
    const multi = /^[ZX](\d*)$/.exec(bare);
    segments.push({
      start,
      end,
      sepEnd,
      text,
      bare,
      multi: !!multi,
      count: multi ? Number(multi[1] || 1) : bare ? 1 : 0,
    });
  };
  let start = 0,
    i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      const close = line.indexOf('"', i + 1);
      i = close < 0 ? line.length : close + 1;
      continue;
    }
    if (c === '|' || (c === '[' && line[i + 1] === '|') || (c === ':' && line[i + 1] === '|')) {
      let j = i + 1;
      while (j < line.length && '|]:'.includes(line[j])) j++;
      make(start, i, j);
      start = i = j;
      continue;
    }
    i++;
  }
  if (line.slice(start).trim()) make(start, line.length, line.length);
  return segments;
}

/** Read the plan line by line: header values, the voices, the sections and the bars of every music line. */
function scan(abc) {
  const text = normalize(abc);
  const rows = text.split('\n').map(raw => ({ raw, kind: 'other' }));
  const head = {};
  const sections = [];
  const voices = [];
  let inBody = false,
    voice = null,
    section = -1;
  for (const row of rows) {
    const line = row.raw;
    if (!inBody) {
      const h = /^([A-Za-z]):\s*(.*)$/.exec(line);
      if (!h) continue;
      row.kind = 'head';
      if (h[1] === 'V') {
        const name = /^(\S+)/.exec(h[2])?.[1];
        if (name && !voices.includes(name)) voices.push(name);
      } else head[h[1]] = h[2].trim();
      if (h[1] === 'K') {
        inBody = true;
        voice = voices[0] || null;
      }
      continue;
    }
    const comment = /^%\s*(.+)$/.exec(line);
    if (comment) {
      sections.push({ name: comment[1].trim() });
      section = sections.length - 1;
      row.kind = 'comment';
      continue;
    }
    const v = /^V:\s*(\S+)/.exec(line);
    if (v) {
      voice = v[1];
      if (!voices.includes(voice)) voices.push(voice);
      row.kind = 'voice';
      continue;
    }
    if (!line.trim() || /^[A-Za-z]:/.test(line)) continue;
    if (section < 0) {
      sections.push({ name: 'intro' });
      section = 0;
    }
    row.kind = 'music';
    row.voice = voice;
    row.section = section;
    row.bars = splitBars(line);
  }
  return { rows, head, sections, voices, text };
}

const barsOf = (rows, section, voice) =>
  rows
    .filter(row => row.kind === 'music' && row.section === section && row.voice === voice)
    .flatMap(row => row.bars.map(bar => ({ row, bar })));
const total = list => list.reduce((sum, { bar }) => sum + bar.count, 0);

function render(rows) {
  return rows
    .filter(row => !row.deleted)
    .map(row => {
      if (!row.edits?.length) return row.raw;
      let line = row.raw;
      for (const edit of [...row.edits].sort((a, b) => b.start - a.start))
        line = line.slice(0, edit.start) + edit.text + line.slice(edit.end);
      return line;
    })
    .join('\n');
}
const edit = (row, start, end, text) => (row.edits ||= []).push({ start, end, text });
function dropEmptyRows(rows) {
  for (const row of rows) {
    if (row.kind !== 'music' || !row.edits?.length) continue;
    let line = row.raw;
    for (const e of [...row.edits].sort((a, b) => b.start - a.start))
      line = line.slice(0, e.start) + e.text + line.slice(e.end);
    if (!line.replace(/[|\s\]:[]/g, '')) row.deleted = true;
  }
  // a "V:" line left with no music after it (before the next V:, "%" line or the end) is dropped too
  const live = rows.filter(row => !row.deleted);
  live.forEach((row, index) => {
    if (row.kind === 'voice' && !['music'].includes(live[index + 1]?.kind)) row.deleted = true;
  });
}

/** Every section with its name, number of bars and length in seconds: [{ index, name, bars, seconds }]. */
export function sectionStats(abc) {
  const { rows, sections, voices } = scan(abc);
  const score = parseScore(abc);
  const barSeconds = score.barUnits * score.secondsPerUnit;
  return sections.map((section, index) => {
    const bars = Math.max(0, ...voices.map(name => total(barsOf(rows, index, name))));
    return { index, name: section.name, bars, seconds: bars * barSeconds };
  });
}

/** Cut a section down to `keep` bars by removing its first bars in every voice (a long intro becomes short). */
export function trimSection(abc, sectionIndex, keep) {
  const { rows, sections, voices } = scan(abc);
  if (!sections[sectionIndex]) throw new Error('Part of the song not found.');
  keep = Math.max(1, Math.floor(Number(keep)));
  const bars = Math.max(0, ...voices.map(name => total(barsOf(rows, sectionIndex, name))));
  if (bars <= keep) return normalize(abc);
  for (const name of voices) {
    let remaining = bars - keep;
    for (const { row, bar } of barsOf(rows, sectionIndex, name)) {
      if (remaining <= 0) break;
      if (!bar.count) continue;
      if (bar.count <= remaining) {
        edit(row, bar.start, bar.sepEnd, '');
        remaining -= bar.count;
      } else {
        edit(row, bar.start, bar.end, 'Z' + (bar.count - remaining > 1 ? bar.count - remaining : ''));
        remaining = 0;
      }
    }
  }
  dropEmptyRows(rows);
  return render(rows);
}

/** Change the speed (BPM) of the plan. */
export function setTempo(abc, bpm) {
  bpm = Math.round(Number(bpm));
  if (!(bpm >= 40 && bpm <= 220)) throw new Error('The tempo must be between 40 and 220 BPM.');
  const text = normalize(abc);
  if (/^Q:.*=\s*\d+/m.test(text)) return text.replace(/^(Q:.*?=)\s*\d+/m, `$1${bpm}`);
  if (!/^K:/m.test(text)) throw new Error('The plan is missing the key line (K:).');
  return text.replace(/^K:/m, `Q:1/4=${bpm}\nK:`);
}

/** The text split at every "% section" line: [{ name, start, end }]; the first part (name '') holds the settings. */
export function sectionSlices(abc) {
  const text = normalize(abc);
  const slices = [{ name: '', start: 0, end: text.length }];
  let offset = 0,
    inBody = false;
  for (const line of text.split('\n')) {
    if (inBody) {
      const comment = /^%\s*(.+)$/.exec(line);
      if (comment) {
        slices[slices.length - 1].end = offset;
        slices.push({ name: comment[1].trim(), start: offset, end: text.length });
      }
    } else if (/^K:/.test(line)) inBody = true;
    offset += line.length + 1;
  }
  return slices;
}

/* ---------- the instrument follows the chords ---------- */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const lowest = (pc, floor) => floor + ((((pc - floor) % 12) + 12) % 12);
const dur = n => (n === 1 ? '' : String(n));

/** Writes MIDI notes for one bar: explicit accidentals whenever they differ from what the key and the bar already say. */
function noteWriter(flats, keyAcc) {
  const memory = {};
  return midi => {
    const name = (flats ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12];
    const letter = name[0];
    const acc = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
    const natural = midi - acc;
    const octave = Math.floor(natural / 12) - 1;
    const id = letter + octave;
    const implied = id in memory ? memory[id] : (keyAcc[letter] ?? 0);
    const mark = implied === acc ? '' : acc === 1 ? '^' : acc === -1 ? '_' : '=';
    memory[id] = acc;
    let out = mark + (octave >= 5 ? letter.toLowerCase() : letter);
    if (octave >= 5) out += "'".repeat(octave - 5);
    else out += ','.repeat(Math.max(0, 4 - octave));
    return out;
  };
}

/** The chord as pitch classes: root, bass and the intervals above the root, or null. */
function chordTones(symbol) {
  const voicing = chordMidis(symbol);
  const match = /^([A-G])([#b]?)/.exec(symbol);
  if (!voicing || !match) return null;
  const letters = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const rootPc = (letters[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
  const intervals = [...new Set(voicing.notes.map(n => ((((n % 12) - rootPc) % 12) + 12) % 12))].sort(
    (a, b) => a - b
  );
  return {
    rootPc,
    bassPc: ((voicing.bass % 12) + 12) % 12,
    intervals,
    flats: match[2] === 'b' ? true : match[2] === '#' ? false : null,
  };
}

/** One bar of the instrument for a chord, in the given style; the notes fill the bar exactly. */
function instrumentBar(style, tones, { beats, beat, flats, keyAcc }) {
  const write = noteWriter(flats, keyAcc);
  if (style === 'chords') {
    const base = lowest(tones.rootPc, 48);
    const chord = `[${tones.intervals.map(iv => write(base + iv)).join('')}]${dur(beat)}`;
    return chord.repeat(beats);
  }
  if (style === 'bass') {
    const r = lowest(tones.bassPc, 43);
    const parts =
      beats >= 4
        ? [
            [r, beat * (beats - 2)],
            [r + 7, beat],
            [r, beat],
          ]
        : beats === 3
          ? [
              [r, beat * 2],
              [r + 7, beat],
            ]
          : beats === 2
            ? [
                [r, beat],
                [r + 7, beat],
              ]
            : [[r, beat * beats]];
    return parts.map(([midi, units]) => write(midi) + dur(units)).join('');
  }
  const base = lowest(tones.rootPc, 45);
  const per = beat % 2 === 0 ? 2 : 1;
  const step = beat / per;
  const pattern = [0, 1, 2, 3, 2, 1, 2, 1];
  const n = tones.intervals.length;
  let out = '';
  for (let i = 0; i < beats * per; i++) {
    const idx = pattern[i % pattern.length];
    out += write(base + tones.intervals[idx % n] + 12 * Math.floor(idx / n)) + dur(step);
  }
  return out;
}

/**
 * Rewrite the instrument bars that have notes so they follow the chords of the singer, in the given style
 * ('arpeggio' | 'bass' | 'chords'). `section` is a section name, or null for the whole song.
 */
export function revoiceInstrument(abc, { style = 'arpeggio', section = null } = {}) {
  if (!INSTRUMENT_STYLES.some(s => s.id === style)) throw new Error('Invalid instrument style.');
  const { rows, head, sections, voices } = scan(abc);
  const [singer, instrument] = voices;
  if (!instrument) throw new Error('The plan has only one voice: there is no instrument to rewrite.');
  const meter = /^(\d+)\s*\/\s*(\d+)/.exec(head.M || '4/4');
  const unit = /^1\s*\/\s*(\d+)/.exec(head.L || '1/8');
  if (!meter || !unit || Number(unit[1]) % Number(meter[2]))
    throw new Error('This plan has a meter I cannot rewrite: edit the notes by hand.');
  const beats = Number(meter[1]);
  const beat = Number(unit[1]) / Number(meter[2]);
  const info = keyInfo(head.K || 'C');
  const keyAcc = keyAccidentals(head.K || 'C');
  let carry = null;
  let changed = 0;
  sections.forEach((part, index) => {
    // the chord of every bar of the section, from the singer
    const chordByBar = [];
    for (const { bar } of barsOf(rows, index, singer)) {
      const found = [...bar.text.matchAll(/"([^"]*)"/g)].map(m => m[1]).find(isChord);
      if (found) carry = found;
      for (let n = 0; n < bar.count; n++) chordByBar.push(bar.multi ? null : (found ?? carry));
    }
    if (section !== null && part.name !== section) return;
    let bar = 0;
    for (const { row, bar: segment } of barsOf(rows, index, instrument)) {
      if (!segment.multi && segment.count === 1 && /[A-Ga-g]/.test(segment.bare)) {
        const symbol = chordByBar[bar] ?? [...chordByBar].reverse().find(Boolean) ?? carry;
        const tones = symbol && chordTones(symbol);
        if (tones) {
          const flats = tones.flats ?? info.flats;
          edit(row, segment.start, segment.end, instrumentBar(style, tones, { beats, beat, flats, keyAcc }));
          changed++;
        }
      }
      bar += segment.count;
    }
  });
  if (!changed) throw new Error('No instrument bar to rewrite in this part.');
  return render(rows);
}

/* ---------- note by note, bar by bar ---------- */
const IT_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const IT_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL = { '^^': 2, __: -2, '^': 1, _: -1, '=': 0 };

/** "F♯4": the name of a MIDI note (60 = C4, the middle C). */
export const noteName = (midi, flats = false) =>
  `${(flats ? IT_FLAT : IT_SHARP)[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/** A length in plain words: `units` of L: and the beat (a quarter note) in units of L:. */
export function durationLabel(units, beatUnits) {
  const beats = units / beatUnits;
  const names = {
    0.125: '⅛ beat',
    0.25: '¼ beat',
    0.375: '⅜ beat',
    0.5: '½ beat',
    0.75: '¾ beat',
    1: '1 beat',
    1.5: '1½ beats',
    2: '2 beats',
    3: '3 beats',
    4: '4 beats',
  };
  return names[beats] || `${Number(beats.toFixed(2))} beats`;
}

function readDuration(text, start) {
  let i = start,
    mult = 1;
  const digits = /^\d+/.exec(text.slice(i));
  if (digits) {
    mult = Number(digits[0]);
    i += digits[0].length;
  }
  while (text[i] === '/') {
    i++;
    const d = /^\d+/.exec(text.slice(i));
    mult /= d ? Number(d[0]) : 2;
    if (d) i += d[0].length;
  }
  return { mult, end: i };
}

/** The items of one bar: labels ("D"), notes, rests and note stacks ([CEG]); null for anything else (the bar is then shown as text only). */
function readItems(text, keyAcc) {
  const items = [];
  const memory = {};
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) return null;
      items.push({ kind: 'label', text: text.slice(i + 1, close), at: i });
      i = close + 1;
      continue;
    }
    if (c === '[') {
      const close = text.indexOf(']', i);
      if (close < 0) return null;
      const raw = text.slice(i + 1, close);
      const midis = [...raw.matchAll(/(\^\^|__|\^|_|=)?([A-Ga-g])([,']*)/g)].map(m => {
        let octave = m[2] === m[2].toLowerCase() ? 5 : 4;
        for (const mark of m[3]) octave += mark === "'" ? 1 : -1;
        const upper = m[2].toUpperCase();
        return 12 * (octave + 1) + LETTER_PC[upper] + (m[1] ? ACCIDENTAL[m[1]] : (keyAcc[upper] ?? 0));
      });
      const { mult, end } = readDuration(text, close + 1);
      const tie = text[end] === '-';
      items.push({ kind: 'stack', raw, midis, units: mult, tie, at: i });
      i = tie ? end + 1 : end;
      continue;
    }
    if (c === 'z' || c === 'x') {
      const { mult, end } = readDuration(text, i + 1);
      items.push({ kind: 'rest', units: mult, at: i });
      i = end;
      continue;
    }
    const note = /^(\^\^|__|\^|_|=)?([A-Ga-g])([,']*)/.exec(text.slice(i));
    if (!note) return null;
    let octave = note[2] === note[2].toLowerCase() ? 5 : 4;
    for (const mark of note[3]) octave += mark === "'" ? 1 : -1;
    const upper = note[2].toUpperCase();
    const id = upper + octave;
    if (note[1]) memory[id] = ACCIDENTAL[note[1]];
    const midi = 12 * (octave + 1) + LETTER_PC[upper] + (id in memory ? memory[id] : (keyAcc[upper] ?? 0));
    const { mult, end } = readDuration(text, i + note[0].length);
    const tie = text[end] === '-';
    items.push({ kind: 'note', midi, units: mult, tie, at: i });
    i = tie ? end + 1 : end;
  }
  return items;
}

const fraction = units => {
  if (Number.isInteger(units)) return units === 1 ? '' : String(units);
  for (let denominator = 2; denominator <= 64; denominator *= 2) {
    const numerator = units * denominator;
    if (Number.isInteger(numerator))
      return numerator === 1 ? `/${denominator}` : `${numerator}/${denominator}`;
  }
  throw new Error('Duration cannot be written.');
};

/** The ABC text of one bar's items, notes written against the key signature. */
function writeItems(items, { flats, keyAcc }) {
  const write = noteWriter(flats, keyAcc);
  return items
    .map(item => {
      if (item.kind === 'label') return `"${item.text}"`;
      if (item.kind === 'rest') return 'z' + fraction(item.units);
      if (item.kind === 'stack') return `[${item.raw}]${fraction(item.units)}${item.tie ? '-' : ''}`;
      return write(item.midi) + fraction(item.units) + (item.tie ? '-' : '');
    })
    .join('');
}

function headerFacts(head) {
  const meter = /^(\d+)\s*\/\s*(\d+)/.exec(head.M || '4/4');
  const unit = /^1\s*\/\s*(\d+)/.exec(head.L || '1/8');
  if (!meter || !unit) throw new Error('This plan has a meter I cannot display: edit the text.');
  const per = Number(unit[1]);
  return {
    barUnits: (Number(meter[1]) / Number(meter[2])) * per,
    beatUnits: per / 4,
    keyAcc: keyAccidentals(head.K || 'C'),
    flats: keyInfo(head.K || 'C').flats,
  };
}

/**
 * One part of the song bar by bar: { barUnits, beatUnits, flats, total, voices: [{ name, role, bars: [{ index, span, silent, items }] }] }.
 * `items` is null for a bar written in notation this view does not understand; `silent` marks a multi-bar rest (Z4).
 */
export function readPart(abc, sectionIndex) {
  const { rows, head, sections, voices } = scan(abc);
  if (!sections[sectionIndex]) throw new Error('Part of the song not found.');
  const facts = headerFacts(head);
  let total = 0;
  const result = voices.map((name, voiceIndex) => {
    let counter = 1;
    const bars = [];
    for (const { bar } of barsOf(rows, sectionIndex, name)) {
      if (!bar.count) continue;
      if (bar.multi) bars.push({ index: counter, span: bar.count, silent: true, items: null });
      else bars.push({ index: counter, span: 1, silent: false, items: readItems(bar.text, facts.keyAcc) });
      counter += bar.count;
    }
    total = Math.max(total, counter - 1);
    return { name, role: voiceIndex === 0 ? 'Vocal' : 'Instrument', bars };
  });
  return { ...facts, total, voices: result };
}

/** Rewrite bar `barIndex` of a voice in a part with new items (the bar keeps its place, nothing else changes). */
export function editBar(abc, sectionIndex, voiceName, barIndex, items) {
  const { rows, head, sections } = scan(abc);
  if (!sections[sectionIndex]) throw new Error('Part of the song not found.');
  const facts = headerFacts(head);
  let counter = 1;
  for (const { row, bar } of barsOf(rows, sectionIndex, voiceName)) {
    if (!bar.count) continue;
    if (counter === barIndex && !bar.multi) {
      edit(row, bar.start, bar.end, writeItems(items, facts));
      return render(rows);
    }
    counter += bar.count;
  }
  throw new Error('Bar not found.');
}

/**
 * One change to one bar: 'pitch' (arg = MIDI note; a rest becomes a note), 'rest', 'split' (in two halves, tied), 'merge' (with the next
 * note). The bar keeps its total length in every case. Returns the new items; throws an Italian Error when it cannot be done.
 */
export function changeItems(items, index, op, arg) {
  const next = items.map(item => ({ ...item }));
  const item = next[index];
  if (!item || item.kind === 'label') throw new Error('Choose a note or a rest.');
  if (op === 'pitch') {
    if (item.kind === 'stack')
      throw new Error('This bar has notes played together: change them in the ABC text.');
    if (!Number.isInteger(arg) || arg < 12 || arg > 108) throw new Error('Note outside the keyboard.');
    next[index] = {
      kind: 'note',
      midi: arg,
      units: item.units,
      tie: item.kind === 'note' ? item.tie : false,
    };
  } else if (op === 'rest') {
    next[index] = { kind: 'rest', units: item.units };
  } else if (op === 'split') {
    const half = item.units / 2;
    if (half < 0.5) throw new Error('I cannot split any further: the note is already very short.');
    next.splice(
      index,
      1,
      { ...item, units: half, ...(item.kind === 'rest' ? {} : { tie: true }) },
      { ...item, units: half }
    );
  } else if (op === 'merge') {
    let after = index + 1;
    while (next[after]?.kind === 'label') after++;
    if (!next[after]) throw new Error('There is no other note after this one in the bar.');
    if (after > index + 1) throw new Error('I cannot merge: there is a chord change in between.');
    next.splice(index, 2, {
      ...item,
      units: item.units + next[after].units,
      ...(item.kind === 'rest' ? {} : { tie: !!next[after].tie }),
    });
  } else throw new Error('Invalid edit.');
  return next;
}

const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/**
 * The whole plan moved by `step` semitones (-24..24): every note of every voice, the chord symbols and the key, together.
 * Rules: only major and minor keys; a bar this module cannot read, or a note that would leave MIDI 0-127, refuses the whole move.
 * After YuE2-Studio's score/transpose.rs (MIT), itself on YuE2-ComfyUI's transpose.py (Apache-2.0).
 */
export function transposeScore(abc, step) {
  if (!Number.isInteger(step) || step < -24 || step > 24)
    throw new Error('Transposition ranges from −24 to +24 semitones.');
  if (step === 0) return abc;
  const { rows, head } = scan(abc);
  const key = head.K || 'C';
  const mode = /^\s*[A-G][#b]?\s*([A-Za-z]*)/.exec(key)?.[1] || '';
  if (mode && !/^(m|min|minor|maj|major)$/i.test(mode))
    throw new Error('This plan is in a special mode: I cannot transpose it.');
  const info = keyInfo(key);
  const target = (info.minor ? MINOR_KEYS : MAJOR_KEYS)[(((info.tonic + step) % 12) + 12) % 12];
  const before = headerFacts(head);
  const after = headerFacts({ ...head, K: target });
  const names = after.flats ? FLAT_NAMES : SHARP_NAMES;
  const moveChord = symbol => {
    const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(symbol);
    if (!m) return symbol;
    const pc = (letter, acc) =>
      (((PITCH[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + step) % 12) + 12) % 12;
    return names[pc(m[1], m[2])] + m[3] + (m[4] ? '/' + names[pc(m[4], m[5])] : '');
  };
  const move = midi => {
    const moved = midi + step;
    if (moved < 0 || moved > 127)
      throw new Error('The transposition would take a note outside the possible range.');
    return moved;
  };
  for (const row of rows) {
    if (row.kind === 'head' && /^K:/.test(row.raw)) edit(row, 0, row.raw.length, `K:${target}`);
    if (row.kind !== 'music') continue;
    for (const bar of row.bars) {
      if (!bar.count) continue;
      if (bar.multi) {
        // a silent stretch (Z4) can still carry a chord symbol
        if (bar.text.includes('"'))
          edit(
            row,
            bar.start,
            bar.end,
            bar.text.replace(/"([^"]*)"/g, (all, text) => (isChord(text) ? `"${moveChord(text)}"` : all))
          );
        continue;
      }
      const items = readItems(bar.text, before.keyAcc);
      if (!items) throw new Error('A bar is written in a way I cannot transpose: change it in the ABC text.');
      const moved = items.map(item => {
        if (item.kind === 'label') return isChord(item.text) ? { ...item, text: moveChord(item.text) } : item;
        if (item.kind === 'note') return { ...item, midi: move(item.midi) };
        if (item.kind === 'stack') {
          const write = noteWriter(after.flats, after.keyAcc);
          const midis = item.midis.map(move);
          return { ...item, midis, raw: midis.map(write).join('') };
        }
        return item;
      });
      edit(row, bar.start, bar.end, writeItems(moved, after));
    }
  }
  return render(rows);
}

/**
 * Where a character of the plan is: { section, voice, bar, item } (bar counted like readPart, item = index in that bar's items), or null.
 * Rules: offsets are on the plan with 
 line ends (the text the score view renders).
 */
export function locateNote(abc, index) {
  const { rows } = scan(abc);
  let offset = 0;
  const counters = new Map();
  for (const row of rows) {
    const start = offset;
    offset += row.raw.length + 1;
    if (row.kind !== 'music') continue;
    const key = `${row.section}|${row.voice}`;
    for (const bar of row.bars) {
      const counter = counters.get(key) || 1;
      if (bar.count) counters.set(key, counter + bar.count);
      if (index < start + bar.start || index >= start + Math.max(bar.end, bar.start + 1)) continue;
      if (!bar.count || bar.multi) return null;
      const items = readItems(bar.text, headerFacts(scan(abc).head).keyAcc);
      if (!items) return null;
      const inBar = index - start - bar.start;
      let found = -1;
      items.forEach((item, i) => {
        if (item.kind !== 'label' && item.at <= inBar) found = i;
      });
      return found < 0 ? null : { section: row.section, voice: row.voice, bar: counter, item: found };
    }
  }
  return null;
}

/** One bar written as ABC from items ({ kind: note|rest|stack, midi(s), units, tie }) in a key, notes against its signature. */
export function writeBar(items, key = 'C') {
  const facts = { keyAcc: keyAccidentals(key), flats: keyInfo(key).flats };
  const write = noteWriter(facts.flats, facts.keyAcc);
  return writeItems(
    items.map(item =>
      item.kind === 'stack' && !item.raw ? { ...item, raw: item.midis.map(write).join('') } : item
    ),
    facts
  );
}
