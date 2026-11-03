// @codedna
// description: User-confirmed, checksum-verified download of the YuE2 GGUF model files for yue2.cpp into a folder the user chooses.
//
// exports: createYue2Models | YUE2_FILES | YUE2_REVISION
// used_by: server.mjs
// rules:   Only the fixed files of the pinned Hugging Face revision are downloaded; never a user-provided URL, never over an existing file; every file is checked against the SHA-256 of the manifest before it is kept.
// agent:   claude-haiku-5-5 | anthropic | 2026-11-03 | Setup helper for the portable build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const REPOSITORY = 'Serveurperso/YuE2-GGUF';
// the same revision as integrations/runpod/yue2_cpp_build.sh, so a PC and a RunPod volume get identical files
export const YUE2_REVISION = 'e630f2b8f6aedf8254c3186438633c1b5eeaf80a';
export const YUE2_FILES = [
  { name: 'YuE2-3B-Q8_0.gguf', setting: 'model', covers: false },
  { name: 'YuE2-Vae-F32.gguf', setting: 'vae', covers: false },
  { name: 'SheetSage2-Q8_0.gguf', setting: 'transcriber', covers: true },
  { name: 'MERT-v2-FullSong-Q8_0.gguf', setting: 'mert', covers: true },
];

function trusted(response, url) {
  const host = new URL(response.url || url);
  if (
    host.protocol !== 'https:' ||
    !(
      host.hostname === 'huggingface.co' ||
      host.hostname.endsWith('.huggingface.co') ||
      host.hostname.endsWith('.hf.co')
    )
  )
    throw new Error('The model download redirected to an untrusted host.');
}

