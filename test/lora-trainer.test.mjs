import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLoraTrainer } from '../lora-trainer.mjs';

test('trainer persists datasets, verifies private upload receipts and never resubmits recovered training', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let submitted = 0,
    input,
    done = false;
  const remote = {
    async uploadTraining(v) {
      return { offset: v.total };
    },
    async startTraining(v) {
      submitted++;
      input = v;
      return { id: 'training-12345' };
    },
    async trainingStatus() {
      return done
        ? { status: 'COMPLETED', output: { loraName: `sonora-${input.projectId}.safetensors` } }
        : { status: 'IN_PROGRESS' };
    },
  };
  const options = {
    dataDir,
    remote,
    endpointId: 'trainer-test',
    publicOrigin: 'https://sonora.test',
    model: 'xl',
    probe: async () => 10,
    cpu: task => task(),
  };
  let trainer = createLoraTrainer(options);
  const p = trainer.create({ name: 'My style' }).projects[0];
  const req = Readable.from([Buffer.alloc(1024, 2)]);
  req.headers = { 'x-audio-name': 'test.wav' };
  await trainer.upload(p.id, req);
  const track = trainer.snapshot().projects[0].tracks[0];
  trainer.annotate(p.id, track.id, { caption: 'soft piano', lyrics: '', instrumental: true });
  await trainer.start(p.id, { epochs: 1 });
  assert.equal(input.tracks[0].url, undefined);
  assert.match(input.tracks[0].sha256, /^[a-f0-9]{64}$/);
  trainer = createLoraTrainer(options);
  await trainer.poll();
  assert.equal(submitted, 1);
  assert.throws(() => trainer.start(p.id, { epochs: 1 }), /locked during training/);
  done = true;
  await trainer.poll();
  assert.equal(trainer.lora(p.id), `sonora-${p.id}.safetensors`);
});

test('trainer rejects unsupported files and missing sung lyrics before GPU submission', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const trainer = createLoraTrainer({ dataDir, remote: {}, probe: async () => 10, cpu: task => task() });
  const p = trainer.create({ name: 'Voice' }).projects[0];
  const req = Readable.from([Buffer.alloc(1024)]);
  req.headers = { 'x-audio-name': '../../unsafe.pt' };
  await assert.rejects(trainer.upload(p.id, req), /Upload a WAV/);
  assert.equal(trainer.snapshot().projects[0].tracks.length, 0);
  assert.throws(() => trainer.lora(p.id), /not ready yet/);
});

test('cancelling a queued dataset copy prevents training submission', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let rejectCopy,
    submitted = 0,
    cancelled;
  const remote = {
    uploadTraining(_input, onReceipt) {
      onReceipt('copy-12345');
      return new Promise((_resolve, reject) => {
        rejectCopy = reject;
      });
    },
    async cancel(job) {
      cancelled = job.remote.id;
      rejectCopy(new Error('cancelled'));
    },
    async startTraining() {
      submitted++;
    },
  };
  const trainer = createLoraTrainer({
    dataDir,
    remote,
    endpointId: 'trainer-test',
    probe: async () => 10,
    cpu: task => task(),
  });
  const p = trainer.create({ name: 'Cancelled copy' }).projects[0];
  const req = Readable.from([Buffer.alloc(1024)]);
  req.headers = { 'x-audio-name': 'example.wav' };
  await trainer.upload(p.id, req);
  trainer.annotate(p.id, p.tracks[0].id, { caption: 'piano', lyrics: '', instrumental: true });
  const pending = trainer.start(p.id, { epochs: 1 });
  const rejected = assert.rejects(pending, /No training was submitted/);
  await trainer.cancel(p.id);
  await rejected;
  assert.equal(cancelled, 'copy-12345');
  assert.equal(submitted, 0);
  assert.equal(p.job.status, 'cancelled');
});

test('restart unlocks interrupted dataset copies but preserves uncertain training submissions', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, remote: {}, endpointId: 'trainer-test' };
  const initial = createLoraTrainer(options),
    p = initial.create({ name: 'Recovery' }).projects[0];
  const file = path.join(dataDir, 'trainer', 'projects.json');
  p.job = { status: 'uploading', uploadRemoteId: 'copy-12345' };
  fs.writeFileSync(file, JSON.stringify([p]));
  let recovered = createLoraTrainer(options);
  assert.equal(recovered.snapshot().projects[0].job.status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(file))[0].job.status, 'failed');
  p.job = { status: 'submitting' };
  fs.writeFileSync(file, JSON.stringify([p]));
  recovered = createLoraTrainer(options);
  assert.equal(recovered.snapshot().projects[0].job.status, 'uncertain');
  assert.throws(() => recovered.start(p.id, { epochs: 1 }), /locked during training/);
});
