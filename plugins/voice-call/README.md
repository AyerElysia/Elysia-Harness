# Voice call

爱莉独立语音 Session 的最简通话插件，包名 `@elysia/voice-call`。用户已批准 [MVP 方案](PLAN-MVP.zh.md)，随后批准将已试听认可的爱莉微调完整 Q8 独立服务用于实时通话。

已通过原生接口加入 Spark Web profile，并在本机 Chrome 验证通话面板及“开始通话”按钮可用；服务和目标模型元数据检查通过。**尚未点击开始或开麦，真实 WebRTC、声音、插话及付费通话仍待短测，不能把入口就绪描述成通话已验收。** 证据见 [Web接入记录](../../docs/report/2026-11-12-voice-call-web-activation.zh.md)。

默认 `enabled: false`。导入/挂载只注册现有宿主路由及生命周期、读取凭据是否配置的描述；不解析密钥、不读取 SOUL、不打开活动存储、不创建 Session、不连接模型、不获取麦克风、不启动业务定时器。仅显式开始通话才获取对应资源。

## 固定边界

- 一个稳定原生 Session `elysia-voice-call`，每通新的云端连接，最多10分钟，不自动重拨，不自动灌入旧通话上下文。
- 复用固定提示词管理，系统只加载原有 SOUL；空业务工具，主意识和原聊天语音不动。
- 精确模型 `gpt-realtime-2.1-mini`，输出文字；通话 TTS 使用 `127.0.0.1:7865` 上已试听认可的爱莉微调完整 Q8 C++ 服务。普通聊天与 `send_voice` 继续使用原 7862／7863，不改其模型或推理模式。
- 完整生成先进入原生耐久记录，再分句顺序合成并流式播放。不是逐 token 发声，也不等待完整 WAV。
- 本程序不持久保存原声/PCM或整通录音。音频输入会发送至 OpenAI 处理；云端数据政策由相应服务约定管理。未取得合法转写时只保存明确的输入事件 notice，不编造用户原话。
- 完整生成、客户端报告播放、已回投 provider 的完整段分别留有事实；不把回执当成物理听见的证明。
- 页面/流/sideband故障、心跳过期、10分钟上限及卸载均关闭对应云端 call，不停止普通聊天 TTS。

## 配置与凭据

部署选项：`enabled`、专用绝对路径 `cwd`、既有 `promptsDir`、现有 `breezeConfigPath`、`breezeServerUrl`、`apiKeyRef`、可选 `openaiProxyUrl`。`breezeServerUrl` 默认且当前 Web 显式配置为 `http://127.0.0.1:7865`，仅允许部署侧指定受限制的 loopback 服务；参考音频、转写、instruction、CFG 和 seed 仍从原 `breezeConfigPath` 读取。`openaiProxyUrl` 仅允许无凭据的 HTTP loopback 代理，按插件作用域连接官方 HTTPS/WSS，不修改全局代理或 Breeze；浏览器不能指定这些值。打开本机页面及临时转发见 [操作说明](../../docs/operations/voice-call-web.zh.md)。

Q8 工程、模型哈希、性能与取消证据见 [实时通话工程](../../breeze-realtime-review/README.zh.md)，服务启停见 [专用服务说明](../../services/breeze-elysia-cpp/README.zh.md)。真实插件 PCM 打断／恢复复测：

```sh
export PATH=/home/ayerelysia/.local/share/node-v22/bin:$PATH
cd plugins/voice-call
node --no-warnings --experimental-transform-types scripts/verify-q8-stream.mts
```

默认凭据引用为 `OPENAI_REALTIME_API_KEY`。用户明确授权的 key 已写入 Spark 现有受控凭据服务；不在源码、此文档或浏览器中保存真实值。之后替换同一引用即可，下次通话按操作重新读取，无需重启。仍建议轮换曾在聊天中披露的 key。

## 离线检查

依赖准备好后，从仓库根目录使用已存在的工具，不为运行测试安装全仓依赖或启动正式服务：

```sh
cd plugins/voice-call
../../dsh/node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
../../dsh/node_modules/.bin/tsc -p tsconfig.test.json
node build.mjs
```

测试使用临时原生 JSONL、临时审计域和假 provider/TTS/浏览器，不写正式数据、不产生通话费用。真实浏览器的 HTTPS/localhost、麦克风、AudioWorklet/CSP、WebRTC网络与实际延迟仍必须单独验收。

范围与后续完整需求见 [REQUIREMENTS.zh.md](REQUIREMENTS.zh.md)，本次证据及未完成项见 [实施记录](../../docs/report/voice-call-mvp-20261112.md)。不改 vendored `dsh/`，不把无行为占位的旧测试当成真实通话验收。
