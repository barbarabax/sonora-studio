#!/usr/bin/env bash
# yue2_cpp_build.sh — builds yue2.cpp (yue-server, CUDA) and downloads its GGUF models onto the shared volume, from a CPU pod.
# rules: Pinned sources only (yue2.cpp commit, GGUF revision); the build runs on the pod's own disk and only the binary, its
#        libraries and the models go to the volume. The marker file is written last: the worker uses yue2.cpp only after it.
set -euo pipefail
COMMIT=c8516dbf44d660cca40d3f420c67063e37ec8258
GGUF_REVISION=e630f2b8f6aedf8254c3186438633c1b5eeaf80a
C=/runpod-volume/yue2/cpp
READY="$C/.ready-${COMMIT:0:7}"
mkdir -p "$C/bin" "$C/models" "$C/adapters"
df -h /runpod-volume
python -m pip install --quiet cmake ninja huggingface-hub==0.36.2

# an earlier run may already have built this commit: then only the models are checked
if LD_LIBRARY_PATH="$C/bin:/usr/local/cuda/lib64/stubs" "$C/bin/yue-server" --help 2>/dev/null | grep -q "${COMMIT:0:7}"; then
  echo "yue-server ${COMMIT:0:7} already built"
else
mkdir -p /work
W=/work/yue2.cpp
rm -rf "$W"
git clone --quiet https://github.com/timoncool/yue2.cpp.git "$W"
cd "$W"
git checkout --quiet "$COMMIT"
git submodule update --init --recursive --quiet
# the CUDA driver library is only a link stub here: the GPU workers bring the real one
export LIBRARY_PATH=/usr/local/cuda/lib64/stubs:${LIBRARY_PATH:-}
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON \
  -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc -DCMAKE_CUDA_ARCHITECTURES="80-virtual;86-real;89-real"
cmake --build build -j "$(nproc)" --target yue-server
BIN=$(find build -type f -name yue-server | head -1)
cp "$BIN" "$C/bin/yue-server"
find build -name '*.so*' -exec cp -P {} "$C/bin/" \; || true
chmod +x "$C/bin/yue-server"
LD_LIBRARY_PATH="$C/bin" ldd "$C/bin/yue-server" | grep -v 'libcuda.so' | grep 'not found' && { echo "MISSING LIBRARIES"; exit 1; } || true
LD_LIBRARY_PATH="$C/bin:/usr/local/cuda/lib64/stubs" "$C/bin/yue-server" --help | head -3 || true
fi

hf download Serveurperso/YuE2-GGUF YuE2-3B-Q8_0.gguf YuE2-Vae-F32.gguf SheetSage2-Q8_0.gguf MERT-v2-FullSong-Q8_0.gguf \
  --revision "$GGUF_REVISION" --local-dir "$C/models"
ls -la "$C/models" "$C/bin"
rm -rf "$C/models/.cache"
touch "$READY"
df -h /runpod-volume
echo "CPP BUILD OK"
