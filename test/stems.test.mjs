import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  STEM_NAMES,
  validateStemMix,
  validateLanes,
  validateClips,
  stemMixFilter,
  fxFilters,
  createStems,
} from '../stems.mjs';
import { audioSeconds } from '../audio-remix.mjs';
import { normalizeFx, fxActive } from '../public/fx.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('mixer settings are validated and solo/mute decide what is audible', () => {
  const all = validateStemMix({});
  assert.equal(stemMixFilter(all).names.length, 6);
  const muted = validateStemMix({ tracks: { drums: { mute: true } } });
  assert.ok(!stemMixFilter(muted).names.includes('drums'));
  const solo = validateStemMix({ tracks: { bass: { solo: true }, drums: { mute: true } } });
  assert.deepEqual(stemMixFilter(solo).names, ['bass']);
  const panned = stemMixFilter(validateStemMix({ tracks: { vocals: { pan: 0.5, gain: 1.5 } } }));
  assert.match(panned.graph, /c0=0\.7500\*c0\|c1=1\.5000\*c1/);
  assert.throws(() => validateStemMix({ tracks: { bass: { gain: 3 } } }), /Invalid settings/);
  assert.throws(() => validateStemMix({ tracks: { kazoo: {} } }), /Unknown instrument/);
  assert.throws(
    () =>
      stemMixFilter(
        validateStemMix({ tracks: Object.fromEntries(STEM_NAMES.map(n => [n, { mute: true }])) })
      ),
    /No instruments are active/
  );
});

