// @codedna
// description: The chord bed: a YuE2 plan written at once from tempo, key and meter, chords over rests, one part per lyrics tag.
//
// exports: METERS | BED_KEYS | AUTO_MAJOR | AUTO_MINOR | lyricSectionLines | writeBed
// used_by: public/midi-io.mjs
//                   public/yue2-ui.mjs
// related: lib.mjs lyricSections — the same tag names on the server; public/chord-presets.mjs — the genre progressions and their spelling in a key
// rules:   Pure functions, no DOM. The voice gets rests only (YuE2 writes the melody over the chords) and the instrument whole-bar silences.
//          Verses and other parts play one progression, choruses a second, a bridge a third; generated progressions avoid repeated neighbouring chords; explicit custom progressions preserve every chord and repeat.
// agent:   Codex | OpenAI | 2026-11-03 | Validate custom progressions and preserve their exact order.
// claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_bed | Ported from YuE2-Studio's score/chord_bed.rs (MIT), itself after gary4juce's yuey scaffold.
import { isChord } from './abc-plan.mjs';
import { PRESETS, progressionChords, keyInfo } from './chord-presets.mjs';

export const METERS = { '4/4': 16, '3/4': 12, '6/8': 12, '2/4': 8 };
export const BED_KEYS = [
  ...['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  ...['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'],
];
/** Progressions common in pop, rock, dance, jazz and film music (YuE2-Studio's pools as Roman numerals). */
export const AUTO_MAJOR = [
  ['I', 'V', 'vi', 'IV'],
  ['I', 'vi', 'IV', 'V'],
  ['vi', 'IV', 'I', 'V'],
  ['I', 'IV', 'V', 'IV'],
  ['ii7', 'V7', 'Imaj7', 'vi7'],
  ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'],
  ['I', 'IV'],
  ['I', 'bVII'],
  ['Imaj7', 'IVmaj7'],
  ['IV', 'I', 'V', 'vi'],
  ['I', 'iii', 'IV', 'V'],
  ['I', 'V', 'IV', 'V'],
  ['vi', 'V', 'IV', 'V'],
  ['I', 'bVII', 'IV', 'I'],
  ['IV', 'V', 'iii', 'vi'],
];
export const AUTO_MINOR = [
  ['i', 'bVI', 'bIII', 'bVII'],
  ['i', 'iv', 'bVII', 'bIII'],
  ['i', 'bVII', 'bVI', 'V'],
  ['iim7b5', 'V7', 'im7', 'bVImaj7'],
  ['i', 'IV'],
  ['im7', 'ivm7'],
  ['i', 'bVI', 'bVII', 'bVI'],
  ['i', 'iv', 'v', 'iv'],
  ['i', 'bVII', 'bVI', 'bVII'],
  ['bVI', 'bVII', 'i', 'bVII'],
  ['i', 'iv', 'bVI', 'V'],
  ['i', 'bIII', 'bVII', 'bVI'],
  ['i', 'v', 'bVI', 'iv'],
  ['i', 'bVI', 'iv', 'V'],
  ['iv', 'v', 'i', 'bVII'],
  ['i', 'bVII', 'iv', 'i'],
];
const ALIASES = {
  prechorus: 'pre-chorus',
  'pre chorus': 'pre-chorus',
  'post chorus': 'post-chorus',
  hook: 'chorus',
  refrain: 'chorus',
};
const KNOWN = new Set([
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
  'theme',
  'development',
  'variation',
  'irregular',
  'preshot',
  'silence',
]);

/** [{ label, lines }] of the lyrics, in order: each tag's score name and its sung lines; words before any tag are a verse. */
export function lyricSectionLines(lyrics) {
  const sections = [];
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
      clean = ALIASES[clean] || clean;
      sections.push({ label: KNOWN.has(clean) ? clean : 'verse', lines: 0 });
      continue;
    }
    if (!/\p{L}/u.test(line)) continue;
    if (!sections.length) sections.push({ label: 'verse', lines: 0 });
    sections.at(-1).lines++;
  }
  return sections;
}

const sectionBars = (label, lines) =>
  lines > 0
    ? Math.min(32, Math.max(1, Math.ceil((lines * 2) / 4)) * 4)
    : ['interlude', 'instrumental', 'solo', 'development'].includes(label)
      ? 8
      : 4;
/**
 * Rules: with a target length the sung parts are stretched or shrunk in blocks of 4 bars (a progression loop) until the
 * whole song is as close to the target as 4-bar blocks allow; parts without words keep their own length.
 */
