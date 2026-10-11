import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStudio } from '../server.mjs';

const call = (url, method = 'GET', body) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      target,
      {
        method,
        agent: false,
        headers: {
          Host: target.host,
          Origin: target.origin,
          'X-Sonora': '1',
          'Content-Type': 'application/json',
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      }
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

test('workspaces: create, rename, reject duplicates, protect General, move songs home on delete', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-workspaces-'));
  const jobId = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(
    path.join(dataDir, 'library.json'),
    JSON.stringify({
      version: 1,
      jobs: [{ id: jobId, title: 'Prova', status: 'done', input: { instrumental: true } }],
    })
  );
  const app = createStudio(
    { comfyUrl: 'http://127.0.0.1:1', model: 'm', encoder: 'e', vae: 'v' },
    { dataDir, pollMs: 3600000 }
  );
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let state = (await call(base + '/api/state')).body;
  assert.deepEqual(
    state.workspaces.map(w => w.name),
    ['General']
  );
  const made = await call(base + '/api/workspaces', 'POST', { name: 'Album rock' });
  assert.equal(made.status, 201);
  assert.equal((await call(base + '/api/workspaces', 'POST', { name: 'album ROCK' })).status, 400);
  assert.equal(
    (await call(base + '/api/workspaces/' + made.body.id, 'PATCH', { name: 'Rock 2026' })).status,
    200
  );
  assert.equal((await call(base + '/api/jobs/' + jobId, 'PATCH', { workspaceId: made.body.id })).status, 200);
  assert.equal((await call(base + '/api/jobs/' + jobId, 'PATCH', { workspaceId: 'nope' })).status, 400);
  state = (await call(base + '/api/state')).body;
  assert.equal(state.jobs[0].workspaceId, made.body.id);
  assert.equal((await call(base + '/api/workspaces/general', 'DELETE')).status, 400);
  assert.equal((await call(base + '/api/workspaces/' + made.body.id, 'DELETE')).status, 200);
  state = (await call(base + '/api/state')).body;
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].workspaceId, 'general');
  assert.deepEqual(
    state.workspaces.map(w => w.name),
    ['General']
  );
});
