// @codedna
// description: The YuE2 settings entered in the app: files for yue2.cpp on this PC and an optional RunPod endpoint, checked, saved and read back after a restart.
// exports: none
// used_by: none
// rules:   Temporary folders only; the engine is never started (the files are empty placeholders and no song is requested).
// agent:   claude-haiku-5-5 | anthropic | 2026-11-03 | Created with the YuE2 provider settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';

const CONFIG = { comfyUrl: 'http://127.0.0.1:1', model: 'm', encoder: 'e', planner: 'p', vae: 'v' };

async function start(closers, dir) {
  const app = createStudio(CONFIG, { dataDir: dir, pollMs: 3600000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  closers.push(close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' },
      body: JSON.stringify(body),
    });
  const config = async () => (await fetch(base + '/api/config')).json();
  return { app, close, post, config };
}

test('yue2.cpp files are checked, saved in the data folder and used after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-settings-'));
  const closers = [];
  try {
    const files = {};
    for (const name of ['yue-server.exe', 'model.gguf', 'vae.gguf']) {
      files[name] = path.join(dir, name);
      fs.writeFileSync(files[name], 'x');
    }
    const first = await start(closers, dir);
    assert.equal((await first.config()).yue2Local, false, 'nothing is configured at first');

    const missing = await first.post('/api/settings/yue2-cpp', {
      engine: path.join(dir, 'nope.exe'),
      model: files['model.gguf'],
      vae: files['vae.gguf'],
    });
    assert.equal(missing.ok, false);
    assert.match((await missing.json()).error, /engine program was not found/);
    const relative = await first.post('/api/settings/yue2-cpp', {
      engine: 'yue-server.exe',
      model: 'a',
      vae: 'b',
    });
    assert.equal(relative.status, 400);
    assert.match((await relative.json()).error, /full path/);
    assert.equal(
      (await first.post('/api/settings/yue2-cpp', { model: files['model.gguf'], vae: files['vae.gguf'] }))
        .status,
      400,
      'the engine is required'
    );

    const saved = await first.post('/api/settings/yue2-cpp', {
      engine: files['yue-server.exe'],
      model: files['model.gguf'],
      vae: files['vae.gguf'],
    });
    assert.equal(saved.status, 200);
    assert.match((await saved.json()).message, /Restart Sonora/);
    const shown = (await first.config()).providers.yue2.cpp;
    assert.equal(shown.engine, files['yue-server.exe']);
    assert.equal(shown.transcriber, '', 'optional files stay empty');
    await first.close();

    const second = await start(closers, dir);
    const config = await second.config();
    assert.equal(config.yue2Local, true, 'the saved files configure YuE2 on this PC after a restart');
    assert.equal(config.yue2Configured, true);
    assert.equal(config.providers.yue2.cpp.model, files['model.gguf']);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    assert.equal(stored.yue2.cpp.vae, files['vae.gguf']);
    assert.equal(JSON.stringify(stored).includes('apiKey'), false, 'no key is written to the settings file');
  } finally {
    for (const close of closers) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the YuE2 RunPod endpoint ID is validated and applied at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-endpoint-'));
  const closers = [];
  try {
    const { post, config } = await start(closers, dir);
    assert.equal((await post('/api/settings/yue2-endpoint', { endpointId: 'bad id!' })).status, 400);
    assert.equal((await post('/api/settings/yue2-endpoint', { endpointId: 'yue2-endpoint-1' })).status, 200);
    const after = await config();
    assert.equal(after.providers.yue2.endpointId, 'yue2-endpoint-1');
    assert.equal(after.yue2Configured, true);
    assert.equal((await post('/api/settings/yue2-endpoint', { endpointId: '' })).status, 200);
    assert.equal((await config()).yue2Configured, false, 'clearing the endpoint turns YuE2 off again');
  } finally {
    for (const close of closers) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the engine can be set to run on another computer: only a port is saved, and it is reported by the setup check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-remote-'));
  const closers = [];
  try {
    const first = await start(closers, dir);
    assert.equal(
      (await first.post('/api/settings/yue2-cpp', { remote: true, port: 80 })).status,
      400,
      'a port below 1024 is refused'
    );
    const saved = await first.post('/api/settings/yue2-cpp', { remote: true, port: 18088 });
    assert.equal(saved.status, 200);
    assert.match((await saved.json()).message, /SSH tunnel/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8')).yue2.cpp, {
      remote: true,
      port: 18088,
    });
    await first.close();

    const second = await start(closers, dir);
    const config = await second.config();
    assert.equal(config.yue2Local, true, 'YuE2 on this PC counts as configured without any file');
    assert.equal(config.yue2Lora, false, 'LoRA adapters are managed on the other computer');
    assert.equal(config.providers.yue2.cpp.remote, true);
    assert.equal(config.providers.yue2.cpp.port, 18088);
    const setup = await (
      await fetch(`http://127.0.0.1:${second.app.server.address().port}/api/setup`)
    ).json();
    const item = setup.items.find(entry => entry.id === 'yue2');
    assert.equal(item.label, 'YuE2 on another computer');
    assert.equal(item.status, 'warn', 'nothing answers on the tunnel port in the test');
    assert.match(item.hint, /SSH tunnel/);

    // going back to files on this PC clears the remote flag
    const file = path.join(dir, 'x.gguf');
    fs.writeFileSync(file, 'x');
    assert.equal(
      (await second.post('/api/settings/yue2-cpp', { engine: file, model: file, vae: file })).status,
      200
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8')).yue2.cpp.remote,
      undefined
    );
  } finally {
    for (const close of closers) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
