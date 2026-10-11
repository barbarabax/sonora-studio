// @codedna
// description: OpenAI provider: key setup, model choice, text and audio requests, listening route, Audio Lab excerpts.
// exports: none
// used_by: none
// rules:   Fake OpenAI and fake key protection; no network or credit use. FFmpeg is used only if installed.
// agent:   Claude - 2026-10-05 - OpenAI provider with audio input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPromptAI } from '../prompt-ai.mjs';
import { createAudioLab } from '../audio-lab.mjs';
import { createStudio } from '../server.mjs';
import { excerptWindow, excerpt, probeDuration } from '../ai-audio.mjs';

const protector = {
  scheme: 'test',
  protect: text => Buffer.from(text).toString('base64').split('').reverse().join(''),
  unprotect: data => Buffer.from(data.split('').reverse().join(''), 'base64').toString(),
};
const MODELS = [
  'gpt-6.1-sol',
  'gpt-6-luna-mini',
  'gpt-5.6-terra-2026-01-01',
  'gpt-audio-1.5',
  'gpt-realtime-2',
  'whisper-1',
  'text-embedding-3-large',
  'gpt-image-2',
];
const KEY = 'sk-proj-fake-openai-key-1234567890';
const answer = content =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), {
    headers: { 'Content-Type': 'application/json' },
  });
function openai(reply) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url,
      body: options.body ? JSON.parse(options.body) : null,
      auth: options.headers?.Authorization,
    });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS.map(id => ({ id })) }));
    return answer(typeof reply === 'function' ? reply(calls.at(-1)) : reply);
  };
  return { calls, fetchImpl };
}
// close: shut the lab or server down before its folder is removed (it saves on close)
const tmp = (t, close) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ai-'));
  t.after(async () => {
    await close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

test('OpenAI key setup lists models, picks sensible defaults, stores the key encrypted and keeps DeepSeek', async t => {
  const dir = tmp(t),
    credentialsFile = path.join(dir, 'prompt-ai.json');
  fs.writeFileSync(credentialsFile, JSON.stringify({ apiKey: 'deepseek-fake-key-123456789' }));
  const { calls, fetchImpl } = openai('{}');
  const ai = createPromptAI({ credentialsFile }, { fetchImpl, protector });
  assert.equal(ai.status().provider, 'deepseek');
  await assert.rejects(ai.configure({ provider: 'openai' }), /Enter a OpenAI API key first/);
  await assert.rejects(ai.configure({ provider: 'openai', apiKey: 'short' }), /valid OpenAI API key/);
  const status = await ai.configure({ provider: 'openai', apiKey: KEY });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].auth, 'Bearer ' + KEY);
  assert.deepEqual(
    [status.provider, status.model, status.canListen, status.listenModel],
    ['openai', 'gpt-6.1-sol', true, 'gpt-audio-1.5']
  );
  assert.ok(
    !status.providers.openai.textModels.includes('whisper-1') &&
      !status.providers.openai.textModels.includes('gpt-image-2')
  );
  assert.deepEqual(status.providers.openai.audioModels, ['gpt-audio-1.5']);
  assert.ok(!JSON.stringify(status).includes(KEY), 'status never returns the key');
  const saved = fs.readFileSync(credentialsFile, 'utf8');
  assert.ok(!saved.includes(KEY) && !saved.includes('deepseek-fake-key'), 'both keys are stored encrypted');
  await assert.rejects(
    ai.configure({ provider: 'openai', textModel: 'gpt-imaginary' }),
    /cannot access the OpenAI text model/
  );
  assert.equal(
    (await ai.configure({ provider: 'openai', textModel: 'gpt-6-luna-mini', audioModel: null })).canListen,
    false
  );
  const back = await ai.configure({ provider: 'deepseek' });
  assert.deepEqual(
    [back.provider, back.available, back.providers.openai.configured],
    ['deepseek', true, true]
  );
  const restarted = createPromptAI({ credentialsFile }, { fetchImpl, protector });
  assert.deepEqual(
    [restarted.status().provider, restarted.status().providers.openai.textModel],
    ['deepseek', 'gpt-6-luna-mini']
  );
});

