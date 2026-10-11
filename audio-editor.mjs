// @codedna
// description: Durable local two-stem sessions, isolated CPU worker and lossless mix exports.
// 
//
// 
//
// 
//
// exports: validateMix | createAudioEditor
// used_by: sonora-studio/server.mjs
// rules:   Keep source audio immutable, paths server-owned, and processing serialized.
// agent:   Codex - 2026-10-04 - Stem editor and replacement vocal pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { audioPython } from './runtime-paths.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => (err = (err + d).slice(-1500)));
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolve()
        : reject(new Error('ffmpeg failed: ' + err.trim().split('\n').slice(-2).join(' ')))
    );
  });
}

export function validateMix(body = {}) {
  const values = {
    baseGain: body.baseGain ?? 1,
    voiceGain: body.voiceGain ?? 1,
    offsetMs: body.offsetMs ?? 0,
  };
  for (const [key, value] of Object.entries(values))
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < (key === 'offsetMs' ? -10000 : 0) ||
      value > (key === 'offsetMs' ? 10000 : 2)
    )
      throw new Error('Invalid volume or alignment.');
  if (typeof body.voiceId !== 'string' || (!['original'].includes(body.voiceId) && !uuid(body.voiceId)))
    throw new Error('Invalid vocal track.');
  return { ...values, voiceId: body.voiceId };
}

