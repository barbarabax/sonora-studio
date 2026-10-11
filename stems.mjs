// @codedna
// description: Six-stem separation sessions, AI-generated extra instrument layers and lossless mixdown with per-track volume, pan, mute and solo.
//
// 
//
// 
//
// 
//
// exports: STEM_NAMES | validateLanes | validateStemMix | validateClips | fxFilters | lanePlan | stemMixFilter | laneRenderGraph | createStems
// used_by: sonora-studio/server.mjs
// rules:   Source audio is read-only; session folders are server-owned; separation is CPU-only, serialized through the shared CPU lock; the mix filter must match public/mixer-ui.mjs (gain, balance pan, solo/mute); layer ids are song-job UUIDs registered in the session, never free paths.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_stems | Mixer a stem: htdemucs_6s via audio-separator (≈1.2x realtime on the VPS CPU), preview MP3 plus FLAC stems.
// claude-sonnet-5-5 | anthropic | 2026-10-09 | s_20261009_layers | Added AI instrument layers: a remix job of the non-vocal stems generates the new instrument on the same timeline; the finished job is registered as a layer.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { audioPython } from './runtime-paths.mjs';
import { audioSeconds } from './audio-remix.mjs';
import { normalizeFx, dspActive, echoTaps, widthMatrix, reverbImpulse } from './public/fx.mjs';
import { createFxProcessor } from './public/dsp-fx.mjs';

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
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

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error('Audio file is unreadable.'))));
  });
}

/**
 * Rules: gain 0-2, pan -1..1, mute/solo booleans; the keys are the six stems plus the registered layer ids, anything else is
 * rejected; missing entries default to unity.
 */
const LANE = /^lane-[a-z0-9]{3,12}$/;
/** Rules: custom timeline tracks are empty lanes named lane-xxxx (at most 12); they carry their own volume/pan and play clips copied from any source. */
export function validateLanes(raw) {
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.length > 12 ||
    raw.some(id => typeof id !== 'string' || !LANE.test(id)) ||
    new Set(raw).size !== raw.length
  )
    throw new Error('Invalid added tracks.');
  return raw;
}

export function validateStemMix(body = {}, layerIds = [], laneIds = []) {
  const keys = [...STEM_NAMES, ...layerIds, ...laneIds];
  const tracks = {};
  for (const name of keys) {
    const t = body.tracks?.[name] ?? {};
    const gain = t.gain ?? 1,
      pan = t.pan ?? 0;
    if (
      typeof gain !== 'number' ||
      !(gain >= 0 && gain <= 2) ||
      typeof pan !== 'number' ||
      !(pan >= -1 && pan <= 1)
    )
      throw new Error(`Invalid settings for ${name}.`);
    tracks[name] = { gain, pan, mute: t.mute === true, solo: t.solo === true, fx: normalizeFx(t.fx) };
  }
  for (const key of Object.keys(body.tracks ?? {}))
    if (!keys.includes(key)) throw new Error('Unknown instrument.');
  return tracks;
}

/**
 * Timeline cuts: { key: [{ at, from, len }] } in seconds (`at` = position on the timeline, `from` = start inside the source,
 * `len` = length). A key without an entry plays whole; an empty list silences it.
 */
export function validateClips(raw, keys, sources = keys) {
  const out = {};
  for (const key of Object.keys(raw ?? {})) {
    if (!keys.includes(key)) throw new Error('Unknown instrument.');
    const list = raw[key];
    if (!Array.isArray(list) || list.length > 64) throw new Error('Too many cuts on one track.');
    out[key] = list.map(c => {
      const at = Number(c?.at),
        from = Number(c?.from),
        len = Number(c?.len);
      if (
        ![at, from, len].every(Number.isFinite) ||
        at < 0 ||
        from < 0 ||
        len < 0.05 ||
        at + len > 900 ||
        from + len > 900
      )
        throw new Error('Invalid cut.');
      // Rules: a cut may play another track's audio (copy/paste), but only a known source.
      const src = c?.src === undefined ? key : c.src;
      if (!sources.includes(src)) throw new Error('Unknown cut source.');
      // Fades in/out in seconds (default none); together they never exceed the clip.
      let fi = Number(c?.fi ?? 0),
        fo = Number(c?.fo ?? 0);
      if (!Number.isFinite(fi) || !Number.isFinite(fo) || fi < 0 || fo < 0 || fi > 60 || fo > 60)
        throw new Error('Invalid fade.');
      if (fi + fo > len) {
        const k = len / (fi + fo);
        fi *= k;
        fo *= k;
      }
      return { at, from, len, src, fi, fo };
    });
  }
  return out;
}

