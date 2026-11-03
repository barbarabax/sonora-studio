// @codedna
// description: YuE2 LoRA training on RunPod from a Sonora training project: upload the songs, run HOT-Step's recipe, keep the result as "your LoRA".
//
// exports: adapterIdFor | triggerFor | createYue2Trainer
// used_by: server.mjs
// related: lora-trainer.mjs — the projects (songs with style and lyrics) this trains from; integrations/runpod/yue2_worker.py train / train-upload
// rules:   One YuE2 training at a time. A run is submitted once and never resubmitted: a lost or failed run stays failed and the user starts a new one.
//          Songs travel in verified chunks (size + SHA-256 checked on the worker). A finished LoRA lives only on the RunPod volume (adapters/mine-…);
//          Sonora keeps its name, trigger word and step in data/trainer/yue2-runs.json.
// agent:   claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_train | Created after YuE2-Studio's training page (HOT-Step trainer, base-matched presets).
// Codex | openai | 2026-10-15 | Resume checked uploads and keep cancellation terminal.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CHUNK = 4 * 1024 * 1024;
const PRESETS = ['fast', 'balanced', 'thorough'];
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** "Il mio reggae!" -> "mine-il-mio-reggae" (the folder the engine knows it by). */
export const adapterIdFor = (name, suffix) =>
  `mine-${
    String(name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'lora'
  }-${suffix}`;
/** A rare word made from the name, so the style can call the LoRA: "Il mio reggae" -> "ilmrgg" + digits. */
export const triggerFor = (name, suffix) =>
  (String(name)
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/[aeiou]/g, '')
    .slice(0, 6) || 'snr') +
  String(suffix)
    .replace(/[^0-9]/g, '')
    .slice(0, 3)
    .padEnd(3, '7');

/**
 * @param options { dataDir, runpod (createRunpodBackend for the YuE2 endpoint), projects: () => [{ id, name, tracks }], trackFile: (project, track) => path,
 *                  onTrained: (lora) => void, onChange: () => void }
 */
