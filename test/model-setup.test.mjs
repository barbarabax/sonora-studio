// @codedna
// description: Tests for user-selected ComfyUI model paths and verified model installation.
// exports: none
// used_by: none
// rules:   Use tiny injected model fixtures; never download large model files in tests.
// agent:   Codex - 2026-10-10 - Local ACE-Step model setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ACE_STEP_FILES, createModelSetup } from '../model-setup.mjs';
import { createStudio } from '../server.mjs';

const manifestUrl = 'https://huggingface.co/api/models/test/tree/main?recursive=true&expand=true';
const fixture = Buffer.from('ACE!');
const model = { path: 'diffusion_models/test.safetensors', setting: 'model' };

function response(value, { status = 200, url = manifestUrl, headers = new Headers() } = {}) {
  return { ok: status >= 200 && status < 300, status, url, headers, json: async () => value, body: value };
}

function fakeFetch(url) {
  if (url === manifestUrl)
    return response([
      {
        path: model.path,
        size: fixture.length,
        lfs: { oid: crypto.createHash('sha256').update(fixture).digest('hex') },
      },
    ]);
  return response(new ReadableStream({ start(controller) { controller.enqueue(fixture); controller.close(); } }), {
    url,
    headers: new Headers(),
  });
}

test('model setup validates a real ComfyUI root and installs only a confirmed verified fixture', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-comfy-'));
  fs.writeFileSync(path.join(root, 'main.py'), '# ComfyUI');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const setup = createModelSetup({
    fetchImpl: fakeFetch,
    files: [model],
    manifestUrl,
    base: 'https://huggingface.co/Comfy-Org/test',
  });

  await assert.rejects(setup.download({ root, confirmed: false }), /Confirm/);
  const plan = await setup.inspect(root);
  assert.equal(plan.files[0].status, 'missing');
  assert.equal(plan.totalBytes, fixture.length);
  await setup.download({ root, confirmed: true });
  const target = path.join(root, 'models', 'diffusion_models', 'test.safetensors');
  assert.deepEqual(fs.readFileSync(target), fixture);
  assert.equal((await setup.inspect(root)).files[0].status, 'present');
  assert.equal(setup.snapshot().status, 'ready');
});

test('model setup rejects folders without ComfyUI main.py', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-not-comfy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const setup = createModelSetup({ fetchImpl: fakeFetch, files: [model], manifestUrl });
  await assert.rejects(setup.inspect(root), /main.py/);
});

test('local model API validates and saves the ComfyUI root before showing the fixed model plan', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-model-api-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-comfy-api-'));
  fs.writeFileSync(path.join(root, 'main.py'), '# ComfyUI');
  const names = { model: 'model.safetensors', encoder: 'encoder.safetensors', planner: 'planner.safetensors', vae: 'vae.safetensors' };
  const comfy = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (route === '/system_stats') return send({ devices: [{ name: 'Test GPU' }] });
    if (route.startsWith('/object_info/')) {
      const node = route.split('/').pop();
      // Rules: this ComfyUI lists no models yet, so the plan comes from the disk (a model ComfyUI lists counts as present).
      const definitions = {
        UNETLoader: { unet_name: [[]] },
        DualCLIPLoader: { clip_name1: [[]], clip_name2: [[]] },
        VAELoader: { vae_name: [[]] },
      };
      return send({ [node]: { input: { required: definitions[node] || {} } } });
    }
    send({});
  });
  await new Promise(resolve => comfy.listen(0, '127.0.0.1', resolve));
  const files = ACE_STEP_FILES.map((item, index) => ({
    path: item.path,
    size: index + 1,
    lfs: { oid: String(index + 1).padStart(64, '0') },
  }));
  const app = createStudio(
    { ...names, port: 0, comfyUrl: `http://127.0.0.1:${comfy.address().port}` },
    {
      dataDir,
      pollMs: 1e8,
      modelFetch: async url => response(files, { url }),
    }
  );
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, body) => fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' },
    body: JSON.stringify(body),
  });
  t.after(async () => {
    await app.close();
    await new Promise(resolve => comfy.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await request('/api/models/plan', {})).status, 400);
  const saved = await request('/api/settings/local', { comfyUrl: `http://127.0.0.1:${comfy.address().port}`, comfyRoot: root });
  assert.equal(saved.status, 200);
  const planResponse = await request('/api/models/plan', {});
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.equal(plan.files.length, 4);
  assert.ok(plan.files.every(file => file.status === 'missing'));
  assert.equal(plan.totalBytes, 10);
  assert.equal((await request('/api/models/download', { confirmed: false })).status, 400);
});

test('a ComfyUI Desktop base folder (models but no main.py) is accepted', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-comfy-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'models'));
  const setup = createModelSetup({ fetchImpl: fakeFetch, files: [model], manifestUrl });
  const plan = await setup.inspect(root);
  assert.equal(plan.root, fs.realpathSync(root));
  assert.equal(plan.files.length, 1);
});

test('when every file is on disk but ComfyUI does not list them, the app says so and names ComfyUIs own folder', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-model-warn-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-comfy-warn-'));
  fs.writeFileSync(path.join(root, 'main.py'), '# ComfyUI');
  const names = { model: 'model.safetensors', encoder: 'encoder.safetensors', planner: 'planner.safetensors', vae: 'vae.safetensors' };
  const files = ACE_STEP_FILES.map((item, index) => ({
    path: item.path,
    size: index + 1,
    lfs: { oid: String(index + 1).padStart(64, '0') },
  }));
  ACE_STEP_FILES.forEach((item, index) => {
    const dir = path.join(root, 'models', item.category);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, names[item.setting]), Buffer.alloc(index + 1));
  });
  // ComfyUI Desktop: started with its own base folder, and its model lists are empty.
  const comfy = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (route === '/system_stats')
      return send({ system: { argv: ['main.py', '--base-directory', 'D:\\ComfyUI'] }, devices: [{ name: 'Test GPU' }] });
    if (route.startsWith('/object_info/')) {
      const node = route.split('/').pop();
      return send({ [node]: { input: { required: { unet_name: [[]], clip_name1: [[]], clip_name2: [[]], vae_name: [[]] } } } });
    }
    send({});
  });
  await new Promise(resolve => comfy.listen(0, '127.0.0.1', resolve));
  const app = createStudio(
    { ...names, port: 0, comfyUrl: `http://127.0.0.1:${comfy.address().port}` },
    { dataDir, pollMs: 1e8, modelFetch: async url => response(files, { url }) }
  );
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, body) => fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' },
    body: JSON.stringify(body),
  });
  t.after(async () => {
    await app.close();
    await new Promise(resolve => comfy.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  await request('/api/settings/local', { comfyUrl: `http://127.0.0.1:${comfy.address().port}`, comfyRoot: root });
  const plan = await (await request('/api/models/plan', {})).json();
  assert.ok(plan.files.every(file => file.status === 'present'));
  assert.match(plan.warning, /does not see them/);
  assert.match(plan.warning, /D:\\ComfyUI/);
  const state = await (await fetch(base + '/api/state')).json();
  assert.match(state.modelSetup.warning, /does not see them/);
});
