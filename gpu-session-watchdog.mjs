import fs from 'node:fs';
import path from 'node:path';
import { createGpuSession } from './gpu-session.mjs';
import { createRunpodBackend } from './runpod-backend.mjs';
import { createProviderSecrets } from './provider-secrets.mjs';
const dataDir = process.env.SONORA_DATA_DIR || path.resolve('data');
const providerFile = path.join(dataDir, 'providers.json');
const providers = fs.existsSync(providerFile) ? JSON.parse(fs.readFileSync(providerFile, 'utf8')) : {};
const settings = providers.runpod || {};
const secrets = createProviderSecrets({ dataDir });
try {
  await createGpuSession({
    dataDir,
    endpointId: settings.endpointId,
    remote: createRunpodBackend(settings, { keyReader: () => secrets.get('runpod') }),
  }).reconcile();
} catch {
  console.error('GPU expiry could not be confirmed; the next scheduled check will retry.');
  process.exitCode = 1;
}
