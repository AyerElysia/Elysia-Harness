# Voice call MVP：运行边界

本文件描述 `plugins/voice-call` 当前源码边界，不是部署或真实通话验收证明。用户已批准 MVP；实际阶段、测试与未完成项见 [实施记录](../report/voice-call-mvp-20261112.md)。

## 一个独立实例，不是新的人格

语音窗口与主意识属于同一持续主体，使用独立原生 Session `elysia-voice-call` 和专用 cwd；不复制或读取主意识私有历史，不修改全局 Agent factory。每通人工开始的电话新建 provider call，仅加载本通上下文。旧的本地原生记录保留，旧音频不保存且不能重放，恢复时明确取消旧不可重放 pending 输入。

原生 `VoiceAgent` 真正实现 Agent 契约，通过公开 register/enter 绑定 Session、scope、inbox、turn/step、stream、取消及关闭。现有 sessionPersistence JSONL 单写者在注册前取得，Agent 关闭/flush 后再释放；不加第二份 append writer，不调用外部插件禁止使用的 appendPluginRecord。

认知系统提示词通过现有 StandingPrompts 读取原有 SOUL，仅此一个 literal section，同时清空额外 tools/contexts/variables。首次连接和每轮回复前读取、确认 provider 更新；缺失/空白就失败，不拼入第二份角色模板。不得修改主体文件内容。

## 数据流与事实身份

浏览器麦克风通过 WebRTC 直接到 OpenAI Realtime，服务器 sideband 是唯一生成 owner。模型固定 `gpt-realtime-2.1-mini`、文字输出、空工具、VAD 自动生成和自动打断关闭；服务端按实际事件控制生成。

取得的完整模型文字先通过原生 assistant/message 和 flush，再顺序机械分段交给既有7862共享 Breeze 入口。每通仅一个在途合成；默认爱莉参考音频、转写、instruction、CFG、seed 及推理模式不变。PCM 分块走认证 SSE，浏览器24kHz mono s16le连续播放；不建立新推理服务、不等待完整 WAV，也不是逐 token TTS。

本程序不录制或持久保存输入原声/PCM。没有合法转写时，原生输入是空正文且明确 `elysia-voice-input-event` notice，source 保存 provider item、call、epoch、时间、不可回放事实，不编造人类原话。OpenAI 接收并处理音频的上游数据政策仍由其服务约定管理。

模型生成原文属于原生 Session 认知活动；运维状态、用量、取消及客户端回执属于基础设施事实，进入全局 `storageDomain` 域 `elysia_voice_infrastructure`。此域不保存 SOUL、模型正文、原声或凭据，不替代原生认知历史，也不形成私有 persona/长期记忆。每条事实带 actor/source/session/call/epoch/occurrence/time；公开 reader 提供有界分页。

完整生成、客户端报告播放、provider 接受的完整段投影相互区分。只把客户端报告完整播放的连续原文段加入 provider conversation；不以生成结束推断听完，不把客户端报告当成物理听见证明，不对文字使用原生音频 truncate。

## HTTP 与浏览器

仅复用宿主 owner-authenticated connection.fetch，不开新端口。原生路由为：

| 路径 | 方法 | 响应 |
|---|---|---|
| /api/voice-call/state | GET | 原始 VoiceState，无密钥/cap |
| /api/voice-call/start | POST | 原始 VoiceStartResult，唯一回传内存 capability 的入口 |
| /api/voice-call/events?callId=… | GET | SSE event: voice-call |
| /api/voice-call/control | POST | 原始 VoiceState |
| /api/voice-call/playback | POST | {ok:true} |

events/control/playback 还要求 `X-Elysia-Voice-Capability`，不放 URL、持久存储、日志或 JSON 控制体。浏览器 tab 共用宿主 owner Peer，所以不能只凭宿主登录状态认定 call 控制权。单 call 单 SSE owner，不自动重连；刷新丢 capability 后只读并等租约终止。

请求/流/播放缓冲有界；PCM 单事件不超过32KiB原始音频，旧 epoch 和重复 seq 丢弃。服务端显式监听 Request.signal：宿主在客户端断开后可能继续 drain response，不能只依赖 ReadableStream.cancel。

仅明确点击开始并确认隐私后申请麦克风；SSE、WebRTC和后端 unmute 就绪后才发送音轨。需要 HTTPS 或 localhost、安全上下文、AudioWorklet/CSP 和浏览器权限。它们尚须真实浏览器验收。

## 生命周期与凭据

默认禁用；挂载只注册路由、生命周期及凭据描述，不打开媒体、Session、活动存储或付费连接。每通最多10分钟，客户端5秒心跳、20秒租约；没有自动拨号、续接、重试或模型 fallback。流、sideband、记录或播放关键故障关闭当前 provider call，不停止共享 Breeze 或主意识。无法确认 hangup/资源清理时明确 failed，不允许假成功后新拨。

凭据只用 `OPENAI_REALTIME_API_KEY` 等受控引用。用户明确授权的 key 已保存于既有 Web 凭据服务，文件权限0600且被版本控制忽略；下次操作重新解析，替换不需要重启。前端不接触长期 key，公开日志不打印 SDP、SOUL、音频或凭据。

卸载必须结束自身连接与任务，再释放原生 Agent/Session writer 和运维审计 owner；不删除权威历史。不得把离线成功、入口可见或原聊天语音成功冒充实际全双工体验验收。
