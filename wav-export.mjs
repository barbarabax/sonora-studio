import fs from 'node:fs';
import { spawn } from 'node:child_process';

// The source is lossless and server-owned. Publish only a complete PCM WAV.
export function exportWav(source, target) {
  if (fs.existsSync(target)) return Promise.resolve();
  const temporary = target + '.part';
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-i',
        source,
        '-map',
        '0:a:0',
        '-c:a',
        'pcm_s24le',
        '-f',
        'wav',
        temporary,
      ],
      { windowsHide: true }
    );
    const timer = setTimeout(() => child.kill(), 120000);
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        fs.rmSync(temporary, { force: true });
        reject(error);
      } else {
        try {
          fs.renameSync(temporary, target);
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    };
    child.stderr.resume();
    child.once('error', () => finish(new Error('FFmpeg is unavailable for WAV downloads.')));
    child.once('close', code => finish(code === 0 ? null : new Error('WAV conversion failed.')));
  });
}
