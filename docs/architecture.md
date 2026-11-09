# Elysia-Harness 架构

> 状态：目标架构与现状盘点。最近一次核对：2026-11-01。
> 本文描述「一条主意识 session、四个渠道汇入」的目标形态，并逐层标注当前实现状态。
> 与代码冲突时以代码为准；发现冲突请直接改本文，不要让两种说法并存。源码已实现不等于完成真实模型、平台或重启验收。

## 1. 一句话

目标是让所有外部平台的消息汇入**同一条主意识 DSH session**，由同一个 agent 阅读、思考、决定回不回、回给谁、从哪个平台发出去。

跨平台的目标是**一个主体**有四个出入口。当前只有 KOOK 接入主意识 pending；QQ、飞书与 Ayla 仍待接入。这里的单 session 指主意识，潜意识的独立心跳 session 目前仅有需求。

## 2. 为什么要单 session

当前主意识选择让已接入的渠道共用一条 session，使不同会话的入站事件进入同一段滚动历史，便于在同一轮决定回复谁、是否回复以及从哪个渠道发出。

这一设计的目标是：

- 上下文共享：接入后的 QQ、飞书、KOOK 等消息进入同一条主意识历史；
- 提示词一致：主意识使用同一份按配置重读的身份前缀；
- 决策统一：她可以在同一轮里选择一个或多个可达会话，也可以沉默。

session 是运行边界，不是主体边界；潜意识拟建独立 session，并不因此成为另一个主体。共享历史也不能代替长期记忆系统。

代价是上下文增长更快。见第 7 节。

## 3. 目标链路

```text
入站
  QQ    → qq-napcat/index.ts   ─┐
  KOOK  → kook-bot/index.ts    ─┤
  飞书  → feishu-app/index.ts  ─┼→ ctx.inboundPending.receive(InboundEvent)
  Ayla  → ayla-app（待建）      ─┘        │
                                          ▼
                             InboundPending（全局单批）
                                          │
                                          ▼
                         MAIN_SESSION_ID（主意识唯一 session，固定 cwd）
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                   ⑤ soul 提示词    ⑥ 记忆检索      ⑦ 人物目录
                          └───────────────┼───────────────┘
                                          ▼
                                   模型思考
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
              ⑩ list_contacts       ⑧ send_text            ⑫ 建定时
                    │                     │                     │
                    └──────────┬──────────┘                     │
                               ▼                                ▼
                     ⑪ outboundText.sender()          ctx.schedule
                               │                                │
                               ▼                                ▼
                    QQ / 飞书 / KOOK / Ayla           到点 → followup
                                                                │
                                                                ▼
                                                     回到「模型思考」
```

## 4. 端口与边界

| 组件 | 位置 | 职责 | 不做什么 |
|---|---|---|---|
| `plugins/conscious-mind` | 本仓库 | 主 session、pending、发送工具与出站注册表；在主 agent scope 中装配固定提示词 | 不注册部署级 complete 前缀，不认识平台协议 |
| `conscious-mind/standing-prompts` | 本仓库子插件 | 按当前 agent 的配置读取有序文件并注册 scoped prompt section | 无 agent scope 时拒绝挂载，不写主体正文 |
| `plugins/qq-napcat` | 本仓库 | NapCat OneBot 连接、`qq` sender | 不持有 session |
| `plugins/kook-bot` | 本仓库 | KOOK Gateway、图文附件入站、文字与语音 sender | 不持有 session |
| `plugins/feishu-app` | 本仓库 | 飞书长连接、`feishu` sender | 不持有 session |
| Ayla 通道插件 | 待建 | Ayla 入站/出站 | 不持有 session |
| `plugins/subconscious` | 只有需求文档 | 拟建独立心跳 session，读取主意识新增事件 | 尚无运行实现 |
| 人物目录插件 | 待建 | 跨平台身份图谱 | 不替模型判断关系 |
| `dsh/packages/schedule` | dsh | 定时规则、持久化、唤醒 | 不认识外部平台 |
| `dsh/packages/compaction` | dsh | 上下文压缩 | — |

**硬规则**：渠道插件永远不调用 `ctx.agents.create()` 或 `ctx.sessionController.create()`。主意识 session 仅由 `conscious-mind/main-session.ts` 创建和恢复。潜意识的独立 session 仍是需求。

## 5. 逐层状态

