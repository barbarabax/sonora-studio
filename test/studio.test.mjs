// @codedna
// description: Contract tests for ComfyUI jobs, recovery, scoped cancellation and local media delivery.
// exports: none
// used_by: none
// rules:   Use isolated temp storage and a fake ComfyUI endpoint; never submit GPU work from tests.
// agent:   Codex - 2026-10-04 - Integration and workflow regression checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { validateInput, buildWorkflow, seedsFor, historyFailure } from '../lib.mjs';

const config = {
  model: 'model.safetensors',
  encoder: 'encoder.safetensors',
  planner: 'planner.safetensors',
  vae: 'vae.safetensors',
};
const input = {
  title: 'Test',
  tags: 'piano, instrumental',
  instrumental: true,
  duration: 15,
  variants: 2,
  seed: 41,
};
test('native XL graph uses dual encoder in both modes and keeps duration and seeds synchronized', () => {
  const p = validateInput(input);
  const graph = buildWorkflow(p, 41, randomUUID(), config);
  assert.equal(graph['2'].class_type, 'DualCLIPLoader');
  assert.equal(graph['2'].inputs.type, 'ace');
  assert.equal(graph['4'].inputs.duration, graph['6'].inputs.seconds);
  assert.equal(graph['4'].inputs.seed, graph['8'].inputs.seed);
  assert.equal(graph['4'].inputs.generate_audio_codes, false);
  assert.equal(graph['4'].inputs.lyrics, '[Instrumental]');
  assert.equal(graph['7'].class_type, 'ModelSamplingAuraFlow');
  assert.equal(graph['8'].inputs.cfg, 1);
  assert.equal(graph['8'].inputs.steps, 8);
  const vocal = buildWorkflow(
    validateInput({ ...input, instrumental: false, lyrics: '[Verse]\nCiao', quality: 'full' }),
    42,
    randomUUID(),
    config
  );
  assert.equal(vocal['4'].inputs.generate_audio_codes, true);
  assert.equal(vocal['4'].inputs.lyrics, '[Verse]\nCiao');
  assert.deepEqual(seedsFor(p), [41, 42]);
  assert.deepEqual(seedsFor({ ...p, seed: 4294967294 }), [4294967294, 0]);
});
test('input validation rejects invalid ranges, missing lyrics and unsafe types', () => {
  for (const patch of [
    { duration: 0 },
    { duration: 301 },
    { duration: NaN },
    { seed: '42' },
    { variants: 5 },
    { instrumental: 'false' },
    { instrumental: false, lyrics: '' },
    { tags: '' },
    { quality: 'unknown' },
    { keyscale: 'invalid' },
    { language: '../' },
    { bpm: 12.5 },
  ])
    assert.throws(() => validateInput({ ...input, ...patch }));
  const failure = historyFailure({
    status: { messages: [['execution_error', { exception_message: 'GPU error' }]] },
  });
  assert.equal(failure.message, 'GPU error');
});

