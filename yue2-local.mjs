// @codedna
// description: Runs YuE2 on this computer's own GPU, one Python process per job, behind the same calls as the RunPod backend.
//
// exports: createLocalYue2
// used_by: server.mjs
// related: runpod-backend.mjs — the RunPod twin (call, submitAction, status, cancel, collect); integrations/local/yue2_local.py — the process this spawns
// rules:   Job ids are UUIDs and every path is built from them under dataDir/yue2-local; nothing else is ever executed. A job survives a restart of the app (detached process, result and error written to files). The song is copied into the library only after its size and SHA-256 match the worker's receipt; the local copy is removed afterwards.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-12 | s_20261012_yue2 | Created so YuE2 can run on the user's RTX 2060 (about 6x slower than real time, no cost).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'integrations',
  'local',
  'yue2_local.py'
);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * @param settings { python, script?, hfHome?, flags? } as in config.yue2.local; `python` is the interpreter of the YuE2 environment
 *   (flags default to ['-u']; the tests run another program).
 * @param options { dataDir, spawnImpl? }
 */
export function createLocalYue2(settings = {}, { dataDir, spawnImpl = spawn } = {}) {
  const configured = typeof settings.python === 'string' && settings.python.trim() !== '';
  const base = path.join(dataDir || '.', 'yue2-local');
  const script = settings.script || DEFAULT_SCRIPT;
  const folder = id => {
    if (!UUID.test(String(id))) throw new Error('Invalid job identifier.');
    return path.join(base, String(id).toLowerCase());
  };

  /** The last "(NN%)" the library printed, as a short label for the job's phase. */
  function progress(dir) {
    try {
      const log = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8').slice(-4000).split(/\r?\n/);
      for (let i = log.length - 1; i >= 0; i--) {
        const m = /\[YuE2\] Running .*?\((\d+)%\)/.exec(log[i]);
        if (m) return `${m[1]}%`;
      }
    } catch {
      /* no log yet */
    }
    return '';
  }

  function start(input) {
    if (!configured) throw new Error('YuE2 on the PC is not configured.');
    if (!fs.existsSync(settings.python))
      throw new Error('I cannot find the YuE2 Python on the PC: ' + settings.python);
    const dir = folder(input.localId);
    fs.mkdirSync(dir, { recursive: true });
    for (const stale of ['result.json', 'error.json', 'cancelled'])
      fs.rmSync(path.join(dir, stale), { force: true });
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(input));
    const log = fs.openSync(path.join(dir, 'log.txt'), 'w');
    const child = spawnImpl(
      settings.python,
      [...(settings.flags ?? ['-u']), script, path.join(dir, 'request.json'), dir],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log, log],
        env: {
          ...process.env,
          YUE2_VOLUME: base,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          ...(settings.hfHome ? { HF_HOME: settings.hfHome } : {}),
          // SheetSage2 (melody of a cover) runs in its own Python environment, set up by the user on this PC.
          ...(settings.sheetsage?.python ? { SHEETSAGE_PYTHON: settings.sheetsage.python } : {}),
          ...(settings.sheetsage?.repo ? { SHEETSAGE_REPO: settings.sheetsage.repo } : {}),
          ...(settings.sheetsage?.dtype ? { SHEETSAGE_DTYPE: settings.sheetsage.dtype } : {}),
        },
      }
    );
    fs.closeSync(log);
    child.on('error', error =>
      fs.writeFileSync(path.join(dir, 'error.json'), JSON.stringify({ error: error.message }))
    );
    child.unref();
    fs.writeFileSync(path.join(dir, 'pid'), String(child.pid ?? 0));
    fs.writeFileSync(path.join(dir, 'started'), String(Date.now()));
    return { host: 'local', id: String(input.localId).toLowerCase() };
  }

  /** The state of a job from its files: COMPLETED (output), FAILED, CANCELLED, IN_PROGRESS (progress) or LOST. */
  function inspect(id) {
    const dir = folder(id);
    if (!fs.existsSync(dir)) return { status: 'LOST' };
    const result = readJson(path.join(dir, 'result.json'));
    if (result) return { status: 'COMPLETED', output: result };
    if (fs.existsSync(path.join(dir, 'cancelled'))) return { status: 'CANCELLED' };
    const failure = readJson(path.join(dir, 'error.json'));
    if (failure) return { status: 'FAILED', error: failure.error };
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8') || 0);
    const started = Number(fs.readFileSync(path.join(dir, 'started'), 'utf8') || 0);
    if (pid && alive(pid)) return { status: 'IN_PROGRESS', progress: progress(dir) };
    // The process ended without leaving a result: give the files a moment to appear before calling it lost.
    return Date.now() - started < 3000
      ? { status: 'IN_PROGRESS', progress: '' }
      : { status: 'FAILED', error: 'The YuE2 process stopped without a result.' };
  }

  return {
    configured,
    async health() {
      if (!configured)
        return {
          online: false,
          ready: false,
          backend: 'yue2-local',
          message: 'YuE2 on the PC is not configured.',
        };
      const ready = fs.existsSync(settings.python);
      return {
        online: ready,
        ready,
        backend: 'yue2-local',
        message: ready ? '' : 'I cannot find the YuE2 Python on the PC.',
      };
    },
    /** A call that waits for its result (the melody-and-chords plan). */
    async call(input, waitMs = 1800000) {
      const remote = start(input);
      const deadline = Date.now() + waitMs;
      for (;;) {
        const state = inspect(remote.id);
        if (state.status === 'COMPLETED') return state.output;
        if (['FAILED', 'CANCELLED', 'LOST'].includes(state.status))
          throw new Error(state.error || 'YuE2 on the PC did not complete the plan.');
        if (Date.now() > deadline) throw new Error('YuE2 on the PC did not respond in time.');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    },
    async submitAction(input) {
      return start(input);
    },
    async status(job) {
      if (!job.remote?.id) return { status: 'UNKNOWN' };
      return inspect(job.remote.id);
    },
    async cancel(job) {
      const dir = folder(job.remote?.id);
      fs.writeFileSync(path.join(dir, 'cancelled'), '1');
      const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8') || 0);
      if (pid && alive(pid)) {
        if (process.platform === 'win32')
          spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
            'error',
            () => {}
          );
        else process.kill(pid, 'SIGTERM');
      }
      return { status: 'CANCELLED' };
    },
    /** Copy the finished song into the library after checking it against the worker's receipt. */
    async collect(job, result, libraryDir, onProgress) {
      if (!Array.isArray(result.audio) || result.audio.length !== 2)
        throw new Error('YuE2 did not return both audio formats.');
      const source = path.join(base, 'yue2', 'audio', String(job.id).toLowerCase());
      const assets = {};
      const total = result.audio.reduce((sum, a) => sum + (Number.isInteger(a.bytes) ? a.bytes : 0), 0);
      let copied = 0;
      for (const asset of result.audio) {
        if (
          !['mp3', 'flac'].includes(asset.format) ||
          !Number.isInteger(asset.bytes) ||
          asset.bytes < 32 ||
          !/^[a-f0-9]{64}$/.test(asset.sha256)
        )
          throw new Error('Invalid audio metadata.');
        const name = `${job.id}.${asset.format}`;
        const target = path.join(libraryDir, 'audio', name);
        const from = path.join(source, `track.${asset.format}`);
        if (!fs.existsSync(target)) {
          if (!fs.existsSync(from)) throw new Error('The YuE2 audio file on the PC is gone.');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(from, target + '.part');
          fs.renameSync(target + '.part', target);
        }
        const digest = createHash('sha256');
        for await (const bytes of fs.createReadStream(target)) digest.update(bytes);
        if (fs.statSync(target).size !== asset.bytes || digest.digest('hex') !== asset.sha256) {
          fs.rmSync(target, { force: true });
          throw new Error('The copied audio does not match the YuE2 result.');
        }
        copied += asset.bytes;
        onProgress?.(copied, total);
        assets[asset.format] = name;
      }
      fs.rmSync(source, { recursive: true, force: true });
      return assets;
    },
  };
}
