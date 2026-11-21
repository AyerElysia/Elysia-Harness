# 最简实时通话审批稿

版本：MVP v1。日期：2026-11-12（UTC+8）。状态：用户已批准，正在实施；尚未完成端到端验收。

本版只做一个人的实时语音对话：新建独立语音 Session，复用现有固定提示词管理，认知系统提示词只加载 SOUL；Realtime 处理听觉和回复，官方 BreezeTTS2 用现有爱莉声音发声。当前主意识与聊天语音保持原样。

用户已回复“OK就这么做”批准本文 MVP；之后确认不保存原声，并明确授权将此前提供的 key 先写入受控配置、之后自行替换。仅显式点击开始才开麦及创建付费连接；实施与验收证据见 docs/report/voice-call-mvp-20261112.md。

### 2026-11-12 通话 TTS 路由修订

用户试听爱莉微调权重的 C++ 完整 Q8 长、短句后明确反馈“效果很好，不错”，并要求“把这个做成实时通话”。因此最新决定是：实时通话改用独立的 `127.0.0.1:7865` 爱莉定制 Q8 服务，替代本稿早期建议的共享慢速 7862 通话路由。其余 MVP 决定不变，普通聊天与 `send_voice` 继续使用 7862／7863，不停止或改写它们。

部署新增 `breezeServerUrl`，默认及 Web 显式配置均为 `http://127.0.0.1:7865`，浏览器不能选择。参考音频、转写、instruction、CFG 和 seed 仍来自既有 `breezeConfigPath`。本修订不改变模型训练、Realtime 模型、Session、提示词、工具、隐私或时长边界。工程、模型哈希、空闲／竞争性能及真实插件打断恢复证据见 [实时通话工程](../../breeze-realtime-review/README.zh.md)；旧文保留作审批历史，冲突处仅以本修订和实测状态为准。

## 1 已明确的要求与本版建议

| 项目 | 决定来源与范围 |
|---|---|
| 独立新 Session | 用户已要求；不使用 elysia-conscious-mind，不替换文字主意识 |
| 固定提示词 | 用户已要求复用旧管理方式，系统只用 SOUL |
| 认知模型 | 沿用 gpt-realtime-2.1-mini，不另串一个文字模型再想一次 |
| 发声 | 沿用已验收的官方 BreezeTTS2 与固定爱莉参考音频，不用 OpenAI 音色 |
| 客户端 | 建议在现有 ElyHarn Web 增加一个通话面板，只支持桌面 Chrome/Edge 单人通话 |
| 工具 | 建议首版空工具清单；无文件、网页、计划、平台消息发送与长期记忆写入 |
| 规模 | 建议一个专用稳定 Session、同时一通电话，每通最多10分钟，不自动重拨或续接 |
| 留存 | 用户已确认不保存原声或整通录音；保留取得的文字和活动事件，明确原声不可回放 |

## 2 第一版用户体验

在现有 Web 面板点击“实时通话”，看到独立 Session、连接、收音、生成、播放状态。点击“开始通话”后才请求麦克风权限和创建付费连接；打开页面、启动 ElyHarn 或加载插件都不自动拨号。

界面仅需要“开始通话、静音/取消静音、停止当前播放、挂断”、爱莉字幕及错误提示。输入输出采用系统默认设备，复杂设备管理和波形动画不列入首版。麦克风持续输入，Breeze 播放时也不关麦；收音和播放状态可以同时成立。

静音只停发麦克风，不挂断；停止播放只影响当前输出；挂断立即停止本地采集和播放，再有限时间清理服务器资源。麦克风拒绝、浏览器拒播、不安全页面或后端故障都显示明确原因，不以空白或假在线代替。

本版不做：Ayla/QQ/飞书/KOOK 通话入口、多人房、视频、跨设备、后台操作工具、自动长通话续接、跨主意识同步上下文或新造人格记忆。原聊天 send_voice 仍正常使用。

## 3 Session 与主体归属

建议唯一语音 Session id 为 `elysia-voice-call`，专用稳定 cwd 为 `homes/web/voice-call` 对应的绝对部署路径。第一次正式开始时创建，后续复用，不因挂断删除记录，也不借用主意识目录。若发现同名但归属不符的 Session，明确报冲突，不覆盖或清空。

专用语音实例仍属于同一持续主体，不是另一个人格；只共享已有 SOUL 来源，不复制、拼接主意识私有历史，不加载 USER、MEMORY、TOOLS 或其他固定提示词。其他渠道继续送原来的主意识，不把聊天 pending 改成音频队列。

区分四个身份并建立关联：