| 层 | 组件 | 状态 | 说明 |
|---|---|---|---|
| 入站 | `qq-napcat/src/index.ts` | ❌ 未接 pending | 只 `ctx.emit('qq/message')`；旧架构只在遗留的 `bridge.ts` 里 |
| 入站 | `kook-bot/src/index.ts` | ✅ 已接 | 文字与图片按原顺序经附件准入后进入 `receive()`；图片失败则整条不入队 |
| 入站 | `feishu-app/src/index.ts` | ❌ 未接 pending | 只 emit |
| 入站 | Ayla | ❌ 不存在 | — |
| 队列 | `conscious-mind/pending.ts` | ✅ 内存队列 | 1.2 秒静默收集后跨渠道全取单批；轮次异常放回队首；尚无耐久队列 |
| 主 session | `conscious-mind/main-session.ts` | ✅ 已带 `meta.cwd` | 固定 id，优先复用或 resume，create 时写入稳定绝对路径；见 6.1 |
| 元信息 | `formatInboundBatch` | ✅ | 元信息文本 + 原生文字/图片块；更强结构化仍待做，见 6.2 |
| system prompt | `standing-prompts.ts` | ✅ 源码已改为 scoped | 主 agent create/resume setup 挂子插件，每次 assemble 重读；live 借用须完整且匹配的装配凭据 |
| Web preset | `homes/web/profiles/web/cordis.patch.yml` | ✅ 已配置 `elysia` | 独立 session 的五文件 scoped 装配；`elysia-core` 仍只有需求，重启恢复尚需验证 |
| 记忆 | — | ⏳ 待选 | DSH 无 memory 包，见第 8 节 |
| 人物目录 | — | 🔴 待自建 | 见 6.3 |
| `send_text` | `send-text.ts` | ✅ | 显式指定渠道和会话；内在字段不外发 |
| `send_voice` | `send-voice.ts`、`breeze-tts.ts` | ✅ | BreezeTTS 本地音色；当前只有 KOOK 注册语音 sender |
| `read_image` | DSH 原生工具 | ✅ 已开放 | 主动读取已有本地图片，不代替聊天附件入站 |
| `send_file` | 统一文件投递需求 | 🔴 未实现 | 已有图片/音频/视频/其他文件共用工具与 `OutboundFile`，尚无源码或渠道注册 |
| `pass` | `pass.ts` | ✅ | — |
| `list_contacts` | — | 🔴 待自建 | 依赖人物目录 |
| 出站路由 | `outbound.ts` | ✅ | 按渠道名精确匹配，缺失即失败 |
| 定时 | `dsh/packages/schedule` | ✅ | 六种规则 + 时区 + 错过合并 |
| 定时路由 | — | 🔴 待补 | 见 6.4 |
| UI 可见 | 主 session 元数据 | ✅ 已提供 cwd | 持久化列表依赖此字段；真实重启恢复仍需验收 |
| 潜意识 | `plugins/subconscious/REQUIREMENTS.zh.md` | 🔴 仅需求 | 尚无心跳插件、独立 session 或事件消费实现 |
| 压缩 | `dsh/packages/compaction` | ✅ | — |

## 6. 实现说明与未完项

### 6.1 主 session 的固定 `meta.cwd`（已实现）

`main-session.ts` 已定义固定 id `elysia-conscious-mind` 和稳定绝对路径：

```text
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/conscious-mind
```

创建时传入 `meta: { cwd: MAIN_SESSION_CWD }`。已有 live agent 仅在提示词/工具装配凭据完整且配置匹配时复用；不兼容时明确失败，不执行 followup，批次回到 pending。没有 live agent 才尝试 resume；resume 失败后若没有兼容的并发恢复实例，仍按同一 id 尝试 create，尚未区分 session 不存在与其他恢复失败。create/resume 的 setup 调用 `composeMainAgent`，挂载作用域提示词子插件并限制工具；挂载时预热 session。

`dsh/packages/api/session-controller/src/list.ts` 的持久化列表依赖 `record.header.cwd`：没有 cwd 的冷 session 不出现在该列表。当前源码已经提供此字段，不能继续标为待修。

这个绝对路径是现有 session 的稳定身份锚点，后续部署或迁移不能随意改动。旧 session 元数据修复、异常 resume 与真实重启恢复仍需单独验证，不因该字段已经实现就宣称恢复验收完成。

### 6.1.1 会话级固定提示词

`plugins/conscious-mind/src/index.ts` 不再注册部署级 complete prompt。新增子插件 `@elysia/conscious-mind/standing-prompts`，仅在 agent scope 中注册 `elysia:standing-prompts`；无 scope 时明确失败。普通 session 不再因挂载主意识运行层而继承主意识前缀。

子插件接收 `baseDir`、`files`、`required`、`complete`。`baseDir` 与 `files` 必须非空，`files` 有序且不重复，`required` 默认为 `['SOUL.md']` 且必须是文件名单的子集。`complete` 默认 true，作为当前 agent 的整份提示词；false 则与其他 section 一起组装。主意识运行层显式传 true。

