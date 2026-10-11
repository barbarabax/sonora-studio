// @codedna
// description: Local fallback for "Auto" tempo, time signature and key when no AI is available: a guess from the words of the style.
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
// exports: guessMeta
// used_by: sonora-studio/public/create-ui.mjs
//                   sonora-studio/server.mjs
// rules:   Pure function, no I/O. Always returns a complete, valid triple (bpm 40-220, timesignature "2|3|4|6", keyscale from the 24 natural names); an explicit "NN BPM" in the text wins over any genre guess.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-10 | s_20261010_crea | Created for the Auto rows of "Crea musica".
const GENRES = [
  [/\b(ninna|lullaby)\b/, 70],
  [/\b(ballad|ballata|slow|lento|ambient|cinematic|cinematico|orchestral|orchestrale)\b/, 72],
  [/\b(blues|soul|r&b|rnb|reggae|bossa|jazz)\b/, 90],
  [/\b(lo-?fi|chill|downtempo|trip-?hop)\b/, 82],
  [/\b(hip-?hop|rap|trap)\b/, 92],
  [/\b(folk|country|acoustic|acustico|indie)\b/, 100],
  [/\b(pop|rock|alternative)\b/, 112],
  [/\b(funk|disco|swing|rockabilly)\b/, 118],
  [/\b(house|techno|edm|electronic|elettronic\w*|dance|synthwave)\b/, 124],
  [/\b(punk|metal|hardcore|drum and bass|dnb)\b/, 150],
];
const MINOR =
  /\b(sad|dark|melanch\w*|triste|malinconic\w*|moody|minor|noir|haunting|brooding|nostalgic\w*|cupo|buio)\b/;

export function guessMeta(tags = '', lyrics = '') {
  const text = String(tags).toLowerCase();
  const explicit = /\b(\d{2,3})\s*bpm\b/.exec(text);
  let bpm = explicit ? Number(explicit[1]) : null;
  if (!bpm || bpm < 40 || bpm > 220) bpm = GENRES.find(([re]) => re.test(text))?.[1] ?? 105;
  const waltz = /\b(waltz|valzer|3\/4)\b/.test(text),
    compound = /\b(6\/8|shuffle|gospel)\b/.test(text);
  const timesignature = waltz ? '3' : compound ? '6' : '4';
  const keyscale = MINOR.test(text)
    ? 'A minor'
    : /\b(bright|happy|upbeat|joyful|solare|allegr\w*)\b/.test(text)
      ? 'G major'
      : 'C major';
  void lyrics;
  return { bpm, timesignature, keyscale };
}
