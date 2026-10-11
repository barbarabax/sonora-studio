// @codedna
// description: Convert Suno Prompt choices to Sonora's supported musical controls and clean lyric sections.
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
// exports: sectionOrder | parseStructure | cleanLyrics | toSonora
// used_by: sonora-studio/public/create-ui.mjs
//                   sonora-studio/public/prompt-ui.mjs
// rules:   Preserve existing lyrics unless the user chooses to transfer a new text. Do not map Suno sliders to ACE-Step.
// agent:   Codex - 2026-10-04 - Prompt-to-Sonora integration boundary.
import { effectiveBpm } from './prompt-core.mjs';
export function sectionOrder(state) {
  const value = state.structure?.[0] || 'Verse-Chorus-Verse-Chorus-Bridge-Chorus-Outro';
  if (/ambient|minimal|progressive/i.test(value)) return ['Intro', 'Verse', 'Chorus', 'Outro'];
  const sections = value.match(/Pre-Chorus|Intro|Verse(?: \d)?|Chorus|Bridge|Outro/gi);
  return sections?.length ? sections : ['Verse', 'Chorus'];
}
const SECTION_NAMES = [
  [/^pre-?(chorus|ritornello)$/i, 'Pre-Chorus'],
  [/^(verse|strofa)$/i, 'Verse'],
  [/^(chorus|ritornello|coro|ritornelli)$/i, 'Chorus'],
  [/^(bridge|ponte)$/i, 'Bridge'],
  [/^intro$/i, 'Intro'],
  [/^(outro|finale)$/i, 'Outro'],
];
/** Rules: free-text order such as "verse, verse, chorus, bridge, chorus" (Italian names accepted); unknown words are ignored, at most 16 sections. */
export function parseStructure(text) {
  const words = String(text || '').match(/pre-?(?:chorus|ritornello)|[a-zàèéìòù]+/gi) || [];
  const out = [];
  for (const word of words) {
    const hit = SECTION_NAMES.find(([pattern]) => pattern.test(word));
    if (hit) out.push(hit[1]);
  }
  return out.slice(0, 16);
}
export function cleanLyrics(value) {
  return value
    .replace(/^\s*\[(?:Mood|Energy|Instrument|Vocal):[^\]]*\]\s*$/gim, '')
    .replace(
      /^\s*\((?:establish palette|story lane; tight lines|raise anticipation|repeatable hook; strongest lift|new angle; same pocket|keep hook consistent|space \+ contrast|biggest version|leave room for fade)\)\s*$/gim,
      ''
    )
    .replace(/\[([^\]|]+)\s*\|[^\]]*\]/g, (_, section) => `[${section.trim()}]`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export function toSonora(state, prompt, lyrics = '') {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 3000)
    throw new Error('The prompt must contain 1 to 3,000 characters.');
  const result = { tags: prompt.trim() };
  if (state.vocal.length) result.instrumental = state.vocal.includes('instrumental-only');
  // Rules: an exact BPM wins; otherwise the middle of the chosen tempo band, so the composer's BPM box follows the choice.
  const wanted = effectiveBpm(state);
  if (wanted) {
    const bpm = Number(wanted);
    if (!Number.isInteger(bpm) || bpm < 30 || bpm > 250)
      throw new Error('Sonora supporta BPM interi da 30 a 250.');
    result.bpm = bpm;
  }
  const key = state.key?.[0]?.replace(/\b(Major|Minor)\b/g, s => s.toLowerCase());
  if (key) result.keyscale = key;
  if (lyrics.trim()) {
    const cleaned = cleanLyrics(lyrics);
    if (cleaned.length > 12000) throw new Error('Text exceeds 12,000 characters.');
    result.lyrics = cleaned;
    result.instrumental = false;
  }
  return result;
}
