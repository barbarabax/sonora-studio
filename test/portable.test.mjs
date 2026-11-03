// @codedna
// description: The portable build helpers: which files are packaged and how the Node.js checksum is read.
// exports: none
// used_by: none
// rules:   Pure functions only; no download, no folder is built.
// agent:   claude-haiku-5-5 | anthropic | 2026-11-03 | Created with the portable build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPackage, shasumFor } from '../scripts/make-portable.mjs';

test('the app is packaged without development files, tests and personal config', () => {
  for (const file of [
    'server.mjs',
    'package.json',
    'README.md',
    'LICENSE',
    'public/app.js',
    'integrations/runpod/yue2_worker.py',
    'yue2-adapters.json',
    'Avvia Sonora.cmd',
  ])
    assert.equal(shouldPackage(file), true, file);
  for (const file of [
    'test/lib.test.mjs',
    'scripts/check.mjs',
    '.github/workflows/release.yml',
    'docs/screenshots/create.jpg',
    'config.json',
    '.gitignore',
    'packaging/launcher/Launcher.cs',
    'integrations/runpod/test_yue2_worker.py',
    'audio-tests.mjs',
  ])
    assert.equal(shouldPackage(file), false, file);
});

test('the checksum of a Node.js download is read from SHASUMS256.txt', () => {
  const hash = 'a'.repeat(64);
  const text = `${'b'.repeat(64)}  node-v22.14.0-linux-x64.tar.xz\n${hash}  node-v22.14.0-win-x64.zip\n`;
  assert.equal(shasumFor(text, 'node-v22.14.0-win-x64.zip'), hash);
  assert.equal(shasumFor(text, 'node-v22.14.0-win-arm64.zip'), null);
  assert.equal(shasumFor('not a checksum file', 'x'), null);
});
