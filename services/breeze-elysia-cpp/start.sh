#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME=breeze-elysia-cpp-q8
IMAGE=sha256:30d6ea28f36ed09b262eeb2eac0f9e1ca4081166179a24bd32b5c87308ef880a
SOURCE="$ROOT/breeze-realtime-review/Breeze-TTS-2.cpp"
MODELS=/home/ayerelysia/AI/models

if curl -fsS --max-time 2 http://127.0.0.1:7865/health >/dev/null 2>&1; then
  echo "$NAME is already healthy on 127.0.0.1:7865"
  exit 0
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
  docker start "$NAME" >/dev/null
else
  docker run -d --name "$NAME" --restart=no --gpus all \
    --entrypoint sh \
    -e LD_LIBRARY_PATH=/work/build-cuda-full/third_party/ggml/src:/work/build-cuda-full/third_party/ggml/src/ggml-cuda:/opt/cuda/lib64 \
    -p 127.0.0.1:7865:7865 \
    -v "$SOURCE:/work" \
    -v "$MODELS:/models:ro" \
    -v "$MODELS/breeze-tts-2-elysia/audio_tokenizer:/opt/audio_tokenizer:ro" \
    -v /usr/local/cuda:/opt/cuda:ro \
    "$IMAGE" \
    -lc "/work/build-cuda-full/breeze-server /models/breeze-tts-2-elysia-cpp/breeze-tts-2-elysia-q8_0.gguf --host 0.0.0.0 --port 7865 --ws-port -1 --voices-dir /tmp/voices --verbose" >/dev/null
fi

for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:7865/health; then
    exit 0
  fi
  sleep 1
done

echo "$NAME did not become healthy within 60 seconds" >&2
exit 1
