// @codedna
// description: User-confirmed, checksum-verified ACE-Step model downloads into an explicitly selected ComfyUI model folder.
// 
//
// 
//
// exports: createModelSetup | ACE_STEP_FILES
// used_by: sonora-studio/server.mjs
// rules:   Download only fixed official model files; never follow a user-provided URL or overwrite an existing model.
// agent:   Codex - 2026-10-10 - Local ACE-Step model setup.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

const REPOSITORY = 'Comfy-Org/ace_step_1.5_ComfyUI_files';
const BASE = `https://huggingface.co/${REPOSITORY}`;
const FILES = [
  { path: 'split_files/diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors', category: 'diffusion_models', setting: 'model' },
  { path: 'split_files/text_encoders/qwen_0.6b_ace15.safetensors', category: 'text_encoders', setting: 'encoder' },
  { path: 'split_files/text_encoders/qwen_4b_ace15.safetensors', category: 'text_encoders', setting: 'planner' },
  { path: 'split_files/vae/ace_1.5_vae.safetensors', category: 'vae', setting: 'vae' },
];

function validateResponseUrl(response, expectedHost = 'huggingface.co', fallback = BASE) {
  const url = new URL(response.url || fallback);
  const trustedHost =
    url.hostname === expectedHost ||
    url.hostname.endsWith(`.${expectedHost}`) ||
    (expectedHost === 'huggingface.co' && url.hostname.endsWith('.hf.co'));
  if (
    url.protocol !== 'https:' ||
    !trustedHost
  )
    throw new Error('The model download redirected to an untrusted host.');
}

async function checkedDirectory(target, { create = false } = {}) {
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Symbolic links are not allowed in the model path.');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await fs.promises.mkdir(target);
  }
}

