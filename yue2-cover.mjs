// @codedna
// description: Prepares a song for the melody transcription of a YuE2 cover: a small mono MP3 as base64, with a length limit.
//
// exports: COVER_MAX_SECONDS | TRANSCRIBE_MAX_SECONDS | prepareCoverAudio | fadeOutEnd
// used_by: server.mjs
// related: integrations/runpod/yue2_worker.py — the `transcribe` action that reads this audio; library-upload.mjs — the upload that makes the FLAC given here
// rules:   Only reads the given file and writes one temporary MP3 next to it, always removed. Mono 24 kHz 64 kbps: SheetSage2 mixes to mono and resamples to 24 kHz anyway, and the RunPod request body stays far below its limit.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-14 | s_20261014_cover | Created for "Cover con YuE2" (melody by SheetSage2, then the song is sung again by YuE2 with cot=melody).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const COVER_MAX_SECONDS = 10 * 60;
const MAX_BYTES = 9 * 1024 * 1024;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-1)[0] || 'ffmpeg failed.'))
    );
  });
}

/** The song at `source` as { base64, bytes, format: 'mp3' }; throws an Italian Error when it cannot be prepared. */
// Rules: the yue2.cpp transcriber fails on long recordings (6:26 failed, 5:30 worked on 2026-10-15): only the first 5:30 are sent.
export const TRANSCRIBE_MAX_SECONDS = 330;
export async function prepareCoverAudio(
  source,
  { encode = ffmpeg, maxSeconds = TRANSCRIBE_MAX_SECONDS } = {}
) {
  const target = source + '.cover.mp3';
  try {
    await encode([
      '-i',
      source,
      '-vn',
      '-t',
      String(maxSeconds),
      '-ac',
      '1',
      '-ar',
      '24000',
      '-b:a',
      '64k',
      target,
    ]);
    const bytes = fs.readFileSync(target);
    if (bytes.length > MAX_BYTES) throw new Error('The song is too large to send: shorten it.');
    if (bytes.length < 1024) throw new Error('The song is too short.');
    return { base64: bytes.toString('base64'), bytes: bytes.length, format: 'mp3' };
  } finally {
    fs.rmSync(target, { force: true });
  }
}

/** Fade out the last `fade` seconds of a finished song file in place (FLAC or MP3), keeping its format. */
export async function fadeOutEnd(file, duration, { fade = 6, encode = ffmpeg } = {}) {
  if (!(duration > fade * 2)) return;
  const ext = file.slice(file.lastIndexOf('.'));
  const temp = file + '.fade' + ext;
  try {
    await encode([
      '-i',
      file,
      '-af',
      `afade=t=out:st=${(duration - fade).toFixed(2)}:d=${fade}`,
      ...(ext === '.mp3' ? ['-b:a', '192k'] : []),
      temp,
    ]);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
