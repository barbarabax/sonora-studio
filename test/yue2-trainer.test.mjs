// @codedna
// description: YuE2 trainer transfer, completion, and cancellation with a fake RunPod worker.
// exports: none
// used_by: none
// rules: Fake RunPod only; no GPU or network work.
// agent: Codex | OpenAI | 2026-10-15 | Verify a partial upload receipt and cancellation before submission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createYue2Trainer } from '../yue2-trainer.mjs';

const until = async check => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('YuE2 trainer did not reach the expected state');
};

test('resumes a partial upload receipt, trains once and registers the adapter', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-trainer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const projectId = randomUUID(),
    trackId = randomUUID();
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1024, 7);
  const project = {
    id: projectId,
    name: 'Voce prova',
    tracks: [
      {
        id: trackId,
        name: 'Esempio',
        ext: '.wav',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        caption: 'Voce solista morbida',
        lyrics: 'Ciao',
        instrumental: false,
      },
    ],
  };
  const folder = path.join(dataDir, 'trainer', projectId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, trackId + '.wav'), bytes);
  const offsets = [],
    submissions = [],
    trained = [];
  let received = 0;
  const trainer = createYue2Trainer({
    dataDir,
    projects: () => [project],
    trackFile: () => path.join(folder, trackId + '.wav'),
    onTrained: value => trained.push(value),
    runpod: {
      async call(input) {
        offsets.push(input.offset);
        assert.equal(input.sha256, project.tracks[0].sha256);
        assert.equal(input.offset, received);
        const chunk = Buffer.from(input.base64, 'base64');
        received += offsets.length === 1 ? Math.floor(chunk.length / 2) : chunk.length;
        received = Math.min(received, bytes.length);
        return { offset: received };
      },
      async submitAction(input) {
        submissions.push(input);
        return { endpointId: 'fake', id: 'remote-training-1' };
      },
      async status() {
        return { status: 'COMPLETED', output: { adapterId: submissions[0].adapterId, step: 100 } };
      },
    },
  });
  const run = trainer.start(projectId, { preset: 'fast', name: 'La mia voce' });
  await until(() => run.status === 'training');
  assert.deepEqual(offsets, [0, 2 * 1024 * 1024]);
  assert.equal(submissions.length, 1);
  await trainer.poll();
  assert.equal(run.status, 'done');
  assert.equal(trained[0].id, run.adapterId);
  assert.equal(trainer.trained()[0].step, 100);
});

test('cancelling during upload never submits a GPU training job', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-cancel-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const projectId = randomUUID(),
    trackId = randomUUID();
  const bytes = Buffer.alloc(1024, 4);
  const project = {
    id: projectId,
    name: 'Prova',
    tracks: [
      {
        id: trackId,
        name: 'Uno',
        ext: '.wav',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        caption: 'Piano acustico',
        lyrics: '',
        instrumental: true,
      },
    ],
  };
  const folder = path.join(dataDir, 'trainer', projectId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, trackId + '.wav'), bytes);
  let release, entered;
  const called = new Promise(resolve => (entered = resolve));
  const trainer = createYue2Trainer({
    dataDir,
    projects: () => [project],
    trackFile: () => path.join(folder, trackId + '.wav'),
    runpod: {
      call: () => {
        entered();
        return new Promise(resolve => (release = () => resolve({ offset: bytes.length })));
      },
      submitAction: () => assert.fail('cancelled upload submitted training'),
    },
  });
  const run = trainer.start(projectId);
  await called;
  await trainer.cancel(run.id);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(run.status, 'cancelled');
  assert.equal(trainer.active(), false);
});