export function createYue2Trainer({
  dataDir,
  runpod,
  projects,
  trackFile,
  onTrained = () => {},
  onChange = () => {},
}) {
  const file = path.join(dataDir, 'trainer', 'yue2-runs.json');
  let runs = [];
  try {
    runs = JSON.parse(fs.readFileSync(file, 'utf8')).runs || [];
  } catch {
    runs = [];
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ runs }, null, 1));
    fs.renameSync(file + '.tmp', file);
    onChange();
  };
  const update = (run, fields) => {
    Object.assign(run, fields, { updatedAt: new Date().toISOString() });
    save();
  };
  const busy = () => runs.find(r => !TERMINAL.has(r.status));

  async function upload(run, project) {
    let sent = 0;
    const total = project.tracks.reduce((n, t) => n + t.bytes, 0);
    for (const track of project.tracks) {
      const bytes = fs.readFileSync(trackFile(project, track));
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, offset + CHUNK);
        const answer = await runpod.call(
          {
            action: 'train-upload',
            projectId: project.id,
            trackId: track.id,
            ext: track.ext,
            total: bytes.length,
            offset,
            sha256: track.sha256,
            base64: chunk.toString('base64'),
          },
          600000
        );
        if (
          !Number.isInteger(answer.offset) ||
          answer.offset < 0 ||
          answer.offset > bytes.length ||
          answer.offset === offset
        )
          throw new Error('Uploading the songs to RunPod was interrupted.');
        sent += answer.offset - offset;
        offset = answer.offset;
        if (run.status === 'cancelled') return;
        update(run, {
          phase: `Uploading the songs to RunPod · ${Math.min(99, Math.floor((100 * sent) / Math.max(1, total)))}%`,
        });
      }
    }
  }

  return {
    snapshot: () => runs,
    active: () => !!busy(),
    trained: () =>
      runs
        .filter(r => r.status === 'done' && r.result)
        .map(r => ({
          id: r.adapterId,
          name: r.name,
          trigger: r.trigger,
          step: r.result.step,
          createdAt: r.updatedAt,
        })),
    /** Start a YuE2 training of a project. Returns at once; the upload and the run continue in the background. */
    start(projectId, { preset = 'fast', name } = {}) {
      if (busy()) throw new Error('A YuE2 training is already running: wait for it to finish.');
      if (!PRESETS.includes(preset)) throw new Error('Invalid recipe.');
      const project = projects().find(p => p.id === projectId);
      if (!project) throw new Error('Project not found.');
      if (!project.tracks.length) throw new Error('Upload at least one song to the project.');
      for (const t of project.tracks)
        if (!t.caption || (!t.instrumental && !t.lyrics))
          throw new Error(`The song «${t.name}» does not have style and lyrics yet.`);
      const title =
        String(name || project.name)
          .trim()
          .slice(0, 60) || project.name;
      const suffix = randomUUID().slice(0, 4);
      const run = {
        id: randomUUID(),
        projectId,
        name: title,
        adapterId: adapterIdFor(title, suffix),
        trigger: triggerFor(title, String(Date.now())),
        preset,
        songs: project.tracks.length,
        status: 'uploading',
        phase: 'Uploading the songs to RunPod',
        createdAt: new Date().toISOString(),
      };
      runs.unshift(run);
      save();
      (async () => {
        try {
          await upload(run, project);
          if (run.status === 'cancelled') return;
          const remote = await runpod.submitAction(
            {
              action: 'train',
              projectId,
              adapterId: run.adapterId,
              trigger: run.trigger,
              preset,
              tracks: project.tracks.map(t => ({
                id: t.id,
                ext: t.ext,
                caption: t.caption,
                lyrics: t.instrumental ? '' : t.lyrics,
                instrumental: !!t.instrumental,
              })),
            },
            4 * 3600000
          );
          if (run.status === 'cancelled') {
            await runpod.cancel({ remote }).catch(() => {});
            return;
          }
          update(run, { remote, status: 'training', phase: 'Training queued on RunPod' });
        } catch (error) {
          if (run.status !== 'cancelled')
            update(run, { status: 'failed', phase: 'Error', error: error.message });
        }
      })();
      return run;
    },
    async cancel(id) {
      const run = runs.find(r => r.id === id);
      if (!run || TERMINAL.has(run.status)) return run;
      if (run.remote) await runpod.cancel({ remote: run.remote }).catch(() => {});
      update(run, { status: 'cancelled', phase: 'Cancelled' });
      return run;
    },
    /** Follow the running training (called by the server's timer). */
    async poll() {
      const run = runs.find(r => r.status === 'training' && r.remote);
      if (!run) return;
      const state = await runpod.status({ id: run.id, remote: run.remote });
      if (state.status === 'COMPLETED' && state.output?.adapterId === run.adapterId) {
        update(run, { status: 'done', phase: `Ready · ${state.output.step} steps`, result: state.output });
        onTrained({ id: run.adapterId, name: run.name, trigger: run.trigger });
      } else if (
        ['FAILED', 'TIMED_OUT', 'CANCELLED', 'LOST'].includes(state.status) ||
        state.status === 'COMPLETED'
      ) {
        const detail = typeof state.error === 'string' ? state.error.slice(0, 300) : '';
        update(run, {
          status: state.status === 'CANCELLED' ? 'cancelled' : 'failed',
          phase: 'Error',
          error: detail || 'Training failed on RunPod.',
        });
      } else if (typeof state.output === 'string' && state.output !== run.phase) {
        update(run, { phase: state.output.replace(/^Training:? ?/, 'Training ') });
      } else if (state.status === 'IN_PROGRESS' && run.phase.startsWith('Training queued')) {
        update(run, { phase: 'Training in progress on RunPod' });
      }
    },
  };
}
