// @codedna
// description: Integration contracts for imported musical choices, ACE transfer and click-driven AI calls.
// exports: none
// used_by: none
// rules:   Use fake provider responses and disposable credentials; never call paid AI or submit GPU jobs.
// agent:   Codex - 2026-10-04 - Suno Prompt adaptation regression checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmptyState,
  buildPrompt,
  randomPromptState,
  bandBpm,
  effectiveBpm,
} from '../public/prompt-core.mjs';
import { toSonora, cleanLyrics, sectionOrder, parseStructure } from '../public/prompt-adapter.mjs';
import { validateInput } from '../lib.mjs';
import { createPromptAI, windowsProtector, lyricsBudget, sungWordCount } from '../prompt-ai.mjs';

test('local generator resolves original IDs into musical words and exposes competing choices', () => {
  const choices = {
    ...createEmptyState(),
    genres: ['indie-pop'],
    vocal: ['female-warm'],
    instruments: ['Piano'],
    bpm: '105',
    key: ['A Minor'],
    customDetails: 'small room ambience',
  };
  const prompt = buildPrompt(choices);
  assert.match(prompt.optimized, /indie pop/i);
  assert.match(prompt.optimized, /female/i);
  assert.match(prompt.optimized, /warm/i);
  assert.match(prompt.optimized, /105 BPM/);
  assert.match(prompt.optimized, /small room ambience/);
  assert.doesNotMatch(prompt.optimized, /female-warm/);
  const conflict = buildPrompt({ ...choices, mix_master: ['warm-mastering', 'bright-mastering'] });
  assert.ok(conflict.conflicts.length, 'opposing mastering choices must remain visible');
  assert.equal(buildPrompt(createEmptyState()).optimized, '');
});

test('random presets transfer into valid ACE controls without Suno parameters', () => {
  for (let i = 0; i < 40; i++) {
    const choices = randomPromptState(),
      prompt = buildPrompt(choices),
      patch = toSonora(choices, prompt.optimized);
    assert.ok(choices.genres.length && choices.instruments.length);
    assert.ok(patch.tags);
    assert.ok(!('sunoV6' in patch) && !('exclude' in patch));
    assert.doesNotThrow(() =>
      validateInput({ title: 'Preset', duration: 30, lyrics: '[Verse]\nUna luce', ...patch })
    );
  }
});

test('transfer preserves untouched fields, normalizes sections and rejects unsupported values', () => {
  const state = { ...createEmptyState(), key: ['C# Minor'], bpm: '110', vocal: ['female-warm'] };
  assert.deepEqual(toSonora(state, ' Piano '), {
    tags: 'Piano',
    instrumental: false,
    bpm: 110,
    keyscale: 'C# minor',
  });
  assert.deepEqual(
    toSonora(createEmptyState(), 'Piano'),
    { tags: 'Piano' },
    'absence of a voice choice must preserve the composer mode'
  );
  const lyrics = '[Mood: Happy]\n[Verse | soft delivery]\nResta qui\n\n[Chorus]\nCon me';
  assert.equal(toSonora(state, 'Piano', lyrics).lyrics, '[Verse]\nResta qui\n\n[Chorus]\nCon me');
  assert.equal(cleanLyrics('[Verse]\n(non andare)\nResta'), '[Verse]\n(non andare)\nResta');
  assert.deepEqual(sectionOrder({ structure: ['Verse-Pre-Chorus-Chorus'] }), [
    'Verse',
    'Pre-Chorus',
    'Chorus',
  ]);
  assert.throws(() => toSonora({ ...state, bpm: '251' }, 'Piano'));
  assert.throws(() => toSonora(state, ''));
});

function configured(t, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ai-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'DEEPSEEK_API_KEY="fake-private-key"\nUNRELATED_SECRET=unused\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPromptAI({ envFile, model: 'test-model' }, { fetchImpl });
}
const response = content =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), {
    headers: { 'Content-Type': 'application/json' },
  });