export function createModelSetup({
  onChange = () => {},
  fetchImpl = globalThis.fetch,
  files = FILES,
  base = BASE,
  manifestUrl = `https://huggingface.co/api/models/${REPOSITORY}/tree/main?recursive=true&expand=true`,
} = {}) {
  let current = { status: 'idle', message: 'Choose a ComfyUI folder to check its models.' };
  let controller = null;

  const update = next => {
    current = { ...current, ...next, updatedAt: new Date().toISOString() };
    onChange(snapshot());
  };

  function snapshot() {
    return { ...current };
  }

  async function validateRoot(input) {
    if (typeof input !== 'string' || !input.trim() || !path.isAbsolute(input.trim()))
      throw new Error(
        'Enter the full path to the ComfyUI folder that contains main.py (for ComfyUI Desktop: the base folder that contains its models folder).'
      );
    const root = await fs.promises.realpath(input.trim()).catch(() => {
      throw new Error('ComfyUI folder not found. Check the full path and try again.');
    });
    const main = path.join(root, 'main.py');
    const stat = await fs.promises.lstat(main).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return root;
    // Rules: ComfyUI Desktop keeps its program and its data apart: the base folder the user chose holds `models` but no main.py.
    const models = await fs.promises.lstat(path.join(root, 'models')).catch(() => null);
    if (models?.isDirectory() && !models.isSymbolicLink()) return root;
    throw new Error(
      'The selected folder must contain the ComfyUI main.py file, or (ComfyUI Desktop) be the base folder that contains the models folder.'
    );
  }

  async function metadata() {
    const response = await fetchImpl(manifestUrl, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    validateResponseUrl(response, 'huggingface.co', manifestUrl);
    if (!response.ok) throw new Error(`Could not read the ACE-Step file manifest (HTTP ${response.status}).`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('The ACE-Step file manifest is not valid.');
    return files.map(file => {
      const found = entries.find(entry => entry.path === file.path);
      const sha256 = String(found?.lfs?.oid || found?.oid || '').replace(/^sha256:/, '');
      if (!found || !Number.isSafeInteger(found.size) || found.size <= 0 || !/^[a-f0-9]{64}$/i.test(sha256))
        throw new Error(`The official manifest is missing verified details for ${path.basename(file.path)}.`);
      return { ...file, size: found.size, sha256: sha256.toLowerCase() };
    });
  }

  /**
   * `names` are the file names from the config (a sub-folder or a full path in front of the name is ignored: only the file name
   * matters on disk). `seen` marks the settings ComfyUI already lists, wherever the file is (sub-folders, extra_model_paths.yaml):
   * those count as present and are never downloaded again.
   */
  async function inspect(input, names = {}, seen = {}) {
    const root = await validateRoot(input);
    const files = await metadata();
    const modelsDir = path.join(root, 'models');
    try {
      await checkedDirectory(modelsDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const entries = [];
    for (const item of files) {
      const category = item.category || item.path.split('/').at(-2);
      const categoryDir = path.join(modelsDir, category);
      try {
        await checkedDirectory(categoryDir);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const name = String(names[item.setting] || path.basename(item.path)).split(/[\\/]/).pop();
      if (name !== path.basename(name) || !name.endsWith('.safetensors'))
        throw new Error('Custom model names must be safe .safetensors filenames.');
      if (seen[item.setting]) {
        entries.push({ name, category, bytes: item.size, status: 'present', remotePath: item.path, listedByComfyui: true });
        continue;
      }
      const target = path.join(modelsDir, category, name);
      let state = 'missing';
      try {
        const stat = await fs.promises.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to replace an unsafe model path: ${name}.`);
        if (stat.size !== item.size)
          throw new Error(`${name} already exists but its size does not match the official model. It was left untouched.`);
        state = 'present';
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      entries.push({ name, category, bytes: item.size, status: state, remotePath: item.path });
    }
    const missing = entries.filter(entry => entry.status === 'missing');
    const totalBytes = missing.reduce((sum, entry) => sum + entry.bytes, 0);
    update({
      status: missing.length ? 'checked' : 'ready',
      root,
      files: entries,
      totalBytes,
      message: missing.length
        ? `${missing.length} model file(s) are missing (${(totalBytes / 1_000_000_000).toFixed(1)} GB to download). Keep at least 22 GB free for the complete ACE-Step XL package.`
        : 'All four ACE-Step model files are present.',
    });
    return { root, files: entries, totalBytes };
  }

  async function download({ root: input, names = {}, seen = {}, confirmed } = {}) {
    if (confirmed !== true) throw new Error('Confirm the large model download before it starts.');
    if (controller) throw new Error('An ACE-Step model download is already running.');
    controller = new AbortController();
    const signal = controller.signal;
    let completed = 0;
    try {
      const plan = await inspect(input, names, seen);
      const missing = plan.files.filter(file => file.status === 'missing');
      if (!missing.length) {
        controller = null;
        return { ...plan, downloaded: 0 };
      }
      update({ status: 'downloading', message: `Downloading ${missing.length} missing model file(s)…`, activeFile: null, completedBytes: 0 });
      const details = await metadata();
      for (const entry of missing) {
        if (signal.aborted) throw new Error('Model download cancelled.');
        const item = details.find(file => file.path === entry.remotePath);
        if (!item) throw new Error(`Could not resolve official model metadata for ${entry.name}.`);
        const targetDir = path.join(plan.root, 'models', entry.category);
        const modelsDir = path.join(plan.root, 'models');
        await checkedDirectory(modelsDir, { create: true });
        await checkedDirectory(targetDir, { create: true });
        const target = path.join(targetDir, entry.name);
        const partial = target + '.sonora-part';
        for (const filePath of [target, partial]) {
          try {
            const stat = await fs.promises.lstat(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing to use an unsafe model path: ${path.basename(filePath)}.`);
            if (filePath === target)
              throw new Error(`${entry.name} appeared during setup. It was left untouched; check the files again.`);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const offset = (await fs.promises.stat(partial).catch(() => ({ size: 0 }))).size;
        if (offset > item.size) await fs.promises.unlink(partial);
        let start = offset > item.size ? 0 : offset;
        let hash = crypto.createHash('sha256');
        if (start) for await (const chunk of fs.createReadStream(partial)) hash.update(chunk);
        const headers = start ? { Range: `bytes=${start}-` } : {};
        const url = `${base}/resolve/main/${item.path.split('/').map(encodeURIComponent).join('/')}?download=true`;
        let response = await fetchImpl(url, { headers, redirect: 'follow', signal });
        validateResponseUrl(response, 'huggingface.co', url);
        if (start && response.status === 200) {
          await fs.promises.unlink(partial);
          start = 0;
          hash = crypto.createHash('sha256');
        }
        if (!(response.ok && (!start || response.status === 206)) || !response.body)
          throw new Error(`Could not download ${entry.name} (HTTP ${response.status}).`);
        if (start && !String(response.headers.get('content-range') || '').startsWith(`bytes ${start}-`))
          throw new Error(`The model host returned an invalid resume range for ${entry.name}.`);
        const downloaded = start;
        update({ activeFile: entry.name, fileBytes: downloaded, fileTotal: item.size, completedBytes: completed + downloaded, message: `Downloading ${entry.name}…` });
        let received = downloaded;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            received += chunk.length;
            const fileBytes = received;
            update({ fileBytes, completedBytes: completed + fileBytes, activeFile: entry.name, fileTotal: item.size });
            callback(null, chunk);
          },
        });
        const out = fs.createWriteStream(partial, { flags: start ? 'a' : 'w', mode: 0o600 });
        await pipeline(Readable.fromWeb(response.body), meter, out, { signal });
        const finalSize = (await fs.promises.stat(partial)).size;
        const digest = hash.digest('hex');
        if (finalSize !== item.size || digest !== item.sha256) {
          await fs.promises.unlink(partial).catch(() => {});
          throw new Error(`Integrity check failed for ${entry.name}; the incomplete file was removed.`);
        }
        await fs.promises.link(partial, target);
        await fs.promises.unlink(partial);
        completed += item.size;
        update({ completedBytes: completed, activeFile: null, fileBytes: 0, fileTotal: 0 });
      }
      const finalPlan = {
        ...plan,
        files: plan.files.map(file => ({ ...file, status: 'present' })),
        totalBytes: 0,
      };
      update({ ...finalPlan, status: 'ready', message: 'ACE-Step models downloaded and verified. If ComfyUI still reports missing models, restart ComfyUI manually.', completedBytes: completed, activeFile: null });
      return { ...finalPlan, downloaded: missing.length };
    } catch (error) {
      const cancelled = signal.aborted;
      update({ status: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Model download cancelled. A partial file may be resumed on retry.' : error.message, activeFile: null });
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

  return { snapshot, validateRoot, inspect, download, cancel };
}

export const ACE_STEP_FILES = FILES.map(file => ({ ...file }));
