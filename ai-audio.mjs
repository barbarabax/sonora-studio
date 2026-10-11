// @codedna
// description: Short mono WAV excerpts (FFmpeg) for AI models that can listen.
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
// exports: probeDuration | excerptWindow | excerpt
// used_by: sonora-studio/audio-lab.mjs
//                   sonora-studio/server.mjs
// rules:   Paths come from the server, never from the browser; excerpts stay in memory and are never saved.
// agent:   Claude - 2026-10-05 - Audio input for OpenAI listening models.
import { spawn } from 'node:child_process';

const MAX_BYTES = 40 * 1024 * 1024;

function run(command, args, binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const out = [];
    let size = 0,
      error = '';
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) child.kill();
      else out.push(chunk);
    });
    child.stderr.on('data', chunk => (error = (error + chunk).slice(-600)));
    child.once('error', e =>
      reject(
        new Error(
          e.code === 'ENOENT' ? 'FFmpeg was not found. Install it to let AI analyze audio.' : e.message
        )
      )
    );
    child.once('close', code => {
      if (code !== 0 || size > MAX_BYTES)
        reject(new Error('Could not prepare the audio excerpt. ' + error.trim().split('\n').pop()));
      else resolve(binary ? Buffer.concat(out) : Buffer.concat(out).toString('utf8'));
    });
  });
}

export async function probeDuration(file) {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    false
  );
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Unrecognized audio format.');
  return seconds;
}

// A window of `length` seconds centred around `position` (0–1) of the track, kept inside it.
export function excerptWindow(total, length, position = 0.4) {
  if (total <= length) return { start: 0, seconds: total };
  const start = Math.min(Math.max(0, total * position - length / 2), total - length);
  return { start: Math.round(start * 10) / 10, seconds: length };
}

export async function excerpt(file, { start = 0, seconds = 60, rate = 24000 } = {}) {
  const wav = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(start),
      '-t',
      String(seconds),
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(rate),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1',
    ],
    true
  );
  if (wav.length < 1000) throw new Error('Audio excerpt is empty.');
  return { data: wav.toString('base64'), format: 'wav', start, seconds };
}
