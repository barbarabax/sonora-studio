// @codedna
// description: The "Run a quick test" step: a hidden 10-second job that proves the pipeline runs, then disappears.
// exports: none
// used_by: none
// rules:   Use isolated temp storage and a fake ComfyUI endpoint; never submit GPU work from tests.
// agent:   claude-sonnet-5-5 - 2026-10-11 - Quick test regression checks (success, failure, hidden from the library, no leftovers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStudio } from '../server.mjs';

const config = {
  model: 'model.safetensors',
  encoder: 'encoder.safetensors',
  planner: 'planner.safetensors',
  vae: 'vae.safetensors',
};

test('quick test: runs a hidden 10 s job, keeps only the verdict and leaves nothing in the library', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-quick-'));
  const history = {},
    submitted = [];
  let healthy = true;
  const nodes = {
    UNETLoader: { unet_name: [[config.model]] },
    DualCLIPLoader: { clip_name1: [[config.encoder]], clip_name2: [[config.planner]] },
    VAELoader: { vae_name: [[config.vae]] },
  };
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : {};
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/system_stats') return send({ devices: [{ name: 'Test GPU' }] });
    if (url.pathname.startsWith('/object_info/')) {
      const name = url.pathname.split('/').pop();
      return send(healthy ? { [name]: { input: { required: nodes[name] || {} } } } : {});
    }
    if (url.pathname === '/prompt') {
      submitted.push(body);
      return send({ prompt_id: body.prompt_id });
    }
    if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: [] });
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.split('/').pop();
      return send(history[id] ? { [id]: history[id] } : {});
    }
    if (url.pathname === '/view') {
      res.writeHead(200);
      res.end(Buffer.alloc(512, 7));
      return;
    }
    send({}, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const app = createStudio(
    { ...config, comfyUrl: `http://127.0.0.1:${fake.address().port}` },
    { dataDir: dir, pollMs: 1e8 }
  );
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  await app.checkHealth();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await new Promise(r => fake.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = (route, method = 'GET', body) =>
    fetch(base + route, {
      method,
      headers: { 'X-Sonora': '1', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const state = async () => (await req('/api/state')).json();
  const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'library.json'))).jobs;

  assert.equal((await state()).quickTest.status, 'idle');

  // Success: a short instrumental light/fast job is submitted and hidden while it runs.
  const started = await req('/api/provider-test', 'POST', {});
  assert.equal(started.status, 202);
  assert.equal(submitted.length, 1);
  const graph = submitted[0].prompt;
  assert.equal(graph['4'].inputs.duration, 10);
  assert.equal(graph['4'].inputs.lyrics, '[Instrumental]');
  let current = await state();
  assert.equal(current.quickTest.status, 'running');
  assert.deepEqual(current.jobs, [], 'the test job never shows in the library');
  assert.equal((await req('/api/provider-test', 'POST', {})).status, 400, 'only one test at a time');

  const promptId = submitted[0].prompt_id;
  history[promptId] = {
    status: { completed: true, status_str: 'success' },
    outputs: {
      10: { audio: [{ filename: 'test.mp3', type: 'output' }] },
      11: { audio: [{ filename: 'test.flac', type: 'output' }] },
    },
  };
  await app.poll();
  await app.poll();
  current = await state();
  assert.equal(current.quickTest.status, 'ok');
  assert.match(current.quickTest.message, /pipeline works/);
  assert.deepEqual(current.jobs, []);
  assert.equal(
    stored().some(j => j.test),
    false,
    'the test job is removed from the saved library'
  );
  const leftovers = fs.existsSync(path.join(dir, 'audio')) ? fs.readdirSync(path.join(dir, 'audio')) : [];
  assert.deepEqual(leftovers, [], 'the test clip is deleted');

  // Failure: the error of the pipeline becomes the verdict, again with nothing left behind.
  await req('/api/provider-test', 'POST', {});
  const failedId = submitted[1].prompt_id;
  history[failedId] = {
    status: { messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] },
  };
  await app.poll();
  current = await state();
  assert.equal(current.quickTest.status, 'failed');
  assert.match(current.quickTest.message, /CUDA out of memory/);
  assert.deepEqual(current.jobs, []);
  assert.equal(
    stored().some(j => j.test),
    false
  );

  // Missing nodes or models: the request is refused with the reason, and the verdict says so.
  healthy = false;
  await app.checkHealth();
  const refused = await req('/api/provider-test', 'POST', {});
  assert.equal(refused.status, 400);
  assert.equal((await state()).quickTest.status, 'failed');
});
