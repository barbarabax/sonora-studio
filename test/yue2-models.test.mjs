// @codedna
// description: The YuE2 model downloader: fixed files of a pinned revision, SHA-256 checks, resume, cancel and refusal to touch existing files.
// exports: none
// used_by: none
// rules:   A fake Hugging Face only; nothing is downloaded from the network.
// agent:   claude-haiku-5-5 | anthropic | 2026-11-03 | Created with the setup helper for the portable build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createYue2Models, YUE2_FILES, YUE2_REVISION } from '../yue2-models.mjs';

const bytesOf = name => Buffer.from(name.repeat(40));
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function fakeHub({ corrupt = null, rangeCalls = [] } = {}) {
  return async (url, options = {}) => {
    const address = new URL(url);
    if (address.pathname.startsWith('/api/models/Serveurperso/YuE2-GGUF/tree/')) {
      assert.ok(
        address.pathname.endsWith('/' + YUE2_REVISION),
        'the manifest comes from the pinned revision'
      );
      return Response.json(
        YUE2_FILES.map(file => ({
          path: file.name,
          size: bytesOf(file.name).length,
          lfs: { oid: sha(bytesOf(file.name)) },
        }))
      );
    }
    const name = decodeURIComponent(address.pathname.split('/').pop());
    assert.ok(
      address.pathname.includes('/resolve/' + YUE2_REVISION + '/'),
      'files come from the pinned revision'
    );
    let data = bytesOf(name);
    if (name === corrupt) data = Buffer.from('x'.repeat(data.length));
    const range = options.headers?.Range;
    if (range) {
      rangeCalls.push(range);
      const from = Number(/bytes=(\d+)-/.exec(range)[1]);
      return new Response(data.subarray(from), {
        status: 206,
        headers: { 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` },
      });
    }
    return new Response(data, { status: 200 });
  };
}

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-yue2-models-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the plan lists what is missing and leaves the optional cover files out by default', async t => {
  const dir = temp(t);
  const models = createYue2Models({ fetchImpl: fakeHub() });
  const plan = await models.inspect(dir);
  assert.deepEqual(
    plan.files.map(f => f.name),
    ['YuE2-3B-Q8_0.gguf', 'YuE2-Vae-F32.gguf']
  );
  assert.ok(plan.files.every(f => f.status === 'missing'));
  assert.equal((await models.inspect(dir, { covers: true })).files.length, 4);
  await assert.rejects(models.inspect('relative/folder'), /full path/);
});

test('files are downloaded, verified and kept; existing files are never replaced', async t => {
  const dir = temp(t);
  const models = createYue2Models({ fetchImpl: fakeHub() });
  await assert.rejects(models.download({ dir }), /Confirm/);
  const done = await models.download({ dir, confirmed: true });
  assert.equal(done.downloaded, 2);
  for (const name of ['YuE2-3B-Q8_0.gguf', 'YuE2-Vae-F32.gguf'])
    assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytesOf(name));
  assert.equal(
    fs.readdirSync(dir).some(n => n.endsWith('.sonora-part')),
    false,
    'no partial file is left'
  );
  assert.equal(models.snapshot().status, 'ready');
  assert.equal(
    (await models.download({ dir, confirmed: true })).downloaded,
    0,
    'a second run downloads nothing'
  );
  fs.writeFileSync(path.join(dir, 'YuE2-Vae-F32.gguf'), 'wrong size');
  await assert.rejects(models.inspect(dir), /size does not match/);
  assert.equal(
    fs.readFileSync(path.join(dir, 'YuE2-Vae-F32.gguf'), 'utf8'),
    'wrong size',
    'the file was left untouched'
  );
});

test('a file that fails the checksum is removed and reported', async t => {
  const dir = temp(t);
  const models = createYue2Models({ fetchImpl: fakeHub({ corrupt: 'YuE2-Vae-F32.gguf' }) });
  await assert.rejects(models.download({ dir, confirmed: true }), /Integrity check failed for YuE2-Vae-F32/);
  assert.equal(fs.existsSync(path.join(dir, 'YuE2-Vae-F32.gguf')), false);
  assert.equal(fs.existsSync(path.join(dir, 'YuE2-Vae-F32.gguf.sonora-part')), false);
  assert.equal(fs.existsSync(path.join(dir, 'YuE2-3B-Q8_0.gguf')), true, 'the file before it is kept');
  assert.equal(models.snapshot().status, 'error');
});

test('an interrupted download resumes from the partial file', async t => {
  const dir = temp(t);
  const rangeCalls = [];
  const name = 'YuE2-3B-Q8_0.gguf';
  fs.writeFileSync(path.join(dir, name + '.sonora-part'), bytesOf(name).subarray(0, 100));
  const models = createYue2Models({ fetchImpl: fakeHub({ rangeCalls }) });
  await models.download({ dir, confirmed: true });
  assert.deepEqual(rangeCalls, ['bytes=100-']);
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytesOf(name));
});

test('a redirect to another host is refused', async t => {
  const dir = temp(t);
  const evil = async () =>
    Object.defineProperty(Response.json([]), 'url', { value: 'https://example.com/list' });
  await assert.rejects(createYue2Models({ fetchImpl: evil }).inspect(dir), /untrusted host/);
});
