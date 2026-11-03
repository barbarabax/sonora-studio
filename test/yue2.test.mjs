// @codedna
// description: YuE2 integration: the ABC plan parser and chord editing, input validation, and the full path through the server with a fake RunPod endpoint.
// exports: none
// used_by: none
// rules:   Fake RunPod only; never submit GPU work from tests.
// agent:   claude-sonnet-5-5 - 2026-10-11 - YuE2 as a third music model (plan, edit chords, generate from the plan, keep the plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { validateInput } from '../lib.mjs';
import { createRunpodBackend } from '../runpod-backend.mjs';
import { parsePlan, setChord, isChord, planSummary } from '../public/abc-plan.mjs';

const PLAN = fs.readFileSync(new URL('./fixtures/yue2-plan.abc', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the ABC plan is parsed into header, sections and editable chords', () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(plan.header, { meter: '4/4', unit: '1/16', bpm: 88, key: 'D' });
  assert.equal(plan.singer, 'Vocal');
  assert.deepEqual(
    [...new Set(plan.sections.map(s => s.name))],
    ['intro', 'verse', 'chorus', 'interlude', 'outro']
  );
  // 4 + 4 + 43 + 42 chords in the sung voice; the quoted voice names of the header are not chords
  assert.equal(plan.slots.length, 93);
  assert.deepEqual([...new Set(plan.slots.map(s => s.chord))].sort(), ['A', 'Bm', 'D', 'G']);
  assert.equal(plan.slots[0].section, 'intro');
  assert.equal(plan.slots[0].bar, 1);
  assert.match(planSummary(PLAN), /key D · 88 BPM · 4\/4 · chords: D G Bm A/);
});

test('changing one chord rewrites only that chord', () => {
  const plan = parsePlan(PLAN);
  const first = plan.slots.find(s => s.section === 'chorus');
  const edited = setChord(PLAN, first.id, 'Em7');
  assert.equal(edited.length, PLAN.length - first.chord.length + 'Em7'.length);
  assert.equal(parsePlan(edited).slots[first.id].chord, 'Em7');
  // everything else is byte for byte the same
  const back = setChord(edited, first.id, first.chord);
  assert.equal(back, PLAN.replace(/\r\n/g, '\n'));
  assert.throws(() => setChord(PLAN, first.id, 'H9'), /Invalid chord: write for/);
  assert.throws(() => setChord(PLAN, first.id, 'D"x'), /Invalid chord: write for/);
  assert.throws(() => setChord(PLAN, 9999, 'D'), /Chord not found in/);
  for (const ok of ['D', 'Bm', 'F#m7', 'Cmaj7', 'G/B', 'Asus4', 'Bb', 'E7(b9)']) assert.ok(isChord(ok), ok);
  for (const bad of ['', 'd', 'H', 'Xx', '"D"', 'D'.repeat(13), 'D\nG'])
    assert.ok(!isChord(bad), JSON.stringify(bad));
});

test('YuE2 input: it always sings, takes an ABC plan and refuses ACE-Step-only options', () => {
  const base = {
    musicModel: 'yue2',
    title: 'Prova',
    tags: 'indie rock, male vocal',
    lyrics: '[Verse]\nCiao',
    yueCot: 'melody',
    seed: 5,
  };
  const input = validateInput({ ...base, abc: PLAN });
  assert.equal(input.musicModel, 'yue2');
  assert.equal(input.instrumental, false);
  assert.equal(input.yueCot, 'melody');
  assert.equal(input.abc, PLAN.replace(/\r\n/g, '\n'));
  assert.equal(validateInput(base).abc, undefined);
  assert.throws(() => validateInput({ ...base, lyrics: '' }), /YuE2 sings: enter the/);
  assert.throws(() => validateInput({ ...base, yueCot: 'chords' }), /Invalid plan mode\./);
  // a cover remembers its original song
  const cover = { id: '0b8c1a52-61f1-4b8e-9d3a-2f1c7e5a9b10', title: 'Funiculì', seconds: 165, chords: true };
  assert.deepEqual(validateInput({ ...base, cover }).cover, cover);
  assert.equal(validateInput(base).cover, undefined);
  assert.throws(() => validateInput({ ...base, cover: { ...cover, id: '../x' } }), /cover/);
  assert.throws(() => validateInput({ ...base, cover: { ...cover, chords: 'yes' } }), /cover/);
  assert.throws(() => validateInput({ ...base, abc: 'not a plan' }), /ABC/);
  assert.throws(() => validateInput({ ...base, abc: 'X:1\n'.repeat(15001) + 'K:D' }), /ABC/);
  assert.throws(() => validateInput({ ...base, loraId: crypto.randomUUID() }), /YuE2/);
  assert.throws(() => validateInput({ ...base, referenceId: crypto.randomUUID() }), /YuE2/);
});

