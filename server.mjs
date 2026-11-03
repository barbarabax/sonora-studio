// @codedna
// description: Loopback HTTP studio, durable job library, scoped ComfyUI queue bridge, stem editor and Audio Lab.
// exports: createStudio
// used_by: none
// rules:   Keep media paths server-owned and enforce local Host and same-origin mutations.
// agent:   Codex - 2026-10-04 - Initial local studio and recovery implementation.
//          Claude - 2026-10-04 - Audio Lab routes and a CPU lock shared with the editor.
//          Codex - 2026-10-10 - Trainer import and track removal routes.
//          Codex - 2026-10-15 - Guard YuE2 generation during its training.
//          Codex - 2026-10-15 - Serve the cover lyrics comparison module from the explicit public allowlist.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomInt } from 'node:crypto';
import {
  buildWorkflow,
  validateInput,
  withoutInstrumentalWords,
  seedsFor,
  historyFailure,
  harmonyField,
  resolveModelName,
  TERMINAL,
  LANGUAGES,
  KEYS,
} from './lib.mjs';
import { createPromptAI } from './prompt-ai.mjs';
import { createAudioEditor } from './audio-editor.mjs';
import { createAudioLab, createCpuLock } from './audio-lab.mjs';
import { probeDuration, excerpt, excerptWindow } from './ai-audio.mjs';
import { createRunpodBackend } from './runpod-backend.mjs';
import { createLocalYue2 } from './yue2-local.mjs';
import { createCppYue2 } from './yue2-cpp.mjs';
import { createYue2Adapters } from './yue2-adapters.mjs';
import { createYue2Trainer } from './yue2-trainer.mjs';
import { COVER_MAX_SECONDS, TRANSCRIBE_MAX_SECONDS, prepareCoverAudio, fadeOutEnd } from './yue2-cover.mjs';
import { exportWav } from './wav-export.mjs';
import { createGpuSession } from './gpu-session.mjs';
import { createLoraTrainer } from './lora-trainer.mjs';
import { createVastComfyBackend } from './vast-comfy-backend.mjs';
import { createProviderSecrets } from './provider-secrets.mjs';
import { createModelSetup } from './model-setup.mjs';
import { createYue2Models } from './yue2-models.mjs';
import { createSetupCheck } from './setup-check.mjs';
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
  4: 'Musical preparation',
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
  const index = argv.findIndex(
    a => typeof a === 'string' && (a === '--base-directory' || a.startsWith('--base-directory='))
  );
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
  const savedProviders = fs.existsSync(providerFile) ? JSON.parse(fs.readFileSync(providerFile, 'utf8')) : {};
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
    throw new Error('Invalid ComfyUI address.');
  let localComfyUrl = base.href.replace(/\/$/, '');
  const providerSecrets = createProviderSecrets({ dataDir });
  const yue2Models = createYue2Models({
    onChange: () => broadcast(),
    ...(modelFetch ? { fetchImpl: modelFetch } : {}),
  });
  const setupCheck = createSetupCheck();
  const runpodSettings = {
    ...(config.runpod || {}),
    ...(savedProviders.runpod || {}),
    model: config.model,
  };
  const vastSettings = { ...(savedProviders.vast || {}) };
  // Rules: YuE2 settings entered in the app win over config.json; the engine files are only read after a restart.
  const yue2Settings = { endpointId: savedProviders.yue2?.endpointId || config.yue2?.endpointId || '' };
  let yue2CppConfig = savedProviders.yue2?.cpp || config.yue2?.cpp;
  function saveProviderSettings() {
    const safe = {
      comfyUrl: localComfyUrl,
      comfyRoot: localModelsRoot,
      runpod: {
        endpointId: runpodSettings.endpointId || '',
        modelsReady: runpodSettings.modelsReady === true,
      },
      vast: { instanceId: vastSettings.instanceId || null },
      yue2: { endpointId: yue2Settings.endpointId || '', ...(yue2CppConfig ? { cpp: yue2CppConfig } : {}) },
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
    throw new Error('Public origin: use only an HTTPS address with no path.');
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
  if (!['local', 'runpod'].includes(generationBackend)) throw new Error('Invalid generation service.');
  const runpod = createRunpodBackend(runpodSettings, {
    ...(runpodFetch ? { fetchImpl: runpodFetch } : {}),
    keyReader: runpodKeyReader || (() => providerSecrets.get('runpod')),
  });
  const vast = createVastComfyBackend({
    dataDir,
    keyReader: () => providerSecrets.get('vast'),
    ...(vastFetch ? { fetchImpl: vastFetch } : {}),
    ...(vastSpawn ? { spawnImpl: vastSpawn } : {}),
    onChange: () => broadcast(),
  });
  const comfyUrl = () => (generationBackend === 'vast' && vast.baseUrl ? vast.baseUrl : localComfyUrl);
  // YuE2: its own RunPod endpoint (config.yue2.endpointId, same transfer protocol as the ComfyUI worker) and/or this
  // computer's GPU (config.yue2.local.python). A song remembers where it was made in job.remote.host.
  const yue2RunpodSettings = {
    endpointId: yue2Settings.endpointId,
    modelsReady: !!yue2Settings.endpointId,
    model: 'YuE2-3B',
  };
  const yue2Runpod = createRunpodBackend(yue2RunpodSettings, {
    ...(runpodFetch ? { fetchImpl: runpodFetch } : {}),
    keyReader: runpodKeyReader || (() => providerSecrets.get('runpod')),
  });
  // Rules: on this PC yue2.cpp handles generation when configured; SheetSage2 in the Python worker transcribes covers first.
  // Songs started with Python (no remote.engine) keep being followed by the Python backend.
  const yue2Python = createLocalYue2(config.yue2?.local, { dataDir });
  const yue2Cpp = createCppYue2(yue2CppConfig, { dataDir });
  // Rules: with the engine on another computer its LoRAs are the ones it loaded at start (/props); they cannot be installed from here.
  let remoteLora = [];
  const refreshRemoteLora = async () => {
    if (!yue2Cpp.remote) return;
    const names = await yue2Cpp.engineAdapters();
    if (names) remoteLora = names;
  };
  const ofJob = job => (job.remote?.engine === 'cpp' ? yue2Cpp : yue2Python);
  const yue2Adapters = createYue2Adapters({
    dir:
      yue2Cpp.configured && !yue2CppConfig?.remote
        ? yue2CppConfig?.adapters || path.join(dataDir, 'yue2-adapters')
        : null,
    onChange: () => yue2Cpp.adaptersChanged(),
    // the user's own LoRA trained on RunPod (yue2-trainer.mjs), listed with the catalogue
    extra: () =>
      (yue2Trainer?.trained() || []).map(t => ({
        id: t.id,
        kind: 'Your LoRAs',
        name: t.name,
        description: `Trained by you (${t.step} steps). Sonora adds the keyword «${t.trigger}» by itself at the start of the style.`,
        author: 'te',
        page: '',
        trigger: t.trigger,
        scales: { ar: 1, nar: 1 },
        files: [],
        trained: true,
      })),
  });
  let yue2Trainer = null;
  // Rules: on RunPod the LoRA live on the volume (installed by the worker's `adapters` action); Sonora remembers what the
  // worker last reported in yue2-runpod-lora.json, so listing them never starts a GPU.
  const runpodLoraFile = path.join(dataDir, 'yue2-runpod-lora.json');
  const runpodLora = () => {
    try {
      return { installed: [], cpp: false, ...JSON.parse(fs.readFileSync(runpodLoraFile, 'utf8')) };
    } catch {
      return { installed: [], cpp: false };
    }
  };
  const rememberRunpodLora = report => {
    if (!report || !Array.isArray(report.installed)) return;
    fs.writeFileSync(
      runpodLoraFile,
      JSON.stringify({ installed: report.installed, cpp: !!report.cpp, checkedAt: new Date().toISOString() })
    );
  };
  /** The engine fields for the chosen YuE2 LoRA. Rules: only yue2.cpp reads them (on this PC or on the RunPod volume), and only installed ones. */
  function yueAdapterFields(list, host) {
    if (!list?.length) return {};
    if (host === 'runpod') {
      const state = runpodLora();
      if (!yue2Settings.endpointId) throw new Error('YuE2 on RunPod is not configured.');
      if (!state.cpp)
        throw new Error(
          'On RunPod the yue2.cpp engine is not installed yet: LoRAs only work on the PC for now.'
        );
      for (const a of list)
        if (!state.installed.includes(a.id))
          throw new Error(`The LoRA «${yue2Adapters.entry(a.id).name}» is not installed on RunPod.`);
    } else {
      if (host !== 'local' || !yue2Cpp.configured)
        throw new Error('YuE2 LoRAs only work on the PC, with the yue2.cpp engine.');
      for (const a of list)
        if (yue2Cpp.remote ? !remoteLora.includes(a.id) : !yue2Adapters.isInstalled(a.id))
          throw new Error(
            yue2Cpp.remote
              ? `The engine on your other computer has not loaded the LoRA «${yue2Adapters.entry(a.id).name}»: put it in its adapters folder there and restart yue-server.`
              : `The LoRA «${yue2Adapters.entry(a.id).name}» is not installed.`
          );
    }
    return { adapters: list.map(a => ({ name: a.id, ar: a.ar, nar: a.nar })) };
  }
  /** Rules: a LoRA trained with a trigger word needs it at the start of the style; it is added once if the user did not write it. */
  function withTriggers(style, list) {
    const words = (list || [])
      .map(a => yue2Adapters.entry(a.id).trigger)
      .filter(t => t && !new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`, 'i').test(style));
    return words.length ? `${words.join(' ')}, ${style}` : style;
  }
  const yue2Local = yue2Cpp.configured
    ? {
        configured: true,
        health: () => yue2Cpp.health(),
        call: async (input, waitMs) => {
          if (
            input.action === 'transcribe' &&
            yue2Python.configured &&
            config.yue2?.local?.sheetsage?.python &&
            config.yue2?.local?.sheetsage?.repo
          ) {
            try {
              return await yue2Python.call(input, waitMs);
            } catch {
              return yue2Cpp.call(input, waitMs);
            }
          }
          return yue2Cpp.call(input, waitMs);
        },
        submitAction: input => yue2Cpp.submitAction(input),
        status: job => ofJob(job).status(job),
        cancel: job => ofJob(job).cancel(job),
        collect: (job, output, dir, onProgress) => ofJob(job).collect(job, output, dir, onProgress),
      }
    : yue2Python;
  const yue2Configured = () => !!yue2Settings.endpointId || yue2Local.configured;
  const yue2Host = host => (host === 'local' ? yue2Local : yue2Runpod);
  /** 'runpod' or 'local': what the user asked for when it exists, otherwise what is configured (RunPod first). */
  function pickYue2Host(requested) {
    if (requested === 'local' && yue2Local.configured) return 'local';
    if (requested === 'runpod' && yue2Settings.endpointId) return 'runpod';
    if (yue2Settings.endpointId) return 'runpod';
    if (yue2Local.configured) return 'local';
    throw new Error('YuE2 is not configured: the RunPod endpoint and the PC Python are missing.');
  }
  let musicModel = 'ace-step';
  const gpuSession = createGpuSession({
    dataDir,
    endpointId: runpodSettings.endpointId,
    getEndpointId: () => runpodSettings.endpointId,
    remote: runpod,
    onChange: () => broadcast(),
  });
  // a separate training endpoint is optional: without one, training uses the generation endpoint
  const trainingSettings = config.runpodTraining ? { ...config.runpodTraining } : runpodSettings;
  const trainer = createLoraTrainer({
    dataDir,
    endpointId: trainingSettings.endpointId,
    remote: createRunpodBackend(trainingSettings, {
      ...(runpodFetch ? { fetchImpl: runpodFetch } : {}),
      keyReader: runpodKeyReader || (() => providerSecrets.get('runpod')),
    }),
    publicOrigin: publicOrigin?.origin,
    model: config.model,
    onChange: () => broadcast(),
    cpu: task => cpu(task),
    probe: audio.probeDuration,
  });
  yue2Trainer = createYue2Trainer({
    dataDir,
    runpod: yue2Runpod,
    projects: () => trainer.snapshot().projects,
    trackFile: (project, track) => path.join(dataDir, 'trainer', project.id, track.id + track.ext),
    // a finished LoRA is on the RunPod volume: list it as installed there
    onTrained: lora => {
      const state = runpodLora();
      rememberRunpodLora({ installed: [...new Set([...state.installed, lora.id])], cpp: true });
    },
    onChange: () => broadcast(),
  });
  const promptStore = createPromptStore({ dataDir, onChange: () => broadcast() });
  const dbFile = path.join(dataDir, 'library.json');
  const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : { version: 1, jobs: [] };
  if (db.version !== 1 || !Array.isArray(db.jobs))
    throw new Error('Invalid library: restore a backup, without overwriting the data.');
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
      throw new Error('Workspace name: 1 to 40 characters.');
    return value.trim();
  };
  const clients = new Set();
  const clientId = randomUUID();
  let health = { online: false, ready: false, message: 'Connecting to ComfyUI…' };
  let resolvedNames = {}; // model names as the local ComfyUI lists them (sub-folders included)
  let comfyListed = {}; // which of the four ACE-Step files the local ComfyUI lists at all (wherever they live on disk)
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
    health: { ...health, musicModel },
    gpuSession: gpuSession.status(),
    trainer: trainer.snapshot(),
    yue2Training: yue2Trainer.snapshot(),
    modelSetup: modelSetupView(),
    yue2Models: yue2Models.snapshot(),
    editor: editor.snapshot(),
    audioLab: lab.snapshot(),
    stems: stems.snapshot(),
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
      phase: 'Done',
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
  function addImportedStemSong(id, files) {
    if (getJob(id)) return getJob(id);
    for (const ext of ['flac', 'mp3']) {
      const target = path.join(dataDir, 'audio', `${id}.${ext}`);
      fs.copyFileSync(files[ext], target + '.tmp');
      fs.renameSync(target + '.tmp', target);
    }
    const now = new Date().toISOString();
    const job = {
      id,
      group: randomUUID(),
      title: files.title,
      workspaceId: files.workspaceId ?? GENERAL,
      variant: 1,
      kind: 'stem-import',
      input: {
        title: files.title,
        tags: 'stems imported',
        lyrics: '',
        instrumental: !files.stems.includes('vocals'),
        durationMode: 'manual',
        duration: Math.round(files.duration),
        bpm: 110,
        variants: 1,
        language: 'unknown',
        keyscale: 'C major',
        timesignature: '4',
        quality: 'light',
        finish: 'fast',
        vocal: 'auto',
        seed: -1,
        musicModel: 'ace-step',
      },
      status: 'done',
      phase: 'Done',
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
          tags: `${session.title} · file uploaded to Audio Lab`,
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
      phase: 'Done',
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
    if (musicModel === 'yue2') {
      await refreshRemoteLora();
      // Rules: the RunPod endpoint decides readiness when there is one; a song made on this PC skips this check at submit time.
      health = {
        ...(await (yue2Settings.endpointId ? yue2Runpod : yue2Local).health()),
        backend: 'yue2',
        model: 'YuE2-3B',
        fullAvailable: true,
        sftAvailable: false,
      };
      if (!yue2Configured())
        health = {
          ...health,
          online: false,
          ready: false,
          message: 'YuE2 is not configured: the RunPod endpoint and the PC Python are missing.',
        };
      broadcast();
      return health;
    }
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
      const listed = (node, key) => info[node]?.input?.required?.[key]?.[0];
      const has = (node, key, value) => listed(node, key)?.includes(value);
      // Rules: models kept in sub-folders are found by file name; the resolved names are used for ComfyUI only, never for RunPod.
      resolvedNames = {
        model: resolveModelName(config.model, listed('UNETLoader', 'unet_name')),
        encoder: resolveModelName(config.encoder, listed('DualCLIPLoader', 'clip_name1')),
        planner: resolveModelName(config.planner, listed('DualCLIPLoader', 'clip_name2')),
        vae: resolveModelName(config.vae, listed('VAELoader', 'vae_name')),
      };
      comfyListed = {
        model: !!has('UNETLoader', 'unet_name', resolvedNames.model),
        encoder: !!has('DualCLIPLoader', 'clip_name1', resolvedNames.encoder),
        planner: !!has('DualCLIPLoader', 'clip_name2', resolvedNames.planner),
        vae: !!has('VAELoader', 'vae_name', resolvedNames.vae),
      };
      if (!has('UNETLoader', 'unet_name', resolvedNames.model)) missing.push(config.model);
      if (!has('DualCLIPLoader', 'clip_name1', resolvedNames.encoder)) missing.push(config.encoder);
      if (!has('DualCLIPLoader', 'clip_name2', resolvedNames.planner)) missing.push(config.planner);
      if (!has('VAELoader', 'vae_name', resolvedNames.vae)) missing.push(config.vae);
      health = {
        online: true,
        ready: missing.length === 0,
        fullAvailable: has('DualCLIPLoader', 'clip_name2', resolvedNames.planner),
        message: missing.length ? `Missing: ${missing.join(', ')}` : 'Ready to create',
        gpu: stats.devices?.[0]?.name,
        model: config.model,
        ...(comfyBaseDirectory(stats) ? { comfyBase: comfyBaseDirectory(stats) } : {}),
        missingModels: [
          !has('UNETLoader', 'unet_name', resolvedNames.model) && {
            category: 'diffusion_models',
            name: config.model,
          },
          !has('DualCLIPLoader', 'clip_name1', resolvedNames.encoder) && {
            category: 'text_encoders',
            name: config.encoder,
          },
          !has('DualCLIPLoader', 'clip_name2', resolvedNames.planner) && {
            category: 'text_encoders',
            name: config.planner,
          },
          !has('VAELoader', 'vae_name', resolvedNames.vae) && { category: 'vae', name: config.vae },
        ].filter(Boolean),
        missingNodes: names.filter(n => !info[n]),
        comfyUrl: comfyUrl(),
        backend: generationBackend,
      };
      connectSocket();
    } catch (e) {
      comfyListed = {};
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
    change(job, { status: 'saving', phase: 'Copying to the library', progress: null }, false);
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
        if (!r.ok) throw new Error('Cannot copy the audio from ComfyUI.');
        const bytes = Buffer.from(await r.arrayBuffer());
        if (bytes.length < 32) throw new Error('ComfyUI returned an empty audio file.');
        fs.writeFileSync(target + '.tmp', bytes);
        fs.renameSync(target + '.tmp', target);
      }
      assets[ext] = filename;
    }
    if (!assets.mp3 || !assets.flac) throw new Error('MP3/FLAC audio not found in the ComfyUI history.');
    change(job, {
      assets,
      status: 'done',
      phase: 'Done',
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
      for (const job of active.filter(j => ['runpod', 'yue2'].includes(j.backend))) {
        const remoteBackend = job.backend === 'yue2' ? yue2Host(job.remote?.host) : runpod;
        const provider =
          job.backend === 'yue2' ? (job.remote?.host === 'local' ? 'YuE2 on the PC' : 'YuE2') : 'RunPod';
        try {
          const result = job.remoteAudio
            ? { status: 'COMPLETED', output: job.remoteAudio }
            : await remoteBackend.status(job);
          if (result.status === 'COMPLETED' && result.output?.error) {
            change(job, {
              status: 'failed',
              phase: `${provider} error`,
              error: 'The worker did not complete the generation.',
            });
          } else if (result.status === 'COMPLETED') {
            // Rules: the semantic codes of a yue2.cpp song (tens of KB) live in data/yue2-replay/<id>.json, never in the library file.
            if (!job.remoteAudio && result.output?.replay) {
              const { replay, ...rest } = result.output;
              if (
                typeof replay.semanticTokens === 'string' &&
                /^[0-9]+(,[0-9]+)*$/.test(replay.semanticTokens)
              ) {
                fs.mkdirSync(path.join(dataDir, 'yue2-replay'), { recursive: true });
                fs.writeFileSync(path.join(dataDir, 'yue2-replay', `${job.id}.json`), JSON.stringify(replay));
                rest.hasReplay = true;
              }
              result.output = rest;
            }
            if (!job.remoteAudio)
              change(job, {
                remoteAudio: result.output,
                status: 'saving',
                phase: `Copying audio from ${provider}`,
                remoteTiming: { delayMs: result.delayTime, executionMs: result.executionTime },
              });
            const assets = job.rework?.spliced
              ? { flac: `${job.id}.flac`, mp3: `${job.id}.mp3` }
              : await remoteBackend.collect(job, result.output, dataDir, (copied, total) => {
                  // Rules: a percentage, not a stream of broadcasts: only when it changes.
                  const percent = Math.min(99, Math.floor((100 * copied) / Math.max(total, 1)));
                  if (job.copyPercent !== percent) {
                    job.copyPercent = percent;
                    change(job, { phase: `Copying audio from ${provider} · ${percent}%` }, false);
                  }
                });
            // Rules: a cover made from an original cut at 5:30 would stop mid-phrase: its last 6 seconds fade out (once)
            if (job.backend === 'yue2' && job.input.cover?.trimmed && !job.faded) {
              const length = Number(result.output?.duration) || 0;
              for (const name of [assets.flac, assets.mp3].filter(Boolean))
                await fadeOutEnd(path.join(dataDir, 'audio', name), length);
              job.faded = true;
            }
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
              phase: 'Done',
              completedAt: new Date().toISOString(),
              error: null,
              // Rules: a YuE2 song keeps the melody-and-chords plan it was sung from (editable later) and its real length.
              ...(job.backend === 'yue2' && typeof job.remoteAudio?.abc === 'string'
                ? {
                    yue: {
                      abc: job.remoteAudio.abc,
                      cot: job.remoteAudio.cot,
                      seed: job.remoteAudio.seed,
                      ...(job.remoteAudio.hasReplay ? { replay: true } : {}),
                    },
                    input: {
                      ...job.input,
                      seed: job.remoteAudio.seed ?? job.input.seed,
                      ...(Number.isFinite(job.remoteAudio.duration)
                        ? { duration: Math.round(job.remoteAudio.duration) }
                        : {}),
                    },
                  }
                : {}),
            });
            if (job.kind === 'layer')
              stems.addLayer(job.rework.parentId, { id: job.id, name: job.rework.layerName });
          } else if (['FAILED', 'TIMED_OUT', 'CANCELLED', 'LOST'].includes(result.status)) {
            const cancelled = result.status === 'CANCELLED';
            change(job, {
              status: cancelled ? 'cancelled' : 'failed',
              phase: cancelled ? 'Cancelled' : `${provider} error`,
              error: cancelled
                ? null
                : `${provider} job interrupted or result not recoverable. It is not resent.`,
            });
          } else if (result.status === 'IN_PROGRESS') {
            change(
              job,
              {
                status: job.cancelRequested ? 'cancelling' : 'running',
                phase: job.cancelRequested
                  ? 'Cancelling…'
                  : `Generating on ${provider}${result.progress ? ' · ' + result.progress : ''}`,
              },
              false
            );
          }
        } catch (e) {
          change(
            job,
            {
              phase: job.remoteAudio
                ? 'Audio copy interrupted · automatic retry'
                : `Reconnecting to ${provider}`,
              error: e.message,
            },
            false
          );
        }
      }
      const local = active.filter(j => !['runpod', 'yue2'].includes(j.backend));
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
              change(job, { status: 'saving', phase: 'Audio copy to retry', error: e.message }, false);
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
                : 'The job is no longer in the ComfyUI queue or history. You can reuse the settings to try again.',
            });
        }
      }
    } catch (e) {
      health = {
        ...health,
        online: false,
        ready: false,
        message: 'Connection to ComfyUI lost. Reconnecting automatically…',
      };
      broadcast();
    } finally {
      polling = false;
    }
  }
  async function submit(input, referenceAudio = null, parentId = null, workspaceId = GENERAL, extra = {}) {
    if (input.musicModel !== musicModel)
      throw new Error('The model has changed: select it again before generating.');
    const selectedBackend = musicModel === 'yue2' ? 'yue2' : generationBackend;
    if (selectedBackend === 'yue2') {
      pickYue2Host(input.yueHost);
      if (referenceAudio || extra.rework || parentId)
        throw new Error('YuE2 creates new songs: remix and new voice are not available.');
    }
    const yueHost = selectedBackend === 'yue2' ? pickYue2Host(input.yueHost) : null;
    if (yueHost) yueAdapterFields(input.yueAdapters, yueHost); // refuse missing LoRA before any job is created
    if (yueHost && input.yueHarmony && !input.abc) harmonyField(input.yueHarmony, input.lyrics); // and lyrics without sections to follow
    if (
      trainer.snapshot().projects.some(p => p.job && !['done', 'failed', 'cancelled'].includes(p.job.status))
    )
      throw new Error('Wait for the LoRA training to finish before generating.');
    if (selectedBackend === 'yue2' && yue2Trainer.active())
      throw new Error('Wait for the YuE2 training on RunPod to finish before generating.');
    if (input.loraId && input.loraScale > 0) {
      if (generationBackend !== 'runpod') throw new Error('The trained LoRA requires RunPod.');
      trainer.lora(input.loraId);
    }
    if (input.finish === 'final' && selectedBackend === 'runpod' && runpodSettings.sftReady !== true)
      throw new Error('The final model (SFT) is not installed on RunPod yet.');
    if (input.finish === 'final' && selectedBackend !== 'runpod')
      throw new Error('Final quality (SFT) requires RunPod.');
    if (extra.rework && selectedBackend !== 'runpod')
      throw new Error('Remix and regenerating a part require RunPod.');
    // Rules: on RunPod a reference audio can only travel as a file inside the request (`extra.sourceFile`).
    if (generationBackend === 'runpod' && referenceAudio && !extra.sourceFile)
      throw new Error('The new voice with reference audio is available with local ComfyUI.');
    // Rules: a reference audio (guides timbre) travels to the GPU like a remix source; it needs RunPod and is never combined with a remix.
    let referenceFile = null;
    if (input.referenceId) {
      if (selectedBackend !== 'runpod') throw new Error('Reference audio requires RunPod.');
      if (extra.rework) throw new Error('Remix and reference audio cannot be combined.');
      referenceFile = path.join(dataDir, 'references', `${input.referenceId}.mp3`);
      if (!fs.existsSync(referenceFile)) throw new Error('The reference audio is gone: upload it again.');
    }
    if (input.yueMelodyFreedom && (yueHost !== 'local' || !yue2Cpp.configured))
      throw new Error('Melodic freedom requires yue2.cpp on the PC.');
    if (yueHost === 'local') {
      const localHealth = await yue2Local.health();
      if (!localHealth.ready) throw new Error(localHealth.message);
    } else {
      if (!health.ready) await checkHealth();
      if (!health.ready) throw new Error(health.message);
    }
    if (input.quality === 'full' && !health.fullAvailable)
      throw new Error('Qwen 4B encoder not available. Choose Light mode.');
    if (db.jobs.filter(j => !TERMINAL.has(j.status)).length + input.variants > 12)
      throw new Error('The queue is full: wait for some songs to finish.');
    const group = randomUUID();
    const jobs = seedsFor(input).map((seed, i) => ({
      id: randomUUID(),
      promptId: randomUUID(),
      group,
      title: input.title,
      variant: i + 1,
      workspaceId,
      // Rules: YuE2 accepts seeds only up to 2^31-1 (ACE-Step up to 2^32-2): fold them or the worker rejects about half the songs.
      input: { ...input, seed: selectedBackend === 'yue2' ? seed % 2147483648 : seed },
      backend: selectedBackend,
      ...(selectedBackend === 'yue2'
        ? { remote: yueHost === 'local' ? { host: 'local' } : { endpointId: yue2Settings.endpointId } }
        : {}),
      ...(selectedBackend === 'runpod' ? { remote: { endpointId: runpodSettings.endpointId } } : {}),
      ...(selectedBackend === 'vast' ? { remote: { instanceId: vast.instanceId } } : {}),
      ...(parentId ? { parentId, kind: 'vocal-cover' } : {}),
      ...(extra.rework
        ? { parentId: extra.rework.parentId, kind: extra.rework.mode, rework: extra.rework }
        : {}),
      status: 'submitting',
      phase:
        selectedBackend === 'yue2'
          ? yueHost === 'local'
            ? 'Starting YuE2 on the PC'
            : 'Sending to YuE2'
          : generationBackend === 'runpod'
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
        if (job.backend === 'yue2') {
          const remote = await yue2Host(yueHost).submitAction({
            action: 'generate',
            localId: job.id,
            style: withTriggers(job.input.tags, job.input.yueAdapters),
            lyrics: job.input.lyrics,
            cot: job.input.yueCot ?? 'full',
            seed: job.input.seed,
            ...(job.input.yueMelodyFreedom ? { melodyFreedom: job.input.yueMelodyFreedom } : {}),
            ...(job.input.abc ? { abc: job.input.abc } : {}),
            ...yueAdapterFields(job.input.yueAdapters, yueHost),
            ...(job.input.yueHarmony && !job.input.abc
              ? { harmony: harmonyField(job.input.yueHarmony, job.input.lyrics) }
              : {}),
          });
          change(job, {
            remote,
            status: 'queued',
            phase: yueHost === 'local' ? 'Queued YuE2 on the PC' : 'Queued YuE2',
          });
          continue;
        }
        const source = extra.rework ? { audio: `Sonora/${job.id}.mp3`, denoise: extra.rework.denoise } : null;
        const prompt = buildWorkflow(
          job.input,
          job.input.seed,
          job.id,
          job.backend === 'runpod' ? config : { ...config, ...resolvedNames },
          referenceFile || (referenceAudio && extra.sourceFile && job.backend === 'runpod')
            ? `Sonora/${job.id}.mp3`
            : referenceAudio,
          source
        );
        if (job.input.loraId && (job.input.loraScale ?? 1) > 0) {
          if (job.backend !== 'runpod') throw new Error('The trained LoRA requires RunPod.');
          prompt['15'] = {
            class_type: 'LoraLoaderModelOnly',
            inputs: {
              model: ['1', 0],
              lora_name: trainer.lora(job.input.loraId),
              strength_model: job.input.loraScale ?? 1,
            },
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
          change(job, { remote, status: 'queued', phase: 'Queued RunPod' });
        } else {
          const result = await comfy('/prompt', { prompt, prompt_id: job.promptId, client_id: clientId });
          change(job, { promptId: result.prompt_id, status: 'queued', phase: 'Queued' });
        }
      } catch (e) {
        if (e.httpStatus) change(job, { status: 'failed', phase: 'Error', error: e.message });
        else
          change(job, {
            status: 'reconciling',
            phase: 'Verifying the job was received',
            error: 'No response from the service: checking without sending duplicates.',
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
      throw new Error('The song must be finished.');
    const mode = body.mode;
    if (!['remix', 'repaint'].includes(mode)) throw new Error('Invalid mode.');
    const denoise = Math.round(Number(body.strength ?? 0.5) * 100) / 100;
    if (!(denoise >= 0.2 && denoise <= 0.95)) throw new Error('Invalid strength (from 0.2 to 0.95).');
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
      if (!(a >= 0) || !(b > a) || b > total + 0.05) throw new Error('Invalid song range.');
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
      throw new Error('The duration to process must be between 10 and 300 seconds.');
    const input = validateInput({
      ...original.input,
      // Rules: when the result is sung, the style must not still say "no vocals" (the source may have been instrumental).
      tags: instrumental ? tags : withoutInstrumentalWords(tags),
      lyrics: instrumental ? original.input.lyrics || '' : lyrics,
      instrumental,
      referenceId: undefined,
      avoid: typeof body.avoid === 'string' ? body.avoid.slice(0, 500) : original.input.avoid,
      title: `${original.title} · ${mode === 'remix' ? 'remix' : 'ritocco'}`.slice(0, 100),
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
      throw new Error('The song must be finished.');
    const instrument = typeof body.instrument === 'string' ? body.instrument.trim() : '';
    if (!instrument || instrument.length > 120)
      throw new Error('Describe the instrument (maximum 120 characters).');
    const denoise = Math.round(Number(body.strength ?? 0.85) * 100) / 100;
    if (!(denoise >= 0.5 && denoise <= 0.95)) throw new Error('Invalid strength (from 0.5 to 0.95).');
    if ((stems.snapshot().sessions.find(x => x.id === id)?.layers.length ?? 0) >= 8)
      throw new Error('Maximum 8 added instruments per song.');
    const total = await audioSeconds(path.join(dataDir, 'audio', `${id}.flac`));
    if (total < 10 || total > 300) throw new Error('The song duration must be between 10 and 300 seconds.');
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
  let planning = false;
  async function cover(id, body) {
    const viaRunpod = generationBackend === 'runpod';
    if (covering.has(id)) throw new Error('Sending of the new voice already in progress.');
    covering.add(id);
    try {
      const reference = editor.coverReference(id),
        original = db.jobs.find(j => j.id === id);
      if (!original) throw new Error('ACE-Step cover is only available for library songs.');
      if (!viaRunpod) {
        const nodes = await comfy('/object_info');
        if (!['LoadAudio', 'VAEEncodeAudio', 'ReferenceTimbreAudio'].every(n => nodes[n]))
          throw new Error('The audio reference nodes are not available in ComfyUI.');
      }
      const input = validateInput({
        ...original.input,
        ...body,
        // Rules: the new voice sings, so the style must not still say "no vocals" (the base is usually instrumental).
        tags: withoutInstrumentalWords(String(body.tags ?? original.input.tags ?? '')),
        title: (original.title + ' · new voice').slice(0, 100),
        durationMode: 'manual',
        duration: Math.min(300, Math.max(10, Math.ceil(reference.duration))),
        durationOverrides: {},
        instrumental: false,
        quality: 'light',
        variants: 1,
        seed: body.seed ?? -1,
      });
      if (viaRunpod) {
        // Rules: on RunPod the base travels inside the request as a 128k MP3, like a remix source (the worker reads Sonora/<job id>.mp3).
        const sourceFile = path.join(dataDir, 'workflows', `${randomUUID()}-source.mp3`);
        fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
        try {
          await encodeSource(reference.file, sourceFile, {
            start: 0,
            length: Math.min(300, reference.duration),
          });
          const [job] = await submit(input, 'runpod-base', id, original.workspaceId ?? GENERAL, {
            sourceFile,
          });
          editor.trackCover(id, job.id);
          return job;
        } finally {
          fs.rmSync(sourceFile, { force: true });
        }
      }
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
      if (!response.ok) throw new Error('ComfyUI did not accept the audio backing.');
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
    if (e.name === 'TimeoutError') return [504, 'The external service did not respond in time. Try again.'];
    if (e.httpStatus) return [502, e.message];
    if (e instanceof TypeError && /fetch failed/i.test(e.message))
      return [502, 'External service unreachable (ComfyUI or DeepSeek).'];
    if (
      e instanceof TypeError ||
      e instanceof ReferenceError ||
      e instanceof RangeError ||
      e instanceof SyntaxError ||
      (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code))
    ) {
      console.error(e);
      return [500, 'Internal Sonora error. The details are in the server terminal.'];
    }
    if (/not found|no longer (available|knows)|not available(?! yet)/i.test(e.message))
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
      if (bytes > 128000) throw new Error('Request too large.');
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
      json(res, 403, { error: 'Access is only allowed locally.' });
      return;
    }
    const url = new URL(req.url, 'http://' + host);
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        const expectedOrigin = isPublicHost ? publicOrigin.origin : 'http://' + host;
        if (req.headers['x-sonora'] !== '1' || (origin && origin !== expectedOrigin)) {
          json(res, 403, { error: 'Request origin not allowed.' });
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
      // YuE2 LoRA training of a project on RunPod (HOT-Step recipe); one at a time, never resubmitted.
      const yueTraining = /^\/api\/trainer\/([a-f0-9-]{36})\/yue2$/.exec(url.pathname);
      if (req.method === 'POST' && yueTraining) {
        if (!yue2Settings.endpointId) throw new Error('YuE2 on RunPod is not configured.');
        if (db.jobs.some(j => j.backend === 'yue2' && !TERMINAL.has(j.status)))
          throw new Error('Wait for the YuE2 songs in progress to finish.');
        json(res, 202, yue2Trainer.start(yueTraining[1], await bodyOf(req)));
        return;
      }
      const yueTrainingCancel = /^\/api\/yue2\/training\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
      if (req.method === 'POST' && yueTrainingCancel) {
        json(res, 200, await yue2Trainer.cancel(yueTrainingCancel[1]));
        return;
      }
      const importTraining = /^\/api\/trainer\/([a-f0-9-]{36})\/import$/.exec(url.pathname);
      if (req.method === 'POST' && importTraining) {
        json(res, 200, trainer.importTracks(importTraining[1], await bodyOf(req)));
        return;
      }
      const removeTraining = /^\/api\/trainer\/([a-f0-9-]{36})\/tracks\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (req.method === 'DELETE' && removeTraining) {
        json(res, 200, trainer.removeTrack(removeTraining[1], removeTraining[2]));
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
            throw new Error('End the GPU session and wait for the songs in progress before the training.');
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
          musicModel,
          yue2Configured: yue2Configured(),
          yue2Runpod: !!yue2Settings.endpointId,
          yue2Local: yue2Local.configured,
          yue2MelodyFreedom: yue2Cpp.configured,
          yue2Lora: yue2Adapters.available || yue2Cpp.remote === true,
          yue2EngineRestart: yue2Cpp.configured && !yue2Cpp.remote,
          yue2LoraRunpod: !!yue2Settings.endpointId,
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
            yue2: {
              endpointId: yue2Settings.endpointId || '',
              cpp: {
                engine: yue2CppConfig?.engine || '',
                model: yue2CppConfig?.model || '',
                vae: yue2CppConfig?.vae || '',
                transcriber: yue2CppConfig?.transcriber || '',
                adapters: yue2CppConfig?.adapters || '',
                remote: yue2CppConfig?.remote === true,
                port: yue2CppConfig?.port || 18087,
              },
            },
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/generation/model') {
        const b = await bodyOf(req);
        if (!['ace-step', 'yue2'].includes(b.musicModel)) throw new Error('Invalid music model.');
        if (b.musicModel === 'yue2' && !yue2Configured())
          throw new Error('YuE2 is not configured: the RunPod endpoint and the PC Python are missing.');
        musicModel = b.musicModel;
        json(res, 200, { ...(await checkHealth()), musicModel });
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
        await checkHealth().catch(() => {});
        const plan = await modelSetup.inspect(
          localModelsRoot,
          { model: config.model, encoder: config.encoder, planner: config.planner, vae: config.vae },
          comfyListed
        );
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
        await checkHealth().catch(() => {});
        const pending = modelSetup.download({
          root: localModelsRoot,
          names: { model: config.model, encoder: config.encoder, planner: config.planner, vae: config.vae },
          seen: comfyListed,
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
        if (gpuSession.status().active)
          throw new Error('Stop the active RunPod session before switching providers.');
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
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        const items = [...(await setupCheck.system({ fresh: url.searchParams.get('fresh') === '1' }))];
        const comfyOnline = await comfy('/system_stats').then(
          () => true,
          () => false
        );
        items.push(
          comfyOnline
            ? { id: 'comfyui', label: 'ComfyUI', status: 'ok', detail: localComfyUrl }
            : {
                id: 'comfyui',
                label: 'ComfyUI',
                status: 'warn',
                detail: 'not reachable at ' + localComfyUrl,
                hint: 'ACE-Step runs through ComfyUI: start it and keep it open, or use RunPod / Vast.ai. YuE2 does not need ComfyUI.',
              }
        );
        const listed = Object.entries(comfyListed);
        if (comfyOnline && listed.length) {
          const missing = listed.filter(([, found]) => !found).map(([name]) => name);
          items.push(
            missing.length
              ? {
                  id: 'acestep',
                  label: 'ACE-Step models',
                  status: 'warn',
                  detail: 'ComfyUI does not list: ' + missing.join(', '),
                  hint: 'Open the "This PC · ComfyUI" card below and choose Check model files, then Download missing models.',
                }
              : { id: 'acestep', label: 'ACE-Step models', status: 'ok', detail: 'listed by ComfyUI' }
          );
        }
        const cpp = yue2CppConfig;
        const have = key => !!cpp?.[key] && fs.existsSync(cpp[key]);
        if (cpp?.remote) {
          const engine = await yue2Cpp.health();
          items.push({
            id: 'yue2',
            label: 'YuE2 on another computer',
            status: engine.ready ? 'ok' : 'warn',
            detail: engine.ready ? 'engine reachable through the SSH tunnel' : 'engine not reachable',
            ...(engine.ready
              ? {}
              : {
                  hint: yue2Cpp.configured
                    ? engine.message
                    : 'Restart Sonora to start using the saved settings.',
                }),
          });
        } else
          items.push(
            cpp && have('engine') && have('model') && have('vae')
              ? { id: 'yue2', label: 'YuE2 on this PC', status: 'ok', detail: 'engine and model files found' }
              : {
                  id: 'yue2',
                  label: 'YuE2 on this PC',
                  status: cpp ? 'warn' : 'missing',
                  detail: cpp ? 'some of the saved files are missing' : 'not set up',
                  hint: 'Open the "YuE2 · This PC" card below: download the model files, enter the engine program, then choose Check and save.',
                }
          );
        json(res, 200, { items });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/yue2/models/plan') {
        const b = await bodyOf(req);
        json(res, 200, await yue2Models.inspect(b.dir, { covers: b.covers === true }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/yue2/models/download') {
        const b = await bodyOf(req);
        if (b.confirmed !== true) throw new Error('Confirm the model download before it starts.');
        const pending = yue2Models.download({ dir: b.dir, covers: b.covers === true, confirmed: true });
        pending.catch(() => {
          /* the snapshot carries the error to the app */
        });
        json(res, 202, { started: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/yue2/models/cancel') {
        yue2Models.cancel();
        json(res, 200, { cancelled: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/yue2-cpp') {
        const b = await bodyOf(req);
        const pathOf = (value, label, { dir = false, optional = false } = {}) => {
          const text = typeof value === 'string' ? value.trim() : '';
          if (!text) {
            if (optional) return '';
            throw new Error(label + ' is required.');
          }
          if (text.length > 500 || text.includes('\0') || !path.isAbsolute(text))
            throw new Error(label + ': enter the full path of the file on this computer.');
          const found =
            fs.existsSync(text) && (dir ? fs.statSync(text).isDirectory() : fs.statSync(text).isFile());
          if (!found) throw new Error(label + ' was not found: ' + text);
          return text;
        };
        const nothing =
          b.remote !== true &&
          ['engine', 'model', 'vae', 'transcriber', 'adapters'].every(k => !String(b[k] || '').trim());
        if (b.remote === true) {
          // the engine runs on another computer and is reached through an SSH tunnel on this port
          const port = b.port === undefined || b.port === '' ? 18087 : Number(b.port);
          if (!Number.isInteger(port) || port < 1024 || port > 65535)
            throw new Error('Enter a port between 1024 and 65535.');
          yue2CppConfig = { remote: true, port };
        } else if (nothing) {
          yue2CppConfig = undefined;
        } else {
          yue2CppConfig = {
            ...(yue2CppConfig || {}),
            engine: pathOf(b.engine, 'The engine program'),
            model: pathOf(b.model, 'The song model'),
            vae: pathOf(b.vae, 'The audio decoder'),
            transcriber: pathOf(b.transcriber, 'The cover transcriber', { optional: true }),
            adapters: pathOf(b.adapters, 'The LoRA folder', { dir: true, optional: true }),
          };
          for (const k of ['transcriber', 'adapters']) if (!yue2CppConfig[k]) delete yue2CppConfig[k];
          delete yue2CppConfig.remote;
        }
        saveProviderSettings();
        json(res, 200, {
          saved: true,
          message: nothing
            ? 'YuE2 on this PC is cleared. Restart Sonora to apply it.'
            : b.remote === true
              ? 'Saved. Restart Sonora, start yue-server on your other computer and open the SSH tunnel.'
              : 'Files found and saved. Restart Sonora so the engine starts with them.',
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/yue2-endpoint') {
        const b = await bodyOf(req);
        const endpointId = String(b.endpointId || '').trim();
        if (endpointId && !/^[a-zA-Z0-9_-]{5,80}$/.test(endpointId))
          throw new Error('Enter a valid RunPod endpoint ID.');
        if (db.jobs.some(j => j.backend === 'yue2' && !TERMINAL.has(j.status)))
          throw new Error('Wait for active YuE2 jobs to finish before changing the endpoint.');
        yue2Settings.endpointId = endpointId;
        yue2RunpodSettings.endpointId = endpointId;
        yue2RunpodSettings.modelsReady = !!endpointId;
        saveProviderSettings();
        json(res, 200, {
          saved: true,
          message: endpointId ? 'YuE2 endpoint saved.' : 'YuE2 endpoint cleared.',
        });
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
        // Rules: the service choice (this PC / RunPod) never switches the music model; YuE2 follows it.
        fs.writeFileSync(generationFile + '.tmp', JSON.stringify({ backend: generationBackend }));
        fs.renameSync(generationFile + '.tmp', generationFile);
        json(res, 200, await checkHealth());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/gpu-session') {
        const b = await bodyOf(req);
        if (!['start', 'stop'].includes(b.action)) throw new Error('Invalid session action.');
        if (b.action === 'start' && generationBackend !== 'runpod') throw new Error('Select RunPod first.');
        if (
          b.action === 'start' &&
          trainer
            .snapshot()
            .projects.some(p => p.job && !['done', 'failed', 'cancelled'].includes(p.job.status))
        )
          throw new Error('Wait for the LoRA training to finish before turning on the generation GPU.');
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
          throw new Error('To have a song listened to, choose OpenAI with an audio model in Set up AI.');
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
              if (bytes > 150 * 1024 * 1024) throw new Error('The file exceeds 150 MB.');
              fs.writeSync(fd, chunk);
            }
          } finally {
            fs.closeSync(fd);
          }
          if (bytes < 1000) throw new Error('Empty audio file.');
          const duration = await audio.probeDuration(file);
          if (duration > 600) throw new Error('Choose a song of at most 10 minutes.');
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
      // YuE2 LoRA: the catalogue with what is installed, install and remove — on this PC (?host=local, background download)
      // or on the RunPod volume (?host=runpod, the worker downloads them: the request waits for it, a GPU starts for a minute).
      const loraHost = url.searchParams.get('host') === 'runpod' ? 'runpod' : 'local';
      const runpodList = () => {
        const state = runpodLora();
        return {
          available: !!yue2Settings.endpointId,
          cpp: state.cpp,
          adapters: yue2Adapters.list().map(a => ({
            ...a,
            installed: state.installed.includes(a.id),
            downloading: false,
            error: undefined,
          })),
        };
      };
      const remoteList = async () => {
        await refreshRemoteLora();
        return {
          available: true,
          adapters: yue2Adapters.list().map(a => ({
            ...a,
            installed: remoteLora.includes(a.id),
            downloading: false,
            error: undefined,
          })),
        };
      };
      if (req.method === 'GET' && url.pathname === '/api/yue2/adapters') {
        json(
          res,
          200,
          loraHost === 'runpod'
            ? runpodList()
            : yue2Cpp.remote
              ? await remoteList()
              : { available: yue2Adapters.available, adapters: yue2Adapters.list() }
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/yue2/engine/restart') {
        await bodyOf(req);
        if (db.jobs.some(j => j.backend === 'yue2' && j.remote?.engine === 'cpp' && !TERMINAL.has(j.status)))
          throw new Error('A song is still being created on this PC: wait for it to finish.');
        const { adapters } = await yue2Cpp.restart();
        json(res, 200, {
          adapters,
          message: adapters.length
            ? `Engine restarted. LoRAs loaded: ${adapters.join(', ')}.`
            : 'Engine restarted. No LoRA is loaded.',
        });
        return;
      }
      const adapterMatch = /^\/api\/yue2\/adapters\/([a-z0-9-]{1,64})$/.exec(url.pathname);
      if (adapterMatch && ['POST', 'DELETE'].includes(req.method) && loraHost === 'runpod') {
        if (!yue2Settings.endpointId) throw new Error('YuE2 on RunPod is not configured.');
        const entry = yue2Adapters.entry(adapterMatch[1]);
        if (entry.trained)
          throw new Error('Trained LoRAs stay on the RunPod volume and are not managed from the catalogue.');
        const report = await yue2Runpod.call(
          req.method === 'POST'
            ? {
                action: 'adapters',
                install: [
                  {
                    id: entry.id,
                    files: entry.files.map(f => ({ url: f.url, file: f.file, bytes: f.bytes })),
                  },
                ],
              }
            : { action: 'adapters', remove: [entry.id] },
          900000
        );
        rememberRunpodLora(report);
        json(res, 200, runpodList());
        return;
      }
      if (adapterMatch && yue2Cpp.remote && ['POST', 'DELETE'].includes(req.method))
        throw new Error(
          'The engine runs on another computer: add or remove the LoRA in its adapters folder there, then restart yue-server.'
        );
      if (adapterMatch && req.method === 'POST') {
        json(res, 202, yue2Adapters.install(adapterMatch[1]));
        return;
      }
      if (adapterMatch && req.method === 'DELETE') {
        json(res, 200, yue2Adapters.remove(adapterMatch[1]));
        return;
      }
      // YuE2 cover: listen to the original song kept for a cover.
      const coverAudio = /^\/api\/yue2\/cover\/([a-f0-9-]{36})\/audio$/.exec(url.pathname);
      if (coverAudio && ['GET', 'HEAD'].includes(req.method)) {
        const file = path.join(dataDir, 'covers', `${coverAudio[1]}.mp3`);
        if (!fs.existsSync(file)) {
          json(res, 404, { error: 'The original song is no longer available: upload it again.' });
          return;
        }
        sendFile(req, res, file, 'audio/mpeg', null);
        return;
      }
      // YuE2 cover, step 1: the melody (and chords if asked) of an existing song, via SheetSage2, as an ABC plan.
      // Rules: the original is kept as data/covers/<id>.mp3 (+ .json with title and length) so a cover can be reused or
      // transcribed again (x-cover-id) without uploading it twice; the lossless upload is deleted right after.
      if (req.method === 'POST' && url.pathname === '/api/yue2/cover/melody') {
        const host = pickYue2Host(req.headers['x-yue-host']);
        if (planning) throw new Error('A plan is still being prepared: wait for it to finish.');
        planning = true;
        let upload = null;
        try {
          const coversDir = path.join(dataDir, 'covers');
          fs.mkdirSync(coversDir, { recursive: true });
          const known = String(req.headers['x-cover-id'] || '');
          let cover;
          if (known) {
            if (!/^[a-f0-9-]{36}$/.test(known) || !fs.existsSync(path.join(coversDir, `${known}.json`)))
              throw new Error('The original song is no longer available: upload it again.');
            cover = {
              id: known,
              ...JSON.parse(fs.readFileSync(path.join(coversDir, `${known}.json`), 'utf8')),
            };
          } else {
            const dir = path.join(dataDir, 'covers-tmp');
            upload = await receiveUpload(req, { dir, tmpDir: dir, probe: audioSeconds });
            if (upload.seconds > COVER_MAX_SECONDS)
              throw new Error('The song lasts more than 10 minutes: use a shorter version.');
            cover = { id: randomUUID(), title: upload.title, seconds: Math.round(upload.seconds) };
            fs.renameSync(upload.mp3, path.join(coversDir, `${cover.id}.mp3`));
            fs.writeFileSync(
              path.join(coversDir, `${cover.id}.json`),
              JSON.stringify({ title: cover.title, seconds: cover.seconds })
            );
          }
          const audio = await prepareCoverAudio(path.join(coversDir, `${cover.id}.mp3`));
          // Rules: chords only when asked (x-cover-chords: 1): YuE2 recommends the melody alone for covers, but the chords can be sung with cot=full.
          const chords = req.headers['x-cover-chords'] === '1';
          const result = await yue2Host(host).call(
            {
              action: 'transcribe',
              localId: randomUUID(),
              audio: audio.base64,
              format: audio.format,
              chords,
            },
            900000
          );
          if (typeof result.abc !== 'string' || !/^K:/m.test(result.abc))
            throw new Error('The transcription did not produce a valid score.');
          json(res, 200, {
            abc: result.abc,
            chords,
            seconds: result.seconds,
            audioSeconds: cover.seconds,
            title: cover.title,
            coverId: cover.id,
            ...(cover.seconds > TRANSCRIBE_MAX_SECONDS ? { trimmedTo: TRANSCRIBE_MAX_SECONDS } : {}),
          });
        } finally {
          planning = false;
          if (upload) {
            fs.rmSync(upload.flac, { force: true });
            fs.rmSync(upload.mp3, { force: true });
          }
        }
        return;
      }
      // YuE2: the melody-and-chords plan (ABC) for a style and lyrics, before any audio is made. Only returns text.
      if (req.method === 'POST' && url.pathname === '/api/yue2/plan') {
        const b = await bodyOf(req);
        const host = pickYue2Host(b.yueHost);
        if (planning) throw new Error('The previous plan is still being prepared.');
        const checked = validateInput({
          musicModel: 'yue2',
          tags: b.tags,
          lyrics: b.lyrics,
          yueCot: b.yueCot ?? 'full',
          seed: b.seed ?? -1,
          yueAdapters: b.yueAdapters ?? null,
          yueHarmony: b.yueHarmony ?? null,
        });
        const harmony = harmonyField(checked.yueHarmony, checked.lyrics);
        const adapterFields = yueAdapterFields(checked.yueAdapters, host);
        planning = true;
        try {
          const plan = await yue2Host(host).call({
            action: 'plan',
            localId: randomUUID(),
            style: withTriggers(checked.tags, checked.yueAdapters),
            lyrics: checked.lyrics,
            cot: checked.yueCot,
            seed: checked.seed,
            ...adapterFields,
            ...(harmony ? { harmony } : {}),
          });
          if (typeof plan.abc !== 'string' || !plan.abc.trim())
            throw new Error('YuE2 did not return the plan.');
          json(res, 200, { abc: plan.abc, seed: plan.seed, seconds: plan.seconds });
        } finally {
          planning = false;
        }
        return;
      }
      // A lyric sheet that fits an existing song (its style, tempo and length). Only returns text.
      if (req.method === 'POST' && url.pathname === '/api/prompt/lyrics-fit') {
        json(res, 200, await promptAi.fitLyrics(await bodyOf(req)));
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
          if (!(length >= 5)) throw new Error('The reference excerpt must last at least 5 seconds.');
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
            tags: 'song uploaded',
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
            musicModel: 'ace-step',
          },
          status: 'done',
          phase: 'Done',
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
        if (db.workspaces.length >= 20) throw new Error('Maximum 20 workspaces.');
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
        json(res, 200, { message: 'Sonora stopped. Jobs already sent continue in ComfyUI.' });
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
          const stemLabel = kind === 'base' ? 'strumenti' : kind === 'voice' ? 'voce' : kind;
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
      if (req.method === 'POST' && url.pathname === '/api/stems/import') {
        const body = await bodyOf(req);
        const session = stems.createImport({
          title: body.title,
          workspaceId: workspaceIdOf(body.workspaceId),
        });
        json(res, 201, { session });
        return;
      }
      const importStemRoute =
        /^\/api\/stems\/([a-f0-9-]{36})\/import\/(vocals|drums|bass|guitar|piano|other)$/.exec(url.pathname);
      if (req.method === 'POST' && importStemRoute) {
        const entry = await stems.importStem(importStemRoute[1], importStemRoute[2], req);
        json(res, 201, { stem: entry });
        return;
      }
      if (req.method === 'DELETE' && importStemRoute) {
        stems.removeImportedStem(importStemRoute[1], importStemRoute[2]);
        json(res, 200, { ok: true });
        return;
      }
      const finishImportRoute = /^\/api\/stems\/([a-f0-9-]{36})\/finish$/.exec(url.pathname);
      if (req.method === 'POST' && finishImportRoute) {
        const id = finishImportRoute[1];
        const job = getJob(id) || addImportedStemSong(id, await stems.prepareImport(id));
        stems.completeImport(id);
        json(res, 201, { job });
        return;
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
          if (!parent) throw new Error('Song not found.');
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
      const match =
        /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|audio|workflow|rework|rerender|extend))?$/.exec(
          url.pathname
        );
      if (match) {
        const job = db.jobs.find(j => j.id === match[1]);
        if (!job) {
          json(res, 404, { error: 'Song not found.' });
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
          for (const k of ['favorite', 'archived', 'disliked'])
            if (b[k] !== undefined) {
              if (typeof b[k] !== 'boolean') throw new Error('Invalid value.');
              fields[k] = b[k];
            }
          if ((fields.archived || fields.disliked) && !TERMINAL.has(job.status))
            throw new Error('Wait for or cancel the song before archiving it.');
          // Rules: a thumbs-down song is hidden like an archived one (it lives in the Archive, marked); restoring it clears both.
          if (fields.disliked) fields.archived = true;
          if (fields.archived === false) fields.disliked = false;
          change(job, fields);
          json(res, 200, job);
          return;
        }
        // Rules: deleting removes the song and its own audio and workflow files for good; mixer, editor and Audio Lab sessions keep their copies.
        if (req.method === 'DELETE' && !match[2]) {
          if (!TERMINAL.has(job.status)) throw new Error('Wait for or cancel the song before deleting it.');
          db.jobs.splice(db.jobs.indexOf(job), 1);
          persist();
          broadcast();
          for (const folder of ['audio', 'workflows']) {
            const dir = path.join(dataDir, folder);
            for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
              if (name.startsWith(job.id + '.')) fs.rmSync(path.join(dir, name), { force: true });
          }
          json(res, 200, { deleted: job.id });
          return;
        }
        // YuE2 exact replay: the same composition and singing (saved semantic codes) rendered again with a new sound seed and steps.
        if (req.method === 'POST' && match[2] === 'rerender') {
          const b = await bodyOf(req);
          const file = path.join(dataDir, 'yue2-replay', `${job.id}.json`);
          if (job.backend !== 'yue2' || !job.yue?.replay || !fs.existsSync(file))
            throw new Error(
              'This song does not have the codes for a new take: only songs made with the new engine keep them.'
            );
          const steps = b.steps ?? 32;
          if (![16, 32, 48, 64].includes(steps)) throw new Error('Invalid steps.');
          const replay = JSON.parse(fs.readFileSync(file, 'utf8'));
          const host = pickYue2Host(b.yueHost ?? job.remote?.host ?? 'runpod');
          if (host === 'local' && !yue2Cpp.configured)
            throw new Error('The yue2.cpp engine is needed on the PC.');
          const fresh = {
            id: randomUUID(),
            promptId: randomUUID(),
            group: randomUUID(),
            title: job.title,
            variant: 1,
            workspaceId: job.workspaceId,
            input: {
              ...job.input,
              seed: randomInt(0, 2147483647),
              variants: 1,
              abc: replay.abc || job.input.abc,
              yueHost: host,
            },
            backend: 'yue2',
            remote: host === 'local' ? { host: 'local' } : { endpointId: yue2Settings.endpointId },
            parentId: job.id,
            kind: 'rerender',
            rerender: { steps },
            status: 'submitting',
            phase: 'New take',
            createdAt: new Date().toISOString(),
            favorite: false,
            archived: false,
            assets: {},
          };
          db.jobs.unshift(fresh);
          persist();
          broadcast();
          try {
            const remote = await yue2Host(host).submitAction({
              action: 'generate',
              localId: fresh.id,
              style: withTriggers(job.input.tags, job.input.yueAdapters),
              lyrics: job.input.lyrics,
              cot: replay.cot || job.input.yueCot || 'full',
              seed: fresh.input.seed,
              ...(replay.abc ? { abc: replay.abc } : {}),
              semanticTokens: replay.semanticTokens,
              steps,
              ...yueAdapterFields(job.input.yueAdapters, host),
            });
            change(fresh, {
              remote,
              status: 'queued',
              phase: host === 'local' ? 'Queued YuE2 on the PC' : 'Queued YuE2',
            });
          } catch (error) {
            change(fresh, { status: 'failed', phase: 'YuE2 error', error: error.message });
          }
          json(res, 202, { job: fresh });
          return;
        }
        // Continue a YuE2 song from a selected part of its saved semantic codes. The original remains untouched.
        if (req.method === 'POST' && match[2] === 'extend') {
          const b = await bodyOf(req);
          const file = path.join(dataDir, 'yue2-replay', `${job.id}.json`);
          if (job.backend !== 'yue2' || job.status !== 'done' || !job.yue?.replay || !fs.existsSync(file))
            throw new Error('This song does not have the codes needed to continue it.');
          if (yue2Trainer.active()) throw new Error('Wait for the YuE2 training on RunPod to finish.');
          const replay = JSON.parse(fs.readFileSync(file, 'utf8'));
          const tokens = replay.semanticTokens;
          if (typeof tokens !== 'string' || !/^[0-9]+(,[0-9]+)*$/.test(tokens))
            throw new Error('The song codes are not valid.');
          const { from, to, seconds } = b;
          const available = tokens.split(',').length / 25;
          if (
            ![from, to, seconds].every(value => typeof value === 'number' && Number.isFinite(value)) ||
            from < 0 ||
            to > available ||
            to - from < 2 ||
            seconds < 10 ||
            seconds > 300 ||
            to - from + seconds > 360
          )
            throw new Error(
              'Choose a part of at least 2 seconds and add 10 to 300 seconds (6 minutes maximum in total).'
            );
          const host = pickYue2Host(b.yueHost ?? job.remote?.host ?? 'runpod');
          if (host === 'local' && !yue2Cpp.configured)
            throw new Error('The yue2.cpp engine is needed on the PC.');
          const total = Math.ceil(to - from + seconds);
          const fresh = {
            id: randomUUID(),
            promptId: randomUUID(),
            group: randomUUID(),
            title: job.title,
            variant: 1,
            workspaceId: job.workspaceId,
            input: {
              ...job.input,
              abc: undefined,
              seed: randomInt(0, 2147483647),
              variants: 1,
              duration: total,
              yueHost: host,
            },
            backend: 'yue2',
            remote: host === 'local' ? { host: 'local' } : { endpointId: yue2Settings.endpointId },
            parentId: job.id,
            kind: 'extend',
            extend: { from, to, seconds },
            status: 'submitting',
            phase: 'YuE2 continuation',
            createdAt: new Date().toISOString(),
            favorite: false,
            archived: false,
            assets: {},
          };
          db.jobs.unshift(fresh);
          persist();
          broadcast();
          try {
            const remote = await yue2Host(host).submitAction({
              action: 'generate',
              localId: fresh.id,
              style: withTriggers(job.input.tags, job.input.yueAdapters),
              lyrics: job.input.lyrics,
              cot: replay.cot || job.input.yueCot || 'full',
              seed: fresh.input.seed,
              sourceTokens: tokens,
              sourceStart: from,
              sourceEnd: to,
              duration: total,
              ...yueAdapterFields(job.input.yueAdapters, host),
            });
            change(fresh, {
              remote,
              status: 'queued',
              phase: host === 'local' ? 'Queued YuE2 on the PC' : 'Queued YuE2',
            });
          } catch (error) {
            change(fresh, { status: 'failed', phase: 'YuE2 error', error: error.message });
          }
          json(res, 202, { job: fresh });
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
          if (job.status === 'submitting') throw new Error('Wait for the job to be sent.');
          if (['runpod', 'yue2'].includes(job.backend)) {
            await (job.backend === 'yue2' ? yue2Host(job.remote?.host) : runpod).cancel(job);
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
            json(res, 404, { error: 'Audio not available.' });
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
        // abcjs 6.4.4 (MIT, Paul Rosen and Gregory Dyke): engraves the YuE2 plan as sheet music; loaded only when the score is opened
        '/vendor/abcjs-basic-min.js': ['vendor/abcjs-basic-min.js', 'text/javascript; charset=utf-8'],
        ...Object.fromEntries(
          [
            'prompt-ui',
            'prompt-core',
            'prompt-presets',
            'prompt-adapter',
            'song-duration',
            'duration-field',
            'auto-meta',
            'abc-plan',
            'abc-play',
            'abc-edit',
            'cover-lyrics',
            'chord-presets',
            'chord-bed',
            'score-view',
            'midi-io',
            'yue2-ui',
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
  const trainingTimer = setInterval(() => {
    trainer.poll().catch(() => {});
    yue2Trainer.poll().catch(() => {});
  }, 10000);
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
    yue2Models.cancel();
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
    console.error(err.code === 'EADDRINUSE' ? 'Sonora is already open, or the port is in use.' : err.message);
    process.exit(1);
  });
  app.server.listen(config.port, '127.0.0.1', () => {
    console.log(`Sonora: http://127.0.0.1:${config.port}`);
    app.checkHealth();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
