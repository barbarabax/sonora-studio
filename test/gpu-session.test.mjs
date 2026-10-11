import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGpuSession } from '../gpu-session.mjs';
import { createRunpodBackend } from '../runpod-backend.mjs';

test('GPU session records a fixed expiry, survives restart and retries uncertain stops', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-session-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = 1000,
    min = 0,
    failStop = false;
  const remote = {
    async sessionSettings(value) {
      if (value === 1) {
        const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'gpu-session.json')));
        assert.equal(saved.expiresAt, 1801000);
      }
      if (value === 0 && failStop) throw new Error('offline');
      if (value !== undefined) min = value;
      return { workersMin: min, workersMax: 1 };
    },
  };
  const options = { dataDir, endpointId: 'endpoint-test', remote, now: () => now };
  let session = createGpuSession(options);
  await session.start();
  assert.equal(min, 1);
  await assert.rejects(session.start(), /current session/);
  session = createGpuSession(options);
  now = 1800999;
  await session.reconcile();
  assert.equal(min, 1);
  now++;
  failStop = true;
  await assert.rejects(session.reconcile(), /not confirmed/);
  assert.equal(session.status().phase, 'stopping');
  failStop = false;
  await createGpuSession(options).reconcile();
  assert.equal(min, 0);
  assert.equal(session.status().active, false);
});

test('uncertain GPU activation is durably compensated rather than forgotten', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-session-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let min = 0;
  const remote = {
    async sessionSettings(value) {
      if (value === 1) {
        min = 1;
        throw new Error('lost receipt');
      }
      if (value === 0) min = 0;
      return { workersMin: min, workersMax: 1 };
    },
  };
  const session = createGpuSession({ dataDir, endpointId: 'endpoint-test', remote });
  await assert.rejects(session.start(), /not confirmed/);
  await session.reconcile();
  assert.equal(min, 0);
  assert.equal(session.status().active, false);
});

test('RunPod sessions send explicit zero and do not change unrelated endpoint configuration', async () => {
  let min = 0;
  const remote = createRunpodBackend(
    { endpointId: 'endpoint-test' },
    {
      keyReader: () => 'secret',
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://rest.runpod.io/v1/endpoints/endpoint-test');
        if (options.method === 'PATCH') {
          const b = JSON.parse(options.body);
          assert.deepEqual(Object.keys(b), ['workersMin']);
          min = b.workersMin;
        }
        return new Response(
          JSON.stringify({ workersMin: min, workersMax: 1, env: { secret: 'must-not-leak' } })
        );
      },
    }
  );
  assert.deepEqual(await remote.sessionSettings(1), { workersMin: 1, workersMax: 1 });
  assert.deepEqual(await remote.sessionSettings(0), { workersMin: 0, workersMax: 1 });
});
