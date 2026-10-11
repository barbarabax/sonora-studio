// @codedna
// description: Encrypted local storage for user-owned GPU provider API keys.
// 
//
// 
//
// 
//
// 
//
// 
//
// exports: createProviderSecrets
// used_by: sonora-studio/gpu-session-watchdog.mjs
//                   sonora-studio/server.mjs
// rules:   Never return secret values to the browser; write credentials atomically with owner-only permissions.
// agent:   Codex - 2026-10-10 - Added local provider credential storage for the portfolio edition.
import fs from 'node:fs';
import path from 'node:path';
import { createFileProtector } from './credentials.mjs';

const PROVIDERS = new Set(['runpod', 'vast']);

export function createProviderSecrets({ dataDir, protector } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A local data directory is required.');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'provider-secrets.json');
  const cipher =
    protector ||
    createFileProtector(process.env.SONORA_SECRET_FILE || path.join(dataDir, '.credential-key'));

  function read() {
    if (!fs.existsSync(file)) return {};
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function providerName(provider) {
    if (!PROVIDERS.has(provider)) throw new Error('Unsupported provider.');
    return provider;
  }

  return {
    get(provider) {
      const record = read()[providerName(provider)];
      if (!record || record.scheme !== cipher.scheme || typeof record.encrypted !== 'string') return null;
      return cipher.unprotect(record.encrypted);
    },
    set(provider, value) {
      providerName(provider);
      if (typeof value !== 'string' || value.length < 16 || value.length > 2048 || /\s/.test(value))
        throw new Error('Enter a valid API key.');
      const records = read();
      records[provider] = { scheme: cipher.scheme, encrypted: cipher.protect(value) };
      fs.writeFileSync(file + '.tmp', JSON.stringify(records), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      return true;
    },
    remove(provider) {
      const name = providerName(provider);
      const records = read();
      delete records[name];
      fs.writeFileSync(file + '.tmp', JSON.stringify(records), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      return true;
    },
  };
}
