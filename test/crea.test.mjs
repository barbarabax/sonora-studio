import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createStudio } from '../server.mjs';
import { createPromptStore, PROMPT_LIMIT } from '../prompts.mjs';
import { buildWorkflow, validateInput } from '../lib.mjs';
import { guessMeta } from '../public/auto-meta.mjs';
import { sliderToValues, valuesToSlider, parseClock } from '../public/create-ui.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const config = {
  model: 'turbo.safetensors',
  sftModel: 'sft.safetensors',
  encoder: 'enc',
  planner: 'plan',
  vae: 'vae',
};
const ID = '11111111-1111-4111-8111-111111111111';
const base = { tags: 'indie pop', lyrics: '', instrumental: true, duration: 30, finish: 'fast' };

test('negative styles only reach the sampler with the SFT model; a reference adds the timbre nodes', () => {
  const input = validateInput({ ...base, avoid: 'autotune, distorted guitars' });
  assert.equal(input.avoid, 'autotune, distorted guitars');
  const turbo = buildWorkflow(input, 1, ID, config);
  assert.equal(turbo['5'].class_type, 'ConditioningZeroOut');
  assert.equal(turbo['16'], undefined);
  const sft = buildWorkflow({ ...input, finish: 'final' }, 1, ID, config);
  assert.equal(sft['5'], undefined);
  assert.equal(sft['16'].class_type, 'TextEncodeAceStepAudio1.5');
  assert.equal(sft['16'].inputs.tags, 'autotune, distorted guitars');
  assert.equal(sft['16'].inputs.generate_audio_codes, false);
  assert.deepEqual(sft['8'].inputs.negative, ['16', 0]);
  const ref = buildWorkflow(input, 1, ID, config, `Sonora/${ID}.mp3`);
  assert.equal(ref['14'].class_type, 'ReferenceTimbreAudio');
  assert.deepEqual(ref['8'].inputs.positive, ['14', 0]);
  assert.equal(ref['4'].inputs.generate_audio_codes, false);
  assert.throws(
    () =>
      buildWorkflow(input, 1, ID, config, `Sonora/${ID}.mp3`, { audio: `Sonora/${ID}.mp3`, denoise: 0.5 }),
    /cannot be used together/
  );
  assert.throws(() => buildWorkflow(input, 1, ID, config, '../etc/passwd'), /invalid/i);
  assert.throws(() => validateInput({ ...base, avoid: 'x'.repeat(501) }), /avoid/);
  assert.throws(() => validateInput({ ...base, referenceId: '../x' }), /reference audio/i);
  assert.equal(validateInput({ ...base, referenceId: ID }).referenceId, ID);
});

test('Auto guess reads the tempo and mood from the style words and always returns a valid triple', () => {
  assert.deepEqual(guessMeta('sad slow ballad 70 bpm piano'), {
    bpm: 70,
    timesignature: '4',
    keyscale: 'A minor',
  });
  assert.equal(guessMeta('upbeat dance electronic').bpm, 124);
  assert.equal(guessMeta('a waltz for strings').timesignature, '3');
  assert.equal(guessMeta('300 bpm madness').bpm, 105);
  const empty = guessMeta('');
  assert.ok(empty.bpm >= 40 && empty.bpm <= 220 && ['2', '3', '4', '6'].includes(empty.timesignature));
});

test('the melody-freedom slider maps to guidance and temperature and is reversible', () => {
  assert.deepEqual(sliderToValues(0), { guidance: 1, creativity: 1.2 });
  assert.deepEqual(sliderToValues(50), { guidance: 2, creativity: 0.85 });
  assert.deepEqual(sliderToValues(100), { guidance: 4, creativity: 0.6 });
  for (let v = 0; v <= 100; v += 5) {
    const { guidance, creativity } = sliderToValues(v);
    assert.ok(guidance >= 1 && guidance <= 5 && creativity >= 0.5 && creativity <= 1.3);
  }
  assert.equal(valuesToSlider(1), 0);
  assert.equal(valuesToSlider(2), 50);
  assert.equal(valuesToSlider(4), 100);
  assert.equal(valuesToSlider(5), 100);
  assert.equal(parseClock('1:05'), 65);
  assert.equal(parseClock('0:00'), 0);
  assert.equal(parseClock('90'), 90);
  assert.equal(parseClock('abc'), null);
});

