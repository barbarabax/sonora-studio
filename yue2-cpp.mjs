// @codedna
// description: Runs YuE2 on this computer through yue2.cpp's yue-server (GGUF, quantised, LoRA), behind the same calls as the other YuE2 backends.
//
// exports: parseMultipart | createCppYue2
// used_by: server.mjs
// related: yue2-local.mjs — the Python twin it replaces when configured; runpod-backend.mjs — the RunPod twin (call, submitAction, status, cancel, collect)
// rules:   The engine listens on 127.0.0.1 only and is started detached so a song survives a restart of the app; every file path is built from a job UUID under dataDir/yue2-cpp.
//          The engine keeps finished jobs in memory (last 32): the result is saved to disk at the first poll that sees it done, and a job the engine no longer knows is LOST, never resubmitted.
//          The engine's seeds are 64-bit, Sonora sends both lm_seed and seed so a song can be replayed. A song is copied into the library only after size and SHA-256 match.
// agent:   claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_cpp | Created: yue2.cpp (from YuE2-Studio's portable build) as the PC engine, Q8_0 backbone on the RTX 2060.
// Codex | openai | 2026-10-15 | Pass selected source codes to the continuation request.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split a multipart/mixed body into { headers, body } parts. */
export function parseMultipart(contentType, body) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) throw new Error('Engine response without boundary.');
  const marker = Buffer.from('--' + m[1]);
  const parts = [];
  let at = body.indexOf(marker);
  while (at !== -1) {
    let start = at + marker.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    if (body.slice(start, start + 2).toString() === '\r\n') start += 2;
    const next = body.indexOf(marker, start);
    if (next === -1) break;
    let chunk = body.slice(start, next);
    if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2);
    const split = chunk.indexOf('\r\n\r\n');
    const head = split === -1 ? '' : chunk.slice(0, split).toString('utf8');
    const headers = {};
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    parts.push({ headers, body: split === -1 ? chunk : chunk.slice(split + 4) });
    at = next;
  }
  return parts;
}

/**
 * @param settings { engine, model, vae, transcriber?, adapters?, port?, device?, maxSeq?, mp3Bitrate? } as in config.yue2.cpp
 * @param options  { dataDir, fetchImpl?, spawnImpl?, encode? } — encode(args) runs ffmpeg (tests replace it)
 */
