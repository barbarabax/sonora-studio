// @codedna
// description: Audio Lab sessions, shared CPU lock, renders, recovery, AI advice validation and HTTP routes.
// exports: none
// used_by: none
// rules:   Use fake workers and a fake DeepSeek; no Python, GPU, network or credit use.
// agent:   Claude - 2026-10-04 - Audio Lab integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createAudioLab,
  createCpuLock,
  validateMastering,
  migrateSettings,
  MASTER_DEFAULTS,
} from '../audio-lab.mjs';
import { createAudioEditor } from '../audio-editor.mjs';
import { createPromptAI } from '../prompt-ai.mjs';
import { createStudio } from '../server.mjs';

const waitFor = async (condition, message = 'Condition not reached') => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(message);
};
const write = (file, bytes = Buffer.alloc(256, 7)) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const analysis = (lufs = -12) => ({
  version: 'test',
  technical: { sampleRate: 48000, duration: 30 },
  loudness: { integrated: lufs, truePeak: -0.8 },
  spectrum: { bands: {} },
  stereo: {},
  integrity: {},
  musical: null,
});
const fakeWorker = async task => {
  if (task.action === 'import' || task.action === 'render') write(task.outputFile);
  if (task.action === 'render') write(task.outputFile.replace(/.flac$/, '.mp3'));
  if (task.action === 'mp3') write(task.outputFile);
  return {
    done: true,
    analysis: analysis(task.action === 'render' ? task.settings.targetLufs : -12),
    mp3: task.action === 'render',
    loudness: task.settings
      ? {
          target: task.settings.targetLufs,
          reached: task.settings.targetLufs,
          gap: 0,
          ceiling: task.settings.ceiling,
          truePeak: task.settings.ceiling - 0.2,
          gain: 1,
          passes: 1,
        }
      : undefined,
  };
};
function library(dir) {
  const id = randomUUID(),
    job = { id, title: 'Prova', status: 'done', assets: { flac: id + '.flac', mp3: id + '.mp3' }, input: {} };
  write(path.join(dir, 'audio', id + '.flac'), Buffer.alloc(512, 3));
  return job;
}
function stream(bytes, name = 'voce.wav') {
  const req = [bytes];
  req.headers = { 'x-audio-name': encodeURIComponent(name) };
  req[Symbol.asyncIterator] = async function* () {
    yield bytes;
  };
  return req;
}

