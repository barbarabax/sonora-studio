// @codedna
// description: Original Suno Prompt assembly, optimization, conflicts and random archetypes.
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
// exports: bandBpm | effectiveBpm | checkNewConflicts | createEmptyState | randomPromptState | buildPrompt
// used_by: sonora-studio/public/create-ui.mjs
//                   sonora-studio/public/prompt-adapter.mjs
//                   sonora-studio/public/prompt-ui.mjs
// rules:   Imported from the user-owned Suno Prompt source. Preserve original musical choices and conflict rules.
// agent:   Codex - 2026-10-04 - Adapted pure logic without React or site authentication.
import {
  BASS_TONE_OPTIONS,
  EAR_CANDY_SPACE_OPTIONS,
  ERA_OPTIONS,
  GENRE_HIERARCHY,
  GOAL_OPTIONS,
  GROOVE_FEEL_OPTIONS,
  HARMONY_FORM_OPTIONS,
  INSTRUMENTS_OPTIONS,
  KEY_OPTIONS,
  MIX_MASTER_HIERARCHY,
  MODES_OPTIONS,
  MOOD_OPTIONS,
  PRODUCTION_OPTIONS,
  RHYTHM_OPTIONS,
  STRUCTURE_OPTIONS,
  TEMPO_OPTIONS,
  VOCAL_HIERARCHY,
} from './prompt-presets.mjs';
const GENRE_NAME_MAP = {};
for (const parent of GENRE_HIERARCHY) {
  GENRE_NAME_MAP[parent.id] = parent.name;
  if (parent.subOptions) {
    for (const sub of parent.subOptions) {
      GENRE_NAME_MAP[sub.id] = sub.name;
    }
  }
}
const VOCAL_NAME_MAP = {};
const VOCAL_PARENT_MAP = {};
for (const parent of VOCAL_HIERARCHY) {
  VOCAL_NAME_MAP[parent.id] = parent.name;
  if (parent.subOptions) {
    for (const sub of parent.subOptions) {
      VOCAL_NAME_MAP[sub.id] = sub.name;
      VOCAL_PARENT_MAP[sub.id] = parent.id;
    }
  }
}
const MIX_NAME_MAP = {};
const MIX_PARENT_MAP = {};
for (const parent of MIX_MASTER_HIERARCHY) {
  if (parent.subOptions) {
    for (const sub of parent.subOptions) {
      MIX_NAME_MAP[sub.id] = sub.name;
      MIX_PARENT_MAP[sub.id] = parent.id;
    }
  }
}
const GENRE_RANDOM_OPTIONS = GENRE_HIERARCHY.flatMap(parent =>
  parent.subOptions?.length ? parent.subOptions.map(sub => sub.id) : [parent.id]
);
const VOCAL_RANDOM_OPTIONS = VOCAL_HIERARCHY.flatMap(parent =>
  parent.subOptions?.length ? parent.subOptions.map(sub => sub.id) : [parent.id]
);
const MIX_RANDOM_GROUPS = MIX_MASTER_HIERARCHY.map(
  parent => parent.subOptions?.map(sub => sub.id) || []
).filter(Boolean);
const pickOne = items => items[Math.floor(Math.random() * items.length)];
const pickMany = (items, count) => {
  const copy = [...items];
  const picked = [];
  while (copy.length > 0 && picked.length < count) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }
  return picked;
};
/** Middle of a tempo band such as "Slow (80-100 BPM)" as a string; '' when the label has no range. */
export const bandBpm = tempo => {
  const match = /\((\d+)\s*-\s*(\d+)\s*BPM\)/i.exec(tempo || '');
  return match ? String(Math.round((Number(match[1]) + Number(match[2])) / 2)) : '';
};
/** The BPM to use: the exact value the user typed, otherwise the middle of the chosen tempo band. */
export const effectiveBpm = state => (state.bpm && String(state.bpm).trim()) || bandBpm(state.tempo?.[0]);
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const bpmForTempo = tempo => {
  if (tempo.includes('80-100')) return String(randomInt(80, 100));
  if (tempo.includes('100-120')) return String(randomInt(100, 120));
  if (tempo.includes('120-140')) return String(randomInt(120, 140));
  if (tempo.includes('140-160')) return String(randomInt(140, 160));
  return '';
};
const RANDOM_ARCHETYPES = [
  {
    name: 'Dark Synthwave',
    genres: ['synthwave', 'darkwave', 'electropop'],
    mood: ['Dark', 'Nostalgic', 'Hypnotic', 'Mysterious'],
    tempo: ['Moderate (100-120 BPM)', 'Fast (120-140 BPM)'],
    instruments: ['Wavetable Synth', 'Pad Synth', 'Lead Synth', 'Drums (Electronic)', 'Synth Bass'],
    vocal: ['male-breathy', 'female-ethereal', 'vocalization', 'instrumental-only'],
    production: ['Vintage', 'Warm', 'Crisp'],
    era: ['1980s', 'Contemporary'],
    goal: ['Cinematic', 'Gaming', 'Emotional'],
    rhythm: ['Straight (4/4)', 'Locked', 'Minimal'],
    groove: ['Driving', 'Hypnotic', 'Tight'],
    bass: ['Synth Bass', 'Deep Sub-Bass', 'Filtered Bass'],
    harmony: ['Minor', 'Modal Interchange', 'Suspended Chords'].filter(v => HARMONY_FORM_OPTIONS.includes(v)),
    earCandy: ['Reverb-heavy', 'Delay Effects', 'Chorus', 'Stereo Width'],
    mix: ['warm-mastering', 'stereo-enhanced', 'compressed'],
  },
  {
    name: 'Acoustic Ballad',
    genres: ['acoustic-pop', 'folk-main', 'singer-songwriter', 'indie-folk'],
    mood: ['Melancholic', 'Romantic', 'Introspective', 'Nostalgic'],
    tempo: ['Slow (80-100 BPM)', 'Moderate (100-120 BPM)'],
    instruments: ['Acoustic Guitar', 'Acoustic Piano', 'String Section', 'Cello', 'Bass Guitar'],
    vocal: ['male-warm', 'male-breathy', 'female-warm', 'female-breathy'],
    production: ['Clean', 'Warm', 'Professional'],
    era: ['2000s', '2010s', 'Contemporary'],
    goal: ['Emotional', 'Storytelling', 'Background Music'],
    rhythm: ['Straight (4/4)', 'Minimal'],
    groove: ['Laid-back', 'Smooth'],
    bass: ['Warm Bass', 'Subtle Bass', 'Acoustic Bass'],
    harmony: ['Simple (I-IV-V)', 'Diatonic', 'Suspended Chords'],
    earCandy: ['Reverb-heavy', 'Stereo Width', 'Delay Effects'],
    mix: ['vocal-forward', 'warm-mastering', 'dynamic-range'],
  },
  {
    name: 'EDM Club',
    genres: ['edm-main', 'house-main', 'deep-house', 'future-bass'],
    mood: ['Energetic', 'Uplifting', 'Epic', 'Joyful'],
    tempo: ['Fast (120-140 BPM)', 'Very fast (140-160 BPM)'],
    instruments: ['Drums (Electronic)', 'Synth Bass', 'Lead Synth', 'Wavetable Synth', 'Pad Synth'],
    vocal: ['female-powerful', 'male-smooth', 'vocalization', 'pitched-vocals'],
    production: ['Crisp', 'Bright', 'Professional'],
    era: ['2010s', '2020s', 'Contemporary'],
    goal: ['Dance Floor Banger', 'Party', 'Workout', 'TikTok'],
    rhythm: ['Straight (4/4)', 'Locked', 'Groove-based'],
    groove: ['Driving', 'Bouncy', 'Tight'],
    bass: ['Deep Sub-Bass', 'Punchy Bass', 'Synth Bass'],
    harmony: ['Diatonic', 'Suspended Chords'],
    earCandy: ['Delay Effects', 'Stereo Width', 'Compression', 'Modulation'],
    mix: ['club-ready', 'loud-punchy', 'bright-mastering', 'stereo-enhanced'],
  },
  {
    name: 'Indie Rock',
    genres: ['indie-rock', 'alternative-rock', 'garage-rock'],
    mood: ['Energetic', 'Introspective', 'Nostalgic', 'Melancholic'],
    tempo: ['Moderate (100-120 BPM)', 'Fast (120-140 BPM)'],
    instruments: ['Electric Guitar', 'Bass Guitar', 'Drums (Acoustic)', 'Acoustic Guitar', 'Electric Piano'],
    vocal: ['male-raspy', 'male-warm', 'female-raspy', 'layered-vocals'],
    production: ['Vintage', 'Live Recording', 'Warm'],
    era: ['1990s', '2000s', '2010s'],
    goal: ['Storytelling', 'Emotional', 'Party'],
    rhythm: ['Straight (4/4)', 'Groove-based'],
    groove: ['Driving', 'Loose', 'Groovy'],
    bass: ['Warm Bass', 'Melodic Bass', 'Prominent Bass'],
    harmony: ['Simple (I-IV-V)', 'Diatonic', 'Suspended Chords'],
    earCandy: ['Reverb-heavy', 'Distortion', 'Stereo Width'],
    mix: ['balanced-mix', 'warm-mastering', 'dynamic-range'],
  },
  {
    name: 'Cinematic Trailer',
    genres: ['cinematic-main', 'orchestral', 'epic-music'],
    mood: ['Epic', 'Dark', 'Mysterious', 'Emotional'],
    tempo: ['Slow (80-100 BPM)', 'Moderate (100-120 BPM)'],
    instruments: ['String Section', 'Brass Section', 'Timpani', 'French Horn', 'Choir'],
    vocal: ['choir', 'vocal-ensemble', 'vocalization', 'instrumental-only'],
    production: ['Professional', 'Crisp', 'Live Recording'],
    era: ['Contemporary', '2020s'],
    goal: ['Cinematic', 'Gaming', 'Background Music'],
    rhythm: ['Minimal', 'Polyrhythmic', 'Straight (4/4)'],
    groove: ['Driving', 'Hypnotic', 'Tight'],
    bass: ['Deep Sub-Bass', 'Prominent Bass'],
    harmony: ['Modal Interchange', 'Suspended Chords', 'Diminished'],
    earCandy: ['Reverb-heavy', 'Spatial Effects', 'Stereo Width'],
    mix: ['dynamic-range', 'stereo-enhanced', 'dark-mastering'],
  },
  {
    name: 'Lo-fi Hip Hop',
    genres: ['lo-fi-hip-hop', 'boom-bap', 'jazz-rap'],
    mood: ['Calm', 'Nostalgic', 'Hypnotic', 'Introspective'],
    tempo: ['Slow (80-100 BPM)', 'Moderate (100-120 BPM)'],
    instruments: ['Electric Piano', 'Drums (Electronic)', 'Bass Guitar', 'Saxophone', 'Vibraphone'],
    vocal: ['instrumental-only', 'spoken-word', 'rap', 'male-smooth'],
    production: ['Lo-Fi', 'Warm', 'Vintage'],
    era: ['1990s', '2000s', 'Contemporary'],
    goal: ['Focus/Study', 'Background Music', 'Podcast'],
    rhythm: ['Swing', 'Broken', 'Groove-based'],
    groove: ['Laid-back', 'Loose', 'Smooth'],
    bass: ['Warm Bass', 'Filtered Bass', 'Subtle Bass'],
    harmony: ['Jazz Harmony', 'Diatonic', 'Suspended Chords'],
    earCandy: ['Echo', 'Compression', 'Reverb-heavy'],
    mix: ['warm-mastering', 'compressed', 'headphone-optimized'],
  },
  {
    name: 'Ambient',
    genres: ['ambient', 'drone', 'new-age'],
    mood: ['Calm', 'Ethereal', 'Hypnotic', 'Mysterious'],
    tempo: ['Slow (80-100 BPM)', 'Moderate (100-120 BPM)'],
    instruments: ['Pad Synth', 'Harp', 'Flute', 'String Section', 'Theremin'],
    vocal: ['instrumental-only', 'female-ethereal', 'vocalization', 'choir'],
    production: ['Clean', 'Warm', 'Experimental'],
    era: ['Contemporary', '2020s'],
    goal: ['Meditation', 'Sleep', 'Background Music', 'Focus/Study'],
    rhythm: ['Minimal', 'Broken'],
    groove: ['Hypnotic', 'Laid-back', 'Smooth'],
    bass: ['Deep Sub-Bass', 'Minimal Bass', 'Subtle Bass'],
    harmony: ['Minimalist', 'Suspended Chords', 'Diatonic'],
    earCandy: ['Reverb-heavy', 'Spatial Effects', 'Delay Effects', 'Stereo Width'],
    mix: ['dynamic-range', 'stereo-enhanced', 'headphone-optimized'],
  },
];
const validFrom = (pool, fallback) => {
  const valid = pool.filter(item => fallback.includes(item));
  return valid.length > 0 ? valid : fallback;
};
const EXCLUDE_MAP = {
  'warm-mastering': ['bright mastering', 'harsh highs'],
  'bright-mastering': ['dark mastering', 'muddy low-mid'],
  'dark-mastering': ['bright mastering', 'harsh transients'],
  'stereo-enhanced': ['mono mix', 'center-heavy mix'],
  'mono-compatible': ['wide stereo field', 'stereo-only effects'],
  'headphone-optimized': ['speaker-only mix', 'collapsed stereo'],
  'dynamic-range': ['overcompressed', 'brickwall limiting'],
  compressed: ['uncompressed dynamic range', 'loose transients'],
  'vocal-forward': ['instrumental mix', 'buried vocals'],
  'instrumental-focused': ['lead vocal', 'prominent vocals'],
  'loud-punchy': ['soft dynamics', 'quiet mix'],
  'instrumental-only': ['vocals', 'sung melody', 'rap'],
};
const CONFLICT_PAIRS = [
  ['warm-mastering', 'bright-mastering', 'Warm e Bright mastering'],
  ['bright-mastering', 'dark-mastering', 'Bright e Dark mastering'],
  ['warm-mastering', 'dark-mastering', 'Warm e Dark mastering'],
  ['stereo-enhanced', 'mono-compatible', 'Stereo-Enhanced e Mono-Compatible'],
  ['dynamic-range', 'compressed', 'Dynamic Range e Compressed'],
  ['dynamic-range', 'loud-punchy', 'Dynamic Range e Loud and Punchy'],
  ['vocal-forward', 'instrumental-focused', 'Vocal-Forward e Instrumental-Focused'],
  ['vocal-forward', 'vocal-balanced', 'Vocal-Forward e Vocal-Balanced'],
  ['vocal-balanced', 'instrumental-focused', 'Vocal-Balanced e Instrumental-Focused'],
  ['instrumental-only', 'vocal-forward', 'Instrumental Only e Vocal-Forward'],
  ['instrumental-only', 'vocal-balanced', 'Instrumental Only e Vocal-Balanced'],
];
const generateExcludeTerms = state => {
  const allSelections = [...state.mix_master, ...state.vocal];
  const conflictedSelections = new Set();
  const conflicts = [];
  for (const [a, b, label] of CONFLICT_PAIRS) {
    if (allSelections.includes(a) && allSelections.includes(b)) {
      conflictedSelections.add(a);
      conflictedSelections.add(b);
      conflicts.push(`Conflicting selections: choose one of ${label}`);
    }
  }
  const excludeSet = new Set();
  for (const sel of allSelections) {
    if (!conflictedSelections.has(sel) && EXCLUDE_MAP[sel]) {
      for (const term of EXCLUDE_MAP[sel]) {
        excludeSet.add(term);
      }
    }
  }
  return { terms: Array.from(excludeSet), conflicts };
};
export const checkNewConflicts = (state, category, option) => {
  const currentArr = state[category];
  if (currentArr.includes(option)) return [];
  const newMixMaster = category === 'mix_master' ? [...state.mix_master, option] : state.mix_master;
  const newVocal = category === 'vocal' ? [...state.vocal, option] : state.vocal;
  const allSelections = [...newMixMaster, ...newVocal];
  const found = [];
  const seen = new Set();
  for (const [a, b, label] of CONFLICT_PAIRS) {
    const key = `${a}|${b}`;
    if (!seen.has(key) && allSelections.includes(a) && allSelections.includes(b)) {
      seen.add(key);
      found.push(label);
    }
  }
  return found;
};
const transformArtistName = name => {
  const noSpaces = name.replace(/\s+/g, '').toLowerCase();
  if (noSpaces.length > 0) {
    return noSpaces[0] + noSpaces;
  }
  return noSpaces;
};
const generateRawPrompt = state => {
  const phrases = [];
  const presetGenreNames = state.genres.map(id => GENRE_NAME_MAP[id] || id);
  if (presetGenreNames.length > 0 && state.mood.length > 0) {
    const genreStr = presetGenreNames.join(', ');
    const moodStr = state.mood.join(', ');
    phrases.push(`${moodStr} ${genreStr}`);
  } else if (presetGenreNames.length > 0 && state.mood.length === 0) {
    phrases.push(presetGenreNames.join(', '));
  } else if (presetGenreNames.length === 0 && state.mood.length > 0) {
    phrases.push(state.mood.join(', '));
  }
  if (state.customGenre && state.customGenre.trim()) {
    phrases.push(state.customGenre.trim());
  }
  const tempoBpm = effectiveBpm(state);
  if (state.tempo.length > 0 || tempoBpm) {
    const tempoPart =
      state.tempo.length > 0
        ? state.tempo[0]
            .replace(/\([^)]*\)/g, '')
            .trim()
            .toLowerCase()
        : '';
    const bpmPart = tempoBpm ? `${tempoBpm} BPM` : '';
    const combined = [tempoPart, bpmPart].filter(Boolean).join(', ');
    if (combined) phrases.push(combined);
  }
  if (state.key.length > 0 || state.modes.length > 0) {
    if (state.modes.length > 0 && state.key.length > 0) {
      const noteMatch = state.key[0].match(/^([A-G][#b]?)/);
      const note = noteMatch ? noteMatch[1] : state.key[0];
      phrases.push(`${note} ${state.modes[0].toLowerCase()}`);
    } else if (state.key.length > 0) {
      phrases.push(state.key[0]);
    } else {
      phrases.push(state.modes[0].toLowerCase());
    }
  }
  if (state.instruments.length > 0) {
    const instStr = state.instruments.join(', ');
    phrases.push(`featuring ${instStr}`);
  }
  if (state.vocal.length > 0) {
    const maleQualities = [];
    const femaleQualities = [];
    const otherVocals = [];
    for (const id of state.vocal) {
      const parentId = VOCAL_PARENT_MAP[id];
      const name = (VOCAL_NAME_MAP[id] || id).toLowerCase();
      if (parentId === 'male-voice') {
        maleQualities.push(name);
      } else if (parentId === 'female-voice') {
        femaleQualities.push(name);
      } else {
        otherVocals.push(name);
      }
    }
    const vocalParts = [];
    if (maleQualities.length > 0) vocalParts.push(`${maleQualities.join(', ')} male voice`);
    if (femaleQualities.length > 0) vocalParts.push(`${femaleQualities.join(', ')} female voice`);
    vocalParts.push(...otherVocals);
    if (vocalParts.length > 0) phrases.push(vocalParts.join(', '));
  }
  if (state.harmony_form.length > 0) {
    const h = state.harmony_form[0];
    const match = h.match(/^(.+?)\s*\(([^)]+)\)$/);
    if (match) {
      phrases.push(`${match[1].toLowerCase()} ${match[2]} chord progression`);
    } else {
      phrases.push(h.toLowerCase());
    }
  }
  if (state.melody.length > 0 && !state.vocal.includes('instrumental-only'))
    phrases.push(state.melody.map(m => m.toLowerCase()).join(', '));
  if (state.rhythm_groove.length > 0) {
    phrases.push(`${state.rhythm_groove.map(r => r.toLowerCase()).join(', ')} rhythm`);
  }
  if (state.groove_feel.length > 0) {
    phrases.push(`${state.groove_feel.map(g => g.toLowerCase()).join(', ')} groove`);
  }
  if (state.bass_tone.length > 0) {
    phrases.push(state.bass_tone.map(b => b.toLowerCase()).join(', '));
  }
  if (state.ear_candy_space.length > 0) {
    phrases.push(state.ear_candy_space.map(e => e.toLowerCase()).join(', '));
  }
  if (state.production.length > 0) {
    phrases.push(`${state.production[0].toLowerCase()} production`);
  }
  if (state.mix_master.length > 0) {
    const dynamicsItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'dynamics');
    const presenceItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'vocal-presence');
    const masteringItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'mastering');
    const stereoItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'stereo');
    if (dynamicsItems.length > 0)
      phrases.push(dynamicsItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase()).join(', '));
    if (presenceItems.length > 0)
      phrases.push(presenceItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase()).join(', '));
    if (masteringItems.length > 0)
      phrases.push(masteringItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase()).join(', '));
    if (stereoItems.length > 0)
      phrases.push(stereoItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase()).join(', '));
  }
  if (state.era.length > 0) {
    phrases.push(`${state.era[0].toLowerCase()} vibes`);
  }
  if (state.reference.length > 0) {
    const refStr = state.reference
      .slice(0, 2)
      .map(r => transformArtistName(r))
      .join(', ');
    phrases.push(`inspired by ${refStr}`);
  }
  if (state.goal.length > 0) {
    phrases.push(`(${state.goal[0].toLowerCase()})`);
  }
  if (state.customDetails.trim()) {
    phrases.push(state.customDetails);
  }
  return phrases.filter(Boolean).join(', ');
};
const normalizePhrase = phrase =>
  phrase
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
const addUnique = (target, phrases) => {
  const seen = new Set(target.map(normalizePhrase));
  for (const phrase of phrases) {
    const cleaned = phrase.replace(/\s+/g, ' ').trim();
    const key = normalizePhrase(cleaned);
    if (cleaned && key && !seen.has(key)) {
      target.push(cleaned);
      seen.add(key);
    }
  }
};
const lowercaseFirst = value => (value ? value.charAt(0).toLowerCase() + value.slice(1) : value);
const formatKeyMode = state => {
  if (state.modes.length > 0 && state.key.length > 0) {
    const noteMatch = state.key[0].match(/^([A-G][#b]?)/);
    const note = noteMatch ? noteMatch[1] : state.key[0];
    return `${note} ${state.modes[0].toLowerCase()}`;
  }
  if (state.key.length > 0) return state.key[0];
  if (state.modes.length > 0) return state.modes[0].toLowerCase();
  return '';
};
const formatVocals = state => {
  const maleQualities = [];
  const femaleQualities = [];
  const otherVocals = [];
  for (const id of state.vocal) {
    const parentId = VOCAL_PARENT_MAP[id];
    const name = (VOCAL_NAME_MAP[id] || id).toLowerCase();
    if (parentId === 'male-voice') {
      maleQualities.push(name);
    } else if (parentId === 'female-voice') {
      femaleQualities.push(name);
    } else {
      otherVocals.push(name);
    }
  }
  const vocalParts = [];
  if (maleQualities.length > 0) vocalParts.push(`${maleQualities.join(', ')} male voice`);
  if (femaleQualities.length > 0) vocalParts.push(`${femaleQualities.join(', ')} female voice`);
  vocalParts.push(...otherVocals);
  return vocalParts;
};
const generateFluentPrompt = state => {
  const phrases = [];
  const strategy = [
    'Reordered the prompt by Suno weight: genre first, then mood, vocals, instruments, production, and arrangement details.',
  ];
  const tricks = new Set(['Tag priority']);
  const presetGenreNames = state.genres.map(id => GENRE_NAME_MAP[id] || id);
  const hasVocals = !state.vocal.includes('instrumental-only');
  const hasVerse = state.structure.some(s => s.toLowerCase().includes('verse'));
  const hasChorus = state.structure.some(s => s.toLowerCase().includes('chorus'));
  addUnique(phrases, presetGenreNames);
  if (state.customGenre && state.customGenre.trim()) addUnique(phrases, [state.customGenre.trim()]);
  addUnique(phrases, state.mood.map(lowercaseFirst));
  addUnique(phrases, formatVocals(state));
  if (state.vocal.includes('robotic')) {
    addUnique(phrases, ['autotuned vocal texture']);
    strategy.push('Converted robotic vocals into a clearer production cue: autotuned vocal texture.');
    tricks.add('Autotuned vocals');
  }
  if (state.vocal.includes('pitched-vocals')) {
    addUnique(phrases, ['octave-stacked vocals']);
    strategy.push('Mapped pitched vocals to octave-stacked vocals for a stronger Suno-readable vocal stack.');
    tricks.add('Octave stack');
  }
  if (state.vocal.includes('whisper')) {
    addUnique(phrases, ['whisper layer']);
    strategy.push(
      'Kept whisper vocals as a dedicated layer cue instead of burying it among generic vocal adjectives.'
    );
    tricks.add('Whisper layer');
  }
  if (hasChorus && hasVocals && !state.vocal.includes('layered-vocals')) {
    addUnique(phrases, ['stacked chorus vocals']);
    strategy.push('Added stacked chorus vocals because a chorus section is present and vocals are enabled.');
    tricks.add('Vocal stack');
  }
  if (hasVerse && hasChorus && hasVocals) {
    addUnique(phrases, ['dry verses, stacked chorus contrast']);
    strategy.push(
      'Added verse/chorus contrast: dry verses against a stacked chorus, which is a reliable arrangement cue.'
    );
    tricks.add('Dynamic contrast');
  }
  addUnique(phrases, state.instruments);
  if (state.production.length > 0) addUnique(phrases, [`${state.production[0].toLowerCase()} production`]);
  if (state.mix_master.length > 0) {
    const dynamicsItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'dynamics');
    const presenceItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'vocal-presence');
    const masteringItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'mastering');
    const stereoItems = state.mix_master.filter(id => MIX_PARENT_MAP[id] === 'stereo');
    addUnique(
      phrases,
      dynamicsItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase())
    );
    addUnique(
      phrases,
      presenceItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase())
    );
    addUnique(
      phrases,
      masteringItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase())
    );
    addUnique(
      phrases,
      stereoItems.map(id => (MIX_NAME_MAP[id] || id).toLowerCase())
    );
  }
  addUnique(
    phrases,
    state.ear_candy_space.map(e => e.toLowerCase())
  );
  if (state.ear_candy_space.includes('Delay Effects')) {
    addUnique(phrases, ['slapback delay accents']);
    strategy.push('Made delay more actionable by adding slapback delay accents.');
    tricks.add('Slapback delay');
  }
  if (state.ear_candy_space.includes('Reverb-heavy')) {
    strategy.push(
      'Kept reverb-heavy as a production shaper because it strongly affects space and vocal placement.'
    );
    tricks.add('Reverb-drenched');
  }
  addUnique(
    phrases,
    state.rhythm_groove.map(r => `${r.toLowerCase()} rhythm`)
  );
  addUnique(
    phrases,
    state.groove_feel.map(g => `${g.toLowerCase()} groove`)
  );
  addUnique(
    phrases,
    state.bass_tone.map(b => b.toLowerCase())
  );
  if (state.harmony_form.length > 0) {
    const h = state.harmony_form[0];
    const match = h.match(/^(.+?)\s*\(([^)]+)\)$/);
    addUnique(phrases, [match ? `${match[1].toLowerCase()} ${match[2]} chord progression` : h.toLowerCase()]);
  }
  if (!state.vocal.includes('instrumental-only'))
    addUnique(
      phrases,
      state.melody.map(m => m.toLowerCase())
    );
  if (state.era.length > 0) addUnique(phrases, [`${state.era[0].toLowerCase()} vibes`]);
  if (state.reference.length > 0) {
    const refStr = state.reference
      .slice(0, 2)
      .map(r => transformArtistName(r))
      .join(', ');
    addUnique(phrases, [`inspired by ${refStr}`]);
  }
  if (state.tempo.length > 0)
    addUnique(phrases, [
      state.tempo[0]
        .replace(/\([^)]*\)/g, '')
        .trim()
        .toLowerCase(),
    ]);
  const keyMode = formatKeyMode(state);
  if (keyMode) addUnique(phrases, [keyMode]);
  const bpmValue = effectiveBpm(state);
  if (bpmValue) addUnique(phrases, [`${bpmValue} BPM`]);
  if (state.goal.length > 0) addUnique(phrases, [state.goal[0].toLowerCase()]);
  if (state.customDetails.trim()) addUnique(phrases, [state.customDetails]);
  let finalPhrases = phrases;
  if (phrases.length > 10) {
    strategy.push(
      `Kept all ${phrases.length} selected concepts, but reordered them so the strongest Suno drivers come first instead of deleting user choices.`
    );
    tricks.add('Priority ordering');
  }
  strategy.push(
    'Removed duplicate or overlapping descriptors so the prompt stays focused instead of competing with itself.'
  );
  if (bpmValue && keyMode) {
    strategy.push('Kept BPM and key near the end as baseline guides rather than primary creative drivers.');
    tricks.add('BPM/key stabilizers');
  } else if (bpmValue) {
    strategy.push('Kept BPM near the end as a timing guide rather than a primary creative driver.');
    tricks.add('BPM stabilizer');
  } else if (keyMode) {
    strategy.push('Kept key/mode near the end as a harmonic guide rather than a primary creative driver.');
    tricks.add('Key/mode stabilizer');
  }
  return {
    prompt: finalPhrases.join(', '),
    strategy,
    tricks: Array.from(tricks),
  };
};
const generateMetaTags = state => {
  const tags = [];
  if (state.mood.length > 0) {
    const moodValue = state.mood[0].split(' ')[0];
    tags.push(`[Mood: ${moodValue}]`);
  }
  let energyLevel = 'Medium';
  if (state.mood.some(m => m.includes('Energetic') || m.includes('Uplifting') || m.includes('Epic'))) {
    energyLevel = 'High';
  } else if (
    state.mood.some(m => m.includes('Calm') || m.includes('Relaxing') || m.includes('Melancholic'))
  ) {
    energyLevel = 'Low';
  }
  tags.push(`[Energy: ${energyLevel}]`);
  if (state.instruments.length > 0) {
    const topInstruments = state.instruments.slice(0, 3).join(', ');
    tags.push(`[Instrument: ${topInstruments}]`);
  }
  tags.push('');
  tags.push('[Intro]');
  tags.push('(establish palette)');
  tags.push('');
  tags.push('[Verse]');
  tags.push('(story lane; tight lines)');
  tags.push('');
  tags.push('[Pre-Chorus]');
  tags.push('[Build-Up]');
  tags.push('(raise anticipation)');
  tags.push('');
  tags.push('[Chorus]');
  tags.push('[Energy: High]');
  tags.push('(repeatable hook; strongest lift)');
  tags.push('');
  tags.push('[Verse 2]');
  tags.push('(new angle; same pocket)');
  tags.push('');
  tags.push('[Chorus]');
  tags.push('(keep hook consistent)');
  tags.push('');
  tags.push('[Bridge]');
  tags.push('[Breakdown]');
  tags.push('(space + contrast)');
  tags.push('');
  tags.push('[Final Chorus]');
  tags.push('[Energy: High]');
  tags.push('(biggest version)');
  tags.push('');
  tags.push('[Outro]');
  tags.push('(leave room for fade)');
  return tags.join('\n');
};
export function createEmptyState() {
  return {
    genres: [],
    mood: [],
    tempo: [],
    bpm: '',
    key: [],
    modes: [],
    structure: [],
    instruments: [],
    vocal: [],
    production: [],
    era: [],
    reference: [],
    goal: [],
    rhythm_groove: [],
    groove_feel: [],
    melody: [],
    bass_tone: [],
    harmony_form: [],
    ear_candy_space: [],
    mix_master: [],
    customDetails: '',
    customGenre: '',
    includeLyrics: false,
    sunoV6: {
      model: 'v6',
      styleInfluence: 85,
      variety: 15,
      weirdness: 10,
      maxMode: true,
      preset: 'precision',
    },
  };
}
export function randomPromptState() {
  const archetype = pickOne(RANDOM_ARCHETYPES);
  const tempo = pickOne(validFrom(archetype.tempo, TEMPO_OPTIONS));
  const instrumental = Math.random() < 0.15;
  const archetypeVocals = validFrom(archetype.vocal, VOCAL_RANDOM_OPTIONS);
  const vocal = instrumental
    ? ['instrumental-only']
    : pickMany(
        archetypeVocals.filter(id => id !== 'instrumental-only'),
        randomInt(1, 2)
      );
  const mixMaster = pickMany(
    archetype.mix.filter(id => MIX_PARENT_MAP[id]),
    randomInt(1, Math.min(3, archetype.mix.length))
  );
  return {
    ...createEmptyState(),
    genres: pickMany(validFrom(archetype.genres, GENRE_RANDOM_OPTIONS), Math.random() < 0.25 ? 2 : 1),
    mood: pickMany(validFrom(archetype.mood, MOOD_OPTIONS), 2),
    tempo: [tempo],
    bpm: bpmForTempo(tempo),
    key: [pickOne(KEY_OPTIONS)],
    modes: Math.random() < 0.2 ? [pickOne(MODES_OPTIONS)] : [],
    structure: [pickOne(STRUCTURE_OPTIONS)],
    instruments: pickMany(validFrom(archetype.instruments, INSTRUMENTS_OPTIONS), randomInt(3, 5)),
    vocal,
    production: [pickOne(validFrom(archetype.production, PRODUCTION_OPTIONS))],
    era: [pickOne(validFrom(archetype.era, ERA_OPTIONS))],
    goal: [pickOne(validFrom(archetype.goal, GOAL_OPTIONS))],
    rhythm_groove: pickMany(validFrom(archetype.rhythm, RHYTHM_OPTIONS), 1),
    groove_feel: pickMany(validFrom(archetype.groove, GROOVE_FEEL_OPTIONS), 1),
    bass_tone: pickMany(validFrom(archetype.bass, BASS_TONE_OPTIONS), 1),
    harmony_form: pickMany(validFrom(archetype.harmony, HARMONY_FORM_OPTIONS), 1),
    ear_candy_space: pickMany(validFrom(archetype.earCandy, EAR_CANDY_SPACE_OPTIONS), randomInt(1, 2)),
    mix_master: instrumental
      ? mixMaster.filter(id => id !== 'vocal-forward' && id !== 'vocal-balanced')
      : mixMaster,
    customDetails: '',
    customGenre: '',
  };
}
export function buildPrompt(state) {
  const optimized = generateFluentPrompt(state);
  const exclude = generateExcludeTerms(state);
  return {
    raw: generateRawPrompt(state),
    optimized: optimized.prompt,
    strategy: optimized.strategy,
    tricks: optimized.tricks,
    exclude: exclude.terms.join(', '),
    conflicts: exclude.conflicts,
    lyricsTemplate: state.includeLyrics ? generateMetaTags(state) : '',
  };
}
