# Third-party notices

## Barichord Audio Lab

The mastering and audio analysis components in Sonora include a rewritten portion of Barichord Audio Lab, Copyright (c) 2025 geeknik, under the MIT License. Sonora's implementation was adapted to its own audio-processing chain. The original application, accounts, billing, watermark handling, metadata tools, and Flask server were not copied.

The MIT license text is included in `LICENSES/Barichord-Audio-Lab-MIT.txt`.

## abcjs

The score view in Sonora's YuE2 editor bundles abcjs (`public/vendor/abcjs-basic-min.js`), licensed under the MIT License. Its license text is included in `public/vendor/abcjs-LICENSE.md`.

## YuE2-Studio and yue2.cpp

The chord-loop plan writer (`public/chord-bed.mjs`) is ported from [YuE2-Studio](https://github.com/timoncool/YuE2-Studio), and the LoRA adapter catalogue (`yue2-adapters.json`) is derived from its adapter catalogue; YuE2-Studio is licensed under the MIT License. Sonora runs the `yue-server` program of [yue2.cpp](https://github.com/timoncool/yue2.cpp) as a separate process on your computer; no yue2.cpp code is included in this repository.

## YuE2 models and LoRA adapters

The YuE2-3B model, its GGUF conversions and the LoRA adapters are **not distributed with Sonora**. You download them from their authors, and each keeps its own license. The adapter weights listed in `yue2-adapters.json` derive from YuE2-3B (CC BY-NC 4.0): read each author's page and the YuE2 license before any commercial use.

## Node.js (portable download only)

The portable Windows download includes the official Node.js runtime (`runtime/node/node.exe`), downloaded by the build script from nodejs.org and checked against the checksum nodejs.org publishes. Node.js is licensed under the MIT License and other licenses; the license text is included as `runtime/node/LICENSE`. The source code in this repository does not include Node.js.
