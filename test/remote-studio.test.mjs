import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { createFileProtector } from '../credentials.mjs';
import { createRunpodBackend } from '../runpod-backend.mjs';
import http from 'node:http';

const request = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method || 'GET', headers: options.headers, agent: false },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });

test('portable credentials authenticate ciphertext and keep plaintext off disk', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-crypto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key');
  const p = createFileProtector(keyFile),
    encrypted = p.protect('private-api-key');
  assert.equal(createFileProtector(keyFile).unprotect(encrypted), 'private-api-key');
  assert.equal(encrypted.includes('private-api-key'), false);
  const bytes = Buffer.from(encrypted, 'base64');
  bytes[20] ^= 1;
  assert.throws(() => p.unprotect(bytes.toString('base64')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

test('RunPod jobs survive restart, save verified audio, and never resubmit generation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-remote-'));
  const bytes = Buffer.alloc(96, 3),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  let submitted = 0,
    complete = false,
    cancelled = 0;
  const fake = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    const body = options.body ? JSON.parse(options.body) : null;
    const response = value => new Response(JSON.stringify(value));
    if (url.endsWith('/health')) return response({ workers: { ready: 0 } });
    if (url.endsWith('/run')) {
      submitted++;
      return response({ id: 'remote-job-12345', status: 'IN_QUEUE' });
    }
    if (url.includes('/cancel/')) {
      cancelled++;
      return response({ status: 'CANCELLED' });
    }
    if (url.includes('/status/'))
      return response(
        complete
          ? {
              status: 'COMPLETED',
              output: {
                audio: ['mp3', 'flac'].map(format => ({ format, bytes: bytes.length, sha256 })),
              },
            }
          : { status: 'IN_PROGRESS' }
      );
    if (url.endsWith('/runsync')) {
      assert.equal(body.input.action, 'asset');
      return response({
        status: 'COMPLETED',
        output: { ...body.input, bytes: bytes.length, base64: bytes.toString('base64') },
      });
    }
    throw new Error('Unexpected URL: ' + url);
  };
  const config = {
    comfyUrl: 'http://127.0.0.1:1',
    model: 'm',
    encoder: 'e',
    planner: 'p',
    vae: 'v',
    generationBackend: 'runpod',
    runpod: { endpointId: 'endpoint-test', modelsReady: true },
    publicOrigin: 'https://sonora.example.test',
  };
  const options = {
    dataDir: dir,
    pollMs: 3600000,
    runpodFetch: fake,
    runpodKeyReader: () => 'private-test-key',
  };
  let app = createStudio(config, options);
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const start = async () => {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  let base = await start();
  const headers = {
    Host: 'sonora.example.test',
    Origin: 'https://sonora.example.test',
    'X-Sonora': '1',
    'Content-Type': 'application/json',
  };
  let r = await request(base + '/api/generate', {
    method: 'POST',
    headers: { ...headers, Origin: 'https://evil.test' },
    body: '{}',
  });
  assert.equal(r.status, 403);
  r = await request(base + '/api/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Remote', tags: 'piano', instrumental: true, duration: 10, variants: 1 }),
  });
  assert.equal(r.status, 202, await r.text());
  assert.equal(submitted, 1);
  await app.close();
  app = createStudio(config, options);
  base = await start();
  complete = true;
  await app.poll();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')).jobs[0];
  assert.equal(saved.status, 'done');
  assert.equal(submitted, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'audio', saved.assets.flac)), bytes);
  assert.equal(JSON.stringify(saved).includes('private-test-key'), false);
  r = await request(base + '/api/config', { headers: { Host: 'untrusted.test' } });
  assert.equal(r.status, 403);
  r = await request(base + '/api/jobs/' + saved.id + '/cancel', { method: 'POST', headers, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(cancelled, 0);
});

test('tampered RunPod downloads fail integrity checks and preserve completed originals', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-bad-audio-'));
  fs.mkdirSync(path.join(dir, 'audio'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = Buffer.alloc(40, 2),
    good = Buffer.alloc(40, 1);
  const remote = createRunpodBackend(
    { endpointId: 'endpoint-test' },
    {
      keyReader: () => 'test-key',
      fetchImpl: async (url, options) => {
        const input = JSON.parse(options.body).input;
        return new Response(
          JSON.stringify({
            status: 'COMPLETED',
            output: { ...input, bytes: bad.length, base64: bad.toString('base64') },
          })
        );
      },
    }
  );
  await assert.rejects(
    remote.collect(
      { id: 'track', remote: { endpointId: 'endpoint-test' } },
      {
        audio: ['mp3', 'flac'].map(format => ({
          format,
          bytes: 40,
          sha256: createHash('sha256').update(good).digest('hex'),
        })),
      },
      dir
    ),
    /integrity/
  );
  assert.equal(fs.existsSync(path.join(dir, 'audio', 'track.mp3')), false);
});