test('mastering settings are validated, rounded to engine steps and clamped only for AI proposals', () => {
  assert.deepEqual(validateMastering({}), MASTER_DEFAULTS);
  const eq = [2.26, 0, 0, 0, 0, 0, 0, 0, 0, -12];
  assert.deepEqual(validateMastering({ eq }).eq.slice(0, 1), [2.5]);
  for (const bad of [
    { eq: [13, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { eq: [0, 0] },
    { eq: 'flat' },
    { width: 2 },
    { targetLufs: -30 },
    { ceiling: 0 },
    { compressor: 'brickwall' },
    { reverb: 'cathedral' },
    { metadata: 'erase' },
    { eq: [NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    [],
  ])
    assert.throws(() => validateMastering(bad));
  const clamped = validateMastering(
    { eq: [20, 0, 0, 0, 0, 0, 0, 0, 0, -30], width: 3, targetLufs: -4, ceiling: 1 },
    { clamp: true }
  );
  assert.deepEqual(
    [clamped.eq[0], clamped.eq[9], clamped.width, clamped.targetLufs, clamped.ceiling],
    [12, -12, 1.5, -8, -0.1]
  );
  const old = migrateSettings({
    eqLow: 2,
    eqMid: -1,
    eqHigh: 3,
    compressor: 'gentle',
    reverb: 'off',
    width: 1,
    targetLufs: -14,
    ceiling: -1,
  });
  assert.deepEqual(old.eq, [2, 2, 2, -1, -1, -1, -1, 3, 3, 3]);
  assert.equal(old.compressor, 'gentle');
  assert.equal(old.metadata, 'keep');
  assert.ok(!('eqLow' in old));
  assert.throws(
    () => validateMastering({ compressor: 'brickwall' }, { clamp: true }),
    'modes are never guessed'
  );
});

test('editor and Audio Lab never run CPU tasks at the same time', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cpu-')),
    job = library(dir),
    jobs = [job],
    cpu = createCpuLock();
  let active = 0,
    peak = 0;
  const slow = worker => async (task, progress) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 15));
    active--;
    return worker(task, progress);
  };
  const editorWorker = async task => {
    write(path.join(task.outputDir, 'vocals.flac'));
    write(path.join(task.outputDir, 'instrumental.flac'));
    return { done: true, duration: 30 };
  };
  const editor = createAudioEditor({
    root: dir,
    dataDir: dir,
    getJob: id => jobs.find(j => j.id === id),
    runTask: slow(editorWorker),
    cpu,
  });
  const lab = createAudioLab({
    root: dir,
    dataDir: dir,
    getJob: id => jobs.find(j => j.id === id),
    getMix: () => null,
    cpu,
    runTask: slow(fakeWorker),
  });
  t.after(() => {
    editor.close();
    lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await editor.separate(job.id);
  const s = lab.create({ kind: 'job', jobId: job.id });
  await waitFor(
    () => editor.snapshot().sessions[0].status === 'ready' && lab.snapshot().sessions[0].status === 'ready'
  );
  assert.equal(peak, 1);
  assert.ok(s.analysis);
});

test('sessions analyse, render full previews, save masters, prune drafts and recover without relaunching', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lab-')),
    job = library(dir),
    jobs = [job],
    tasks = [];
  const runTask = async (task, progress) => {
    tasks.push(task);
    progress('Prova');
    return fakeWorker(task);
  };
  let lab = createAudioLab({
    root: dir,
    dataDir: dir,
    getJob: id => jobs.find(j => j.id === id),
    getMix: () => null,
    runTask,
  });
  t.after(() => {
    lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const original = fs.readFileSync(path.join(dir, 'audio', job.id + '.flac'));
  assert.throws(() => lab.create({ kind: 'job', jobId: '../../etc' }));
  assert.throws(() => lab.create({ kind: 'mix', jobId: job.id }));
  const s = lab.create({ kind: 'job', jobId: job.id });
  assert.equal(lab.create({ kind: 'job', jobId: job.id }).id, s.id, 'one session per source');
  await waitFor(() => s.status === 'ready');
  assert.equal(s.analysis.loudness.integrated, -12);
  assert.match(s.sourceSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(lab.preview(s.id, { targetLufs: -40 }));
  await lab.preview(s.id, { ...MASTER_DEFAULTS, targetLufs: -16 });
  assert.throws(() => lab.analyze(s.id), /Wait for this track/);
  await waitFor(() => s.renders.length === 1 && s.status === 'ready');
  const render = s.renders[0];
  assert.equal(render.loudness.reached, -16);
  assert.equal(s.settings.targetLufs, -16);
  assert.equal(tasks.at(-1).source, path.join(dir, 'audio', job.id + '.flac'));
  assert.ok(fs.existsSync(lab.media(s.id, 'render', render.id)));
  assert.ok(render.saved && render.mp3, 'every export writes FLAC and MP3');
  assert.ok(fs.existsSync(lab.media(s.id, 'render', render.id, 'mp3')));
  for (let i = 0; i < 6; i++) {
    await lab.preview(s.id, { targetLufs: -14 });
    await waitFor(() => s.status === 'ready');
  }
  assert.equal(s.renders.length, 7);
  assert.equal(fs.readdirSync(path.join(dir, 'audio-lab', s.id, 'renders')).length, 7);
  const doomed = s.renders[1];
  lab.removeRender(s.id, doomed.id);
  assert.equal(s.renders.length, 6);
  assert.ok(!fs.existsSync(path.join(dir, 'audio-lab', s.id, 'renders', doomed.id)));
  assert.throws(() => lab.removeRender(s.id, doomed.id));
  assert.ok(fs.existsSync(lab.media(s.id, 'render', render.id)), 'other masters stay');
  s.renders.push({ ...render, id: randomUUID() });
  assert.throws(() => lab.media(s.id, 'render', '../../library.json'));
  assert.throws(() => lab.media(s.id, 'reference'));
  fs.writeFileSync(path.join(dir, 'audio', job.id + '.flac'), Buffer.alloc(512, 9));
  await assert.rejects(lab.preview(s.id, {}), /changed after analysis/);
  fs.writeFileSync(path.join(dir, 'audio', job.id + '.flac'), original);
  lab.close();
  const file = path.join(dir, 'audio-lab', 'sessions.json'),
    db = JSON.parse(fs.readFileSync(file));
  db.sessions[0].status = 'processing';
  fs.writeFileSync(file, JSON.stringify(db));
  const count = tasks.length;
  lab = createAudioLab({
    root: dir,
    dataDir: dir,
    getJob: id => jobs.find(j => j.id === id),
    getMix: () => null,
    runTask,
  });
  assert.equal(lab.snapshot().sessions[0].status, 'failed');
  assert.equal(tasks.length, count, 'recovery must not relaunch work');
  assert.equal(lab.snapshot().sessions[0].renders.length, 7);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'audio', job.id + '.flac')), original);
});

test('imports, references, cancellation and removal keep library audio intact', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lab-import-')),
    job = library(dir);
  let release;
  const runTask = async task => {
    if (task.action === 'render')
      await new Promise(r => {
        release = r;
      });
    return fakeWorker(task);
  };
  const lab = createAudioLab({
    root: dir,
    dataDir: dir,
    getJob: id => (id === job.id ? job : null),
    getMix: () => null,
    runTask,
  });
  t.after(() => {
    lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(lab.importFile(stream(Buffer.alloc(4))), /empty/);
  assert.equal(lab.snapshot().sessions.length, 0);
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'audio-lab')).filter(n => n !== 'sessions.json'),
    [],
    'failed uploads leave no folders'
  );
  const s = await lab.importFile(stream(Buffer.alloc(4096, 1), 'Il mio brano.wav'));
  await waitFor(() => s.status === 'ready');
  assert.equal(s.title, 'Il mio brano');
  assert.ok(!fs.existsSync(path.join(dir, 'audio-lab', s.id, 'upload.audio')));
  await lab.reference(s.id, stream(Buffer.alloc(4096, 2), 'Modello.flac'));
  await waitFor(() => s.reference && s.status === 'ready');
  assert.equal(s.reference.label, 'Modello.flac');
  assert.ok(fs.existsSync(lab.media(s.id, 'reference')));
  await lab.preview(s.id, {});
  await waitFor(() => s.status === 'processing');
  lab.cancel(s.id);
  release();
  await waitFor(() => s.status === 'ready');
  assert.equal(s.phase, 'Cancelled');
  assert.equal(s.renders.length, 0);
  assert.equal(
    fs.readdirSync(path.join(dir, 'audio-lab', s.id, 'renders')).length,
    0,
    'cancelled renders are discarded'
  );
  lab.remove(s.id);
  assert.ok(!fs.existsSync(path.join(dir, 'audio-lab', s.id)));
  assert.ok(fs.existsSync(path.join(dir, 'audio', job.id + '.flac')));
});