- 原生 DSH Session：持久记录和 UI 归属。
- 语音 Agent：真正驱动 Realtime 的运行对象。
- callId/epoch：本次通话和取消代次。
- OpenAI provider session/response/item：本次云端连接及输出身份。

**首版上下文建议**：本地 Session 保留自己的记录；每次手动开始一通新电话创建新的 provider 连接，第一版不自动向它灌入旧通话历史。UI 明示“本通话上下文”，不能假称恢复了旧云端会话或模型记得未加载的内容。跨通话上下文续接可在下一版单独设计，不改变主体归属。

### 必须先通过的适配门槛

现有 `ctx.agents.create/resume` 会构造普通 ReactLoopAgent，没有现成的 Realtime runner。不能建一个同名空 Session，再让旁路 Realtime 思考，却宣称两者已经接通。

方案是在插件层实现一个真正满足原生 Agent 契约的 Realtime 适配器，使用公开的 `ctx.agents.register/enter` 扩展点注册，不替换全局 factory；它必须真实绑定合法 Session、scope、持久化写入 owner，并支持状态、取消、whenIdle、inbox/send/followup 和关闭。会影响现有主意识的接口不能重用或覆盖。

先用离线假 Realtime 验证注册、记录、取消、关闭与 UI 状态。不得 cast 一个假 Agent，也不得使用明令禁止外部插件生产调用的 `appendPluginRecord()` 自造权威账本。若合法记录/注册路径不足，停在这个技术门槛，说明缺口后重新审批，不先开始付费通话。

## 4 只用 SOUL 的固定提示词

只复用 `@elysia/conscious-mind/standing-prompts` 与现有 systemPrompt assemble/render，不复用 `composeMainAgent()`；后者还会挂载文件、网页、计划和其他能力。

审批后的语音作用域配置意图：

```json
{
  "baseDir": "<既有站立提示词目录>",
  "files": ["SOUL.md"],
  "required": ["SOUL.md"],
  "complete": true
}
```

当前既有目录由配置解析；Web 的 standing-prompts 链接指向 `/home/ayerelysia/Elysia/Data/standing-prompts`。不创建 VOICE_SOUL、不复制另一份 SOUL，不替她写新的自我描述。

管理器已把 section 的 `interpolate` 固定为 false，按原逻辑仅裁去文件边缘空白，不加标题、角色模板或新的风格指令。Realtime 的 `instructions` 必须显式等于该次 render 的 SOUL，不留空触发 provider 默认提示词，也不另外添加 developer/system 文本。

complete=true 只决定 system sections，**不会自动清空 tools 和 contexts**。语音作用域还必须显式隔离全部工具与默认系统上下文，验收最终有效提示词，而不是只看配置里列了一个文件。技术状态放协议字段或有来源的输入事件，不偷偷变成第二段人格提示词。

同步时点：首次建连前装配；每次真正生成回答前重新装配。服务器关闭自动生成，由唯一 owner 在确认本轮 SOUL 更新被 provider 接受后再请求回答。SOUL 正在修改或缺失/空白时不开始新回答；已开始的一轮保持其版本，下一轮才更新。记录来源、render hash 和实际生效的轮次，不在公开日志复制 SOUL 正文。

“系统只用 SOUL”指 Realtime 认知系统提示词；不覆盖已验收的 Breeze 固定音色与合成 instruction 配置。首版不额外要求模型输出 JSON 情绪或内心话，普通文字直接合成，原生声音事件若出现则原样保留。

## 5 最少新增媒体设施的链路

```text
用户麦克风 ── WebRTC ──→ OpenAI Realtime Mini
                                  │ 纯文字增量
                         服务端 sideband 唯一接收
                                  ▼
                    新语音 Agent 与原生语音 Session
                                  │ 稳定短句
                                  ▼
                 既有7862共享入口 → 官方 BreezeTTS2
                                  │ PCM 分片
                                  ▼
               既有认证 HTTP流或SSE → 浏览器播放器
```

建议采用官方 WebRTC unified SDP 方式：后端创建 Realtime call，长期项目密钥不进浏览器；SOUL 由服务端受控读取并传给获授权的 OpenAI provider，不由浏览器选择文件或修改配置。已授权 WebRTC 客户端可能从 provider 配置事件看到 instructions，不能承诺 SOUL 只留在 Spark。服务端 sideband 负责同一个 provider 会话的输出、控制和记录。[O1][O2]

