// @codedna
// description: Read-only checks of the computer for the first-run setup panel: Node.js, FFmpeg and the NVIDIA graphics card.
//
// exports: createSetupCheck
// used_by: server.mjs
// rules:   Only runs `ffmpeg -version` and `nvidia-smi` with a timeout; installs nothing, sends nothing anywhere.
// agent:   claude-haiku-5-5 | anthropic | 2026-11-03 | Setup helper for the portable build.
import { spawn } from 'node:child_process';

function run(spawnImpl, command, args, timeoutMs = 8000) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', chunk => {
      if (out.length < 4000) out += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

export function createSetupCheck({
  spawnImpl = spawn,
  nodeVersion = process.version,
  platform = process.platform,
  ttlMs = 30000,
} = {}) {
  let cached = null;
  let cachedAt = 0;

  async function system() {
    const items = [];
    const major = Number(/^v(\d+)/.exec(nodeVersion)?.[1] || 0);
    items.push(
      major >= 22
        ? { id: 'node', label: 'Node.js', status: 'ok', detail: nodeVersion }
        : {
            id: 'node',
            label: 'Node.js',
            status: 'missing',
            detail: nodeVersion,
            hint: 'Sonora needs Node.js 22 or newer. Install it from nodejs.org, or use the portable download, which includes it.',
          }
    );
    const ffmpeg = await run(spawnImpl, 'ffmpeg', ['-version']);
    items.push(
      ffmpeg
        ? { id: 'ffmpeg', label: 'FFmpeg', status: 'ok', detail: ffmpeg.split('\n')[0].slice(0, 80) }
        : {
            id: 'ffmpeg',
            label: 'FFmpeg',
            status: 'missing',
            detail: 'not found on PATH',
            hint:
              platform === 'win32'
                ? 'Needed for uploads, editing, stems and export. In a Command Prompt run: winget install Gyan.FFmpeg, then restart Sonora.'
                : 'Needed for uploads, editing, stems and export. Install ffmpeg with your package manager, then restart Sonora.',
          }
    );
    const gpu = await run(spawnImpl, 'nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits',
    ]);
    const first = gpu?.split('\n').find(line => line.trim());
    if (!first) {
      items.push({
        id: 'gpu',
        label: 'NVIDIA graphics card',
        status: 'warn',
        detail: 'not found',
        hint: 'Without an NVIDIA card use RunPod or Vast.ai for ACE-Step. YuE2 on this PC needs an NVIDIA card with 12 GB.',
      });
    } else {
      const [name, memory, driver] = first.split(',').map(part => part.trim());
      const gb = Math.round((Number(memory) / 1024) * 10) / 10;
      items.push(
        gb >= 12
          ? {
              id: 'gpu',
              label: 'NVIDIA graphics card',
              status: 'ok',
              detail: `${name} · ${gb} GB · driver ${driver}`,
            }
          : {
              id: 'gpu',
              label: 'NVIDIA graphics card',
              status: 'warn',
              detail: `${name} · ${gb} GB · driver ${driver}`,
              hint: 'The YuE2 Q8_0 model was tested on a 12 GB card; with less memory it may not run. RunPod is an alternative.',
            }
      );
    }
    return items;
  }

  return {
    /** The computer's own checks, kept for a short time so the panel can refresh without starting programs each time. */
    async system({ fresh = false } = {}) {
      if (!fresh && cached && Date.now() - cachedAt < ttlMs) return cached;
      cached = await system();
      cachedAt = Date.now();
      return cached;
    },
  };
}
