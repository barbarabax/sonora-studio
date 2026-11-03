// @codedna
// description: Structure edits of the YuE2 plan: shorter intro, tempo, text parts, and an instrument that follows the chords in every key.
// exports: none
// used_by: none
// rules:   Pure functions only; no audio device is needed.
// agent:   claude-sonnet-5-5 - 2026-10-12 - Trim a section (also multi-bar rests), tempo, slices, and the instrument in bass / arpeggio / chord style for every chord quality.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  sectionStats,
  trimSection,
  setTempo,
  sectionSlices,
  revoiceInstrument,
} from '../public/abc-edit.mjs';
import { parseScore, chordMidis } from '../public/abc-play.mjs';
import { parsePlan } from '../public/abc-plan.mjs';
import { QUALITIES, composeChord } from '../public/chord-presets.mjs';

const PLAN = fs
  .readFileSync(new URL('./fixtures/yue2-plan.abc', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const pc = midi => ((midi % 12) + 12) % 12;

test('sections are counted in bars and seconds', () => {
  const stats = sectionStats(PLAN);
  assert.deepEqual(
    stats.slice(0, 3).map(s => [s.name, s.bars]),
    [
      ['intro', 9],
      ['verse', 16],
      ['chorus', 6],
    ]
  );
  assert.ok(Math.abs(stats[0].seconds - 9 * 16 * (60 / 88 / 4)) < 1e-6);
});

test('a long intro is cut to the bars asked for and nothing else changes', () => {
  const before = parseScore(PLAN);
  const after = trimSection(PLAN, 0, 2);
  assert.equal(sectionStats(after)[0].bars, 2);
  assert.equal(parseScore(after).length, before.length - 7 * 16);
  assert.equal(parsePlan(after).slots.length, parsePlan(PLAN).slots.length - 7);
  // from the first verse on, the text is identical
  const tail = text => text.slice(text.indexOf('% verse'));
  assert.equal(tail(after), tail(PLAN));
  assert.ok(!/V: \w+\n(V:|%)/.test(after), 'no empty voice lines are left behind');
  // asking for more bars than there are, or the same, changes nothing
  assert.equal(trimSection(PLAN, 0, 9), PLAN);
  assert.equal(trimSection(PLAN, 0, 20), PLAN);
});

test('a multi-bar rest is shortened, not removed', () => {
  const abc = [
    'X:1',
    'M:4/4',
    'L:1/8',
    'Q:1/4=100',
    'V: Vocal',
    'V: Ins',
    'K:C',
    '% intro',
    'V: Vocal',
    'Z4|"C"c8|',
    'V: Ins',
    'Z4|C8|',
  ].join('\n');
  const out = trimSection(abc, 0, 3);
  assert.deepEqual(
    sectionStats(out).map(s => s.bars),
    [3]
  );
  assert.match(out, /Z2\|/);
  assert.equal(parseScore(out).length, parseScore(abc).length - 16);
  assert.equal(sectionStats(trimSection(abc, 0, 1))[0].bars, 1);
});

test('tempo is changed in the Q: line only', () => {
  const out = setTempo(PLAN, 120);
  assert.match(out, /^Q:1\/4=120$/m);
  assert.equal(out.replace(/^Q:.*$/m, ''), PLAN.replace(/^Q:.*$/m, ''));
  assert.throws(() => setTempo(PLAN, 10), /The tempo must be/);
  assert.match(setTempo('X:1\nM:4/4\nL:1/16\nK:C\nc4|', 90), /Q:1\/4=90\nK:C/);
});

test('the text splits in parts that join back to the original', () => {
  const slices = sectionSlices(PLAN);
  assert.equal(slices[0].name, '');
  assert.deepEqual(
    slices.slice(1, 4).map(s => s.name),
    ['intro', 'verse', 'chorus']
  );
  assert.equal(slices.map(s => PLAN.slice(s.start, s.end)).join(''), PLAN);
  assert.ok(PLAN.slice(slices[1].start, slices[1].end).startsWith('% intro'));
});

const ins = score => score.voices.find(v => v.name === 'Ins');
const bars = score => new Set(score.voices[1].notes.map(n => Math.floor(n.start / score.barUnits)));

test('the instrument follows the chords and stays silent where it was silent', () => {
  const before = parseScore(PLAN);
  for (const style of ['arpeggio', 'bass', 'chords']) {
    const out = revoiceInstrument(PLAN, { style });
    const after = parseScore(out);
    assert.deepEqual(after.voices[0].notes, before.voices[0].notes, 'the singer is untouched');
    assert.deepEqual([...bars(after)], [...bars(before)], 'the same bars have notes');
    assert.equal(after.length, before.length);
    assert.deepEqual(
      parsePlan(out).slots.map(s => s.chord),
      parsePlan(PLAN).slots.map(s => s.chord)
    );
  }
  // the first instrument bar of the intro is on D (50 = D below middle C) in the bass style
  const bass = parseScore(revoiceInstrument(PLAN, { style: 'bass' }));
  assert.equal(bass.voices[1].notes[0].midi, 50);
  // only one section
  const verses = revoiceInstrument(PLAN, { style: 'bass', section: 'verse' });
  assert.equal(verses.slice(0, verses.indexOf('% verse')), PLAN.slice(0, PLAN.indexOf('% verse')));
  assert.throws(() => revoiceInstrument(PLAN, { section: 'nowhere' }), /No instrument bar/);
  assert.throws(() => revoiceInstrument('X:1\nM:4/4\nL:1/16\nV: Vocal\nK:C\n"C"c16|', {}), /only one voice/);
});

test('changed chords give a changed instrument', () => {
  const abc = [
    'X:1',
    'M:4/4',
    'L:1/16',
    'Q:1/4=100',
    'V: Vocal',
    'V: Ins',
    'K:C',
    '% verse',
    'V: Vocal',
    '"C"z16|"G"z16|"Am"z16|"F"z16|',
    'V: Ins',
    'C,16|C,16|C,16|C,16|',
  ].join('\n');
  const out = revoiceInstrument(abc, { style: 'bass' });
  const roots = ins(parseScore(out))
    .notes.filter((n, i, all) => i === 0 || Math.floor(n.start / 16) !== Math.floor(all[i - 1].start / 16))
    .map(n => pc(n.midi));
  assert.deepEqual(roots, [0, 7, 9, 5]);
});

test('every chord quality is written with the right notes in sharp, flat and plain keys', () => {
  for (const key of ['C', 'D', 'Bb', 'F#m', 'Eb']) {
    for (const q of QUALITIES) {
      for (const root of ['C', 'F#', 'Bb', 'E']) {
        const chord = composeChord(root, q.symbol);
        const tones = new Set(chordMidis(chord).notes.map(pc));
        const rootPc = pc(chordMidis(chord).bass);
        const abc = [
          'X:1',
          'M:4/4',
          'L:1/16',
          'Q:1/4=100',
          'V: Vocal',
          'V: Ins',
          `K:${key}`,
          '% verse',
          'V: Vocal',
          `"${chord}"z16|`,
          'V: Ins',
          'c16|',
        ].join('\n');
        const set = style =>
          new Set(ins(parseScore(revoiceInstrument(abc, { style }))).notes.map(n => pc(n.midi)));
        const label = `${chord} in ${key}`;
        assert.deepEqual(
          [...set('chords')].sort((a, b) => a - b),
          [...tones].sort((a, b) => a - b),
          `chords ${label}`
        );
        assert.ok(
          [...set('arpeggio')].every(n => tones.has(n)),
          `arpeggio ${label}`
        );
        assert.ok(
          [...set('bass')].every(n => n === rootPc || n === (rootPc + 7) % 12),
          `bass ${label}`
        );
      }
    }
  }
});
