// @codedna
// description: Saved prompts (style, optional lyrics and chosen options) kept on the server so every device sees the same list.
//
// 
//
// 
//
// 
//
// exports: PROMPT_LIMIT | createPromptStore
// used_by: sonora-studio/server.mjs
// rules:   Every write goes through a .tmp file and a rename. Validate lengths and the options whitelist: a saved prompt is plain data and is never executed or interpolated into paths.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-10 | s_20261010_crea | Created for the "Crea musica" reorganisation (saved prompts).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROMPT_LIMIT = 200;
const OPTION_KEYS = {
  language: v => typeof v === 'string' && v.length <= 10,
  vocal: v => typeof v === 'string' && v.length <= 10,
  instrumental: v => typeof v === 'boolean',
  bpm: v => Number.isInteger(v) && v >= 30 && v <= 250,
  keyscale: v => typeof v === 'string' && v.length <= 20,
  timesignature: v => typeof v === 'string' && v.length <= 1,
  finish: v => v === 'fast' || v === 'final',
  quality: v => v === 'light' || v === 'full',
  guidance: v => typeof v === 'number' && v >= 1 && v <= 5,
  creativity: v => typeof v === 'number' && v >= 0.5 && v <= 1.3,
  avoid: v => typeof v === 'string' && v.length <= 500,
  autoMeta: v =>
    Array.isArray(v) && v.length <= 3 && v.every(x => ['bpm', 'keyscale', 'timesignature'].includes(x)),
};

export function createPromptStore({ dataDir, onChange = () => {} }) {
  const file = path.join(dataDir, 'prompts.json');
  let items = [];
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.items)) items = saved.items;
    } catch {
      throw new Error('prompts.json is unreadable. Restore a backup without overwriting it.');
    }
  }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, items }, null, 2));
    fs.renameSync(file + '.tmp', file);
    onChange();
  };
  const text = (value, label, max, required = false) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string' || value.length > max)
      throw new Error(`${label}: maximum ${max} characters.`);
    value = value.trim();
    if (required && !value) throw new Error(`${label}: required field.`);
    return value;
  };
  function clean(body, previous = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
    const pick = (key, fallback) => (body[key] === undefined ? fallback : body[key]);
    const options = {};
    const rawOptions = pick('options', previous.options || {});
    if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
      throw new Error('Invalid options.');
    for (const [key, value] of Object.entries(rawOptions)) {
      if (!Object.hasOwn(OPTION_KEYS, key)) continue;
      if (!OPTION_KEYS[key](value)) throw new Error(`Invalid ${key} option.`);
      options[key] = value;
    }
    return {
      name: text(pick('name', previous.name), 'Name', 70, true),
      tags: text(pick('tags', previous.tags), 'Style', 3000, true),
      lyrics: text(pick('lyrics', previous.lyrics), 'Lyrics', 12000),
      label: text(pick('label', previous.label), 'Label', 30),
      options,
    };
  }
  const find = id => {
    const item = items.find(p => p.id === id);
    if (!item) throw new Error('Prompt was not found.');
    return item;
  };
  return {
    list: () => [...items].sort((a, b) => (b.usedAt || b.createdAt).localeCompare(a.usedAt || a.createdAt)),
    create(body) {
      if (items.length >= PROMPT_LIMIT)
        throw new Error(`You have reached the ${PROMPT_LIMIT} saved prompt limit. Delete one before adding another.`);
      const now = new Date().toISOString();
      const item = { id: randomUUID(), ...clean(body), createdAt: now, usedAt: null };
      items.push(item);
      save();
      return item;
    },
    update(id, body) {
      const item = find(id);
      Object.assign(item, clean(body, item));
      if (body.used === true) item.usedAt = new Date().toISOString();
      save();
      return item;
    },
    remove(id) {
      find(id);
      items = items.filter(p => p.id !== id);
      save();
      return { ok: true };
    },
    /** Import a list exported earlier: invalid entries are skipped, the limit is respected. Returns how many were added. */
    importMany(list) {
      if (!Array.isArray(list)) throw new Error('Invalid prompt file.');
      let added = 0;
      for (const entry of list.slice(0, PROMPT_LIMIT)) {
        if (items.length >= PROMPT_LIMIT) break;
        try {
          const item = {
            id: randomUUID(),
            ...clean(entry),
            createdAt: new Date().toISOString(),
            usedAt: null,
          };
          if (items.some(p => p.name === item.name && p.tags === item.tags && p.lyrics === item.lyrics))
            continue;
          items.push(item);
          added++;
        } catch {}
      }
      if (added) save();
      return { added };
    },
  };
}
