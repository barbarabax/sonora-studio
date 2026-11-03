// @codedna
// description: The yue2.cpp backend against a fake yue-server: plan, song, cover transcription, lost jobs and the multipart answer.
// exports: none
// used_by: none
// rules:   No GPU and no real engine: a tiny HTTP server answers like yue-server (job ids, polling, multipart results).
// agent:   claude-opus-5-5 - 2026-10-15 - Created with yue2-cpp.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCppYue2, parseMultipart } from '../yue2-cpp.mjs';

const ABC = 'X:1\nM:4/4\nL:1/16\nQ:1/4=100\nK:C\nV: Vocal\n"C"c4d4e4f4|\n';
const BOUNDARY = 'yue2-batch-boundary';
const multipart = parts =>
  Buffer.concat([
    ...parts.flatMap(([type, body]) => [
      Buffer.from(`--${BOUNDARY}\r\nContent-Type: ${type}\r\n\r\n`),
      Buffer.from(body),
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);

test('a multipart answer is split into its parts, binary bodies intact', () => {
  const audio = Buffer.from([0, 13, 10, 255, 45, 45]);
  const parts = parseMultipart(
    `multipart/mixed; boundary=${BOUNDARY}`,
    multipart([
      ['application/json', '{"abc":"x"}'],
      ['audio/wav', audio],
    ])
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0].body.toString(), '{"abc":"x"}');
  assert.deepEqual(parts[1].body, audio);
});

test('plan, song and cover through a fake yue-server', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cpp-'));
  const jobs = new Map();
  const seen = [];
  let next = 1;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const send = (code, value, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    if (u.pathname === '/health') return send(200, { status: 'ok' });
    if (u.pathname === '/synth') {
      const request = JSON.parse(body.toString());
      seen.push(request);
      const id = String(next++);
      jobs.set(id, { kind: 'synth', request, polls: 0 });
      return send(200, { id });
    }
    if (u.pathname === '/transcribe') {
      seen.push({ transcribe: body.toString('latin1').includes('melody_only') ? 'melody' : 'full' });
      const id = String(next++);
      jobs.set(id, { kind: 'transcribe', polls: 0 });
      return send(200, { id });
    }
    if (u.pathname === '/job') {
      const job = jobs.get(u.searchParams.get('id'));
      if (!job) return send(404, { error: 'unknown job' });
      if (u.searchParams.get('cancel')) return send(200, { status: 'cancelled' });
      if (!u.searchParams.get('result')) return send(200, { status: job.polls++ < 1 ? 'running' : 'done' });
      if (job.kind === 'transcribe') return send(200, { abc: ABC });
      const replay = {
        ...job.request,
        abc: job.request.abc || ABC,
        lm_seed: 42,
        seed: 42,
        semantic_tokens: '1,2,3,4,5,6,7,8,9,10',
      };
      return send(
        200,
        multipart([
          ['application/json', JSON.stringify(replay)],
          ['audio/wav', Buffer.alloc(4000, 3)],
          ['application/octet-stream', Buffer.alloc(16)],
        ]),
        `multipart/mixed; boundary=${BOUNDARY}`
      );
    }
    send(404, { error: 'no' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const files = Object.fromEntries(['engine', 'model', 'vae'].map(k => [k, path.join(dir, k)]));
  for (const f of Object.values(files)) fs.writeFileSync(f, 'x');
  const encoded = [];
  const cpp = createCppYue2(
    { ...files, port: server.address().port },
    {
      dataDir: dir,
      encode: async args => {
        encoded.push(args.at(-1));
        fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));
      },
    }
  );
  assert.equal(cpp.configured, true);
  assert.equal((await cpp.health()).ready, true);

  // the plan: a score-only request (1 s, 1 step), the score and the seed come back
  const plan = await cpp.call({
    action: 'plan',
    localId: crypto.randomUUID(),
    style: 'rock',
    lyrics: '[Verse]\nCiao',
    cot: 'full',
    seed: 7,
  });
  assert.equal(plan.abc, ABC);
  assert.equal(plan.seed, 42);
  assert.deepEqual([seen[0].duration, seen[0].steps, seen[0].lm_seed, seen[0].seed], [1, 1, 7, 7]);

  // a song from an edited plan
  const id = crypto.randomUUID();
  const remote = await cpp.submitAction({
    action: 'generate',
    localId: id,
    style: 'rock',
    lyrics: '[Verse]\nCiao',
    cot: 'melody',
    seed: 9,
    abc: ABC,
    melodyFreedom: 'low',
  });
  assert.deepEqual(remote, { host: 'local', engine: 'cpp', id });
  assert.equal(seen[1].abc, ABC);
  assert.equal(seen[1].semantic_sampling.temperature, 0.7);
  assert.equal(seen[1].abc_sampling.temperature, 0.5);
  assert.equal(seen[1].output_format, 'wav24');
  const job = { id, remote };
  assert.equal((await cpp.status(job)).status, 'IN_PROGRESS');
  const done = await cpp.status(job);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.output.abc, ABC);
  assert.equal(done.output.duration, 0.4, '10 semantic frames at 25 per second');
  assert.deepEqual(
    done.output.audio.map(a => a.format),
    ['flac', 'mp3']
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'yue2-cpp', id, 'replay.json')),
    'the codes are kept for an exact replay'
  );
  const library = path.join(dir, 'library');
  assert.deepEqual(await cpp.collect(job, done.output, library), { flac: `${id}.flac`, mp3: `${id}.mp3` });
  assert.equal(fs.statSync(path.join(library, 'audio', `${id}.mp3`)).size, 4000);
  assert.equal((await cpp.status(job)).status, 'COMPLETED', 'a finished song stays finished after a restart');

  const continuedId = crypto.randomUUID();
  await cpp.submitAction({
    action: 'generate',
    localId: continuedId,
    style: 'rock',
    lyrics: '[Verse]\nCiao',
    cot: 'full',
    seed: 12,
    sourceTokens: '1,2,3,4',
    sourceStart: 0,
    sourceEnd: 0.16,
    duration: 20,
  });
  assert.deepEqual(
    [seen.at(-1).source_tokens, seen.at(-1).source_start, seen.at(-1).source_end, seen.at(-1).duration],
    ['1,2,3,4', 0, 0.16, 20]
  );

  // the cover: melody only unless chords are asked for
  const audio = Buffer.alloc(3000, 1).toString('base64');
  assert.equal((await cpp.call({ action: 'transcribe', audio, format: 'mp3', chords: false })).abc, ABC);
  assert.equal(seen.at(-1).transcribe, 'melody');
  assert.equal((await cpp.call({ action: 'transcribe', audio, format: 'mp3', chords: true })).chords, true);
  assert.equal(seen.at(-1).transcribe, 'full');

  // a job the engine forgot (restarted) is lost, never resubmitted
  const lost = crypto.randomUUID();
  fs.mkdirSync(path.join(dir, 'yue2-cpp', lost), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'yue2-cpp', lost, 'engine.json'),
    JSON.stringify({ engineId: '999', started: Date.now() })
  );
  assert.equal((await cpp.status({ id: lost, remote: { id: lost, engine: 'cpp' } })).status, 'LOST');
  await assert.rejects(
    cpp.submitAction({ action: 'generate', localId: '../x', style: 'a', lyrics: 'b' }),
    /Invalid job identifier\./
  );
});

