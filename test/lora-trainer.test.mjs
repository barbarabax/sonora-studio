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
  assert.throws(() => trainer.start(p.id, { epochs: 1 }), /The dataset is locked/);
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
  await assert.rejects(trainer.upload(p.id, req), /Upload WAV, MP3, FLAC,/);
  assert.equal(trainer.snapshot().projects[0].tracks.length, 0);
  assert.throws(() => trainer.lora(p.id), /LoRA not completed yet\./);
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
  const rejected = assert.rejects(pending, /No training sent/);
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
  assert.throws(() => recovered.start(p.id, { epochs: 1 }), /The dataset is locked/);
});

test('trainer copies annotated audio between projects and removes only dataset membership', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, remote: {}, probe: async () => 18, cpu: task => task() };
  let trainer = createLoraTrainer(options);
  const source = trainer.create({ name: 'Anni 80' }).projects[0];
  const req = Readable.from([Buffer.alloc(2048, 7)]);
  req.headers = { 'x-audio-name': 'song.mp3' };
  await trainer.upload(source.id, req);
  const original = source.tracks[0];
  trainer.annotate(source.id, original.id, {
    caption: 'Synth pop anni ottanta',
    lyrics: 'Parole cantate',
    instrumental: false,
  });
  const target = trainer.create({ name: 'Anni 80 nuova prova' }).projects[0];
  trainer.importTracks(target.id, { sourceProjectId: source.id, trackIds: [original.id] });
  const copy = target.tracks[0];
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.caption, original.caption);
  assert.equal(copy.lyrics, original.lyrics);
  assert.equal(copy.sha256, original.sha256);
  const originalFile = path.join(dataDir, 'trainer', source.id, original.id + original.ext);
  const copyFile = path.join(dataDir, 'trainer', target.id, copy.id + copy.ext);
  assert.deepEqual(fs.readFileSync(copyFile), fs.readFileSync(originalFile));
  trainer.annotate(target.id, copy.id, { caption: 'Synth pop aggiornato', lyrics: '', instrumental: true });
  assert.equal(original.caption, 'Synth pop anni ottanta');
  trainer.removeTrack(source.id, original.id);
  assert.equal(source.tracks.length, 0);
  assert.equal(target.tracks.length, 1);
  assert.equal(fs.existsSync(originalFile), true);
  assert.equal(fs.existsSync(copyFile), true);
  trainer = createLoraTrainer(options);
  assert.equal(
    trainer.snapshot().projects.find(p => p.id === target.id).tracks[0].caption,
    'Synth pop aggiornato'
  );
  assert.equal(trainer.snapshot().projects.find(p => p.id === source.id).tracks.length, 0);
});

test('trainer rejects invalid or locked imports without changing datasets', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const trainer = createLoraTrainer({ dataDir, remote: {}, probe: async () => 10, cpu: task => task() });
  const source = trainer.create({ name: 'Source' }).projects[0];
  const target = trainer.create({ name: 'Target' }).projects[0];
  const req = Readable.from([Buffer.alloc(1024)]);
  req.headers = { 'x-audio-name': 'sample.wav' };
  await trainer.upload(source.id, req);
  const id = source.tracks[0].id;
  assert.throws(
    () => trainer.importTracks(target.id, { sourceProjectId: source.id, trackIds: [id, id] }),
    /Select at least one/
  );
  assert.throws(
    () => trainer.importTracks(target.id, { sourceProjectId: source.id, trackIds: ['missing'] }),
    /A track is no/
  );
  assert.equal(target.tracks.length, 0);
  target.job = { status: 'running' };
  assert.throws(
    () => trainer.importTracks(target.id, { sourceProjectId: source.id, trackIds: [id] }),
    /The dataset is locked/
  );
  assert.throws(() => trainer.removeTrack(target.id, id), /The dataset is locked/);
  assert.equal(target.tracks.length, 0);
});
