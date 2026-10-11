// @codedna
// description: Editor isolation, asynchronous worker lifecycle, voice replacement and native cover contracts.
// exports: none
// used_by: none
// rules:   Use fake workers and temporary audio; no GPU work or model downloads.
// agent:   Codex - 2026-10-04 - Meaningful editor integration checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createAudioEditor, validateMix } from '../audio-editor.mjs';
import { createStudio } from '../server.mjs';
import { buildWorkflow, validateInput } from '../lib.mjs';

const cfg = { model: 'model', encoder: 'encoder', planner: 'planner', vae: 'vae' };
const input = validateInput({
  title: 'Una voce',
  tags: 'jazz, singing',
  lyrics: '[Verse]\nCiao amore',
  instrumental: false,
  duration: 30,
  seed: 41,
});
const waitFor = async condition => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail('Worker did not complete');
};
const write = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(128, 42));
};
const fakeWorker = async task => {
  if (task.action === 'separate') {
    write(task.outputDir, 'vocals.flac');
    write(task.outputDir, 'instrumental.flac');
  }
  if (task.action === 'instrumental') {
    write(task.outputDir, 'vocals.flac');
    write(task.outputDir, 'instrumental.flac');
  }
  if (task.action === 'import') write(task.outputDir, 'voice.flac');
  if (task.action === 'mix') write(task.outputDir, 'mix.flac');
  return { done: true, duration: 30, frames: 1323000, rate: 44100, attenuation: 1 };
};
function library(dir) {
  const id = randomUUID(),
    job = { id, title: 'Test', input, status: 'done', assets: { flac: id + '.flac', mp3: id + '.mp3' } };
  write(path.join(dir, 'audio'), id + '.flac');
  return job;
}

test('cover graph routes the audio latent into conditioning and disables planner codes', () => {
  const ref = 'Sonora/' + randomUUID() + '.flac';
  const g = buildWorkflow({ ...input, quality: 'full' }, 41, randomUUID(), cfg, ref);
  assert.equal(g['12'].inputs.audio, ref);
  assert.equal(g['13'].class_type, 'VAEEncodeAudio');
  assert.equal(g['14'].class_type, 'ReferenceTimbreAudio');
  assert.deepEqual(g['8'].inputs.positive, ['14', 0]);
  assert.equal(g['4'].inputs.generate_audio_codes, false);
  assert.equal(g['4'].inputs.duration, g['6'].inputs.seconds);
  assert.throws(() => buildWorkflow(input, 41, randomUUID(), cfg, '../../private.flac'));
});

test('editor serializes separation, preserves originals, validates media ownership and recovers interrupted tasks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-editor-')),
    a = library(dir),
    b = library(dir),
    jobs = [a, b];
  let active = 0,
    peak = 0,
    calls = 0;
  const before = fs.readFileSync(path.join(dir, 'audio', a.assets.flac));
  const runTask = async task => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 10));
    const result = await fakeWorker(task);
    active--;
    return result;
  };
  let editor = createAudioEditor({
    root: dir,
    dataDir: dir,
    getJob: id => jobs.find(j => j.id === id),
    runTask,
  });
  t.after(() => {
    editor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await Promise.all([editor.separate(a.id), editor.separate(a.id), editor.separate(b.id)]);
  await waitFor(() => editor.snapshot().sessions.every(s => s.status === 'ready'));
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'audio', a.assets.flac)), before);
  assert.throws(() => editor.media(a.id, 'voice', '../../private'));
  assert.throws(() => editor.media(a.id, 'mix', randomUUID()));
  for (const body of [
    { voiceId: 'original', baseGain: NaN },
    { voiceId: 'original', voiceGain: 3 },
    { voiceId: 'original', offsetMs: 10001 },
    { voiceId: '../' },
  ])
    assert.throws(() => validateMix(body));
  const values = { voiceId: 'original', baseGain: 0.6, voiceGain: 1.2, offsetMs: -500 };
  editor.settings(a.id, values);
  await editor.exportMix(a.id, values);
  await waitFor(() => editor.snapshot().sessions[0].mixes.length === 1);
  assert.ok(fs.existsSync(editor.media(a.id, 'mix', editor.snapshot().sessions[0].mixes[0].id)));
  editor.close();
  const file = path.join(dir, 'editor', 'sessions.json'),
    db = JSON.parse(fs.readFileSync(file));
  db.sessions[0].status = 'processing';
  fs.writeFileSync(file, JSON.stringify(db));
  editor = createAudioEditor({ root: dir, dataDir: dir, getJob: id => jobs.find(j => j.id === id), runTask });
  assert.equal(editor.snapshot().sessions[0].status, 'failed');
  assert.equal(calls, 3, 'recovery must not relaunch interrupted work');
  assert.deepEqual(editor.snapshot().sessions[0].settings, values);
  assert.ok(fs.existsSync(editor.media(a.id, 'base')));
});

