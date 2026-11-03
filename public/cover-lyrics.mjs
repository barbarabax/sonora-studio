// @codedna
// description: Aligns cover lyric blocks to the sung sections of a YuE2 ABC plan and estimates note/syllable density without changing words.
// exports: coverSectionFit | alignCoverLyrics
// used_by: public/yue2-ui.mjs
// rules: Pure functions. Never discard a lyric block with words; refuse automatic alignment when the plan or block count is ambiguous.
// agent:   Codex | OpenAI | 2026-10-15 | Added conservative cover lyric alignment and an approximate syllable comparison.
import { sectionStats, readPart } from './abc-edit.mjs';

function lyricBlocks(lyrics) {
  const blocks = [];
  let current = [];
  for (const line of String(lyrics).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*\[[^\]\n]+\]\s*$/.test(line)) {
      if (current.length) blocks.push(current.join('\n').trim());
      current = [];
    } else current.push(line);
  }
  if (current.length) blocks.push(current.join('\n').trim());
  return blocks.filter(Boolean);
}

function syllables(text) {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return null;
  const words = String(text).match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) || [];
  return words.reduce((sum, word) => sum + Math.max(1, (word.match(/[aeiouàèéìíòóùúü]+/gi) || []).length), 0);
}

function melodyNotes(part) {
  const singer = part.voices[0];
  if (!singer) return null;
  let count = 0;
  let tiedPitch = null;
  for (const bar of singer.bars) {
    if (bar.silent) {
      tiedPitch = null;
      continue;
    }
    if (!bar.items) return null;
    for (const item of bar.items) {
      if (item.kind === 'label') continue;
      if (item.kind === 'rest') {
        tiedPitch = null;
        continue;
      }
      const pitch = item.kind === 'note' ? String(item.midi) : item.midis?.join(',');
      if (!pitch) return null;
      if (pitch !== tiedPitch) count++;
      tiedPitch = item.tie ? pitch : null;
    }
  }
  return count;
}

export function coverSectionFit(abc, lyrics) {
  const blocks = lyricBlocks(lyrics);
  let cursor = 0;
  const sections = sectionStats(abc).map(section => {
    const notes = melodyNotes(readPart(abc, section.index));
    const text = notes > 0 ? blocks[cursor++] || '' : '';
    return { index: section.index, name: section.name, notes, text, syllables: syllables(text) };
  });
  return { sections, extraBlocks: blocks.slice(cursor) };
}

export function alignCoverLyrics(abc, lyrics) {
  const { sections, extraBlocks } = coverSectionFit(abc, lyrics);
  if (sections.some(section => section.notes === null))
    throw new Error('Some voice notes are not readable: check the score before fitting the lyrics.');
  if (extraBlocks.length)
    throw new Error(
      `The lyrics have ${extraBlocks.length} extra sung ${extraBlocks.length === 1 ? 'block' : 'blocks'}: split them or fix the score sections, so no word is lost.`
    );
  if (!sections.length) throw new Error('There are no parts in the score.');
  if (sections.some(section => !section.name || /[\]\r\n]/.test(section.name)))
    throw new Error('One of the part names cannot become a lyrics tag.');
  return sections.map(section => `[${section.name}]${section.text ? `\n${section.text}` : ''}`).join('\n\n');
}
