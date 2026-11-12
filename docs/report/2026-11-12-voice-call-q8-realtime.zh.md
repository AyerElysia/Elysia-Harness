# 爱莉定制 Q8 实时通话接入记录

日期：2026-11-12。状态：本地语音链路、插件离线检查和定向加载完成；真实麦克风与付费 Realtime 短测未完成。

## 决定与范围

用户已试听爱莉微调 C++ 完整 Q8 并明确认可效果，随后要求做成实时通话。本次将 `voice-call` 的 TTS 从早期方案中的共享 7862 改为独立 `127.0.0.1:7865`，其他 MVP 边界保持不变。

普通聊天和 `send_voice` 继续使用 7862／7863，未修改其模型、推理模式、完整 WAV 契约或服务配置。Realtime 仍为 `gpt-realtime-2.1-mini`；独立 Session `elysia-voice-call`、SOUL-only、空业务工具、单通话、最多10分钟、显式开始才开麦和拨号、不保存原声或整通录音均不变。

## 工程与服务

- 工程：`/home/ayerelysia/Elysia/Elysium/Elysia-Harness/breeze-realtime-review`
- 完整说明：`breeze-realtime-review/README.zh.md`
- 服务管理：`services/breeze-elysia-cpp/`
- 容器：`breeze-elysia-cpp-q8`
- 固定镜像：`sha256:30d6ea28f36ed09b262eeb2eac0f9e1ca4081166179a24bd32b5c87308ef880a`
- 服务：仅 `127.0.0.1:7865`，`restart=no`，`--ws-port -1`
- 健康：`status=ok`、`sample_rate=24000`、`ws_port=0`

当前服务 GGUF SHA256：`9962f833585b188dc59090bdcbcefbd58f56f8444eddf12c330af2819f21a9d3`。

## 插件实现

- `breezeServerUrl` 默认 `http://127.0.0.1:7865`，Web profile 也显式写出此值。
- 仅覆盖 `server`，参考音频、参考转写、instruction、CFG、seed 等仍从既有 `breezeConfigPath` 读取。
- 浏览器不能传 URL、模型、声音或参考文件；服务地址仅接受受限 loopback、7862 或 7865。
- `streamBreeze()` 保持原始 PCM 流式消费、 AbortSignal、统一截止时间、格式校验及读取器取消。
- 启动失败按 Breeze 配置、Agent 准备、凭据解析、provider 创建分阶段返回安全错误码；合法上游 HTTP 状态进入受控诊断。
- 补齐当前框架要求的 `tools` 注入和测试夹具，不改 vendored `dsh/`。

## 已执行验证

### 离线

在 Node 22.20.0 下执行：

```sh
cd plugins/voice-call
../../dsh/node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
../../dsh/node_modules/.bin/tsc -p tsconfig.test.json
node build.mjs
```

结果：14 个测试文件、167 项测试全部通过；类型检查通过；客户端构建成功。

### 真实生产函数到 7865

`scripts/verify-q8-stream.mts` 直接调用 `loadBreezeSettings()` 与 `streamBreeze()`。最近一次结果：

- 长句首个 PCM：154.131 ms，首块 3840 bytes。
- 首块后继续读取 500 ms，再触发取消；客户端明确观察到 aborted。
- 下一条请求发生 4 次 409，第 5 次在 395.359 ms 收到新首块。
- 恢复音频 107520 bytes、2.24 s、24 kHz mono s16le，已保存 WAV 和 JSON。

证据：`breeze-realtime-review/results/plugin-q8-interruption.json` 与同名 WAV。HTTP 没有独立 cancel ACK；这证明客户端取消和释放后的恢复，不声称有服务端独立取消回执。

性能空闲与竞争数据分开列在工程 README。共享 GB10 上长句仍可能慢于实时，不能由一次短句最佳结果承诺持续无卡顿。

### 最终音质试听与用户确认

收束前重新通过当前 7865 服务生成短句和长句，流式 PCM 原样封装 WAV，无后期修音、降噪或音色替换。短句 4.48 s，首块 126.326 ms、总耗时 2.432 s；长句 23.92 s，首块 143.434 ms、总耗时 12.324 s，分别约为实时的 1.842× 和 1.941×。两者均为 24 kHz 单声道，未检测到削波样本。

用户实际打开长句试听并明确确认“效果不错，可以”，同意收束工作文档。样例与指标保存在 `breeze-realtime-review/results/preview-q8-20261112-{short,long}.wav` 及对应 `.capture.json`。本次确认针对本地实时链路的生成音质，不替代下节的真实麦克风与云端通话验收。

### 普通聊天与加载状态

真实 Q8 测试后，7862 返回 `ready=true`、`backend_ready=true`、`busy=false`，7863 与 7865 均返回健康。

在没有活动通话时，使用原生 `pluginManager/setBundleEnabled` 只对 `@elysia/voice-call` 执行一次 disable→enable，两个操作都 `applied`、`changed=true`。Web 进程身份不变；重载前后 `@elysia/conscious-mind` 都 enabled、active，`elysia-conscious-mind` Agent 可用且非运行中；通话最终 enabled、active、idle、capture inactive，无错误码。未重启整个 Web，未执行全 profile reconcile。

## 尚未验收

没有在本轮点击开始、申请真实麦克风、建立付费 Realtime call 或进行真人听说。因此以下仍待用户受控短测：

1. 浏览器麦克风权限和真实 WebRTC 建连。
2. 实际扬声器听到爱莉 Q8 声音，检查首响与段间停顿。
3. 真人开口触发停播、取消旧合成并恢复后续回答。
4. 静音、停止播放、挂断、10分钟上限和异常清理。
5. 同一时段普通聊天与 `send_voice` 回归。

不能把按钮存在、插件 active、离线 PCM 或本地 HTTP 合成成功写成完整实时通话已验收。
