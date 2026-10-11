// @codedna
// description: Validate music requests and build the native ACE-Step 1.5 XL Turbo graph.
//
//
// 
//
// 
//
// 
//
// exports: LANGUAGES | KEYS | TERMINAL | VOICES | validateInput | seedsFor | buildWorkflow | historyFailure
// used_by: sonora-studio/server.mjs
// rules:   Never interpolate user text into paths. Keep both duration and seed inputs synchronized.
// agent:   Codex - 2026-10-04 - Initial implementation for installed native ACE-Step nodes; canonical server-side vocal duration.
import { randomInt } from 'node:crypto';
import { estimateSongDuration } from './public/song-duration.mjs';

export const LANGUAGES = ['it', 'en', 'fr', 'es', 'de', 'pt', 'ja', 'ko', 'zh', 'unknown'];
export const KEYS = [
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
].flatMap(k => [`${k} major`, `${k} minor`]);
export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// ACE-Step has no voice control: the choice is added to the style tags in plain words.
export const VOICES = {
  auto: '',
  female: 'female lead vocals',
  male: 'male lead vocals',
  duet: 'male and female duet vocals, alternating lead singers',
  choir: 'choir vocals',
};

export function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
  const str = (key, fallback, max) => {
    const value = body[key] ?? fallback;
    if (typeof value !== 'string' || value.length > max)
      throw new Error(`Invalid ${key} field (maximum ${max} characters).`);
    return value.trim();
  };
  const num = (key, fallback, min, max) => {
    const v = body[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || !Number.isInteger(v))
      throw new Error(`Invalid ${key} field: enter a whole number from ${min} to ${max}.`);
    return v;
  };
  // Rules: decimal knobs for the ACE-Step language model (guidance = cfg_scale, creativity = temperature); anything outside the range is rejected.
  const decimal = (key, fallback, min, max) => {
    const v = body[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`Invalid ${key} field: enter a value from ${min} to ${max}.`);
    return Math.round(v * 100) / 100;
  };
  const bool = (key, fallback) => {
    if (body[key] !== undefined && typeof body[key] !== 'boolean')
      throw new Error(`Invalid ${key} field.`);
    return body[key] ?? fallback;
  };
  const input = {
    title: str('title', 'Untitled', 100) || 'Untitled',
    tags: str('tags', '', 3000),
    lyrics: str('lyrics', '', 12000),
    instrumental: bool('instrumental', true),
    durationMode: str('durationMode', 'manual', 10),
    lyricPacing: str('lyricPacing', 'normal', 10),
    durationArrangement: str('durationArrangement', 'written', 10),
    bpm: num('bpm', 110, 30, 250),
    variants: num('variants', 1, 1, 4),
    language: str('language', 'en', 10),
    keyscale: str('keyscale', 'C major', 20),
    timesignature: str('timesignature', '4', 1),
    quality: str('quality', 'light', 10),
    finish: str('finish', 'fast', 5),
    vocal: str('vocal', 'auto', 10),
    avoid: str('avoid', '', 500),
    seed: num('seed', -1, -1, 4294967294),
    guidance: decimal('guidance', 2, 1, 5),
    creativity: decimal('creativity', 0.85, 0.5, 1.3),
  };
  if (!input.tags) throw new Error('Describe the music you want to create.');
  if (body.referenceId !== undefined) {
    if (typeof body.referenceId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.referenceId))
      throw new Error('Invalid reference audio.');
    input.referenceId = body.referenceId;
  }
  if (body.loraId) {
    if (typeof body.loraId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.loraId))
      throw new Error('Invalid LoRA.');
    input.loraId = body.loraId;
  }
  if (!input.instrumental && !input.lyrics) throw new Error('Enter lyrics, or select Instrumental.');
  if (
    !LANGUAGES.includes(input.language) ||
    !KEYS.includes(input.keyscale) ||
    !['2', '3', '4', '6'].includes(input.timesignature) ||
    !['light', 'full'].includes(input.quality) ||
    !['fast', 'final'].includes(input.finish) ||
    !Object.hasOwn(VOICES, input.vocal)
  )
    throw new Error('Invalid music settings.');
  if (
    !['auto', 'manual'].includes(input.durationMode) ||
    !['normal', 'fast', 'relaxed'].includes(input.lyricPacing)
  )
    throw new Error('Invalid duration or phrasing mode.');
  if (!['written', 'balanced', 'spacious'].includes(input.durationArrangement))
    throw new Error('Invalid musical spaces.');
  const overrides = body.durationOverrides ?? {};
  if (
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    Object.keys(overrides).length > 128 ||
    Object.entries(overrides).some(
      ([k, v]) => k.length > 64 || !Number.isInteger(v) || v < (k.startsWith('auto:') ? 0 : 1) || v > 128
    )
  )
    throw new Error('Invalid bars per section.');
  input.durationOverrides = { ...overrides };
  if (input.instrumental) input.durationMode = 'manual';
  if (input.durationMode === 'auto') {
    const estimate = estimateSongDuration(input);
    if (!estimate.valid) throw new Error(estimate.reason);
    if (estimate.overflow)
      throw new Error(
        `The estimate is ${estimate.seconds} seconds, which exceeds the 5-minute limit. Edit the lyrics, phrasing or bars per section.`
      );
    input.duration = estimate.seconds;
    input.durationEstimate = estimate;
  } else input.duration = num('duration', 30, 10, 300);
  return input;
}

