// Builds the portable Windows folder of Sonora Studio: the app files, a verified Node.js runtime and Sonora.exe.
//
//   node scripts/make-portable.mjs [--out dist/folder] [--node-version v22.14.0] [--node-zip file.zip] [--skip-node] [--skip-launcher]
//
// The folder is zipped by the release workflow (.github/workflows/release.yml). Nothing here is committed to Git.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_VERSION = 'v22.14.0';

// Development and repository files are not part of the download.
const SKIP = [
  /^\.github\//,
  /^\.gitignore$/,
  /^\.prettier/,
  /^\.codedna/,
  /^docs\//,
  /^test\//,
  /^scripts\//,
  /^packaging\//,
  /^audio-tests\.mjs$/,
  /^integrations\/runpod\/test_/,
  /^config\.json$/,
];

/** Whether a tracked file belongs in the portable folder. */
export const shouldPackage = file => !SKIP.some(pattern => pattern.test(file));

/** The SHA-256 listed for `name` in the text of a nodejs.org SHASUMS256.txt, or null. */
export function shasumFor(text, name) {
  for (const line of String(text).split('\n')) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === name && /^[a-f0-9]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

async function obtainNode(version, zipArg, tmp) {
  const name = `node-${version}-win-x64.zip`;
  let zip = zipArg;
  if (!zip) {
    zip = path.join(tmp, name);
    console.log(`Downloading ${name} from nodejs.org…`);
    await download(`https://nodejs.org/dist/${version}/${name}`, zip);
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = shasumFor(sums, name);
  if (!expected) throw new Error(`nodejs.org lists no checksum for ${name}.`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (actual !== expected)
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}.`);
  const folder = `node-${version}-win-x64`;
  // the tar that comes with Windows; a Git Bash tar would read 'C:' as a host name
  const windowsTar = path.join(process.env.WINDIR || 'C:\Windows', 'System32', 'tar.exe');
  execFileSync(
    fs.existsSync(windowsTar) ? windowsTar : 'tar',
    ['-xf', zip, '-C', tmp, `${folder}/node.exe`, `${folder}/LICENSE`],
    { stdio: 'inherit' }
  );
  return path.join(tmp, folder);
}

function buildLauncher(out) {
  const csc = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  );
  if (!fs.existsSync(csc))
    throw new Error('The C# compiler that comes with Windows was not found, so Sonora.exe cannot be built.');
  execFileSync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      `/out:${path.join(out, 'Sonora.exe')}`,
      '/reference:System.Windows.Forms.dll',
      path.join(ROOT, 'packaging', 'launcher', 'Launcher.cs'),
    ],
    { stdio: 'inherit' }
  );
}

async function main() {
  const args = process.argv.slice(2);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = path.resolve(
    option(args, '--out', path.join(ROOT, 'dist', `Sonora-Studio-${pkg.version}-win-x64`))
  );
  const version = option(args, '--node-version', NODE_VERSION);
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('The Node.js version must look like v22.14.0.');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\n')
    .filter(Boolean)
    .filter(shouldPackage);
  for (const file of files) {
    const target = path.join(out, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  console.log(`Copied ${files.length} files.`);

  if (!args.includes('--skip-node')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonora-node-'));
    try {
      const folder = await obtainNode(version, option(args, '--node-zip'), tmp);
      fs.mkdirSync(path.join(out, 'runtime', 'node'), { recursive: true });
      fs.copyFileSync(path.join(folder, 'node.exe'), path.join(out, 'runtime', 'node', 'node.exe'));
      fs.copyFileSync(path.join(folder, 'LICENSE'), path.join(out, 'runtime', 'node', 'LICENSE'));
      console.log(`Node.js ${version} added and verified.`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (!args.includes('--skip-launcher')) buildLauncher(out);

  fs.writeFileSync(
    path.join(out, 'START-HERE.txt'),
    `Sonora Studio ${pkg.version} (portable, Windows 10/11, 64-bit)

1. Double-click Sonora.exe. Your browser opens Sonora Studio.
   (Windows may say the program is from an unknown publisher: it is not signed. Choose "More info", then "Run anyway".)
2. In the app, open "Provider settings". The "Setup check" at the top shows what this computer is missing and what to do.
3. To stop Sonora, run "Stop Sonora.cmd".

Your songs and settings stay in the "data" folder next to Sonora.exe. Copy that folder to keep them when you update.
If Sonora does not start, double-click "Sonora (show errors).cmd".
README.md explains everything else, including YuE2 on your own PC.
`
  );
  fs.writeFileSync(
    path.join(out, 'Sonora (show errors).cmd'),
    '@echo off\r\ncd /d "%~dp0"\r\nif exist "runtime\\node\\node.exe" (\r\n  "runtime\\node\\node.exe" server.mjs\r\n) else (\r\n  node server.mjs\r\n)\r\npause\r\n'
  );
  fs.writeFileSync(
    path.join(out, 'Stop Sonora.cmd'),
    '@echo off\r\ncd /d "%~dp0"\r\nif exist "Sonora.exe" (\r\n  start "" /wait "Sonora.exe" --stop\r\n) else (\r\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Ferma-Sonora.ps1"\r\n)\r\n'
  );
  console.log(`Portable folder ready: ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
