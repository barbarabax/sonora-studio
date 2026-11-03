#!/usr/bin/env bash
# yue2_train_build.sh — builds HOT-Step's ace-train (YuE2 LoRA trainer, CUDA) and downloads its training weights onto the shared volume.
# rules: Pinned sources only (HOT-Step-CPP commit as YuE2-Studio ships it, scragnog/YuE2-GGUF and Mothersuperior revisions); the build
#        runs on the worker's own disk, only the binary, its libraries and the weights go to the volume; the marker file is written last.
set -euo pipefail
COMMIT=91e92a8aeeac5e800c8810e7b2e7fafbebaca3fc
WEIGHTS=eb7de0903bf4dfbd14a2384ae0c0d14150cfa2c7
COMPANION=e2e63d859f3af879baf1b4d4e9f22d1eeda6fde5
T=/runpod-volume/yue2/train
READY="$T/.ready-${COMMIT:0:7}"
mkdir -p "$T/bin" "$T/models"
df -h /runpod-volume
python -m pip install --quiet cmake ninja huggingface-hub==0.36.2

if [ -x "$T/bin/ace-train" ] && [ -f "$T/bin/.commit-${COMMIT:0:7}" ]; then
  echo "ace-train ${COMMIT:0:7} already built"
else
  mkdir -p /work
  W=/work/hot-step
  rm -rf "$W"
  git clone --quiet https://github.com/timoncool/HOT-Step-CPP.git "$W"
  cd "$W"
  git checkout --quiet "$COMMIT"
  # the ggml fork, and the VST3 SDK the CMake project configures even when only ace-train is built
  git submodule update --init --recursive --quiet engine/ggml engine/vendor/vst3sdk
  cd engine
  export LIBRARY_PATH=/usr/local/cuda/lib64/stubs:${LIBRARY_PATH:-}
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON \
    -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc -DCMAKE_CUDA_ARCHITECTURES="80-virtual;86-real;89-real"
  cmake --build build -j "$(nproc)" --target ace-train
  BIN=$(find build -type f -name ace-train | head -1)
  cp "$BIN" "$T/bin/ace-train"
  find build -name '*.so*' -exec cp -P {} "$T/bin/" \; || true
  chmod +x "$T/bin/ace-train"
  LD_LIBRARY_PATH="$T/bin" ldd "$T/bin/ace-train" | grep -v 'libcuda.so' | grep 'not found' && { echo "MISSING LIBRARIES"; exit 1; } || true
  touch "$T/bin/.commit-${COMMIT:0:7}"
fi
LD_LIBRARY_PATH="$T/bin:/usr/local/cuda/lib64/stubs" "$T/bin/ace-train" --help 2>&1 | head -20 || true

# training weights, stored flat under the names the trainer looks for
hf download scragnog/YuE2-GGUF checkpoints/yue2_3b_int8_convrot.safetensors yue2-vae-standard-f32.gguf yue2-tok-f16.gguf \
  sheetsage2-f16.gguf mms-fa/mms-fa-f32.gguf --revision "$WEIGHTS" --local-dir "$T/download"
mv -f "$T/download/checkpoints/yue2_3b_int8_convrot.safetensors" "$T/download/yue2-vae-standard-f32.gguf" "$T/download/yue2-tok-f16.gguf" \
  "$T/download/sheetsage2-f16.gguf" "$T/download/mms-fa/mms-fa-f32.gguf" "$T/models/"
hf download Mothersuperior/yue2-mothersuperior-realaudio-tokenizer-v4 nar_lora_joint_v9.safetensors --revision "$COMPANION" --local-dir "$T/models"
rm -rf "$T/download" "$T/models/.cache"
ls -la "$T/models" "$T/bin"
touch "$READY"
df -h /runpod-volume
echo "TRAIN BUILD OK"