test('HTTP integration: two jobs, scoped cancel, recovery, downloads, persistence and origin protection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-test-'));
  let pending = [],
    running = [],
    history = {},
    submitted = [],
    cancelled = [],
    deleted = [],
    rejectNext = false,
    viewFails = 0;
  const nodes = {
    UNETLoader: { unet_name: [[config.model]] },
    DualCLIPLoader: { clip_name1: [[config.encoder]], clip_name2: [[config.planner]] },
    VAELoader: { vae_name: [[config.vae]] },
  };
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = [];
    for await (const c of req) parts.push(c);
    const b = parts.length ? JSON.parse(Buffer.concat(parts)) : {};
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/system_stats') return send({ devices: [{ name: 'Test GPU' }] });
    if (url.pathname.startsWith('/object_info/')) {
      const n = url.pathname.split('/').pop();
      return send({ [n]: { input: { required: nodes[n] || {} } } });
    }
    if (url.pathname === '/prompt') {
      if (rejectNext) {
        rejectNext = false;
        return send({ error: 'Invalid workflow' }, 400);
      }
      submitted.push(b);
      pending.push([0, b.prompt_id]);
      return send({ prompt_id: b.prompt_id });
    }
    if (url.pathname === '/queue' && req.method === 'POST') {
      deleted.push(b);
      pending = pending.filter(x => !b.delete.includes(x[1]));
      return send({});
    }
    if (url.pathname === '/queue') return send({ queue_running: running, queue_pending: pending });
    if (url.pathname === '/interrupt') {
      cancelled.push(b);
      running = running.filter(x => x[1] !== b.prompt_id);
      return send({});
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/').pop();
      return send(history[id] ? { [id]: history[id] } : {});
    }
    if (url.pathname === '/view') {
      if (viewFails-- > 0) return send({ error: 'temporary download failure' }, 500);
      res.writeHead(200);
      res.end(Buffer.alloc(512, 42));
      return;
    }
    send({}, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const cfg = { ...config, comfyUrl: `http://127.0.0.1:${fake.address().port}` };
  let app = createStudio(cfg, { dataDir: dir, pollMs: 1e8 });
  const start = async () => {
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    await app.checkHealth();
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  let base = await start();
  t.after(async () => {
    await app.close();
    await new Promise(r => fake.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = async (route, method = 'GET', body, headers = {}) =>
    fetch(base + route, {
      method,
      headers: { 'X-Sonora': '1', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const create = await req('/api/generate', 'POST', input);
  assert.equal(create.status, 202);
  const { jobs } = await create.json();
  assert.equal(jobs.length, 2);
  assert.equal(submitted.length, 2);
  assert.notEqual(jobs[0].input.seed, jobs[1].input.seed);
  assert.equal(submitted[0].prompt_id, jobs[0].promptId);
  assert.equal(
    (await req('/api/generate', 'POST', input, { Origin: 'https://unrelated.example' })).status,
    403
  );
  assert.equal((await req('/api/generate', 'POST', input, { 'X-Sonora': '' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const r = http.get(base + '/api/state', { headers: { Host: 'attacker.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await req('/api/jobs/' + jobs[0].id, 'PATCH', { archived: true })).status, 400);
  const external = randomUUID();
  pending.push([999, external]);
  await req(`/api/jobs/${jobs[1].id}/cancel`, 'POST', {});
  assert.deepEqual(deleted, [{ delete: [jobs[1].promptId] }]);
  assert.deepEqual(cancelled, [{ prompt_id: jobs[1].promptId }]);
  assert.ok(pending.some(x => x[1] === external));
  history[jobs[1].promptId] = { status: { messages: [['execution_interrupted', {}]] } };
  await app.close();
  app = createStudio(cfg, { dataDir: dir, pollMs: 1e8 });
  base = await start();
  await app.poll();
  assert.equal(submitted.length, 2, 'restart must not resubmit jobs');
  const first = jobs[0];
  history[first.promptId] = {
    status: { completed: true, status_str: 'success' },
    outputs: {
      10: { audio: [{ filename: 'test.mp3', type: 'output' }] },
      11: { audio: [{ filename: 'test.flac', type: 'output' }] },
    },
  };
  pending = pending.filter(x => x[1] !== first.promptId);
  viewFails = 1;
  await app.poll();
  let state = await (await req('/api/state')).json();
  assert.equal(state.jobs.find(j => j.id === first.id).status, 'saving');
  await app.poll();
  state = await (await req('/api/state')).json();
  assert.equal(state.jobs.find(j => j.id === first.id).status, 'done');
  assert.equal(state.jobs.find(j => j.id === jobs[1].id).status, 'cancelled');
  const range = await req(`/api/jobs/${first.id}/audio`, 'GET', undefined, { Range: 'bytes=10-19' });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
  assert.equal(range.headers.get('content-range'), 'bytes 10-19/512');
  const suffix = await req(`/api/jobs/${first.id}/audio`, 'GET', undefined, { Range: 'bytes=-7' });
  assert.equal((await suffix.arrayBuffer()).byteLength, 7);
  assert.equal(
    (await req(`/api/jobs/${first.id}/audio`, 'GET', undefined, { Range: 'bytes=999-' })).status,
    416
  );
  assert.equal((await req(`/api/jobs/${first.id}/audio?format=../../config.json`)).status, 404);
  assert.equal((await req('/%2e%2e/config.json')).status, 404);
  await req(`/api/jobs/${first.id}`, 'PATCH', { title: 'Musica <test>', favorite: true, archived: true });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'))).jobs.find(
    j => j.id === first.id
  );
  assert.equal(stored.title, 'Musica <test>');
  assert.equal(stored.favorite, true);
  assert.equal(stored.archived, true);
  assert.ok(fs.existsSync(path.join(dir, 'audio', first.id + '.flac')));
  await req(`/api/jobs/${first.id}`, 'PATCH', { archived: false });
  rejectNext = true;
  const rejected = await (await req('/api/generate', 'POST', { ...input, variants: 1 })).json();
  assert.equal(rejected.jobs[0].status, 'failed');
  const automatic = await req('/api/generate', 'POST', {
    ...input,
    variants: 1,
    instrumental: false,
    durationMode: 'auto',
    bpm: 80,
    lyrics: '[Verse]\nCiao amore\nResta ancora\n[Chorus]\nLuce sul mare\nResta qui',
  });
  assert.equal(automatic.status, 202);
  const autoJob = (await automatic.json()).jobs[0];
  assert.equal(autoJob.input.duration, 24);
  assert.equal(autoJob.input.durationEstimate.totalBars, 8);
  const submittedGraph = submitted.at(-1).prompt;
  assert.equal(submittedGraph['4'].inputs.duration, 24);
  assert.equal(submittedGraph['6'].inputs.seconds, 24);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'library.json'))).jobs.find(j => j.id === autoJob.id).input
      .durationMode,
    'auto'
  );
});

test('voice choice is added to the style tags, ignored for instrumentals and validated', () => {
  const base = {
    title: 'Voce',
    tags: 'indie pop',
    lyrics: '[Verse]\nCiao',
    instrumental: false,
    duration: 30,
    seed: 1,
  };
  const tags = vocal =>
    buildWorkflow(validateInput({ ...base, vocal }), 1, '00000000-0000-0000-0000-000000000000', config)['4']
      .inputs.tags;
  assert.equal(tags('female'), 'indie pop, female lead vocals');
  assert.equal(tags('duet'), 'indie pop, male and female duet vocals, alternating lead singers');
  assert.equal(tags('auto'), 'indie pop');
  assert.equal(
    buildWorkflow(validateInput({ ...base }), 1, '00000000-0000-0000-0000-000000000000', config)['4'].inputs
      .tags,
    'indie pop',
    'older drafts without the field keep working'
  );
  const instrumental = validateInput({ ...base, instrumental: true, vocal: 'male' });
  assert.equal(
    buildWorkflow(instrumental, 1, '00000000-0000-0000-0000-000000000000', config)['4'].inputs.tags,
    'indie pop, instrumental, no vocals'
  );
  for (const vocal of ['toString', 'robot', 7]) assert.throws(() => validateInput({ ...base, vocal }));
});