export function createAudioEditor({
  root,
  dataDir,
  getJob,
  onChange = () => {},
  runTask,
  cpu = task => task(),
}) {
  const folder = path.join(dataDir, 'editor'),
    dbFile = path.join(folder, 'sessions.json');
  fs.mkdirSync(folder, { recursive: true });
  const db = fs.existsSync(dbFile)
    ? JSON.parse(fs.readFileSync(dbFile, 'utf8'))
    : { version: 1, sessions: [] };
  if (db.version !== 1 || !Array.isArray(db.sessions)) throw new Error('Invalid editor archive.');
  let running = false,
    closed = false,
    child = null;
  const queue = [];
  const python = audioPython(root);
  const save = () => {
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(dbFile + '.tmp', dbFile);
    onChange();
  };
  for (const session of db.sessions)
    if (['queued', 'processing'].includes(session.status)) {
      session.status = 'failed';
      session.error = 'Processing was interrupted by a restart. Select Split vocals and backing to try again.';
      session.phase = 'Interrupted';
    }
  const getSession = id => db.sessions.find(s => s.id === id);
  const sessionDir = id => path.join(folder, id);
  function source(id) {
    if (!uuid(id)) throw new Error('Invalid track ID.');
    const s = getSession(id);
    if (s?.source?.kind === 'import') {
      const file = path.join(sessionDir(id), 'original.flac');
      if (!fs.existsSync(file)) throw new Error('Imported audio was not found.');
      return file;
    }
    const job = getJob(id);
    if (job?.status !== 'done' || job.assets?.flac !== `${id}.flac`)
      throw new Error('Select a completed track with FLAC audio.');
    const file = path.join(dataDir, 'audio', id + '.flac');
    if (!fs.existsSync(file)) throw new Error('Original audio was not found.');
    return file;
  }
  function session(id) {
    let s = getSession(id);
    if (!s) {
      source(id);
      s = {
        id,
        status: 'idle',
        phase: 'Ready to separate',
        voices: [],
        mixes: [],
        settings: { baseGain: 1, voiceGain: 1, offsetMs: 0, voiceId: 'original' },
      };
      db.sessions.push(s);
      save();
    }
    return s;
  }
  function change(s, fields) {
    Object.assign(s, fields, { updatedAt: new Date().toISOString() });
    save();
  }
  function worker(task, progress) {
    return new Promise((resolve, reject) => {
      const file = path.join(folder, 'task-' + randomUUID() + '.json');
      fs.writeFileSync(file, JSON.stringify(task));
      const taskChild = spawn(python, [path.join(root, 'audio_worker.py'), file], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '4' },
      });
      child = taskChild;
      let buffer = '',
        last = null,
        errorText = '';
      const timeout = setTimeout(
        () => {
          taskChild.kill();
        },
        30 * 60 * 1000
      );
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
        reject(new Error(err.code === 'ENOENT' ? 'Separator is not installed. See the README.' : err.message));
      });
      taskChild.once('close', code => {
        cleanup();
        if (code === 0 && last?.done) resolve(last);
        else reject(new Error(last?.error || errorText.trim() || 'Audio processing was interrupted.'));
      });
    });
  }
  async function enqueue(s, task, done, phase = 'Queued for audio processing') {
    if (closed) throw new Error('Editor is stopped.');
    if (queue.length >= 8) throw new Error('Wait for the current audio tasks to finish.');
    if (!runTask && !fs.existsSync(python)) throw new Error('Local stem separator is not installed.');
    change(s, { status: 'queued', phase, error: null });
    queue.push({ s, task, done });
    void drain();
    return s;
  }
  async function drain() {
    if (running || closed) return;
    running = true;
    while (queue.length && !closed) {
      const { s, task, done } = queue.shift();
      try {
        change(s, { status: 'processing', phase: 'Preparing audio' });
        const result = await cpu(
          () => (runTask || worker)(task, phase => change(s, { phase })),
          () => change(s, { phase: 'Waiting: Audio Lab is processing' })
        );
        if (closed) break;
        await done(result);
        change(s, { status: 'ready', phase: 'Ready', error: null });
      } catch (e) {
        if (task.action === 'import') fs.rmSync(task.outputDir, { recursive: true, force: true });
        if (!closed) {
          if (task.coverId) attaching.delete(task.coverId);
          change(s, {
            status: 'failed',
            phase: 'Error',
            error: e.message,
            ...(task.coverId ? { pendingCoverId: null, coverError: e.message } : {}),
          });
        }
      }
    }
    running = false;
  }
  function ready(id) {
    const s = session(id);
    if (!s.stems) throw new Error('Separate the vocals and backing first.');
    if (['queued', 'processing'].includes(s.status))
      throw new Error('Wait for the current audio processing to finish.');
    return s;
  }
  function voicePath(s, id) {
    if (id === 'original') return path.join(sessionDir(s.id), 'vocals.flac');
    if (!uuid(id) || !s.voices.some(v => v.id === id)) throw new Error('Vocal track is unavailable.');
    return path.join(sessionDir(s.id), 'voices', id, 'voice.flac');
  }
  async function separate(id) {
    const s = session(id);
    if (s.stems || ['queued', 'processing'].includes(s.status)) return s;
    return enqueue(
      s,
      {
        action: 'separate',
        source: source(id),
        outputDir: sessionDir(id),
        modelDir: path.join(folder, 'models'),
      },
      result => {
        if (
          !['vocals', 'instrumental'].every(name => fs.existsSync(path.join(sessionDir(id), name + '.flac')))
        )
          throw new Error('Track files were not found.');
        Object.assign(s, {
          stems: true,
          duration: result.duration,
          rate: result.rate,
          frames: result.frames,
          stemAttenuation: result.stemAttenuation ?? 1,
        });
      }
    );
  }
  async function importVoice(id, req) {
    const s = ready(id),
      voiceId = randomUUID(),
      out = path.join(sessionDir(id), 'voices', voiceId);
    fs.mkdirSync(out, { recursive: true });
    const input = path.join(out, 'upload.audio');
    let bytes = 0;
    const fd = fs.openSync(input, 'wx');
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 150 * 1024 * 1024) throw new Error('File exceeds 150 MB.');
        fs.writeSync(fd, chunk);
      }
      if (bytes < 32) throw new Error('Audio file is empty.');
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(input, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    let label = 'Voce importata';
    try {
      label = decodeURIComponent(req.headers['x-audio-name'] || label).slice(0, 100);
    } catch {}
    return enqueue(s, { action: 'import', source: input, outputDir: out }, result => {
      s.voices.push({ id: voiceId, label, kind: 'import', duration: result.duration });
      s.settings.voiceId = voiceId;
      fs.rmSync(input, { force: true });
    });
  }
  function settings(id, body) {
    const s = session(id);
    if (!s.stems) throw new Error('Separate the vocals and backing first.');
    const value = validateMix(body);
    voicePath(s, value.voiceId);
    change(s, { settings: value });
    return s;
  }
  async function exportMix(id, body) {
    const s = ready(id),
      value = validateMix(body),
      voice = voicePath(s, value.voiceId),
      mixId = randomUUID(),
      out = path.join(sessionDir(id), 'mixes', mixId);
    change(s, { settings: value });
    return enqueue(
      s,
      {
        action: 'mix',
        base: path.join(sessionDir(id), 'instrumental.flac'),
        voice,
        outputDir: out,
        ...value,
      },
      result => {
        if (!fs.existsSync(path.join(out, 'mix.flac'))) throw new Error('Mix was not found.');
        s.settings = value;
        s.mixes.unshift({
          id: mixId,
          createdAt: new Date().toISOString(),
          settings: value,
          attenuation: result.attenuation,
          duration: result.duration,
        });
      }
    );
  }
  function media(id, kind, mediaId) {
    const s = getSession(id);
    if (!s || !uuid(id)) throw new Error('Session was not found.');
    if (kind === 'original') return source(id);
    if (kind === 'base' && s.stems) return path.join(sessionDir(id), 'instrumental.flac');
    if (kind === 'voice' && s.stems) return voicePath(s, mediaId || 'original');
    if (kind === 'mix' && uuid(mediaId) && s.mixes.some(m => m.id === mediaId))
      return path.join(sessionDir(id), 'mixes', mediaId, 'mix.flac');
    throw new Error('Editor audio is unavailable.');
  }
  async function importSong(req) {
    if (closed) throw new Error('Editor is stopped.');
    const id = randomUUID(),
      out = sessionDir(id);
    fs.mkdirSync(out, { recursive: true });
    const input = path.join(out, 'upload.audio');
    let bytes = 0;
    const fd = fs.openSync(input, 'wx');
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 150 * 1024 * 1024) throw new Error('File exceeds 150 MB.');
        fs.writeSync(fd, chunk);
      }
      if (bytes < 32) throw new Error('Audio file is empty.');
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(out, { recursive: true, force: true });
      throw e;
    }
    fs.closeSync(fd);
    let label = 'External track';
    try {
      label = decodeURIComponent(req.headers['x-audio-name'] || label).slice(0, 100);
    } catch {}
    const title = label.replace(/\.[a-z0-9]{2,5}$/i, '') || 'External track';
    const s = {
      id,
      title,
      source: { kind: 'import', label },
      status: 'idle',
      phase: 'Importing',
      voices: [],
      mixes: [],
      settings: { baseGain: 1, voiceGain: 1, offsetMs: 0, voiceId: 'original' },
      createdAt: new Date().toISOString(),
    };
    db.sessions.unshift(s);
    save();
    return enqueue(
      s,
      { action: 'import', source: input, outputDir: out, outputName: 'original.flac' },
      result => {
        if (fs.existsSync(path.join(out, 'voice.flac')) && !fs.existsSync(path.join(out, 'original.flac'))) {
          fs.renameSync(path.join(out, 'voice.flac'), path.join(out, 'original.flac'));
        }
        s.duration = result.duration;
        s.phase = 'Ready to separate';
        fs.rmSync(input, { force: true });
      },
      'Importing track'
    );
  }
  function remove(id) {
    if (!uuid(id)) throw new Error('Invalid session ID.');
    const s = getSession(id);
    if (!s) throw new Error('Session was not found.');
    if (['queued', 'processing'].includes(s.status))
      throw new Error('Wait for audio processing to finish.');
    db.sessions = db.sessions.filter(item => item.id !== id);
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
    save();
    return { ok: true };
  }
  async function ensureMp3(flacPath) {
    if (!fs.existsSync(flacPath)) throw new Error('Audio file was not found.');
    const mp3Path = flacPath.replace(/\.flac$/i, '') + '.mp3';
    if (!fs.existsSync(mp3Path)) {
      if (runTask) {
        fs.writeFileSync(mp3Path, fs.readFileSync(flacPath));
        return mp3Path;
      }
      await run('ffmpeg', ['-y', '-v', 'error', '-i', flacPath, '-b:a', '192k', mp3Path]);
    }
    return mp3Path;
  }
  function coverReference(id) {
    const s = ready(id);
    if (s.pendingCoverId) throw new Error('A new vocal track is already being processed.');
    return { file: media(id, 'base'), duration: s.duration };
  }
  function trackCover(id, jobId) {
    if (!uuid(jobId)) throw new Error('Invalid cover.');
    const s = ready(id);
    change(s, { pendingCoverId: jobId, coverError: null });
  }
  const attaching = new Set();
  async function reconcile() {
    for (const s of db.sessions) {
      const coverId = s.pendingCoverId;
      if (!coverId || attaching.has(coverId) || closed) continue;
      const job = getJob(coverId);
      if (!job) continue;
      if (['failed', 'cancelled'].includes(job.status)) {
        change(s, { pendingCoverId: null, coverError: job.error || 'Generazione annullata.' });
        continue;
      }
      if (job.status !== 'done' || ['queued', 'processing'].includes(s.status)) continue;
      attaching.add(coverId);
      try {
        const voiceId = randomUUID(),
          out = path.join(sessionDir(s.id), 'voices', voiceId);
        await enqueue(
          s,
          {
            action: 'separate',
            coverId,
            source: source(coverId),
            outputDir: out,
            modelDir: path.join(folder, 'models'),
          },
          result => {
            fs.renameSync(path.join(out, 'vocals.flac'), path.join(out, 'voice.flac'));
            s.voices.push({
              id: voiceId,
              label: 'Voce ACE · ' + job.title,
              kind: 'cover',
              sourceJobId: coverId,
              duration: result.duration,
              quiet: result.vocalsRms !== undefined && result.vocalsRms < 0.005,
            });
            s.settings.voiceId = voiceId;
            s.pendingCoverId = null;
            attaching.delete(coverId);
          },
          'Queued · extracting new vocals'
        );
      } catch (e) {
        attaching.delete(coverId);
        change(s, { pendingCoverId: null, coverError: e.message });
      }
    }
  }
  return {
    snapshot: () => ({
      available: !!runTask || fs.existsSync(python),
      sessions: db.sessions,
      busy: running,
      model: 'UVR-MDX-NET-Voc_FT',
      device: 'CPU',
    }),
    separate,
    importSong,
    remove,
    ensureMp3,
    title: id => getSession(id)?.title,
    importVoice,
    settings,
    exportMix,
    media,
    coverReference,
    trackCover,
    reconcile,
    close: () => {
      closed = true;
      child?.kill();
      for (const s of db.sessions)
        if (['queued', 'processing'].includes(s.status)) {
          s.status = 'failed';
          s.phase = 'Interrupted';
          s.error = 'Processing was interrupted. You can try again.';
        }
      save();
    },
  };
}