test('completed cover is separated and becomes a new voice without replacing the stored base', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cover-')),
    a = library(dir),
    cover = library(dir),
    jobs = [a, cover];
  const editor = createAudioEditor({
    root: dir,
    dataDir: dir,
    getJob: id => jobs.find(j => j.id === id),
    runTask: fakeWorker,
  });
  t.after(() => {
    editor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await editor.separate(a.id);
  await waitFor(() => editor.snapshot().sessions[0].stems);
  const base = fs.readFileSync(editor.media(a.id, 'base'));
  editor.trackCover(a.id, cover.id);
  await editor.reconcile();
  await waitFor(() => editor.snapshot().sessions[0].voices.length === 1);
  const s = editor.snapshot().sessions[0];
  assert.equal(s.pendingCoverId, null);
  assert.equal(s.voices[0].sourceJobId, cover.id);
  assert.equal(s.settings.voiceId, s.voices[0].id);
  assert.deepEqual(fs.readFileSync(editor.media(a.id, 'base')), base);
  assert.ok(fs.existsSync(editor.media(a.id, 'voice', s.settings.voiceId)));
});

test('editor HTTP serves ranges, protects uploads, exports mixes and submits a cover with canonical duration', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-editor-http-')),
    job = library(dir);
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, jobs: [job] }));
  let prompt;
  const fake = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const bytes = Buffer.concat(parts);
    const url = new URL(req.url, 'http://localhost');
    const send = value => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/system_stats') return send({});
    if (url.pathname === '/object_info')
      return send({ LoadAudio: {}, VAEEncodeAudio: {}, ReferenceTimbreAudio: {} });
    if (url.pathname.startsWith('/object_info/')) {
      const n = url.pathname.split('/').pop();
      const required =
        n === 'UNETLoader'
          ? { unet_name: [[cfg.model]] }
          : n === 'DualCLIPLoader'
            ? { clip_name1: [[cfg.encoder]], clip_name2: [[cfg.planner]] }
            : n === 'VAELoader'
              ? { vae_name: [[cfg.vae]] }
              : {};
      return send({ [n]: { input: { required } } });
    }
    if (url.pathname === '/upload/image') {
      const name = /filename="([a-f0-9-]+\.flac)"/.exec(bytes.toString())[1];
      return send({ name, subfolder: 'Sonora', type: 'input' });
    }
    if (url.pathname === '/prompt') {
      prompt = JSON.parse(bytes);
      return send({ prompt_id: prompt.prompt_id });
    }
    return send({ queue_pending: [], queue_running: [] });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const app = createStudio(
    { ...cfg, comfyUrl: `http://127.0.0.1:${fake.address().port}` },
    { dataDir: dir, pollMs: 1e8, audioTask: fakeWorker }
  );
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  await app.checkHealth();
  const base = `http://127.0.0.1:${app.server.address().port}`,
    route = `/api/editor/${job.id}`;
  t.after(async () => {
    await app.close();
    await new Promise(r => fake.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = (endpoint, method = 'GET', body, headers = {}) =>
    fetch(base + endpoint, {
      method,
      headers: { 'X-Sonora': '1', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await req(route + '/separate', 'POST', {})).status, 202);
  await waitFor(() => fs.existsSync(path.join(dir, 'editor', job.id, 'vocals.flac')));
  const range = await req(route + '/audio?kind=base', 'GET', undefined, { Range: 'bytes=2-8' });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 7);
  assert.equal(
    (await req(route + '/audio?kind=voice&id=../config')).status,
    404,
    'path traversal is never served'
  );
  const denied = await fetch(base + route + '/voice', {
    method: 'POST',
    headers: { 'X-Sonora': '1', Origin: 'https://attacker.example' },
    body: Buffer.alloc(64),
  });
  assert.equal(denied.status, 403);
  const upload = await fetch(base + route + '/voice', {
    method: 'POST',
    headers: { 'X-Sonora': '1', 'X-Audio-Name': encodeURIComponent('Voce <nuova>.wav') },
    body: Buffer.alloc(64),
  });
  assert.equal(upload.status, 202);
  await waitFor(
    () =>
      JSON.parse(fs.readFileSync(path.join(dir, 'editor', 'sessions.json'))).sessions[0].voices.length === 1
  );
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'editor', 'sessions.json'))).sessions[0];
  assert.equal(s.voices[0].label, 'Voce <nuova>.wav');
  assert.equal((await req(route + '/mix', 'POST', { ...s.settings, offsetMs: 300 })).status, 202);
  await waitFor(
    () =>
      JSON.parse(fs.readFileSync(path.join(dir, 'editor', 'sessions.json'))).sessions[0].status === 'ready'
  );
  const cover = await req(route + '/cover', 'POST', {
    tags: 'soul vocals',
    lyrics: '[Verse]\nCiao amore',
    duration: 120,
    durationMode: 'auto',
  });
  assert.equal(cover.status, 202);
  const newJob = (await cover.json()).job;
  assert.equal(newJob.parentId, job.id);
  assert.equal(newJob.input.duration, 30);
  assert.equal(newJob.kind, 'vocal-cover');
  assert.equal(prompt.prompt['4'].inputs.generate_audio_codes, false);
  assert.equal(prompt.prompt['14'].class_type, 'ReferenceTimbreAudio');
});

