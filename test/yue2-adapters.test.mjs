// @codedna
// description: YuE2 LoRA: the catalogue, a checked download, removal, and the request fields (validation, strengths, trigger words).
// exports: none
// used_by: none
// rules:   No network: downloads come from a fake fetch.
// agent:   claude-opus-5-5 - 2026-10-15 - Created with yue2-adapters.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createYue2Adapters, loadCatalog } from '../yue2-adapters.mjs';
import { validateInput } from '../lib.mjs';

test('the shipped catalogue is pinned, credited and in Italian', () => {
  const catalog = loadCatalog();
  assert.ok(catalog.length >= 30);
  for (const a of catalog) {
    assert.match(a.id, /^[a-z0-9-]+$/);
    assert.ok(a.name && a.description && a.author && a.page.startsWith('https://huggingface.co/'));
    for (const f of a.files) {
      assert.match(
        f.url,
        /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//,
        'every file is pinned to a commit'
      );
      assert.ok(Number.isInteger(f.bytes) && f.bytes > 0);
    }
  }
  assert.equal(catalog.find(a => a.id === 'yue2-canzone-italiana').trigger, 'cnzn');
});

test('a LoRA is downloaded, checked by size, listed and removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-lora-'));
  const catalog = [
    {
      id: 'demo',
      kind: 'Stile',
      name: 'Demo',
      description: 'd',
      author: 'x',
      page: 'https://huggingface.co/x/y',
      scales: { ar: 1, nar: 0.5 },
      files: [
        { url: 'https://huggingface.co/x/y/resolve/0/a.safetensors', file: 'a.safetensors', bytes: 10 },
      ],
    },
    {
      id: 'short',
      kind: 'Stile',
      name: 'Short',
      description: 'd',
      author: 'x',
      page: 'https://huggingface.co/x/y',
      scales: { ar: 1, nar: 0 },
      files: [
        { url: 'https://huggingface.co/x/y/resolve/0/b.safetensors', file: 'b.safetensors', bytes: 99 },
      ],
    },
  ];
  let changes = 0;
  const lora = createYue2Adapters({
    dir,
    catalog,
    fetchImpl: async () => new Response(Buffer.alloc(10, 1)),
    onChange: () => changes++,
  });
  assert.equal(lora.list().find(a => a.id === 'demo').installed, false);
  lora.install('demo');
  for (let i = 0; i < 50 && !lora.isInstalled('demo'); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(lora.isInstalled('demo'), true);
  assert.equal(changes, 1, 'the engine is told to reload');
  // a file of the wrong size is refused and not kept
  lora.install('short');
  for (let i = 0; i < 50 && !lora.list().find(a => a.id === 'short').error; i++)
    await new Promise(r => setTimeout(r, 20));
  assert.match(lora.list().find(a => a.id === 'short').error, /The downloaded file does/);
  assert.ok(!fs.existsSync(path.join(dir, 'short', 'b.safetensors')));
  assert.throws(() => lora.install('../etc'), /Unknown LoRA\./);
  lora.remove('demo');
  assert.equal(lora.isInstalled('demo'), false);
  assert.equal(changes, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('YuE2 LoRA in a request: at most 4, strengths between -10 and 10', () => {
  const base = { musicModel: 'yue2', tags: 'ballad', lyrics: '[Verse]\nCiao' };
  assert.deepEqual(
    validateInput({ ...base, yueAdapters: [{ id: 'yue2-canzone-italiana', ar: 1, nar: 0.5 }] }).yueAdapters,
    [{ id: 'yue2-canzone-italiana', ar: 1, nar: 0.5 }]
  );
  assert.equal(validateInput({ ...base, yueAdapters: [] }).yueAdapters, undefined);
  assert.throws(() => validateInput({ ...base, yueAdapters: [{ id: '../x', ar: 1, nar: 1 }] }), /LoRA/);
  assert.throws(() => validateInput({ ...base, yueAdapters: [{ id: 'a', ar: 11, nar: 1 }] }), /LoRA/);
  assert.throws(
    () =>
      validateInput({
        ...base,
        yueAdapters: [
          { id: 'a', ar: 1, nar: 1 },
          { id: 'a', ar: 1, nar: 1 },
        ],
      }),
    /LoRA/
  );
  assert.throws(
    () => validateInput({ ...base, yueAdapters: 'a,b,c,d,e'.split(',').map(id => ({ id, ar: 1, nar: 1 })) }),
    /LoRA/
  );
});

test('chords and sections: validated, turned into the engine field, sections read from the lyrics tags', async () => {
  const { harmonyField, lyricSections } = await import('../lib.mjs');
  const base = {
    musicModel: 'yue2',
    tags: 'ballad',
    lyrics: '[Intro]\n[Verse 1]\nwalking down\n[Hook]\nall the lights\n[Outro]',
  };
  assert.deepEqual(lyricSections(base.lyrics), ['intro', 'verse', 'chorus', 'outro']);
  assert.deepEqual(lyricSections('words before a tag\n[Pre Chorus]\nx\n[Strange part]\ny'), [
    'verse',
    'pre-chorus',
    'verse',
  ]);
  const input = validateInput({
    ...base,
    yueHarmony: { strength: 4, identity: 'spelling', sectionStrength: 8, follow: true },
  });
  assert.deepEqual(harmonyField(input.yueHarmony, input.lyrics), {
    identity: 'spelling',
    strength: 4,
    section_strength: 8,
    follow: ['intro', 'verse', 'chorus', 'outro'],
  });
  assert.equal(
    validateInput({ ...base, yueHarmony: { strength: 0 } }).yueHarmony,
    undefined,
    'all at rest is nothing'
  );
  assert.throws(() => validateInput({ ...base, yueHarmony: { strength: 99 } }), /Invalid chord settings\./);
  assert.throws(
    () => validateInput({ ...base, yueHarmony: { identity: 'chord', strength: 2 } }),
    /Invalid chord settings\./
  );
  assert.equal(lyricSections('').length, 0);
  assert.throws(() => harmonyField({ follow: true }, ''), /tag/);
});
