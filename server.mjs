// @codedna
// description: Loopback HTTP studio, durable job library, scoped ComfyUI queue bridge, stem editor and Audio Lab.
// exports: createStudio
// used_by: none
// rules:   Keep media paths server-owned and enforce local Host and same-origin mutations.
// agent:   Codex - 2026-10-04 - Initial local studio and recovery implementation.
//          Claude - 2026-10-04 - Audio Lab routes and a CPU lock shared with the editor.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildWorkflow, validateInput, withoutInstrumentalWords, seedsFor, historyFailure, TERMINAL, LANGUAGES, KEYS } from './lib.mjs';
import { createPromptAI } from './prompt-ai.mjs';
import { createAudioEditor } from './audio-editor.mjs';
import { createAudioLab, createCpuLock } from './audio-lab.mjs';
import { probeDuration, excerpt, excerptWindow } from './ai-audio.mjs';
import { createRunpodBackend } from './runpod-backend.mjs';
import { exportWav } from './wav-export.mjs';
import { createGpuSession } from './gpu-session.mjs';
import { createLoraTrainer } from './lora-trainer.mjs';
import { createVastComfyBackend } from './vast-comfy-backend.mjs';
import { createProviderSecrets } from './provider-secrets.mjs';
import { createModelSetup } from './model-setup.mjs';
import { createStems } from './stems.mjs';
import { createPromptStore } from './prompts.mjs';
import { receiveUpload } from './library-upload.mjs';
import { guessMeta } from './public/auto-meta.mjs';
import { audioSeconds, encodeSource, repaintWindow, spliceSection, placeSection } from './audio-remix.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = {
  port: 3210,
  comfyUrl: 'http://127.0.0.1:8188',
  model: 'acestep_v1.5_xl_turbo_bf16.safetensors',
  encoder: 'qwen_0.6b_ace15.safetensors',
  planner: 'qwen_4b_ace15.safetensors',
  vae: 'ace_1.5_vae.safetensors',
};
const PHASES = {
  1: 'Loading model',
  2: 'Loading encoder',
  3: 'Loading audio decoder',
  4: 'Preparing music',
  5: 'Preparing',
  6: 'Preparing audio',
  7: 'Preparing model',
  8: 'Generating audio',
  9: 'Decoding audio',
  10: 'Saving MP3',
  11: 'Saving FLAC',
};

