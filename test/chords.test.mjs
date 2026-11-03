// @codedna
// description: The plan as notes and sound, the chord vocabulary and the classic progressions of the YuE2 interface.
// exports: none
// used_by: none
// rules:   Pure functions only; no audio device is needed.
// agent:   claude-sonnet-5-5 - 2026-10-11 - Piano roll parser, chord voicings, progressions in any key, applying a progression to a plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseScore, chordMidis } from '../public/abc-play.mjs';
import {
  QUALITIES,
  PRESETS,
  keyInfo,
  progressionChords,
  applyProgression,
  composeChord,
} from '../public/chord-presets.mjs';
import { parsePlan, setChords, isChord } from '../public/abc-plan.mjs';

const PLAN = fs.readFileSync(new URL('./fixtures/yue2-plan.abc', import.meta.url), 'utf8');

test('the real plan becomes timed notes in the right key, with chords and sections', () => {
  const score = parseScore(PLAN);
  assert.equal(score.bpm, 88);
  assert.equal(score.barUnits, 16);
  assert.ok(Math.abs(score.secondsPerUnit - 60 / 88 / 4) < 1e-9, 'a 1/16 unit is a quarter of a beat');
  // 4:08 song, the plan is about the same length
  assert.ok(score.seconds > 240 && score.seconds < 260, String(score.seconds));
  const [vocal, instrument] = score.voices;
  assert.equal(vocal.name, 'Vocal');
  assert.equal(instrument.name, 'Ins');
  // the instrument starts after one bar of rest (Z): D below middle C, three units long
  assert.deepEqual(instrument.notes[0], { start: 16, dur: 3, midi: 50 });
  assert.deepEqual(instrument.notes[1], { start: 19, dur: 3, midi: 57 });
  // the key signature of D makes the singer's F an F sharp (66)
  assert.equal(vocal.notes[0].midi, 66);
  assert.equal(vocal.notes[0].start, 144, 'the singer enters after the intro');
  assert.equal(score.chords.length, 93);
  assert.deepEqual(score.chords[0], { start: 12, symbol: 'D', dur: 4 });
  assert.deepEqual(score.sections.map(s => s.name).slice(0, 3), ['intro', 'verse', 'chorus']);
});

test('ties join notes, accidentals last until the bar line, and rests move time', () => {
  const abc = [
    'X:1',
    'M:4/4',
    'L:1/8',
    'Q:1/4=120',
    'V: Vocal',
    'K:C',
    'V: Vocal',
    'C2-C2 ^F2 F2|F2 =F2 z2 [CEG]2|Z|C|',
  ].join('\n');
  const score = parseScore(abc);
  const notes = score.voices[0].notes;
  assert.deepEqual(notes[0], { start: 0, dur: 4, midi: 60 }, 'C2-C2 is one note of four units');
  assert.equal(notes[1].midi, 66, '^F is F sharp');
  assert.equal(notes[2].midi, 66, 'the sharp holds for the rest of the bar');
  assert.equal(notes[3].midi, 65, 'a new bar forgets the sharp: F natural');
});

test('chord voicings cover sevenths, diminished, half-diminished, sus, sixths, ninths and slash chords', () => {
  const pcs = symbol =>
    chordMidis(symbol)
      .notes.map(n => n % 12)
      .sort((a, b) => a - b);
  assert.deepEqual(pcs('C'), [0, 4, 7]);
  assert.deepEqual(pcs('Cm'), [0, 3, 7]);
  assert.deepEqual(pcs('C7'), [0, 4, 7, 10]);
  assert.deepEqual(pcs('Cmaj7'), [0, 4, 7, 11]);
  assert.deepEqual(pcs('Cm7'), [0, 3, 7, 10]);
  assert.deepEqual(pcs('Cm7b5'), [0, 3, 6, 10]);
  assert.deepEqual(pcs('Cdim'), [0, 3, 6]);
  assert.deepEqual(pcs('Cdim7'), [0, 3, 6, 9]);
  assert.deepEqual(pcs('Caug'), [0, 4, 8]);
  assert.deepEqual(pcs('Csus2'), [0, 2, 7]);
  assert.deepEqual(pcs('Csus4'), [0, 5, 7]);
  assert.deepEqual(pcs('C7sus4'), [0, 5, 7, 10]);
  assert.deepEqual(pcs('C6'), [0, 4, 7, 9]);
  assert.deepEqual(pcs('Cm6'), [0, 3, 7, 9]);
  assert.deepEqual(pcs('C9'), [0, 2, 4, 7, 10]);
  assert.deepEqual(pcs('Cmaj9'), [0, 2, 4, 7, 11]);
  assert.deepEqual(pcs('Cadd9'), [0, 2, 4, 7]);
  assert.deepEqual(pcs('C5'), [0, 7]);
  assert.equal(chordMidis('G/B').bass % 12, 11, 'the bass of a slash chord');
  assert.equal(chordMidis('H'), null);
  // every quality offered by the picker is a valid chord and has a voicing
  for (const q of QUALITIES) {
    const chord = composeChord('Eb', q.symbol);
    assert.ok(chord && isChord(chord) && chordMidis(chord), chord);
  }
});