/** Tracks that are audible: with any solo only the soloed ones, otherwise everything not muted. */
function audible(tracks) {
  const keys = Object.keys(tracks),
    solo = keys.filter(n => tracks[n].solo);
  return keys.filter(n => (solo.length ? tracks[n].solo : !tracks[n].mute));
}

/** ffmpeg filters for every effect before the reverb, in the same order as the browser preview (see public/fx.mjs). */
export function fxFilters(raw, part = 'all') {
  const f = normalizeFx(raw),
    out = [];
  if (part !== 'post') {
    if (f.low) out.push(`bass=g=${f.low}:f=120:t=s:w=1`);
    if (f.mid) out.push(`equalizer=f=1000:t=q:w=1:g=${f.mid}`);
    if (f.high) out.push(`treble=g=${f.high}:f=8000:t=s:w=1`);
    if (f.hp > 20) out.push(`highpass=f=${f.hp}:poles=2`);
    if (f.lp < 20000) out.push(`lowpass=f=${f.lp}:poles=2`);
  }
  if (part === 'pre') return out;
  if (f.sat > 0) {
    const k = (1 + f.sat * 9).toFixed(4);
    out.push(`aeval=tanh(${k}*val(0))/tanh(${k})|tanh(${k}*val(1))/tanh(${k})`);
  }
  if (f.width !== 1) {
    const { a, b } = widthMatrix(f);
    out.push(`pan=stereo|c0=${a.toFixed(4)}*c0+${b.toFixed(4)}*c1|c1=${b.toFixed(4)}*c0+${a.toFixed(4)}*c1`);
  }
  if (f.echo > 0) {
    const taps = echoTaps(f);
    out.push(`aecho=1:1:${taps.map(t => t.ms).join('|')}:${taps.map(t => t.gain.toFixed(4)).join('|')}`);
  }
  return out;
}

/**
 * The audible tracks of a mix with the pieces each one plays: [{ key, segments, gain, pan, fx }].
 * A custom lane starts empty; every other track plays whole until it has cuts.
 */
export function lanePlan(tracks, clips = {}) {
  const lanes = audible(tracks).map(key => {
    const list = clips[key] ?? (key.startsWith('lane-') ? [] : [{ at: 0, from: 0, len: null }]);
    return {
      key,
      segments: list.map(c => ({ key, ...c })),
      gain: tracks[key].gain,
      pan: tracks[key].pan,
      fx: tracks[key].fx,
    };
  });
  if (!lanes.some(l => l.segments.length))
    throw new Error('No instruments are active. Enable at least one track.');
  return lanes.filter(l => l.segments.length);
}

/** One piece of a track: trim to its cut, 5 ms (or longer) fades, delay to its place on the timeline. */
function cutFilter(seg) {
  if (seg.len === null) return 'anull';
  const fi = Math.max(0.005, seg.fi ?? 0),
    fo = Math.max(0.005, seg.fo ?? 0);
  return [
    `atrim=start=${seg.from.toFixed(4)}:duration=${seg.len.toFixed(4)}`,
    'asetpts=PTS-STARTPTS',
    `afade=t=in:d=${fi.toFixed(4)}`,
    `afade=t=out:st=${Math.max(0, seg.len - fo).toFixed(4)}:d=${fo.toFixed(4)}`,
    ...(seg.at > 0 ? [`adelay=${Math.round(seg.at * 1000)}:all=1`] : []),
  ].join(',');
}

