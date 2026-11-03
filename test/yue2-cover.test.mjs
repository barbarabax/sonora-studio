// @codedna
// description: YuE2 covers: a song is prepared as a small mono MP3, sent to the worker to get its melody, and the plan comes back; plus the Python tests of the worker.
// exports: none
// used_by: none
// rules:   Fake RunPod endpoint and a fake SheetSage2: no GPU, no model; temporary uploads must be gone after every request.
// agent:   claude-sonnet-5-5 - 2026-10-14 - Cover melody route end to end, audio preparation, worker transcribe action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCoverAudio } from '../yue2-cover.mjs';
import { createStudio } from '../server.mjs';

const ABC =
  'X:1\nM:4/4\nL:1/16\nQ:1/4=100\nV: Vocal\nV: Ins\nK:C\n% verse\nV: Vocal\nc4d4e4f4|\nV: Ins\nC,16|\n';

test('a song is prepared as a base64 mono MP3 and the temporary file is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cover-'));
  const source = path.join(dir, 'song.flac');
  fs.writeFileSync(source, 'x');
  const seen = [];
  const audio = await prepareCoverAudio(source, {
    encode: async args => {
      seen.push(args);
      fs.writeFileSync(args.at(-1), Buffer.alloc(5000, 7));
    },
  });
  assert.equal(audio.format, 'mp3');
  assert.equal(Buffer.from(audio.base64, 'base64').length, 5000);
  assert.deepEqual(seen[0].slice(seen[0].indexOf('-ac'), seen[0].indexOf('-b:a') + 2), [
    '-ac',
    '1',
    '-ar',
    '24000',
    '-b:a',
    '64k',
  ]);
  assert.ok(!fs.existsSync(source + '.cover.mp3'));
  await assert.rejects(
    prepareCoverAudio(source, { encode: async args => fs.writeFileSync(args.at(-1), Buffer.alloc(10)) }),
    /The song is too/
  );
  assert.ok(!fs.existsSync(source + '.cover.mp3'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cover route uploads a song, asks the worker for its melody and removes every temporary file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cover-route-'));
  const song = path.join(dir, 'song.wav');
  const made = spawnSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-ac',
    '2',
    song,
  ]);
  assert.equal(made.status, 0, 'ffmpeg is needed for this test');
  const bytes = fs.readFileSync(song);
  const received = [];
  let reply = { status: 'COMPLETED', output: { abc: ABC, seconds: 12.5 } };
  const fake = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/health')) return new Response(JSON.stringify({ workers: { ready: 0 } }));
    if (url.endsWith('/runsync')) {
      received.push(body);
      return new Response(JSON.stringify(reply));
    }
    return new Response(JSON.stringify({ status: 'IN_PROGRESS' }));
  };
  const app = createStudio(
    {
      comfyUrl: 'http://127.0.0.1:1',
      model: 'm',
      encoder: 'e',
      planner: 'p',
      vae: 'v',
      yue2: { endpointId: 'yue2-endpoint' },
    },
    { dataDir: dir, pollMs: 3600000, runpodFetch: fake, runpodKeyReader: () => 'private-test-key' }
  );
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const upload = (chords = false) =>
    fetch(base + '/api/yue2/cover/melody', {
      method: 'POST',
      headers: {
        'X-Sonora': '1',
        'x-audio-name': encodeURIComponent('Dancing Queen.wav'),
        'x-yue-host': 'runpod',
        'x-cover-chords': chords ? '1' : '0',
        'Content-Type': 'audio/wav',
      },
      body: bytes,
    });

  const response = await upload();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.abc, ABC);
  assert.equal(result.title, 'Dancing Queen');
  assert.equal(result.audioSeconds, 4);
  assert.equal(received.length, 1);
  const input = received[0].input;
  assert.equal(input.action, 'transcribe');
  assert.equal(input.format, 'mp3');
  assert.equal(input.chords, false, 'the melody alone is the default');
  assert.equal(result.chords, false);
  assert.match(input.localId, /^[0-9a-f-]{36}$/);
  assert.ok(Buffer.from(input.audio, 'base64').length > 1024, 'the audio travels as base64');
  assert.ok(received[0].policy.executionTimeout >= 600000, 'a long transcription is allowed to run');
  for (const folder of ['covers-tmp']) {
    const left = fs.existsSync(path.join(dir, folder)) ? fs.readdirSync(path.join(dir, folder)) : [];
    assert.deepEqual(left, [], 'no upload is left behind');
  }
  // the original is kept (small mp3 + title) so the cover can be reused without uploading it again
  assert.match(result.coverId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'covers')).sort(), [
    `${result.coverId}.json`,
    `${result.coverId}.mp3`,
  ]);
  const listen = await fetch(`${base}/api/yue2/cover/${result.coverId}/audio`);
  assert.equal(listen.status, 200);
  assert.equal(listen.headers.get('content-type'), 'audio/mpeg');
  const again = await fetch(base + '/api/yue2/cover/melody', {
    method: 'POST',
    headers: { 'X-Sonora': '1', 'x-yue-host': 'runpod', 'x-cover-chords': '1', 'x-cover-id': result.coverId },
    body: '',
  });
  assert.equal(again.status, 200);
  const reused = await again.json();
  assert.deepEqual(
    [reused.coverId, reused.title, reused.audioSeconds, reused.chords],
    [result.coverId, 'Dancing Queen', 4, true]
  );
  assert.equal(received.length, 2, 'the stored original went to the worker again');
  assert.equal(fs.readdirSync(path.join(dir, 'covers')).length, 2, 'no second copy of the original');
  const gone = await fetch(base + '/api/yue2/cover/melody', {
    method: 'POST',
    headers: {
      'X-Sonora': '1',
      'x-yue-host': 'runpod',
      'x-cover-id': '00000000-0000-4000-8000-000000000000',
    },
    body: '',
  });
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /no longer available/);

  // with the chords box ticked the worker is asked for them and the answer says so
  const withChords = await (await upload(true)).json();
  assert.equal(received.at(-1).input.chords, true);
  assert.equal(withChords.chords, true);
  // a worker that returns something that is not a score is refused
  reply = { status: 'COMPLETED', output: { abc: 'not a score', seconds: 1 } };
  const bad = await upload();
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /valid score/);
  // a file that is not audio is refused before anything is sent to the GPU
  const before = received.length;
  const junk = await fetch(base + '/api/yue2/cover/melody', {
    method: 'POST',
    headers: { 'X-Sonora': '1' },
    body: Buffer.alloc(2000, 1),
  });
  assert.equal(junk.status, 400);
  assert.equal(received.length, before);
});

test('the worker transcribe action, with a fake SheetSage2 (Python)', t => {
  const python = spawnSync('python', ['--version']);
  if (python.status !== 0) return t.skip('python is not available');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const run = spawnSync('python', ['-m', 'unittest', 'integrations/runpod/test_yue2_worker.py'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(run.status, 0, run.stderr);
});