Realtime 仅文字输出，不产生 OpenAI 音频。浏览器不再把模型文本转交给服务器冒充可信生成；Breeze 输入只接受服务器收到并归属的 provider 事件。页面不发送配置/生成命令，服务器校验实际会话配置；若检测到异常改写则终止通话。[O3]

现有 Web 的认证 fetch/SSE 和侧栏挂载模式可复用，但 PCM 连续播放、sideband 和 Session 适配器均需新增。优先验证现有载体是否真正保持流式；如果宿主缓冲整条响应，不静默改造另一套服务或 WebSocket 协议，先报告替代方案。

浏览器用 Web Audio 的小缓冲播放器处理24kHz mono s16le，不把每个网络块当独立 WAV 文件。协议包含 callId、epoch、segmentId、chunk 序号和格式；事件流必须有界、可取消，旧代音频不能播入下一轮。若 SSE 承载 PCM，可使用 base64 数据分片，但不在日志打印音频。

麦克风必须位于 HTTPS 或 localhost 安全上下文。直接打开不安全的 Spark IP 页面不属于已支持路径；实施时先验证现有访问入口及 WebRTC 网络可达性，不把这些问题留到用户开麦时才发现。

## 6 一轮对话和插话

1. 点击开始，先完成原生语音 Session、归属与提示词装配，准备播放器和记录，再允许麦克风发送；失败不假在线。
2. 首版建议 server_vad。设置 `create_response=false`、`interrupt_response=false`，仅使用事件通知，由服务端统一决定实际媒体取消和生成时点，避免自动生成绕过每轮 SOUL 装配。[O4]
3. 服务端收到 provider 的 speech_started 后发送停播控制，浏览器收到控制即停止旧播放；同时提高 epoch、取消本通话旧 Breeze 请求和仍在生成的旧 response。不停止共享 TTS，也不取消主意识的其他工作。首版没有现成本地零延迟 VAD，必须实测开口到停播的总延迟。
4. 用户话音结束后，本轮先确认 SOUL 版本，再请求 Realtime 回答；收到文字按稳定短句依次交给 Breeze，不等整段 WAV 才播放。
5. 挂断或关键控制/记录连接丢失时，本地停止音频，服务器关闭 provider call 与本通话任务；不能只断开 sideband、留下仍在计费的媒体连接。

OpenAI 不知道外部 Breeze 播到了哪里，原生 audio truncate 不能当成文本截断。保存完整原始生成，同时维护区分“已生成、已完整播放、部分播放/未知、未播放”的对话投影。[O3]

建议在适配门槛中验证 `conversation:"none"` 的 out-of-band 文字回答，只把有播放回执的完整原文段投回 provider 对话；不从生成完毕推断用户听完。部分段落没有逐字对齐时只报告时间范围与不确定性，不编造已听到的字句。若该方案与原生记录/顺序不兼容，先停并修订，不能通过删除权威历史解决。[O3]

## 7 保护原聊天与实时性能边界

继续使用已验收的7862共享入口，默认参考音频、转写、CFG、seed 和推理模式不动。普通聊天及直播仍走原完整 PCM 转 WAV 契约；通话新增流式消费者，不改 `requestBreeze()` 的返回类型。

每通电话最多一个在途合成，不能把整轮所有短句一次灌满 FIFO，不抢占已在排队的聊天或直播。分段只处理语音传输边界，不判断哪句更重要；缓冲耗尽时明确中断并记录未播范围，不能静默删掉文字。

现有样例的5.36秒音频用7.957秒生成，首块约398ms。它证明流式可用，但该样例整体速率慢于实时，不能据此承诺长时间连续流畅说话。首版先测短句的真实可听延迟、段间停顿、打断与队列竞争。

若达不到可用体验，保留实验状态并报告；不擅自改变已验收的共享推理模式、开启第二模型或切回 OpenAI 声音。官方 fast flags 的专项验证可后续申请，不并入本轮默认授权。

## 8 安全 费用与留存建议

- 一个已鉴权用户、一个活动通话，建议每通10分钟硬上限；到时提示结束，不自动创建下一付费连接。
- 仅使用服务器受控凭据引用。用户后续明确授权暂用其先前提供的 key，现已保存到 OPENAI_REALTIME_API_KEY，由用户之后替换；仍建议轮换已披露凭据。模型权限需真实短测确认。浏览器不能指定任意 model、baseURL、prompt 文件或主体 Session。
- 复用宿主鉴权，start/control/events/playback 回执都验证用户与 call owner。浏览器回执只表示客户端报告，不当作服务端模型事实或物理听到的证明。
- 显示已确认 usage 和未知结算；音频输入仍计费，纯文字输出不等于免费。费用核算按实施时官方价格，首版不自动切模型、续费或无界重试。
- 建议持久保存本 Session 实际取得的生成原文、配置版本引用、来源事件、投递/播放状态和异常，不把它混入主意识私有上下文。不得伪造未返回的 hidden reasoning。
- 默认不做整通诊断录音，不无限保存环境声音。若不批准原声/音频片段持久化，记录必须明确输入音频不可回放，不能以转写或元数据冒充原声；如有合法转写也注明其派生性质。具体留存模式须先确认再开生产采集，不能把“最简”当作省略权威活动记录的理由。
- 声音引用、会话记录、临时媒体与密钥保持受保护，公开日志只含必要阶段、ID 和错误码；挂断清理瞬态缓冲，不删除已形成的权威历史。