export function createCppYue2(
  settings = {},
  { dataDir, fetchImpl = fetch, spawnImpl = spawn, encode, findEnginePid } = {}
) {
  // Rules: `remote: true` means yue-server runs on another computer and reaches this one through an SSH tunnel on `port`;
  // then no engine or model file is needed here and nothing is ever started or restarted by this app.
  const remote = settings.remote === true;
  const configured =
    remote ||
    ['engine', 'model', 'vae'].every(k => typeof settings[k] === 'string' && settings[k].trim() !== '');
  const port = Number.isInteger(settings.port) ? settings.port : 18087;
  const url = route => `http://127.0.0.1:${port}${route}`;
  const base = path.join(dataDir || '.', 'yue2-cpp');
  const folder = id => {
    if (!UUID.test(String(id))) throw new Error('Invalid job identifier.');
    return path.join(base, String(id).toLowerCase());
  };
  const ffmpeg =
    encode ||
    (args =>
      new Promise((resolve, reject) => {
        const child = spawnImpl('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr?.on('data', d => (err += d));
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.slice(-300)))));
      }));
  const unreachable = () =>
    `The YuE2 engine on your other computer is not reachable on port ${port}. Start yue-server there and open the SSH tunnel.`;
  const missing = () =>
    remote
      ? []
      : ['engine', 'model', 'vae', 'transcriber'].filter(k => settings[k] && !fs.existsSync(settings[k]));

  async function alive() {
    try {
      const r = await fetchImpl(url('/health'), { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }
  let starting = null;
  let stale = false; // the LoRA folder changed since the engine started
  const active = new Set(); // engine job ids this app is still waiting for
  const pidFile = () => path.join(base, 'engine.pid');
  function stopEngine() {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(pidFile(), 'utf8')) || 0;
    } catch {
      /* never started by this app */
    }
    if (!pid) return;
    try {
      if (process.platform === 'win32')
        spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on?.(
          'error',
          () => {}
        );
      else process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    fs.rmSync(pidFile(), { force: true });
  }
  /** pid of the yue-server that listens on our port when it was started outside this app; 0 when none or not the configured program. */
  const enginePid =
    findEnginePid ||
    (() =>
      new Promise(resolve => {
        if (process.platform !== 'win32') return resolve(0);
        const script = `$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { "$($p.Id)|$($p.Path)" } }`;
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true, timeout: 15000 },
          (error, stdout) => {
            const [pid, exe] = String(stdout || '')
              .trim()
              .split('|');
            const same =
              exe &&
              settings.engine &&
              path.resolve(exe).toLowerCase() === path.resolve(settings.engine).toLowerCase();
            resolve(!error && same && Number(pid) > 0 ? Number(pid) : 0);
          }
        );
      }));
  const killPid = pid => {
    try {
      if (process.platform === 'win32')
        spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on?.(
          'error',
          () => {}
        );
      else process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  /**
   * Start yue-server if it is not answering yet; it keeps running (detached) between songs and frees the GPU after each one.
   * Rules: after a LoRA was added or removed the engine is restarted, but only when none of our jobs is still running on it.
   */
  async function ensureEngine({ needsFresh = false } = {}) {
    if (!configured) throw new Error('YuE2 on the PC (yue2.cpp) is not configured.');
    if (remote) {
      if (await alive()) return;
      throw new Error(unreachable());
    }
    if (stale && (await alive())) {
      if (active.size) {
        if (needsFresh)
          throw new Error(
            'The engine is still creating a song: wait for it to finish to use the LoRA you just installed.'
          );
      } else {
        stopEngine();
        for (let i = 0; i < 20 && (await alive()); i++)
          await new Promise(resolve => setTimeout(resolve, 500));
        if (await alive())
          throw new Error(
            'I cannot restart the yue2.cpp engine to read the new LoRAs: close yue-server.exe and try again.'
          );
        stale = false;
      }
    }
    if (await alive()) return;
    stale = false;
    if (!starting) {
      starting = (async () => {
        const absent = missing();
        if (absent.length)
          throw new Error('The yue2.cpp files are missing: ' + absent.map(k => settings[k]).join(', '));
        fs.mkdirSync(base, { recursive: true });
        const args = [
          '--model',
          settings.model,
          '--vae',
          settings.vae,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
        ];
        if (settings.transcriber) args.push('--transcriber', settings.transcriber);
        if (settings.adapters) args.push('--adapters', settings.adapters);
        if (settings.device) args.push('--device', settings.device);
        if (Number.isInteger(settings.maxSeq)) args.push('--max-seq', String(settings.maxSeq));
        const log = fs.openSync(path.join(base, 'engine.log'), 'a');
        const child = spawnImpl(settings.engine, args, {
          cwd: path.dirname(settings.engine),
          detached: true,
          windowsHide: true,
          stdio: ['ignore', log, log],
        });
        fs.closeSync(log);
        child.on?.('error', () => {});
        child.unref?.();
        if (child.pid) fs.writeFileSync(pidFile(), String(child.pid));
        for (let i = 0; i < 120; i++) {
          if (await alive()) return;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('The yue2.cpp engine did not start: look at ' + path.join(base, 'engine.log'));
      })().finally(() => (starting = null));
    }
    await starting;
  }
  async function engineJson(route, init) {
    const r = await fetchImpl(url(route), init);
    const text = await r.text();
    let value = {};
    try {
      value = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new Error('yue2.cpp: ' + (value.error || text.slice(0, 200) || r.status));
    return value;
  }
  /** The engine request for a Sonora action (generate or plan). */
  function synthRequest(input, planOnly) {
    const seed = Number.isInteger(input.seed) && input.seed >= 0 ? input.seed : -1;
    // Rules: a replay renders the saved semantic codes again (same composition and singing) with another sound seed and steps; no planning.
    if (input.semanticTokens && !planOnly)
      return {
        style: input.style,
        lyrics: input.lyrics,
        cot: input.cot || 'full',
        ...(input.abc ? { abc: input.abc } : {}),
        semantic_tokens: input.semanticTokens,
        seed,
        steps: Number.isInteger(input.steps) ? input.steps : 32,
        output_format: 'wav24',
        ...(Array.isArray(input.adapters) && input.adapters.length
          ? {
              adapters: input.adapters.map(a => ({
                name: String(a.name),
                ar_scale: Number(a.ar) || 0,
                nar_scale: Number(a.nar) || 0,
              })),
            }
          : {}),
      };
    const body = {
      style: input.style,
      lyrics: input.lyrics,
      cot: input.cot || 'full',
      lm_seed: seed,
      seed,
      output_format: planOnly ? 'wav16' : 'wav24',
      ...(planOnly
        ? { duration: 1, steps: 1 }
        : { duration: Number(input.duration) > 0 ? Math.min(900, Number(input.duration)) : 360 }),
    };
    if (input.abc && !planOnly) body.abc = input.abc;
    // Sampling controls creativity, not a guaranteed distance between melodies.
    if (input.melodyFreedom) {
      const settings = { low: [0.5, 0.7], medium: [0.7, 1.0], high: [0.9, 1.15] }[input.melodyFreedom];
      if (!settings) throw new Error('Invalid melodic freedom.');
      body.abc_sampling = { temperature: settings[0] };
      body.semantic_sampling = { temperature: settings[1] };
    }

    if (input.sourceTokens && !planOnly) {
      body.source_tokens = input.sourceTokens;
      body.source_start = input.sourceStart;
      body.source_end = input.sourceEnd;
    }
    // Rules: chord variety and section order only steer a plan the engine writes itself, never a given score.
    if (input.harmony && !body.abc) body.harmony = input.harmony;
    if (Number.isFinite(input.cfgScale)) body.cfg_scale = input.cfgScale;
    // Rules: a LoRA is named by its catalogue id (its folder) with its own strength on the composition (ar) and on the sound (nar).
    if (Array.isArray(input.adapters) && input.adapters.length)
      body.adapters = input.adapters.map(a => ({
        name: String(a.name),
        ar_scale: Number(a.ar) || 0,
        nar_scale: Number(a.nar) || 0,
      }));
    return body;
  }
  async function result(engineId) {
    const r = await fetchImpl(url(`/job?id=${encodeURIComponent(engineId)}&result=1`));
    if (!r.ok) throw new Error('yue2.cpp did not return the result.');
    return { type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) };
  }
  async function waitDone(engineId, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const s = await engineJson(`/job?id=${encodeURIComponent(engineId)}`);
      if (s.status === 'done') return;
      if (s.status === 'failed' || s.status === 'cancelled')
        throw new Error('yue2.cpp: ' + (s.error || 'job not completed.'));
      if (Date.now() > deadline) throw new Error('yue2.cpp did not respond in time.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  async function describe(file) {
    const digest = createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
    return {
      format: path.extname(file).slice(1),
      bytes: fs.statSync(file).size,
      sha256: digest.digest('hex'),
    };
  }
  /** Turn the engine's multipart answer into Sonora's result.json (flac + mp3 next to it). */
  async function save(id, answer, started) {
    const dir = folder(id);
    const parts = parseMultipart(answer.type, answer.body);
    const replayPart = parts.find(p => (p.headers['content-type'] || '').startsWith('application/json'));
    const audioPart = parts.find(p => (p.headers['content-type'] || '').startsWith('audio/'));
    if (!replayPart || !audioPart) throw new Error('yue2.cpp did not return audio and plan.');
    const replay = JSON.parse(replayPart.body.toString('utf8'));
    const wav = path.join(dir, 'track.wav');
    fs.writeFileSync(wav, audioPart.body);
    const flac = path.join(dir, 'track.flac');
    const mp3 = path.join(dir, 'track.mp3');
    await ffmpeg(['-y', '-v', 'error', '-i', wav, flac]);
    await ffmpeg(['-y', '-v', 'error', '-i', wav, '-b:a', `${settings.mp3Bitrate || 192}k`, mp3]);
    fs.rmSync(wav, { force: true });
    // the semantic codes make an exact replay possible: kept beside the song, never sent back to the page
    fs.writeFileSync(path.join(dir, 'replay.json'), JSON.stringify(replay));
    const frames = String(replay.semantic_tokens || '')
      .split(',')
      .filter(Boolean).length;
    const output = {
      localId: id,
      audio: [await describe(flac), await describe(mp3)],
      abc: typeof replay.abc === 'string' ? replay.abc : '',
      cot: replay.cot,
      seed: replay.lm_seed,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      ...(frames ? { duration: Math.round((frames / 25) * 100) / 100 } : {}),
      engine: 'yue2.cpp',
      // what an exact replay needs; the server moves it out of the library into data/yue2-replay
      replay: {
        semanticTokens: replay.semantic_tokens || '',
        abc: replay.abc || '',
        cot: replay.cot,
        lmSeed: replay.lm_seed,
        seed: replay.seed,
        steps: replay.steps,
      },
    };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(output));
    return output;
  }

  return {
    configured,
    remote,
    /**
     * Stop the engine and start it again so it reads the LoRA folder now (also when it was started by hand).
     * Rules: never while one of our songs is running on it; only the yue-server program that is configured is stopped.
     */
    async restart() {
      if (remote) throw new Error('The engine runs on another computer: restart it there.');
      if (!configured) throw new Error('YuE2 on the PC (yue2.cpp) is not configured.');
      if (active.size) throw new Error('The engine is still creating a song: wait for it to finish.');
      const down = async () => {
        for (let i = 0; i < 20 && (await alive()); i++)
          await new Promise(resolve => setTimeout(resolve, 500));
        return !(await alive());
      };
      if (await alive()) {
        stopEngine();
        if (!(await down())) {
          const pid = await enginePid();
          if (pid) killPid(pid);
          if (!(await down()))
            throw new Error('I cannot stop the yue2.cpp engine: close yue-server.exe and try again.');
        }
      }
      stale = false;
      await ensureEngine();
      return { adapters: (await this.engineAdapters()) ?? [] };
    },
    /** The LoRA folder changed: restart the engine before the next request (when it is idle). */
    adaptersChanged() {
      if (!remote) stale = true;
    },
    /** LoRA names the running engine knows (from /props), or null when it is not running. */
    async engineAdapters() {
      if (!(await alive())) return null;
      try {
        return (await engineJson('/props')).adapters?.map(a => a.name) ?? [];
      } catch {
        return null;
      }
    },
    async health() {
      if (!configured)
        return {
          online: false,
          ready: false,
          backend: 'yue2-cpp',
          message: 'YuE2 on the PC (yue2.cpp) is not configured.',
        };
      if (remote) {
        const up = await alive();
        return { online: up, ready: up, backend: 'yue2-cpp', message: up ? '' : unreachable() };
      }
      const absent = missing();
      if (absent.length)
        return {
          online: false,
          ready: false,
          backend: 'yue2-cpp',
          message: 'The yue2.cpp files are missing on the PC.',
        };
      return { online: true, ready: true, backend: 'yue2-cpp', message: '' };
    },
    /** A call that waits for its result: the plan (score only) or the melody of a cover. */
    async call(input, waitMs = 1800000) {
      await ensureEngine();
      const started = Date.now();
      if (input.action === 'transcribe') {
        const form = new FormData();
        const format = input.format === 'wav' ? 'wav' : 'mp3';
        form.append(
          'audio',
          new Blob([Buffer.from(input.audio, 'base64')], {
            type: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
          }),
          'song.' + format
        );
        if (!input.chords) form.append('melody_only', '1');
        const { id } = await engineJson('/transcribe', { method: 'POST', body: form });
        await waitDone(id, waitMs);
        const answer = await result(id);
        const value = JSON.parse(answer.body.toString('utf8'));
        if (typeof value.abc !== 'string' || !value.abc.trim())
          throw new Error('yue2.cpp did not transcribe the song.');
        return {
          abc: value.abc,
          chords: !!input.chords,
          seconds: Math.round((Date.now() - started) / 100) / 10,
        };
      }
      if (input.action !== 'plan') throw new Error('Action not supported by yue2.cpp.');
      if (Array.isArray(input.adapters) && input.adapters.length) await ensureEngine({ needsFresh: true });
      const { id } = await engineJson('/synth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(synthRequest(input, true)),
      });
      await waitDone(id, waitMs);
      const answer = await result(id);
      const replay = parseMultipart(answer.type, answer.body).find(p =>
        (p.headers['content-type'] || '').startsWith('application/json')
      );
      const plan = replay ? JSON.parse(replay.body.toString('utf8')) : {};
      if (typeof plan.abc !== 'string' || !plan.abc.trim())
        throw new Error('yue2.cpp did not write the plan.');
      return { abc: plan.abc, seed: plan.lm_seed, seconds: Math.round((Date.now() - started) / 100) / 10 };
    },
    async submitAction(input) {
      if (input.action !== 'generate') throw new Error('Action not supported by yue2.cpp.');
      await ensureEngine({ needsFresh: Array.isArray(input.adapters) && input.adapters.length > 0 });
      const dir = folder(input.localId);
      fs.mkdirSync(dir, { recursive: true });
      for (const stale of ['result.json', 'error.json']) fs.rmSync(path.join(dir, stale), { force: true });
      const { id } = await engineJson('/synth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(synthRequest(input, false)),
      });
      fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ engineId: id, started: Date.now() }));
      active.add(id);
      return { host: 'local', engine: 'cpp', id: String(input.localId).toLowerCase() };
    },
    async status(job) {
      const id = job.remote?.id;
      if (!id) return { status: 'UNKNOWN' };
      const dir = folder(id);
      const done = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
        } catch {
          return null;
        }
      })();
      if (done) return { status: 'COMPLETED', output: done };
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8'));
      } catch {
        return { status: 'LOST' };
      }
      if (!(await alive())) {
        active.delete(meta.engineId);
        return { status: 'LOST', error: 'The yue2.cpp engine stopped during the song.' };
      }
      let s;
      try {
        s = await engineJson(`/job?id=${encodeURIComponent(meta.engineId)}`);
      } catch {
        return { status: 'LOST', error: 'The yue2.cpp engine no longer knows this song.' };
      }
      if (s.status !== 'done' && s.status !== 'running' && s.status !== 'queued')
        active.delete(meta.engineId);
      if (s.status === 'cancelled') return { status: 'CANCELLED' };
      if (s.status === 'failed')
        return { status: 'FAILED', error: 'yue2.cpp: ' + (s.error || 'song failed.') };
      if (s.status !== 'done') return { status: 'IN_PROGRESS', progress: s.stage || '' };
      active.delete(meta.engineId);
      try {
        return { status: 'COMPLETED', output: await save(id, await result(meta.engineId), meta.started) };
      } catch (error) {
        return { status: 'FAILED', error: error.message };
      }
    },
    async cancel(job) {
      const meta = JSON.parse(fs.readFileSync(path.join(folder(job.remote?.id), 'engine.json'), 'utf8'));
      await fetchImpl(url(`/job?id=${encodeURIComponent(meta.engineId)}&cancel=1`), { method: 'POST' }).catch(
        () => {}
      );
      return { status: 'CANCELLED' };
    },
    /** Copy the finished song into the library after checking it against the saved receipt. */
    async collect(job, output, libraryDir, onProgress) {
      if (!Array.isArray(output.audio) || output.audio.length !== 2)
        throw new Error('yue2.cpp did not produce both audio formats.');
      const dir = folder(job.remote?.id || job.id);
      const assets = {};
      const total = output.audio.reduce((sum, a) => sum + a.bytes, 0);
      let copied = 0;
      for (const asset of output.audio) {
        if (!['mp3', 'flac'].includes(asset.format) || !/^[a-f0-9]{64}$/.test(asset.sha256))
          throw new Error('Invalid audio metadata.');
        const name = `${job.id}.${asset.format}`;
        const target = path.join(libraryDir, 'audio', name);
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(dir, `track.${asset.format}`), target + '.part');
          fs.renameSync(target + '.part', target);
        }
        const check = await describe(target);
        if (check.bytes !== asset.bytes || check.sha256 !== asset.sha256) {
          fs.rmSync(target, { force: true });
          throw new Error('The copied audio does not match the yue2.cpp result.');
        }
        copied += asset.bytes;
        onProgress?.(copied, total);
        assets[asset.format] = name;
      }
      for (const name of ['track.flac', 'track.mp3']) fs.rmSync(path.join(dir, name), { force: true });
      return assets;
    },
  };
}
