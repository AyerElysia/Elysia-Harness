# DSH 会话内语音通话

此插件默认关闭，Spark 的正式 Web profile 已显式启用本地 ASR（3299 回环入口）。左下角保留独立「爱莉通话」，「主意识」的原生输入框旁也有电话按钮；两种通话均在对应的普通 DSH 会话里显示转写和回复，不在控制条重复显示。旧独立面板停用，旧历史保留。先明确同意再申请麦克风；离开或挂断停止本地媒体，不自动重拨。

通话中的 LiveKit 房间持续接收麦克风。`local-asr` 模式等一句话结束后在 Spark 本机用 SenseVoice 转写；独立会话只将转写文字交给 Elysium 既有 `NexusAI / A6API-Gemini` 的 `gemini-3.8-flash`。旧的 `direct-audio` 模式只用于隔离对照，会直接发送当轮 WAV，当前 A6 未通过原声验收。两种模式由部署方明确选择，不自动回退。返回文字按可读短句交给既有 7865 Breeze 流式接口，参考音色固定。媒体双向且可打断，模型仍逐轮推理。

独立会话使用 SOUL 提示词、不带入旧通话音频或主意识历史。每通文字和语音共享本通上下文；旧通话不是新通话的模型上下文。通过受保护的服务端事件将完成文本和输入事实写入同一原生 Session。本地 ASR 成功时把最终转写以带来源的用户消息留在同一 Session；未识别到文字时只留语音发言标记，不捏造转写。原声只在请求处理中存在，不录音、不持久化、不提供回放。本地 ASR 模式不向上游发送音频。已生成和已送入音轨都不等于用户实际听见。

## 主意识

Web profile 的 `mainSessionVoice: true` 只允许已运行并装配好的 `elysia-conscious-mind` 使用本地 ASR，不从通话创建、恢复或替换主 Agent。转写以与 Web 打字等价的普通用户消息进入原生下一轮队列，原生历史、模型、工具和输入框不变。通话中可以继续打字；只有和该语音请求精确关联的最终普通回复会被交给 Breeze 流式播报。后台、工具过程和与其他输入混合的轮次不播报，但仍按 DSH 原规则显示。插话或挂断只清空媒体、解除播报关联；已经接收的主意识消息和任务继续按原有流程运行，不取消 Agent 或清空它的队列。

验收：用原生 DSH AgentLoop 和本地模拟模型验证打字 → 语音转写 → 打字读取同一份上下文、后台隔离、插话不取消、混合输入不播报。Spark 正式 `3299` 验证新前端包、主意识和独立会话入口、本地 ASR 模式，以及未发布任何音轨的 LiveKit 接通与挂断。没有向正式会话发送测试消息；真实麦克风及可听音色由用户开麦验收。

## 隔离预览

`services/voice-livekit-pilot/dsh-cascade-profile` 是私有预览模板。用新 DSH_HOME、独立 profile、仅回环 18795 启动；不要用正式主意识的 home 启动第二个 writer。链接构建好的插件包，按 DSH 原生方式完成浏览器认证。仅预览 profile 显式启用本插件。构建与测试：`pnpm --filter @elysia/gemini-cascade build`、`pnpm --filter @elysia/gemini-cascade test`。

独立 broker 和 worker 复用已经运行的 Spark LiveKit 试验实例；只用回环端口。本地 ASR 的模型准备和 18796 服务见 [ASR-LOCAL](../../services/voice-livekit-pilot/ASR-LOCAL.md)。先启动 ASR，再用 `gemini_broker.py --local-asr`；启动预览 DSH 时设置 `ELYSIA_GEMINI_CASCADE_LOCAL_ASR=1`。两端模式不一致会在取得麦克风权限前拒绝开房。健康 18792，私有 DSH 事件 18793，私有 broker 18794。两端使用同一个 owner-only 0600 随机桥接文件；OpenAI 试验凭据与 A6 凭据互不复用。Broker 仅从既有 Elysium 私有 TOML 内存读取网关引用，不复制或输出凭据。正式 Web、Breeze 和模型网关都无需重启。

正式接入和消息时序见 [正式会话验收](../../docs/report/2026-11-13-dsh-native-voice-timeline.zh.md)。详见 [初版实施记录](../../docs/report/2026-11-12-gemini-cascade-session.zh.md) 和 [本地 ASR 级联验收](../../docs/report/2026-11-13-gemini-cascade-local-asr.zh.md)。
