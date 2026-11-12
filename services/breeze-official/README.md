# Official Breeze inference on Spark

The build context must be an unmodified, complete export of official
`breezeblue-ai/breeze-tts` commit
`daa6cb2efe5471f09369229f322d20bb956cb3c3`, not the local inference fork.

This Dockerfile reuses the already verified Arm64 CUDA/PyTorch dependency
image by its exact image ID. It does not install the H100-oriented dependency
pins, modify model code, or use vLLM for inference. Official source runs from
`/opt/breeze-official`, ahead of the read-only `/opt/breeze-pkgs` dependency
mount. The original fork is not mounted into this container.

Required read-only mounts:

- Existing checkpoint directory to `/models/breeze`.
- Existing verified Qwen TTS dependency directory to `/opt/breeze-pkgs`.

The API binds to container port 7863; publish only to host loopback.
The separate application gateway owns the existing public-to-app loopback
port 7862, shared FIFO admission and client compatibility. It does not
load any model. Keep inference at one process; do not add Uvicorn workers.

Use eager streaming first. Fast flags require separate measured validation.
Keep the previous container stopped and recoverable until the migration
report and real chat voice test are complete. Do not remove model weights,
reference audio, subject data, or the original Git history.