## 9 审批后的实施顺序

| 阶段 | 交付与放行条件 |
|---|---|
| A 离线适配门槛 | 假 Realtime 驱动真实独立 Session；SOUL-only、真实记录、单一 owner、取消/关闭通过；不调用云端 |
| B 媒体小样 | 现有Web认证载体流式验证，PCM播放器、麦克风权限与 WebRTC 路径通过；先用假音频，不占正式TTS |
| C 受控真实短测 | 安全凭据与留存模式确认后，Mini纯文字到Breeze短句，验证SOUL更新、字幕、插话、挂断与费用 |
| D 端到端验收 | 用户能自然说话并听到固定爱莉声音，同时原聊天send_voice回归正常；再允许启用入口 |

审批只覆盖本文 MVP，不包含修改 SOUL、扩大工具、修改 dsh、改变主意识、训练音色或改共享推理参数。出现需要扩大边界的缺口时暂停该部分，提交修订，不用临时旁路冒充验收。

## 10 必须验证的项目

- 独立语音 Session id/cwd、Agent状态、运行/空闲、取消和持久记录相符；普通聊天的Session和factory未被替换。
- 最终有效 instructions 只等于现有管理器 render 的SOUL，工具为空，默认contexts不泄入；文件缺失失败，修改后下一轮生效。
- 只存在一个认知驱动，不再触发第二个普通文字Agent回答同一音频。
- 播放时仍可收音；首音不丢；连续插话、停止播放和挂断均不续播旧epoch。
- 原始生成完整保留，已播与未播区分；断线或部分播放不能被记成完整送达。
- 后端故障、限流、拒绝权限、页面关闭、SSE/sideband丢失能有界清理，不残留付费通话。
- 同时发一条原聊天语音，确认单条投递、原音色和完整WAV不受损；通话取消不影响其他合成请求。
- 实测说话结束到首段可听声音、段间停顿与停播时延；明确区分首字节、播放器输出及用户听感。门槛在短测中确认，不套用H100基准。

## 11 已审批的最简范围

用户已明确“新Session、复用管理、系统仅SOUL”，并已批准以下收窄范围：

1. 使用现有 Web 面板，桌面单人通话，暂不接其他平台。
2. 一个稳定专用语音 Session；每通新建云端连接，不自动加载旧通话上下文。
3. 首版没有业务工具，不加第二段系统提示词；Breeze沿用已有固定配置。
4. 单并发、每通最多10分钟、无自动重拨；真实短测使用用户明确授权的受控凭据，之后由用户替换。
5. 不保存原声或整通录音；只保留取得的文字和活动事件，原声不可回放。
6. 先通过离线原生Agent桥接与媒体门槛，再实测，不以空Session或聊天语音成功替代通话验收。

审批状态：**用户已确认实施**。后续确认不保存原声，暂用用户明确授权的既有 key 并由用户之后替换。受控凭据已配置；实现与验收仍在进行，尚未启用通话、开麦或发起真实云端测试。

## 12 核查依据

本地源码核查：`conscious-mind/src/standing-prompts.ts` 与 `src/load.ts`、原生 system-prompt 的 complete 规则、core/agent 的 register/enter 与当前 agent-loop factory、Web console 的 fetch/SSE 模式；没有读取 SOUL 正文。Breeze 状态与性能样例见 [迁移验收](../../docs/report/2026-11-12-breeze-official-service-migration.zh.md)。

- [O1 OpenAI WebRTC Realtime 部分](https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime)
- [O2 Realtime server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=realtime)
- [O3 Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)
- [O4 Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad)
- [目标模型 GPT-Realtime-2.1 Mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)

引用只用于公开 Realtime 协议，不混用 GPT-Live 的事件、代理后台或计费规则。账号权限、实际浏览器网络与本版适配器仍须真实短测验证，离线通过不等于通话已可用。
