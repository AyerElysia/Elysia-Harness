# 本地 ASR 级联试用验收（2026-11-13，上海时间）

本次仅将 Spark 回环 DSH 预览切到 `local-asr`，继续使用独立原生 Session `elysia-gemini-cascade`、LiveKit 音轨与现有 Breeze 爱莉固定音色。正式 DSH 3299 仍是原进程，主意识、正式插件和共享模型网关均未改。隔离预览没有公网监听或自动拨号。

## D1 核对

ElyHarn 现有 D1 受控引用可读模型目录，目录未返回 Gemini；精确 `gemini-3.8-flash` 流式请求 HTTP 403。旧 Elysium 是另一份同渠道凭据，目录也未返回 Gemini，精确短请求 HTTP 503。仅证明这两份已配置凭据当前未通过验收，不泛化为整个 D1 无此模型。本次没有切换模型配置或自动换渠道，ASR 预览继续明确用原来的 NexusAI → A6 Gemini 3.8 Flash。

## 本地识别与隐私

Spark 的 SenseVoice INT8、词表、Silero 三份资产按原有 DSH 固定 SHA-256 校验，复用已安装的 ARM64 sherpa-onnx Node 运行库。ASR 只在本机 18796 接收需要私有桥接令牌的受限 PCM。中文合成样句准确识别，整段音频送完到返回约 92 ms。此模式只允许纯文字发给 Gemini；原声不保存、不发送到模型渠道。浏览器须先确认明确模式，错误模式在开房前返回 409。会话展示用户最终转写，未取得文字时不编造。没有滚动字幕。

## 实际 DSH 端到端

只使用程序内生成的英文算术语音，不开启麦克风。DSH 开房 → 真实 LiveKit 进出音轨 → SenseVoice → A6 → Breeze → DSH 正常挂断。真实转写和答案均通过预期校验，接收端收到 131 个非静音 Breeze 帧，挂断 HTTP 200。ASR 开始到最终转写 57 ms；模型开始到首字 15.706 s，模型开始到首个非静音音轨帧 15.857 s。原生压缩 Session 记录含转写和正确回复，未发现原声负载。另一次独立 A6 合成文字请求正确，首字 20.25 s。

44 项 Python 测试、14 项 DSH 插件测试、4 项 ASR 接口测试及前端构建通过。ASR 和打断逻辑有离线测试；此前实测的三轮插话使用模拟模型，**本次 A6 + ASR 只验收一轮**。没有宣称已做真实浏览器、用户听感、稳定低延迟或实际多轮插话验收。A6 首段延迟仍明显，暂不挂正式入口。

## 本次运行（只用于定位，不作长期 PID 假设）

Spark：ASR PID 4103968 / 18796；Gemini broker PID 4111169 / 18794；worker PID 4111239 / 18792；DSH 预览 PID 4121198 / 18795（私有事件 18793）。均为回环监听。预览运行目录 `/tmp/elyharn-gemini-cascade.upPA0yfJ`，broker 私有运行目录 `/tmp/elyharn-gemini-cascade.k0FFoGH0`，ASR 模型缓存 `/tmp/elyharn-local-asr.wTaBp92q`。凭据、启动认证链接及私有日志不复制、不分享。
