// @codedna
// description: Personal AI services (DeepSeek or OpenAI) for prompts, lyrics, mastering advice and listening to audio.
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
// 
//
// 
//
// 
//
// exports: windowsProtector | PROVIDERS | lyricsBudget | sungWordCount | createPromptAI
// used_by: sonora-studio/server.mjs
// rules:   Keep credentials server-side. Only make an AI request after an explicit UI action. Audio goes only to providers that can hear it.
// agent:   Codex - 2026-10-04 - Adapted Suno Prompt AI functions for local Sonora.
// Claude - 2026-10-05 - OpenAI provider with audio input (gpt-audio) next to DeepSeek.
// claude-sonnet-5-5 - 2026-10-08 - Lyrics: short hook-based songs, word budget from the duration, one retry when too long.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFileProtector } from './credentials.mjs';

// Windows DPAPI (CurrentUser): the saved key can be decrypted only by this Windows account on this PC.
// The key travels through stdin, never through command-line arguments.
function powershell(script, input) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security;' + script],
    { input, encoding: 'utf8', windowsHide: true, timeout: 30000 }
  );
  if (r.status !== 0) throw new Error('Key protection is unavailable.');
  return r.stdout.trim();
}
export const windowsProtector =
  process.platform === 'win32'
    ? {
        scheme: 'dpapi-currentuser',
        protect: text =>
          powershell(
            "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,'CurrentUser'))",
            text
          ),
        unprotect: data =>
          powershell(
            "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()),$null,'CurrentUser'))",
            data
          ),
      }
    : null;

export const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    keys: 'https://platform.deepseek.com/api_keys',
  },
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', keys: 'https://platform.openai.com/api-keys' },
};
const DEFAULT_AUDIO_MODEL = 'gpt-audio-1.5';
// Chat models that can take part in a text conversation; excludes images, speech, embeddings, realtime…
const isOpenAIChatModel = id =>
  /^(gpt-|o\d|chatgpt-)/.test(id) &&
  !/(audio|realtime|transcribe|tts|whisper|embedding|image|dall-e|moderation|search|live|translate|instruct)/.test(
    id
  );