/** Graph fragments that sum the pieces of one track and apply its effects (no reverb, no gain/pan). Input indexes start at `first`. */
function laneCore(lane, first, tag, part = 'all') {
  const parts = lane.segments.map((seg, n) => `[${first + n}:a]${cutFilter(seg)}[${tag}c${n}]`);
  const labels = lane.segments.map((_, n) => `[${tag}c${n}]`).join('');
  const fx = fxFilters(lane.fx, part);
  const sum =
    lane.segments.length > 1
      ? `${labels}amix=inputs=${lane.segments.length}:normalize=0:duration=longest`
      : `${labels}anull`;
  parts.push(`${sum}${fx.length ? ',' + fx.join(',') : ''}[${tag}m]`);
  return parts;
}

/** Gain and balance-style pan (the louder side keeps full level) of one track. */
function panFilter(lane) {
  const left = (lane.gain * (lane.pan > 0 ? 1 - lane.pan : 1)).toFixed(4),
    right = (lane.gain * (lane.pan < 0 ? 1 + lane.pan : 1)).toFixed(4);
  return `pan=stereo|c0=${left}*c0|c1=${right}*c1`;
}

/**
 * ffmpeg graph for the whole mix. A track listed in `rendered` ({ key: file }) was already processed (reverb) and is a single input.
 * Returns { segments, lanes, names, graph }: `segments` are the inputs in order.
 */
export function stemMixFilter(tracks, clips = {}, rendered = {}) {
  const lanes = lanePlan(tracks, clips),
    chain = [],
    segments = [];
  let index = 0;
  lanes.forEach((lane, n) => {
    if (rendered[lane.key]) {
      segments.push({ key: lane.key, rendered: rendered[lane.key] });
      chain.push(`[${index}:a]${panFilter(lane)}[L${n}]`);
      index += 1;
    } else {
      chain.push(...laneCore(lane, index, `l${n}`));
      chain.push(`[l${n}m]${panFilter(lane)}[L${n}]`);
      segments.push(...lane.segments);
      index += lane.segments.length;
    }
  });
  const labels = lanes.map((_, n) => `[L${n}]`).join('');
  chain.push(`${labels}amix=inputs=${lanes.length}:normalize=0:duration=longest,alimiter=limit=0.97[out]`);
  return { segments, lanes, names: lanes.map(l => l.key), graph: chain.join(';') };
}

/** Graph that renders one track (pieces, sum and the effects of `part`: pre = EQ and filters, all = everything before the reverb) as a stereo float file. */
export function laneRenderGraph(lane, part = 'all') {
  return laneCore(lane, 0, 'r', part).join(';').replace('[rm]', '[out]');
}

/** Graph for the effects that come after the processor (saturation, stereo width, echo) applied to an already rendered file. */
function postGraph(raw) {
  const filters = fxFilters(raw, 'post');
  return filters.length ? `[0:a]${filters.join(',')}[out]` : null;
}

/** Reads a 32-bit float stereo WAV written by ffmpeg (searches the 'data' chunk). */
function readWavFloat(file) {
  const buffer = fs.readFileSync(file);
  let at = 12,
    rate = 44100;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4),
      size = buffer.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = buffer.readUInt32LE(at + 12);
    if (id === 'data') {
      const frames = Math.floor(Math.min(size, buffer.length - at - 8) / 8),
        left = new Float32Array(frames),
        right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = buffer.readFloatLE(at + 8 + i * 8);
        right[i] = buffer.readFloatLE(at + 12 + i * 8);
      }
      return { left, right, rate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('Invalid intermediate audio file.');
}

/** Runs the shared dynamics/modulation processor over a rendered lane, in blocks, exactly like the browser worklet does. */
function applyDsp(inFile, outFile, fx, bpm) {
  const { left, right, rate } = readWavFloat(inFile);
  const processor = createFxProcessor(rate);
  processor.setParams(fx, bpm);
  for (let i = 0; i < left.length; i += 128) {
    const end = Math.min(left.length, i + 128);
    processor.process(left.subarray(i, end), right.subarray(i, end), end - i);
  }
  fs.writeFileSync(outFile, wavFloatStereo(left, right, rate));
}

