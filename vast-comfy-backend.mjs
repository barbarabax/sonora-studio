// @codedna
// description: Connect to a user-owned, running Vast.ai ComfyUI instance through a local SSH tunnel.
// 
//
// 
//
// 
//
// exports: createVastComfyBackend
// used_by: sonora-studio/server.mjs
// rules:   Never create, start, stop, or destroy cloud resources; accept only instance metadata returned by Vast.
// agent:   Codex - 2026-10-10 - Added a no-provisioning Vast ComfyUI bridge.
import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const API = 'https://console.vast.ai/api/v0';

function validInstance(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Select a valid Vast instance.');
  return id;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.instances)) return value.instances;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function instanceView(row) {
  const id = Number(row?.id);
  const port = Number(row?.ssh_port);
  const host = row?.ssh_host;
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return {
    id,
    label: typeof row.label === 'string' ? row.label.slice(0, 120) : `Vast instance ${id}`,
    status: typeof row.actual_status === 'string' ? row.actual_status : 'unknown',
    gpu: typeof row.gpu_name === 'string' ? row.gpu_name.slice(0, 80) : '',
    sshHost: typeof host === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(host) ? host : null,
    sshPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
  };
}

function localPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export function createVastComfyBackend({
  dataDir,
  keyReader,
  fetchImpl = fetch,
  spawnImpl = spawnProcess,
  portPicker = localPort,
  probeImpl,
  onChange = () => {},
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A local data directory is required.');
  if (typeof keyReader !== 'function') throw new Error('A Vast key reader is required.');
  fs.mkdirSync(dataDir, { recursive: true });
  const knownHosts = path.join(dataDir, 'vast-known-hosts');
  let child = null;
  let childFailure = null;
  let current = null;
  let tunnelUrl = null;

  async function api(route, key = keyReader()) {
    if (typeof key !== 'string' || key.length < 16) throw new Error('Add and verify your Vast API key first.');
    let response;
    try {
      response = await fetchImpl(`${API}${route}`, {
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('Vast.ai could not be reached. Check your connection and try again.');
    }
    if (!response.ok) throw new Error(`Vast.ai returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error('Vast.ai returned an invalid response.');
    }
  }

  async function probe(url) {
    if (probeImpl) return probeImpl(url);
    const response = await fetchImpl(`${url}/system_stats`, {
      redirect: 'error',
      signal: AbortSignal.timeout(3500),
    });
    return response.ok;
  }

  function disconnect() {
    const old = child;
    child = null;
    current = null;
    tunnelUrl = null;
    if (old && old.exitCode === null && !old.killed) old.kill();
    onChange({ connected: false });
  }

  return {
    get connected() {
      return Boolean(child && tunnelUrl && child.exitCode === null);
    },
    get instanceId() {
      return current?.id ?? null;
    },
    get baseUrl() {
      return tunnelUrl;
    },
    get configured() {
      try {
        return typeof keyReader() === 'string' && keyReader().length >= 16;
      } catch {
        return false;
      }
    },
    async verifyKey(value) {
      if (typeof value !== 'string' || value.length < 16 || value.length > 2048 || /\s/.test(value))
        throw new Error('Enter a valid Vast API key.');
      const result = await api('/instances/', value);
      return { verified: true, instanceCount: rowsFrom(result).length };
    },
    async instances() {
      const result = await api('/instances/');
      return rowsFrom(result).map(instanceView).filter(Boolean);
    },
    async connect(instanceId) {
      const id = validInstance(instanceId);
      const instances = await this.instances();
      const selected = instances.find(instance => instance.id === id);
      if (!selected) throw new Error('That instance is not available in your Vast account. Refresh the list.');
      if (selected.status !== 'running') throw new Error('Start the selected Vast instance in Vast.ai, then try again.');
      if (!selected.sshHost || !selected.sshPort)
        throw new Error('This instance has no SSH connection. Use a running SSH-enabled ComfyUI instance.');
      disconnect();
      const port = await portPicker();
      const args = [
        '-N',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${knownHosts}`,
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${port}:127.0.0.1:8188`,
        '-p', String(selected.sshPort),
        `root@${selected.sshHost}`,
      ];
      childFailure = null;
      try {
        child = spawnImpl('ssh', args, { stdio: 'ignore', windowsHide: true });
      } catch {
        disconnect();
        throw new Error('Could not start OpenSSH. Install or enable the OpenSSH client, then try again.');
      }
      const opened = child;
      childFailure = null;
      opened.once('error', error => {
        childFailure = error;
        if (child === opened) disconnect();
      });
      opened.once('exit', () => {
        if (child === opened) disconnect();
      });
      tunnelUrl = `http://127.0.0.1:${port}`;
      current = selected;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && child === opened && opened.exitCode === null) {
        try {
          if (await probe(tunnelUrl)) {
            onChange({ connected: true, instanceId: id });
            return { connected: true, instanceId: id, label: selected.label, gpu: selected.gpu };
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      disconnect();
      if (childFailure?.code === 'ENOENT')
        throw new Error('OpenSSH was not found. Install or enable the OpenSSH client, then try again.');
      throw new Error('Could not reach ComfyUI through SSH. Check the instance, its SSH key, and port 8188.');
    },
    disconnect,
    async close() {
      disconnect();
    },
  };
}
