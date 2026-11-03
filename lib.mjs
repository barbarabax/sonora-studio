// @codedna
// description: Validate music requests and build the native ACE-Step 1.5 XL Turbo graph.
//
// exports: LANGUAGES | KEYS | TERMINAL | VOICES | withoutInstrumentalWords | validateInput | lyricSections | harmonyField | seedsFor | buildWorkflow | historyFailure | resolveModelName
// used_by: server.mjs
// rules:   Never interpolate user text into paths. Keep both duration and seed inputs synchronized.
// agent:   Codex - 2026-10-04 - Initial implementation for installed native ACE-Step nodes; canonical server-side vocal duration.
// Codex - 2026-10-10 - Validate LoRA scale from zero to full strength.
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

/**
 * Rules: a style that says "no vocals" or "instrumental" contradicts typed lyrics, and ACE-Step obeys the caption: the song
 * stays instrumental. Used when a remix or a repaint turns an instrumental into a sung song. "Instrumental break" and similar
 * phrases are kept; the result is never empty.
 */
export function withoutInstrumentalWords(tags) {
  const drop =
    /\b(no|without)\s+(any\s+)?(vocals?|singing|voice|lyrics|singer)\b|\bvocal-?less\b|^\s*(purely\s+|fully\s+|mostly\s+)?instrumental\b(?!\s+(break|breaks|interlude|section|solo|bridge|passages?|outro|intro|moments?))/i;
  const kept = String(tags)
    .split(',')
    .map(part => part.trim())
    .filter(part => part && !drop.test(part));
  return kept.length ? kept.join(', ') : 'vocal song';
}

