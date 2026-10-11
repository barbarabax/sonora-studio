import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'data', 'runtime']);
const sources = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) walk(path.join(directory, entry.name));
    } else if (/\.(?:mjs|js)$/.test(entry.name)) {
      sources.push(path.join(directory, entry.name));
    }
  }
}
walk(root);
if (typeof vm.SourceTextModule !== 'function') {
  throw new Error('This check requires the Node.js --experimental-vm-modules option.');
}
for (const source of sources) {
  try {
    new vm.SourceTextModule(fs.readFileSync(source, 'utf8'), { identifier: source });
  } catch (error) {
    console.error(`${source}: ${error.message}`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) console.log(`Syntax checked ${sources.length} JavaScript files.`);
