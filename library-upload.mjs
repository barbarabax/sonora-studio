// @codedna
// description: Turn an uploaded audio file into FLAC 44.1 kHz stereo + MP3 files ready to become a library song.
//
// 
//
// 
//
// 
//
// exports: UPLOAD_LIMIT | receiveUpload
// used_by: sonora-studio/server.mjs
// rules:   The raw upload is streamed to a temporary file with a size cap and always deleted; a file that ffmpeg cannot read is rejected and leaves no trace. Output names are server-chosen (uuid), never taken from the client.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-10 | s_20261010_crea | Created for uploading songs as Remix/Modifica sources.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const UPLOAD_LIMIT = 150 * 1024 * 1024;
const MAX_SECONDS = 20 * 60;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-1)[0]))
    );
  });
}

/**
 * Stream `req` into `dir`, then convert. Returns { id, flac, mp3, title }. `probe(file)` gives the length in seconds.
 * The caller registers the library job; on any failure nothing is left behind.
 */
export async function receiveUpload(req, { dir, tmpDir, probe, convert = ffmpeg }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const id = randomUUID();
  const raw = path.join(tmpDir, id + '.upload');
  const flac = path.join(dir, id + '.flac'),
    mp3 = path.join(dir, id + '.mp3');
  let bytes = 0;
  const fd = fs.openSync(raw, 'wx');
  try {
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > UPLOAD_LIMIT) throw new Error('File exceeds 150 MB.');
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (bytes < 256) throw new Error('Audio file is empty.');
    let seconds;
    try {
      seconds = await probe(raw);
    } catch {
      throw new Error('This does not appear to be an audio file. Use WAV, MP3, FLAC, M4A or OGG.');
    }
    if (!(seconds >= 1)) throw new Error('Track is too short.');
    if (seconds > MAX_SECONDS)
      throw new Error('Track is over 20 minutes long. Trim it before uploading.');
    try {
      await convert(['-i', raw, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'flac', flac]);
      await convert(['-i', flac, '-vn', '-b:a', '192k', mp3]);
    } catch (e) {
      throw new Error('Could not read this audio file: ' + (e.message || 'unsupported format.'));
    }
    let name = 'Uploaded track';
    try {
      name = decodeURIComponent(req.headers['x-audio-name'] || name);
    } catch {}
    const title =
      name
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[\u0000-\u001f]/g, '')
        .trim()
        .slice(0, 90) || 'Uploaded track';
    return { id, flac, mp3, title, seconds };
  } catch (e) {
    fs.rmSync(flac, { force: true });
    fs.rmSync(mp3, { force: true });
    throw e;
  } finally {
    fs.rmSync(raw, { force: true });
  }
}
