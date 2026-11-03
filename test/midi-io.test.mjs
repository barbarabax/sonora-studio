// @codedna
// description: MIDI <-> YuE2 plan: a plan survives a round trip through a .mid, key and chords are guessed, clicks find their note.
// exports: none
// used_by: none
// rules:   Pure functions only; plans are real YuE2/SheetSage2 scores from the fixtures.
// agent:   claude-opus-5-5 - 2026-10-15 - Created with public/midi-io.mjs and locateNote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planToMidi, readMidi, midiToPlan, guessKey, guessChord } from '../public/midi-io.mjs';
import { parseScore } from '../public/abc-play.mjs';
import { parsePlan } from '../public/abc-plan.mjs';
import { locateNote, readPart } from '../public/abc-edit.mjs';
import { writeBed } from '../public/chord-bed.mjs';

const plan = fs.readFileSync(new URL('./fixtures/yue2-plan-dm.abc', import.meta.url), 'utf8');
const voiceAt = score =>
  score.voices[0].notes.map(n => `${(n.start * score.secondsPerUnit).toFixed(2)}:${n.midi}`);

test('a plan saved as MIDI and read back keeps the sung melody, tempo, meter and parts', () => {
  const bytes = planToMidi(plan);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'MThd');
  const midi = readMidi(bytes);
  assert.equal(midi.bpm, 78);
  assert.deepEqual(midi.meter, [2, 4]);
  assert.deepEqual(
    midi.tracks.map(t => t.name),
    ['Vocal', 'Instrument 1', 'Chords']
  );
  assert.deepEqual(
    midi.markers.map(m => m.text),
    parseScore(plan).sections.map(s => s.name)
  );
  const back = midiToPlan(midi, { vocal: 0, instrument: 1 });
  assert.deepEqual(voiceAt(parseScore(back.abc)), voiceAt(parseScore(plan)));
  assert.equal(Math.round(parseScore(back.abc).seconds), Math.round(parseScore(plan).seconds));
  assert.deepEqual(
    parseScore(back.abc).sections.map(s => s.name),
    parseScore(plan).sections.map(s => s.name)
  );
  assert.ok(parsePlan(back.abc).slots.length > 0, 'chords are guessed into chord boxes');
});

test('a chord bed through MIDI gives its chords back', () => {
  const bed = writeBed({ bpm: 100, key: 'G', lyrics: '[Verse]\na\nb\n[Chorus]\nc\nd', seed: 4 });
  const back = midiToPlan(readMidi(planToMidi(bed.abc)), { vocal: 0, instrument: -1 });
  assert.deepEqual(
    back.chords,
    parsePlan(bed.abc).slots.map(s => s.chord)
  );
  assert.equal(back.key, 'G');
});

test('key and chord guesses', () => {
  const cMajor = Array(12).fill(0);
  for (const [pc, w] of [
    [0, 5],
    [2, 2],
    [4, 4],
    [5, 2],
    [7, 5],
    [9, 2],
    [11, 2],
  ])
    cMajor[pc] = w;
  assert.equal(guessKey(cMajor), 'C');
  const aMinor = Array(12).fill(0);
  for (const [pc, w] of [
    [9, 6],
    [0, 4],
    [4, 5],
    [2, 2],
    [11, 2],
    [5, 2],
    [7, 1],
  ])
    aMinor[pc] = w;
  assert.equal(guessKey(aMinor), 'Am');
  const triad = (pcs, w = 4) => Array.from({ length: 12 }, (_, i) => (pcs.includes(i) ? w : 0));
  assert.equal(guessChord(triad([7, 11, 2]), 7, false), 'G');
  assert.equal(guessChord(triad([9, 0, 4]), 9, false), 'Am');
  assert.equal(guessChord(triad([10, 2, 5]), 10, true), 'Bb');
  assert.equal(guessChord(Array(12).fill(0), null, false), null);
  assert.throws(() => readMidi(new Uint8Array([1, 2, 3])), /MIDI/);
});

test('a click on the drawn score finds its note', () => {
  const text = plan.replace(/\r\n/g, '\n');
  const sections = parseScore(text).sections.length;
  let checked = 0;
  for (let section = 0; section < sections; section++) {
    const part = readPart(text, section);
    for (const voice of part.voices)
      for (const bar of voice.bars) {
        if (!bar.items) continue;
        bar.items.forEach((item, i) => {
          if (item.kind === 'label') return;
          // the character where this item starts, found again from the whole text
          const at = findItem(text, section, voice.name, bar.index, i);
          assert.deepEqual(locateNote(text, at), { section, voice: voice.name, bar: bar.index, item: i });
          checked++;
        });
      }
  }
  assert.ok(checked > 40, String(checked));
  assert.equal(locateNote(text, 0), null, 'the header is not a note');
});

// the absolute offset of item i of a bar, by scanning the music lines the same way a reader would
function findItem(text, section, voice, barIndex, itemIndex) {
  const lines = text.split('\n');
  let offset = 0,
    s = -1,
    v = null,
    inBody = false;
  const counters = new Map();
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    if (!inBody) {
      if (/^K:/.test(line)) inBody = true;
      continue;
    }
    if (/^%/.test(line)) {
      s++;
      continue;
    }
    const vm = /^V:\s*(\S+)/.exec(line);
    if (vm) {
      v = vm[1];
      continue;
    }
    if (!line.trim()) continue;
    if (s < 0) s = 0;
    let barStart = 0;
    for (const raw of line.split('|')) {
      const key = `${s}|${v}`;
      const counter = counters.get(key) || 1;
      const bare = raw.replace(/"[^"]*"/g, '').trim();
      const multi = /^[ZX](\d*)$/.exec(bare);
      const count = multi ? Number(multi[1] || 1) : bare ? 1 : 0;
      if (s === section && v === voice && counter === barIndex && count === 1 && !multi) {
        const part = readPart(text, section);
        const item = part.voices.find(x => x.name === voice).bars.find(b => b.index === barIndex).items[
          itemIndex
        ];
        return start + barStart + item.at;
      }
      counters.set(key, counter + count);
      barStart += raw.length + 1;
    }
  }
  throw new Error('not found');
}
