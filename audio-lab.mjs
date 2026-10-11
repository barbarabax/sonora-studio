// @codedna
// description: Durable Audio Lab sessions: analysis, full-length mastering renders, saved masters, references and AI advice.
//
//
// 
//
// 
//
// 
//
// exports: EQ_BANDS | MASTER_DEFAULTS | migrateSettings | validateMastering | createCpuLock | createAudioLab
// used_by: sonora-studio/server.mjs
// rules:   Resolve sources server-side, never modify them, publish renders only after the worker completes.
// agent:   Claude - 2026-10-04 - Audio Lab integration from Barichord Audio Lab.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { excerpt, excerptWindow } from './ai-audio.mjs';
import { audioPython } from './runtime-paths.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const UPLOAD_LIMIT = 150 * 1024 * 1024;
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const MASTER_DEFAULTS = {
  eq: EQ_BANDS.map(() => 0),
  compressor: 'off',
  reverb: 'off',
  width: 1,
  targetLufs: -14,
  ceiling: -1,
  metadata: 'keep',
};
const EQ = [-12, 12, 0.5];
const RANGES = { width: [0.5, 1.5, 0.05], targetLufs: [-20, -8, 0.5], ceiling: [-3, -0.1, 0.1] };
const MODES = {
  compressor: ['off', 'gentle', 'tight', 'punch'],
  reverb: ['off', 'small', 'studio', 'large'],
  metadata: ['keep', 'strip'],
};
const snap = (value, [min, max, step], clamp, key) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${key} value.`);
  if (clamp) value = Math.min(max, Math.max(min, value));
  else if (value < min || value > max) throw new Error(`${key} is outside the allowed range (${min}…${max}).`);
  return Number((Math.round(value / step) * step).toFixed(2));
};
// Settings saved before the 10-band EQ (3 bands split at 200 Hz / 4 kHz) map onto the nearest bands.
export function migrateSettings(value) {
  if (!value || Array.isArray(value.eq) || !('eqLow' in value)) return value;
  const { eqLow = 0, eqMid = 0, eqHigh = 0, ...rest } = value;
  return {
    ...MASTER_DEFAULTS,
    ...rest,
    eq: EQ_BANDS.map(f => (f < 200 ? eqLow : f < 4000 ? eqMid : eqHigh)),
  };
}

// clamp=true is for AI proposals: out-of-range numbers are brought into range instead of rejected.
export function validateMastering(body = {}, { clamp = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid mastering settings.');
  const out = {},
    eq = body.eq ?? MASTER_DEFAULTS.eq;
  if (!Array.isArray(eq) || eq.length !== EQ_BANDS.length)
    throw new Error('The equalizer requires 10 bands.');
  out.eq = eq.map((v, i) => snap(v, EQ, clamp, 'EQ ' + EQ_BANDS[i] + ' Hz'));
  for (const [key, range] of Object.entries(RANGES))
    out[key] = snap(body[key] ?? MASTER_DEFAULTS[key], range, clamp, key);
  for (const [key, list] of Object.entries(MODES)) {
    const value = body[key] ?? MASTER_DEFAULTS[key];
    if (!list.includes(value)) throw new Error(`Invalid ${key} value.`);
    out[key] = value;
  }
  return out;
}

// One CPU-heavy local task at a time across the stem editor and Audio Lab.
export function createCpuLock() {
  let tail = Promise.resolve(),
    pending = 0;
  return (task, onWait) => {
    if (pending) onWait?.();
    pending++;
    const run = tail.then(task).finally(() => {
      pending--;
    });
    tail = run.catch(() => {});
    return run;
  };
}

const hashFile = file =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });

export function createAudioLab({
  root,
  dataDir,
  getJob,
  getMix,
  promptAi,
  cpu = createCpuLock(),
  onChange = () => {},
  runTask,
  excerptImpl = excerpt,
  addToLibrary = null,
}) {
  const folder = path.join(dataDir, 'audio-lab'),
    dbFile = path.join(folder, 'sessions.json');
  fs.mkdirSync(folder, { recursive: true });
  const db = fs.existsSync(dbFile)
    ? JSON.parse(fs.readFileSync(dbFile, 'utf8'))
    : { version: 1, sessions: [] };
  if (db.version !== 1 || !Array.isArray(db.sessions)) throw new Error('Invalid Audio Lab archive.');
  const python = audioPython(root);
  let running = false,
    closed = false,
    child = null,
    current = null;
  const queue = [],
    advising = new Set();
  const save = () => {
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(dbFile + '.tmp', dbFile);
    onChange();
  };
  for (const s of db.sessions) {
    if (['queued', 'processing'].includes(s.status))
      Object.assign(s, {
        status: 'failed',
        phase: 'Interrupted',
        task: null,
        error: 'Processing was interrupted by a restart. You can try again.',
      });
    s.settings = migrateSettings(s.settings);
    if (s.advice) s.advice.settings = migrateSettings(s.advice.settings);
    for (const r of s.renders || []) r.settings = migrateSettings(r.settings);
  }
  const getSession = id => {
    if (!uuid(id)) throw new Error('Invalid session.');
    const s = db.sessions.find(s => s.id === id);
    if (!s) throw new Error('Audio Lab session was not found.');
    return s;
  };
  const sessionDir = id => path.join(folder, id);
  const busy = s => ['queued', 'processing'].includes(s.status);
  function change(s, fields) {
    Object.assign(s, fields, { updatedAt: new Date().toISOString() });
    save();
  }
  function sourceFile(s) {
    const { kind, jobId, mixId } = s.source;
    if (kind === 'import') {
      const file = path.join(sessionDir(s.id), 'source.flac');
      if (!fs.existsSync(file)) throw new Error('Imported audio is unavailable.');
      return file;
    }
    const job = getJob(jobId);
    if (job?.status !== 'done' || job.assets?.flac !== `${jobId}.flac`)
      throw new Error('The source track is no longer available.');
    const file = kind === 'mix' ? getMix(jobId, mixId) : path.join(dataDir, 'audio', jobId + '.flac');
    if (!fs.existsSync(file)) throw new Error('Source audio was not found.');
    return file;
  }
  function worker(task, progress) {
    return new Promise((resolve, reject) => {
      const file = path.join(folder, 'task-' + randomUUID() + '.json');
      fs.writeFileSync(file, JSON.stringify(task));
      const taskChild = spawn(python, [path.join(root, 'audio_lab_worker.py'), file], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '4' },
      });
      child = taskChild;
      let buffer = '',
        last = null,
        errorText = '';
      const timeout = setTimeout(() => taskChild.kill(), 30 * 60 * 1000);
      timeout.unref();
      taskChild.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines)
          try {
            const value = JSON.parse(line);
            last = value;
            if (value.phase) progress(value.phase);
          } catch {}
      });
      taskChild.stderr.on('data', chunk => {
        errorText = (errorText + chunk.toString()).slice(-1800);
      });
      const cleanup = () => {
        clearTimeout(timeout);
        fs.rmSync(file, { force: true });
        if (child === taskChild) child = null;
      };
      taskChild.once('error', err => {
        cleanup();
        reject(
          new Error(
            err.code === 'ENOENT' ? 'The local Python environment is not installed. See the README.' : err.message
          )
        );
      });
      taskChild.once('close', code => {
        cleanup();
        if (code === 0 && last?.done) resolve(last);
        else
          reject(
            new Error(last?.error || errorText.trim().split('\n').pop() || 'Audio processing was interrupted.')
          );
      });
    });
  }
  function enqueue(s, task, { done, fail = () => {}, phase = 'Queued' }) {
    if (closed) throw new Error('Audio Lab is stopped.');
    if (busy(s)) throw new Error('Wait for this track’s current processing to finish.');
    if (queue.length >= 8) throw new Error('Too many tasks are queued. Wait a moment.');
    if (!runTask && !fs.existsSync(python))
      throw new Error('The local Python environment is not installed. See the README.');
    change(s, { status: 'queued', phase, error: null, task: task.action });
    queue.push({ s, task, done, fail, cancelled: false });
    void drain();
    return s;
  }
  async function drain() {
    if (running || closed) return;
    running = true;
    while (queue.length && !closed) {
      const item = queue.shift(),
        { s, task } = item;
      current = item;
      try {
        const result = await cpu(
          async () => {
            if (item.cancelled || closed) throw new Error('Cancelled.');
            change(s, { status: 'processing', phase: 'Preparing' });
            return (runTask || worker)(task, phase => change(s, { phase }));
          },
          () => change(s, { phase: 'Waiting: the audio editor is processing' })
        );
        if (closed) break;
        if (item.cancelled) throw new Error('Cancelled.');
        await item.done(result);
        change(s, { status: 'ready', phase: 'Ready', error: null, task: null });
      } catch (e) {
        try {
          item.fail();
        } catch {}
        if (!closed)
          change(
            s,
            item.cancelled
              ? { status: 'ready', phase: 'Cancelled', error: null, task: null }
              : { status: 'failed', phase: 'Error', error: e.message, task: null }
          );
      } finally {
        current = null;
      }
    }
    running = false;
  }
  async function receive(req, file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let bytes = 0;
    const fd = fs.openSync(file, 'w');
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > UPLOAD_LIMIT) throw new Error('File exceeds 150 MB.');
        fs.writeSync(fd, chunk);
      }
      if (bytes < 32) throw new Error('Audio file is empty.');
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw e;
    }
    fs.closeSync(fd);
  }
  const nameOf = req => {
    let name = 'Audio importato';
    try {
      name = decodeURIComponent(req.headers['x-audio-name'] || name);
    } catch {}
    return (
      name
        .replace(/[\u0000-\u001f]/g, '')
        .trim()
        .slice(0, 100) || 'Audio importato'
    );
  };
  function analyzeTask(s) {
    const file = sourceFile(s);
    return enqueue(
      s,
      { action: 'analyze', source: file },
      {
        done: async result => {
          s.analysis = result.analysis;
          s.sourceSha256 = await hashFile(file);
          s.analyzedAt = new Date().toISOString();
        },
      }
    );
  }
  function create(body) {
    const kind = body?.kind;
    if (!['job', 'mix'].includes(kind) || !uuid(body.jobId) || (kind === 'mix' && !uuid(body.mixId)))
      throw new Error('Select a track or mix to analyze.');
    const existing = db.sessions.find(
      s =>
        s.source.kind === kind &&
        s.source.jobId === body.jobId &&
        (kind === 'job' || s.source.mixId === body.mixId)
    );
    if (existing) {
      if (!existing.analysis && !busy(existing)) analyzeTask(existing);
      return existing;
    }
    const job = getJob(body.jobId);
    const s = {
      id: randomUUID(),
      title: (job?.title || 'Track') + (kind === 'mix' ? ' · mix' : ''),
      source: kind === 'mix' ? { kind, jobId: body.jobId, mixId: body.mixId } : { kind, jobId: body.jobId },
      status: 'idle',
      phase: 'Ready to analyze',
      analysis: null,
      reference: null,
      renders: [],
      advice: null,
      settings: { ...MASTER_DEFAULTS },
      createdAt: new Date().toISOString(),
    };
    sourceFile(s);
    db.sessions.unshift(s);
    save();
    return analyzeTask(s);
  }
  async function importFile(req) {
    if (closed) throw new Error('Audio Lab is stopped.');
    const id = randomUUID(),
      upload = path.join(sessionDir(id), 'upload.audio'),
      label = nameOf(req);
    try {
      await receive(req, upload);
    } catch (e) {
      fs.rmSync(sessionDir(id), { recursive: true, force: true });
      throw e;
    }
    const s = {
      id,
      title: label.replace(/\.[a-z0-9]{2,5}$/i, ''),
      source: { kind: 'import', label },
      status: 'idle',
      phase: 'Importing',
      analysis: null,
      reference: null,
      renders: [],
      advice: null,
      settings: { ...MASTER_DEFAULTS },
      createdAt: new Date().toISOString(),
    };
    db.sessions.unshift(s);
    save();
    const file = path.join(sessionDir(id), 'source.flac');
    return enqueue(
      s,
      { action: 'import', source: upload, outputFile: file },
      {
        phase: 'Queued · import',
        done: async result => {
          fs.rmSync(upload, { force: true });
          s.analysis = result.analysis;
          s.sourceSha256 = await hashFile(file);
          s.analyzedAt = new Date().toISOString();
        },
        fail: () => fs.rmSync(upload, { force: true }),
      }
    );
  }
  async function reference(id, req) {
    const s = getSession(id);
    if (busy(s)) throw new Error('Wait for this track’s current processing to finish.');
    const upload = path.join(sessionDir(id), `reference-${randomUUID()}.audio`),
      label = nameOf(req),
      file = path.join(sessionDir(id), 'reference.flac');
    await receive(req, upload);
    return enqueue(
      s,
      { action: 'import', source: upload, outputFile: file },
      {
        phase: 'Queued · reference',
        done: result => {
          fs.rmSync(upload, { force: true });
          s.reference = { label, analysis: result.analysis, createdAt: new Date().toISOString() };
        },
        fail: () => fs.rmSync(upload, { force: true }),
      }
    );
  }
  function analyze(id) {
    const s = getSession(id);
    return analyzeTask(s);
  }
  async function preview(id, body) {
    const s = getSession(id);
    if (!s.analysis) throw new Error('Analyze the track first.');
    const settings = validateMastering(body),
      file = sourceFile(s);
    if (s.sourceSha256 && (await hashFile(file)) !== s.sourceSha256)
      throw new Error('The source audio changed after analysis. Select Analyze again.');
    const renderId = randomUUID(),
      dir = path.join(sessionDir(id), 'renders', renderId);
    change(s, { settings });
    // Listening happens live in the browser; this is the export: FLAC + MP3 with loudness and true-peak limiting.
    return enqueue(
      s,
      { action: 'render', source: file, outputFile: path.join(dir, 'master.flac'), settings },
      {
        phase: 'Queued · master export',
        done: result => {
          if (!fs.existsSync(path.join(dir, 'master.flac')))
            throw new Error('Master was not found after processing.');
          const now = new Date().toISOString(),
            mp3 = !!result.mp3 && fs.existsSync(path.join(dir, 'master.mp3'));
          const render = {
            id: renderId,
            createdAt: now,
            savedAt: now,
            settings,
            analysis: result.analysis,
            loudness: result.loudness,
            saved: true,
            mp3,
          };
          s.renders.unshift(render);
          // A library copy is a convenience: if it fails, the export itself is still valid.
          if (body.toLibrary === true)
            try {
              publish(s, render);
            } catch (e) {
              render.libraryError = e.message;
            }
        },
        fail: () => fs.rmSync(dir, { recursive: true, force: true }),
      }
    );
  }
  // Copy an exported master into the Sonora library as a new track; the source track is untouched.
  function publish(s, render) {
    if (!addToLibrary) throw new Error('Library is unavailable.');
    const dir = path.join(sessionDir(s.id), 'renders', render.id),
      flac = path.join(dir, 'master.flac'),
      mp3 = path.join(dir, 'master.mp3');
    if (!fs.existsSync(flac) || !fs.existsSync(mp3))
      throw new Error('Master files are missing. Export it again.');
    const job = addToLibrary({ session: s, render, flac, mp3 });
    render.libraryJobId = job.id;
    delete render.libraryError;
    return job;
  }
  function toLibrary(id, renderId) {
    const s = getSession(id),
      render = uuid(renderId) && s.renders.find(r => r.id === renderId);
    if (!render) throw new Error('Master was not found.');
    const job = publish(s, render);
    change(s, {});
    return job;
  }
  function removeRender(id, renderId) {
    const s = getSession(id);
    if (busy(s)) throw new Error('Wait for this track’s current processing to finish.');
    if (!uuid(renderId) || !s.renders.some(r => r.id === renderId)) throw new Error('Master was not found.');
    fs.rmSync(path.join(sessionDir(id), 'renders', renderId), { recursive: true, force: true });
    change(s, { renders: s.renders.filter(r => r.id !== renderId) });
    return s;
  }
  function saveRender(id, renderId) {
    const s = getSession(id),
      render = s.renders.find(r => r.id === renderId);
    if (!uuid(renderId) || !render) throw new Error('Preview was not found.');
    if (render.saved && render.mp3) return s;
    const dir = path.join(sessionDir(id), 'renders', renderId);
    return enqueue(
      s,
      { action: 'mp3', source: path.join(dir, 'master.flac'), outputFile: path.join(dir, 'master.mp3') },
      {
        phase: 'Queued · saving master',
        done: () => {
          if (!fs.existsSync(path.join(dir, 'master.mp3'))) throw new Error('MP3 was not found.');
          Object.assign(render, { saved: true, mp3: true, savedAt: new Date().toISOString() });
        },
      }
    );
  }
  function cancel(id) {
    const s = getSession(id),
      index = queue.findIndex(item => item.s === s);
    if (index >= 0) {
      const [item] = queue.splice(index, 1);
      try {
        item.fail();
      } catch {}
      change(s, { status: 'ready', phase: 'Cancelled', error: null, task: null });
      return s;
    }
    if (current?.s === s) {
      current.cancelled = true;
      change(s, { phase: 'Cancelling…' });
      child?.kill();
    }
    return s;
  }
  function remove(id) {
    const s = getSession(id);
    if (busy(s) || advising.has(id))
      throw new Error('Wait for processing to finish or cancel it before removing the session.');
    db.sessions = db.sessions.filter(x => x !== s);
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
    save();
    return { removed: id };
  }
  async function advice(id, body = {}) {
    const s = getSession(id);
    if (!s.analysis) throw new Error('Analyze the track first.');
    if (advising.has(id)) throw new Error('An AI request is already in progress for this track.');
    const goal = body.goal ?? '';
    if (typeof goal !== 'string' || goal.length > 500)
      throw new Error('Invalid goal (maximum 500 characters).');
    const settings = validateMastering(body.settings ?? s.settings);
    advising.add(id);
    onChange();
    try {
      const latest = s.renders[0];
      // With a provider that can listen (OpenAI audio model), send short excerpts too: 45 s of the source
      // and 30 s of the reference. body.listen === false keeps the request to measurements only.
      let audio = null;
      if (body.listen !== false && promptAi.canListen?.()) {
        const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
        const take = async (file, total, length, label) => {
          const w = excerptWindow(total, length);
          const part = await excerptImpl(file, w);
          return { ...part, label: `${label}, from ${clock(w.start)} to ${clock(w.start + w.seconds)}` };
        };
        audio = [
          await take(
            sourceFile(s),
            s.analysis.technical.duration,
            45,
            'an excerpt of the source track before mastering'
          ),
        ];
        if (s.reference?.analysis)
          audio.push(
            await take(
              path.join(sessionDir(id), 'reference.flac'),
              s.reference.analysis.technical.duration,
              30,
              'an excerpt of the reference track the user likes'
            )
          );
      }
      const result = await promptAi.mastering({
        audio,
        analysis: s.analysis,
        reference: s.reference?.analysis || null,
        current: settings,
        render: latest
          ? { settings: latest.settings, loudness: latest.loudness, analysis: latest.analysis }
          : null,
        goal: goal.trim(),
        ranges: { ...RANGES, eq: EQ },
        bands: EQ_BANDS,
        modes: { compressor: MODES.compressor, reverb: MODES.reverb },
      });
      const value = {
        createdAt: new Date().toISOString(),
        summary: result.summary,
        observations: result.observations,
        settings: validateMastering({ ...settings, ...result.settings }, { clamp: true }),
        listening: result.listening,
        heard: !!audio,
        provider: promptAi.status?.().providerName || null,
      };
      change(s, { advice: value });
      return value;
    } finally {
      advising.delete(id);
      onChange();
    }
  }
  function media(id, kind, mediaId, format = 'flac') {
    const s = getSession(id);
    if (kind === 'source') return sourceFile(s);
    if (kind === 'reference' && s.reference) return path.join(sessionDir(id), 'reference.flac');
    const render = uuid(mediaId) && s.renders.find(r => r.id === mediaId);
    if (kind === 'render' && render && (format === 'flac' || (format === 'mp3' && render.mp3)))
      return path.join(sessionDir(id), 'renders', mediaId, 'master.' + format);
    throw new Error('Audio is unavailable.');
  }
  return {
    snapshot: () => ({
      available: !!runTask || fs.existsSync(python),
      busy: running,
      advising: [...advising],
      sessions: db.sessions,
    }),
    create,
    importFile,
    reference,
    analyze,
    preview,
    saveRender,
    toLibrary,
    removeRender,
    cancel,
    remove,
    advice,
    media,
    close: () => {
      closed = true;
      child?.kill();
      for (const s of db.sessions)
        if (busy(s))
          Object.assign(s, {
            status: 'failed',
            phase: 'Interrupted',
            task: null,
            error: 'Processing was interrupted. You can try again.',
          });
      save();
    },
  };
}
