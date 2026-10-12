// @codedna
// description: Models kept in sub-folders of the ComfyUI model folders are found by file name and used in the local workflow.
// exports: none
// used_by: none
// rules:   Use isolated temp storage and a fake ComfyUI endpoint; never submit GPU work from tests.
// agent:   claude-sonnet-5-5 - 2026-10-12 - Sub-folder lists with / and \ separators, ambiguity, and the names that reach ComfyUI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStudio } from '../server.mjs';
import { resolveModelName } from '../lib.mjs';

test('a model in a sub-folder is found by its file name, exact names win, ambiguity is not guessed', () => {
  const list = ['other.safetensors', 'acestep/acestep_v1.5_xl_turbo_bf16.safetensors'];
  assert.equal(resolveModelName('acestep_v1.5_xl_turbo_bf16.safetensors', list), 'acestep/acestep_v1.5_xl_turbo_bf16.safetensors');
  assert.equal(resolveModelName('x.safetensors', ['a\\b\\x.safetensors']), 'a\\b\\x.safetensors', 'Windows separators');
  assert.equal(resolveModelName('x.safetensors', ['x.safetensors', 'sub/x.safetensors']), 'x.safetensors', 'the exact name wins');
  assert.equal(resolveModelName('x.safetensors', ['a/x.safetensors', 'b/x.safetensors']), 'x.safetensors', 'two candidates: not guessed');
  assert.equal(resolveModelName('x.safetensors', ['y.safetensors']), 'x.safetensors');
  assert.equal(resolveModelName('x.safetensors', undefined), 'x.safetensors');
  assert.equal(resolveModelName('acestep/x.safetensors', ['acestep/x.safetensors']), 'acestep/x.safetensors', 'a path written in the config still works');
});

test('Studio is ready with sub-folder models and sends the names ComfyUI lists', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-sub-'));
  const submitted = [];
  const nodes = {
    UNETLoader: { unet_name: [['acestep\\model.safetensors']] },
    DualCLIPLoader: { clip_name1: [['qwen/encoder.safetensors']], clip_name2: [['qwen/planner.safetensors']] },
    VAELoader: { vae_name: [['acestep/vae.safetensors']] },
  };
  const fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : {};
    const send = value => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/system_stats') return send({ devices: [{ name: 'Test GPU' }] });
    if (url.pathname.startsWith('/object_info/')) {
      const n = url.pathname.split('/').pop();
      return send({ [n]: { input: { required: nodes[n] || {} } } });
    }
    if (url.pathname === '/prompt') {
      submitted.push(body);
      return send({ prompt_id: body.prompt_id });
    }
    if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: [] });
    send({});
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const app = createStudio(
    { model: 'model.safetensors', encoder: 'encoder.safetensors', planner: 'planner.safetensors', vae: 'vae.safetensors', comfyUrl: `http://127.0.0.1:${fake.address().port}` },
    { dataDir: dir, pollMs: 1e8 }
  );
  t.after(async () => {
    await app.close();
    await new Promise(r => fake.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const health = await app.checkHealth();
  assert.equal(health.ready, true, health.message);
  assert.equal(health.fullAvailable, true);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base + '/api/generate', {
    method: 'POST',
    headers: { 'X-Sonora': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test', tags: 'piano', instrumental: true, duration: 15, variants: 1, seed: 1 }),
  });
  assert.equal(response.status, 202);
  const workflow = JSON.stringify(submitted[0].prompt);
  for (const name of ['acestep\\\\model.safetensors', 'qwen/encoder.safetensors', 'qwen/planner.safetensors', 'acestep/vae.safetensors'])
    assert.ok(workflow.includes(name), name);
});