export function createYue2Models({
  onChange = () => {},
  fetchImpl = globalThis.fetch,
  repository = REPOSITORY,
  revision = YUE2_REVISION,
  files = YUE2_FILES,
} = {}) {
  let current = { status: 'idle', message: 'Choose a folder for the YuE2 model files.' };
  let controller = null;
  const manifestUrl = `https://huggingface.co/api/models/${repository}/tree/${revision}?recursive=true&expand=true`;
  const update = next => {
    current = { ...current, ...next, updatedAt: new Date().toISOString() };
    onChange(snapshot());
  };
  const snapshot = () => ({ ...current });

  async function folder(input, { create = false } = {}) {
    if (
      typeof input !== 'string' ||
      !input.trim() ||
      !path.isAbsolute(input.trim()) ||
      input.length > 500 ||
      input.includes('\0')
    )
      throw new Error('Enter the full path of a folder on this computer for the model files.');
    const target = path.resolve(input.trim());
    if (create) await fs.promises.mkdir(target, { recursive: true });
    const stat = await fs.promises.lstat(target).catch(() => null);
    if (!stat) return target; // not created yet: nothing to check
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('The model folder must be a normal folder.');
    return target;
  }

  async function manifest() {
    const response = await fetchImpl(manifestUrl, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    trusted(response, manifestUrl);
    if (!response.ok) throw new Error(`Could not read the YuE2 file list (HTTP ${response.status}).`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('The YuE2 file list is not valid.');
    return files.map(file => {
      const found = entries.find(entry => entry.path === file.name);
      const sha256 = String(found?.lfs?.oid || '').replace(/^sha256:/, '');
      if (!found || !Number.isSafeInteger(found.size) || found.size <= 0 || !/^[a-f0-9]{64}$/i.test(sha256))
        throw new Error(`The official list is missing verified details for ${file.name}.`);
      return { ...file, size: found.size, sha256: sha256.toLowerCase() };
    });
  }

  /** What is already in the folder and what is missing; `covers` adds the optional cover-transcription files. */
  async function inspect(input, { covers = false } = {}) {
    const dir = await folder(input);
    const details = (await manifest()).filter(file => covers || !file.covers);
    const entries = [];
    for (const item of details) {
      let status = 'missing';
      try {
        const stat = await fs.promises.lstat(path.join(dir, item.name));
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error(`Refusing to use an unsafe path: ${item.name}.`);
        status = stat.size === item.size ? 'present' : 'mismatch';
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      entries.push({
        name: item.name,
        setting: item.setting,
        bytes: item.size,
        status,
        path: path.join(dir, item.name),
      });
    }
    const wrong = entries.find(entry => entry.status === 'mismatch');
    if (wrong)
      throw new Error(
        `${wrong.name} already exists but its size does not match the official file. It was left untouched.`
      );
    const missing = entries.filter(entry => entry.status === 'missing');
    const totalBytes = missing.reduce((sum, entry) => sum + entry.bytes, 0);
    update({
      status: missing.length ? 'checked' : 'ready',
      dir,
      files: entries,
      totalBytes,
      message: missing.length
        ? `${missing.length} file(s) are missing (${(totalBytes / 1_000_000_000).toFixed(1)} GB to download).`
        : 'All the YuE2 model files are present.',
    });
    return { dir, files: entries, totalBytes };
  }

  async function download({ dir: input, covers = false, confirmed } = {}) {
    if (confirmed !== true) throw new Error('Confirm the model download before it starts.');
    if (controller) throw new Error('A YuE2 model download is already running.');
    controller = new AbortController();
    const signal = controller.signal;
    let completed = 0;
    try {
      await folder(input, { create: true });
      const plan = await inspect(input, { covers });
      const missing = plan.files.filter(file => file.status === 'missing');
      if (!missing.length) return { ...plan, downloaded: 0 };
      const details = await manifest();
      update({
        status: 'downloading',
        message: `Downloading ${missing.length} file(s)…`,
        activeFile: null,
        completedBytes: 0,
      });
      for (const entry of missing) {
        if (signal.aborted) throw new Error('Model download cancelled.');
        const item = details.find(file => file.name === entry.name);
        const target = path.join(plan.dir, entry.name);
        const partial = target + '.sonora-part';
        if (await fs.promises.lstat(target).catch(() => null))
          throw new Error(`${entry.name} appeared during setup. It was left untouched.`);
        const partialStat = await fs.promises.lstat(partial).catch(() => null);
        if (partialStat && (partialStat.isSymbolicLink() || !partialStat.isFile()))
          throw new Error(`Refusing to use an unsafe path: ${entry.name}.part.`);
        let start = partialStat && partialStat.size <= item.size ? partialStat.size : 0;
        if (partialStat && !start) await fs.promises.unlink(partial);
        let hash = crypto.createHash('sha256');
        if (start) for await (const chunk of fs.createReadStream(partial)) hash.update(chunk);
        const url = `https://huggingface.co/${repository}/resolve/${revision}/${encodeURIComponent(item.name)}?download=true`;
        const response = await fetchImpl(url, {
          headers: start ? { Range: `bytes=${start}-` } : {},
          redirect: 'follow',
          signal,
        });
        trusted(response, url);
        if (start && response.status === 200) {
          await fs.promises.unlink(partial);
          start = 0;
          hash = crypto.createHash('sha256');
        }
        if (!(response.ok && (!start || response.status === 206)) || !response.body)
          throw new Error(`Could not download ${entry.name} (HTTP ${response.status}).`);
        let received = start;
        update({
          activeFile: entry.name,
          fileBytes: received,
          fileTotal: item.size,
          completedBytes: completed + received,
          message: `Downloading ${entry.name}…`,
        });
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            received += chunk.length;
            update({
              fileBytes: received,
              completedBytes: completed + received,
              activeFile: entry.name,
              fileTotal: item.size,
            });
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body),
          meter,
          fs.createWriteStream(partial, { flags: start ? 'a' : 'w', mode: 0o600 }),
          { signal }
        );
        const size = (await fs.promises.stat(partial)).size;
        if (size !== item.size || hash.digest('hex') !== item.sha256) {
          await fs.promises.unlink(partial).catch(() => {});
          throw new Error(`Integrity check failed for ${entry.name}; the incomplete file was removed.`);
        }
        await fs.promises.link(partial, target);
        await fs.promises.unlink(partial);
        completed += item.size;
        update({ completedBytes: completed, activeFile: null, fileBytes: 0, fileTotal: 0 });
      }
      const done = {
        ...plan,
        files: plan.files.map(file => ({ ...file, status: 'present' })),
        totalBytes: 0,
      };
      update({
        ...done,
        status: 'ready',
        message: 'YuE2 model files downloaded and verified.',
        completedBytes: completed,
        activeFile: null,
      });
      return { ...done, downloaded: missing.length };
    } catch (error) {
      const cancelled = signal.aborted;
      update({
        status: cancelled ? 'cancelled' : 'error',
        message: cancelled ? 'Download cancelled. A partial file is resumed on retry.' : error.message,
        activeFile: null,
      });
      throw error;
    } finally {
      controller = null;
    }
  }

  function cancel() {
    if (!controller) return false;
    controller.abort();
    return true;
  }

  return { snapshot, inspect, download, cancel };
}