const isOpenAIAudioModel = id => /audio/.test(id) && !/(realtime|transcribe|tts)/.test(id);
const versionOf = id => Number((/^gpt-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || 0);
// Highest-version general model, skipping dated snapshots and the small "mini"/"nano" variants.
function defaultTextModel(ids) {
  const plain = ids.filter(id => isOpenAIChatModel(id) && !/\d{4}-\d{2}-\d{2}$/.test(id));
  const pool = plain.filter(id => !/(mini|nano)/.test(id));
  return (
    [...(pool.length ? pool : plain)].sort((a, b) => versionOf(b) - versionOf(a) || a.length - b.length)[0] ||
    null
  );
}
const validModelId = id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(id);

/**
 * Sung-word budget for a clip of `duration` seconds.
 * Real songs repeat their hook and use vocables, so lyric sheets stay short: about 0.9 words/s as the target and
 * 1.2 words/s as a ceiling (beyond that an audio model rushes the singing or drops words).
 */
export function lyricsBudget(duration) {
  return { target: Math.max(8, Math.round(duration * 0.9)), max: Math.max(12, Math.round(duration * 1.2)) };
}
/** Sung words of a lyric sheet: section tags are not words; repeated lines and vocables count. */
export const sungWordCount = value =>
  String(value)
    .replace(/\[[^\]]+\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

export function createPromptAI(settings = {}, { fetchImpl = fetch, protector = undefined } = {}) {
  const file = settings.credentialsFile;
  if (protector === undefined)
    protector =
      windowsProtector ||
      (file
        ? createFileProtector(
            process.env.SONORA_SECRET_FILE || path.join(path.dirname(file), '.credential-key')
          )
        : null);
  const usableKey = value =>
    typeof value === 'string' &&
    !/^(?:your[_-].*|replace[_-].*|change.?me|sk[-_](?:your.*|x{4,}|.*_here))$/i.test(value.trim())
      ? value.trim()
      : '';
  const keys = { deepseek: '', openai: '' },
    invalid = { deepseek: false, openai: false };
  let provider = 'deepseek';
  const models = {
    deepseek: settings.model || process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    openaiText: null,
    openaiAudio: DEFAULT_AUDIO_MODEL,
    openaiList: [],
  };
  keys.deepseek = process.env.DEEPSEEK_API_KEY || '';
  keys.openai = process.env.OPENAI_API_KEY || '';
  if (settings.envFile && fs.existsSync(settings.envFile)) {
    for (const line of fs.readFileSync(settings.envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?(DEEPSEEK_API_KEY|DEEPSEEK_MODEL)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let value = m[2];
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '');
      if (m[1] === 'DEEPSEEK_API_KEY') keys.deepseek = usableKey(value) || keys.deepseek;
      else if (!settings.model) models.deepseek = value || models.deepseek;
    }
  }
  const sealed = key =>
    protector ? { scheme: protector.scheme, apiKeyProtected: protector.protect(key) } : { apiKey: key };
  const unsealed = entry => {
    if (typeof entry?.apiKeyProtected === 'string' && protector && entry.scheme === protector.scheme)
      return protector.unprotect(entry.apiKeyProtected);
    if (typeof entry?.apiKey === 'string') return entry.apiKey;
    return '';
  };
  let stored = { version: 2, provider: 'deepseek', keys: {}, models: {} };
  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(stored, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version === 2)
        stored = { ...stored, ...saved, keys: saved.keys || {}, models: saved.models || {} };
      else
        stored.keys.deepseek = {
          scheme: saved.scheme,
          apiKeyProtected: saved.apiKeyProtected,
          apiKey: saved.apiKey,
        }; // version 1: a single DeepSeek key
      for (const name of Object.keys(PROVIDERS)) {
        const key = usableKey(unsealed(stored.keys[name]));
        if (key) keys[name] = key;
        if (key && protector && stored.keys[name]?.scheme !== protector.scheme)
          stored.keys[name] = sealed(key); // migrate plain text
        else if (stored.keys[name] && !stored.keys[name].apiKeyProtected && !stored.keys[name].apiKey)
          delete stored.keys[name];
      }
      if (PROVIDERS[stored.provider]) provider = stored.provider;
      const o = stored.models.openai || {};
      if (Array.isArray(o.list)) models.openaiList = o.list.filter(validModelId).slice(0, 400);
      if (validModelId(o.text)) models.openaiText = o.text;
      if (validModelId(o.audio) || o.audio === null) models.openaiAudio = o.audio;
      if (saved.version !== 2 || JSON.stringify(saved) !== JSON.stringify(stored)) persist();
    } catch {}
  }
  for (const name of Object.keys(keys)) keys[name] = usableKey(keys[name]);
  if (!models.openaiText && models.openaiList.length) models.openaiText = defaultTextModel(models.openaiList);

  const ready = name => !!keys[name] && !invalid[name] && (name !== 'openai' || !!models.openaiText);
  const canListen = () => provider === 'openai' && !!keys.openai && !invalid.openai && !!models.openaiAudio;
  const status = () => ({
    available: ready(provider),
    provider,
    providerName: PROVIDERS[provider].name,
    model: provider === 'openai' ? models.openaiText : models.deepseek,
    canListen: canListen(),
    listenModel: canListen() ? models.openaiAudio : null,
    providers: {
      deepseek: {
        configured: !!keys.deepseek,
        invalid: invalid.deepseek,
        model: models.deepseek,
        keysUrl: PROVIDERS.deepseek.keys,
      },
      openai: {
        configured: !!keys.openai,
        invalid: invalid.openai,
        textModel: models.openaiText,
        audioModel: models.openaiAudio,
        textModels: models.openaiList.filter(isOpenAIChatModel),
        audioModels: models.openaiList.filter(isOpenAIAudioModel),
        keysUrl: PROVIDERS.openai.keys,
      },
    },
  });
  let busy = false;

  async function listModels(name, key) {
    const response = await fetchImpl(PROVIDERS[name].base + '/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? `${PROVIDERS[name].name} does not recognize this key. Check it and try again.`
          : `${PROVIDERS[name].name} verification failed (error ${response.status}).`
      );
    const result = await response.json();
    if (!Array.isArray(result.data))
      throw new Error(`Invalid ${PROVIDERS[name].name} verification response.`);
    return result.data.map(m => m?.id).filter(validModelId);
  }
  // body: {provider, apiKey?, textModel?, audioModel?, refresh?}. Without apiKey it switches provider or models.
  async function configure(body = {}) {
    const name = body.provider ?? provider;
    if (!PROVIDERS[name]) throw new Error('Unsupported AI provider.');
    if (busy) throw new Error('Wait for the current AI request to finish before changing settings.');
    if (!file) throw new Error('AI settings cannot be saved.');
    const candidate = body.apiKey;
    if (candidate !== undefined && candidate !== '') {
      if (
        typeof candidate !== 'string' ||
        candidate.trim().length < 20 ||
        candidate.length > 512 ||
        /\s/.test(candidate.trim())
      )
        throw new Error(`Enter a valid ${PROVIDERS[name].name} API key.`);
    } else if (!keys[name]) throw new Error(`Enter a ${PROVIDERS[name].name} API key first.`);
    busy = true;
    try {
      const key = candidate ? candidate.trim() : keys[name];
      if (candidate || body.refresh || (name === 'openai' && !models.openaiList.length)) {
        const ids = await listModels(name, key);
        if (name === 'openai') {
          models.openaiList = ids.slice(0, 400);
          if (!models.openaiText || !ids.includes(models.openaiText))
            models.openaiText = defaultTextModel(ids);
          if (!ids.includes(models.openaiAudio))
            models.openaiAudio = ids.includes(DEFAULT_AUDIO_MODEL)
              ? DEFAULT_AUDIO_MODEL
              : ids.find(isOpenAIAudioModel) || null;
        }
        keys[name] = key;
        invalid[name] = false;
        stored.keys[name] = sealed(key);
      }
      if (name === 'openai') {
        const list = models.openaiList;
        if (body.textModel !== undefined) {
          if (!validModelId(body.textModel) || (list.length && !list.includes(body.textModel)))
            throw new Error('The selected API key cannot access the OpenAI text model.');
          models.openaiText = body.textModel;
        }
        if (body.audioModel !== undefined) {
          if (body.audioModel === null || body.audioModel === '') models.openaiAudio = null;
          else if (!validModelId(body.audioModel) || (list.length && !list.includes(body.audioModel)))
            throw new Error('The selected API key cannot access the OpenAI audio model.');
          else models.openaiAudio = body.audioModel;
        }
        if (!models.openaiText)
          throw new Error('No OpenAI text models are available for this API key.');
        stored.models.openai = {
          text: models.openaiText,
          audio: models.openaiAudio,
          list: models.openaiList,
        };
      }
      provider = name;
      stored.provider = name;
      persist();
      return status();
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`${PROVIDERS[name].name} verification timed out. Try again.`);
      throw e;
    } finally {
      busy = false;
    }
  }

  // audio: [{data: base64, format: 'wav'}] — only for providers that can listen.
  async function completion(
    prompt,
    maxTokens,
    jsonMode = false,
    {
      temperature = 1.1,
      system = 'You are a careful music producer and original songwriter. Follow the requested output format.',
      audio = null,
    } = {}
  ) {
    const name = provider,
      label = PROVIDERS[name].name;
    if (!ready(name)) throw new Error(`${label} is not configured. Open Configure AI and enter the key.`);
    if (audio?.length && !canListen())
      throw new Error('To analyze audio, select OpenAI with an audio model in Configure AI.');
    if (busy) throw new Error('An AI request is already in progress. Wait for it to finish.');
    busy = true;
    const key = keys[name];
    try {
      let body;
      if (name === 'deepseek')
        body = {
          model: models.deepseek,
          thinking: { type: 'disabled' },
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        };
      else if (audio?.length)
        body = {
          model: models.openaiAudio,
          modalities: ['text'],
          max_completion_tokens: maxTokens + 1000,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                ...audio.map(a => ({
                  type: 'input_audio',
                  input_audio: { data: a.data, format: a.format || 'wav' },
                })),
              ],
            },
          ],
        };
      // Current OpenAI text models reason before answering: no custom temperature, and room for reasoning tokens.
      else
        body = {
          model: models.openaiText,
          max_completion_tokens: maxTokens + 8000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        };
      const response = await fetchImpl(PROVIDERS[name].base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(audio?.length ? 240000 : 180000),
      });
      if (!response.ok) {
        if (response.status === 401) {
          invalid[name] = true;
          throw new Error(`The ${label} key is invalid. Enter it again in Configure AI and try again.`);
        }
        let message = `${label} returned error ${response.status}.`;
        try {
          const detail = await response.json();
          if (typeof detail.error?.message === 'string')
            message += ' ' + detail.error.message.slice(0, 350).replaceAll(key, '[redacted]');
        } catch {}
        if (response.status === 404)
          message += ` Check the selected model in Configure AI (${body.model}).`;
        throw new Error(message);
      }
      const result = await response.json();
      if (result.choices?.[0]?.finish_reason === 'length')
        throw new Error('AI response is too long and incomplete. Try again.');
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim())
        throw new Error(`${label} did not return a result.`);
      return content.trim();
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error(`${label} timed out. You can try again.`);
      throw e;
    } finally {
      busy = false;
    }
  }
  const parseJson = (raw, message) => {
    const text = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(text);
    } catch {
      const inner = /\{[\s\S]*\}/.exec(text); // audio models may wrap the JSON in a sentence
      try {
        if (inner) return JSON.parse(inner[0]);
      } catch {}
      throw new Error(message);
    }
  };
  const lines = (value, max, length = 400) =>
    Array.isArray(value)
      ? value
          .filter(v => typeof v === 'string' && v.trim())
          .map(v => v.trim().slice(0, length))
          .slice(0, max)
      : [];
  const text = (body, key, max, fallback = '') => {
    const v = body[key] ?? fallback;
    if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${key} field.`);
    return v.trim();
  };

  async function boost(body) {
    const basePrompt = text(body, 'basePrompt', 3000),
      exclude = text(body, 'exclude', 2000);
    if (!basePrompt) throw new Error('Build a prompt with the music categories first.');
    const raw = await completion(
      `Improve this music STYLE prompt for ACE-Step 1.5, without writing lyrics.
Base prompt: ${basePrompt}
Avoid these competing concepts: ${exclude || '(none)'}
Preserve the user's genre, voice choice, instruments, BPM and key. Order by priority: genre, mood, vocals, instruments, production, BPM/key. Remove duplicate or contradictory descriptors. Do not invent unsupported claims about model controls. Artist references should become concrete sonic traits. Keep instrumental prompts explicitly instrumental, with no vocals. Use concise English music descriptors (maximum 180 words).
Return ONLY JSON: {"boostedPrompt":"style prompt","strategy":["2-4 short explanations in Italian"],"exclude":"comma-separated excluded concepts"}.`,
      1200,
      true
    );
    const result = parseJson(raw, 'Invalid AI prompt format.');
    if (
      typeof result.boostedPrompt !== 'string' ||
      !result.boostedPrompt.trim() ||
      result.boostedPrompt.length > 3000
    )
      throw new Error('The AI prompt is empty or too long.');
    return {
      boostedPrompt: result.boostedPrompt.trim(),
      strategy: Array.isArray(result.strategy)
        ? result.strategy.filter(s => typeof s === 'string').slice(0, 6)
        : [],
      exclude: typeof result.exclude === 'string' ? result.exclude.slice(0, 2000) : '',
    };
  }

  async function lyrics(body) {
    const concept = text(body, 'concept', 2500),
      language = text(body, 'language', 40, 'Italian'),
      tone = text(body, 'tone', 100, 'intimate'),
      pov = text(body, 'pov', 100, 'first person'),
      existing = text(body, 'existingLyrics', 12000),
      context = text(body, 'musicalContext', 3000),
      voice = text(body, 'vocalType', 100, 'as described in the music prompt');
    const mode = text(body, 'mode', 20, 'write');
    if (!['write', 'tag-existing'].includes(mode)) throw new Error('Invalid lyrics mode.');
    if (mode === 'write' && !concept) throw new Error('Describe the song idea.');
    if (mode === 'tag-existing' && !existing) throw new Error('Enter the lyrics to structure.');
    const structure = body.structure ?? ['Verse', 'Chorus', 'Verse', 'Chorus', 'Bridge', 'Chorus', 'Outro'];
    if (
      !Array.isArray(structure) ||
      !structure.length ||
      structure.length > 16 ||
      structure.some(s => typeof s !== 'string' || s.length > 50)
    )
      throw new Error('Invalid song structure.');
    const duration = body.duration ?? 60;
    if (!Number.isInteger(duration) || duration < 10 || duration > 300) throw new Error('Invalid duration.');
    const budget = lyricsBudget(duration);
    // Rules: "write" mode is a short, hook-based sheet like a real song (repetition and vocables, no storytelling);
    // "tag-existing" only organises the user's words and gets no style or length instructions.
    const style =
      mode === 'write'
        ? `Write like a real song, not like a story or a poem: few words, a strong hook, a lot of repetition. Real lyric sheets are short. Repeat the hook line, answer a line by repeating it, and use sung vocables (such as "ooh", "yeah", "hey", "oh-oh-oh", "la la la", "da-da-dee", "whoa") on their own lines or inside lines, the way the genre in the musical context does (blues and rockabilly refrains, pop hooks, punk shouts, sparse ballad lines).
Length: about ${budget.target} sung words in total and never more than ${budget.max}; section tags are not words, but repeated lines and vocables count. Lines are short: usually 3 to 7 words, never more than 9. Typical sizes: verse 2-4 lines, chorus 2-4 lines built on one repeated hook, bridge 1-2 lines, intro or outro 1-2 lines or just vocables. Do not narrate or explain: one concrete image and one feeling per section, and leave room to breathe. A verse may be a single line sung two or three times.
Keep the metre consistent and the lines easy to sing. Use natural rhymes without forcing words. A bridge brings one new image; an outro may return to an earlier image. Avoid generic AI clichés such as neon haze, symphony of, echoes in the dark, story unfolds, down on my knees. Backing vocal parentheses should be sparse and inside lyric lines only.`
        : '';
    const prompt = `Target: ACE-Step 1.5 music generation. ${mode === 'tag-existing' ? 'Organize the supplied lyrics with section tags, preserving every sung word and its order.' : 'Write original, singable song lyrics.'}
Language: ${language}. Idea: ${concept}. Tone: ${tone}. Point of view: ${pov}. Voice: ${voice}.
Musical context: ${context || '(not specified)'}. Approximate audio duration: ${duration} seconds.
Requested section order: ${structure.join(' > ')}. Use exactly this order, without adding sections.
Use plain section tags such as [Verse], [Chorus], [Bridge], [Intro], [Outro]. Do not use Suno-specific metadata, pipe-delimited delivery hints, sliders, or stage directions in standalone parentheses.
${mode === 'write' ? 'Delivery cues (ACE-Step reads them): after a tag you may add one or two English words, e.g. [Verse - whispered], [Chorus - anthemic], [Bridge - stripped back]; use them on at most half of the sections. UPPERCASE marks a word to shout or stress, rarely. A background echo goes in parentheses at the end of the same line, never on a line of its own. Lines of 6-10 syllables sing most naturally.' : ''}
${style}
${existing ? 'Existing lyrics:\n' + existing : ''}
Return ONLY lyrics in ${language}, with section tags, no introduction, no markdown fences, no commentary.`;
    const tidy = raw =>
      raw
        .replace(/^```[^\n]*\n/, '')
        .replace(/\n```$/, '')
        .trim();
    let result = tidy(await completion(prompt, 3000));
    // Rules: one retry at most, only when the draft is over the ceiling; the shorter draft wins, never a longer one.
    if (mode === 'write' && sungWordCount(result) > budget.max) {
      const shorter = tidy(
        await completion(
          `${prompt}\n\nPREVIOUS DRAFT (${sungWordCount(result)} sung words, too long: the maximum is ${budget.max}, the target ${budget.target}):\n${result}\n\nRewrite it shorter. Keep the idea and the hook, cut narrative lines, repeat the hook instead of adding new lines, and use vocables where the genre does. Return ONLY the new lyrics, with section tags.`,
          3000
        )
      );
      if (sungWordCount(shorter) < sungWordCount(result)) result = shorter;
    }
    if (result.length > 12000) throw new Error('AI lyrics exceed Sonora’s limit.');
    if (mode === 'tag-existing') {
      const sungWords = value =>
        value
          .replace(/\[[^\]]+\]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      if (sungWords(existing) !== sungWords(result))
        throw new Error('AI changed the lyrics. Your original is preserved; try again.');
    }
    return mode === 'write'
      ? { lyrics: result, words: sungWordCount(result), maxWords: budget.max }
      : { lyrics: result };
  }

  // Audio Lab. Measurements always; with a listening provider also short excerpts (source, then reference).
  // Settings are clamped again by audio-lab.mjs.
  async function mastering({
    analysis,
    reference = null,
    current,
    render = null,
    goal = '',
    ranges,
    bands = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    modes,
    audio = null,
  }) {
    const heard = audio?.length
      ? `You CAN hear audio: ${audio.map((a, i) => `audio ${i + 1} is ${a.label}`).join('; ')}. Combine what you hear (tone, balance, dynamics, harshness, muddiness, vocal clarity, stereo image) with the measurements, and in each observation say whether it comes from listening, from the measurements, or both. Do not promise a quality improvement.`
      : 'You have NOT heard the audio: you only receive objective measurements, so describe what the numbers indicate and never claim to hear it. Do not promise a quality improvement.';
    const raw = await completion(
      `You are advising on the mastering of one song in a local tool. ${heard}
The engine applies, in this order: 30 Hz high-pass; 10-band graphic EQ, peaking filters with Q 1.4 centred at ${bands.join(', ')} Hz (settings.eq is an array of 10 gains in dB, in that order); compressor preset (gentle: -18 dB 2:1, tight: -22 dB 3.5:1, punch: -24 dB 5:1, stereo-linked); stereo width (mid/side, 1 = unchanged); reverb preset (small/studio/large, filtered and subtle); integrated loudness normalisation to targetLufs with a true-peak limiter at ceiling dBTP.
Measurement legend: loudness.integrated LUFS (BS.1770), truePeak dBTP (4x oversampled), samplePeak dBFS, plr = truePeak - integrated (dB), crest = sample peak - RMS (dB), lra = EBU loudness range (LU). spectrum.bands are % of energy: sub 20-60 Hz, bass 60-250 Hz, lowMid 250 Hz-2 kHz, presence 2-6 kHz, air 6-20 kHz (bands do not match the EQ bands). spectrum.octaves are octave-band levels in dB relative to their mean; tilt is dB per octave between 100 Hz and 10 kHz; centroid Hz. stereo.correlation and lowCorrelation (below 150 Hz) range -1..1; width % is side energy share (0 = mono); balance dB left minus right; monoLoss dB when summed to mono. integrity: dcOffset %, clippedRuns = runs of 3+ samples at full scale, head/tailSilence s, noiseFloor dBFS. Render loudness: target, reached, gap (LU), truePeak, gain (dB applied before limiting), passes.
Allowed numeric ranges [min,max,step]: ${JSON.stringify(ranges)}. Allowed modes: ${JSON.stringify(modes)}.
Translate every tonal imbalance you identify into concrete EQ gains (typically ±1 to ±4 dB on the relevant bands); do not leave the EQ flat when your own observations describe a spectral imbalance. settings.eq holds absolute gains for a flat starting point, not changes relative to the current settings. If you deliberately recommend no change for a control, say so explicitly in the summary. Keep changes moderate. Keep reverb off unless the mix is very dry and the goal asks for space. Do not widen when low-frequency correlation is low or mono loss is large. Avoid targets that force heavy limiting of dynamic material (high PLR); explain the loudness/dynamics trade-off.
Source measurements: ${JSON.stringify(analysis)}
${reference ? 'Reference track measurements (match tonal balance and loudness only where sensible): ' + JSON.stringify(reference) : 'No reference track.'}
${render ? 'Latest render with its settings and resulting measurements: ' + JSON.stringify(render) : 'No render yet.'}
Current settings: ${JSON.stringify(current)}
User goal: ${goal || '(none: a clean, balanced master for streaming)'}
Return ONLY JSON: {"summary":"2-3 sentences in Italian","observations":["3-6 short observations in Italian, each citing its source"],"settings":{"eq":[0,0,0,0,0,0,0,0,0,0],"compressor":"off","reverb":"off","width":1,"targetLufs":-14,"ceiling":-1},"listening":["1-3 things in Italian to check by ear in the A/B comparison"]}`,
      1400,
      true,
      {
        temperature: 0.3,
        system:
          'You are a careful mastering engineer. You reason from the supplied measurements (and audio, when provided) and follow the requested output format.',
        audio,
      }
    );
    const result = parseJson(raw, 'Invalid AI suggestions format. Try again.');
    if (
      typeof result?.summary !== 'string' ||
      !result.summary.trim() ||
      !result.settings ||
      typeof result.settings !== 'object' ||
      Array.isArray(result.settings)
    )
      throw new Error('AI suggestions are incomplete. Try again.');
    const settings = {};
    const eqIn = result.settings.eq,
      num = v =>
        typeof v === 'number'
          ? v
          : typeof v === 'string' && v.trim() !== ''
            ? Number(v.replace(',', '.').replace(/\s*db$/i, ''))
            : NaN;
    const keyOf = f =>
      [String(f), f >= 1000 ? f / 1000 + 'k' : null, f + 'hz', f >= 1000 ? f / 1000 + 'khz' : null].filter(
        Boolean
      );
    const eq = Array.isArray(eqIn)
      ? eqIn.map(num)
      : eqIn && typeof eqIn === 'object'
        ? bands.map(f => {
            const k = Object.keys(eqIn).find(k => keyOf(f).includes(k.toLowerCase().replace(/\s/g, '')));
            return k === undefined ? 0 : num(eqIn[k]);
          })
        : null;
    if (eq && eq.length === bands.length && eq.every(Number.isFinite)) settings.eq = eq;
    for (const key of ['width', 'targetLufs', 'ceiling'])
      if (typeof result.settings[key] === 'number' && Number.isFinite(result.settings[key]))
        settings[key] = result.settings[key];
    for (const key of ['compressor', 'reverb'])
      if (modes?.[key]?.includes(result.settings[key])) settings[key] = result.settings[key];
    return {
      summary: result.summary.trim().slice(0, 1200),
      observations: lines(result.observations, 6),
      settings,
      listening: lines(result.listening, 3),
      heard: !!audio?.length,
    };
  }

  // Prompt assistant: listen to a song and describe how to make a new, original one with a similar sound.
  const NOTES = [
    'C',
    'C#',
    'Db',
    'D',
    'D#',
    'Eb',
    'E',
    'F',
    'F#',
    'Gb',
    'G',
    'G#',
    'Ab',
    'A',
    'A#',
    'Bb',
    'B',
  ];
  async function listen({ audio, duration, excerpt, name = '' }) {
    if (!audio?.length) throw new Error('There is no audio to analyze.');
    const raw = await completion(
      `Listen to this song${name ? ` (file name: ${JSON.stringify(name.slice(0, 120))})` : ''}. ${excerpt ? `You hear ${excerpt} of a ${Math.round(duration)} s track.` : `Duration: ${Math.round(duration)} s.`}
The user wants to create a NEW, ORIGINAL song with a similar sound in ACE-Step 1.5 (a text-to-music model). Describe the sound so it can be recreated in spirit: genre and sub-genre, era, mood, tempo feel, instrumentation and how each part is played, drums and groove, bass, harmony colour, vocal type and delivery, production and mix character (space, saturation, width, loudness).
Rules: do not transcribe or quote the lyrics; do not name the artist or the song, even if you recognise it; describe sonic traits instead. Do not reproduce the melody. Lyric themes may be summarised in your own words so the user can write original lyrics.
Return ONLY JSON: {"stylePrompt":"concise English ACE-Step style prompt, comma-separated descriptors, max 180 words, no artist names","summary":"2-3 sentences in Italian describing what you hear","bpm":120,"key":"A minor","timeSignature":"4","vocal":"female|male|duet|choir|instrumental","language":"it|en|fr|es|de|pt|ja|ko|zh|unknown","structure":[{"section":"Intro","seconds":8}],"lyricThemes":"Italian summary of the themes and imagery, no quotes","exclude":"comma-separated sounds to avoid","notes":["1-4 short tips in Italian"]}`,
      1600,
      true,
      {
        system:
          'You are an expert music producer and arranger who describes recordings precisely and helps create original music. Follow the requested output format.',
        audio,
      }
    );
    const r = parseJson(raw, 'Invalid AI response format. Try again.');
    if (typeof r.stylePrompt !== 'string' || !r.stylePrompt.trim())
      throw new Error('AI did not describe the track. Try again.');
    const keyMatch =
      typeof r.key === 'string'
        ? /^\s*([A-G](?:#|b)?)\s*(major|minor|maj|min|m)?\s*$/i.exec(
            r.key.replace('♯', '#').replace('♭', 'b')
          )
        : null;
    const note = keyMatch && NOTES.find(n => n.toLowerCase() === keyMatch[1].toLowerCase());
    const minor = keyMatch && /^(minor|min|m)$/i.test(keyMatch[2] || '') && keyMatch[2] !== 'M';
    const bpm = Math.round(Number(r.bpm));
    return {
      stylePrompt: r.stylePrompt.trim().slice(0, 3000),
      summary: typeof r.summary === 'string' ? r.summary.trim().slice(0, 1200) : '',
      bpm: bpm >= 30 && bpm <= 250 ? bpm : null,
      key: note ? `${note} ${minor ? 'minor' : 'major'}` : null,
      timeSignature: ['2', '3', '4', '6'].includes(String(r.timeSignature)) ? String(r.timeSignature) : null,
      vocal: ['female', 'male', 'duet', 'choir', 'instrumental'].includes(r.vocal) ? r.vocal : null,
      language: ['it', 'en', 'fr', 'es', 'de', 'pt', 'ja', 'ko', 'zh', 'unknown'].includes(r.language)
        ? r.language
        : null,
      structure: Array.isArray(r.structure)
        ? r.structure
            .filter(s => typeof s?.section === 'string' && s.section.trim())
            .slice(0, 16)
            .map(s => ({
              section: s.section.trim().slice(0, 40),
              seconds: Number.isFinite(Number(s.seconds)) ? Math.max(0, Math.round(Number(s.seconds))) : null,
            }))
        : [],
      lyricThemes: typeof r.lyricThemes === 'string' ? r.lyricThemes.trim().slice(0, 1500) : '',
      exclude: typeof r.exclude === 'string' ? r.exclude.trim().slice(0, 500) : '',
      notes: lines(r.notes, 4),
    };
  }
  /**
   * The dice: one call that returns a title, a style and (unless instrumental) lyrics that fit each other.
   * Rules: it only FILLS fields, it never starts a generation. `seedPrompt` is a random style built locally from the prompt categories.
   */
  async function surprise(body = {}) {
    const seedPrompt = text(body, 'seedPrompt', 3000),
      language = text(body, 'language', 40, 'Italian'),
      concept = text(body, 'concept', 400),
      instrumental = body.instrumental === true;
    const duration =
      Number.isInteger(body.duration) && body.duration >= 10 && body.duration <= 300 ? body.duration : 60;
    const structure = Array.isArray(body.structure)
      ? body.structure.filter(s => typeof s === 'string' && s.length <= 50).slice(0, 16)
      : [];
    const budget = lyricsBudget(duration);
    const raw = await completion(
      `Invent ONE original song for ACE-Step 1.5 and return it as JSON. Start from this random style seed and keep its genre and mood: ${seedPrompt || '(any genre, you choose)'}
${concept ? `Optional theme from the user: ${concept}.` : 'Pick a fresh, concrete theme (one image, one feeling).'}
The style, the title and the lyrics must clearly belong together: same mood, same era, same kind of voice, instruments that suit the genre.
"tags": an English style prompt, comma-separated descriptors, at most 70 words: genre, mood, tempo feel, instruments, vocal type${instrumental ? ' (instrumental, no vocals)' : ''}, production. No artist names, no BPM digits unless you are sure.
"title": a short title (max 6 words) in ${instrumental ? 'English or Italian' : language}.
${
  instrumental
    ? '"lyrics": "" (empty).'
    : `"lyrics": original lyrics in ${language}, with plain section tags such as [Verse], [Chorus], [Bridge], [Outro]${structure.length ? ', using exactly this order: ' + structure.join(' > ') : ''}. Write like a real song: short lines of 3-7 words, a strong repeated hook, vocables where the genre uses them. This is a full-length song of about ${Math.round(duration / 60)} minutes: write every section of the order, and repeat the chorus in full each time it comes back. About ${budget.target} sung words in total, never more than ${budget.max}. No stage directions.`
}
Return ONLY JSON: {"title":"...","tags":"...","lyrics":"..."}.`,
      2500,
      true,
      { temperature: 1.2 }
    );
    const r = parseJson(raw, 'Invalid AI response format. Try again.');
    if (typeof r.tags !== 'string' || !r.tags.trim())
      throw new Error('AI did not write a style prompt. Try again.');
    const lyrics = instrumental || typeof r.lyrics !== 'string' ? '' : r.lyrics.trim().slice(0, 12000);
    if (!instrumental && !lyrics) throw new Error('AI did not write lyrics. Try again.');
    return {
      title: typeof r.title === 'string' ? r.title.trim().slice(0, 100) : '',
      tags: r.tags.trim().slice(0, 3000),
      lyrics,
    };
  }

  /** "Auto" for tempo, time signature and key: the AI reads style and lyrics and proposes values the ACE-Step encoder needs. */
  async function chooseMeta(body = {}) {
    const tags = text(body, 'tags', 3000),
      lyricsText = text(body, 'lyrics', 12000),
      wanted = Array.isArray(body.fields)
        ? body.fields.filter(f => ['bpm', 'keyscale', 'timesignature'].includes(f))
        : [];
    if (!tags) throw new Error('Describe the style first.');
    const raw = await completion(
      `Choose musical parameters for a new song. Style: ${tags}
${lyricsText ? 'Lyrics (first part): ' + lyricsText.slice(0, 1200) : 'Instrumental.'}
Pick values that fit the genre, mood and lyrics: bpm (integer 40-220, quarter-note beats per minute), timeSignature ("2", "3", "4" or "6" for 6/8) and key (like "A minor" or "Eb major", natural names with # or b).
Return ONLY JSON: {"bpm":96,"timeSignature":"4","key":"A minor"}.`,
      200,
      true,
      { temperature: 0.4 }
    );
    const r = parseJson(raw, 'Invalid AI response format.');
    const bpm = Math.round(Number(r.bpm));
    const keyMatch =
      typeof r.key === 'string'
        ? /^\s*([A-G](?:#|b)?)\s*(major|minor|maj|min|m)?\s*$/i.exec(
            r.key.replace('♯', '#').replace('♭', 'b')
          )
        : null;
    const note = keyMatch && NOTES.find(n => n.toLowerCase() === keyMatch[1].toLowerCase());
    const minor = keyMatch && /^(minor|min|m)$/i.test(keyMatch[2] || '') && keyMatch[2] !== 'M';
    const result = {};
    if (bpm >= 40 && bpm <= 220) result.bpm = bpm;
    if (note) result.keyscale = `${note} ${minor ? 'minor' : 'major'}`;
    if (['2', '3', '4', '6'].includes(String(r.timeSignature)))
      result.timesignature = String(r.timeSignature);
    return wanted.length
      ? Object.fromEntries(Object.entries(result).filter(([k]) => wanted.includes(k)))
      : result;
  }
  return { status, configure, boost, lyrics, mastering, listen, canListen, surprise, chooseMeta };
}
