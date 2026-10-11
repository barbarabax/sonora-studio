// @codedna
// description: Musical duration estimation and server-side canonical duration regression checks.
// exports: none
// used_by: none
// rules:   Exercise real musical examples, unsupported limits and synchronized workflow duration without GPU work.
// agent:   Codex - 2026-10-04 - Lyrics duration feature contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSongDuration, parseDuration, formatDuration } from '../public/song-duration.mjs';
import { validateInput, buildWorkflow } from '../lib.mjs';
const lines = n => Array(n).fill('La tazza aspetta qui').join('\n');
const example = [
  ['Intro', 0],
  ['Verse 1', 4],
  ['Chorus', 4],
  ['Solo Trumpet', 0],
  ['Verse 2', 4],
  ['Pre-Chorus + Chorus', 6],
  ['Bridge + Final Chorus', 6],
  ['Outro', 0],
]
  .map(([title, count]) => `[${title}]\n${lines(count)}`)
  .join('\n\n');
const options = { lyrics: example, bpm: 80, timesignature: '4' };

test('the supplied 60-bar arrangement lasts exactly 180 seconds at 80 BPM in 4/4', () => {
  const estimate = estimateSongDuration(options);
  assert.equal(estimate.valid, true);
  assert.equal(estimate.totalBars, 60);
  assert.equal(estimate.secondsPerBar, 3);
  assert.equal(estimate.seconds, 180);
  assert.deepEqual(
    estimate.sections.map(s => s.bars),
    [4, 8, 8, 4, 8, 12, 12, 4]
  );
});
test('tempo, meter and user bar corrections affect timing without counting metadata', () => {
  assert.equal(estimateSongDuration({ ...options, bpm: 160 }).seconds, 90);
  assert.equal(estimateSongDuration({ ...options, timesignature: '3' }).seconds, 135);
  const compound = estimateSongDuration({ ...options, timesignature: '6' });
  assert.equal(compound.meter, '6/8');
  assert.equal(compound.seconds, 135);
  const override = estimateSongDuration({ ...options, durationOverrides: { '2:chorus': 12 } });
  assert.equal(override.totalBars, 64);
  assert.equal(override.seconds, 192);
  assert.equal(override.sections[2].overridden, true);
  assert.equal(
    estimateSongDuration({ ...options, lyrics: '[Mood: Warm]\n[Energy: Low]\n' + example }).seconds,
    180
  );
});
test('phrase density, vocal pacing, untagged lyrics and repeated choruses are accounted for', () => {
  const dense = estimateSongDuration({ lyrics: '[Verse]\n' + 'la '.repeat(40), bpm: 80 });
  assert.equal(dense.totalBars, 3);
  const plain = estimateSongDuration({ lyrics: lines(4), bpm: 80 });
  assert.equal(plain.totalBars, 8);
  assert.equal(plain.seconds, 24);
  assert.equal(estimateSongDuration({ lyrics: lines(4), bpm: 80, lyricPacing: 'fast' }).seconds, 12);
  assert.equal(estimateSongDuration({ lyrics: lines(4), bpm: 80, lyricPacing: 'relaxed' }).seconds, 36);
  const repeated = estimateSongDuration({ lyrics: `[Chorus]\n${lines(4)}\n[Final Chorus]`, bpm: 80 });
  assert.equal(repeated.totalBars, 16);
  assert.equal(repeated.sections[1].repeated, true);
});
test('empty singing templates and invalid timing cannot produce an automatic duration', () => {
  for (const patch of [
    { lyrics: '' },
    { lyrics: '[Verse]\n[Chorus]\n[Outro]' },
    { bpm: 0 },
    { bpm: 80.5 },
    { timesignature: '7' },
    { durationOverrides: { '0:verse': 0 } },
    { durationOverrides: { '0:verse': 129 } },
  ])
    assert.equal(estimateSongDuration({ ...options, ...patch }).valid, false);
  assert.equal(
    estimateSongDuration({ lyrics: 'Ciao', bpm: 250 }).seconds,
    10,
    'minimum supported clip is 10 seconds'
  );
});
test('automatic duration is recalculated by the server, persists its rationale and reaches both ACE nodes', () => {
  const input = validateInput({
    ...options,
    tags: 'Italian jazz, trumpet, warm vocals',
    instrumental: false,
    durationMode: 'auto',
    duration: 15,
  });
  assert.equal(input.duration, 180);
  assert.equal(input.durationEstimate.totalBars, 60);
  const graph = buildWorkflow(input, 42, '00000000-0000-4000-8000-000000000001', {
    model: 'model',
    encoder: 'encoder',
    planner: 'planner',
    vae: 'vae',
  });
  assert.equal(graph['4'].inputs.duration, 180);
  assert.equal(graph['6'].inputs.seconds, 180);
  assert.equal(
    validateInput({ ...options, tags: 'jazz', instrumental: false, durationMode: 'manual', duration: 47 })
      .duration,
    47
  );
  const instrumental = validateInput({
    tags: 'piano',
    instrumental: true,
    durationMode: 'auto',
    duration: 123,
  });
  assert.equal(instrumental.durationMode, 'manual');
  assert.equal(instrumental.duration, 123);
});
test('long lyrics are reported and rejected rather than silently cut to five minutes', () => {
  const long = { ...options, lyrics: example + '\n' + example };
  assert.equal(estimateSongDuration(long).overflow, true);
  assert.throws(
    () => validateInput({ ...long, tags: 'jazz', instrumental: false, durationMode: 'auto' }),
    /exceeds the 5-minute limit/
  );
});

