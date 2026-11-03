// @codedna
// description: Durable private LoRA datasets and explicit remote training jobs.
// exports: createLoraTrainer
// used_by: server.mjs
// rules: Never resubmit recovered training; transfer datasets only through authenticated RunPod APIs.
// agent: Codex - 2026-10-10 - Dataset track removal and independent annotated copies across projects.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const terminal = new Set(['done', 'failed', 'cancelled']);
export function createLoraTrainer({ dataDir, remote, endpointId, model, onChange = () => {}, probe, cpu }) {
  const dir = path.join(dataDir, 'trainer'),
    file = path.join(dir, 'projects.json');
  fs.mkdirSync(dir, { recursive: true });
  const projects = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
  let recovered = false;
  for (const p of projects) {
    if (['uploading', 'cancelling'].includes(p.job?.status) && !p.job.remoteId) {
      p.job.status = 'failed';
      p.job.error = 'Dataset copy interrupted by the restart. No training sent: you can try again.';
      delete p.job.uploadRemoteId;
      recovered = true;
    } else if (p.job?.status === 'submitting') {
      p.job.status = 'uncertain';
      recovered = true;
    }
  }
  if (recovered) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(projects));
    fs.renameSync(file + '.tmp', file);
  }
  let polling = false;
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify(projects));
    fs.renameSync(file + '.tmp', file);
    onChange();
  };
  const get = id => {
    const p = projects.find(p => p.id === id);
    if (!p) throw new Error('LoRA project not found.');
    return p;
  };
  const snapshot = () => ({ configured: !!endpointId, model, projects });
  const metadata = b => {
    if (typeof b.caption !== 'string' || b.caption.trim().length < 3 || b.caption.length > 3000)
      throw new Error('Describe the style or voice of the examples.');
    if (typeof b.lyrics !== 'string' || b.lyrics.length > 12000) throw new Error('Invalid song lyrics.');
    if (typeof b.instrumental !== 'boolean') throw new Error('Choose sung or instrumental.');
    if (!b.instrumental && !b.lyrics.trim()) throw new Error('For sung tracks enter the exact lyrics.');
    return {
      caption: b.caption.trim(),
      lyrics: b.instrumental ? '' : b.lyrics.trim(),
      instrumental: b.instrumental,
    };
  };
  const mutable = p => {
    if (p.job && !terminal.has(p.job.status)) throw new Error('The dataset is locked during the training.');
  };
  return {
    snapshot,
    create(b) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100)
        throw new Error('Invalid LoRA name.');
      const p = { id: randomUUID(), name: b.name.trim(), tracks: [], createdAt: new Date().toISOString() };
      projects.unshift(p);
      save();
      return snapshot();
    },
    async upload(id, req) {
      const p = get(id);
      mutable(p);
      if (p.tracks.length >= 20) throw new Error('Maximum 20 tracks per project.');
      let name;
      try {
        name = decodeURIComponent(req.headers['x-audio-name'] || '');
      } catch {
        throw new Error('Invalid file name.');
      }
      const ext = path.extname(name).toLowerCase();
      if (!['.wav', '.mp3', '.flac', '.ogg', '.m4a'].includes(ext))
        throw new Error('Upload WAV, MP3, FLAC, OGG or M4A.');
      const track = {
        id: randomUUID(),
        name: path.basename(name).slice(0, 120),
        ext,
        caption: '',
        lyrics: '',
        instrumental: true,
      };
      const folder = path.join(dir, p.id);
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, track.id + ext),
        temp = target + '.part';
      let bytes = 0;
      const fd = fs.openSync(temp, 'wx');
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (
            bytes > 100 * 1024 * 1024 ||
            bytes + p.tracks.reduce((n, t) => n + t.bytes, 0) > 200 * 1024 * 1024
          )
            throw new Error('Limit: 100 MB per file, 200 MB per project.');
          fs.writeSync(fd, chunk);
        }
        fs.closeSync(fd);
        if (bytes < 1000) throw new Error('Empty audio.');
        const duration = await cpu(() => probe(temp));
        if (duration < 10 || duration > 300)
          throw new Error('The examples must last from 10 seconds to 5 minutes.');
        fs.renameSync(temp, target);
        const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        p.tracks.push({ ...track, bytes, duration, sha256 });
        save();
        return snapshot();
      } catch (e) {
        try {
          fs.closeSync(fd);
        } catch {}
        fs.rmSync(temp, { force: true });
        throw e;
      }
    },
    annotate(id, trackId, body) {
      const p = get(id);
      mutable(p);
      const track = p.tracks.find(t => t.id === trackId);
      if (!track) throw new Error('Track not found.');
      Object.assign(track, metadata(body));
      save();
      return snapshot();
    },
    removeTrack(id, trackId) {
      const p = get(id);
      mutable(p);
      const index = p.tracks.findIndex(t => t.id === trackId);
      if (index < 0) throw new Error('Track not found.');
      // The original audio stays on disk, including after a completed training.
      p.tracks.splice(index, 1);
      save();
      return snapshot();
    },
    importTracks(id, body) {
      const target = get(id);
      mutable(target);
      const source = get(body?.sourceProjectId);
      if (source.id === target.id) throw new Error('Choose another project to import from.');
      const ids = body?.trackIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some(v => typeof v !== 'string') ||
        new Set(ids).size !== ids.length
      )
        throw new Error('Select at least one valid track.');
      const tracks = ids.map(trackId => {
        const track = source.tracks.find(t => t.id === trackId);
        if (!track) throw new Error('A track is no longer available in the source project.');
        return track;
      });
      if (target.tracks.length + tracks.length > 20) throw new Error('Maximum 20 tracks per project.');
      const total = [...target.tracks, ...tracks].reduce((n, t) => n + t.bytes, 0);
      if (total > 200 * 1024 * 1024) throw new Error('Limit: 200 MB per project.');
      const folder = path.join(dir, target.id);
      fs.mkdirSync(folder, { recursive: true });
      const copies = [];
      let added = false;
      try {
        for (const track of tracks) {
          const clone = {
            ...track,
            id: randomUUID(),
            sourceProjectId: source.id,
            sourceTrackId: track.id,
          };
          const from = path.join(dir, source.id, track.id + track.ext);
          const to = path.join(folder, clone.id + clone.ext);
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          copies.push({ clone, to });
        }
        target.tracks.push(...copies.map(item => item.clone));
        added = true;
        save();
      } catch (e) {
        if (added) target.tracks.splice(target.tracks.length - copies.length, copies.length);
        for (const item of copies) fs.rmSync(item.to, { force: true });
        throw e;
      }
      return snapshot();
    },
    start(id, b) {
      const p = get(id);
      mutable(p);
      if (projects.some(other => other.id !== id && other.job && !terminal.has(other.job.status)))
        throw new Error('Wait for the other training to finish.');
      if (!endpointId) throw new Error('Training worker not available yet.');
      if (!p.tracks.length) throw new Error('Upload and annotate at least one track.');
      for (const t of p.tracks) metadata(t);
      if (!Number.isInteger(b.epochs) || b.epochs < 1 || b.epochs > 100)
        throw new Error('Choose from 1 to 100 epochs.');
      p.job = {
        localId: randomUUID(),
        status: 'uploading',
        startedAt: new Date().toISOString(),
        epochs: b.epochs,
        copiedBytes: 0,
        totalBytes: p.tracks.reduce((n, t) => n + t.bytes, 0),
      };
      save();
      return (async () => {
        try {
          for (const track of p.tracks) {
            const fd = fs.openSync(path.join(dir, p.id, track.id + track.ext), 'r');
            try {
              for (let offset = 0; offset < track.bytes;) {
                const bytes = Buffer.alloc(Math.min(512 * 1024, track.bytes - offset));
                const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
                if (!count) throw new Error('File audio incompleto.');
                const r = await remote.uploadTraining(
                  {
                    action: 'training-upload',
                    projectId: p.id,
                    trackId: track.id,
                    ext: track.ext,
                    offset,
                    total: track.bytes,
                    sha256: track.sha256,
                    base64: bytes.subarray(0, count).toString('base64'),
                  },
                  receipt => {
                    p.job.uploadRemoteId = receipt;
                    save();
                  }
                );
                if (p.job.status === 'cancelling') throw new Error('Upload cancelled.');
                if (!Number.isInteger(r.offset) || r.offset <= offset || r.offset > track.bytes)
                  throw new Error('Invalid upload receipt.');
                p.job.copiedBytes += r.offset - offset;
                delete p.job.uploadRemoteId;
                save();
                offset = r.offset;
              }
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch (e) {
          p.job.status = p.job.status === 'cancelling' ? 'cancelled' : 'failed';
          fs.writeFileSync(
            path.join(dir, p.id, p.job.localId + '-copy-error.json'),
            JSON.stringify({ receipt: p.job.uploadRemoteId, error: e.message })
          );
          p.job.error = 'Dataset copy not completed. No training sent: you can try again.';
          save();
          throw new Error(p.job.error);
        }
        p.job.status = 'submitting';
        save();
        const input = {
          action: 'train',
          localId: p.job.localId,
          projectId: p.id,
          model,
          epochs: b.epochs,
          tracks: p.tracks,
        };
        try {
          p.job.remoteId = (await remote.startTraining(input)).id;
          p.job.status = 'queued';
          save();
        } catch {
          p.job.status = 'uncertain';
          save();
          throw new Error('Uncertain training receipt. It is not resent: check RunPod.');
        }
        return snapshot();
      })();
    },
    async cancel(id) {
      const p = get(id);
      const receipt = p.job?.remoteId || p.job?.uploadRemoteId;
      if (!receipt || terminal.has(p.job.status)) throw new Error('No cancellable job.');
      const before = p.job.status;
      p.job.status = 'cancelling';
      save();
      try {
        await remote.cancel({ remote: { endpointId, id: receipt } });
      } catch (e) {
        if (p.job.status === 'cancelling') {
          p.job.status = before;
          save();
        }
        throw e;
      }
      return snapshot();
    },
    async poll() {
      if (polling || !endpointId) return;
      polling = true;
      try {
        for (const p of projects.filter(p => p.job?.remoteId && !terminal.has(p.job.status))) {
          try {
            const r = await remote.trainingStatus(p.job.remoteId);
            if (r.status === 'COMPLETED' && r.output?.loraName === `sonora-${p.id}.safetensors`) {
              p.job.status = 'done';
              p.loraName = r.output.loraName;
              p.job.completedAt = new Date().toISOString();
              save();
            } else if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(r.status)) {
              p.job.status = r.status === 'CANCELLED' ? 'cancelled' : 'failed';
              p.job.error = 'Training interrupted. The data and any checkpoints stay on the volume.';
              save();
            } else {
              p.job.status =
                r.status === 'IN_QUEUE' ? 'queued' : p.job.status === 'cancelling' ? 'cancelling' : 'running';
              save();
            }
          } catch {
            /* Receipt and dataset remain durable; never retry submission. */
          }
        }
      } finally {
        polling = false;
      }
    },
    lora(id) {
      const p = get(id);
      if (!p.loraName || p.job?.status !== 'done') throw new Error('LoRA not completed yet.');
      return p.loraName;
    },
  };
}