function fitBars(base, sung, totalBars) {
  const blocks = base.map(bars => Math.max(1, Math.round(bars / 4)));
  const flexible = blocks.map((_, i) => i).filter(i => sung[i]);
  const movable = flexible.length ? flexible : blocks.map((_, i) => i);
  const fixed = blocks.reduce((sum, b, i) => sum + (movable.includes(i) ? 0 : b), 0);
  const want = Math.max(movable.length, Math.round(totalBars / 4) - fixed);
  const have = movable.reduce((sum, i) => sum + blocks[i], 0);
  const scale = want / have;
  for (const i of movable) blocks[i] = Math.max(1, Math.round(blocks[i] * scale));
  let sum = movable.reduce((s, i) => s + blocks[i], 0);
  // settle the rounding one block at a time on the longest part
  while (sum !== want) {
    const order = [...movable].sort((a, b) => blocks[b] - blocks[a]);
    const pick = sum < want ? order[0] : order.find(i => blocks[i] > 1);
    if (pick === undefined) break;
    blocks[pick] += sum < want ? 1 : -1;
    sum += sum < want ? 1 : -1;
  }
  return blocks.map(b => b * 4);
}
const roleOf = label =>
  ['chorus', 'post-chorus', 'loop'].includes(label)
    ? 1
    : ['bridge', 'pre-outro', 'development'].includes(label)
      ? 2
      : 0;
/** A small deterministic generator: the same seed picks the same progressions. */
function draw(seed) {
  let state = (BigInt(seed >>> 0) ^ 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  return below => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number((state >> 33n) % BigInt(below));
  };
}

/**
 * @param options { bpm, key, meter, lyrics, seed, parts: [verse, chorus, bridge] } where each part is 'auto' or a PRESETS index
 * @returns { abc, bars, progressions: [[chord names] x3] }
 */
export function writeBed({
  bpm,
  key,
  meter = '4/4',
  lyrics = '',
  seed = 1,
  parts = ['auto', 'auto', 'auto'],
  custom = [],
  targetSeconds = 0,
}) {
  if (!Number.isInteger(bpm) || bpm < 40 || bpm > 240)
    throw new Error('The tempo must be between 40 and 240 beats per minute.');
  if (!BED_KEYS.includes(key)) throw new Error('Invalid key.');
  const units = METERS[meter];
  if (!units) throw new Error('Invalid meter: 4/4, 3/4, 6/8 or 2/4.');
  const minor = keyInfo(key).minor;
  const pool = minor ? AUTO_MINOR : AUTO_MAJOR;
  const next = draw(seed);
  const used = new Set();
  const progressions = [0, 1, 2].map(role => {
    if (custom[role] !== undefined) {
      const chords = String(custom[role])
        .trim()
        .split(/[\s,|]+/)
        .filter(Boolean);
      if (!chords.length || chords.length > 32 || chords.some(c => !isChord(c)))
        throw new Error('Write 1 to 32 valid chords for each loop (e.g. C Am F G7).');
      return { chords, bars: 1, exact: true };
    }
    const chosen = parts[role];
    if (chosen !== 'auto' && chosen !== undefined && PRESETS[Number(chosen)]) {
      const preset = PRESETS[Number(chosen)];
      return { chords: progressionChords(key, preset.degrees), bars: preset.bars || 1 };
    }
    let index;
    do index = next(pool.length);
    while (used.has(index));
    used.add(index);
    return { chords: progressionChords(key, pool[index]), bars: 1 };
  });
  let sections = lyricSectionLines(lyrics);
  if (!sections.length) sections = ['verse', 'chorus', 'verse', 'chorus'].map(label => ({ label, lines: 2 }));
  let abc = `X:1\nT:\nM:${meter}\nL:1/16\nQ:1/4=${bpm}\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:${key}\n`;
  let previous = null;
  let total = 0;
  const secondsPerBar = (units / 4) * (60 / bpm);
  if (targetSeconds && (!(targetSeconds >= 10) || targetSeconds > 300))
    throw new Error('The song length must be between 0:10 and 5:00.');
  const lengths = targetSeconds
    ? fitBars(
        sections.map(s => sectionBars(s.label, s.lines)),
        sections.map(s => s.lines > 0),
        targetSeconds / secondsPerBar
      )
    : sections.map(s => sectionBars(s.label, s.lines));
  for (const [index, { label }] of sections.entries()) {
    const { chords, bars: perChord, exact } = progressions[roleOf(label)];
    const bars = lengths[index];
    abc += `% ${label}\n`;
    let row = [];
    let at = 0;
    for (let bar = 0; bar < bars; bar++) {
      let chord = chords[Math.floor(at / perChord) % chords.length];
      // Rules: with one chord per bar, a chord never repeats its neighbour: the changes are what hold the song to the tempo
      if (!exact && perChord === 1 && chord === previous && chords.length > 1) {
        at++;
        chord = chords[at % chords.length];
      }
      at++;
      row.push(`"${chord}"z${units}`);
      previous = chord;
      if (row.length === 4) {
        abc += `V: Vocal\n${row.join('|')}|\nV: Ins\nZ${row.length}|\n`;
        row = [];
      }
    }
    if (row.length) abc += `V: Vocal\n${row.join('|')}|\nV: Ins\nZ${row.length}|\n`;
    total += bars;
  }
  return {
    abc,
    bars: total,
    seconds: Math.round(total * secondsPerBar),
    progressions: progressions.map(p => p.chords),
  };
}