test(
  'a separated song is mixed down to FLAC and MP3 with the requested balance',
  { skip: !hasFfmpeg },
  async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-stems-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const id = '55555555-5555-4555-8555-555555555555';
    fs.mkdirSync(path.join(dataDir, 'audio'), { recursive: true });
    const tone = (file, hz) =>
      spawnSync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${hz}:duration=3`,
        '-ac',
        '2',
        '-ar',
        '44100',
        file,
      ]);
    tone(path.join(dataDir, 'audio', id + '.flac'), 440);
    const job = { id, title: 'Prova', status: 'done', assets: { flac: id + '.flac' } };
    const stems = createStems({
      root: path.resolve('.'),
      dataDir,
      getJob: x => (x === id ? job : null),
      runTask: async task => {
        STEM_NAMES.forEach((n, i) => tone(path.join(task.outputDir, n + '.flac'), 200 + i * 100));
        return { done: true, stems: [...STEM_NAMES] };
      },
    });
    fs.mkdirSync(path.join(dataDir, 'stems', id), { recursive: true });
    stems.separate(id);
    for (let i = 0; i < 100 && stems.snapshot().sessions[0].status !== 'ready'; i++)
      await new Promise(r => setTimeout(r, 100));
    assert.equal(stems.snapshot().sessions[0].status, 'ready', JSON.stringify(stems.snapshot()));
    assert.ok(fs.existsSync(stems.media(id, 'bass', 'mp3')));
    const cut = await stems.mixdown(id, {
      tracks: { drums: { mute: true } },
      clips: { bass: [{ at: 1, from: 0, len: 1 }], vocals: [], other: [], guitar: [], piano: [] },
    });
    assert.ok(
      Math.abs((await audioSeconds(cut.flac)) - 2) < 0.15,
      'a cut placed at 1 s and 1 s long ends at 2 s'
    );
    const files = await stems.mixdown(id, { tracks: { vocals: { mute: true }, drums: { gain: 0.5 } } });
    assert.ok(Math.abs((await audioSeconds(files.flac)) - 3) < 0.1);
    assert.ok(fs.statSync(files.mp3).size > 1000);
    // An AI layer: a finished helper song registered as one more track; unknown layer ids stay rejected.
    const layerId = '66666666-6666-4666-8666-666666666666';
    assert.throws(() => stems.media(id, layerId, 'mp3'), /unavailable/);
    tone(path.join(dataDir, 'audio', layerId + '.flac'), 1000);
    tone(path.join(dataDir, 'audio', layerId + '.mp3'), 1000);
    stems.addLayer(id, { id: layerId, name: 'Violoncello' });
    assert.deepEqual(stems.snapshot().sessions[0].layers, [{ id: layerId, name: 'Violoncello' }]);
    assert.ok(stems.media(id, layerId, 'mp3').endsWith(layerId + '.mp3'));
    const withLayer = await stems.mixdown(id, {
      tracks: { [layerId]: { gain: 0.8 }, vocals: { mute: true } },
    });
    assert.ok(Math.abs((await audioSeconds(withLayer.flac)) - 3) < 0.1);
    await assert.rejects(
      () => stems.mixdown(id, { tracks: { '77777777-7777-4777-8777-777777777777': {} } }),
      /Unknown instrument/
    );
    const source = await stems.layerSource(id);
    assert.ok(Math.abs((await audioSeconds(source)) - 3) < 0.2);
    stems.removeLayer(id, layerId);
    assert.deepEqual(stems.snapshot().sessions[0].layers, []);
    assert.throws(() => stems.removeLayer(id, layerId), /not found/);
    assert.throws(() => stems.media(id, 'kazoo', 'mp3'), /unavailable/);
    stems.close();
  }
);

test('timeline cuts are validated and become trimmed, delayed segments in the mix', () => {
  const keys = [...STEM_NAMES];
  assert.throws(() => validateClips({ kazoo: [] }, keys), /Unknown instrument/);
  assert.throws(() => validateClips({ bass: [{ at: -1, from: 0, len: 2 }] }, keys), /Invalid cut/);
  assert.throws(() => validateClips({ bass: [{ at: 0, from: 0, len: 0.01 }] }, keys), /Invalid cut/);
  assert.throws(() => validateClips({ bass: Array(65).fill({ at: 0, from: 0, len: 1 }) }, keys), /Too many cuts/);
  const clips = validateClips(
    {
      bass: [
        { at: 4, from: 2, len: 3 },
        { at: 10, from: 0, len: 2 },
      ],
      drums: [],
    },
    keys
  );
  const { segments, graph } = stemMixFilter(validateStemMix({}), clips);
  assert.equal(segments.filter(x => x.key === 'bass').length, 2);
  assert.equal(segments.filter(x => x.key === 'drums').length, 0);
  assert.match(graph, /atrim=start=2\.0000:duration=3\.0000.*adelay=4000:all=1/);
  assert.match(graph, /atrim=start=0\.0000:duration=2\.0000.*adelay=10000:all=1/);
});

test('custom lanes: validated ids, clips may play another track and stay silent when empty', () => {
  assert.deepEqual(validateLanes(undefined), []);
  assert.deepEqual(validateLanes(['lane-abc123']), ['lane-abc123']);
  assert.throws(() => validateLanes(['lane-x']), /Invalid added tracks/);
  assert.throws(() => validateLanes(['..\/etc']), /Invalid added tracks/);
  assert.throws(() => validateLanes(['lane-abc123', 'lane-abc123']), /Invalid added tracks/);
  const lanes = ['lane-abc123'];
  const keys = [...STEM_NAMES, ...lanes];
  const clips = validateClips(
    { 'lane-abc123': [{ at: 2, from: 1, len: 3, src: 'drums' }] },
    keys,
    STEM_NAMES
  );
  assert.equal(clips['lane-abc123'][0].src, 'drums');
  assert.throws(
    () => validateClips({ bass: [{ at: 0, from: 0, len: 1, src: 'lane-abc123' }] }, keys, STEM_NAMES),
    /Unknown cut source/
  );
  assert.throws(
    () => validateClips({ bass: [{ at: 0, from: 0, len: 1, src: '../x' }] }, keys, STEM_NAMES),
    /Unknown cut source/
  );
  const tracks = validateStemMix({ tracks: { 'lane-abc123': { gain: 0.5, pan: -1 } } }, [], lanes);
  const mix = stemMixFilter(tracks, clips);
  assert.ok(mix.segments.some(x => x.key === 'lane-abc123' && x.src === 'drums'));
  assert.match(mix.graph, /c0=0\.5000\*c0\|c1=0\.0000\*c1/);
  // an empty lane contributes nothing (it must not fall back to playing a file named after the lane)
  const quiet = stemMixFilter(validateStemMix({}, [], lanes), {});
  assert.ok(!quiet.segments.some(x => x.key === 'lane-abc123'));
});

test('clip fades are validated, clamped to the clip and written into the mix filter', () => {
  const keys = [...STEM_NAMES];
  const [clip] = validateClips({ bass: [{ at: 0, from: 0, len: 4, fi: 1.5, fo: 0.5 }] }, keys).bass;
  assert.equal(clip.fi, 1.5);
  assert.equal(clip.fo, 0.5);
  const [over] = validateClips({ bass: [{ at: 0, from: 0, len: 2, fi: 3, fo: 1 }] }, keys).bass;
  assert.ok(Math.abs(over.fi + over.fo - 2) < 1e-9, 'fades never exceed the clip');
  assert.throws(() => validateClips({ bass: [{ at: 0, from: 0, len: 2, fi: -1 }] }, keys), /Invalid fade/);
  assert.throws(() => validateClips({ bass: [{ at: 0, from: 0, len: 2, fo: 'x' }] }, keys), /Invalid fade/);
  const { graph } = stemMixFilter(validateStemMix({}), {
    bass: [clip],
    drums: [],
    vocals: [],
    guitar: [],
    piano: [],
    other: [],
  });
  assert.match(graph, /afade=t=in:d=1\.5000,afade=t=out:st=3\.5000:d=0\.5000/);
});

test('effects: settings are clamped, and the ffmpeg chain follows the documented order', () => {
  assert.equal(fxActive({}), false);
  assert.equal(fxActive({ verb: 0.2 }), true);
  const clamped = normalizeFx({ low: 99, hp: 5, lp: 99999, width: -3, room: 'cathedral', sat: 'x' });
  assert.equal(clamped.low, 12);
  assert.equal(clamped.hp, 20);
  assert.equal(clamped.lp, 20000);
  assert.equal(clamped.width, 0);
  assert.equal(clamped.room, 'medium');
  assert.equal(clamped.sat, 0);
  const chain = fxFilters({
    low: 3,
    mid: -2,
    high: 4,
    hp: 100,
    lp: 8000,
    sat: 0.5,
    width: 1.5,
    echo: 0.4,
    echoMs: 200,
  });
  const names = chain.map(x => x.split('=')[0]);
  assert.deepEqual(names, ['bass', 'equalizer', 'treble', 'highpass', 'lowpass', 'aeval', 'pan', 'aecho']);
  assert.match(chain.at(-1), /aecho=1:1:200\|400\|600:0\.2400\|0\.1440\|0\.0864/);
  assert.deepEqual(fxFilters({}), []);
});

test(
  'a real mixdown applies EQ, saturation, width and reverb with the same loudness law as the preview',
  { skip: !hasFfmpeg },
  async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-fx-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const id = '88888888-8888-4888-8888-888888888888';
    fs.mkdirSync(path.join(dataDir, 'audio'), { recursive: true });
    const tone = (file, hz) =>
      spawnSync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${hz}:duration=3`,
        '-ac',
        '2',
        '-ar',
        '44100',
        file,
      ]);
    tone(path.join(dataDir, 'audio', id + '.flac'), 100);
    const job = { id, title: 'Fx', status: 'done', assets: { flac: id + '.flac' } };
    const python =
      spawnSync('python', ['-c', 'import numpy, scipy, soundfile']).status === 0 ? 'python' : null;
    const stems = createStems({
      root: path.resolve('.'),
      dataDir,
      getJob: x => (x === id ? job : null),
      runTask: async task => {
        if (task.action === 'reverb') {
          const file = path.join(dataDir, 'task.json');
          fs.writeFileSync(file, JSON.stringify(task));
          const r = spawnSync(python, [path.resolve('stems_worker.py'), file]);
          if (r.status) throw new Error(String(r.stderr));
          return { done: true };
        }
        STEM_NAMES.forEach(n => tone(path.join(task.outputDir, n + '.flac'), 100));
        // The reverb is checked on noise: a pure tone only excites one frequency of a random impulse response.
        spawnSync('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'anoisesrc=d=3:c=pink:r=44100:a=0.3',
          '-af',
          'pan=stereo|c0=c0|c1=c0',
          path.join(task.outputDir, 'other.flac'),
        ]);
        return { done: true, stems: [...STEM_NAMES] };
      },
    });
    fs.mkdirSync(path.join(dataDir, 'stems', id), { recursive: true });
    stems.separate(id);
    for (let i = 0; i < 100 && stems.snapshot().sessions[0].status !== 'ready'; i++)
      await new Promise(r => setTimeout(r, 100));
    const only = (key, extra) => ({
      tracks: Object.fromEntries(STEM_NAMES.map(n => [n, n === key ? extra : { mute: true }])),
    });
    const rms = file => {
      const r = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        '-',
      ]);
      const d = new Float32Array(
        r.stdout.buffer.slice(
          r.stdout.byteOffset,
          r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)
        )
      );
      return Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length);
    };
    const plain = rms((await stems.mixdown(id, only('bass', {}))).flac);
    const boosted = rms((await stems.mixdown(id, only('bass', { fx: { low: 12 } }))).flac);
    assert.ok(
      boosted / plain > 2.4 && boosted / plain < 4.6,
      `low shelf +12 dB at 100 Hz, ratio ${boosted / plain}`
    );
    const cut = rms((await stems.mixdown(id, only('bass', { fx: { hp: 1000 } }))).flac);
    assert.ok(cut / plain < 0.1, 'a 1 kHz high-pass removes a 100 Hz tone');
    const saturated = rms((await stems.mixdown(id, only('bass', { fx: { sat: 1 } }))).flac);
    assert.ok(saturated > plain, 'saturation raises the average level of a sine');
    // The compressor runs in the export with the same module as the preview: 4:1 above -30 dBFS turns the -21.07 dBFS test sine (mono tone placed in stereo) into -27.77 dBFS, a 6.7 dB reduction.
    const squeezed = rms(
      (
        await stems.mixdown(
          id,
          only('bass', {
            fx: { comp: { on: true, thr: -30, ratio: 4, att: 1, rel: 100, knee: 0, auto: false, schp: 20 } },
          })
        )
      ).flac
    );
    assert.ok(Math.abs(squeezed / plain - 10 ** (-6.7 / 20)) < 0.04, `compressed ratio ${squeezed / plain}`);
    const everything = await stems.mixdown(
      id,
      only('bass', {
        fx: {
          low: 3,
          sat: 0.3,
          width: 1.4,
          echo: 0.2,
          comp: { on: true },
          dist: { on: true, mix: 0.3 },
          wah: { on: true, mix: 0.3 },
          env: { on: true, mix: 0.3 },
          chorus: { on: true },
          flanger: { on: true },
          delay: { on: true, mix: 0.2, pingpong: true },
        },
      })
    );
    assert.ok(
      Math.abs((await audioSeconds(everything.flac)) - 3) < 0.1,
      'a full effect chain keeps the song length'
    );
    if (python) {
      const dryNoise = rms((await stems.mixdown(id, only('other', {}))).flac);
      const wet = await stems.mixdown(id, only('other', { fx: { verb: 0.5, room: 'small' } }));
      assert.ok(
        Math.abs((await audioSeconds(wet.flac)) - 3) < 0.1,
        'the reverb tail does not lengthen the song'
      );
      const level = rms(wet.flac);
      assert.ok(
        level > plain * 0.5 && level < plain * 1.5,
        `equal-power reverb keeps the level (${level} vs ${plain})`
      );
    }
    stems.close();
  }
);

