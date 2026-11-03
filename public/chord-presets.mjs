// @codedna
// description: Chord vocabulary for the YuE2 plan: every chord quality a user can pick, and classic progressions by genre applied to the plan in its own key.
//
// exports: QUALITIES | ROOTS | composeChord | keyInfo | progressionChords | PRESETS | applyProgression
// used_by: public/abc-edit.mjs
//                   public/chord-bed.mjs
//                   public/yue2-ui.mjs
// rules:   Pure functions, no DOM. Progressions are written as Roman numerals relative to the tonic of the plan (K: line) and become chord names in that key, with flats for flat keys. They are classic patterns, not  applying one rewrites chord symbols only, never notes.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-11 | s_20261011_yue2 | Created after the user asked for sevenths, diminished chords and starting progressions by genre.
import { parsePlan, setChords, isChord } from './abc-plan.mjs';

/** The suffix written after the root, with a plain English name. */
export const QUALITIES = [
  { symbol: '', label: 'major' },
  { symbol: 'm', label: 'minor' },
  { symbol: '7', label: 'seventh (dominant)' },
  { symbol: 'maj7', label: 'major seventh' },
  { symbol: 'm7', label: 'minor 7' },
  { symbol: 'm7b5', label: 'half-diminished' },
  { symbol: 'dim', label: 'diminished' },
  { symbol: 'dim7', label: 'diminished 7' },
  { symbol: 'aug', label: 'augmented' },
  { symbol: 'sus2', label: 'sus2' },
  { symbol: 'sus4', label: 'sus4' },
  { symbol: '7sus4', label: '7 sus4' },
  { symbol: '6', label: 'sixth' },
  { symbol: 'm6', label: 'minor 6' },
  { symbol: '9', label: 'ninth' },
  { symbol: 'maj9', label: 'major ninth' },
  { symbol: 'm9', label: 'minor 9' },
  { symbol: 'add9', label: 'add9' },
  { symbol: '5', label: 'fifth (power chord)' },
];
export const ROOTS = [
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

/** Root + quality (+ optional slash bass). */
export function composeChord(root, quality = '', bass = '') {
  const chord = root + quality + (bass ? '/' + bass : '');
  return isChord(chord) ? chord : null;
}

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FLAT_MAJOR = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']);
const FLAT_MINOR = new Set(['D', 'G', 'C', 'F', 'Bb', 'Eb']);

/** Tonic (0-11), minor or major, and whether its chords are spelled with flats, from a K: value such as D, Bm, F#m, Eb. */
export function keyInfo(key) {
  const match = /^\s*([A-G])([#b]?)\s*([A-Za-z]*)/.exec(key || 'C') || ['', 'C', '', ''];
  const minor = /^(m|min|minor|aeo|dor|phr|loc)/i.test(match[3] || '') && !/^maj/i.test(match[3] || '');
  const tonic = (SEMITONES[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
  const name = match[1] + match[2];
  const flats = match[2] === 'b' || (minor ? FLAT_MINOR.has(name) : FLAT_MAJOR.has(name));
  return { tonic, minor, flats };
}

const DEGREES = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };
/** One Roman numeral ("ii7", "bVII", "Imaj7", "vi", "V7", "viidim") in a key -> chord name, or null. */
function degreeChord(token, info) {
  const match = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(.*)$/.exec(token);
  if (!match) return null;
  const numeral = match[2];
  const lower = numeral === numeral.toLowerCase();
  const offset = DEGREES[numeral.toUpperCase()] + (match[1] === 'b' ? -1 : match[1] === '#' ? 1 : 0);
  const root = (info.tonic + offset + 12) % 12;
  const suffix = match[3] || '';
  const names = info.flats ? FLATS : SHARPS;
  // a lower-case numeral is a minor chord unless the suffix already says what it is
  const quality = lower && !/^(m|dim|ø|°|aug|sus)/.test(suffix) ? 'm' + suffix : suffix;
  return names[root] + quality;
}

/** [chord names] for a list of Roman numerals in a key ("D", "Bm"). */
export function progressionChords(key, degrees) {
  const info = keyInfo(key);
  return degrees.map(d => degreeChord(d, info)).filter(Boolean);
}

/** Classic progressions by genre. `bars` = bars each chord lasts by default. */
export const PRESETS = [
  { genre: 'Pop', name: 'The pop loop (I–V–vi–IV)', degrees: ['I', 'V', 'vi', 'IV'], bars: 1 },
  { genre: 'Pop', name: 'Melancholic pop (vi–IV–I–V)', degrees: ['vi', 'IV', 'I', 'V'], bars: 1 },
  {
    genre: 'Pop',
    name: 'Canon (I–V–vi–iii–IV–I–IV–V)',
    degrees: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'],
    bars: 1,
  },
  { genre: 'Rock', name: 'Classic rock (I–IV–V–IV)', degrees: ['I', 'IV', 'V', 'IV'], bars: 1 },
  { genre: 'Rock', name: 'Rock with the flat VII (I–bVII–IV–I)', degrees: ['I', 'bVII', 'IV', 'I'], bars: 1 },
  { genre: 'Rock', name: 'Minor rock (i–bVII–bVI–bVII)', degrees: ['i', 'bVII', 'bVI', 'bVII'], bars: 1 },
  { genre: 'Punk and pop-punk', name: 'Three chords (I–IV–V)', degrees: ['I', 'IV', 'V', 'V'], bars: 1 },
  { genre: 'Punk and pop-punk', name: 'Pop-punk (I–V–vi–IV)', degrees: ['I', 'V', 'vi', 'IV'], bars: 1 },
  {
    genre: 'Blues',
    name: '12-bar blues',
    degrees: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'],
    bars: 1,
  },
  {
    genre: 'Blues',
    name: 'Minor blues (i7–i7–iv7–i7–bVI7–V7–i7–V7)',
    degrees: ['i7', 'i7', 'iv7', 'i7', 'bVI7', 'V7', 'i7', 'V7'],
    bars: 1,
  },
  { genre: 'Jazz', name: 'II–V–I (ii7–V7–Imaj7)', degrees: ['ii7', 'V7', 'Imaj7', 'Imaj7'], bars: 1 },
  { genre: 'Jazz', name: 'Turnaround (Imaj7–vi7–ii7–V7)', degrees: ['Imaj7', 'vi7', 'ii7', 'V7'], bars: 1 },
  { genre: 'Jazz', name: 'Rhythm changes (I–vi–ii–V)', degrees: ['I', 'vi', 'ii7', 'V7'], bars: 1 },
  {
    genre: 'Lo-fi and neo soul',
    name: 'Lo-fi (ii7–V7–Imaj7–vi7)',
    degrees: ['ii7', 'V7', 'Imaj7', 'vi7'],
    bars: 2,
  },
  {
    genre: 'Lo-fi and neo soul',
    name: 'Mellow (IVmaj7–iii7–ii7–Imaj7)',
    degrees: ['IVmaj7', 'iii7', 'ii7', 'Imaj7'],
    bars: 2,
  },
  { genre: '50s and soul', name: 'Doo-wop (I–vi–IV–V)', degrees: ['I', 'vi', 'IV', 'V'], bars: 1 },
  { genre: 'Folk and country', name: 'Folk (I–IV–V–I)', degrees: ['I', 'IV', 'V', 'I'], bars: 1 },
  { genre: 'Folk and country', name: 'Country (I–IV–I–V)', degrees: ['I', 'IV', 'I', 'V'], bars: 1 },
  { genre: 'Reggae', name: 'Reggae (I–IV)', degrees: ['I', 'IV'], bars: 2 },
  {
    genre: 'Indie and dark',
    name: 'Aeolian (i–bVI–bIII–bVII)',
    degrees: ['i', 'bVI', 'bIII', 'bVII'],
    bars: 1,
  },
  { genre: 'Indie and dark', name: 'Andalusian (i–bVII–bVI–V)', degrees: ['i', 'bVII', 'bVI', 'V'], bars: 1 },
  { genre: 'Indie and dark', name: 'Classic minor (i–iv–v–i)', degrees: ['i', 'iv', 'v', 'i'], bars: 1 },
  { genre: 'Dance and recent pop', name: 'Dance (vi–IV–I–V)', degrees: ['vi', 'IV', 'I', 'V'], bars: 1 },
  {
    genre: 'Dance and recent pop',
    name: 'Minor dance (i–bVI–bIII–bVII)',
    degrees: ['i', 'bVI', 'bIII', 'bVII'],
    bars: 1,
  },
];

/**
 * Rewrite the chords of a plan with a progression: `section` is a section name or null for the whole song;
 * the chord changes every `barsPerChord` bars and the pattern repeats. Returns the new ABC text.
 */
export function applyProgression(abc, { degrees, section = null, barsPerChord = 1 }) {
  const plan = parsePlan(abc);
  const names = progressionChords(plan.header.key, degrees);
  if (!names.length) throw new Error('Invalid chord pattern.');
  const changes = new Map();
  const sections = plan.sections.filter(s => s.slots.length && (section === null || s.name === section));
  for (const target of sections) {
    const bars = [...new Set(target.slots.map(slot => slot.bar))];
    for (const slot of target.slots) {
      const barIndex = bars.indexOf(slot.bar);
      changes.set(slot.id, names[Math.floor(barIndex / Math.max(1, barsPerChord)) % names.length]);
    }
  }
  if (!changes.size) throw new Error('No chord to change in this part of the plan.');
  return setChords(abc, changes);
}