const shortArrangement = ['Verse', 'Chorus', 'Verse', 'Chorus', 'Bridge', 'Chorus', 'Outro']
  .map((title, i) => `[${title}]\n${lines(i === 6 ? 2 : 4)}`)
  .join('\n\n');
test('musical spacing adds intro, section transitions and a tail after a sung outro', () => {
  const base = { lyrics: shortArrangement, bpm: 110 };
  const written = estimateSongDuration(base),
    balanced = estimateSongDuration({ ...base, durationArrangement: 'balanced' }),
    spacious = estimateSongDuration({ ...base, durationArrangement: 'spacious' });
  assert.equal(written.totalBars, 52);
  assert.equal(written.seconds, 114);
  assert.equal(balanced.totalBars, 72);
  assert.equal(balanced.vocalBars, 52);
  assert.equal(balanced.instrumentalBars, 20);
  assert.equal(balanced.addedBars, 20);
  assert.equal(balanced.seconds, 158);
  assert.equal(balanced.sections.at(-1).id, 'auto:outro');
  assert.equal(spacious.totalBars, 92);
  assert.equal(spacious.seconds, 201);
  assert.equal(estimateSongDuration({ ...base, bpm: 100, durationArrangement: 'balanced' }).seconds, 173);
  assert.equal(estimateSongDuration({ ...base, bpm: 100, durationArrangement: 'spacious' }).seconds, 221);
  const manual = estimateSongDuration({
    ...base,
    durationArrangement: 'balanced',
    durationOverrides: { 'auto:intro': 0, 'auto:outro': 8, 'auto:gap:1:chorus': 0 },
  });
  assert.equal(manual.totalBars, 70);
  assert.equal(manual.sections[0].bars, 0);
  assert.equal(manual.sections.at(-1).bars, 8);
});
test('written instrumental sections are counted once and parenthetical breaks preserve subsequent lyrics', () => {
  const complete = estimateSongDuration({ ...options, durationArrangement: 'balanced' });
  assert.equal(
    complete.sections.some(s => s.id === 'auto:intro' || s.id === 'auto:outro'),
    false
  );
  assert.equal(complete.sections.filter(s => s.synthetic).length, 3);
  assert.equal(complete.addedBars, 6);
  assert.equal(complete.totalBars, 66);
  const split = estimateSongDuration({
    lyrics: `[Verse]\n${lines(2)}\n(Stacco musicale)\n${lines(2)}\n[Chorus]\n${lines(2)}`,
    bpm: 80,
    durationArrangement: 'balanced',
  });
  assert.equal(split.vocalBars, 12);
  assert.equal(split.instrumentalBars, 14);
  assert.deepEqual(
    split.sections.filter(s => !s.synthetic).map(s => [s.type, s.bars]),
    [
      ['verse', 4],
      ['instrumental', 4],
      ['verse', 4],
      ['chorus', 4],
    ]
  );
  assert.equal(split.sections.filter(s => s.id.startsWith('auto:gap:')).length, 1);
  const explicit = estimateSongDuration({
    lyrics: `[Intro]\n[Verse]\n${lines(2)}\n[Stacco]\n[Chorus]\n${lines(2)}\n[Outro]`,
    bpm: 80,
    durationArrangement: 'balanced',
  });
  assert.equal(explicit.addedBars, 0);
  assert.equal(explicit.instrumentalBars, 12);
  assert.equal(explicit.totalBars, 20);
});
test('the server honors musical spacing and corrections and sends the canonical total to both ACE nodes', () => {
  const input = validateInput({
    lyrics: shortArrangement,
    bpm: 100,
    tags: 'dream pop',
    instrumental: false,
    durationMode: 'auto',
    durationArrangement: 'balanced',
    duration: 15,
    durationOverrides: { 'auto:outro': 8 },
  });
  assert.equal(input.duration, 183);
  assert.equal(input.durationEstimate.totalBars, 76);
  assert.equal(input.durationEstimate.addedBars, 24);
  const graph = buildWorkflow(input, 42, '00000000-0000-4000-8000-000000000001', {
    model: 'model',
    encoder: 'encoder',
    planner: 'planner',
    vae: 'vae',
  });
  assert.equal(graph['4'].inputs.duration, 183);
  assert.equal(graph['6'].inputs.seconds, 183);
  assert.throws(
    () => validateInput({ ...input, durationArrangement: 'unknown' }),
    /Invalid musical spaces/
  );
  for (const patch of [
    { durationArrangement: '__proto__' },
    { timesignature: 'constructor' },
    { lyricPacing: 'toString' },
    { durationOverrides: { '0:verse': 0 } },
    { durationOverrides: { 'auto:intro': -1 } },
  ])
    assert.equal(estimateSongDuration({ ...options, ...patch }).valid, false);
});

test('a free song length accepts m:ss, seconds and single minutes within 0:10-5:00', () => {
  assert.equal(parseDuration('2:30'), 150);
  assert.equal(parseDuration(' 0:15 '), 15);
  assert.equal(parseDuration('150'), 150);
  assert.equal(parseDuration('3'), 180);
  assert.equal(parseDuration('5:00'), 300);
  for (const bad of [
    '',
    'abc',
    '5:01',
    '0:09',
    '9:99',
    '2:75',
    '301',
    '0',
    '-30',
    '1.5',
    '2:3:0',
    null,
    undefined,
  ])
    assert.equal(parseDuration(bad), null, String(bad));
  assert.equal(formatDuration(150), '2:30');
  assert.equal(formatDuration(15), '0:15');
  assert.equal(parseDuration(formatDuration(187)), 187);
});