test('OpenAI text requests use the chosen model without custom temperature; audio goes only to the listening model', async t => {
  const dir = tmp(t),
    credentialsFile = path.join(dir, 'prompt-ai.json');
  const { calls, fetchImpl } = openai(call =>
    call.body.model === 'gpt-audio-1.5'
      ? 'Ecco il JSON: {"stylePrompt":"warm indie pop, brushed drums, airy female vocals","summary":"Pop intimo.","bpm":"96","key":"F# m","timeSignature":4,"vocal":"female","language":"it","structure":[{"section":"Intro","seconds":"8"},{"section":"Verse"}],"lyricThemes":"Una partenza.","exclude":"distortion","notes":["Batteria leggera."]}'
      : JSON.stringify({ boostedPrompt: 'Indie pop', strategy: ['ok'], exclude: '' })
  );
  const ai = createPromptAI({ credentialsFile }, { fetchImpl, protector });
  await ai.configure({ provider: 'openai', apiKey: KEY });
  await ai.boost({ basePrompt: 'pop' });
  const text = calls.at(-1);
  assert.equal(text.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(text.body.model, 'gpt-6.1-sol');
  assert.ok(
    !('temperature' in text.body) && !('max_tokens' in text.body) && text.body.max_completion_tokens > 1200
  );
  assert.deepEqual(text.body.response_format, { type: 'json_object' });
  const heard = await ai.listen({
    audio: [{ data: 'UklGRg==', format: 'wav' }],
    duration: 200,
    excerpt: '150 s (from 0:15 to 2:45)',
    name: 'demo.mp3',
  });
  const audio = calls.at(-1);
  assert.equal(audio.body.model, 'gpt-audio-1.5');
  assert.deepEqual(audio.body.modalities, ['text']);
  assert.deepEqual(audio.body.messages[1].content[1], {
    type: 'input_audio',
    input_audio: { data: 'UklGRg==', format: 'wav' },
  });
  assert.match(
    audio.body.messages[1].content[0].text,
    /do not transcribe or quote the lyrics; do not name the artist/
  );
  assert.deepEqual(
    [heard.bpm, heard.key, heard.timeSignature, heard.vocal, heard.language],
    [96, 'F# minor', '4', 'female', 'it']
  );
  assert.deepEqual(heard.structure, [
    { section: 'Intro', seconds: 8 },
    { section: 'Verse', seconds: null },
  ]);
  await ai.configure({ provider: 'deepseek', apiKey: 'deepseek-fake-key-123456789' });
  await assert.rejects(
    ai.listen({ audio: [{ data: 'x', format: 'wav' }], duration: 10 }),
    /select OpenAI/
  );
});

test('Audio Lab sends excerpts to a listening model, and only measurements when listening is off', async t => {
  let lab;
  const dir = tmp(t, () => lab?.close()),
    id = randomUUID(),
    job = { id, title: 'Prova', status: 'done', assets: { flac: id + '.flac' }, input: {} };
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio', id + '.flac'), Buffer.alloc(512, 3));
  const prompts = [];
  const { fetchImpl } = openai(call => {
    prompts.push(call.body);
    return JSON.stringify({
      summary: 'Ok.',
      observations: ['Ascolto: voce chiara.'],
      settings: { eq: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0] },
      listening: [],
    });
  });
  const promptAi = createPromptAI(
    { credentialsFile: path.join(dir, 'prompt-ai.json') },
    { fetchImpl, protector }
  );
  await promptAi.configure({ provider: 'openai', apiKey: KEY });
  const windows = [];
  lab = createAudioLab({
    root: dir,
    dataDir: dir,
    getJob: x => (x === id ? job : null),
    getMix: () => null,
    promptAi,
    runTask: async () => ({
      done: true,
      analysis: {
        technical: { duration: 200 },
        loudness: { integrated: -12 },
        spectrum: {},
        stereo: {},
        integrity: {},
      },
    }),
    excerptImpl: async (file, w) => (windows.push({ file, ...w }), { data: 'UklGRg==', format: 'wav', ...w }),
  });
  const s = lab.create({ kind: 'job', jobId: id });
  for (let i = 0; i < 100 && s.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 5));
  const advice = await lab.advice(s.id, {});
  assert.equal(advice.heard, true);
  assert.deepEqual(windows[0], { file: path.join(dir, 'audio', id + '.flac'), start: 57.5, seconds: 45 });
  assert.equal(prompts.at(-1).model, 'gpt-audio-1.5');
  assert.match(
    prompts.at(-1).messages[1].content[0].text,
    /You CAN hear audio: audio 1 is an excerpt of the source track before mastering, from 0:57 to 1:42/
  );
  const silent = await lab.advice(s.id, { listen: false });
  assert.equal(silent.heard, false);
  assert.equal(prompts.at(-1).model, 'gpt-6.1-sol');
  assert.match(prompts.at(-1).messages[1].content, /You have NOT heard the audio/);
  assert.equal(windows.length, 1);
});