test('saved prompts: validated, persisted atomically, limited, importable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-prompts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let changes = 0;
  const store = createPromptStore({ dataDir: dir, onChange: () => changes++ });
  const a = store.create({
    name: ' Notte indie ',
    tags: 'dreamy indie pop',
    lyrics: '[Verse]\nciao',
    label: 'indie',
    options: { bpm: 96, finish: 'final', unknown: 'ignored', autoMeta: ['keyscale'] },
  });
  assert.equal(a.name, 'Notte indie');
  assert.deepEqual(a.options, { bpm: 96, finish: 'final', autoMeta: ['keyscale'] });
  assert.throws(() => store.create({ name: '', tags: 'x' }), /Name/);
  assert.throws(() => store.create({ name: 'n', tags: '' }), /Style/);
  assert.throws(() => store.create({ name: 'n', tags: 'x', options: { bpm: 'fast' } }), /bpm/);
  assert.throws(() => store.create({ name: 'n'.repeat(71), tags: 'x' }), /Name/);
  const b = store.update(a.id, { name: 'Rinominato', used: true });
  assert.equal(b.name, 'Rinominato');
  assert.equal(b.tags, 'dreamy indie pop');
  assert.ok(b.usedAt);
  const second = store.create({ name: 'Secondo', tags: 'lofi' });
  assert.equal(store.list()[0].id, second.id); // newest first until something is used
  store.update(a.id, { used: true });
  assert.equal(store.list()[0].id, a.id); // then the last used
  assert.equal(second.lyrics, '');
  assert.deepEqual(
    store.importMany([{ name: 'Secondo', tags: 'lofi' }, { name: 'Nuovo', tags: 'jazz' }, { nope: 1 }]),
    {
      added: 1,
    }
  );
  const reopened = createPromptStore({ dataDir: dir });
  assert.equal(reopened.list().length, 3);
  assert.equal(fs.existsSync(path.join(dir, 'prompts.json.tmp')), false);
  store.remove(a.id);
  assert.throws(() => store.remove(a.id), /not found/);
  assert.ok(changes >= 4);
  for (let i = store.list().length; i < PROMPT_LIMIT; i++) store.create({ name: 'p' + i, tags: 'x' + i });
  assert.throws(() => store.create({ name: 'troppi', tags: 'x' }), /saved prompt limit/);
});

const request = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method || 'GET', headers: options.headers, agent: false },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });

test(
  'uploads become library songs; a remix and a reference travel to the GPU with their audio',
  { skip: !hasFfmpeg },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-crea-'));
    const submitted = [];
    const fake = async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/health')) return response({ workers: { ready: 0 } });
      if (url.endsWith('/run')) {
        submitted.push(body.input);
        return response({ id: 'remote-' + submitted.length + '-abcdef', status: 'IN_QUEUE' });
      }
      return response({ status: 'IN_PROGRESS' });
    };
    const cfg = {
      comfyUrl: 'http://127.0.0.1:1',
      model: 'm',
      encoder: 'e',
      planner: 'p',
      vae: 'v',
      generationBackend: 'runpod',
      runpod: { endpointId: 'endpoint-test', modelsReady: true, sftReady: true },
      publicOrigin: 'https://sonora.example.test',
    };
    const app = createStudio(cfg, {
      dataDir: dir,
      pollMs: 3600000,
      runpodFetch: fake,
      runpodKeyReader: () => 'private-test-key',
    });
    t.after(async () => {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { Host: 'sonora.example.test', Origin: 'https://sonora.example.test', 'X-Sonora': '1' };
    const json = { ...headers, 'Content-Type': 'application/json' };
    const tone = path.join(dir, 'tone.wav');
    spawnSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=14',
      '-ac',
      '1',
      '-ar',
      '22050',
      tone,
    ]);

    // not audio: rejected, nothing left behind
    let r = await request(url + '/api/library/upload', {
      method: 'POST',
      headers,
      body: Buffer.alloc(4000, 65),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /does not appear to be an audio file/);
    r = await request(url + '/api/library/upload', { method: 'POST', headers, body: Buffer.alloc(10) });
    assert.equal(r.status, 400);
    assert.equal(fs.readdirSync(path.join(dir, 'audio')).length, 0);
    assert.deepEqual(
      fs.existsSync(path.join(dir, 'uploads-tmp')) ? fs.readdirSync(path.join(dir, 'uploads-tmp')) : [],
      []
    );

    // valid mono upload: converted to stereo 44.1 kHz FLAC + MP3 and registered as a finished song
    r = await request(url + '/api/library/upload', {
      method: 'POST',
      headers: { ...headers, 'X-Audio-Name': encodeURIComponent('Il mio brano.wav') },
      body: fs.readFileSync(tone),
    });
    assert.equal(r.status, 201, await r.clone().text());
    const song = await r.json();
    assert.equal(song.title, 'Il mio brano');
    assert.equal(song.kind, 'upload');
    assert.equal(song.status, 'done');
    assert.equal(song.input.duration, 14);
    const probe = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=channels,sample_rate',
      '-of',
      'csv=p=0',
      path.join(dir, 'audio', song.assets.flac),
    ]);
    assert.equal(probe.stdout.toString().trim(), '44100,2');
    assert.ok(fs.existsSync(path.join(dir, 'audio', song.assets.mp3)));
    r = await request(url + '/api/state');
    assert.equal(
      (await r.json()).jobs.some(j => j.id === song.id),
      true
    );

    // remix of the uploaded song with new words: the source audio travels with the job, typed lyrics mean "with voice"
    r = await request(`${url}/api/jobs/${song.id}/rework`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        mode: 'remix',
        tags: 'rock',
        lyrics: '[Verse]\nhello',
        strength: 0.6,
        sourceStart: 0,
        sourceEnd: 12,
        avoid: 'autotune',
      }),
    });
    assert.equal(r.status, 202, await r.clone().text());
    let run = submitted.at(-1);
    assert.ok(run.inputAudio && run.inputAudio.length > 100);
    const graph = run.workflow;
    assert.equal(graph['4'].inputs.lyrics, '[Verse]\nhello');
    assert.equal(graph['4'].inputs.duration, 12);
    assert.equal(graph['12'].class_type, 'LoadAudio');
    assert.equal(graph['8'].inputs.denoise, 0.6);
    assert.equal(graph['5'].class_type, 'ConditioningZeroOut'); // Turbo ignores negative styles
    // a piece that is too short is refused
    r = await request(`${url}/api/jobs/${song.id}/rework`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ mode: 'remix', tags: 'rock', instrumental: true, sourceStart: 0, sourceEnd: 5 }),
    });
    assert.equal(r.status, 400);

    // reference audio: a 60 s MP3 at most, sent with the generation, plus a negative prompt with the SFT model
    r = await request(url + '/api/reference', {
      method: 'POST',
      headers: { ...headers, 'X-Audio-Start': '1', 'X-Audio-Length': '8' },
      body: fs.readFileSync(tone),
    });
    assert.equal(r.status, 201, await r.clone().text());
    const reference = await r.json();
    assert.equal(reference.seconds, 8);
    r = await request(url + '/api/generate', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        ...base,
        referenceId: reference.id,
        avoid: 'autotune',
        finish: 'final',
        duration: 10,
      }),
    });
    assert.equal(r.status, 202, await r.clone().text());
    run = submitted.at(-1);
    assert.ok(run.inputAudio);
    assert.equal(run.workflow['14'].class_type, 'ReferenceTimbreAudio');
    assert.equal(run.workflow['16'].inputs.tags, 'autotune');
    assert.match(run.workflow['12'].inputs.audio, /^Sonora\/[a-f0-9-]{36}\.mp3$/);
    // an unknown reference is refused
    r = await request(url + '/api/generate', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...base, referenceId: ID, duration: 10 }),
    });
    assert.equal(r.status, 400);

    // saved prompts and the Auto endpoint over HTTP
    r = await request(url + '/api/prompts', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'Uno', tags: 'jazz trio' }),
    });
    assert.equal(r.status, 201);
    const saved = await r.json();
    r = await request(url + '/api/state');
    assert.equal((await r.json()).prompts[0].id, saved.id);
    r = await request(`${url}/api/prompts/${saved.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ name: 'Due' }),
    });
    assert.equal((await r.json()).name, 'Due');
    r = await request(`${url}/api/prompts/${saved.id}`, { method: 'DELETE', headers: json, body: '{}' });
    assert.equal(r.status, 200);
    r = await request(url + '/api/prompt/meta', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tags: 'sad piano ballad', fields: ['bpm'] }),
    });
    const meta = await r.json();
    assert.equal(meta.by, 'local');
    assert.equal(meta.keyscale, 'A minor');
  }
);

test(
  'new voice on RunPod: the separated base travels as MP3 with the job and the style no longer says "no vocals"',
  { skip: !hasFfmpeg },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cover-runpod-'));
    const submitted = [];
    const fake = async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/health')) return response({ workers: { ready: 0 } });
      if (url.endsWith('/run')) {
        submitted.push(body.input);
        return response({ id: 'remote-' + submitted.length + '-abcdef', status: 'IN_QUEUE' });
      }
      return response({ status: 'IN_PROGRESS' });
    };
    // A real 4 s tone as the library song; the fake separator writes real stems from it.
    const id = crypto.randomUUID();
    fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
    const flac = path.join(dir, 'audio', id + '.flac');
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-ac', '2', '-ar', '44100', flac]);
    const input = {
      musicModel: 'ace-step',
      title: 'Strumentale',
      tags: 'indie rock, instrumental, no vocals, warm bass',
      lyrics: '',
      instrumental: true,
      duration: 4,
      bpm: 100,
      timesignature: '4',
      keyscale: 'C major',
      language: 'en',
      quality: 'light',
      finish: 'fast',
      variants: 1,
      seed: 1,
    };
    fs.writeFileSync(
      path.join(dir, 'library.json'),
      JSON.stringify({
        version: 1,
        jobs: [{ id, title: 'Strumentale', status: 'done', input, assets: { flac: id + '.flac', mp3: id + '.mp3' } }],
      })
    );
    const audioTask = async task => {
      if (task.action === 'separate') {
        fs.mkdirSync(task.outputDir, { recursive: true });
        for (const name of ['vocals', 'instrumental'])
          fs.copyFileSync(task.source, path.join(task.outputDir, name + '.flac'));
      }
      return { done: true, duration: 4, rate: 44100, frames: 176400, stemAttenuation: 1 };
    };
    const app = createStudio(
      {
        comfyUrl: 'http://127.0.0.1:1',
        model: 'm',
        encoder: 'e',
        planner: 'p',
        vae: 'v',
        generationBackend: 'runpod',
        runpod: { endpointId: 'endpoint-test', modelsReady: true, sftReady: true },
        publicOrigin: 'https://sonora.example.test',
      },
      { dataDir: dir, pollMs: 3600000, runpodFetch: fake, runpodKeyReader: () => 'private-test-key', audioTask }
    );
    t.after(async () => {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { Host: 'sonora.example.test', Origin: 'https://sonora.example.test', 'X-Sonora': '1' };
    const post = (route, body) =>
      request(url + route, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await post(`/api/editor/${id}/separate`, {})).status, 202);
    for (let i = 0; i < 100; i++) {
      const state = await (await request(url + '/api/state', { headers })).json();
      if (state.editor.sessions.find(x => x.id === id)?.status === 'ready') break;
      await new Promise(r => setTimeout(r, 20));
    }
    const response = await post(`/api/editor/${id}/cover`, {
      tags: 'warm indie rock male voice, no vocals',
      lyrics: '[Verse]\nThe last bus drags its wheels',
    });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    assert.equal(job.kind, 'vocal-cover');
    assert.equal(job.parentId, id);
    assert.equal(submitted.length, 1);
    const run = submitted[0];
    assert.ok(run.inputAudio && run.inputAudio.length > 100, 'the base travels with the job');
    assert.equal(run.workflow['14'].class_type, 'ReferenceTimbreAudio');
    assert.equal(run.workflow['12'].inputs.audio, `Sonora/${job.id}.mp3`);
    assert.doesNotMatch(run.workflow['4'].inputs.tags, /no vocals/);
    assert.match(run.workflow['4'].inputs.tags, /male voice/);
    assert.equal(run.workflow['4'].inputs.lyrics, '[Verse]\nThe last bus drags its wheels');
  }
);
