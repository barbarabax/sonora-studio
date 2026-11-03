#!/usr/bin/env bash
# Starts the YuE2 worker. The first start installs a private Python environment (torch, transformers, yue2_infer) on the
# persistent volume; later starts only check a marker file and go straight to the worker.
set -euo pipefail
V=/runpod-volume/yue2
mkdir -p "$V"
export HF_HOME="$V/hf"
export PIP_CACHE_DIR="$V/pipcache"
READY="$V/venv/.ready-0.1.5"
if [ ! -f "$READY" ]; then
  rm -rf "$V/venv"
  python -m venv "$V/venv"
  "$V/venv/bin/python" -m pip install --quiet --upgrade pip
  "$V/venv/bin/python" -m pip install --quiet huggingface-hub==0.36.2 runpod imageio-ffmpeg soundfile
  "$V/venv/bin/hf" download m-a-p/YuE2-3B yue2_infer-0.1.5-py3-none-any.whl --local-dir "$V/wheels"
  "$V/venv/bin/python" -m pip install --quiet "$V/wheels/yue2_infer-0.1.5-py3-none-any.whl"
  touch "$READY"
fi
# SheetSage2 (audio -> melody ABC, for covers) has its own environment: it needs torch 2.8 and older libraries than YuE2.
S="$V/sheetsage"
if [ ! -f "$S/.ready-1" ]; then
  rm -rf "$S"
  mkdir -p "$S"
  python -m venv --system-site-packages "$S/venv"
  "$S/venv/bin/python" -m pip install --quiet --upgrade pip
  "$S/venv/bin/python" -m pip install --quiet huggingface-hub==0.36.0 transformers==4.45.2 safetensors==0.5.3 numpy==1.24.3 scipy==1.13.1 mir_eval==0.8.2 pretty_midi==0.2.10 mido==1.3.3 setuptools==78.1.1
  "$S/venv/bin/hf" download m-a-p/SheetSage2 --local-dir "$S/repo"
  "$S/venv/bin/hf" download m-a-p/MERT-v2-FullSong
  touch "$S/.ready-1"
fi
# Extra arguments (for example --test_input) go straight to the worker, which lets the RunPod SDK run one job locally.
exec "$V/venv/bin/python" -u /yue2_worker.py "$@"