test('listening route: upload is temporary, long songs are trimmed to 150 s, DeepSeek is refused', async t => {
  let app;
  const dir = tmp(t, () => app?.close());
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, jobs: [] }));
  const { fetchImpl } = openai(
    JSON.stringify({
      stylePrompt: 'lofi, warm piano',
      summary: 'Lo-fi.',
      bpm: 80,
      key: 'C major',
      vocal: 'instrumental',
      structure: [],
    })
  );
  const windows = [];
  app = createStudio(
    { model: 'm', encoder: 'e', planner: 'p', vae: 'v', comfyUrl: 'http://127.0.0.1:9' },
    {
      dataDir: dir,
      pollMs: 1e8,
      aiFetch: fetchImpl,
      aiProtector: protector,
      audioTools: {
        probeDuration: async () => 240,
        excerpt: async (file, w) => (
          windows.push({ exists: fs.existsSync(file), ...w }),
          { data: 'UklGRg==', format: 'wav', ...w }
        ),
      },
    }
  );
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body, headers = {}) =>
    fetch(base + route, { method: 'POST', headers: { 'X-Sonora': '1', ...headers }, body });
  const upload = () =>
    post('/api/prompt-ai/listen', Buffer.alloc(4096, 1), {
      'Content-Type': 'application/octet-stream',
      'X-Audio-Name': encodeURIComponent('Brano.mp3'),
    });
  assert.equal((await upload()).status, 400, 'no listening provider yet');
  assert.equal(
    (
      await post('/api/prompt-ai/config', JSON.stringify({ provider: 'openai', apiKey: KEY }), {
        'Content-Type': 'application/json',
      })
    ).status,
    200
  );
  const r = await upload();
  const result = await r.json();
  assert.equal(r.status, 200, JSON.stringify(result));
  assert.deepEqual(
    [result.stylePrompt, result.key, result.heardSeconds, result.duration],
    ['lofi, warm piano', 'C major', 150, 240]
  );
  assert.deepEqual(windows[0], { exists: true, start: 36, seconds: 150 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'ai-uploads')), [], 'the upload is deleted after listening');
  assert.equal((await fetch(base + '/api/prompt-ai/listen', { method: 'POST', body: 'x' })).status, 403);
});

test('excerpt windows stay inside the track, and FFmpeg produces a mono WAV excerpt', async t => {
  assert.deepEqual(excerptWindow(30, 45), { start: 0, seconds: 30 });
  assert.deepEqual(excerptWindow(200, 45), { start: 57.5, seconds: 45 });
  assert.deepEqual(excerptWindow(100, 45, 0.95), { start: 55, seconds: 45 });
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('FFmpeg non installato');
  const dir = tmp(t),
    file = path.join(dir, 'tone.flac');
  spawnSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6:sample_rate=44100',
    '-ac',
    '2',
    file,
  ]);
  assert.ok(Math.abs((await probeDuration(file)) - 6) < 0.1);
  const part = await excerpt(file, { start: 1, seconds: 2 });
  const wav = Buffer.from(part.data, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 24000, '24 kHz');
  assert.ok(Math.abs(wav.length - 44 - 2 * 24000 * 2) < 2000, 'about two seconds of 16-bit audio');
});
