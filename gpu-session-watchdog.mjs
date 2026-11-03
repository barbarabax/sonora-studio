import fs from 'node:fs';
import path from 'node:path';
import { createGpuSession } from './gpu-session.mjs';
import { createRunpodBackend } from './runpod-backend.mjs';
const config = JSON.parse(
  fs.readFileSync(process.env.SONORA_CONFIG || new URL('./config.json', import.meta.url))
);
const dataDir = process.env.SONORA_DATA_DIR || path.resolve('data');
try {
  await createGpuSession({
    dataDir,
    endpointId: config.runpod?.endpointId,
    remote: createRunpodBackend(config.runpod),
  }).reconcile();
} catch {
  console.error('GPU expiry: restore not confirmed; the next check will retry.');
  process.exitCode = 1;
}
