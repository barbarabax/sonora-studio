import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audioPython } from './runtime-paths.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const result = spawnSync(audioPython(root), ['-m', 'unittest', 'discover', '-s', 'test', '-p', '*_test.py'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
