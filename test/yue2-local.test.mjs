// @codedna
// description: YuE2 on this computer's GPU: plan, generate, status, cancel, failure and copy into the library, with a fake program instead of Python.
// exports: none
// used_by: none
// rules:   No GPU or Python is needed: the "python" of these tests is node running a small fake script that behaves like integrations/local/yue2_local.py.
// agent:   claude-sonnet-5-5 - 2026-10-12 - Backend lifecycle and the whole studio with only the local host configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLocalYue2 } from '../yue2-local.mjs';
import { createStudio } from '../server.mjs';

const PLAN = 'X:1\nM:4/4\nL:1/16\nQ:1/4=90\nV: Vocal\nK:C\n"C"z16|"G"z16|';
const FAKE = `
import fs from 'node:fs';
import crypto from 'node:crypto';
const [requestFile, dir] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const write = (name, value) => fs.writeFileSync(dir + '/' + name, JSON.stringify(value));
const PLAN = ${JSON.stringify(PLAN)};
if (data.style === 'fail') {
  write('error.json', { error: 'boom' });
  process.exit(1);
}
if (data.style === 'slow') {
  console.log('[YuE2] Running Writing tokens: 3/10 (30%) | elapsed 1.0s');
  setInterval(() => {}, 1000);
} else if (data.action === 'plan') {
  write('result.json', { localId: data.localId, abc: PLAN, seed: 7, seconds: 1 });
} else {
  const out = process.env.YUE2_VOLUME + '/yue2/audio/' + data.localId;
  fs.mkdirSync(out, { recursive: true });
  const files = { flac: Buffer.alloc(5000, 1), mp3: Buffer.alloc(3000, 2) };
  for (const [ext, bytes] of Object.entries(files)) fs.writeFileSync(out + '/track.' + ext, bytes);
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  write('result.json', {
    localId: data.localId,
    audio: Object.entries(files).map(([format, b]) => ({ format, bytes: b.length, sha256: sha(b) })),
    abc: PLAN, seed: 4242, cot: 'full', seconds: 2, duration: 12.5,
  });
}
`;
const wait = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
function setup(t, cleanup = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-local-'));
  const script = path.join(dir, 'fake-yue.mjs');
  fs.writeFileSync(script, FAKE);
  if (cleanup)
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return { dir, settings: { python: process.execPath, script, flags: [] } };
}

test('local YuE2: a plan, a song copied into the library, a failure and a cancel', async t => {
  const { dir, settings } = setup(t);
  const local = createLocalYue2(settings, { dataDir: dir });
  assert.equal(local.configured, true);
  assert.equal((await local.health()).ready, true);
  assert.equal((await createLocalYue2({}, { dataDir: dir }).health()).ready, false);
  assert.equal(
    (await createLocalYue2({ python: path.join(dir, 'missing.exe') }, { dataDir: dir }).health()).ready,
    false
  );

  const plan = await local.call(
    { action: 'plan', localId: crypto.randomUUID(), style: 'rock', lyrics: 'x', cot: 'full', seed: 7 },
    8000
  );
  assert.equal(plan.abc, PLAN);

  const job = { id: crypto.randomUUID() };
  job.remote = await local.submitAction({
    action: 'generate',
    localId: job.id,
    style: 'rock',
    lyrics: 'x',
    cot: 'full',
    seed: 4242,
  });
  assert.deepEqual(job.remote, { host: 'local', id: job.id });
  const done = await wait(async () => {
    const state = await local.status(job);
    return state.status === 'COMPLETED' && state;
  });
  const progress = [];
  const assets = await local.collect(job, done.output, dir, (copied, total) =>
    progress.push([copied, total])
  );
  assert.deepEqual(assets, { flac: `${job.id}.flac`, mp3: `${job.id}.mp3` });
  assert.equal(fs.statSync(path.join(dir, 'audio', assets.flac)).size, 5000);
  assert.deepEqual(progress.at(-1), [8000, 8000]);
  assert.ok(
    !fs.existsSync(path.join(dir, 'yue2-local', 'yue2', 'audio', job.id)),
    'the local copy is removed once the library has the song'
  );

  // a damaged or missing copy is refused
  const bad = { ...done.output, audio: done.output.audio.map(a => ({ ...a, sha256: 'a'.repeat(64) })) };
  await assert.rejects(local.collect({ id: crypto.randomUUID() }, bad, dir), /is gone/);

  // a failing program reports its message
  const failing = { id: crypto.randomUUID() };
  failing.remote = await local.submitAction({
    action: 'generate',
    localId: failing.id,
    style: 'fail',
    lyrics: 'x',
  });
  const failed = await wait(async () => {
    const state = await local.status(failing);
    return state.status === 'FAILED' && state;
  });
  assert.equal(failed.error, 'boom');
  await assert.rejects(
    local.call({ action: 'plan', localId: crypto.randomUUID(), style: 'fail', lyrics: 'x' }, 8000),
    /boom/
  );

  // a long job shows its progress and can be cancelled
  const slow = { id: crypto.randomUUID() };
  slow.remote = await local.submitAction({
    action: 'generate',
    localId: slow.id,
    style: 'slow',
    lyrics: 'x',
  });
  const running = await wait(async () => {
    const state = await local.status(slow);
    return state.status === 'IN_PROGRESS' && state.progress === '30%' && state;
  });
  assert.equal(running.progress, '30%');
  await local.cancel(slow);
  assert.equal((await local.status(slow)).status, 'CANCELLED');

  await assert.rejects(local.cancel({ remote: { id: '../etc' } }), /Invalid job identifier\./);
});

test('the studio runs YuE2 on this PC when only the PC is configured', async t => {
  const { dir, settings } = setup(t, false);
  const app = createStudio(
    {
      comfyUrl: 'http://127.0.0.1:1',
      model: 'm',
      encoder: 'e',
      planner: 'p',
      vae: 'v',
      yue2: { local: settings },
    },
    { dataDir: dir, pollMs: 3600000 }
  );
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' },
      body: JSON.stringify(body),
    });
  const config = await (await fetch(base + '/api/config')).json();
  assert.deepEqual([config.yue2Configured, config.yue2Local, config.yue2Runpod], [true, true, false]);
  const switched = await (await post('/api/generation/model', { musicModel: 'yue2' })).json();
  assert.equal(switched.ready, true);

  const planned = await (
    await post('/api/yue2/plan', {
      tags: 'rock',
      lyrics: '[Verse]\nCiao',
      yueCot: 'full',
      seed: 7,
      yueHost: 'local',
    })
  ).json();
  assert.equal(planned.abc, PLAN);

  const generated = await post('/api/generate', {
    musicModel: 'yue2',
    title: 'Sul PC',
    tags: 'rock',
    lyrics: '[Verse]\nCiao',
    yueCot: 'full',
    yueHost: 'local',
    abc: PLAN,
    seed: 4242,
  });
  assert.equal(generated.status, 202);
  const { jobs } = await generated.json();
  assert.equal(jobs[0].remote.host, 'local');
  const finished = await wait(async () => {
    await app.poll();
    const job = (await (await fetch(base + '/api/state')).json()).jobs.find(j => j.id === jobs[0].id);
    return job.status === 'done' && job;
  });
  assert.equal(fs.statSync(path.join(dir, 'audio', finished.id + '.flac')).size, 5000);
  assert.equal(finished.yue.abc, PLAN);
  assert.equal(finished.input.duration, 13);
  assert.equal(
    (await post('/api/generate', { musicModel: 'yue2', tags: 'x', lyrics: 'y', yueHost: 'mars' })).status,
    400
  );
});