test('an engine on another computer needs no files here, is never started, and is reported when unreachable', async () => {
  let up = true;
  const asked = [];
  const cpp = createCppYue2(
    { remote: true, port: 19999 },
    {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cpp-remote-')),
      fetchImpl: async address => {
        asked.push(address);
        if (!up) throw new Error('connection refused');
        return new Response('{}', { status: 200 });
      },
      spawnImpl: () => {
        throw new Error('the engine of another computer must never be started from here');
      },
    }
  );
  assert.equal(cpp.configured, true, 'no engine or model file is needed');
  assert.deepEqual(await cpp.health(), { online: true, ready: true, backend: 'yue2-cpp', message: '' });
  assert.equal(asked[0], 'http://127.0.0.1:19999/health', 'the tunnel port on this computer is asked');
  cpp.adaptersChanged();
  up = false;
  const down = await cpp.health();
  assert.equal(down.ready, false);
  assert.match(down.message, /not reachable on port 19999/);
  assert.match(down.message, /SSH tunnel/);
  await assert.rejects(cpp.call({ action: 'plan' }, 1000), /not reachable on port 19999/);
});

test('with the engine on another computer, its loaded LoRAs are read from /props and none can be installed here', async () => {
  const cpp = createCppYue2(
    { remote: true, port: 19998 },
    {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-cpp-remote-lora-')),
      fetchImpl: async address =>
        address.endsWith('/props')
          ? new Response(JSON.stringify({ adapters: [{ name: 'lora-a' }, { name: 'lora-b' }] }), {
              status: 200,
            })
          : new Response('{}', { status: 200 }),
    }
  );
  assert.equal(cpp.remote, true);
  assert.deepEqual(await cpp.engineAdapters(), ['lora-a', 'lora-b']);
});
