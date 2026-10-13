// @codedna
// description: "Check model files" with models in sub-folders or outside the ComfyUI folder (extra_model_paths.yaml): ComfyUI's own list decides.
// exports: none
// used_by: none
// rules:   Use isolated temp storage and a fake ComfyUI endpoint; never download real models in tests.
// agent:   claude-sonnet-5-5 - 2026-10-13 - A user with models under a Stability Matrix folder, full paths in config.json and an empty ComfyUI models folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ACE_STEP_FILES } from '../model-setup.mjs';
import { createStudio } from '../server.mjs';

const manifest = ACE_STEP_FILES.map((item, index) => ({
  path: item.path,
  size: index + 1,
  lfs: { oid: String(index + 1).padStart(64, '0') },
}));
const response = (value, url) => ({ ok: true, status: 200, url, headers: new Headers(), json: async () => value });

async function studio(t, { config, listed }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-sub-setup-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-sub-comfy-'));
  fs.writeFileSync(path.join(root, 'main.py'), '# ComfyUI');
  const comfy = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const send = value => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (route === '/system_stats') return send({ system: { argv: ['main.py'] }, devices: [{ name: 'Test GPU' }] });
    if (route.startsWith('/object_info/')) {
      const node = route.split('/').pop();
      return send({ [node]: { input: { required: { unet_name: [listed.model], clip_name1: [listed.encoder], clip_name2: [listed.planner], vae_name: [listed.vae] } } } });
    }
    send({});
  });
  await new Promise(resolve => comfy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${comfy.address().port}`;
  const app = createStudio({ ...config, port: 0, comfyUrl: url }, { dataDir, pollMs: 1e8, modelFetch: async u => response(manifest, u) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await new Promise(resolve => comfy.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const post = (route, body) =>
    fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' }, body: JSON.stringify(body) });
  await post('/api/settings/local', { comfyUrl: url, comfyRoot: root });
  return { post, root, app };
}

test('full paths in config.json and models outside the ComfyUI folder: the check follows ComfyUI, nothing is downloaded', async t => {
  const config = {
    model: 'A:\\StabilityMatrix\\Data\\models\\diffusion_models\\acestep\\acestep_v1.5_xl_turbo_bf16.safetensors',
    encoder: 'A:\\StabilityMatrix\\Data\\models\\text_encoders\\qwen\\qwen_0.6b_ace15.safetensors',
    planner: 'A:\\StabilityMatrix\\Data\\models\\text_encoders\\qwen\\qwen_4b_ace15.safetensors',
    vae: 'A:\\StabilityMatrix\\Data\\models\\vae\\acestep\\ace_1.5_vae.safetensors',
  };
  const listed = {
    model: ['acestep\\acestep_v1.5_xl_turbo_bf16.safetensors'],
    encoder: ['qwen\\qwen_0.6b_ace15.safetensors', 'qwen\\qwen_4b_ace15.safetensors'],
    planner: ['qwen\\qwen_0.6b_ace15.safetensors', 'qwen\\qwen_4b_ace15.safetensors'],
    vae: ['acestep\\ace_1.5_vae.safetensors'],
  };
  const { post, root, app } = await studio(t, { config, listed });
  const plan = await (await post('/api/models/plan', {})).json();
  assert.equal(plan.error, undefined);
  assert.equal(plan.files.length, 4);
  assert.ok(plan.files.every(file => file.status === 'present'), JSON.stringify(plan.files));
  assert.equal(plan.totalBytes, 0);
  assert.equal(app.state?.health?.ready ?? true, true);
  // the ComfyUI folder itself stays empty: nothing was written there
  assert.ok(!fs.existsSync(path.join(root, 'models', 'diffusion_models')) || fs.readdirSync(path.join(root, 'models', 'diffusion_models')).length === 0);
  const started = await post('/api/models/download', { confirmed: true });
  assert.equal(started.status, 202);
});

test('a relative sub-folder in the config is accepted too, and a model ComfyUI does not list is still reported missing', async t => {
  const config = {
    model: 'acestep/acestep_v1.5_xl_turbo_bf16.safetensors',
    encoder: 'qwen/qwen_0.6b_ace15.safetensors',
    planner: 'qwen/qwen_4b_ace15.safetensors',
    vae: 'acestep/ace_1.5_vae.safetensors',
  };
  const listed = { model: ['acestep/acestep_v1.5_xl_turbo_bf16.safetensors'], encoder: ['qwen/qwen_0.6b_ace15.safetensors'], planner: [], vae: [] };
  const { post } = await studio(t, { config, listed });
  const plan = await (await post('/api/models/plan', {})).json();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.files.map(file => file.status), ['present', 'present', 'missing', 'missing']);
  assert.deepEqual(plan.files.map(file => file.name), [
    'acestep_v1.5_xl_turbo_bf16.safetensors',
    'qwen_0.6b_ace15.safetensors',
    'qwen_4b_ace15.safetensors',
    'ace_1.5_vae.safetensors',
  ]);
});
