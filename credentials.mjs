// @codedna
// description: Authenticated credential encryption for Linux and portable deployments.
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
// 
//
// 
//
// exports: createFileProtector
// used_by: sonora-studio/prompt-ai.mjs
//                   sonora-studio/provider-secrets.mjs
// rules:   Keep the master key server-side with owner-only permissions; reject tampered ciphertext.
// agent:   Codex - 2026-10-05 - VPS credential storage.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function createFileProtector(keyFile) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyFile)) {
    try {
      fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  if (process.platform !== 'win32') fs.chmodSync(keyFile, 0o600);
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('Invalid server encryption key.');
  return {
    scheme: 'aes-256-gcm-v1',
    protect(text) {
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    unprotect(value) {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length < 28) throw new Error('Invalid encrypted credential.');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