test(
  'external audio (an import or a recorded take) becomes a source for clips on any track',
  { skip: !hasFfmpeg },
  async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-ext-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const id = '99999999-9999-4999-8999-999999999999';
    fs.mkdirSync(path.join(dataDir, 'audio'), { recursive: true });
    const make = (file, hz, channels = 2, seconds = 3) =>
      spawnSync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${hz}:duration=${seconds}`,
        '-ac',
        String(channels),
        '-ar',
        '48000',
        file,
      ]);
    make(path.join(dataDir, 'audio', id + '.flac'), 100);
    const job = { id, title: 'Ext', status: 'done', assets: { flac: id + '.flac' } };
    const stems = createStems({
      root: path.resolve('.'),
      dataDir,
      getJob: x => (x === id ? job : null),
      runTask: async task => {
        STEM_NAMES.forEach(n => make(path.join(task.outputDir, n + '.flac'), 100));
        return { done: true, stems: [...STEM_NAMES] };
      },
    });
    fs.mkdirSync(path.join(dataDir, 'stems', id), { recursive: true });
    await assert.rejects(
      () => stems.addExternal(id, Readable.from([Buffer.alloc(200)])),
      /Separate the track first/
    );
    stems.separate(id);
    for (let i = 0; i < 100 && stems.snapshot().sessions[0].status !== 'ready'; i++)
      await new Promise(r => setTimeout(r, 100));
    const monoFile = path.join(dataDir, 'mono.wav');
    make(monoFile, 440, 1, 2);
    const entry = await stems.addExternal(id, Readable.from([fs.readFileSync(monoFile)]), {
      name: 'Chitarra',
      kind: 'rec',
    });
    assert.equal(entry.name, 'Chitarra');
    assert.equal(entry.kind, 'rec');
    assert.ok(Math.abs(entry.duration - 2) < 0.1);
    assert.deepEqual(
      stems.snapshot().sessions[0].externals.map(x => x.id),
      [entry.id]
    );
    assert.ok(fs.existsSync(stems.media(id, entry.id, 'mp3')));
    await assert.rejects(
      () => stems.addExternal(id, Readable.from([Buffer.from('not audio at all, just text')])),
      /Audio file is empty|unreadable|readable audio/i
    );
    assert.equal(stems.snapshot().sessions[0].externals.length, 1, 'a rejected file leaves no trace');
    // The take plays on a custom lane at 1 s: the song stays 3 s long and the lane is the only audible one.
    const lane = 'lane-take01';
    const tracks = Object.fromEntries([...STEM_NAMES, lane].map(n => [n, n === lane ? {} : { mute: true }]));
    const mix = await stems.mixdown(id, {
      tracks,
      lanes: [lane],
      clips: { [lane]: [{ at: 1, from: 0, len: 2, src: entry.id }] },
    });
    assert.ok(Math.abs((await audioSeconds(mix.flac)) - 3) < 0.1);
    const level = (from, len) => {
      const r = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-ss',
        String(from),
        '-t',
        String(len),
        '-i',
        mix.flac,
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        '-',
      ]);
      const d = new Float32Array(
        r.stdout.buffer.slice(
          r.stdout.byteOffset,
          r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)
        )
      );
      return Math.sqrt(d.reduce((a, b) => a + b * b, 0) / Math.max(1, d.length));
    };
    assert.ok(level(0.1, 0.7) < 0.001, 'silent before the take');
    assert.ok(level(1.3, 1.2) > 0.05, 'the take is audible from 1 s');
    await assert.rejects(
      () =>
        stems.mixdown(id, {
          tracks,
          lanes: [lane],
          clips: { [lane]: [{ at: 0, from: 0, len: 1, src: '00000000-0000-4000-8000-000000000000' }] },
        }),
      /Unknown cut source/
    );
    stems.removeExternal(id, entry.id);
    assert.equal(stems.snapshot().sessions[0].externals.length, 0);
    assert.throws(() => stems.media(id, entry.id, 'mp3'), /unavailable/);
    stems.close();
  }
);
