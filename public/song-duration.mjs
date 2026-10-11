// @codedna
// description: Shared, deterministic lyric-to-bars duration estimate for the composer and ComfyUI requests.
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
// 
//
// 
//
// exports: parseDuration | formatDuration | estimateSongDuration
// used_by: sonora-studio/lib.mjs
//                   sonora-studio/public/app.js
//                   sonora-studio/public/create-ui.mjs
//                   sonora-studio/public/duration-field.mjs
//                   sonora-studio/public/prompt-ui.mjs
// rules:   Report estimates as estimates. Do not silently truncate long songs or count metadata as sung words.
// agent:   Codex - 2026-10-04 - Automatic vocal duration with explicit sections and editable musical spacing.
// Parse a typed song length: "2:30", "150" (seconds) or a single digit "3" (minutes).
// Returns whole seconds between 0:10 and 5:00, otherwise null.
export function parseDuration(value) {
  const text = String(value ?? '').trim();
  const clock = /^(\d{1,2}):([0-5]?\d)$/.exec(text);
  let seconds = null;
  if (clock) seconds = Number(clock[1]) * 60 + Number(clock[2]);
  else if (/^\d{1,3}$/.test(text)) seconds = Number(text) < 10 ? Number(text) * 60 : Number(text);
  return Number.isInteger(seconds) && seconds >= 10 && seconds <= 300 ? seconds : null;
}
/** Seconds as m:ss. */
export const formatDuration = seconds =>
  `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const METERS = { 2: [2, 4], 3: [3, 4], 4: [4, 4], 6: [6, 8] };
const PACING = {
  normal: { bars: 2, density: 4 },
  fast: { bars: 1, density: 6 },
  relaxed: { bars: 3, density: 2 },
};
const ARRANGEMENTS = {
  written: { edge: 0, gap: 0 },
  balanced: { edge: 4, gap: 2 },
  spacious: { edge: 8, gap: 4 },
};
const wordsIn = line => line.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) || [];
const syllablesIn = (line, language) =>
  wordsIn(line).reduce((sum, word) => {
    let count = (word.toLowerCase().match(/[aeiouyàèéìòóùâêîôûäëïöüáíúãõæœ]+/g) || []).length;
    if (language === 'en' && count > 1 && /[^aeiou]e$/i.test(word)) count--;
    return sum + Math.max(1, count);
  }, 0);
function sectionType(label) {
  if (/^(?:intro|introduction|introduzione)\b/i.test(label)) return 'intro';
  if (/^(?:outro|coda|finale|ending)\b/i.test(label)) return 'outro';
  if (/pre[- ]?(?:chorus|ritornello)/i.test(label)) return 'prechorus';
  if (/chorus|ritornello|hook/i.test(label)) return 'chorus';
  if (/bridge|ponte/i.test(label)) return 'bridge';
  if (/verse|strofa/i.test(label)) return 'verse';
  if (
    /\b(?:solo|assolo|instrumental|instrumental|interlude|interludio|breakdown|break|intermezzo|stacco|pausa|silence|silenzio)\b/i.test(
      label
    )
  )
    return 'instrumental';
  return 'text';
}
function parseSections(lyrics) {
  const sections = [];
  let current,
    continuation = null;
  const add = (title, type) => {
    current = { id: `${sections.length}:${type}`, title, type, text: [] };
    sections.push(current);
  };
  for (let line of lyrics.replace(/\r/g, '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    const tag = /^\[([^\]\n]{1,120})\](.*)$/.exec(line);
    if (tag) {
      continuation = null;
      const title = tag[1].split('|')[0].trim();
      if (!/^(?:mood|energy|instrument|vocal|tempo|bpm|key|style)\s*:/i.test(title))
        add(title, sectionType(title));
      line = tag[2].trim();
      if (!line) continue;
    }
    const direction = /^\(([^)]+)\)$/.exec(line);
    if (
      direction &&
      /^(?:instrumental|solo|assolo|interlude|interludio|stacco|breakdown|break|pausa|silence|silenzio|intro|outro)\b/i.test(
        direction[1]
      )
    ) {
      const previous = current;
      add(direction[1], sectionType(direction[1]));
      current = null;
      continuation = previous
        ? { title: previous.title.replace(/ \(continua\)$/, ''), type: previous.type }
        : continuation;
      continue;
    }
    if (
      /^\((?:instrumental|solo|assolo|music|intro|outro|fade|silence|pausa|piano|trumpet|tromba|guitar|chitarra|drums|batteria|strings|archi)\b[^)]*\)$/i.test(
        line
      )
    )
      continue;
    line = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!wordsIn(line).length) continue;
    if (!current) {
      add(continuation ? continuation.title + ' (continued)' : 'Lyrics', continuation?.type || 'text');
      continuation = null;
    }
    current.text.push(line);
  }
  return sections;
}

export function estimateSongDuration({
  lyrics = '',
  bpm = 110,
  timesignature = '4',
  language = 'it',
  lyricPacing = 'normal',
  durationArrangement = 'written',
  durationOverrides = {},
} = {}) {
  const invalid = reason => ({
    valid: false,
    reason,
    sections: [],
    seconds: 0,
    totalBars: 0,
    hasLyrics: false,
    overflow: false,
  });
  if (typeof lyrics !== 'string' || lyrics.length > 12000)
    return invalid('Enter up to 12,000 characters of lyrics.');
  if (!Number.isInteger(bpm) || bpm < 30 || bpm > 250) return invalid('Enter a whole-number BPM from 30 to 250.');
  const meter = Object.hasOwn(METERS, timesignature) && METERS[timesignature],
    pacing = Object.hasOwn(PACING, lyricPacing) && PACING[lyricPacing],
    arrangement = Object.hasOwn(ARRANGEMENTS, durationArrangement) && ARRANGEMENTS[durationArrangement];
  if (!meter || !pacing || !arrangement) return invalid('Invalid time signature, lyric pacing or arrangement.');
  if (
    !durationOverrides ||
    typeof durationOverrides !== 'object' ||
    Array.isArray(durationOverrides) ||
    Object.keys(durationOverrides).length > 128 ||
    Object.entries(durationOverrides).some(
      ([k, v]) => !Number.isInteger(v) || v < (k.startsWith('auto:') ? 0 : 1) || v > 128
    )
  )
    return invalid('Bars must be whole numbers from 1 to 128; added spaces can be 0.');
  const [numerator, denominator] = meter,
    quarterNotesPerBar = (numerator * 4) / denominator,
    secondsPerBar = (quarterNotesPerBar * 60) / bpm;
  const parsed = parseSections(lyrics);
  if (parsed.length > 128) return invalid('Lyrics contain too many sections (maximum 128).');
  let previousChorus = null;
  const writtenSections = parsed.map(section => {
    const lines = section.text.length,
      words = section.text.reduce((n, line) => n + wordsIn(line).length, 0),
      syllables = section.text.reduce((n, line) => n + syllablesIn(line, language), 0);
    const sungBars = section.text.reduce(
      (n, line) =>
        n +
        Math.max(pacing.bars, Math.ceil(syllablesIn(line, language) / (quarterNotesPerBar * pacing.density))),
      0
    );
    let estimatedBars = Math.max(sungBars, ['intro', 'outro', 'instrumental'].includes(section.type) ? 4 : 0),
      repeated = false;
    if (section.type === 'chorus' && !lines && previousChorus) {
      estimatedBars = previousChorus;
      repeated = true;
    }
    if (section.type === 'chorus' && lines) previousChorus = estimatedBars;
    const overridden = Object.hasOwn(durationOverrides, section.id),
      bars = overridden ? durationOverrides[section.id] : estimatedBars;
    return {
      id: section.id,
      title: section.title,
      type: section.type,
      lines,
      words,
      syllables,
      estimatedBars,
      bars,
      overridden,
      repeated,
      synthetic: false,
      sung: lines > 0 || repeated,
      seconds: bars * secondsPerBar,
    };
  });
  const sections = [];
  const addSpace = (id, title, type, bars) => {
    const overridden = Object.hasOwn(durationOverrides, id),
      actual = overridden ? durationOverrides[id] : bars;
    sections.push({
      id,
      title,
      type,
      lines: 0,
      words: 0,
      syllables: 0,
      estimatedBars: bars,
      bars: actual,
      overridden,
      repeated: false,
      synthetic: true,
      sung: false,
      seconds: actual * secondsPerBar,
    });
  };
  const musical = writtenSections.filter(s => s.bars > 0);
  if (arrangement.edge && musical[0]?.sung)
    addSpace('auto:intro', 'Intro instrumental aggiunta', 'intro', arrangement.edge);
  let previous = null;
  for (const section of writtenSections) {
    if (arrangement.gap && previous?.sung && section.sung && section.bars > 0)
      addSpace('auto:gap:' + section.id, 'Stacco prima di ' + section.title, 'instrumental', arrangement.gap);
    sections.push(section);
    if (section.bars > 0) previous = section;
  }
  if (arrangement.edge && musical.at(-1)?.sung)
    addSpace('auto:outro', 'Coda instrumental aggiunta', 'outro', arrangement.edge);
  if (sections.length > 128) return invalid('Too many sections, including musical spaces (maximum 128).');
  const totalBars = sections.reduce((n, s) => n + s.bars, 0),
    hasLyrics = sections.some(s => s.words > 0);
  const vocalBars = sections.filter(s => s.sung).reduce((n, s) => n + s.bars, 0),
    instrumentalBars = totalBars - vocalBars,
    addedBars = sections.filter(s => s.synthetic).reduce((n, s) => n + s.bars, 0);
  const seconds = hasLyrics ? Math.max(10, Math.ceil(totalBars * secondsPerBar - 1e-9)) : 0;
  return {
    valid: hasLyrics,
    reason: hasLyrics ? '' : 'Enter lyrics to estimate the duration.',
    seconds,
    totalBars,
    vocalBars,
    instrumentalBars,
    addedBars,
    durationArrangement,
    secondsPerBar,
    quarterNotesPerBar,
    meter: `${numerator}/${denominator}`,
    hasLyrics,
    overflow: seconds > 300,
    sections,
  };
}