test('AI uses server-side configuration, makes no idle calls and validates requests before sending', async t => {
  let count = 0,
    request;
  const ai = configured(t, async (url, options) => {
    count++;
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    request = options;
    return response(
      JSON.stringify({
        boostedPrompt: 'Intimate indie pop, warm female voice, piano, 105 BPM',
        strategy: ['Voce e genere mantenuti.'],
        exclude: 'distortion',
      })
    );
  });
  const st = ai.status();
  assert.deepEqual(
    [st.available, st.provider, st.providerName, st.model, st.canListen],
    [true, 'deepseek', 'DeepSeek', 'test-model', false]
  );
  assert.equal(count, 0);
  await assert.rejects(ai.boost({ basePrompt: '' }));
  await assert.rejects(ai.lyrics({ concept: '', duration: 30 }));
  assert.equal(count, 0);
  const result = await ai.boost({ basePrompt: 'indie pop, female, piano, 105 BPM' });
  assert.equal(count, 1);
  assert.equal(JSON.parse(request.body).response_format.type, 'json_object');
  assert.equal(request.headers.Authorization, 'Bearer fake-private-key');
  assert.match(result.boostedPrompt, /105 BPM/);
  assert.ok(!JSON.stringify(ai.status()).includes('fake-private-key'));
  await assert.rejects(ai.lyrics({ concept: 'Una sera', duration: 301 }));
  assert.equal(count, 1);
});

test('organizing existing lyrics must keep the exact sung words and order', async t => {
  let output = '[Verse]\nResta qui\n[Chorus]\nCon me';
  const ai = configured(t, async () => response(output));
  const input = {
    mode: 'tag-existing',
    existingLyrics: 'Resta qui\nCon me',
    duration: 15,
    structure: ['Verse', 'Chorus'],
  };
  assert.equal((await ai.lyrics(input)).lyrics, output);
  output = '[Verse]\nVai via\n[Chorus]\nDa me';
  await assert.rejects(ai.lyrics(input), /changed the lyrics/);
});

test('AI serializes requests, releases failed calls and redacts provider errors', async t => {
  let release;
  const ai = configured(t, () => new Promise(resolve => (release = resolve)));
  const pending = ai.boost({ basePrompt: 'Piano' });
  await assert.rejects(ai.boost({ basePrompt: 'Guitar' }), /already in progress/);
  release(new Response(JSON.stringify({ error: { message: 'Invalid fake-private-key' } }), { status: 429 }));
  await assert.rejects(
    pending,
    e => e.message.includes('[redacted]') && !e.message.includes('fake-private-key')
  );
  const next = ai.boost({ basePrompt: 'Piano' });
  release(response('not JSON'));
  await assert.rejects(next, /Invalid AI prompt format/);
});

test('key setup verifies before saving, never returns the key and survives a restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ai-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsFile = path.join(dir, 'nested', 'prompt-ai.json');
  let reject = false,
    calls = 0;
  const fake = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer fake-personal-key-123456');
    return reject
      ? new Response('{}', { status: 401 })
      : new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
  };
  const ai = createPromptAI({ credentialsFile }, { fetchImpl: fake });
  await assert.rejects(ai.configure({ apiKey: 'short' }));
  assert.equal(calls, 0);
  assert.ok(!fs.existsSync(credentialsFile));
  const status = await ai.configure({ apiKey: 'fake-personal-key-123456' });
  assert.equal(status.available, true);
  assert.ok(!JSON.stringify(status).includes('fake-personal'));
  const saved = fs.readFileSync(credentialsFile, 'utf8');
  if (windowsProtector) {
    assert.ok(!saved.includes('fake-personal'), 'the key is stored encrypted with DPAPI');
    assert.equal(JSON.parse(saved).keys.deepseek.scheme, 'dpapi-currentuser');
  } else {
    assert.equal(JSON.parse(saved).keys.deepseek.scheme, 'aes-256-gcm-v1');
    assert.ok(!saved.includes('fake-personal'), 'the key is encrypted on Linux');
  }
  const restarted = createPromptAI({ credentialsFile }, { fetchImpl: fake });
  assert.equal(restarted.status().available, true);
  reject = true;
  await assert.rejects(ai.configure({ apiKey: 'fake-personal-key-123456' }), /does not recognize this key/);
  assert.equal(ai.status().available, true, 'failed setup preserves the previous verified key');
});

test('a plain-text key from an older version is migrated to the protected format and still works', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ai-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsFile = path.join(dir, 'prompt-ai.json');
  fs.writeFileSync(credentialsFile, JSON.stringify({ apiKey: 'fake-personal-key-123456' }));
  const protector = {
    scheme: 'test',
    protect: text => Buffer.from(text).toString('base64').split('').reverse().join(''),
    unprotect: data => Buffer.from(data.split('').reverse().join(''), 'base64').toString(),
  };
  assert.equal(createPromptAI({ credentialsFile }, { protector }).status().available, true);
  const saved = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.keys.deepseek.scheme, 'test');
  assert.equal(saved.keys.deepseek.apiKey, undefined);
  assert.ok(!JSON.stringify(saved).includes('fake-personal'));
  assert.equal(
    createPromptAI({ credentialsFile }, { protector }).status().available,
    true,
    'the protected key loads after a restart'
  );
  assert.equal(
    createPromptAI({ credentialsFile }, { protector: { ...protector, scheme: 'other' } }).status().available,
    false,
    'an unknown scheme is never read as a key'
  );
});