test('importing external song to editor allows separation, downloading separate tracks and deletion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ext-editor-'));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, jobs: [] }));
  const app = createStudio(
    { ...cfg, comfyUrl: 'http://127.0.0.1:9' },
    { dataDir: dir, pollMs: 1e8, audioTask: fakeWorker }
  );
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const uploadRes = await fetch(base + '/api/editor/import', {
    method: 'POST',
    headers: { 'X-Sonora': '1', 'X-Audio-Name': encodeURIComponent('Mio Brano.mp3') },
    body: Buffer.alloc(128, 7),
  });
  assert.equal(uploadRes.status, 202);
  const session = await uploadRes.json();
  assert.ok(session.id);
  assert.equal(session.title, 'Mio Brano');
  assert.equal(session.source.kind, 'import');

  await waitFor(() => fs.existsSync(path.join(dir, 'editor', session.id, 'original.flac')));

  const sepRes = await fetch(base + `/api/editor/${session.id}/separate`, {
    method: 'POST',
    headers: { 'X-Sonora': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(sepRes.status, 202);

  await waitFor(() => fs.existsSync(path.join(dir, 'editor', session.id, 'vocals.flac')));
  assert.ok(fs.existsSync(path.join(dir, 'editor', session.id, 'instrumental.flac')));

  const baseFlac = await fetch(base + `/api/editor/${session.id}/audio?kind=base&download=1`, {
    headers: { 'X-Sonora': '1' },
  });
  assert.equal(baseFlac.status, 200);
  assert.equal(baseFlac.headers.get('content-type'), 'audio/flac');
  assert.match(baseFlac.headers.get('content-disposition'), /Mio%20Brano-backing\.flac/);

  const voiceFlac = await fetch(base + `/api/editor/${session.id}/audio?kind=voice&download=1`, {
    headers: { 'X-Sonora': '1' },
  });
  assert.equal(voiceFlac.status, 200);
  assert.equal(voiceFlac.headers.get('content-type'), 'audio/flac');
  assert.match(voiceFlac.headers.get('content-disposition'), /Mio%20Brano-vocals\.flac/);

  const baseMp3 = await fetch(base + `/api/editor/${session.id}/audio?kind=base&format=mp3&download=1`, {
    headers: { 'X-Sonora': '1' },
  });
  assert.equal(baseMp3.status, 200);
  assert.equal(baseMp3.headers.get('content-type'), 'audio/mpeg');
  assert.match(baseMp3.headers.get('content-disposition'), /Mio%20Brano-backing\.mp3/);

  const delRes = await fetch(base + `/api/editor/${session.id}`, {
    method: 'DELETE',
    headers: { 'X-Sonora': '1' },
  });
  assert.equal(delRes.status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'editor', session.id)));
});

test('an instrumental track can skip separation: the base is ready without the separation model', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-instr-')),
    a = library(dir),
    b = library(dir),
    actions = [];
  const editor = createAudioEditor({
    root: dir,
    dataDir: dir,
    getJob: id => [a, b].find(j => j.id === id),
    runTask: async task => {
      actions.push(task.action);
      return fakeWorker(task);
    },
  });
  t.after(() => {
    editor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await editor.separate(a.id, { instrumental: true });
  await waitFor(() => editor.snapshot().sessions[0].stems);
  const s = editor.snapshot().sessions[0];
  assert.deepEqual(actions, ['instrumental']);
  assert.equal(s.instrumentalOnly, true);
  assert.ok(fs.existsSync(editor.media(a.id, 'base')));
  assert.ok(fs.existsSync(editor.media(a.id, 'voice')), 'the original voice exists (silent) so mixes keep working');
  // The normal path still runs the separator for the other track.
  await editor.separate(b.id);
  await waitFor(() => editor.snapshot().sessions.every(x => x.stems));
  assert.deepEqual(actions, ['instrumental', 'separate']);
  assert.equal(editor.snapshot().sessions.find(x => x.id === b.id).instrumentalOnly, undefined);
  // An instrumental base can be mixed with a new voice like any other session.
  const values = { voiceId: 'original', baseGain: 1, voiceGain: 1, offsetMs: 0 };
  await editor.exportMix(a.id, values);
  await waitFor(() => editor.snapshot().sessions.find(x => x.id === a.id).mixes.length === 1);
});
