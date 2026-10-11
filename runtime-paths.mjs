// @codedna
// description: Resolve the isolated audio Python runtime on Windows or Linux.
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
// 
//
// exports: audioPython
// used_by: sonora-studio/audio-editor.mjs
//                   sonora-studio/audio-lab.mjs
//                   sonora-studio/audio-tests.mjs
//                   sonora-studio/stems.mjs
// rules:   Use the configured runtime only; never install packages during requests.
// agent:   Codex - 2026-10-05 - Linux audio runtime support.
import path from 'node:path';
export function audioPython(root) {
  return (
    process.env.SONORA_PYTHON ||
    path.join(
      root,
      'runtime',
      'separator',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])
    )
  );
}