test('AI advice sends measurements only, clamps proposals and keeps manual mastering when AI fails', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lab-ai-')),
    job = library(dir),
    credentialsFile = path.join(dir, 'prompt-ai.json');
  fs.writeFileSync(credentialsFile, JSON.stringify({ apiKey: 'fake-personal-key-123456' }));
  let body, reply;
  const promptAi = createPromptAI(
    { credentialsFile },
    {
      fetchImpl: async (url, options) => {
        body = JSON.parse(options.body);
        return reply();
      },
    }
  );
  const lab = createAudioLab({
    root: dir,
    dataDir: dir,
    getJob: id => (id === job.id ? job : null),
    getMix: () => null,
    promptAi,
    runTask: fakeWorker,
  });
  t.after(() => {
    lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const s = lab.create({ kind: 'job', jobId: job.id });
  await waitFor(() => s.status === 'ready');
  const content = value => () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  reply = content({
    summary: 'Il brano è già forte.',
    observations: ['Loudness integrata -12 LUFS.', 42],
    settings: {
      eq: [20, 0, 0, 0, 0, 0, 1.2, 0, 0, 0],
      compressor: 'gentle',
      reverb: 'cathedral',
      targetLufs: -14,
    },
    listening: ['Controlla la cassa.'],
  });
  const advice = await lab.advice(s.id, { goal: 'streaming' });
  assert.equal(advice.settings.eq[0], 12);
  assert.equal(advice.settings.eq[6], 1);
  assert.equal(advice.settings.compressor, 'gentle');
  assert.equal(advice.settings.reverb, 'off', 'invalid modes fall back to current settings');
  assert.deepEqual(advice.observations, ['Loudness integrata -12 LUFS.']);
  assert.equal(s.advice.summary, 'Il brano è già forte.');
  const prompt = body.messages[1].content;
  assert.match(prompt, /NOT heard the audio/);
  assert.match(prompt, /streaming/);
  assert.ok(!prompt.includes('fake-personal'));
  assert.equal(body.temperature, 0.3);
  reply = content({
    summary: 'Bande come oggetto.',
    observations: [],
    settings: { eq: { '31Hz': 2, '1k': '-1,5', '16 kHz': '+3 dB' }, compressor: 'off' },
    listening: [],
  });
  const keyed = await lab.advice(s.id, {});
  assert.deepEqual(
    keyed.settings.eq,
    [2, 0, 0, 0, 0, -1.5, 0, 0, 0, 3],
    'EQ given per frequency or as text is understood'
  );
  assert.match(body.messages[1].content, /Translate every tonal imbalance/);
  reply = content({ observations: [] });
  await assert.rejects(lab.advice(s.id, {}), /incomplete/);
  reply = () => new Response('{}', { status: 401 });
  await assert.rejects(lab.advice(s.id, {}), /key is invalid/);
  await assert.rejects(lab.advice(s.id, { goal: 'x'.repeat(501) }), /Invalid goal/);
  await lab.preview(s.id, {});
  await waitFor(() => s.renders.length === 1 && s.status === 'ready');
  assert.equal(
    s.advice.summary,
    'Bande come oggetto.',
    'failed requests keep the last valid advice; manual mastering still works'
  );
});

test('Audio Lab HTTP routes: origin protection, upload, preview, ranges and downloads', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lab-http-')),
    job = library(dir);
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, jobs: [job] }));
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const app = createStudio(
    { model: 'm', encoder: 'e', planner: 'p', vae: 'v', comfyUrl: `http://127.0.0.1:${fake.address().port}` },
    { dataDir: dir, pollMs: 1e8, labTask: fakeWorker }
  );
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await new Promise(r => fake.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'X-Sonora': '1', 'Content-Type': 'application/json', ...headers },
      body: body instanceof Buffer ? body : JSON.stringify(body),
    });
  assert.equal((await fetch(base + '/api/audio-lab/sessions', { method: 'POST', body: '{}' })).status, 403);
  assert.equal(
    (await post('/api/audio-lab/sessions', { kind: 'job', jobId: job.id }, { Origin: 'http://evil.test' }))
      .status,
    403
  );
  const s = await (await post('/api/audio-lab/sessions', { kind: 'job', jobId: job.id })).json();
  const state = async () =>
    (await (await fetch(base + '/api/state')).json()).audioLab.sessions.find(x => x.id === s.id);
  for (let i = 0; i < 100 && (await state()).status !== 'ready'; i++)
    await new Promise(r => setTimeout(r, 5));
  assert.equal(
    (await post(`/api/audio-lab/${s.id}/preview`, { eq: [13, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).status,
    400
  );
  assert.equal(
    (await post(`/api/audio-lab/${s.id}/preview`, { eq: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).status,
    202
  );
  let current;
  for (let i = 0; i < 100 && !(current = await state()).renders.length; i++)
    await new Promise(r => setTimeout(r, 5));
  const r = await fetch(
    `${base}/api/audio-lab/${s.id}/audio?kind=render&id=${current.renders[0].id}&download=1`,
    { headers: { Range: 'bytes=0-9' } }
  );
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  assert.match(r.headers.get('content-disposition'), /Prova-master\.flac/);
  assert.equal((await fetch(`${base}/api/audio-lab/${s.id}/audio?kind=source`)).status, 200);
  assert.equal(
    (await fetch(`${base}/api/audio-lab/${s.id}/audio?kind=render&id=${current.renders[0].id}&format=mp3`))
      .status,
    200
  );
  assert.equal(
    (await fetch(`${base}/api/audio-lab/${s.id}/renders/${current.renders[0].id}`, { method: 'DELETE' }))
      .status,
    403
  );
  assert.equal(
    (
      await fetch(`${base}/api/audio-lab/${s.id}/renders/${current.renders[0].id}`, {
        method: 'DELETE',
        headers: { 'X-Sonora': '1' },
      })
    ).status,
    200
  );
  assert.equal(
    (await fetch(`${base}/api/audio-lab/${s.id}/audio?kind=render&id=${current.renders[0].id}`)).status,
    404
  );
  assert.equal(
    (await fetch(`${base}/api/audio-lab/${s.id}/audio?kind=render&id=${randomUUID()}`)).status,
    404
  );
  const imported = await (
    await post('/api/audio-lab/import', Buffer.alloc(2048, 5), {
      'Content-Type': 'application/octet-stream',
      'X-Audio-Name': encodeURIComponent('Demo.mp3'),
    })
  ).json();
  assert.equal(imported.source.kind, 'import');
  assert.equal(imported.title, 'Demo');
  assert.equal((await fetch(`${base}/api/audio-lab/${imported.id}`, { method: 'DELETE' })).status, 403);
  for (
    let i = 0;
    i < 100 &&
    (await (await fetch(base + '/api/state')).json()).audioLab.sessions.find(x => x.id === imported.id)
      .status !== 'ready';
    i++
  )
    await new Promise(r => setTimeout(r, 5));
  assert.equal(
    (await fetch(`${base}/api/audio-lab/${imported.id}`, { method: 'DELETE', headers: { 'X-Sonora': '1' } }))
      .status,
    200
  );
});

test('exported masters can be added to the library as new tracks, leaving the original untouched', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lab-library-')),
    job = {
      ...library(dir),
      input: { tags: 'indie pop', bpm: 96, lyrics: '[Verse]\nCiao', instrumental: false, duration: 30 },
    };
  const original = fs.readFileSync(path.join(dir, 'audio', job.id + '.flac'));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, jobs: [job] }));
  const app = createStudio(
    { model: 'm', encoder: 'e', planner: 'p', vae: 'v', comfyUrl: 'http://127.0.0.1:9' },
    { dataDir: dir, pollMs: 1e8, labTask: fakeWorker }
  );
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'X-Sonora': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const state = async () => (await fetch(base + '/api/state')).json();
  const s = await (await post('/api/audio-lab/sessions', { kind: 'job', jobId: job.id })).json();
  const waitReady = async n => {
    for (let i = 0; i < 200; i++) {
      const lab = (await state()).audioLab.sessions.find(x => x.id === s.id);
      if (lab.status === 'ready' && lab.renders.length >= n) return lab;
      await new Promise(r => setTimeout(r, 5));
    }
    assert.fail('export did not finish');
  };
  await waitReady(0);
  assert.equal(
    (await post(`/api/audio-lab/${s.id}/preview`, { targetLufs: -14, toLibrary: true })).status,
    202
  );
  const lab = await waitReady(1);
  const jobs = (await state()).jobs,
    master = jobs.find(j => j.kind === 'master');
  assert.equal(lab.renders[0].libraryJobId, master.id);
  assert.deepEqual(
    [master.title, master.status, master.parentId, master.input.tags, master.input.bpm],
    ['Prova · master', 'done', job.id, 'indie pop', 96]
  );
  const renderFile = path.join(dir, 'audio-lab', s.id, 'renders', lab.renders[0].id, 'master.flac');
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'audio', master.id + '.flac')),
    fs.readFileSync(renderFile)
  );
  assert.equal(
    (await fetch(`${base}/api/jobs/${master.id}/audio?format=mp3`)).status,
    200,
    'the master plays from the library'
  );
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'audio', job.id + '.flac')),
    original,
    'the original track is untouched'
  );
  assert.equal((await post(`/api/audio-lab/${s.id}/preview`, { targetLufs: -16 })).status, 202);
  const second = (await waitReady(2)).renders[0];
  assert.equal(second.libraryJobId, undefined, 'without the option nothing is added');
  const added = await (await post(`/api/audio-lab/${s.id}/renders/${second.id}/library`, {})).json();
  assert.equal(added.kind, 'master');
  assert.equal((await state()).jobs.filter(j => j.kind === 'master').length, 2);
  assert.equal((await post(`/api/audio-lab/${s.id}/renders/${randomUUID()}/library`, {})).status, 404);
});
