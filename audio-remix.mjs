// @codedna
// description: ffmpeg helpers for remix/repaint: compressed source for the GPU worker and a crossfaded splice of a regenerated section.
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
// exports: audioSeconds | encodeSource | repaintWindow | spliceSection | placeSection
// used_by: sonora-studio/server.mjs
//                   sonora-studio/stems.mjs
// rules:   Never write outside the given paths; the original song file is only read. A repaint splices a regenerated window back with 0.4 s crossfades, so the original must keep its exact length.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-08 | s_20261008_remix | Added remix/repaint support (ACE-Step has no repaint node in ComfyUI: the window is regenerated as a remix and spliced).
import { spawn } from 'node:child_process';

const FADE = 0.4;
const MIN_WINDOW = 10;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let out = '',
      err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolve(out)
        : reject(new Error('ffmpeg failed: ' + err.trim().split('\n').slice(-2).join(' ')))
    );
  });
}

/** Length in seconds of an audio file. */
export async function audioSeconds(file) {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  const value = Number(out.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error('Audio duration cannot be read.');
  return value;
}

/** Compressed copy (stereo 44.1 kHz MP3 128k) of a section of the source, small enough to travel inside a RunPod request. */
export async function encodeSource(source, target, { start = 0, length = null } = {}) {
  const range = length ? ['-ss', String(start), '-t', String(length)] : [];
  await run('ffmpeg', [
    '-y',
    '-v',
    'error',
    ...range,
    '-i',
    source,
    '-vn',
    '-ac',
    '2',
    '-ar',
    '44100',
    '-b:a',
    '128k',
    target,
  ]);
}

/**
 * Window regenerated for a repaint: the section plus context on both sides, never shorter than 10 s (the model's minimum)
 * and clamped to the song. Returns { windowStart, windowEnd }.
 */
export function repaintWindow(start, end, total) {
  const length = end - start;
  if (!(start >= 0) || !(end > start) || end > total + 0.05) throw new Error('Invalid range.');
  if (length < 1) throw new Error('The section to regenerate must be at least 1 second long.');
  const pad = Math.max(2, (MIN_WINDOW - length) / 2);
  let windowStart = Math.max(0, start - pad),
    windowEnd = Math.min(total, end + pad);
  if (windowEnd - windowStart < MIN_WINDOW) {
    if (windowStart === 0) windowEnd = Math.min(total, MIN_WINDOW);
    else windowStart = Math.max(0, windowEnd - MIN_WINDOW);
  }
  if (windowEnd - windowStart < MIN_WINDOW)
    throw new Error('The track is too short to regenerate a section (minimum 10 seconds).');
  return { windowStart, windowEnd };
}

/**
 * Replace [start, end] of `original` with the same span of `segment` (which begins at `windowStart` of the original timeline),
 * crossfading 0.4 s at each seam. Writes FLAC and MP3 and keeps the original's total length.
 */
export async function spliceSection({ original, segment, start, end, windowStart, total, flacOut, mp3Out }) {
  const hasHead = start > 0.05,
    hasTail = end < total - 0.05;
  const norm = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const from = start - windowStart,
    to = end - windowStart + (hasTail ? FADE : 0);
  const chain = [`[1:a]${norm},atrim=${from.toFixed(3)}:${to.toFixed(3)},asetpts=PTS-STARTPTS[m]`];
  let current = '[m]';
  if (hasHead) {
    chain.push(`[0:a]${norm},atrim=0:${(start + FADE).toFixed(3)},asetpts=PTS-STARTPTS[h]`);
    chain.push(`[h]${current}acrossfade=d=${FADE}:c1=tri:c2=tri[hm]`);
    current = '[hm]';
  }
  if (hasTail) {
    chain.push(`[2:a]${norm},atrim=${end.toFixed(3)},asetpts=PTS-STARTPTS[t]`);
    chain.push(`${current}[t]acrossfade=d=${FADE}:c1=tri:c2=tri[out]`);
    current = '[out]';
  }
  const map = current === '[m]' ? '[m]' : current;
  const base = [
    '-y',
    '-v',
    'error',
    '-i',
    original,
    '-i',
    segment,
    '-i',
    original,
    '-filter_complex',
    chain.join(';'),
    '-map',
    map,
  ];
  await run('ffmpeg', [...base, '-c:a', 'flac', flacOut]);
  await run('ffmpeg', [...base, '-c:a', 'libmp3lame', '-q:a', '0', mp3Out]);
}

/**
 * Puts [start, end] of a regenerated window (which begins at `windowStart` of the song timeline) into an otherwise silent file
 * as long as the whole song, with 0.25 s fades at both edges. Used for an AI instrument that plays only in one section.
 */
export async function placeSection({ segment, start, end, windowStart, total, flacOut, mp3Out }) {
  const fade = Math.min(0.25, (end - start) / 4);
  const from = start - windowStart,
    to = end - windowStart,
    length = end - start;
  const graph =
    `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=${from.toFixed(3)}:${to.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:d=${fade.toFixed(3)},afade=t=out:st=${(length - fade).toFixed(3)}:d=${fade.toFixed(3)},` +
    `adelay=${Math.round(start * 1000)}:all=1,apad=whole_dur=${total.toFixed(3)}[out]`;
  const base = [
    '-y',
    '-v',
    'error',
    '-i',
    segment,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-t',
    total.toFixed(3),
  ];
  await run('ffmpeg', [...base, '-c:a', 'flac', flacOut]);
  await run('ffmpeg', [...base, '-c:a', 'libmp3lame', '-q:a', '0', mp3Out]);
}
