import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { audioSeconds, repaintWindow, spliceSection, placeSection } from '../audio-remix.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('repaint window adds context, keeps the 10 s minimum and stays inside the song', () => {
  assert.deepEqual(repaintWindow(20, 30, 100), { windowStart: 18, windowEnd: 32 });
  const short = repaintWindow(40, 43, 100);
  assert.ok(short.windowEnd - short.windowStart >= 10);
  assert.ok(short.windowStart <= 40 && short.windowEnd >= 43);
  assert.deepEqual(repaintWindow(0, 4, 100), { windowStart: 0, windowEnd: 10 });
  const end = repaintWindow(96, 100, 100);
  assert.ok(end.windowEnd === 100 && end.windowEnd - end.windowStart >= 10);
  assert.throws(() => repaintWindow(10, 10.5, 100), /at least 1 second/);
  assert.throws(() => repaintWindow(10, 120, 100), /Invalid range/);
  assert.throws(() => repaintWindow(0, 5, 8), /too short/);
});

test('splice replaces only the chosen section and keeps the song length', { skip: !hasFfmpeg }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-splice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tone = (file, hz, seconds) =>
    spawnSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${hz}:duration=${seconds}`,
      '-ac',
      '2',
      '-ar',
      '44100',
      file,
    ]);
  const original = path.join(dir, 'o.wav'),
    segment = path.join(dir, 's.wav');
  tone(original, 220, 30);
  tone(segment, 880, 14); // window 8..22
  const flacOut = path.join(dir, 'out.flac'),
    mp3Out = path.join(dir, 'out.mp3');
  await spliceSection({ original, segment, start: 10, end: 20, windowStart: 8, total: 30, flacOut, mp3Out });
  assert.ok(Math.abs((await audioSeconds(flacOut)) - 30) < 0.15);
  assert.ok(Math.abs((await audioSeconds(mp3Out)) - 30) < 0.3);
  // First and last seconds still come from the original (220 Hz), the middle from the segment (880 Hz).
  const pitch = (file, from) => {
    const r = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(from),
      '-t',
      '1',
      '-i',
      file,
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      'f32le',
      '-',
    ]);
    const data = new Float32Array(
      r.stdout.buffer.slice(
        r.stdout.byteOffset,
        r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)
      )
    );
    let crossings = 0;
    for (let i = 1; i < data.length; i++) if (data[i - 1] < 0 && data[i] >= 0) crossings++;
    return crossings;
  };
  assert.ok(Math.abs(pitch(flacOut, 2) - 220) < 6);
  assert.ok(Math.abs(pitch(flacOut, 14) - 880) < 12);
  assert.ok(Math.abs(pitch(flacOut, 25) - 220) < 6);
});

test(
  'a section instrument is placed in silence at its exact position and keeps the song length',
  { skip: !hasFfmpeg },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-place-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const segment = path.join(dir, 's.wav');
    spawnSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=12',
      '-ac',
      '2',
      '-ar',
      '44100',
      segment,
    ]);
    const flacOut = path.join(dir, 'o.flac'),
      mp3Out = path.join(dir, 'o.mp3');
    // window 8..20 of a 30 s song, instrument only between 10 and 16 s
    await placeSection({ segment, start: 10, end: 16, windowStart: 8, total: 30, flacOut, mp3Out });
    assert.ok(Math.abs((await audioSeconds(flacOut)) - 30) < 0.1);
    const level = (from, len) => {
      const r = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-ss',
        String(from),
        '-t',
        String(len),
        '-i',
        flacOut,
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        '-',
      ]);
      const data = new Float32Array(
        r.stdout.buffer.slice(
          r.stdout.byteOffset,
          r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)
        )
      );
      return Math.sqrt(data.reduce((a, b) => a + b * b, 0) / Math.max(1, data.length));
    };
    assert.ok(level(1, 2) < 0.001, 'silent before the section');
    assert.ok(level(12, 2) > 0.05, 'sound inside the section');
    assert.ok(level(20, 5) < 0.001, 'silent after the section');
  }
);