主回复处理器保存所选配置的快照。文件名单属于该 agent 的固定装配，每次 assemble 重新读正文，不按轮次换名单、不扫描目录。必需文件缺失或为空会失败，可选缺失/空文件跳过，其他读取错误抛出。文件正文、旧主 session id/cwd 和已有 header 不由这项改动迁移或改写。

Web profile 当前只添加 `elysia` preset，配置五份文件并挂载同一 scoped 子插件；`elysia-core` 尚未配置。preset 创建的是独立 session，不自动加入平台 pending。独立 `tui.ts` 也在自己的 scope 中装配前缀，但仍是进程内历史与直接模型请求的实验入口。真实 preset 重启恢复仍需验证。主意识 setup 成功后，以 agent context 为键在进程内 WeakMap 记录固定配置签名和完成状态，不包含文件正文；scope 卸载时清除。相同配置重复 setup 复用 promise，不同配置拒绝替换。既有或竞态恢复的 live agent 须匹配完整凭据；旧未装配实例不会自动热迁移，需通过正常恢复 setup 装配，不改写 header 或私有历史。

### 6.2 入站元信息与图片

当前 `formatInboundBatch` 返回原生 `ContentBlock[]`，元信息放在正文前面的文本块中，例如：

```text
[1] 渠道 kook ｜ 会话 kook:channel:12345 ｜ 消息id 987
小明(123)：你好
```

文字与图片保持原顺序。KOOK 先下载图片，再经 `ctx.attachments.admitPromptContent()` 持久化，随后只把附件引用放进 pending；主意识轮次写入原生 `{ type: 'image', attachment }`，不把 Base64 写进历史，也不以 `[图片]` 代替成功准入的图片。下载或准入失败时整条消息不入队。

这条图文链路目前只接到 KOOK。QQ、飞书仍只发出各自 message 事件，尚未接统一 pending 或附件准入。聊天附件不依赖 `read_image`；该工具用于主体主动读取已有本地图片。

元信息目前是可读文本，尚未采用 XML 等更强字段边界。后续结构化必须保留 channel、conversation、sender 与 message_id 的精确值以及图文顺序。

### 6.3 人物目录（待自建）

**问题**：模型要「自己决定发给谁」，必须先知道「谁在哪些平台」。

DSH 没有联系人抽象。`packages/identity/` 只是遥测用的匿名安装 ID，与人物身份无关。

最小结构：

```ts
interface Person {
  id: string                         // 内部稳定 ID
  displayName: string
  channels: Record<string, string>   // { qq: '3263049205', feishu: 'ou_xxx', kook: '111' }
  lastActive: Record<string, number> // 每个渠道最后活跃时间
}
```

**身份归并的约束**：不能用「名字相同」推断同一个人，也不能用正则或关键词匹配。只有两种合法来源：

1. 显式登记（配置或人工确认）；
2. 模型自己判断，并记录判断依据。

参照 QQ 跨群认人的既有原则：**认号不认名**。跨平台时号完全不同，所以只能靠登记。

配套工具 `list_contacts()`：返回人物列表与各渠道可达性，让模型自己选择。不直接改 `send_text` 的签名——保持它只做 `channel`+`conversation` 的纯路由。

### 6.4 定时唤醒后的路由

`dsh/packages/schedule/schedule/src/runtime.ts` 的投递只有三步：

```ts
resolved.agent.followup(message)   // 往 session 塞消息
await this.ctx.sessions.flush(...) // 持久化
```

塞进去的消息 `source` 只有 `{ kind: 'schedule' }`，**没有 channel / conversation**。

所以「到点了」能触发对话，但「发给谁」需要额外信息。两条路：

| 方案 | 优点 | 缺点 |
|---|---|---|
| 任务文本里写明收件人 | 不改 DSH | 路由信息混进自然语言 |
| `conscious-mind` 唤醒时注入「最近活跃会话」 | 干净 | 需要在 followup 时挂钩 |

倾向后者：路由是工程事实，不该让模型从散文里猜。

### 6.5 其余待处理项

| 项 | 说明 |
|---|---|
| `qq-napcat/src/bridge.ts` | 旧架构遗留（独立 `new Context()` + 手写 fetch）。正式入口是 `index.ts`。应删除或明确标注 deprecated |
| 未回复消息与失败 | 成功轮次不会因某个会话未收到回复而自动补答；轮次异常则整批放回队首。这是进程内重试，重启前未入 session 的内存消息仍可能丢失；重复 followup 边界仍需验证 |
| 单批上限 | 群刷屏时一批可能上百条。需要定义上限与溢出策略 |
| 渠道可靠性 | `send_text` 已统一分段、停止与未知结果契约；各渠道传输的超时、重连与重试边界仍需按实现验收 |

## 7. 上下文增长

单 session 全渠道，上下文增速是单渠道的数倍。DSH 已有一整套：

