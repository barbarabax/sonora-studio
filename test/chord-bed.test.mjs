// @codedna
// description: The chord bed: one part per lyrics tag, bars from the sung lines, no repeated neighbouring chords, readable by the plan tools.
// exports: none
// used_by: none
// rules:   Pure functions only.
// agent:   claude-opus-5-5 - 2026-10-15 - Created with public/chord-bed.mjs (cases after YuE2-Studio's chord_bed.rs tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeBed, lyricSectionLines, AUTO_MAJOR, AUTO_MINOR } from '../public/chord-bed.mjs';
import { parsePlan } from '../public/abc-plan.mjs';
import { parseScore } from '../public/abc-play.mjs';
import { PRESETS, progressionChords } from '../public/chord-presets.mjs';

const chords = abc => [...abc.matchAll(/"([^"]+)"z/g)].map(m => m[1]);

test('every lyrics part gets its bars and no chord repeats its neighbour', () => {
  const bed = writeBed({
    bpm: 96,
    key: 'Em',
    meter: '4/4',
    seed: 7,
    lyrics:
      '[Intro]\n[Verse 1]\nwalk on\nrun home\nsing loud\n[Chorus]\nhold on\nfire\n[Bridge]\nagain\n[Outro]',
  });
  assert.deepEqual(
    bed.abc.split('\n').filter(l => l.startsWith('% ')),
    ['% intro', '% verse', '% chorus', '% bridge', '% outro']
  );
  assert.equal(bed.bars, 4 + 8 + 4 + 4 + 4);
  const all = chords(bed.abc);
  assert.equal(all.length, bed.bars);
  assert.ok(
    all.every((c, i) => i === 0 || c !== all[i - 1]),
    all.join(' ')
  );
  assert.match(bed.abc, /K:Em\n/);
  assert.match(bed.abc, /M:4\/4\nL:1\/16\nQ:1\/4=96\n/);
  assert.match(bed.abc, /z16\|/);
  assert.match(bed.abc, /V: Ins\nZ4\|/);
  assert.notDeepEqual(
    bed.progressions[0],
    bed.progressions[1],
    'verse and chorus play different progressions'
  );
  // the plan tools read it: chord boxes per part, a score with the right length
  const plan = parsePlan(bed.abc);
  assert.equal(plan.slots.length, bed.bars);
  assert.equal(Math.round(parseScore(bed.abc).seconds), Math.round((bed.bars * 4 * 60) / 96));
});

test('meter, key spelling, chosen genre schemes and the same seed', () => {
  assert.match(writeBed({ bpm: 80, key: 'Bbm', meter: '3/4', lyrics: '[Verse]\nwalking down' }).abc, /z12\|/);
  assert.ok(
    chords(writeBed({ bpm: 80, key: 'Bbm', lyrics: '[Verse]\nx' }).abc).every(c => !c.includes('#')),
    'flats in B-flat minor'
  );
  const reggae = PRESETS.findIndex(p => p.genre === 'Reggae');
  const bed = writeBed({
    bpm: 76,
    key: 'A',
    lyrics: '[Verse]\na\nb\nc\nd',
    parts: [String(reggae), 'auto', 'auto'],
  });
  assert.deepEqual(bed.progressions[0], progressionChords('A', PRESETS[reggae].degrees));
  assert.deepEqual(
    chords(bed.abc),
    ['A', 'A', 'D', 'D', 'A', 'A', 'D', 'D'],
    'a two-bar scheme holds each chord for two bars'
  );
  const one = writeBed({ bpm: 100, key: 'C', lyrics: '[Verse]\nx', seed: 3 });
  assert.equal(one.abc, writeBed({ bpm: 100, key: 'C', lyrics: '[Verse]\nx', seed: 3 }).abc);
  assert.throws(() => writeBed({ bpm: 300, key: 'C' }), /tempo/);
  assert.throws(() => writeBed({ bpm: 100, key: 'H' }), /Invalid key/);
  for (const degrees of [...AUTO_MAJOR, ...AUTO_MINOR])
    assert.equal(progressionChords('C', degrees).length, degrees.length, degrees.join('-'));
});

test('lyrics without tags are a verse; unknown tags count as verses', () => {
  assert.deepEqual(lyricSectionLines('words\nmore words\n[Hook]\nyeah\n[Strange part]\n'), [
    { label: 'verse', lines: 2 },
    { label: 'chorus', lines: 1 },
    { label: 'verse', lines: 0 },
  ]);
  assert.equal(
    writeBed({ bpm: 100, key: 'C', lyrics: '' }).bars,
    16,
    'no lyrics: verse, chorus, verse, chorus'
  );
});

test('custom progressions preserve exact order, repeated chords and extended qualities', () => {
  const options = {
    bpm: 96,
    key: 'C',
    lyrics: '[Verse]\na\nb\n[Chorus]\nc\nd\n[Bridge]\ne\nf',
    custom: ['C C Cdim Caug', 'Dsus2 Gsus4 Am7 G7', 'Dm7b5 E7 Am Am'],
  };
  const first = writeBed({ ...options, seed: 1 });
  assert.deepEqual(
    chords(first.abc),
    options.custom.flatMap(s => s.split(' '))
  );
  assert.equal(
    first.abc,
    writeBed({ ...options, seed: 999 }).abc,
    'variant seeds never change fixed harmony'
  );
  assert.throws(() => writeBed({ ...options, custom: ['C nope', 'C', 'C'] }), /valid chords/);
  assert.throws(() => writeBed({ ...options, custom: ['', 'C', 'C'] }), /valid chords/);
});

test('a target length stretches the sung parts in 4-bar blocks and keeps parts without words', () => {
  const lyrics = '[Intro]\n[Verse]\na\nb\nc\nd\n[Chorus]\ne\nf\n[Verse]\ng\nh\nj\nk\n[Chorus]\ne\nf\n[Outro]';
  const natural = writeBed({ bpm: 96, key: 'C', lyrics });
  assert.ok(natural.seconds < 120, 'by default the song follows its sung lines only');
  for (const target of [150, 180, 240, 300]) {
    const bed = writeBed({ bpm: 96, key: 'C', lyrics, targetSeconds: target });
    assert.ok(Math.abs(bed.seconds - target) <= 10, `${target}: got ${bed.seconds}`);
    assert.equal(parsePlan(bed.abc).slots.length, bed.bars);
    assert.equal(Math.round(parseScore(bed.abc).seconds), bed.seconds);
    const parts = bed.abc
      .split('% ')
      .slice(1)
      .map(p => p.split('\n')[0]);
    assert.deepEqual(parts, ['intro', 'verse', 'chorus', 'verse', 'chorus', 'outro']);
    assert.match(
      bed.abc.split('% intro\n')[1],
      /^(?:V: Vocal\n(?:"[^"]+"z16\|){4}\nV: Ins\nZ4\|\n)(?=% verse)/,
      'the intro keeps its 4 bars'
    );
  }
  assert.throws(() => writeBed({ bpm: 96, key: 'C', lyrics, targetSeconds: 5 }), /0:10 and 5:00/);
  assert.throws(() => writeBed({ bpm: 96, key: 'C', lyrics, targetSeconds: 301 }), /0:10 and 5:00/);
  const long = '[Verse]\n' + Array.from({ length: 14 }, (_, i) => 'line ' + i).join('\n');
  assert.equal(
    writeBed({ bpm: 96, key: 'C', lyrics: long }).bars,
    28,
    'a long verse is no longer cut to 16 bars'
  );
});