/** The folder ComfyUI was started with (`--base-directory`), when its system stats expose the command line. */
function comfyBaseDirectory(stats) {
  const argv = stats?.system?.argv;
  if (!Array.isArray(argv)) return undefined;
  const index = argv.findIndex(a => typeof a === 'string' && (a === '--base-directory' || a.startsWith('--base-directory=')));
  if (index < 0) return undefined;
  const value = argv[index].includes('=') ? argv[index].split('=').slice(1).join('=') : argv[index + 1];
  return typeof value === 'string' && value && value.length < 500 ? value : undefined;
}
export function createStudio(
  config,
  {
    dataDir = process.env.SONORA_DATA_DIR || path.join(ROOT, 'data'),
    pollMs = 2500,
    audioTask,
    labTask,
    aiFetch,
    aiProtector,
    audioTools = {},
    runpodFetch,
    runpodKeyReader,
    vastFetch,
    vastSpawn,
    modelFetch,
  } = {}
) {
  fs.mkdirSync(dataDir, { recursive: true });
  const providerFile = path.join(dataDir, 'providers.json');
  const savedProviders = fs.existsSync(providerFile)
    ? JSON.parse(fs.readFileSync(providerFile, 'utf8'))
    : {};
  const localUrlValue = savedProviders.comfyUrl || config.comfyUrl || 'http://127.0.0.1:8188';
  let localModelsRoot = typeof savedProviders.comfyRoot === 'string' ? savedProviders.comfyRoot : '';
  const base = new URL(localUrlValue);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('The ComfyUI URL is invalid.');
  let localComfyUrl = base.href.replace(/\/$/, '');
  const providerSecrets = createProviderSecrets({ dataDir });
  const runpodSettings = {
    ...(config.runpod || {}),
    ...(savedProviders.runpod || {}),
    model: config.model,
  };
  const vastSettings = { ...(savedProviders.vast || {}) };
  function saveProviderSettings() {
    const safe = {
      comfyUrl: localComfyUrl,
      comfyRoot: localModelsRoot,
      runpod: {
        endpointId: runpodSettings.endpointId || '',
        modelsReady: runpodSettings.modelsReady === true,
      },
      vast: { instanceId: vastSettings.instanceId || null },
    };
    fs.writeFileSync(providerFile + '.tmp', JSON.stringify(safe, null, 2), { mode: 0o600 });
    fs.renameSync(providerFile + '.tmp', providerFile);
    if (process.platform !== 'win32') fs.chmodSync(providerFile, 0o600);
  }
  const publicOrigin = config.publicOrigin ? new URL(config.publicOrigin) : null;
  if (
    publicOrigin &&
    (publicOrigin.protocol !== 'https:' ||
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.pathname !== '/' ||
      publicOrigin.search ||
      publicOrigin.hash)
  )
    throw new Error('Public origin must be an HTTPS URL with no path.');
  const promptAi = createPromptAI(
    { ...config.promptAi, credentialsFile: path.join(dataDir, 'prompt-ai.json') },
    {
      ...(aiFetch ? { fetchImpl: aiFetch } : {}),
      ...(aiProtector !== undefined ? { protector: aiProtector } : {}),
    }
  );
  const audio = { probeDuration, excerpt, ...audioTools };
  fs.mkdirSync(path.join(dataDir, 'audio'), { recursive: true });
  const generationFile = path.join(dataDir, 'generation.json');
  let generationBackend = fs.existsSync(generationFile)
    ? JSON.parse(fs.readFileSync(generationFile, 'utf8')).backend
    : config.generationBackend || 'local';
  if (!['local', 'runpod', 'vast'].includes(generationBackend))
    throw new Error('Select a valid generation provider.');
  const runpod = createRunpodBackend(
    runpodSettings,
    {
      ...(runpodFetch ? { fetchImpl: runpodFetch } : {}),
      keyReader: runpodKeyReader || (() => providerSecrets.get('runpod')),
    }
  );
  const vast = createVastComfyBackend({
    dataDir,
    keyReader: () => providerSecrets.get('vast'),
    ...(vastFetch ? { fetchImpl: vastFetch } : {}),
    ...(vastSpawn ? { spawnImpl: vastSpawn } : {}),
    onChange: () => broadcast(),
  });
  const comfyUrl = () => (generationBackend === 'vast' && vast.baseUrl ? vast.baseUrl : localComfyUrl);
  const gpuSession = createGpuSession({
    dataDir,
    endpointId: runpodSettings.endpointId,
    getEndpointId: () => runpodSettings.endpointId,
    remote: runpod,
    onChange: () => broadcast(),
  });
  const trainer = createLoraTrainer({
    dataDir,
    endpointId: runpodSettings.endpointId,
    remote: createRunpodBackend(runpodSettings, {
      ...(runpodFetch ? { fetchImpl: runpodFetch } : {}),
      keyReader: runpodKeyReader || (() => providerSecrets.get('runpod')),
    }),
    publicOrigin: publicOrigin?.origin,
    model: config.model,
    onChange: () => broadcast(),
    cpu: task => cpu(task),
    probe: audio.probeDuration,
  });
  const promptStore = createPromptStore({ dataDir, onChange: () => broadcast() });
  const dbFile = path.join(dataDir, 'library.json');
  const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { version: 1, jobs: [] };
  if (db.version !== 1 || !Array.isArray(db.jobs))
    throw new Error('Invalid library. Restore a backup without overwriting the data.');
  // Rules: workspaces only group songs; a job without workspaceId belongs to 'general', which can be renamed but never deleted.
  const GENERAL = 'general';
  const localizedGeneral =
    Array.isArray(db.workspaces) && db.workspaces.some(w => w.id === GENERAL && w.name === 'Generale');
  if (!Array.isArray(db.workspaces) || !db.workspaces.some(w => w.id === GENERAL))
    db.workspaces = [
      { id: GENERAL, name: 'General' },
      ...(Array.isArray(db.workspaces) ? db.workspaces : []),
    ];
  const workspaceIdOf = value => {
    if (value === undefined || value === null) return GENERAL;
    if (!db.workspaces.some(w => w.id === value)) throw new Error('Invalid workspace.');
    return value;
  };
  const workspaceName = value => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 40)
      throw new Error('Workspace name must be 1 to 40 characters.');
    return value.trim();
  };
  const clients = new Set();
  const clientId = randomUUID();
  let health = { online: false, ready: false, message: 'Connecting to ComfyUI…' };
  let stopped = false,
    polling = false,
    socket = null,
    socketEndpoint = null,
    reconnect = null,
    lastHealth = 0;
  const persist = () => {
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(dbFile + '.tmp', dbFile);
  };
  if (localizedGeneral) {
    db.workspaces.find(w => w.id === GENERAL).name = 'General';
    persist();
  }
  let modelSetup;
  // Rules: the verdict of the last quick test; the test job itself is deleted as soon as it ends (see finishQuickTest).
  let quickTest = { status: 'idle' };
  const snapshot = () => ({
    jobs: db.jobs.filter(j => !j.test),
    quickTest,
    workspaces: db.workspaces,
    prompts: promptStore.list(),
    health: { ...health },
    gpuSession: gpuSession.status(),
    trainer: trainer.snapshot(),
    editor: editor.snapshot(),
    audioLab: lab.snapshot(),
    stems: stems.snapshot(),
    modelSetup: modelSetupView(),
  });
  // Progress events arrive many times per second: coalesce them into one snapshot every 120 ms.
  let broadcastTimer = null;
  const sendSnapshot = () => {
    broadcastTimer = null;
    const event = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(event);
  };
  const broadcast = () => {
    if (stopped) return;
    broadcastTimer ??= setTimeout(sendSnapshot, 120);
  };
  /**
   * Rules: the model files Sonora finds on disk and the models ComfyUI lists can disagree (ComfyUI Desktop keeps its models in
   * its own base folder). When every file is present but ComfyUI still reports them missing, say so and name the folder.
   */
  const modelSetupView = () => {
    const setup = modelSetup?.snapshot() || {
      status: 'idle',
      message: 'Choose a ComfyUI folder to check its models.',
    };
    if (setup.status !== 'ready' || !health.online || !health.missingModels?.length) return setup;
    const where = health.comfyBase
      ? ` ComfyUI says its base folder is ${health.comfyBase}: enter that folder in the field above.`
      : ' ComfyUI Desktop keeps its models in its own base folder: enter that folder (the one that contains models), or move the files there. If it already is the folder ComfyUI reads, restart ComfyUI.';
    return {
      ...setup,
      warning: `Sonora found the model files in ${path.join(setup.root || '', 'models')}, but ComfyUI does not see them.${where}`,
    };
  };
  let lastModelStatus = 'idle';
  modelSetup = createModelSetup({
    onChange: () => {
      broadcast();
      const status = modelSetup?.snapshot().status;
      // Right after a download finishes, ask ComfyUI again so a wrong folder shows up immediately.
      if (status === 'ready' && lastModelStatus !== 'ready') checkHealth().then(broadcast, () => {});
      lastModelStatus = status;
    },
    ...(modelFetch ? { fetchImpl: modelFetch } : {}),
  });
  const change = (job, fields, durable = true) => {
    Object.assign(job, fields, { updatedAt: new Date().toISOString() });
    if (durable) persist();
    broadcast();
    if (job.test && TERMINAL.has(job.status)) finishQuickTest(job);
  };
  /**
   * The quick test is an ordinary 10-second job flagged `test`: it never appears in the library and is removed, with its
   * files, the moment it ends. Only the verdict stays. It proves the pipeline runs, not that the music is good.
   */
  const finishQuickTest = job => {
    const seconds = Math.round((Date.now() - Date.parse(job.createdAt)) / 100) / 10;
    quickTest =
      job.status === 'done'
        ? {
            status: 'ok',
            seconds,
            message: `The pipeline works: a 10-second test clip was generated in ${seconds} s.`,
          }
        : {
            status: 'failed',
            seconds,
            message:
              job.status === 'cancelled'
                ? 'The test was cancelled.'
                : job.error || 'The test failed. Check ComfyUI and the provider settings.',
          };
    const index = db.jobs.indexOf(job);
    if (index >= 0) db.jobs.splice(index, 1);
    try {
      const audioDir = path.join(dataDir, 'audio');
      for (const name of fs.readdirSync(audioDir))
        if (name.startsWith(job.id + '.')) fs.rmSync(path.join(audioDir, name), { force: true });
    } catch {}
    fs.rmSync(path.join(dataDir, 'workflows', job.id + '.json'), { force: true });
    persist();
    broadcast();
  };
  const cpu = createCpuLock(),
    getJob = id => db.jobs.find(j => j.id === id);
  const editor = createAudioEditor({
    root: ROOT,
    dataDir,
    getJob,
    onChange: broadcast,
    runTask: audioTask,
    cpu,
  });
  /** A mixdown of the stem mixer becomes a new finished song in the parent's workspace; the parent is untouched. */
  function addStemMix(parent, files) {
    const id = randomUUID();
    for (const [from, ext] of [
      [files.flac, 'flac'],
      [files.mp3, 'mp3'],
    ]) {
      const target = path.join(dataDir, 'audio', `${id}.${ext}`);
      fs.copyFileSync(from, target + '.tmp');
      fs.renameSync(target + '.tmp', target);
      fs.rmSync(from, { force: true });
    }
    const now = new Date().toISOString();
    const job = {
      id,
      group: randomUUID(),
      title: `${parent.title.replace(/ · mix$/, '')} · mix`.slice(0, 100),
      workspaceId: parent.workspaceId ?? GENERAL,
      variant: 1,
      input: { ...parent.input },
      kind: 'mix',
      parentId: parent.id,
      status: 'done',
      phase: 'Complete',
      createdAt: now,
      completedAt: now,
      favorite: false,
      archived: false,
      assets: { flac: `${id}.flac`, mp3: `${id}.mp3` },
    };
    db.jobs.unshift(job);
    persist();
    broadcast();
    return job;
  }
  const stems = createStems({
    root: ROOT,
    dataDir,
    getJob,
    onChange: broadcast,
    cpu,
  });
  const lab = createAudioLab({
    root: ROOT,
    dataDir,
    getJob,
    getMix: (jobId, mixId) => editor.media(jobId, 'mix', mixId),
    promptAi,
    cpu,
    onChange: broadcast,
    runTask: labTask,
    excerptImpl: audio.excerpt,
    addToLibrary: addMaster,
  });
  // An Audio Lab master becomes a new, finished library track that keeps the source track's parameters.
  function addMaster({ session, render, flac, mp3 }) {
    const parent = session.source.jobId ? getJob(session.source.jobId) : null;
    const id = randomUUID(),
      now = new Date().toISOString();
    const duration = Math.round(
      render.analysis?.technical?.duration || session.analysis?.technical?.duration || 30
    );
    const musical = session.analysis?.musical || {};
    const input = parent
      ? { ...parent.input, duration }
      : {
          title: session.title,
          tags: `${session.title} · file caricato in Audio Lab`,
          lyrics: '',
          instrumental: false,
          durationMode: 'manual',
          duration,
          bpm: Math.min(250, Math.max(30, Math.round(musical.bpm || 120))),
          variants: 1,
          language: 'unknown',
          keyscale: KEYS.includes(musical.key) ? musical.key : 'C major',
          timesignature: '4',
          quality: 'light',
          seed: -1,
        };
    const base = (parent?.title || session.title).replace(/ · master$/, '');
    for (const [from, ext] of [
      [flac, 'flac'],
      [mp3, 'mp3'],
    ]) {
      const target = path.join(dataDir, 'audio', `${id}.${ext}`);
      fs.copyFileSync(from, target + '.tmp');
      fs.renameSync(target + '.tmp', target);
    }
    const job = {
      id,
      group: randomUUID(),
      title: `${base} · master`.slice(0, 100),
      workspaceId: parent?.workspaceId ?? GENERAL,
      variant: 1,
      input,
      kind: 'master',
      ...(parent ? { parentId: parent.id } : {}),
      master: {
        sessionId: session.id,
        renderId: render.id,
        settings: render.settings,
        loudness: render.loudness,
      },
      status: 'done',
      phase: 'Complete',
      createdAt: now,
      completedAt: now,
      favorite: false,
      archived: false,
      assets: { flac: `${id}.flac`, mp3: `${id}.mp3` },
    };
    db.jobs.unshift(job);
    persist();
    broadcast();
    return job;
  }
  async function comfy(endpoint, body, timeout = 15000) {
    const r = await fetch(comfyUrl() + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`ComfyUI ${r.status}: ${text.slice(0, 2500)}`);
      err.httpStatus = r.status;
      throw err;
    }
    return r.json();
  }
  async function checkHealth() {
    lastHealth = Date.now();
    if (generationBackend === 'runpod') {
      health = await runpod.health();
      broadcast();
      return health;
    }
    if (generationBackend === 'vast' && !vast.connected && vastSettings.instanceId) {
      try {
        await vast.connect(vastSettings.instanceId);
      } catch (e) {
        health = {
          online: false,
          ready: false,
          backend: 'vast',
          message: e.message,
        };
        broadcast();
        return health;
      }
    }
    health.backend = generationBackend;
    try {
      const stats = await comfy('/system_stats');
      const names = [
        'UNETLoader',
        'DualCLIPLoader',
        'VAELoader',
        'TextEncodeAceStepAudio1.5',
        'EmptyAceStep1.5LatentAudio',
        'ModelSamplingAuraFlow',
        'SaveAudioMP3',
        'SaveAudio',
      ];
      const results = await Promise.all(names.map(n => comfy('/object_info/' + n)));
      const info = Object.assign({}, ...results);
      const missing = names.filter(n => !info[n]);
      const has = (node, key, value) => info[node]?.input?.required?.[key]?.[0]?.includes(value);
      if (!has('UNETLoader', 'unet_name', config.model)) missing.push(config.model);
      if (!has('DualCLIPLoader', 'clip_name1', config.encoder)) missing.push(config.encoder);
      if (!has('DualCLIPLoader', 'clip_name2', config.planner)) missing.push(config.planner);
      if (!has('VAELoader', 'vae_name', config.vae)) missing.push(config.vae);
      health = {
        online: true,
        ready: missing.length === 0,
        fullAvailable: has('DualCLIPLoader', 'clip_name2', config.planner),
        message: missing.length ? `Missing: ${missing.join(', ')}` : 'Ready to create',
        gpu: stats.devices?.[0]?.name,
        model: config.model,
          ...(comfyBaseDirectory(stats) ? { comfyBase: comfyBaseDirectory(stats) } : {}),
          missingModels: [
            !has('UNETLoader', 'unet_name', config.model) && { category: 'diffusion_models', name: config.model },
            !has('DualCLIPLoader', 'clip_name1', config.encoder) && { category: 'text_encoders', name: config.encoder },
            !has('DualCLIPLoader', 'clip_name2', config.planner) && { category: 'text_encoders', name: config.planner },
            !has('VAELoader', 'vae_name', config.vae) && { category: 'vae', name: config.vae },
          ].filter(Boolean),
          missingNodes: names.filter(n => !info[n]),
        comfyUrl: comfyUrl(),
        backend: generationBackend,
      };
      connectSocket();
    } catch (e) {
      health = {
        ...health,
        online: false,
        ready: false,
        message:
          generationBackend === 'vast'
            ? 'Vast ComfyUI is not reachable through SSH. Check the instance and connection settings.'
            : 'ComfyUI is not reachable. Start it and leave it running.',
      };
    }
    broadcast();
    return health;
  }
  function connectSocket() {
    if (stopped) return;
    const u = new URL(comfyUrl() + '/ws');
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('clientId', clientId);
    const endpoint = u.toString();
    if (socket && socketEndpoint === endpoint && socket.readyState < 2) return;
    if (socket && socket.readyState < 2) socket.close();
    const current = new WebSocket(u);
    socket = current;
    socketEndpoint = endpoint;
    current.addEventListener('error', () => {});
    current.addEventListener('close', () => {
      if (socket !== current) return;
      socket = null;
      socketEndpoint = null;
      if (!stopped) {
        clearTimeout(reconnect);
        reconnect = setTimeout(connectSocket, 5000);
        reconnect.unref();
      }
    });
    current.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const d = message.data || {};
      const job = db.jobs.find(j => j.promptId === d.prompt_id && !TERMINAL.has(j.status));
      if (!job) return;
      if (message.type === 'executing' && d.node)
        change(
          job,
          {
            status: job.cancelRequested ? 'cancelling' : 'running',
            phase: PHASES[d.node] || 'Processing',
            progress: null,
          },
          false
        );
      if (message.type === 'progress') change(job, { progress: { value: d.value, max: d.max } }, false);
      if (message.type === 'execution_error')
        change(job, {
          status: 'failed',
          error: d.exception_message || 'Error during generation.',
          phase: 'Error',
        });
      if (message.type === 'execution_interrupted') change(job, { status: 'cancelled', phase: 'Cancelled' });
    });
  }
  async function collect(job, entry) {
    change(job, { status: 'saving', phase: 'Copying to library', progress: null }, false);
    const files = Object.values(entry.outputs || {}).flatMap(o => o.audio || []);
    const assets = { ...job.assets };
    for (const file of files) {
      const ext = path
        .extname(file.filename || '')
        .slice(1)
        .toLowerCase();
      if (!['mp3', 'flac'].includes(ext)) continue;
      const filename = `${job.id}.${ext}`;
      const target = path.join(dataDir, 'audio', filename);
      if (!fs.existsSync(target)) {
        const q = new URLSearchParams({
          filename: file.filename,
          subfolder: file.subfolder || '',
          type: file.type || 'output',
        });
        const r = await fetch(`${comfyUrl()}/view?${q}`, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error('Could not copy audio from ComfyUI.');
        const bytes = Buffer.from(await r.arrayBuffer());
        if (bytes.length < 32) throw new Error('ComfyUI returned an empty audio file.');
        fs.writeFileSync(target + '.tmp', bytes);
        fs.renameSync(target + '.tmp', target);
      }
      assets[ext] = filename;
    }
    if (!assets.mp3 || !assets.flac)
      throw new Error('MP3/FLAC audio was not found in ComfyUI history.');
    change(job, {
      assets,
      status: 'done',
      phase: 'Complete',
      completedAt: new Date().toISOString(),
      error: null,
    });
  }
  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      await editor.reconcile();
      if (Date.now() - lastHealth > 20000) await checkHealth();
      const active = db.jobs.filter(j => !TERMINAL.has(j.status));
      if (!active.length) return;
      for (const job of active.filter(j => j.backend === 'runpod')) {
        const remoteBackend = runpod;
        const provider = 'RunPod';
        try {
          const result = job.remoteAudio
            ? { status: 'COMPLETED', output: job.remoteAudio }
            : await remoteBackend.status(job);
          if (result.status === 'COMPLETED' && result.output?.error) {
            change(job, {
              status: 'failed',
              phase: `Error ${provider}`,
              error: 'The worker did not complete generation.',
            });
          } else if (result.status === 'COMPLETED') {
            if (!job.remoteAudio)
              change(job, {
                remoteAudio: result.output,
                status: 'saving',
                phase: `Copying audio from ${provider}`,
                remoteTiming: { delayMs: result.delayTime, executionMs: result.executionTime },
              });
            const assets = job.rework?.spliced
              ? { flac: `${job.id}.flac`, mp3: `${job.id}.mp3` }
              : await remoteBackend.collect(job, result.output, dataDir);
            if (job.kind === 'layer' && job.rework?.section && !job.rework.spliced) {
              // Rules: a section instrument becomes a full-length track that is silent outside [start, end].
              const audioDir = path.join(dataDir, 'audio');
              const raw = path.join(audioDir, `${job.id}.segment.flac`);
              fs.copyFileSync(path.join(audioDir, `${job.id}.flac`), raw);
              await placeSection({
                segment: raw,
                start: job.rework.start,
                end: job.rework.end,
                windowStart: job.rework.windowStart,
                total: job.rework.total,
                flacOut: path.join(audioDir, `${job.id}.placed.flac`),
                mp3Out: path.join(audioDir, `${job.id}.placed.mp3`),
              });
              fs.renameSync(
                path.join(audioDir, `${job.id}.placed.flac`),
                path.join(audioDir, `${job.id}.flac`)
              );
              fs.renameSync(
                path.join(audioDir, `${job.id}.placed.mp3`),
                path.join(audioDir, `${job.id}.mp3`)
              );
              change(job, {
                rework: { ...job.rework, spliced: true },
                input: { ...job.input, duration: Math.round(job.rework.total) },
              });
            }
            if (job.rework?.mode === 'repaint' && !job.rework.spliced) {
              // Rules: the regenerated window replaces only [start, end] of the parent; the raw window is kept next to it.
              const audioDir = path.join(dataDir, 'audio');
              const raw = path.join(audioDir, `${job.id}.segment.flac`);
              fs.copyFileSync(path.join(audioDir, `${job.id}.flac`), raw);
              await spliceSection({
                original: path.join(audioDir, `${job.rework.parentId}.flac`),
                segment: raw,
                start: job.rework.start,
                end: job.rework.end,
                windowStart: job.rework.windowStart,
                total: job.rework.total,
                flacOut: path.join(audioDir, `${job.id}.spliced.flac`),
                mp3Out: path.join(audioDir, `${job.id}.spliced.mp3`),
              });
              fs.renameSync(
                path.join(audioDir, `${job.id}.spliced.flac`),
                path.join(audioDir, `${job.id}.flac`)
              );
              fs.renameSync(
                path.join(audioDir, `${job.id}.spliced.mp3`),
                path.join(audioDir, `${job.id}.mp3`)
              );
              // The song keeps its full length: the 42 s window is only an intermediate step.
              change(job, {
                rework: { ...job.rework, spliced: true },
                input: { ...job.input, duration: Math.round(job.rework.total) },
              });
            }
            change(job, {
              assets,
              status: 'done',
              phase: 'Complete',
              completedAt: new Date().toISOString(),
              error: null,
            });
            if (job.kind === 'layer')
              stems.addLayer(job.rework.parentId, { id: job.id, name: job.rework.layerName });
          } else if (['FAILED', 'TIMED_OUT', 'CANCELLED', 'LOST'].includes(result.status)) {
            const cancelled = result.status === 'CANCELLED';
            change(job, {
              status: cancelled ? 'cancelled' : 'failed',
              phase: cancelled ? 'Cancelled' : `Error ${provider}`,
              error: cancelled
                ? null
                : `${provider} job was interrupted or its result could not be recovered. It will not be resubmitted.`,
            });
          } else if (result.status === 'IN_PROGRESS') {
            change(
              job,
              {
                status: job.cancelRequested ? 'cancelling' : 'running',
                phase: job.cancelRequested ? 'Cancelling…' : `Generating on ${provider}`,
              },
              false
            );
          }
        } catch (e) {
          change(
            job,
            {
              phase: job.remoteAudio ? 'Retrying audio copy' : `Reconnecting to ${provider}`,
              error: e.message,
            },
            false
          );
        }
      }
      const local = active.filter(j => j.backend !== 'runpod');
      if (!local.length) return;
      const queue = await comfy('/queue');
      for (const job of local) {
        const history = await comfy('/history/' + job.promptId);
        const entry = history[job.promptId];
        if (entry) {
          const fail = historyFailure(entry);
          if (fail) {
            change(job, {
              status: fail.cancelled ? 'cancelled' : 'failed',
              phase: fail.cancelled ? 'Cancelled' : 'Error',
              error: fail.cancelled ? null : fail.message,
            });
            continue;
          }
          if (entry.status?.completed || entry.status?.status_str === 'success') {
            try {
              await collect(job, entry);
            } catch (e) {
              change(job, { status: 'saving', phase: 'Retrying audio copy', error: e.message }, false);
            }
            continue;
          }
        }
        const running = queue.queue_running?.some(x => x[1] === job.promptId);
        const index = queue.queue_pending?.findIndex(x => x[1] === job.promptId) ?? -1;
        if (running) {
          job.missingSince = null;
          change(
            job,
            {
              status: job.cancelRequested ? 'cancelling' : 'running',
              phase: job.cancelRequested
                ? 'Cancelling…'
                : job.status === 'running'
                  ? job.phase
                  : 'Processing in ComfyUI',
            },
            false
          );
        } else if (index >= 0) {
          job.missingSince = null;
          change(
            job,
            {
              status: job.cancelRequested ? 'cancelling' : 'queued',
              phase: `Queued · position ${index + 1}`,
            },
            false
          );
        } else {
          job.missingSince ??= Date.now();
          if (Date.now() - job.missingSince > (job.cancelRequested ? 5000 : 60000))
            change(job, {
              status: job.cancelRequested ? 'cancelled' : 'failed',
              phase: job.cancelRequested ? 'Cancelled' : 'Job not found',
              error: job.cancelRequested
                ? null
                : 'The job is no longer in the ComfyUI queue or history. You can reuse its settings to try again.',
            });
        }
      }
    } catch (e) {
      health = {
        ...health,
        online: false,
        ready: false,
        message: 'ComfyUI connection lost. Reconnecting automatically…',
      };
      broadcast();
    } finally {
      polling = false;
    }
  }
  async function submit(input, referenceAudio = null, parentId = null, workspaceId = GENERAL, extra = {}) {
    const selectedBackend = generationBackend;
    if (
      trainer.snapshot().projects.some(p => p.job && !['done', 'failed', 'cancelled'].includes(p.job.status))
    )
      throw new Error('Wait for LoRA training to finish before generating music.');
    if (input.loraId) {
      if (generationBackend !== 'runpod') throw new Error('The trained LoRA requires RunPod.');
      trainer.lora(input.loraId);
    }
    if (input.finish === 'final' && selectedBackend === 'runpod' && config.runpod?.sftReady !== true)
      throw new Error('The final model (SFT) is not installed on RunPod yet.');
    if (input.finish === 'final' && selectedBackend !== 'runpod')
      throw new Error('Final quality (SFT) requires RunPod.');
    if (extra.rework && selectedBackend !== 'runpod')
      throw new Error('Remix and section regeneration require RunPod.');
    if (generationBackend === 'runpod' && referenceAudio)
      throw new Error('Replacing vocals with reference audio is available with local ComfyUI.');
    // Rules: a reference audio (guides timbre) travels to the GPU like a remix source; it needs RunPod and is never combined with a remix.
    let referenceFile = null;
    if (input.referenceId) {
      if (selectedBackend !== 'runpod') throw new Error('Reference audio requires RunPod.');
      if (extra.rework) throw new Error('Remix and reference audio cannot be used together.');
      referenceFile = path.join(dataDir, 'references', `${input.referenceId}.mp3`);
      if (!fs.existsSync(referenceFile))
        throw new Error('Reference audio is no longer available. Upload it again.');
    }
    if (!health.ready) await checkHealth();
    if (!health.ready) throw new Error(health.message);
    if (input.quality === 'full' && !health.fullAvailable)
      throw new Error('Qwen 4B encoder is unavailable. Choose Light mode.');
    if (db.jobs.filter(j => !TERMINAL.has(j.status)).length + input.variants > 12)
      throw new Error('The queue is full. Wait for some tracks to finish.');
    const group = randomUUID();
    const jobs = seedsFor(input).map((seed, i) => ({
      id: randomUUID(),
      promptId: randomUUID(),
      group,
      title: input.title,
      variant: i + 1,
      workspaceId,
      input: { ...input, seed },
      backend: selectedBackend,
      ...(generationBackend === 'runpod' ? { remote: { endpointId: runpodSettings.endpointId } } : {}),
      ...(generationBackend === 'vast' ? { remote: { instanceId: vast.instanceId } } : {}),
      ...(parentId ? { parentId, kind: 'vocal-cover' } : {}),
      ...(extra.rework
        ? { parentId: extra.rework.parentId, kind: extra.rework.mode, rework: extra.rework }
        : {}),
      status: 'submitting',
      phase:
        generationBackend === 'runpod'
          ? 'Sending to RunPod'
          : generationBackend === 'vast'
            ? 'Sending through Vast.ai'
            : 'Sending to ComfyUI',
      createdAt: new Date().toISOString(),
      favorite: false,
      archived: extra.rework?.mode === 'layer',
      ...(extra.test ? { test: true } : {}),
      assets: {},
    }));
    db.jobs.unshift(...jobs);
    persist();
    broadcast();
    for (const job of jobs) {
      try {
        const source = extra.rework ? { audio: `Sonora/${job.id}.mp3`, denoise: extra.rework.denoise } : null;
        const prompt = buildWorkflow(
          job.input,
          job.input.seed,
          job.id,
          config,
          referenceFile ? `Sonora/${job.id}.mp3` : referenceAudio,
          source
        );
        if (job.input.loraId) {
          if (job.backend !== 'runpod') throw new Error('The trained LoRA requires RunPod.');
          prompt['15'] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: { model: ['1', 0], lora_name: trainer.lora(job.input.loraId), strength_model: 1 },
          };
          prompt['7'].inputs.model = ['15', 0];
        }
        fs.mkdirSync(path.join(dataDir, 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'workflows', job.id + '.json'), JSON.stringify(prompt, null, 2));
        if (job.backend === 'runpod') {
          const remote = await runpod.submit(
            job,
            prompt,
            extra.sourceFile || referenceFile
              ? fs.readFileSync(extra.sourceFile || referenceFile).toString('base64')
              : null
          );
          change(job, { remote, status: 'queued', phase: 'Queued on RunPod' });
        } else {
          const result = await comfy('/prompt', { prompt, prompt_id: job.promptId, client_id: clientId });
          change(job, { promptId: result.prompt_id, status: 'queued', phase: 'Queued' });
        }
      } catch (e) {
        if (e.httpStatus) change(job, { status: 'failed', phase: 'Error', error: e.message });
        else
          change(job, {
            status: 'reconciling',
            phase: 'Checking job receipt',
            error: 'No response from the service. Checking status without submitting a duplicate.',
          });
      }
    }
    return jobs;
  }
  /**
   * Remix (whole song) or repaint (one section) of a finished song, always as a NEW song: the original is never touched.
   * Rules: RunPod only; the source travels as a 128k MP3 inside the request; a repaint regenerates a window with context
   * and splices only the chosen section back, with crossfades (see audio-remix.mjs).
   */
  async function rework(id, body) {
    const original = db.jobs.find(j => j.id === id);
    if (!original || original.status !== 'done' || original.assets?.flac !== `${id}.flac`)
      throw new Error('The track must be complete.');
    const mode = body.mode;
    if (!['remix', 'repaint'].includes(mode)) throw new Error('Invalid mode.');
    const denoise = Math.round(Number(body.strength ?? 0.5) * 100) / 100;
    if (!(denoise >= 0.2 && denoise <= 0.95)) throw new Error('Invalid strength (0.2 to 0.95).');
    const flac = path.join(dataDir, 'audio', `${id}.flac`);
    const total = await audioSeconds(flac);
    const typed = typeof body.tags === 'string' ? body.tags.trim() : '';
    // Rules: a remix may rewrite the whole style; a repaint ADDS the requested change in front of the song's own style,
    // otherwise the section would lose the sound of the rest of the song.
    const tags = (
      mode === 'repaint' && typed ? `${typed}, ${original.input.tags}` : typed || original.input.tags
    ).slice(0, 3000);
    let window = { windowStart: 0, windowEnd: total },
      start = 0,
      end = total,
      lyrics =
        mode === 'remix' && typeof body.lyrics === 'string' && body.lyrics.trim()
          ? body.lyrics.trim().slice(0, 12000)
          : original.input.lyrics,
      typedLyrics = mode === 'remix' && typeof body.lyrics === 'string' && !!body.lyrics.trim();
    // Rules: a long source (uploaded songs can last minutes) is remixed on a chosen piece of at most 5 minutes.
    if (mode === 'remix' && (body.sourceStart !== undefined || body.sourceEnd !== undefined)) {
      const a = Number(body.sourceStart ?? 0),
        b = Number(body.sourceEnd ?? total);
      if (!(a >= 0) || !(b > a) || b > total + 0.05) throw new Error('Invalid track range.');
      window = { windowStart: a, windowEnd: Math.min(b, total) };
    }
    if (mode === 'repaint') {
      start = Number(body.start);
      end = Number(body.end);
      window = repaintWindow(start, end, total);
      const part = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
      lyrics = part || (original.input.instrumental ? original.input.lyrics : '[Instrumental]');
      typedLyrics = !!part;
    }
    // Rules: the singing choice is explicit when the caller states it; typed words always mean "with voice".
    const instrumental =
      typeof body.instrumental === 'boolean'
        ? body.instrumental && !typedLyrics
        : typedLyrics
          ? false
          : original.input.instrumental;
    const length = window.windowEnd - window.windowStart;
    if (length < 10 || length > 300)
      throw new Error('The section to process must be 10 to 300 seconds long.');
    const input = validateInput({
      ...original.input,
      // Rules: when the result is sung, the style must not still say "no vocals" (the source may have been instrumental).
      tags: instrumental ? tags : withoutInstrumentalWords(tags),
      lyrics: instrumental ? original.input.lyrics || '' : lyrics,
      instrumental,
      referenceId: undefined,
      avoid: typeof body.avoid === 'string' ? body.avoid.slice(0, 500) : original.input.avoid,
      title: `${original.title} · ${mode === 'remix' ? 'remix' : 'touch-up'}`.slice(0, 100),
      durationMode: 'manual',
      duration: Math.ceil(length),
      durationOverrides: {},
      variants: 1,
      seed: typeof body.seed === 'number' ? body.seed : -1,
      finish: body.finish === 'final' ? 'final' : 'fast',
    });
    const sourceFile = path.join(dataDir, 'workflows', `${randomUUID()}-source.mp3`);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    try {
      await encodeSource(flac, sourceFile, { start: window.windowStart, length });
      const rework = {
        mode,
        parentId: id,
        denoise,
        start,
        end,
        total,
        windowStart: window.windowStart,
      };
      const [job] = await submit(input, null, null, original.workspaceId ?? GENERAL, { rework, sourceFile });
      return job;
    } finally {
      fs.rmSync(sourceFile, { force: true });
    }
  }
  /**
   * AI instrument layer for the stem mixer. Rules: RunPod only; the generated song is an internal helper job (archived from the
   * start, kind 'layer') that registers itself as a mixer track when it completes; the parent song is never touched.
   */
  const clock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  async function addLayerJob(id, body) {
    const original = db.jobs.find(j => j.id === id);
    if (!original || original.status !== 'done' || original.assets?.flac !== `${id}.flac`)
      throw new Error('The track must be complete.');
    const instrument = typeof body.instrument === 'string' ? body.instrument.trim() : '';
    if (!instrument || instrument.length > 120)
      throw new Error('Describe the instrument (maximum 120 characters).');
    const denoise = Math.round(Number(body.strength ?? 0.85) * 100) / 100;
    if (!(denoise >= 0.5 && denoise <= 0.95)) throw new Error('Invalid strength (0.5 to 0.95).');
    if ((stems.snapshot().sessions.find(x => x.id === id)?.layers.length ?? 0) >= 8)
      throw new Error('You can add up to 8 instruments per track.');
    const total = await audioSeconds(path.join(dataDir, 'audio', `${id}.flac`));
    if (total < 10 || total > 300) throw new Error('Track duration must be 10 to 300 seconds.');
    // Optional section: the instrument is generated only between `start` and `end` (with context around it) and placed in silence.
    let section = null,
      window = { windowStart: 0, windowEnd: total };
    if (body.start !== undefined || body.end !== undefined) {
      const start = Number(body.start),
        end = Number(body.end);
      window = repaintWindow(start, end, total);
      section = { start, end };
    }
    const windowLength = window.windowEnd - window.windowStart;
    const input = validateInput({
      ...original.input,
      referenceId: undefined,
      tags: `solo ${instrument}, isolated instrument track, played alone`,
      lyrics: '[Instrumental]',
      instrumental: true,
      title: `${original.title} · ${instrument}`.slice(0, 100),
      durationMode: 'manual',
      duration: Math.ceil(windowLength),
      durationOverrides: {},
      variants: 1,
      seed: typeof body.seed === 'number' ? body.seed : -1,
      finish: body.finish === 'final' ? 'final' : 'fast',
    });
    const sourceFile = await stems.layerSource(
      id,
      section ? { start: window.windowStart, end: window.windowEnd } : null
    );
    try {
      const rework = {
        mode: 'layer',
        parentId: id,
        denoise,
        start: section ? section.start : 0,
        end: section ? section.end : total,
        total,
        windowStart: window.windowStart,
        section: !!section,
        layerName: section
          ? `${instrument} (${clock(section.start)}–${clock(section.end)})`.slice(0, 60)
          : instrument,
      };
      const [job] = await submit(input, null, null, original.workspaceId ?? GENERAL, { rework, sourceFile });
      return job;
    } finally {
      fs.rmSync(sourceFile, { force: true });
    }
  }
  const covering = new Set();
  async function cover(id, body) {
    if (generationBackend === 'runpod')
      throw new Error('Replacing vocals with reference audio requires local ComfyUI.');
    if (covering.has(id)) throw new Error('Vocal replacement is already in progress.');
    covering.add(id);
    try {
      const reference = editor.coverReference(id),
        original = db.jobs.find(j => j.id === id);
      if (!original) throw new Error('ACE-Step cover is available only for tracks in the library.');
      const nodes = await comfy('/object_info');
      if (!['LoadAudio', 'VAEEncodeAudio', 'ReferenceTimbreAudio'].every(n => nodes[n]))
        throw new Error('The audio reference nodes are not available in ComfyUI.');
      const input = validateInput({
        ...original.input,
        ...body,
        title: (original.title + ' · nuova voce').slice(0, 100),
        durationMode: 'manual',
        duration: Math.min(300, Math.max(10, Math.ceil(reference.duration))),
        durationOverrides: {},
        instrumental: false,
        quality: 'light',
        variants: 1,
        seed: body.seed ?? -1,
      });
      const referenceId = randomUUID(),
        form = new FormData();
      form.append(
        'image',
        new Blob([fs.readFileSync(reference.file)], { type: 'audio/flac' }),
        referenceId + '.flac'
      );
      form.append('subfolder', 'Sonora');
      form.append('type', 'input');
      form.append('overwrite', 'false');
      const response = await fetch(comfyUrl() + '/upload/image', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error('ComfyUI did not accept the instrumental backing.');
      const uploaded = await response.json();
      if (
        uploaded.name !== referenceId + '.flac' ||
        uploaded.subfolder !== 'Sonora' ||
        uploaded.type !== 'input'
      )
        throw new Error('ComfyUI returned an unexpected audio reference.');
      const [job] = await submit(
        input,
        'Sonora/' + referenceId + '.flac',
        id,
        original.workspaceId ?? GENERAL
      );
      editor.trackCover(id, job.id);
      return job;
    } finally {
      covering.delete(id);
    }
  }
  // User mistakes stay 400; missing resources 404; unreachable services 502/504; bugs 500 with details only in the server log.
  function failure(e) {
    if (e.status) return [e.status, e.message];
    if (e.name === 'TimeoutError') return [504, 'The external service timed out. Try again.'];
    if (e.httpStatus) return [502, e.message];
    if (e instanceof TypeError && /fetch failed/i.test(e.message))
      return [502, 'External service is unreachable (ComfyUI or DeepSeek).'];
    if (
      e instanceof TypeError ||
      e instanceof ReferenceError ||
      e instanceof RangeError ||
      e instanceof SyntaxError ||
      (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code))
    ) {
      console.error(e);
      return [500, 'Sonora encountered an internal error. Details are in the server terminal.'];
    }
    if (/not (found|available)|unavailable|non (è |sono )?(più )?(trovat|disponibil)/i.test(e.message))
      return [404, e.message];
    return [400, e.message];
  }
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  async function bodyOf(req) {
    let bytes = 0,
      parts = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 128000) throw new Error('Request is too large.');
      parts.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString());
    } catch {
      throw new Error('Invalid JSON.');
    }
  }
  function sendFile(req, res, file, type, downloadName) {
    if (!fs.existsSync(file)) {
      json(res, 404, { error: 'File not found.' });
      return;
    }
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' };
    if (downloadName)
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    let start = 0,
      end = size - 1,
      status = 200;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!m || (!m[1] && !m[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      if (!m[1]) start = Math.max(0, size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else {
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      res.on('close', () => stream.destroy());
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    const host = req.headers.host || '';
    const isLocalHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
    const isPublicHost = !!publicOrigin && host === publicOrigin.host;
    if (!isLocalHost && !isPublicHost) {
      json(res, 403, { error: 'Access is allowed only from this computer.' });
      return;
    }
    const url = new URL(req.url, 'http://' + host);
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        const expectedOrigin = isPublicHost ? publicOrigin.origin : 'http://' + host;
        if (req.headers['x-sonora'] !== '1' || (origin && origin !== expectedOrigin)) {
          json(res, 403, { error: 'Request origin is not allowed.' });
          return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, snapshot());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/trainer/projects') {
        json(res, 200, trainer.create(await bodyOf(req)));
        return;
      }
      const training =
        /^\/api\/trainer\/([a-f0-9-]{36})\/(upload|start|cancel|tracks\/([a-f0-9-]{36}))$/.exec(url.pathname);
      if (req.method === 'POST' && training) {
        const [, id, action, trackId] = training;
        if (action === 'upload') {
          json(res, 200, await trainer.upload(id, req));
          return;
        }
        if (trackId) {
          json(res, 200, trainer.annotate(id, trackId, await bodyOf(req)));
          return;
        }
        if (action === 'start') {
          if (gpuSession.status().active || db.jobs.some(j => !TERMINAL.has(j.status)))
            throw new Error('End the GPU session and wait for tracks in progress before training.');
          const pending = trainer.start(id, await bodyOf(req));
          pending.catch(() => {
            /* Durable trainer status carries the failure to the UI. */
          });
          json(res, 202, trainer.snapshot());
          return;
        }
        json(res, 200, await trainer.cancel(id));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        json(res, 200, {
          languages: LANGUAGES,
          keys: KEYS,
          comfyUrl: localComfyUrl,
          model: config.model,
          generationBackend,
          providers: {
            local: { comfyUrl: localComfyUrl, comfyRoot: localModelsRoot },
            runpod: {
              configured: Boolean(runpodSettings.endpointId && providerSecrets.get('runpod')),
              endpointId: runpodSettings.endpointId || '',
              modelsReady: runpodSettings.modelsReady === true,
            },
            vast: {
              configured: vast.configured,
              connected: vast.connected,
              instanceId: vast.instanceId || vastSettings.instanceId || null,
            },
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/local') {
        const b = await bodyOf(req);
        const next = new URL(String(b.comfyUrl || ''));
        if (
          !['http:', 'https:'].includes(next.protocol) ||
          next.username ||
          next.password ||
          next.search ||
          next.hash ||
          !['localhost', '127.0.0.1', '[::1]'].includes(next.hostname)
        )
          throw new Error('Use a ComfyUI URL on this computer, such as http://127.0.0.1:8188.');
        if (db.jobs.some(j => ['local', 'vast'].includes(j.backend) && !TERMINAL.has(j.status)))
          throw new Error('Wait for active ComfyUI jobs to finish before changing this URL.');
        const rootValue = typeof b.comfyRoot === 'string' ? b.comfyRoot.trim() : localModelsRoot;
        localModelsRoot = rootValue ? await modelSetup.validateRoot(rootValue) : '';
        localComfyUrl = next.href.replace(/\/$/, '');
        saveProviderSettings();
        const result = generationBackend === 'local' ? await checkHealth() : health;
        json(res, 200, { comfyUrl: localComfyUrl, comfyRoot: localModelsRoot, health: result });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/models/plan') {
        if (!localModelsRoot) throw new Error('Save the folder containing ComfyUI main.py first.');
        const plan = await modelSetup.inspect(localModelsRoot, {
          model: config.model,
          encoder: config.encoder,
          planner: config.planner,
          vae: config.vae,
        });
        await checkHealth().catch(() => {});
        const warning = modelSetupView().warning;
        json(res, 200, warning ? { ...plan, warning } : plan);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/models/download') {
        const b = await bodyOf(req);
        if (b.confirmed !== true) throw new Error('Confirm the ACE-Step model download before it starts.');
        if (!localModelsRoot) throw new Error('Save the folder containing ComfyUI main.py first.');
        if (db.jobs.some(j => ['local', 'vast'].includes(j.backend) && !TERMINAL.has(j.status)))
          throw new Error('Wait for active ComfyUI jobs to finish before downloading models.');
        const pending = modelSetup.download({
          root: localModelsRoot,
          names: { model: config.model, encoder: config.encoder, planner: config.planner, vae: config.vae },
          confirmed: true,
        });
        pending.catch(() => {
          /* The model setup snapshot carries download errors to the UI. */
        });
        json(res, 202, { started: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/models/cancel') {
        modelSetup.cancel();
        json(res, 200, { cancelled: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/providers/runpod') {
        const b = await bodyOf(req);
        const endpointId = String(b.endpointId || '').trim();
        const apiKey = b.apiKey;
        if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 2048 || /\s/.test(apiKey))
          throw new Error('Enter a valid RunPod API key.');
        if (!/^[a-zA-Z0-9_-]{5,80}$/.test(endpointId))
          throw new Error('Enter a valid RunPod serverless endpoint ID.');
        if (db.jobs.some(j => j.backend === 'runpod' && !TERMINAL.has(j.status)))
          throw new Error('Wait for active RunPod jobs to finish before changing the endpoint.');
        await runpod.verifyKey(apiKey, endpointId);
        providerSecrets.set('runpod', apiKey);
        runpod.setKey(apiKey);
        runpodSettings.endpointId = endpointId;
        runpodSettings.modelsReady = b.modelsReady === true;
        saveProviderSettings();
        json(res, 200, { configured: true, endpointId, modelsReady: runpodSettings.modelsReady });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/vast/key') {
        const b = await bodyOf(req);
        await vast.verifyKey(b.apiKey);
        providerSecrets.set('vast', b.apiKey);
        json(res, 200, { configured: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/vast/instances') {
        const instances = await vast.instances();
        json(res, 200, {
          instances: instances.map(({ id, label, status, gpu }) => ({ id, label, status, gpu })),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/vast/connect') {
        const b = await bodyOf(req);
        if (gpuSession.status().active) throw new Error('Stop the active RunPod session before switching providers.');
        if (db.jobs.some(j => ['local', 'vast'].includes(j.backend) && !TERMINAL.has(j.status)))
          throw new Error('Wait for active ComfyUI jobs to finish before switching providers.');
        await vast.connect(b.instanceId);
        vastSettings.instanceId = vast.instanceId;
        generationBackend = 'vast';
        fs.writeFileSync(generationFile + '.tmp', JSON.stringify({ backend: generationBackend }));
        fs.renameSync(generationFile + '.tmp', generationFile);
        saveProviderSettings();
        json(res, 200, await checkHealth());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/vast/disconnect') {
        if (db.jobs.some(j => j.backend === 'vast' && !TERMINAL.has(j.status)))
          throw new Error('Wait for active Vast jobs to finish before disconnecting.');
        await vast.close();
        if (generationBackend === 'vast') {
          generationBackend = 'local';
          fs.writeFileSync(generationFile + '.tmp', JSON.stringify({ backend: generationBackend }));
          fs.renameSync(generationFile + '.tmp', generationFile);
        }
        json(res, 200, await checkHealth());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/generation/backend') {
        const b = await bodyOf(req);
        if (!['local', 'runpod', 'vast'].includes(b.backend))
          throw new Error('Select a valid generation provider.');
        if (b.backend === 'runpod' && (!runpodSettings.endpointId || !providerSecrets.get('runpod')))
          throw new Error('Configure your RunPod API key and endpoint first.');
        if (b.backend === 'vast' && (!vast.connected || !vast.instanceId))
          throw new Error('Connect a running Vast ComfyUI instance first.');
        if (gpuSession.status().active && b.backend !== 'runpod')
          throw new Error('Stop the active RunPod session before switching providers.');
        if (
          generationBackend !== b.backend &&
          db.jobs.some(j => ['local', 'runpod', 'vast'].includes(j.backend) && !TERMINAL.has(j.status))
        )
          throw new Error('Wait for active generation jobs to finish before switching providers.');
        if (generationBackend === 'vast' && b.backend !== 'vast') await vast.close();
        generationBackend = b.backend;
        fs.writeFileSync(generationFile + '.tmp', JSON.stringify({ backend: generationBackend }));
        fs.renameSync(generationFile + '.tmp', generationFile);
        json(res, 200, await checkHealth());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/gpu-session') {
        const b = await bodyOf(req);
        if (!['start', 'stop'].includes(b.action)) throw new Error('Invalid session action.');
        if (b.action === 'start' && generationBackend !== 'runpod')
          throw new Error('Select RunPod first.');
        if (
          b.action === 'start' &&
          trainer
            .snapshot()
            .projects.some(p => p.job && !['done', 'failed', 'cancelled'].includes(p.job.status))
        )
          throw new Error(
            'Wait for LoRA training to finish before starting a generation GPU session.'
          );
        json(res, 200, await gpuSession[b.action]());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/prompt-ai/status') {
        json(res, 200, promptAi.status());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt-ai/config') {
        json(res, 200, await promptAi.configure(await bodyOf(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt-ai/boost') {
        json(res, 200, await promptAi.boost(await bodyOf(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt-ai/lyrics') {
        json(res, 200, await promptAi.lyrics(await bodyOf(req)));
        return;
      }
      // Listen to an uploaded song (OpenAI audio model). The upload is temporary and deleted right after.
      if (req.method === 'POST' && url.pathname === '/api/prompt-ai/listen') {
        if (!promptAi.canListen())
          throw new Error('To analyze a track, select OpenAI with an audio model in Configure AI.');
        const dir = path.join(dataDir, 'ai-uploads'),
          file = path.join(dir, randomUUID() + '.audio');
        fs.mkdirSync(dir, { recursive: true });
        let name = '';
        try {
          name = decodeURIComponent(req.headers['x-audio-name'] || '').slice(0, 120);
        } catch {}
        try {
          let bytes = 0;
          const fd = fs.openSync(file, 'w');
          try {
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > 150 * 1024 * 1024) throw new Error('File exceeds 150 MB.');
              fs.writeSync(fd, chunk);
            }
          } finally {
            fs.closeSync(fd);
          }
          if (bytes < 1000) throw new Error('Audio file is empty.');
          const duration = await audio.probeDuration(file);
          if (duration > 600) throw new Error('Choose a track up to 10 minutes long.');
          // Up to 150 s: the whole song when short, otherwise from 15% in (usually verse and chorus).
          const w =
            duration <= 150
              ? { start: 0, seconds: duration }
              : excerptWindow(duration, 150, 0.15 + 75 / duration);
          const part = await audio.excerpt(file, w);
          const minutes = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
          json(res, 200, {
            ...(await promptAi.listen({
              audio: [part],
              duration,
              name,
              excerpt:
                w.seconds < duration
                  ? `${Math.round(w.seconds)} s (from ${minutes(w.start)} to ${minutes(w.start + w.seconds)})`
                  : '',
            })),
            duration,
            heardSeconds: Math.round(w.seconds),
          });
        } finally {
          fs.rmSync(file, { force: true });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        clients.add(res);
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        req.on('close', () => clients.delete(res));
        return;
      }
      // Quick test: a 10-second instrumental clip with the selected provider, to confirm the whole pipeline runs.
      if (req.method === 'POST' && url.pathname === '/api/provider-test') {
        const open = db.jobs.find(j => j.test && !TERMINAL.has(j.status));
        if (open && Date.now() - Date.parse(open.createdAt) < 15 * 60 * 1000)
          throw new Error('A quick test is already running.');
        if (open) db.jobs.splice(db.jobs.indexOf(open), 1);
        const probe = validateInput({
          title: 'Quick test',
          tags: 'calm solo piano, soft, simple melody',
          instrumental: true,
          durationMode: 'manual',
          duration: 10,
          bpm: 90,
          keyscale: 'C major',
          timesignature: '4',
          quality: 'light',
          finish: 'fast',
          variants: 1,
        });
        quickTest = { status: 'running', message: 'Generating a 10-second test clip…' };
        try {
          await submit(probe, null, null, GENERAL, { test: true });
        } catch (e) {
          quickTest = { status: 'failed', message: e.message };
          broadcast();
          throw e;
        }
        broadcast();
        json(res, 202, { quickTest });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        const body = await bodyOf(req);
        const input = validateInput(body);
        json(res, 202, { jobs: await submit(input, null, null, workspaceIdOf(body.workspaceId)) });
        return;
      }
      // Saved prompts (style, optional lyrics and options), shared by every device.
      if (url.pathname === '/api/prompts' && req.method === 'GET') {
        json(res, 200, { prompts: promptStore.list() });
        return;
      }
      if (url.pathname === '/api/prompts' && req.method === 'POST') {
        const body = await bodyOf(req);
        json(
          res,
          201,
          Array.isArray(body.import) ? promptStore.importMany(body.import) : promptStore.create(body)
        );
        return;
      }
      const promptMatch = /^\/api\/prompts\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (promptMatch && req.method === 'PATCH') {
        json(res, 200, promptStore.update(promptMatch[1], await bodyOf(req)));
        return;
      }
      if (promptMatch && req.method === 'DELETE') {
        json(res, 200, promptStore.remove(promptMatch[1]));
        return;
      }
      // The dice: a coherent title, style and lyrics from one AI call. It only fills the form.
      if (req.method === 'POST' && url.pathname === '/api/prompt/surprise') {
        json(res, 200, await promptAi.surprise(await bodyOf(req)));
        return;
      }
      // "Auto" tempo / time signature / key: the AI when configured, otherwise a local guess from the style words.
      if (req.method === 'POST' && url.pathname === '/api/prompt/meta') {
        const body = await bodyOf(req);
        const guess = guessMeta(String(body.tags || ''), String(body.lyrics || ''));
        let chosen = {},
          by = 'local';
        if (promptAi.status().available) {
          try {
            chosen = await promptAi.chooseMeta(body);
            by = 'ai';
          } catch {}
        }
        json(res, 200, { ...guess, ...chosen, by });
        return;
      }
      // A reference audio: at most 60 s, kept as a small MP3 and sent to the GPU with the job that uses it.
      if (req.method === 'POST' && url.pathname === '/api/reference') {
        const dir = path.join(dataDir, 'references');
        const upload = await receiveUpload(req, {
          dir: path.join(dir, 'tmp'),
          tmpDir: path.join(dir, 'tmp'),
          probe: audioSeconds,
        });
        try {
          const start = Math.max(0, Number(req.headers['x-audio-start']) || 0);
          const length = Math.min(
            60,
            Math.max(5, Number(req.headers['x-audio-length']) || 30),
            upload.seconds - start
          );
          if (!(length >= 5)) throw new Error('Reference audio must be at least 5 seconds long.');
          const id = randomUUID();
          await encodeSource(upload.flac, path.join(dir, `${id}.mp3`), { start, length });
          json(res, 201, { id, seconds: Math.round(length), title: upload.title });
        } finally {
          fs.rmSync(upload.flac, { force: true });
          fs.rmSync(upload.mp3, { force: true });
        }
        return;
      }
      // Upload a song as a library track (source for Remix / Modifica, mixer, editor, Audio Lab).
      if (req.method === 'POST' && url.pathname === '/api/library/upload') {
        const upload = await receiveUpload(req, {
          dir: path.join(dataDir, 'audio'),
          tmpDir: path.join(dataDir, 'uploads-tmp'),
          probe: audioSeconds,
        });
        const workspaceId = workspaceIdOf(req.headers['x-workspace'] || undefined);
        const job = {
          id: upload.id,
          group: randomUUID(),
          title: upload.title,
          workspaceId,
          variant: 1,
          kind: 'upload',
          input: {
            title: upload.title,
            tags: 'uploaded track',
            lyrics: '',
            instrumental: true,
            durationMode: 'manual',
            duration: Math.round(upload.seconds),
            bpm: 110,
            variants: 1,
            language: 'unknown',
            keyscale: 'C major',
            timesignature: '4',
            quality: 'light',
            finish: 'fast',
            vocal: 'auto',
            seed: -1,
          },
          status: 'done',
          phase: 'Complete',
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          favorite: false,
          archived: false,
          assets: { flac: `${upload.id}.flac`, mp3: `${upload.id}.mp3` },
        };
        db.jobs.unshift(job);
        persist();
        broadcast();
        json(res, 201, job);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/workspaces') {
        const name = workspaceName((await bodyOf(req)).name);
        if (db.workspaces.length >= 20) throw new Error('You can create up to 20 workspaces.');
        if (db.workspaces.some(w => w.name.toLowerCase() === name.toLowerCase()))
          throw new Error('A workspace with this name already exists.');
        const workspace = { id: randomUUID(), name };
        db.workspaces.push(workspace);
        persist();
        broadcast();
        json(res, 201, workspace);
        return;
      }
      const workspaceMatch = /^\/api\/workspaces\/([a-z0-9-]{1,36})$/.exec(url.pathname);
      if (workspaceMatch && ['PATCH', 'DELETE'].includes(req.method)) {
        const workspace = db.workspaces.find(w => w.id === workspaceMatch[1]);
        if (!workspace) {
          json(res, 404, { error: 'Workspace not found.' });
          return;
        }
        if (req.method === 'PATCH') {
          const name = workspaceName((await bodyOf(req)).name);
          if (db.workspaces.some(w => w.id !== workspace.id && w.name.toLowerCase() === name.toLowerCase()))
            throw new Error('A workspace with this name already exists.');
          workspace.name = name;
        } else {
          if (workspace.id === GENERAL) throw new Error('The General workspace cannot be deleted.');
          // Rules: deleting a workspace never deletes songs: they move to General.
          for (const job of db.jobs) if (job.workspaceId === workspace.id) job.workspaceId = GENERAL;
          db.workspaces = db.workspaces.filter(w => w.id !== workspace.id);
        }
        persist();
        broadcast();
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reconnect') {
        json(res, 200, await checkHealth());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        json(res, 200, { message: 'Sonora stopped. Jobs already submitted will continue in ComfyUI.' });
        setImmediate(close);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/editor/import') {
        json(res, 202, await editor.importSong(req));
        return;
      }
      if (req.method === 'DELETE' && /^\/api\/editor\/([a-f0-9-]{36})$/.test(url.pathname)) {
        const [, id] = /^\/api\/editor\/([a-f0-9-]{36})$/.exec(url.pathname);
        json(res, 200, editor.remove(id));
        return;
      }
      const edit = /^\/api\/editor\/([a-f0-9-]{36})\/(separate|voice|settings|mix|cover|audio)$/.exec(
        url.pathname
      );
      if (edit) {
        const [, id, operation] = edit;
        if (req.method === 'POST' && operation === 'separate') {
          const body = await bodyOf(req);
          json(res, 202, await editor.separate(id, { instrumental: body.instrumental === true }));
          return;
        }
        if (req.method === 'POST' && operation === 'voice') {
          json(res, 202, await editor.importVoice(id, req));
          return;
        }
        if (req.method === 'PATCH' && operation === 'settings') {
          json(res, 200, editor.settings(id, await bodyOf(req)));
          return;
        }
        if (req.method === 'POST' && operation === 'mix') {
          json(res, 202, await editor.exportMix(id, await bodyOf(req)));
          return;
        }
        if (req.method === 'POST' && operation === 'cover') {
          json(res, 202, { job: await cover(id, await bodyOf(req)) });
          return;
        }
        if (['GET', 'HEAD'].includes(req.method) && operation === 'audio') {
          const kind = url.searchParams.get('kind'),
            format = url.searchParams.get('format') === 'mp3' ? 'mp3' : 'flac';
          let file = editor.media(id, kind, url.searchParams.get('id'));
          const title = editor.title(id) || db.jobs.find(j => j.id === id)?.title || 'Sonora';
          if (format === 'mp3') {
            file = await editor.ensureMp3(file);
          }
          const stemLabel = kind === 'base' ? 'backing' : kind === 'voice' ? 'vocals' : kind;
          sendFile(
            req,
            res,
            file,
            format === 'mp3' ? 'audio/mpeg' : 'audio/flac',
            url.searchParams.has('download') ? `${title}-${stemLabel}.${format}` : null
          );
          return;
        }
      }
      const stemRoute =
        /^\/api\/stems\/([a-f0-9-]{36})\/(separate|export|audio|layer|grid|external)(?:\/([a-f0-9-]{36}))?$/.exec(
          url.pathname
        );
      if (stemRoute) {
        const [, id, operation, layerId] = stemRoute;
        if (req.method === 'POST' && operation === 'separate') {
          json(res, 202, stems.separate(id));
          return;
        }
        if (req.method === 'POST' && operation === 'grid') {
          json(res, 200, { grid: await stems.ensureGrid(id) });
          return;
        }
        if (req.method === 'POST' && operation === 'external' && !layerId) {
          let name = 'External audio';
          try {
            name = decodeURIComponent(req.headers['x-audio-name'] || name);
          } catch {}
          const entry = await stems.addExternal(id, req, { name, kind: req.headers['x-audio-kind'] });
          json(res, 201, { external: entry });
          return;
        }
        if (req.method === 'DELETE' && operation === 'external' && layerId) {
          stems.removeExternal(id, layerId);
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && operation === 'layer' && !layerId) {
          json(res, 202, { job: await addLayerJob(id, await bodyOf(req)) });
          return;
        }
        if (req.method === 'DELETE' && operation === 'layer' && layerId) {
          stems.removeLayer(id, layerId);
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && operation === 'export') {
          const parent = getJob(id);
          if (!parent) throw new Error('Track not found.');
          const files = await stems.mixdown(id, await bodyOf(req));
          json(res, 201, { job: addStemMix(parent, files) });
          return;
        }
        if (['GET', 'HEAD'].includes(req.method) && operation === 'audio') {
          const name = url.searchParams.get('stem'),
            format = url.searchParams.get('format') === 'flac' ? 'flac' : 'mp3';
          sendFile(
            req,
            res,
            stems.media(id, name, format),
            format === 'flac' ? 'audio/flac' : 'audio/mpeg',
            url.searchParams.has('download') ? `${getJob(id)?.title || 'Sonora'}-${name}.${format}` : null
          );
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/audio-lab/sessions') {
        json(res, 202, lab.create(await bodyOf(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/audio-lab/import') {
        json(res, 202, await lab.importFile(req));
        return;
      }
      const labRoute =
        /^\/api\/audio-lab\/([a-f0-9-]{36})(?:\/(analyze|reference|preview|advice|cancel|audio)|\/renders\/([a-f0-9-]{36})(\/save|\/library)?)?$/.exec(
          url.pathname
        );
      if (labRoute) {
        const [, id, operation, renderId, saveRender] = labRoute;
        if (req.method === 'DELETE' && !operation && !renderId) {
          json(res, 200, lab.remove(id));
          return;
        }
        if (req.method === 'DELETE' && renderId && !saveRender) {
          json(res, 200, lab.removeRender(id, renderId));
          return;
        }
        if (req.method === 'POST' && renderId && saveRender === '/library') {
          json(res, 200, lab.toLibrary(id, renderId));
          return;
        }
        if (req.method === 'POST' && renderId && saveRender) {
          json(res, 202, lab.saveRender(id, renderId));
          return;
        }
        if (req.method === 'POST' && operation === 'analyze') {
          json(res, 202, lab.analyze(id));
          return;
        }
        if (req.method === 'POST' && operation === 'reference') {
          json(res, 202, await lab.reference(id, req));
          return;
        }
        if (req.method === 'POST' && operation === 'preview') {
          json(res, 202, await lab.preview(id, await bodyOf(req)));
          return;
        }
        if (req.method === 'POST' && operation === 'advice') {
          json(res, 200, await lab.advice(id, await bodyOf(req)));
          return;
        }
        if (req.method === 'POST' && operation === 'cancel') {
          json(res, 200, lab.cancel(id));
          return;
        }
        if (['GET', 'HEAD'].includes(req.method) && operation === 'audio') {
          const kind = url.searchParams.get('kind'),
            format = url.searchParams.get('format') === 'mp3' ? 'mp3' : 'flac',
            file = lab.media(id, kind, url.searchParams.get('id'), format);
          const title = lab.snapshot().sessions.find(s => s.id === id)?.title || 'Sonora',
            suffix = { render: 'master', reference: 'riferimento', source: 'originale' }[kind];
          sendFile(
            req,
            res,
            file,
            format === 'mp3' ? 'audio/mpeg' : 'audio/flac',
            url.searchParams.has('download') ? `${title}-${suffix}.${format}` : null
          );
          return;
        }
      }
      const match = /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|audio|workflow|rework))?$/.exec(url.pathname);
      if (match) {
        const job = db.jobs.find(j => j.id === match[1]);
        if (!job) {
          json(res, 404, { error: 'Track not found.' });
          return;
        }
        if (req.method === 'PATCH' && !match[2]) {
          const b = await bodyOf(req),
            fields = {};
          if (b.title !== undefined) {
            if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 100)
              throw new Error('Invalid title.');
            fields.title = b.title.trim();
          }
          if (b.workspaceId !== undefined) fields.workspaceId = workspaceIdOf(b.workspaceId);
          for (const k of ['favorite', 'archived'])
            if (b[k] !== undefined) {
              if (typeof b[k] !== 'boolean') throw new Error('Invalid value.');
              fields[k] = b[k];
            }
          if (fields.archived && !TERMINAL.has(job.status))
            throw new Error('Wait for the track to finish or cancel it before archiving.');
          change(job, fields);
          json(res, 200, job);
          return;
        }
        if (req.method === 'POST' && match[2] === 'rework') {
          json(res, 202, { job: await rework(job.id, await bodyOf(req)) });
          return;
        }
        if (req.method === 'POST' && match[2] === 'cancel') {
          if (TERMINAL.has(job.status)) {
            json(res, 200, job);
            return;
          }
          if (job.status === 'submitting') throw new Error('Wait for the job to be submitted.');
          if (job.backend === 'runpod') {
            await runpod.cancel(job);
            change(job, { cancelRequested: true, status: 'cancelling', phase: 'Cancelling…' });
            json(res, 200, job);
            return;
          }
          await comfy('/queue', { delete: [job.promptId] });
          await comfy('/interrupt', { prompt_id: job.promptId });
          change(job, { cancelRequested: true, status: 'cancelling', phase: 'Cancelling…' });
          json(res, 200, job);
          return;
        }
        if (['GET', 'HEAD'].includes(req.method) && match[2] === 'audio') {
          const format = url.searchParams.get('format') || 'mp3';
          if (format === 'wav' && job.assets.flac === `${job.id}.flac`) {
            const target = path.join(dataDir, 'audio', `${job.id}.wav`);
            await cpu(() => exportWav(path.join(dataDir, 'audio', job.assets.flac), target));
            sendFile(
              req,
              res,
              target,
              'audio/wav',
              url.searchParams.has('download') ? `${job.title}.wav` : null
            );
            return;
          }
          if (!['mp3', 'flac'].includes(format) || job.assets[format] !== `${job.id}.${format}`) {
            json(res, 404, { error: 'Audio is unavailable.' });
            return;
          }
          sendFile(
            req,
            res,
            path.join(dataDir, 'audio', job.assets[format]),
            format === 'mp3' ? 'audio/mpeg' : 'audio/flac',
            url.searchParams.has('download') ? `${job.title}.${format}` : null
          );
          return;
        }
        if (req.method === 'GET' && match[2] === 'workflow') {
          sendFile(
            req,
            res,
            path.join(dataDir, 'workflows', job.id + '.json'),
            'application/json',
            `${job.title}-workflow.json`
          );
          return;
        }
      }
      const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
        '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/audio-lab-worklet.js': ['audio-lab-worklet.js', 'text/javascript; charset=utf-8'],
        '/fx-worklet.js': ['fx-worklet.js', 'text/javascript; charset=utf-8'],
        '/rec-worklet.js': ['rec-worklet.js', 'text/javascript; charset=utf-8'],
        ...Object.fromEntries(
          [
            'prompt-ui',
            'prompt-core',
            'prompt-presets',
            'prompt-adapter',
            'song-duration',
            'duration-field',
            'auto-meta',
            'create-ui',
            'editor-ui',
            'mixer-ui',
            'timeline-ui',
            'fx',
            'dsp-fx',
            'audio-lab-ui',
            'audio-lab-dsp',
            'trainer-ui',
          ].map(name => ['/' + name + '.mjs', [name + '.mjs', 'text/javascript; charset=utf-8']])
        ),
      };
      if (['GET', 'HEAD'].includes(req.method) && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        sendFile(req, res, path.join(ROOT, 'public', file), type);
        return;
      }
      json(res, 404, { error: 'Resource not found.' });
    } catch (e) {
      if (!res.headersSent) {
        const [status, error] = failure(e);
        json(res, status, { error });
      } else res.destroy();
    }
  });
  const timer = setInterval(poll, pollMs);
  const sessionTimer = setInterval(() => gpuSession.reconcile().catch(() => {}), 5000);
  const trainingTimer = setInterval(() => trainer.poll().catch(() => {}), 10000);
  trainingTimer.unref();
  sessionTimer.unref();
  gpuSession.reconcile().catch(() => {});
  timer.unref();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  function close() {
    stopped = true;
    modelSetup.cancel();
    editor.close();
    stems.close();
    lab.close();
    clearTimeout(broadcastTimer);
    clearInterval(timer);
    clearInterval(sessionTimer);
    clearInterval(trainingTimer);
    clearInterval(heartbeat);
    clearTimeout(reconnect);
    socket?.close();
    for (const res of clients) res.end();
    persist();
    return vast.close().then(() => new Promise(resolve => server.close(resolve)));
  }
  return { server, close, checkHealth, poll };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.env.SONORA_CONFIG || path.join(ROOT, 'config.json');
  const config = {
    ...DEFAULT_CONFIG,
    ...(fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}),
  };
  const app = createStudio(config);
  app.server.on('error', err => {
    console.error(
      err.code === 'EADDRINUSE' ? 'Sonora Studio is already running or the port is in use.' : err.message
    );
    process.exit(1);
  });
  app.server.listen(config.port, '127.0.0.1', () => {
    console.log(`Sonora Studio: http://127.0.0.1:${config.port}`);
    app.checkHealth();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
