# 爱莉 BreezeTTS 2 C++／实时通话工程

本目录保存爱莉微调权重迁移到 C++ 运行时、GGUF 转换与量化、真实 PCM 性能测试、插话取消和实时通话接入的工程与证据。

远端工程根目录：

```text
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/breeze-realtime-review
```

本文记录 Spark 上的工程和复测步骤。下文列出的上游源码、工具脚本、模型、编译产物与试听证据都由 Spark 本机保管。

## 1. 当前可用形态

- 爱莉微调源模型已转换为 F16、完整 Q8 和 Q8-dd4 GGUF；默认实时通话使用完整 Q8，不使用 dd4。
- 独立 C++ HTTP 服务容器 `breeze-elysia-cpp-q8` 运行在 `127.0.0.1:7865`，`restart=no`，WebSocket 已关闭。
- `plugins/voice-call` 新增部署侧 `breezeServerUrl`，默认 `http://127.0.0.1:7865`；浏览器不能改 URL、模型、参考音频或声音参数。
- 原 `breezeConfigPath` 继续提供参考音频、参考转写、instruction、CFG、seed、超时和文本上限；只覆盖通话服务地址。
- 普通聊天和 `send_voice` 仍使用 7862／7863，未改变其模型、推理模式或完整 WAV 返回契约。
- 通话仍使用独立 Session `elysia-voice-call`、`gpt-realtime-2.1-mini`、SOUL-only、空业务工具、单通话、最多 10 分钟；只有用户显式开始才获取麦克风并创建付费 Realtime 连接。

启动及运维见 `services/breeze-elysia-cpp/README.zh.md`，插件集成见 `plugins/voice-call/README.md`。

## 2. 权重谱系与校验

| 项目 | 路径或 SHA256 |
|---|---|
| 爱莉微调 PyTorch 源权重 | `/home/ayerelysia/AI/models/breeze-tts-2-elysia` |
| GGUF 输出目录 | `/home/ayerelysia/AI/models/breeze-tts-2-elysia-cpp` |
| F16 | `6a581621d7ece9cac2c6da31ef13fbcd32f5b5558daad1bd796e7dd2863aeeb0` |
| 完整 Q8（当前服务） | `9962f833585b188dc59090bdcbcefbd58f56f8444eddf12c330af2819f21a9d3` |
| Q8-dd4（实验备选） | `1cdb6009e8da683f34077da012f3852da5f413f2f87320083207c762b17328fe` |

复核：

```sh
sha256sum /home/ayerelysia/AI/models/breeze-tts-2-elysia-cpp/*.gguf
```

这些文件由现有爱莉微调模型转换而来，不是用参考音频临时克隆一个通用模型，也不是重新训练。用户已实际试听定制 Q8 长、短句并反馈“效果很好，不错”。试听文件在：

```text
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/breeze-realtime-benchmark/elysia-cpp-q8-short.wav
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/breeze-realtime-benchmark/elysia-cpp-q8-long.wav
```

## 3. C++ 源码、镜像与构建

- C++ 源码：`Breeze-TTS-2.cpp/`
- 原始源码包：`breeze-tts-2-cpp-source.tar.gz`
- 构建产物：`Breeze-TTS-2.cpp/build-cuda-full/breeze-server` 与 `breeze-quantize`
- 固定 Docker 镜像：`sha256:30d6ea28f36ed09b262eeb2eac0f9e1ca4081166179a24bd32b5c87308ef880a`
- 转换辅助：`FindCUDAToolkit.cmake`
- HTTP／WebSocket 实验：`capture_stream.py`、`validate_interruption.py`

GB10／sm_121 构建需要宿主机完整 CUDA 挂载 `/usr/local/cuda:/opt/cuda:ro`，并使用：

```text
CMAKE_CUDA_ARCHITECTURES=121
CUDAToolkit_ROOT=/opt/cuda
CUDA_CUDART=/opt/cuda/lib64/libcudart.so.13
```

不能用不含完整 CUDA toolkit 的普通运行时挂载复现这个构建。当前可运行产物和固定镜像已经保留，日常使用不需要重新编译。

## 4. 转换与量化复现

在 Spark 上执行，源模型只读，输出写入既有 GGUF 目录：

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --entrypoint python \
  -v /home/ayerelysia/Elysia/Elysium/Elysia-Harness/breeze-realtime-review/Breeze-TTS-2.cpp:/work:ro \
  -v /home/ayerelysia/AI/models/breeze-tts-2-elysia:/model:ro \
  -v /home/ayerelysia/AI/models/breeze-tts-2-elysia-cpp:/out \
  sha256:30d6ea28f36ed09b262eeb2eac0f9e1ca4081166179a24bd32b5c87308ef880a \
  /work/scripts/convert_hf_to_gguf.py /model \
  -o /out/breeze-tts-2-elysia-f16.gguf --dtype f16
```

量化命令在对应容器工作环境中执行：

```sh
/work/build-cuda-full/breeze-quantize \
  /out/breeze-tts-2-elysia-f16.gguf \
  /out/breeze-tts-2-elysia-q8_0.gguf q8_0