export function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
  const str = (key, fallback, max) => {
    const value = body[key] ?? fallback;
    if (typeof value !== 'string' || value.length > max)
      throw new Error(`Field ${key} is not valid (maximum ${max} characters).`);
    return value.trim();
  };
  const num = (key, fallback, min, max) => {
    const v = body[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || !Number.isInteger(v))
      throw new Error(`Field ${key}: choose a whole number between ${min} and ${max}.`);
    return v;
  };
  // Rules: decimal knobs for the ACE-Step language model (guidance = cfg_scale, creativity = temperature); anything outside the range is rejected.
  const decimal = (key, fallback, min, max) => {
    const v = body[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
      throw new Error(`Field ${key}: choose a value between ${min} and ${max}.`);
    return Math.round(v * 100) / 100;
  };
  const bool = (key, fallback) => {
    if (body[key] !== undefined && typeof body[key] !== 'boolean')
      throw new Error(`Field ${key} is not valid.`);
    return body[key] ?? fallback;
  };
  const input = {
    musicModel: str('musicModel', 'ace-step', 20),
    title: str('title', 'Untitled', 100) || 'Untitled',
    tags: str('tags', '', 3000),
    lyrics: str('lyrics', '', 12000),
    instrumental: bool('instrumental', true),
    durationMode: str('durationMode', 'manual', 10),
    lyricPacing: str('lyricPacing', 'normal', 10),
    durationArrangement: str('durationArrangement', 'written', 10),
    bpm: num('bpm', 110, 30, 250),
    variants: num('variants', 1, 1, 4),
    language: str('language', 'it', 10),
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
  if (!['ace-step', 'yue2'].includes(input.musicModel)) throw new Error('Invalid music model.');
  if (input.musicModel === 'yue2') {
    // Rules: YuE2 writes a melody-and-chords plan (ABC) before it sings; the plan can be edited and passed back. It always sings, has no LoRA or reference audio.
    if (body.loraId || body.referenceId) throw new Error('YuE2 does not support LoRA or reference audio.');
    if (!input.lyrics) throw new Error('YuE2 sings: enter the lyrics.');
    input.instrumental = false;
    input.yueCot = str('yueCot', 'full', 6);
    if (!['full', 'melody', 'off'].includes(input.yueCot)) throw new Error('Invalid plan mode.');
    // Rules: where the song is made: RunPod or this computer's GPU; empty lets the server choose what is configured.
    input.yueHost = str('yueHost', '', 6);
    if (body.yueMelodyFreedom !== undefined) {
      if (!['low', 'medium', 'high'].includes(body.yueMelodyFreedom))
        throw new Error('Invalid melodic freedom.');
      input.yueMelodyFreedom = body.yueMelodyFreedom;
    }
    if (!['', 'runpod', 'local'].includes(input.yueHost))
      throw new Error('Where to create the song is not valid.');
    if (body.abc !== undefined && body.abc !== null && body.abc !== '') {
      if (
        typeof body.abc !== 'string' ||
        body.abc.length < 20 ||
        body.abc.length > 60000 ||
        !/^K:/m.test(body.abc)
      )
        throw new Error('The ABC plan is not valid: a key line K: is required (maximum 60000 characters).');
      input.abc = body.abc.replace(/\r\n/g, '\n');
    }
    // Rules: YuE2 LoRA (yue2.cpp on the PC only): up to 4 catalogue ids, each with a strength on the composition (ar) and on the sound (nar), -10..10.
    if (body.yueAdapters !== undefined && body.yueAdapters !== null) {
      const list = body.yueAdapters;
      const strength = v => typeof v === 'number' && Number.isFinite(v) && v >= -10 && v <= 10;
      if (
        !Array.isArray(list) ||
        list.length > 4 ||
        list.some(
          a =>
            !a ||
            typeof a.id !== 'string' ||
            !/^[a-z0-9-]{1,64}$/.test(a.id) ||
            !strength(a.ar) ||
            !strength(a.nar)
        ) ||
        new Set(list.map(a => a.id)).size !== list.length
      )
        throw new Error('Invalid YuE2 LoRAs (at most 4, strength between −10 and 10).');
      if (list.length)
        input.yueAdapters = list.map(a => ({
          id: a.id,
          ar: Math.round(a.ar * 100) / 100,
          nar: Math.round(a.nar * 100) / 100,
        }));
    }
    // Rules: chord variety and section order for the plan YuE2 writes (yue2.cpp `harmony`); every control at rest means none.
    if (body.yueHarmony !== undefined && body.yueHarmony !== null) {
      const h = body.yueHarmony;
      const within = (v, max) =>
        v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);
      if (
        typeof h !== 'object' ||
        !within(h.strength, 64) ||
        !within(h.outsideBonus, 20) ||
        !within(h.sectionStrength, 64) ||
        (h.identity !== undefined && !['root', 'spelling'].includes(h.identity)) ||
        (h.follow !== undefined && typeof h.follow !== 'boolean')
      )
        throw new Error('Invalid chord settings.');
      const harmony = {
        ...(h.identity ? { identity: h.identity } : {}),
        ...(h.strength ? { strength: h.strength } : {}),
        ...(h.outsideBonus ? { outsideBonus: h.outsideBonus } : {}),
        ...(h.sectionStrength ? { sectionStrength: h.sectionStrength } : {}),
        ...(h.follow ? { follow: true } : {}),
      };
      if (harmony.strength || harmony.outsideBonus || harmony.sectionStrength || harmony.follow)
        input.yueHarmony = harmony;
    }
    // Rules: a cover remembers its original (data/covers/<id>.mp3) so «Riusa parametri» reloads it without a new upload or transcription.
    if (body.cover !== undefined && body.cover !== null) {
      const c = body.cover;
      if (
        typeof c !== 'object' ||
        typeof c.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(c.id) ||
        typeof c.title !== 'string' ||
        c.title.length > 200 ||
        !Number.isInteger(c.seconds) ||
        c.seconds < 0 ||
        c.seconds > 3600 ||
        typeof c.chords !== 'boolean' ||
        (c.trimmed !== undefined && typeof c.trimmed !== 'boolean')
      )
        throw new Error('Invalid cover data.');
      input.cover = {
        id: c.id,
        title: c.title,
        seconds: c.seconds,
        chords: c.chords,
        ...(c.trimmed ? { trimmed: true } : {}),
      };
    }
  }
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
    input.loraScale = decimal('loraScale', 1, 0, 1);
  }
  if (!input.instrumental && !input.lyrics) throw new Error('Enter the lyrics, or choose Instrumental.');
  if (
    !LANGUAGES.includes(input.language) ||
    !KEYS.includes(input.keyscale) ||
    !['2', '3', '4', '6'].includes(input.timesignature) ||
    !['light', 'full'].includes(input.quality) ||
    !['fast', 'final'].includes(input.finish) ||
    !Object.hasOwn(VOICES, input.vocal)
  )
    throw new Error('Invalid music setting.');
  if (
    !['auto', 'manual'].includes(input.durationMode) ||
    !['normal', 'fast', 'relaxed'].includes(input.lyricPacing)
  )
    throw new Error('Invalid duration mode or phrasing.');
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
        `The estimate is ${estimate.seconds} seconds and exceeds the 5-minute limit. Edit the lyrics, phrasing or bars per section.`
      );
    input.duration = estimate.seconds;
    input.durationEstimate = estimate;
  } else input.duration = num('duration', 30, 10, 300);
  return input;
}