- `compaction/compaction`、`compaction-basic`：基础压缩策略
- `compaction-tool-result-pruner`：工具结果修剪
- `compaction-image-offload`：图片外置
- `command-compact`：`/compact` 命令
- `token-meter`：`contextPressure` 投影

**不要自己实现压缩。** 但要注意：压缩产生摘要时必须保留原文可读路径（session log 不删除），否则等于篡改历史。

## 8. 记忆

本仓库尚未迁入 Elysium 的生命记忆、学习与检索闭环；主意识耐久 session 历史和提示词中的 `MEMORY.md` 读取不等于这些子系统已经实现。

DSH 的 `packages/` 里**没有任何 memory 包**。现状可用的只有：

- `packages/session-query`：`searchSessions` 可搜历史消息，带 `eventFilters`；
- `packages/mcp/mcp-client`：可接外部 MCP 服务（向量库等）。

未来选社区 memory 插件时，必须先回答一个问题：

> 这个插件是「自动摘要对话并入库」，还是「提供检索工具，由模型自己决定记什么」？

前者意味着外部程序代替主体决定什么值得记住。在主体性约束下这是不可接受的：记忆的取舍必须来自她自己的判断，或独立他者的评估，不能由关键词、相似度阈值或固定策略代劳。

**这条是选型的一票否决项。**

## 9. 工具面

`main-session.ts` 的 `composeMainAgent`：

```ts
await agentCtx.plugin(StandingPrompt, promptConfig)
await agentCtx.plugin(FileCapabilities, fileConfig) // scope 内挂载原生文件/搜索工具与守卫
agentCtx.tools.register(definePassTool())
agentCtx.tools.restrict({ allow: ['send_text', 'send_voice', 'read_image'] })
```

按 `composeMainAgent` 装配后的主 agent 暴露 `send_text`、`send_voice`、`read`、`read_image`、`write`、`edit`、`glob`、`grep` 和本作用域注册的 `pass`；只有装配凭据完整且配置匹配的 live agent 才可借用。文本文件与搜索工具只由文件能力子插件在目标 agent scope 注册，不在 host plane 全局开启；standard、minimal 的既有工具与权限不变。文件能力子插件只开放配置工作区（排除 `.migration`）与精确选中的提示词文件，`read_image` 仅可读取工作区图片。备份、名单外文件、符号链接逃逸与可检测硬链接被阻断；搜索检查完整 canonical result，不能只依赖截断后的显示 metadata。提示词修改前保存逐字节运维备份，检查必需文件非空与最终 UTF-8 字节上限；原生 DSH 继续负责已读观察、陈旧版本、字面编辑及原子写入。装配后期失败会回收提示词与文件守卫两个子插件，不遗留半套能力。代码执行仍未开放，聊天图片继续使用独立附件入站链路。原 session cwd header 保持不变，实际工作目录由 working-directory 服务设为工作区。

`send_voice` 经 BreezeTTS 合成固定本地音色，再交给渠道语音 sender。当前 KOOK 已实现上传与原生语音发送，平台明确拒绝该类型时才退为音频文件消息；状态未知不自动重发。QQ、飞书语音仍待接入。统一 `send_file(channel, conversation, path)`、共享文件检查与 `OutboundFile` 以及渠道投递仍只有需求，不能据此宣称已有文件发送可用。

新增 `list_contacts`、`schedule_*` 时必须同步改这一行 `allow` 列表。注意 `restrict` 是白名单语义——漏加就是工具不可见。

## 10. 注意事项

1. **preset 与 live agent 分别核对**。Web 只配置了 `elysia` preset；该配置不证明旧 session 已采用它，也不证明重启恢复后的插件装配。主意识 create/resume 显式传 setup，现存 live agent 只有配置匹配的完整装配凭据才能借用；旧未装配实例不自动迁移，不得通过删除或重建主 session 代替验证。
2. **cwd 不可变**。见 6.1。
3. **一个插件永不编辑 `dsh/`**（仓库根 `AGENTS.md`）。需要不同行为时在上面加 bundle row 或 patch 层。
4. **渠道插件不得持有 session**。见第 4 节。
5. **投递未知 ≠ 失败**。平台接受但无法确认送达时，应作为独立状态记录，不能算成功也不能自动重发。
6. **不跨平台合并身份**，除非有显式登记或模型判断记录。

## 11. 参考

- 仓库根 `AGENTS.md`：工程规则
- `dsh/AGENTS.md`：DSH 上游规则
- `plugins/conscious-mind/REQUIREMENTS.zh.md`：主意识需求
- `plugins/subconscious/REQUIREMENTS.zh.md`：潜意识（心跳）需求
- `dsh/packages/schedule/schedule/src/runtime.ts`：定时投递实现
- `dsh/packages/api/session-controller/src/list.ts`：session 可见性规则