/work/build-cuda-full/breeze-quantize \
  /out/breeze-tts-2-elysia-f16.gguf \
  /out/breeze-tts-2-elysia-q8_0-dd4.gguf q8_0 --depth q4_k
```

重新转换或量化前应另行备份现有输出，避免覆盖已试听和校验的版本。

## 5. 服务边界与健康

```sh
curl -fsS http://127.0.0.1:7865/health
curl -fsS http://127.0.0.1:7862/health
curl -fsS http://127.0.0.1:7863/health
```

7865 当前健康响应为 `status=ok`、`sample_rate=24000`、`ws_port=0`。普通聊天兼容网关和官方推理仍分别由 7862／7863 负责，三者不能互相冒充。

## 6. 实测性能：空闲与竞争必须分开

以下均为真实 HTTP PCM 流、CFG 3.8、固定爱莉微调 Q8；不是估算。`breeze-realtime-benchmark/` 保存原始逐块结果。

| GPU 场景 | 文本 | 音频长度 | 首块 PCM | 总耗时 | 实时倍率 |
|---|---|---:|---:|---:|---:|
| 与官方 PyTorch 服务竞争 | 短句 | 4.48 s | 1.111 s | 6.355 s | 0.705× |
| 与官方 PyTorch 服务竞争 | 长句 | 23.92 s | 1.129 s | 33.304 s | 0.718× |
| GPU 较空闲复测 | 短句 | 4.48 s | 0.437 s | 2.383 s | 1.880× |
| 较空闲长句测试 | 长句 | 23.92 s | 1.122 s | 32.727 s | 0.731× |
| 最终试听生成 | 短句 | 4.48 s | 0.126 s | 2.432 s | 1.842× |
| 最终试听生成 | 长句 | 23.92 s | 0.143 s | 12.324 s | 1.941× |

两个推理进程共享同一 GB10，竞争会显著影响速度；最佳一次结果不是持续保证，长句也不能由短句结果外推。后续通话采用稳定短句、每通最多一个在途合成，不以抢占或停止普通聊天来粉饰性能。

最终试听由当前 7865 服务直接流式生成 PCM，再原样封装为 WAV，没有后期修音、降噪或更换音色。短句和长句分别为 24 kHz 单声道，未检测到削波样本；用户试听长句后明确确认“效果不错，可以”。样例及逐块指标保存在：

```text
breeze-realtime-review/results/preview-q8-20261112-short.wav
breeze-realtime-review/results/preview-q8-20261112-short.capture.json
breeze-realtime-review/results/preview-q8-20261112-long.wav
breeze-realtime-review/results/preview-q8-20261112-long.capture.json
```

复现短句测试：

```sh
python3 breeze-realtime-review/benchmark_realtime.py \
  --url http://127.0.0.1:7865 \
  --label elysia-cpp-q8-recheck \
  --out breeze-realtime-benchmark \
  --text short --cfg 3.8 --runs 2 --warmup
```

## 7. 真实插件打断／恢复验证

`plugins/voice-call/scripts/verify-q8-stream.mts` 直接调用生产实现 `loadBreezeSettings()` 与 `streamBreeze()`，不是另写一套 Python 请求来代替插件：

1. 从原 Elysium TTS 配置加载参考音频、转写、instruction、CFG 和 seed，只把服务覆盖为 7865。
2. 收到长句首个 PCM 块后再流式读取 500 ms，触发与通话相同的 AbortSignal／响应体取消。
3. 有界重试下一条短句，记录 409 与恢复首块时间，将恢复 PCM 封装为 WAV 供试听。

运行：

```sh
export PATH=/home/ayerelysia/.local/share/node-v22/bin:$PATH
cd plugins/voice-call
node --no-warnings --experimental-transform-types scripts/verify-q8-stream.mts
```

最近一次结果：首块 154.131 ms；取消被客户端明确观察；恢复经历 4 次 409，第 5 次在 395.359 ms 收到首块，完整恢复音频 2.24 s、24 kHz 单声道。结果位于：

```text
breeze-realtime-review/results/plugin-q8-interruption.json
breeze-realtime-review/results/plugin-q8-interruption.wav
```

HTTP 断开没有独立 cancel ACK。上述结果证明客户端取消和旧请求释放后的恢复，不把本地关闭 socket 的时间冒充服务端取消确认。C++ 服务端在 `apps/server/server.cpp` 的写入失败路径停止生成回调并释放 Slot。

## 8. 验收边界

插件离线检查为 14 个测试文件、167 项测试全部通过，TypeScript 类型检查及客户端构建通过。PCM Worklet 有 8 秒队列上限、epoch reset、旧代隔离与实际消费帧回执；控制器在插话时取消本通话 Breeze、取消 provider response、递增 epoch 并清除旧段。

这些结果不等于真实端到端通话已经验收。仍需用户在 ElyHarn 页面显式点击开始、授权并打开麦克风，做一次受控付费 Realtime 短测，分别确认真实 WebRTC、可听声音、开口打断、挂断和普通聊天回归。不能用按钮出现、离线 PCM 或本地合成成功替代这一验收。