export function seedsFor(input) {
  const base = input.seed === -1 ? randomInt(0, 4294967294) : input.seed;
  return Array.from({ length: input.variants }, (_, i) => (base + i) % 4294967295);
}

/**
 * Rules: `referenceAudio` ('Sonora/<id>.mp3') adds ReferenceTimbreAudio (the reference guides timbre; the planner's audio codes are then off).
 * A list of styles to avoid (`input.avoid`) becomes a real negative prompt only with the SFT model (cfg 7): turbo runs at cfg 1, where it is ignored.
 * `source` ({ audio: 'Sonora/<id>.mp3', denoise }) turns the graph into a remix: the encoded song replaces the empty latent and
 * `denoise` (0.2-0.95) decides how much of it is rewritten. `finish: 'final'` uses the SFT model (50 steps, real guidance), slower than turbo.
 */
export function buildWorkflow(input, seed, id, config, referenceAudio = null, source = null) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID.');
  const full = input.quality === 'full';
  const final = input.finish === 'final';
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    1: node('UNETLoader', {
      unet_name: final ? config.sftModel || 'acestep_v1.5_xl_sft_bf16.safetensors' : config.model,
      weight_dtype: 'default',
    }),
    2: node('DualCLIPLoader', {
      clip_name1: config.encoder,
      clip_name2: config.planner,
      type: 'ace',
      device: 'default',
    }),
    3: node('VAELoader', { vae_name: config.vae }),
    4: node('TextEncodeAceStepAudio1.5', {
      clip: ['2', 0],
      tags: input.instrumental
        ? `${input.tags}, instrumental, no vocals`
        : VOICES[input.vocal]
          ? `${input.tags}, ${VOICES[input.vocal]}`
          : input.tags,
      lyrics: input.instrumental ? '[Instrumental]' : input.lyrics,
      seed,
      bpm: input.bpm,
      duration: input.duration,
      timesignature: input.timesignature,
      language: input.instrumental ? 'unknown' : input.language,
      keyscale: input.keyscale,
      generate_audio_codes: referenceAudio || source ? false : full,
      cfg_scale: input.guidance ?? 2,
      temperature: input.creativity ?? 0.85,
      top_p: 0.9,
      top_k: 0,
      min_p: 0,
    }),
    5: node('ConditioningZeroOut', { conditioning: ['4', 0] }),
    6: node('EmptyAceStep1.5LatentAudio', { seconds: input.duration, batch_size: 1 }),
    7: node('ModelSamplingAuraFlow', { model: ['1', 0], shift: 3 }),
    8: node('KSampler', {
      model: ['7', 0],
      seed,
      steps: final ? 50 : 8,
      cfg: final ? 7 : 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
      denoise: source ? source.denoise : 1,
    }),
    9: node('VAEDecodeAudio', { samples: ['8', 0], vae: ['3', 0] }),
    10: node('SaveAudioMP3', { audio: ['9', 0], filename_prefix: `audio/Sonora/${id}`, quality: 'V0' }),
    11: node('SaveAudio', { audio: ['9', 0], filename_prefix: `audio/Sonora/${id}` }),
  };
  if (source) {
    if (typeof source.audio !== 'string' || !/^Sonora\/[a-f0-9-]{36}\.mp3$/.test(source.audio))
      throw new Error('Invalid source audio.');
    if (!(source.denoise >= 0.2 && source.denoise <= 0.95))
      throw new Error('Invalid strength (0.2–0.95).');
    graph['12'] = node('LoadAudio', { audio: source.audio });
    graph['13'] = node('VAEEncodeAudio', { audio: ['12', 0], vae: ['3', 0] });
    graph['8'].inputs.latent_image = ['13', 0];
  }
  if (referenceAudio) {
    if (source) throw new Error('Remix and reference audio cannot be used together.');
    if (typeof referenceAudio !== 'string' || !/^Sonora\/[a-f0-9-]{36}\.(?:flac|mp3)$/.test(referenceAudio))
      throw new Error('Invalid reference audio.');
    graph['12'] = node('LoadAudio', { audio: referenceAudio });
    graph['13'] = node('VAEEncodeAudio', { audio: ['12', 0], vae: ['3', 0] });
    graph['14'] = node('ReferenceTimbreAudio', { conditioning: ['4', 0], latent: ['13', 0] });
    graph['8'].inputs.positive = ['14', 0];
  }
  if (final && input.avoid) {
    graph['16'] = node('TextEncodeAceStepAudio1.5', {
      ...graph['4'].inputs,
      tags: input.avoid,
      lyrics: '[Instrumental]',
      generate_audio_codes: false,
    });
    graph['8'].inputs.negative = ['16', 0];
    delete graph['5'];
  }
  return graph;
}

export function historyFailure(entry) {
  const event = entry?.status?.messages?.findLast(m =>
    ['execution_error', 'execution_interrupted'].includes(m[0])
  );
  if (!event) return null;
  return {
    cancelled: event[0] === 'execution_interrupted',
    message: event[1]?.exception_message || 'Generation was interrupted.',
  };
}