const SECTION_ALIASES = {
  prechorus: 'pre-chorus',
  'pre chorus': 'pre-chorus',
  'post chorus': 'post-chorus',
  hook: 'chorus',
  refrain: 'chorus',
};
const SCORE_SECTIONS = new Set([
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'post-chorus',
  'bridge',
  'outro',
  'rap',
  'interlude',
  'instrumental',
  'solo',
  'fade-out',
  'pre-outro',
  'loop',
  'intro and verse',
  'pre-chorus and chorus',
  'verse and pre-chorus',
  'theme',
  'development',
  'variation',
  'irregular',
  'preshot',
  'silence',
]);
/** The score's name for each section tag of the lyrics, in order (ported from YuE2-Studio's phrasing.rs, MIT); words before any tag are a verse. */
export function lyricSections(lyrics) {
  const labels = [];
  for (const raw of String(lyrics || '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tag = /^\[\s*([^\]]*?)\s*\]$/.exec(line);
    if (tag) {
      let clean = tag[1]
        .toLowerCase()
        .replace(/_/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .join(' ')
        .replace(/[\s\d:.#-]+$/, '');
      clean = SECTION_ALIASES[clean] || clean;
      labels.push(SCORE_SECTIONS.has(clean) ? clean : 'verse');
    } else if (!labels.length) labels.push('verse');
  }
  return labels;
}
/** yue2.cpp's `harmony` request field from Sonora's yueHarmony, or undefined. */
export function harmonyField(harmony, lyrics) {
  if (!harmony) return undefined;
  const field = {
    ...(harmony.identity ? { identity: harmony.identity } : {}),
    ...(harmony.strength ? { strength: harmony.strength } : {}),
    ...(harmony.outsideBonus ? { outside_bonus: harmony.outsideBonus } : {}),
    ...(harmony.sectionStrength ? { section_strength: harmony.sectionStrength } : {}),
  };
  if (harmony.follow) {
    const follow = lyricSections(lyrics);
    if (!follow.length)
      throw new Error('To follow the sections the lyrics need tags, for example [Verse] and [Chorus].');
    field.follow = follow.slice(0, 64);
  }
  return Object.keys(field).length ? field : undefined;
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
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID');
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
    if (!(source.denoise >= 0.2 && source.denoise <= 0.95)) throw new Error('Invalid strength (0.2–0.95).');
    graph['12'] = node('LoadAudio', { audio: source.audio });
    graph['13'] = node('VAEEncodeAudio', { audio: ['12', 0], vae: ['3', 0] });
    graph['8'].inputs.latent_image = ['13', 0];
  }
  if (referenceAudio) {
    if (source) throw new Error('Remix and reference audio cannot be combined.');
    if (typeof referenceAudio !== 'string' || !/^Sonora\/[a-f0-9-]{36}\.(?:flac|mp3)$/.test(referenceAudio))
      throw new Error('Invalid audio reference.');
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

/**
 * The name ComfyUI knows a model by. `wanted` is the file name from the config; `available` is the list of the loader node.
 * A model kept in a sub-folder is listed with its path (`acestep/file.safetensors`, backslashes on Windows): when the exact name
 * is not listed but exactly one entry has the same file name, that entry is used. Anything else (none, or several) keeps `wanted`.
 */
export function resolveModelName(wanted, available) {
  if (!Array.isArray(available) || available.includes(wanted)) return wanted;
  const base = name => String(name).split(/[\\/]/).pop();
  const same = available.filter(name => typeof name === 'string' && base(name) === base(wanted));
  return same.length === 1 ? same[0] : wanted;
}

export function historyFailure(entry) {
  const event = entry?.status?.messages?.findLast(m =>
    ['execution_error', 'execution_interrupted'].includes(m[0])
  );
  if (!event) return null;
  return {
    cancelled: event[0] === 'execution_interrupted',
    message: event[1]?.exception_message || 'Generation interrupted.',
  };
}