test('provider authentication failure disables further AI buttons without exposing credentials', async t => {
  const ai = configured(t, async () => new Response('{}', { status: 401 }));
  await assert.rejects(ai.boost({ basePrompt: 'Piano' }), /key is invalid/);
  assert.equal(ai.status().available, false);
});

test('lyrics budget counts sung words only: tags are free, hooks and vocables count', () => {
  assert.deepEqual(lyricsBudget(60), { target: 54, max: 72 });
  assert.deepEqual(lyricsBudget(10), { target: 9, max: 12 });
  assert.equal(sungWordCount("[Verse]\nWell, that's all right, mama\n[Chorus]\nDa-da-dee, dee"), 7);
});

test('lyrics writing asks for a short hook-based song and retries once only when it runs long', async t => {
  const bodies = [];
  const long = '[Verse]\n' + Array.from({ length: 12 }, () => 'one two three four five six').join('\n');
  const short = '[Verse]\nThat is all right\nThat is all right, mama\n[Chorus]\nOoh, yeah\nThat is all right';
  const ai = configured(t, async (url, options) => {
    bodies.push(options.body);
    return response(bodies.length === 1 ? long : short);
  });
  const result = await ai.lyrics({ concept: 'Una sera', duration: 30, structure: ['Verse', 'Chorus'] });
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /never more than 36/);
  assert.match(bodies[0], /vocables/);
  assert.doesNotMatch(bodies[0], /advance the story/);
  assert.match(bodies[1], /PREVIOUS DRAFT \(72 sung words/);
  assert.equal(result.lyrics, short);
  assert.ok(result.words <= result.maxWords);
  bodies.length = 0;
  const again = await configured(t, async (url, options) => {
    bodies.push(options.body);
    return response(short);
  }).lyrics({ concept: 'Una sera', duration: 30, structure: ['Verse', 'Chorus'] });
  assert.equal(bodies.length, 1);
  assert.equal(again.lyrics, short);
});

test('a chosen tempo band supplies the BPM, and an exact BPM always wins', () => {
  assert.equal(bandBpm('Slow (80-100 BPM)'), '90');
  assert.equal(bandBpm('Very fast (140-160 BPM)'), '150');
  assert.equal(bandBpm('Fast'), '');
  const state = { ...createEmptyState(), tempo: ['Slow (80-100 BPM)'], key: ['G# Minor'] };
  assert.equal(effectiveBpm(state), '90');
  assert.match(buildPrompt(state).optimized, /90 BPM/);
  assert.equal(toSonora(state, 'Piano').bpm, 90);
  assert.equal(toSonora(state, 'Piano').keyscale, 'G# minor');
  const exact = { ...state, bpm: '84' };
  assert.equal(effectiveBpm(exact), '84');
  assert.equal(toSonora(exact, 'Piano').bpm, 84);
  assert.match(buildPrompt(exact).optimized, /84 BPM/);
  assert.doesNotMatch(buildPrompt(exact).optimized, /90 BPM/);
  assert.equal('bpm' in toSonora({ ...createEmptyState(), key: ['C Major'] }, 'Piano'), false);
});

test('a typed section order is parsed, with Italian names and a 16-section cap', () => {
  assert.deepEqual(parseStructure('verse, verse, chorus, verse, bridge, chorus, chorus'), [
    'Verse',
    'Verse',
    'Chorus',
    'Verse',
    'Bridge',
    'Chorus',
    'Chorus',
  ]);
  assert.deepEqual(parseStructure('Intro > strofa > pre-chorus > ritornello > ponte > outro'), [
    'Intro',
    'Verse',
    'Pre-Chorus',
    'Chorus',
    'Bridge',
    'Outro',
  ]);
  assert.deepEqual(parseStructure('boh, niente'), []);
  assert.equal(parseStructure('verse '.repeat(30)).length, 16);
});

test('vocal melody choices reach the prompt unless the song is instrumental', () => {
  const state = {
    ...createEmptyState(),
    melody: ['Wide Vocal Range', 'Vocal Runs'],
    vocal: ['female-vocals'],
  };
  assert.match(buildPrompt(state).optimized, /wide vocal range, vocal runs/);
  assert.match(buildPrompt(state).optimized, /vocal runs/);
  const instrumental = { ...state, vocal: ['instrumental-only'] };
  assert.doesNotMatch(buildPrompt(instrumental).optimized, /vocal runs/);
});
