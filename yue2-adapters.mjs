// @codedna
// description: The YuE2 LoRA catalogue (yue2-adapters.json): which are installed for yue2.cpp, download and removal.
//
// exports: loadCatalog | createYue2Adapters
// used_by: server.mjs
// related: yue2-cpp.mjs — the engine reads every folder of `dir` at start, so a new or removed LoRA needs an engine restart
// rules:   Only catalogue entries are ever downloaded, from their pinned Hugging Face commit, each file checked by its size; a folder is named after the catalogue id
//          (the name the engine knows it by) and is complete only when every file is there. Downloads land as .part and are renamed at the end.
// agent:   claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_cpp | Created with the catalogue ported from YuE2-Studio (MIT), descriptions in Italian.
// Codex | openai | 2026-10-15 | Keep trained RunPod adapters out of local install state.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'yue2-adapters.json');
export const loadCatalog = (file = CATALOG) => JSON.parse(fs.readFileSync(file, 'utf8')).adapters;

/**
 * @param options { dir, catalog?, fetchImpl?, onChange? } — onChange() is called when a LoRA is installed or removed
 */
export function createYue2Adapters({
  dir,
  catalog: shipped = loadCatalog(),
  extra = () => [],
  fetchImpl = fetch,
  onChange = () => {},
} = {}) {
  // Rules: `extra` are the user's own trained LoRA (no files to download: they live on the RunPod volume)
  const all = () => [...shipped, ...extra()];
  const downloads = new Map(); // id -> { done, total, error }
  const entry = id => {
    const found = all().find(a => a.id === id);
    if (!found) throw new Error('Unknown LoRA.');
    return found;
  };
  const installed = a =>
    !!dir &&
    a.files.every(f => {
      try {
        return fs.statSync(path.join(dir, a.id, f.file)).size === f.bytes;
      } catch {
        return false;
      }
    });

  async function download(a) {
    const state = { done: 0, total: a.files.reduce((s, f) => s + f.bytes, 0), error: null };
    downloads.set(a.id, state);
    try {
      const folder = path.join(dir, a.id);
      fs.mkdirSync(folder, { recursive: true });
      for (const f of a.files) {
        const target = path.join(folder, f.file);
        if (fs.existsSync(target) && fs.statSync(target).size === f.bytes) {
          state.done += f.bytes;
          continue;
        }
        const response = await fetchImpl(f.url, { redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
        const before = state.done;
        const body = Readable.fromWeb(response.body);
        body.on('data', chunk => (state.done += chunk.length));
        await pipeline(body, fs.createWriteStream(target + '.part'));
        if (fs.statSync(target + '.part').size !== f.bytes) {
          fs.rmSync(target + '.part', { force: true });
          state.done = before;
          throw new Error('The downloaded file does not have the expected size.');
        }
        fs.renameSync(target + '.part', target);
      }
      downloads.delete(a.id);
      onChange();
    } catch (error) {
      state.error = error.message;
    }
  }

  return {
    available: !!dir,
    /** The catalogue with what is installed and what is downloading. */
    list() {
      return all().map(a => {
        const d = downloads.get(a.id);
        return {
          ...a,
          bytes: a.files.reduce((s, f) => s + f.bytes, 0),
          installed: !a.trained && installed(a),
          ...(d
            ? {
                downloading: !d.error,
                progress: d.total ? Math.round((100 * d.done) / d.total) : 0,
                error: d.error,
              }
            : {}),
          files: undefined,
        };
      });
    },
    isInstalled: id => installed(entry(id)),
    entry,
    /** Start the download in the background; the list shows its progress. */
    install(id) {
      if (!dir) throw new Error('YuE2 LoRAs work with yue2.cpp on the PC: it is not configured.');
      const a = entry(id);
      if (a.trained) throw new Error('The LoRAs you train live on RunPod: for now they are only used there.');
      if (installed(a)) return { installed: true };
      if (downloads.get(id) && !downloads.get(id).error) return { downloading: true };
      download(a);
      return { downloading: true };
    },
    remove(id) {
      const a = entry(id);
      if (downloads.get(id) && !downloads.get(id).error) throw new Error('Wait for the download to finish.');
      downloads.delete(id);
      fs.rmSync(path.join(dir, a.id), { recursive: true, force: true });
      onChange();
      return { removed: true };
    },
  };
}
