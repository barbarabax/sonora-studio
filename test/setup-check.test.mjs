// @codedna
// description: The first-run setup checks: Node.js version, FFmpeg and the NVIDIA card, from fake programs.
// exports: none
// used_by: none
// rules:   Fake child processes only; nothing is started.
// agent:   claude-haiku-5-5 | anthropic | 2026-11-03 | Created with the setup helper for the portable build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSetupCheck } from '../setup-check.mjs';

const fake = programs => (command, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const output = programs[command];
  setImmediate(() => {
    if (output === undefined) child.emit('error', new Error('ENOENT'));
    else {
      child.stdout.emit('data', output);
      child.emit('close', 0);
    }
  });
  return child;
};

test('everything present is reported as ok, with the card and its memory', async () => {
  const check = createSetupCheck({
    nodeVersion: 'v22.5.0',
    spawnImpl: fake({
      ffmpeg: 'ffmpeg version 7.1 Copyright\nmore',
      'nvidia-smi': 'NVIDIA GeForce RTX 2060, 12288, 581.57\n',
    }),
  });
  const items = await check.system();
  assert.deepEqual(
    items.map(i => [i.id, i.status]),
    [
      ['node', 'ok'],
      ['ffmpeg', 'ok'],
      ['gpu', 'ok'],
    ]
  );
  assert.match(items[2].detail, /RTX 2060 · 12 GB · driver 581\.57/);
});

test('missing programs come with a hint', async () => {
  const check = createSetupCheck({ nodeVersion: 'v20.1.0', platform: 'win32', spawnImpl: fake({}) });
  const [node, ffmpeg, gpu] = await check.system();
  assert.equal(node.status, 'missing');
  assert.match(node.hint, /22 or newer/);
  assert.equal(ffmpeg.status, 'missing');
  assert.match(ffmpeg.hint, /winget install Gyan\.FFmpeg/);
  assert.equal(gpu.status, 'warn');
  assert.match(gpu.hint, /RunPod or Vast\.ai/);
});

test('a card with less than 12 GB is a warning, and results are cached briefly', async () => {
  let calls = 0;
  const spawnImpl = (...args) => {
    calls++;
    return fake({ ffmpeg: 'ffmpeg version 7', 'nvidia-smi': 'NVIDIA GTX, 6144, 560.1\n' })(...args);
  };
  const check = createSetupCheck({ nodeVersion: 'v24.0.0', spawnImpl });
  const items = await check.system();
  assert.equal(items[2].status, 'warn');
  assert.match(items[2].hint, /12 GB card/);
  const before = calls;
  await check.system();
  assert.equal(calls, before, 'a second request inside the cache time starts nothing');
  await check.system({ fresh: true });
  assert.ok(calls > before, 'a fresh check runs the programs again');
});
