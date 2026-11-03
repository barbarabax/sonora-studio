// @codedna
// description: The plan read bar by bar and edited note by note: readable names, pitch, rest, split and merge, always keeping the bar's length.
// exports: none
// used_by: none
// rules:   Pure functions only; no audio device is needed.
// agent:   claude-sonnet-5-5 - 2026-10-12 - Bar view of a real plan in D minor (M:2/4, L:1/32): key signature, naturals, ties, multi-bar rests, round trip of every bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  readPart,
  editBar,
  changeItems,
  noteName,
  durationLabel,
  sectionStats,
} from '../public/abc-edit.mjs';
import { parseScore } from '../public/abc-play.mjs';

const PLAN = fs
  .readFileSync(new URL('./fixtures/yue2-plan-dm.abc', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const units = items => items.reduce((sum, item) => sum + (item.units || 0), 0);

test('a bar is read as notes with note names, in the key of the plan', () => {
  const intro = readPart(PLAN, 0);
  assert.deepEqual([intro.barUnits, intro.beatUnits, intro.total], [16, 8, 4]);
  assert.deepEqual(
    intro.voices.map(v => v.role),
    ['Vocal', 'Instrument']
  );
  const [vocal, ins] = intro.voices;
  assert.deepEqual(
    vocal.bars[0].items.map(({ at, ...rest }) => rest),
    [
      { kind: 'label', text: 'D' },
      { kind: 'rest', units: 16 },
    ]
  );
  assert.deepEqual(
    ins.bars[0].items.map(i => i.midi),
    [50, 54, 57, 62]
  );
  assert.deepEqual(
    ins.bars[0].items.map(i => noteName(i.midi, i.midi === 54)),
    ['D3', 'G♭3', 'A3', 'D4']
  );
  // the second pair of bars uses =B, : B natural in D minor (which has a B flat)
  assert.equal(ins.bars[2].items[1].midi, 59);
  assert.equal(noteName(60), 'C4');
  assert.equal(durationLabel(8, 8), '1 beat');
  assert.equal(durationLabel(4, 8), '½ beat');
  assert.equal(durationLabel(16, 8), '2 beats');
});

test('a multi-bar rest is one silent block and keeps the bar numbers right', () => {
  const verse = readPart(PLAN, 1);
  const ins = verse.voices[1];
  assert.deepEqual(
    ins.bars.map(b => [b.index, b.span, b.silent]),
    [
      [1, 1, false],
      [2, 3, true],
      [5, 4, true],
    ]
  );
  assert.equal(verse.total, 8);
  assert.equal(ins.bars[1].items, null);
  // ties and accidentals in the bridge
  const bridge = readPart(PLAN, 3);
  assert.deepEqual(
    bridge.voices[0].bars[0].items.map(i => [i.kind, i.midi, i.tie]),
    [
      ['label', undefined, undefined],
      ['note', 73, true],
    ]
  );
});

test('every bar written back unchanged sounds exactly the same', () => {
  const before = parseScore(PLAN);
  let text = PLAN;
  const count = sectionStats(PLAN).length;
  for (let section = 0; section < count; section++) {
    for (const voice of readPart(text, section).voices)
      for (const bar of voice.bars)
        if (bar.items) text = editBar(text, section, voice.name, bar.index, bar.items);
  }
  const after = parseScore(text);
  assert.deepEqual(after.voices, before.voices);
  assert.equal(after.length, before.length);
});

test('changing a pitch rewrites that bar only, a rest becomes a note and back', () => {
  const part = readPart(PLAN, 0);
  const bar = part.voices[1].bars[0];
  const higher = changeItems(bar.items, 1, 'pitch', 56);
  const text = editBar(PLAN, 0, 'Ins', 1, higher);
  assert.deepEqual(
    parseScore(text)
      .voices[1].notes.slice(0, 4)
      .map(n => n.midi),
    [50, 56, 57, 62]
  );
  assert.equal(parseScore(text).length, parseScore(PLAN).length);
  assert.equal(text.split('\n').length, PLAN.split('\n').length);
  // a rest in the vocal bar becomes a note, and its length is kept
  const vocal = part.voices[0].bars[0];
  const sung = changeItems(vocal.items, 1, 'pitch', 62);
  assert.deepEqual(sung[1], { kind: 'note', midi: 62, units: 16, tie: false });
  assert.equal(units(sung), 16);
  const silent = changeItems(sung, 1, 'rest');
  assert.deepEqual(silent[1], { kind: 'rest', units: 16 });
  assert.throws(() => changeItems(vocal.items, 0, 'pitch', 62), /Choose a note or/);
  assert.throws(() => changeItems(bar.items, 1, 'pitch', 3), /Note outside the keyboard\./);
});

test('split and merge keep the length of the bar; a chord change in the way stops a merge', () => {
  const bar = readPart(PLAN, 0).voices[1].bars[0];
  const split = changeItems(bar.items, 0, 'split');
  assert.equal(split.length, 5);
  assert.deepEqual(
    split.slice(0, 2).map(i => [i.units, i.tie]),
    [
      [2, true],
      [2, false],
    ]
  );
  assert.equal(units(split), 16);
  const text = editBar(PLAN, 0, 'Ins', 1, split);
  const notes = parseScore(text).voices[1].notes;
  assert.deepEqual(notes[0], { start: 0, dur: 4, midi: 50 }, 'the tie joins the two halves into one note');
  const merged = changeItems(split, 0, 'merge');
  assert.deepEqual(merged, bar.items);
  // vocal bar 1 of the verse: "D" z8 A4 d4 -> merge the rest with the next note
  const verse = readPart(PLAN, 1).voices[0].bars[0].items;
  assert.equal(units(changeItems(verse, 1, 'merge')), 16);
  const labelled = [
    { kind: 'note', midi: 60, units: 8, tie: false },
    { kind: 'label', text: 'G' },
    { kind: 'note', midi: 62, units: 8, tie: false },
  ];
  assert.throws(() => changeItems(labelled, 0, 'merge'), /I cannot merge: there/);
  assert.throws(() => changeItems([{ kind: 'rest', units: 16 }], 0, 'merge'), /no other note after this one/);
  assert.throws(
    () => changeItems([{ kind: 'note', midi: 60, units: 0.5, tie: false }], 0, 'split'),
    /already very short/
  );
});

test('notes written back use the key signature: sharps, flats and naturals', () => {
  const abc = [
    'X:1',
    'M:4/4',
    'L:1/16',
    'Q:1/4=100',
    'V: Vocal',
    'V: Ins',
    'K:D',
    '% verse',
    'V: Vocal',
    '"D"c16|',
    'V: Ins',
    'D,16|',
  ].join('\n');
  const bar = readPart(abc, 0).voices[1].bars[0];
  const scale = [62, 66, 67, 70, 71].map(midi => ({ kind: 'note', midi, units: 3, tie: false }));
  const text = editBar(abc, 0, 'Ins', 1, [...scale, { kind: 'rest', units: 1 }]);
  assert.deepEqual(
    parseScore(text).voices[1].notes.map(n => n.midi),
    [62, 66, 67, 70, 71]
  );
  assert.equal(bar.items[0].midi, 50);
  assert.throws(() => editBar(abc, 0, 'Ins', 7, scale), /Bar not found/);
});