test('progressions follow the key, with flats for flat keys and minor degrees in a minor key', () => {
  assert.deepEqual(progressionChords('D', ['I', 'V', 'vi', 'IV']), ['D', 'A', 'Bm', 'G']);
  assert.deepEqual(progressionChords('C', ['ii7', 'V7', 'Imaj7']), ['Dm7', 'G7', 'Cmaj7']);
  assert.deepEqual(progressionChords('Bb', ['I', 'IV', 'V']), ['Bb', 'Eb', 'F']);
  assert.deepEqual(progressionChords('Bm', ['i', 'bVI', 'bIII', 'bVII']), ['Bm', 'G', 'D', 'A']);
  assert.deepEqual(progressionChords('Am', ['i', 'bVII', 'bVI', 'V']), ['Am', 'G', 'F', 'E']);
  assert.deepEqual(progressionChords('Dm', ['i', 'iv', 'v']), ['Dm', 'Gm', 'Am']);
  assert.equal(progressionChords('F', ['IV']).join(), 'Bb');
  assert.deepEqual(keyInfo('F#m'), { tonic: 6, minor: true, flats: false });
  assert.equal(keyInfo('Eb').flats, true);
  // every preset is valid in major and minor keys
  for (const preset of PRESETS)
    for (const key of ['C', 'D', 'Bb', 'Am', 'F#m']) {
      const chords = progressionChords(key, preset.degrees);
      assert.equal(chords.length, preset.degrees.length, preset.name);
      assert.ok(chords.every(isChord), `${preset.name} in ${key}: ${chords}`);
    }
  assert.ok(PRESETS.length >= 20 && new Set(PRESETS.map(p => p.genre)).size >= 8);
});

test('applying a progression rewrites only chord symbols, per section or for the whole song', () => {
  const before = parsePlan(PLAN);
  const whole = applyProgression(PLAN, { degrees: ['I', 'V', 'vi', 'IV'], section: null, barsPerChord: 1 });
  const after = parsePlan(whole);
  assert.equal(after.slots.length, before.slots.length);
  // the first bars of the first sung section now follow D A Bm G
  const verse = after.sections.find(s => s.name === 'verse');
  const bars = [...new Set(verse.slots.map(s => s.bar))];
  assert.deepEqual(
    bars.slice(0, 4).map(b => verse.slots.find(s => s.bar === b).chord),
    ['D', 'A', 'Bm', 'G']
  );
  // notes, header and layout are untouched: removing every quoted chord leaves identical text
  const strip = text => text.replace(/"[A-G][^"]*"/g, '"?"');
  assert.equal(strip(whole), strip(PLAN.replace(/\r\n/g, '\n')));
  // one section only: the other sections keep their chords
  const chorusOnly = parsePlan(
    applyProgression(PLAN, { degrees: ['vi', 'IV', 'I', 'V'], section: 'chorus', barsPerChord: 2 })
  );
  const chorus = chorusOnly.sections.find(s => s.name === 'chorus');
  const firstBars = [...new Set(chorus.slots.map(s => s.bar))].slice(0, 4);
  assert.deepEqual(
    firstBars.map(b => chorus.slots.find(s => s.bar === b).chord),
    ['Bm', 'Bm', 'G', 'G']
  );
  assert.deepEqual(
    chorusOnly.slots.filter(s => s.section === 'verse').map(s => s.chord),
    before.slots.filter(s => s.section === 'verse').map(s => s.chord)
  );
  assert.throws(
    () => applyProgression(PLAN, { degrees: ['I'], section: 'nonexistent' }),
    /No chord to change/
  );
  assert.throws(() => setChords(PLAN, new Map([[0, 'H9']])), /Invalid chord: H9/);
});
