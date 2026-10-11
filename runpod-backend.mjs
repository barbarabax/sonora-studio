// @codedna
// description: Durable RunPod music jobs and verified, resumable audio transfer.
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
// exports: createRunpodBackend
// used_by: sonora-studio/gpu-session-watchdog.mjs
//                   sonora-studio/server.mjs
// rules:   Never resubmit generation on recovery; credentials remain server-side; downloads are scoped to job IDs.
// agent:   Codex - 2026-10-05 - Remote generation bridge.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function createRunpodBackend(settings = {}, { fetchImpl = fetch, keyReader = () => null } = {}) {
  let key;
  const endpoint = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{5,80}$/.test(value))
      throw new Error('RunPod endpoint is not configured.');
    return value;
  };
  async function request(endpointId, route, body) {
    key ||= keyReader();
    let response;
    try {
      response = await fetchImpl(`https://api.runpod.ai/v2/${endpoint(endpointId)}/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(100000),
      });
    } catch {
      throw new Error('RunPod response was not received. Generation will not be resubmitted.');
    }
    if (!response.ok) {
      const error = new Error(`RunPod HTTP ${response.status}: request failed.`);
      error.httpStatus = response.status;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      throw new Error('Invalid response from RunPod.');
    }
  }
  async function output(endpointId, input, waitMs = 180000, onReceipt) {
    let result = await request(endpointId, input.action === 'training-upload' ? 'run' : 'runsync', {
      input,
      policy: { executionTimeout: 90000, ttl: Math.max(300000, waitMs) },
    });
    if (result.id && onReceipt) onReceipt(result.id);
    const deadline = Date.now() + waitMs;
    while (['IN_QUEUE', 'IN_PROGRESS'].includes(result.status) && result.id && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      result = await request(endpointId, 'status/' + encodeURIComponent(result.id));
    }
    if (result.status !== 'COMPLETED' || result.output?.error)
      throw new Error('RunPod audio recovery did not finish. The files remain on the volume.');
    return result.output;
  }
  async function verifyKey(value, endpointId) {
    const url = `https://api.runpod.ai/v2/${endpoint(endpointId)}/health`;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${value}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('Could not verify the RunPod key and endpoint. Check both values and try again.');
    }
    if (!response.ok) throw new Error(`RunPod returned HTTP ${response.status}.`);
    return true;
  }
  async function health() {
    try {
      const stats = await request(settings.endpointId, 'health');
      return {
        online: true,
        ready: settings.modelsReady === true,
        fullAvailable: true,
        sftAvailable: settings.sftReady === true,
        backend: 'runpod',
        model: settings.model,
        gpu: 'RunPod · GPU remota',
        message:
          settings.modelsReady !== true
            ? 'Modelli RunPod da verificare.'
            : stats.workers?.initializing
              ? 'RunPod · starting GPU'
              : 'RunPod ready · the GPU starts on request',
      };
    } catch {
      return {
        online: false,
        ready: false,
        backend: 'runpod',
        message: 'RunPod is unreachable or the API key is unavailable.',
      };
    }
  }
  return {
    verifyKey,
    setKey(value) {
      key = value;
    },
    health,
    async uploadTraining(input, onReceipt) {
      return output(settings.endpointId, input, 900000, onReceipt);
    },
    async startTraining(input) {
      const r = await request(settings.endpointId, 'run', {
        input,
        policy: { executionTimeout: 1800000, ttl: 7200000 },
      });
      if (typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{5,160}$/.test(r.id))
        throw new Error('Training receipt is missing.');
      return { id: r.id };
    },
    async trainingStatus(id) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{5,160}$/.test(id))
        throw new Error('Invalid training receipt.');
      return request(settings.endpointId, 'status/' + encodeURIComponent(id));
    },
    async sessionSettings(workersMin) {
      key ||= keyReader();
      const url = `https://rest.runpod.io/v1/endpoints/${endpoint(settings.endpointId)}`;
      const call = async (method, body) => {
        const r = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error(`RunPod session setup failed (HTTP ${r.status}).`);
        const value = await r.json();
        return { workersMin: value.workersMin, workersMax: value.workersMax };
      };
      if (workersMin !== undefined) {
        if (![0, 1].includes(workersMin)) throw new Error('Invalid GPU count.');
        const before = await call('GET');
        if (workersMin === 1 && before.workersMax !== 1)
          throw new Error('The session requires an endpoint capped at one GPU.');
        await call('PATCH', { workersMin });
      }
      const value = await call('GET');
      if (workersMin !== undefined && value.workersMin !== workersMin)
        throw new Error('RunPod did not confirm the GPU change.');
      return value;
    },
    async submit(job, workflow, inputAudio = null) {
      const endpointId = endpoint(settings.endpointId);
      const result = await request(endpointId, 'run', {
        input: { action: 'generate', localId: job.id, workflow, ...(inputAudio ? { inputAudio } : {}) },
        policy: { executionTimeout: 900000, ttl: 86400000 },
      });
      if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{5,160}$/.test(result.id))
        throw new Error('RunPod did not return an identifier.');
      return { endpointId, id: result.id };
    },
    async status(job) {
      if (!job.remote?.id) return { status: 'UNKNOWN' };
      try {
        return await request(job.remote.endpointId, 'status/' + encodeURIComponent(job.remote.id));
      } catch (e) {
        if (e.httpStatus !== 404) throw e;
        // A read-only recovery request can wake the worker, but never generates music.
        const recovered = await output(job.remote.endpointId, { action: 'recover', localId: job.id });
        if (recovered.missing || recovered.pending) return { status: 'LOST' };
        return { status: 'COMPLETED', output: recovered };
      }
    },
    async cancel(job) {
      if (!job.remote?.id)
        throw new Error('Job receipt is uncertain. Check RunPod before cancelling.');
      return request(job.remote.endpointId, 'cancel/' + encodeURIComponent(job.remote.id), {});
    },
    async collect(job, result, dataDir) {
      if (
        !Array.isArray(result.audio) ||
        result.audio.length !== 2 ||
        new Set(result.audio.map(a => a.format)).size !== 2
      )
        throw new Error('RunPod did not return both audio formats.');
      const assets = {};
      for (const asset of result.audio) {
        if (
          !['mp3', 'flac'].includes(asset.format) ||
          !Number.isInteger(asset.bytes) ||
          asset.bytes < 32 ||
          asset.bytes > 200 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(asset.sha256)
        )
          throw new Error('Invalid RunPod audio metadata.');
        const name = `${job.id}.${asset.format}`,
          target = path.join(dataDir, 'audio', name),
          partial = target + '.part';
        if (!fs.existsSync(target)) {
          if (fs.existsSync(partial) && fs.statSync(partial).size > asset.bytes) fs.unlinkSync(partial);
          let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
          while (offset < asset.bytes) {
            const chunk = await output(job.remote.endpointId, {
              action: 'asset',
              localId: job.id,
              format: asset.format,
              offset,
            });
            if (
              chunk.localId !== job.id ||
              chunk.format !== asset.format ||
              chunk.offset !== offset ||
              typeof chunk.base64 !== 'string' ||
              chunk.base64.length > 4.1 * 1024 * 1024
            )
              throw new Error('Invalid RunPod audio chunk.');
            const bytes = Buffer.from(chunk.base64, 'base64');
            if (!bytes.length || bytes.length !== chunk.bytes || offset + bytes.length > asset.bytes)
              throw new Error('Invalid RunPod audio size.');
            fs.appendFileSync(partial, bytes);
            offset += bytes.length;
          }
          const digest = createHash('sha256');
          for await (const bytes of fs.createReadStream(partial)) digest.update(bytes);
          if (digest.digest('hex') !== asset.sha256) {
            fs.unlinkSync(partial);
            throw new Error('Audio integrity check failed.');
          }
          fs.renameSync(partial, target);
        }
        const digest = createHash('sha256');
        for await (const bytes of fs.createReadStream(target)) digest.update(bytes);
        if (fs.statSync(target).size !== asset.bytes || digest.digest('hex') !== asset.sha256)
          throw new Error('Saved audio does not match the RunPod result.');
        assets[asset.format] = name;
      }
      return assets;
    },
  };
}
