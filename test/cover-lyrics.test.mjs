// @codedna
// description: Cover lyric alignment preserves sung words and flags surplus blocks while counting vocal note attacks.
// exports: none
// used_by: none
// agent:   Codex | OpenAI | 2026-10-15 | Regression checks for silent sections, repeated sections and conservative alignment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coverSectionFit, alignCoverLyrics } from '../public/cover-lyrics.mjs';

const PLAN = [
  'X:1',
  'M:4/4',
  'L:1/8',
  'Q:1/4=100',
  'V: Vocal',
  'V: Ins',
  'K:C',
  '% intro',
  'V: Vocal',
  'Z1|',
  'V: Ins',
  'C8|',
  '% verse',
  'V: Vocal',
  'C2D2E4|',
  'V: Ins',
  'C8|',
  '% chorus',
  'V: Vocal',
  'G4-G4|',
  'V: Ins',
  'C8|',
  '% verse',
  'V: Vocal',
  'A2B2c4|',
  'V: Ins',
  'C8|',
  '% outro',
  'V: Vocal',
  'Z1|',
  'V: Ins',
  'C8|',
].join('\n');

test('cover alignment inserts silent tags, preserves every lyric line and counts vocal attacks', () => {
  const lyrics = '[Verse]\nCiao bella\n\n[Chorus]\nResta qui\n\n[Verse]\nPer sempre';
  const fit = coverSectionFit(PLAN, lyrics);
  assert.deepEqual(
    fit.sections.map(section => [section.name, section.notes]),
    [
      ['intro', 0],
      ['verse', 3],
      ['chorus', 1],
      ['verse', 3],
      ['outro', 0],
    ]
  );
  assert.deepEqual(
    fit.sections.map(section => section.syllables),
    [0, 3, 3, 3, 0]
  );
  assert.equal(
    alignCoverLyrics(PLAN, lyrics),
    '[intro]\n\n[verse]\nCiao bella\n\n[chorus]\nResta qui\n\n[verse]\nPer sempre\n\n[outro]'
  );
});

test('surplus sung blocks are reported instead of dropped', () => {
  assert.throws(
    () => alignCoverLyrics(PLAN, '[Verse]\nUno\n[Verse]\nDue\n[Verse]\nTre\n[Verse]\nQuattro'),
    /The lyrics have 1/
  );
});
