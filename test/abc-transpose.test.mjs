// @codedna
// description: Transposing a whole YuE2 plan: notes of both voices, chord symbols and key move together and read back the same music.
// exports: none
// used_by: none
// rules:   Pure functions only; the fixture is a real YuE2 plan.
// agent:   claude-opus-5-5 - 2026-10-15 - Created with transposeScore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transposeScore } from '../public/abc-edit.mjs';
import { parseScore } from '../public/abc-play.mjs';
import { parsePlan } from '../public/abc-plan.mjs';

const plan = fs.readFileSync(new URL('./fixtures/yue2-plan-dm.abc', import.meta.url), 'utf8');

test('a real plan moves by any step and reads back the same music, shifted', () => {
  const notes = score => score.voices.flatMap(v => v.notes.map(n => ({ voice: v.name, ...n })));
  const base = notes(parseScore(plan));
  assert.ok(base.length > 20, String(base.length));
  for (const step of [2, -3, 5, 12, -12, 7]) {
    const moved = transposeScore(plan, step);
    const now = notes(parseScore(moved));
    assert.equal(now.length, base.length, `step ${step}`);
    now.forEach((n, i) =>
      assert.deepEqual(n, { ...base[i], midi: base[i].midi + step }, `note ${i} step ${step}`)
    );
    assert.equal(parseScore(moved).seconds, parseScore(plan).seconds);
    assert.equal(
      parsePlan(moved).slots.length,
      parsePlan(plan).slots.length,
      'every chord box is still there'
    );
    // back again gives the same notes
    assert.deepEqual(notes(parseScore(transposeScore(moved, -step))), base);
  }
});

test('key and chord names follow, with flats or sharps as the new key wants', () => {
  const up = transposeScore(plan, 2); // D minor -> E minor
  assert.match(up, /^K:Em$/m);
  assert.ok(
    parsePlan(up).slots.every(s => !s.chord.includes('b')),
    parsePlan(up)
      .slots.map(s => s.chord)
      .join(' ')
  );
  const down = transposeScore(plan, -2); // D minor -> C minor: flats
  assert.match(down, /^K:Cm$/m);
  assert.ok(parsePlan(down).slots.every(s => !s.chord.includes('#')));
  const first = parsePlan(plan).slots[0].chord;
  assert.equal(parsePlan(transposeScore(plan, 12)).slots[0].chord, first, 'an octave keeps the chord names');
  assert.equal(transposeScore(plan, 0), plan);
  assert.throws(() => transposeScore(plan, 30), /−24/);
  assert.throws(() => transposeScore(plan.replace(/^K:.*$/m, 'K:Ddor'), 2), /This plan is in/);
});