/** 32-bit float stereo WAV (the impulse response handed to the reverb step). */
function wavFloatStereo(left, right, rate) {
  const n = left.length,
    buffer = Buffer.alloc(44 + n * 8);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + n * 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 8, 28);
  buffer.writeUInt16LE(8, 32);
  buffer.writeUInt16LE(32, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) {
    buffer.writeFloatLE(left[i], 44 + i * 8);
    buffer.writeFloatLE(right[i], 48 + i * 8);
  }
  return buffer;
}

export function createStems({
  root,
  dataDir,
  getJob,
  onChange = () => {},
  cpu = task => task(),
  runTask = null,
}) {
  const folder = path.join(dataDir, 'stems'),
    dbFile = path.join(folder, 'sessions.json');
  fs.mkdirSync(folder, { recursive: true });
  const db = fs.existsSync(dbFile)
    ? JSON.parse(fs.readFileSync(dbFile, 'utf8'))
    : { version: 1, sessions: [] };
  if (db.version !== 1 || !Array.isArray(db.sessions)) throw new Error('Invalid mixer archive.');
  const python = audioPython(root);
  const queue = [];
  let running = false,
    closed = false;
  const save = () => {
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(dbFile + '.tmp', dbFile);
    onChange();
  };
  for (const s of db.sessions)
    if (['queued', 'processing'].includes(s.status)) {
      s.status = 'failed';
      s.error = 'Stem separation was interrupted by a restart. Try again.';
      s.phase = 'Interrupted';
    }
  const get = id => db.sessions.find(s => s.id === id);
  const dir = id => path.join(folder, id);
  const layersOf = s => s?.layers ?? [];
  const externalsOf = s => s?.externals ?? [];
  function source(id) {
    if (!uuid(id)) throw new Error('Invalid track ID.');
    const job = getJob(id);
    if (job?.status !== 'done' || job.assets?.flac !== `${id}.flac`)
      throw new Error('Select a completed track.');
    if (job.kind === 'layer')
      throw new Error('This is an added instrument, not a track. Open it from the original track.');
    const file = path.join(dataDir, 'audio', id + '.flac');
    if (!fs.existsSync(file)) throw new Error('Original audio was not found.');
    return file;
  }
  function change(s, fields) {
    Object.assign(s, fields, { updatedAt: new Date().toISOString() });
    save();
  }
  function worker(task, progress) {
    return new Promise((resolve, reject) => {
      const file = path.join(folder, 'task-' + randomUUID() + '.json');
      fs.writeFileSync(file, JSON.stringify(task));
      const child = spawn(python, [path.join(root, 'stems_worker.py'), file], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '6' },
      });
      let buffer = '',
        last = null,
        errorText = '';
      const timeout = setTimeout(() => child.kill(), 40 * 60 * 1000);
      timeout.unref();
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines)
          try {
            last = JSON.parse(line);
            if (last.phase) progress(last.phase);
          } catch {}
      });
      child.stderr.on('data', chunk => (errorText = (errorText + chunk.toString()).slice(-1800)));
      const cleanup = () => {
        clearTimeout(timeout);
        fs.rmSync(file, { force: true });
      };
      child.once('error', err => {
        cleanup();
        reject(new Error(err.code === 'ENOENT' ? 'Stem separator is not installed.' : err.message));
      });
      child.once('close', code => {
        cleanup();
        if (code === 0 && last?.done) resolve(last);
        else reject(new Error(last?.error || errorText.trim() || 'Stem separation was interrupted.'));
      });
    });
  }
  async function drain() {
    if (running || closed) return;
    running = true;
    while (queue.length && !closed) {
      const s = queue.shift();
      try {
        change(s, { status: 'processing', phase: 'Preparing audio' });
        const task = {
          action: 'separate6',
          source: source(s.id),
          outputDir: dir(s.id),
          modelDir: path.join(dataDir, 'editor', 'models'),
        };
        const result = await cpu(
          () => (runTask || worker)(task, phase => change(s, { phase })),
          () => change(s, { phase: 'Waiting: another audio task is in progress' })
        );
        if (closed) break;
        change(s, { phase: 'Creating previews' });
        for (const name of result.stems)
          await run('ffmpeg', [
            '-y',
            '-v',
            'error',
            '-i',
            path.join(dir(s.id), name + '.flac'),
            '-b:a',
            '160k',
            path.join(dir(s.id), name + '.mp3'),
          ]);
        change(s, { status: 'ready', phase: 'Ready', stems: result.stems, error: null });
      } catch (e) {
        if (!closed) change(s, { status: 'failed', phase: 'Error', error: e.message });
      }
    }
    running = false;
  }
  return {
    snapshot: () => ({
      sessions: db.sessions.map(({ id, status, phase, stems, error, layers, grid, externals }) => ({
        id,
        status,
        phase,
        stems,
        error,
        layers: layers ?? [],
        grid: grid ?? null,
        externals: externals ?? [],
      })),
    }),
    /** Constant-tempo beat grid of a separated song (cached in the session); used for snapping on the timeline. */
    async ensureGrid(id) {
      const s = get(id);
      if (!s?.stems || s.status !== 'ready') throw new Error('Separate the track first.');
      if (s.grid) return s.grid;
      const result = await cpu(
        () => (runTask || worker)({ action: 'grid', stemDir: dir(id) }, () => {}),
        () => {}
      );
      change(s, { grid: result.grid });
      return result.grid;
    },
    separate(id) {
      source(id);
      let s = get(id);
      if (s && (s.stems || ['queued', 'processing'].includes(s.status))) return s;
      if (queue.length >= 4) throw new Error('Wait for the current stem separations to finish.');
      if (!s) db.sessions.push((s = { id, status: 'idle', phase: 'Ready to separate' }));
      change(s, { status: 'queued', phase: 'Queued for separation', error: null });
      queue.push(s);
      void drain();
      return s;
    },
    /** Path of a stem (preview MP3 or lossless FLAC) of a finished separation, or of a registered AI layer. */
    media(id, name, format) {
      const s = get(id);
      if (!['mp3', 'flac'].includes(format)) throw new Error('Invalid format.');
      if (layersOf(s).some(l => l.id === name)) return path.join(dataDir, 'audio', `${name}.${format}`);
      if (externalsOf(s).some(x => x.id === name)) return path.join(dir(id), 'ext', `${name}.${format}`);
      if (!s?.stems || !s.stems.includes(name)) throw new Error('Instrument is unavailable.');
      return path.join(dir(id), `${name}.${format}`);
    },
    /**
     * Guide for an AI layer: the song without vocals as a 128k MP3 (it travels inside the GPU request) plus its length.
     * The generated instrument starts from this audio, so it keeps the song's timeline, tempo and harmony.
     */
    async layerSource(id, window = null) {
      const s = get(id);
      if (!s?.stems || s.status !== 'ready') throw new Error('Separate the track first.');
      const names = s.stems.filter(n => n !== 'vocals');
      const file = path.join(dir(id), `layer-source-${randomUUID()}.mp3`);
      const inputs = names.flatMap(n => ['-i', path.join(dir(id), n + '.flac')]);
      await run('ffmpeg', [
        '-y',
        '-v',
        'error',
        ...inputs,
        '-filter_complex',
        `amix=inputs=${names.length}:normalize=0,alimiter=limit=0.95` +
          (window
            ? `,atrim=start=${window.start.toFixed(3)}:end=${window.end.toFixed(3)},asetpts=PTS-STARTPTS`
            : ''),
        '-ac',
        '2',
        '-ar',
        '44100',
        '-b:a',
        '128k',
        file,
      ]);
      return file;
    },
    /**
     * Stores an audio file from outside (an import or a take recorded in the browser): streamed to disk with a size limit,
     * converted to 44.1 kHz stereo FLAC plus a preview MP3. It becomes a source that clips on any track can play.
     */
    async addExternal(id, stream, { name = 'External audio', kind = 'import' } = {}) {
      const s = get(id);
      if (!s?.stems || s.status !== 'ready') throw new Error('Separate the track first.');
      if (externalsOf(s).length >= 24) throw new Error('You can add up to 24 external audio files per track.');
      const extId = randomUUID(),
        folder = path.join(dir(id), 'ext');
      fs.mkdirSync(folder, { recursive: true });
      const upload = path.join(folder, extId + '.upload');
      let bytes = 0;
      const fd = fs.openSync(upload, 'wx');
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > 250 * 1024 * 1024) throw new Error('File exceeds 250 MB.');
          fs.writeSync(fd, chunk);
        }
        if (bytes < 64) throw new Error('Audio file is empty.');
      } catch (e) {
        fs.closeSync(fd);
        fs.rmSync(upload, { force: true });
        throw e;
      }
      fs.closeSync(fd);
      const flac = path.join(folder, extId + '.flac'),
        mp3 = path.join(folder, extId + '.mp3');
      try {
        // A mono source is copied to both channels at full level (a plain up-mix would lose 3 dB).
        const channels = Number(
          (
            await runCapture('ffprobe', [
              '-v',
              'error',
              '-select_streams',
              'a:0',
              '-show_entries',
              'stream=channels',
              '-of',
              'csv=p=0',
              upload,
            ])
          ).trim()
        );
        if (!channels) throw new Error('The file contains no readable audio.');
        const filter = channels === 1 ? ['-af', 'pan=stereo|c0=c0|c1=c0'] : ['-ac', '2'];
        await run('ffmpeg', ['-y', '-v', 'error', '-i', upload, '-vn', ...filter, '-ar', '44100', flac]);
        await run('ffmpeg', ['-y', '-v', 'error', '-i', flac, '-b:a', '160k', mp3]);
        const duration = await audioSeconds(flac);
        if (duration < 0.1 || duration > 1800)
          throw new Error('Duration must be between 0.1 seconds and 30 minutes.');
        const entry = {
          id: extId,
          name: String(name).slice(0, 80) || 'External audio',
          kind: kind === 'rec' ? 'rec' : 'import',
          duration,
        };
        change(s, { externals: [...externalsOf(s), entry] });
        return entry;
      } catch (e) {
        for (const file of [flac, mp3]) fs.rmSync(file, { force: true });
        throw e;
      } finally {
        fs.rmSync(upload, { force: true });
      }
    },
    removeExternal(id, extId) {
      const s = get(id);
      if (!s || !externalsOf(s).some(x => x.id === extId)) throw new Error('External audio was not found.');
      change(s, { externals: externalsOf(s).filter(x => x.id !== extId) });
      for (const ext of ['flac', 'mp3'])
        fs.rmSync(path.join(dir(id), 'ext', `${extId}.${ext}`), { force: true });
    },
    addLayer(id, layer) {
      const s = get(id);
      if (!s || !uuid(layer.id)) return;
      if (layersOf(s).some(l => l.id === layer.id)) return;
      change(s, { layers: [...layersOf(s), { id: layer.id, name: String(layer.name).slice(0, 60) }] });
    },
    removeLayer(id, layerId) {
      const s = get(id);
      if (!s || !layersOf(s).some(l => l.id === layerId)) throw new Error('Added instrument was not found.');
      change(s, { layers: layersOf(s).filter(l => l.id !== layerId) });
    },
    /**
     * Lossless mixdown of the current mixer settings. Tracks with reverb are first rendered to a temporary file, convolved with the
     * same deterministic impulse response the browser uses, and then enter the final mix like any other input.
     */
    async mixdown(id, body) {
      const s = get(id);
      if (!s?.stems || s.status !== 'ready') throw new Error('Separate the track first.');
      const layerIds = layersOf(s).map(l => l.id),
        externalIds = externalsOf(s).map(x => x.id),
        laneIds = validateLanes(body.lanes);
      const tracks = validateStemMix(body, layerIds, laneIds),
        clips = validateClips(
          body.clips,
          [...STEM_NAMES, ...layerIds, ...laneIds],
          [...STEM_NAMES, ...layerIds, ...externalIds]
        );
      // Tempo for tempo-synced delays: the one the timeline showed (it may carry the ×2/÷2 correction), else the detected one.
      const asked = Number(body.bpm);
      const tempo = asked >= 30 && asked <= 300 ? asked : s.grid?.bpm || 100;
      const total = await audioSeconds(path.join(dir(id), 'vocals.flac'));
      const out = path.join(dir(id), 'mixes');
      fs.mkdirSync(out, { recursive: true });
      const work = path.join(out, 'tmp-' + randomUUID());
      fs.mkdirSync(work, { recursive: true });
      const sourceFile = source =>
        STEM_NAMES.includes(source)
          ? path.join(dir(id), source + '.flac')
          : externalIds.includes(source)
            ? path.join(dir(id), 'ext', source + '.flac')
            : path.join(dataDir, 'audio', source + '.flac');
      const rendered = {};
      try {
        // Tracks with the dynamics/modulation processor or a reverb are rendered in stages:
        // pieces + EQ/filters (ffmpeg) → processor (same JS as the preview) → saturation/width/echo (ffmpeg) → reverb (convolution).
        for (const lane of lanePlan(tracks, clips).filter(l => dspActive(l.fx) || l.fx.verb > 0)) {
          const inputs = lane.segments.flatMap(seg => ['-i', sourceFile(seg.src ?? seg.key)]);
          const stage = name => path.join(work, `${lane.key}-${name}.wav`);
          const staged = dspActive(lane.fx);
          const first = stage('a');
          await run('ffmpeg', [
            '-y',
            '-v',
            'error',
            ...inputs,
            '-filter_complex',
            laneRenderGraph(lane, staged ? 'pre' : 'all'),
            '-map',
            '[out]',
            '-c:a',
            'pcm_f32le',
            '-ar',
            '44100',
            first,
          ]);
          let current = first;
          if (staged) {
            const processed = stage('b');
            applyDsp(current, processed, lane.fx, tempo);
            current = processed;
            const post = postGraph(lane.fx);
            if (post) {
              const posted = stage('c');
              await run('ffmpeg', [
                '-y',
                '-v',
                'error',
                '-i',
                current,
                '-filter_complex',
                post,
                '-map',
                '[out]',
                '-c:a',
                'pcm_f32le',
                '-ar',
                '44100',
                posted,
              ]);
              current = posted;
            }
          }
          if (lane.fx.verb > 0) {
            const wet = stage('verb'),
              ir = path.join(work, `ir-${lane.fx.room}.wav`);
            if (!fs.existsSync(ir)) {
              const { left, right, sampleRate } = reverbImpulse(lane.fx.room, 44100);
              fs.writeFileSync(ir, wavFloatStereo(left, right, sampleRate));
            }
            await (runTask || worker)(
              { action: 'reverb', input: current, ir, output: wet, mix: lane.fx.verb },
              () => {}
            );
            current = wet;
          }
          rendered[lane.key] = current;
        }
        const { segments, graph } = stemMixFilter(tracks, clips, rendered);
        const flac = path.join(out, randomUUID() + '.flac'),
          mp3 = flac.replace(/\.flac$/, '.mp3');
        const inputs = segments.flatMap(seg => ['-i', seg.rendered ?? sourceFile(seg.src ?? seg.key)]);
        const base = [
          '-y',
          '-v',
          'error',
          ...inputs,
          '-filter_complex',
          graph,
          '-map',
          '[out]',
          '-t',
          total.toFixed(3),
        ];
        await run('ffmpeg', [...base, '-c:a', 'flac', flac]);
        await run('ffmpeg', [...base, '-c:a', 'libmp3lame', '-q:a', '0', mp3]);
        return { flac, mp3 };
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    close() {
      closed = true;
    },
  };
}