test('YuE2 end to end with a fake endpoint: plan, edited plan, song saved with its plan and real length', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-'));
  const flac = Buffer.alloc(5000, 1),
    mp3 = Buffer.alloc(3000, 2);
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const submitted = [];
  const calls = [];
  const adapterCalls = [];
  const fake = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const reply = value => new Response(JSON.stringify(value));
    calls.push(url.replace(/^https:\/\/api\.runpod\.ai\/v2\/[^/]+\//, ''));
    if (url.endsWith('/health')) return reply({ workers: { ready: 0 } });
    if (url.endsWith('/run')) {
      submitted.push(body.input);
      return reply({ id: 'yue-remote-1-abcdef', status: 'IN_QUEUE' });
    }
    if (url.includes('/status/'))
      return reply({
        status: 'COMPLETED',
        output: {
          localId: submitted[0].localId,
          audio: [
            { format: 'flac', bytes: flac.length, sha256: sha(flac) },
            { format: 'mp3', bytes: mp3.length, sha256: sha(mp3) },
          ],
          abc: PLAN,
          seed: 4242,
          cot: 'full',
          duration: 215.4,
          replay: { semanticTokens: '5,6,7,8', abc: PLAN, cot: 'full', lmSeed: 4242, seed: 4242, steps: 32 },
        },
      });
    if (url.endsWith('/runsync')) {
      const input = body.input;
      if (input.action === 'plan')
        return reply({ status: 'COMPLETED', output: { abc: PLAN, seed: 7, seconds: 12 } });
      if (input.action === 'adapters') {
        adapterCalls.push(input);
        return reply({
          status: 'COMPLETED',
          output: { installed: input.install ? input.install.map(a => a.id) : [], cpp: true },
        });
      }
      if (input.action === 'asset') {
        const bytes = input.format === 'flac' ? flac : mp3;
        const chunk = bytes.subarray(input.offset, input.offset + 1500);
        return reply({
          status: 'COMPLETED',
          output: {
            localId: input.localId,
            format: input.format,
            offset: input.offset,
            bytes: chunk.length,
            base64: chunk.toString('base64'),
          },
        });
      }
    }
    return reply({ status: 'IN_PROGRESS' });
  };
  const app = createStudio(
    {
      comfyUrl: 'http://127.0.0.1:1',
      model: 'm',
      encoder: 'e',
      planner: 'p',
      vae: 'v',
      yue2: { endpointId: 'yue2-endpoint' },
    },
    { dataDir: dir, pollMs: 3600000, runpodFetch: fake, runpodKeyReader: () => 'private-test-key' }
  );
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sonora': '1' },
      body: JSON.stringify(body),
    });
  const state = async () => (await fetch(base + '/api/state')).json();

  assert.equal((await (await fetch(base + '/api/config')).json()).yue2Configured, true);
  const switched = await (await post('/api/generation/model', { musicModel: 'yue2' })).json();
  assert.equal(switched.musicModel, 'yue2');
  assert.equal(switched.ready, true);

  // 1. the plan alone: melody and chords, no audio
  const planned = await post('/api/yue2/plan', {
    tags: 'indie rock, male vocal',
    lyrics: '[Verse]\nCiao',
    yueCot: 'full',
    seed: 7,
  });
  assert.equal(planned.status, 200);
  const plan = await planned.json();
  assert.equal(plan.abc, PLAN);
  assert.equal((await post('/api/yue2/plan', { tags: 'x', lyrics: '' })).status, 400);

  // 2. the plan is edited (one chord) and the song is made from it
  const first = parsePlan(plan.abc).slots.find(s => s.section === 'chorus');
  const edited = setChord(plan.abc, first.id, 'Em');
  const generated = await post('/api/generate', {
    musicModel: 'yue2',
    title: 'Dal piano',
    tags: 'indie rock, male vocal',
    lyrics: '[Verse]\nCiao',
    yueCot: 'full',
    abc: edited,
    seed: 4242,
  });
  assert.equal(generated.status, 202);
  const { jobs } = await generated.json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].backend, 'yue2');
  assert.equal(submitted.length, 1);
  assert.deepEqual(
    { ...submitted[0], localId: undefined },
    {
      action: 'generate',
      localId: undefined,
      style: 'indie rock, male vocal',
      lyrics: '[Verse]\nCiao',
      cot: 'full',
      seed: 4242,
      abc: edited,
    }
  );
  assert.equal(submitted[0].localId, jobs[0].id);

  // 3. the endpoint finishes: the song is copied in verified chunks and keeps its plan and real length
  await app.poll();
  const job = (await state()).jobs.find(j => j.id === jobs[0].id);
  assert.equal(job.status, 'done');
  assert.equal(fs.statSync(path.join(dir, 'audio', job.id + '.flac')).size, flac.length);
  assert.equal(fs.statSync(path.join(dir, 'audio', job.id + '.mp3')).size, mp3.length);
  assert.equal(job.yue.abc, PLAN);
  assert.equal(job.yue.cot, 'full');
  assert.equal(job.input.duration, 215);
  assert.equal(job.input.seed, 4242);
  assert.ok(calls.filter(c => c === 'runsync').length >= 5, 'the audio came in several chunks');
  // the semantic codes are kept beside the library, not in it, and allow a new performance of the same song
  assert.equal(job.yue.replay, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')).jobs.find(j => j.id === job.id)
      .remoteAudio.replay,
    undefined
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'yue2-replay', job.id + '.json'), 'utf8')).semanticTokens,
    '5,6,7,8'
  );
  const again = await post(`/api/jobs/${job.id}/rerender`, { steps: 64 });
  assert.equal(again.status, 202);
  const rerun = submitted.at(-1);
  assert.deepEqual(
    [rerun.semanticTokens, rerun.steps, rerun.abc, rerun.action],
    ['5,6,7,8', 64, PLAN, 'generate']
  );
  assert.notEqual(rerun.localId, job.id);
  assert.equal((await again.json()).job.parentId, job.id);
  assert.equal((await post(`/api/jobs/${job.id}/rerender`, { steps: 5 })).status, 400);
  // Continuation uses the saved codes server-side; the browser submits only the chosen times.
  const sourceTokens = Array.from({ length: 500 }, (_, n) => String(n % 100)).join(',');
  fs.writeFileSync(
    path.join(dir, 'yue2-replay', job.id + '.json'),
    JSON.stringify({ semanticTokens: sourceTokens, cot: 'full' })
  );
  const continuation = await post(`/api/jobs/${job.id}/extend`, { from: 2, to: 8, seconds: 20 });
  assert.equal(continuation.status, 202);
  const extended = submitted.at(-1);
  assert.deepEqual(
    [extended.sourceTokens, extended.sourceStart, extended.sourceEnd, extended.duration],
    [sourceTokens, 2, 8, 26]
  );
  assert.equal(extended.semanticTokens, undefined);
  assert.equal((await continuation.json()).job.kind, 'extend');
  assert.equal((await post(`/api/jobs/${job.id}/extend`, { from: 0, to: 25, seconds: 20 })).status, 400);
  assert.equal((await post(`/api/jobs/${job.id}/extend`, { from: 0, to: 8, seconds: 500 })).status, 400);

  // YuE2 makes new songs only, and never a LoRA
  assert.equal(
    (await post('/api/generate', { musicModel: 'yue2', tags: 'x', lyrics: 'y', loraId: crypto.randomUUID() }))
      .status,
    400
  );
  // before yue2.cpp is on the RunPod volume a LoRA is refused, before any job is made
  const before = (await (await fetch(base + '/api/state')).json()).jobs.length;
  const lora = await post('/api/generate', {
    musicModel: 'yue2',
    tags: 'x',
    lyrics: 'y',
    yueHost: 'runpod',
    yueAdapters: [{ id: 'yue2-canzone-italiana', ar: 1, nar: 1 }],
  });
  assert.equal(lora.status, 400);
  assert.match((await lora.json()).error, /yue2.cpp engine is not installed yet/);
  assert.equal((await (await fetch(base + '/api/state')).json()).jobs.length, before);
  // installing a LoRA on RunPod: the worker downloads the pinned files; listing afterwards never calls the GPU
  assert.equal(
    (await (await fetch(base + '/api/yue2/adapters?host=runpod')).json()).adapters.find(
      a => a.id === 'yue2-canzone-italiana'
    ).installed,
    false
  );
  const installed = await (await post('/api/yue2/adapters/yue2-canzone-italiana?host=runpod', {})).json();
  assert.equal(installed.adapters.find(a => a.id === 'yue2-canzone-italiana').installed, true);
  assert.equal(installed.cpp, true);
  assert.match(
    adapterCalls[0].install[0].files[0].url,
    /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//
  );
  const adapterCount = adapterCalls.length;
  await fetch(base + '/api/yue2/adapters?host=runpod');
  assert.equal(adapterCalls.length, adapterCount);
  // a LoRA that is not installed on RunPod is refused too
  const missing = await post('/api/generate', {
    musicModel: 'yue2',
    tags: 'x',
    lyrics: 'y',
    yueHost: 'runpod',
    yueAdapters: [{ id: 'yue2-dreampop', ar: 1, nar: 1 }],
  });
  assert.match((await missing.json()).error, /is not installed on RunPod/);
});

