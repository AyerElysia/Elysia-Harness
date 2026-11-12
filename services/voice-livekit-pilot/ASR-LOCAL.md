# Isolated local ASR for the voice pilot

This is a turn-based recognizer, not a partial-caption service. LiveKit keeps listening while Breeze is playing, and the existing call worker handles voice activity, barge-in, and turn boundaries. This service only recognizes a completed turn. It uses the vendored DSH SenseVoiceSmall INT8 and Silero inference code on CPU through the already-installed ARM64 `sherpa-onnx-node`; no ASR cloud credentials, Python model runtime, recording, or raw-audio file is needed.

## Prepare

Use a fresh owner-only directory created by `mktemp -d /tmp/elyharn-local-asr.XXXXXXXX`. Stage only `model.int8.onnx`, `tokens.txt`, and `silero_vad.onnx` from the pinned URLs and revisions in [DSH's assets manifest](../../dsh/packages/experimental/speech-to-text-sensevoice/runtime/assets.json). If needed, use the same path from the DSH-configured HF mirror, but only accept the exact manifest length and SHA-256. Keep model files owner-only. The process verifies all three files at startup; it does not download automatically.

From this service directory, using Spark's existing Node 22:

```sh
node --test test_asr_local.mjs
node asr_local.mjs --verify --runtime /tmp/elyharn-local-asr.XXXXXXXX
node asr_local.mjs --runtime /tmp/elyharn-local-asr.XXXXXXXX --key-file /path/to/preview/bridge.key
```

Use the isolated preview's existing owner-only key file. Do not log the key or set it on a command line. Run in the foreground and stop this process only, by its own console or verified PID. There is no automatic restart or public listen.

## Local contract

- `GET http://127.0.0.1:18796/health` returns `{ "ready": true }` when the model thread is ready.
- `POST /transcribe` requires `Authorization: Bearer …`, exact `Content-Type: application/octet-stream`, and `Content-Length`. Body is 16 kHz mono signed little-endian PCM16, 6,400 to 640,000 bytes. Returns `{ "text": "…" }`; empty text means no recognized speech. Browser requests and other hosts are rejected. Input, output, wait, and concurrency are bounded; no request bodies or model exceptions are logged.
- One turn at a time; busy or unhealthy is HTTP 503. A native inference timeout makes the process unhealthy rather than silently retrying. Keep the call worker's request deadline shorter than an operator's manual recovery; do not auto-retry the same audio.

The 2026-11-13 isolated Spark smoke got an exact recognition of the synthetic Mandarin fixture “你好，今天我们测试中文语音转写。” in 92 ms from sending the completed audio to receiving text. This is not a latency or accuracy claim for a live call or for the downstream LLM.