test('copying a finished song reports progress after every verified chunk', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'audio'));
  const flac = crypto.randomBytes(7000),
    mp3 = crypto.randomBytes(2500);
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const fake = async (url, options) => {
    const input = JSON.parse(options.body).input;
    const bytes = input.format === 'flac' ? flac : mp3;
    const chunk = bytes.subarray(input.offset, input.offset + 2000);
    return new Response(
      JSON.stringify({
        status: 'COMPLETED',
        output: {
          localId: input.localId,
          format: input.format,
          offset: input.offset,
          bytes: chunk.length,
          base64: chunk.toString('base64'),
        },
      })
    );
  };
  const backend = createRunpodBackend(
    { endpointId: 'endpoint-test' },
    { fetchImpl: fake, keyReader: () => 'key' }
  );
  const job = { id: crypto.randomUUID(), remote: { endpointId: 'endpoint-test' } };
  const seen = [];
  const assets = await backend.collect(
    job,
    {
      audio: [
        { format: 'flac', bytes: flac.length, sha256: sha(flac) },
        { format: 'mp3', bytes: mp3.length, sha256: sha(mp3) },
      ],
    },
    dir,
    (copied, total) => seen.push([copied, total])
  );
  assert.deepEqual(assets, { flac: job.id + '.flac', mp3: job.id + '.mp3' });
  assert.equal(seen.length, 4 + 2, 'one report per chunk (7000/2000 + 2500/2000)');
  assert.ok(seen.every(([, total]) => total === 9500));
  assert.ok(
    seen.every(([copied], i) => i === 0 || copied > seen[i - 1][0]),
    'always increasing'
  );
  assert.equal(seen.at(-1)[0], 9500);
});
