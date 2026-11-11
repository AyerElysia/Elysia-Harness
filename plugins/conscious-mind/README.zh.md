# @elysia/conscious-mind

[English](README.md) | 中文

爱莉希雅的主意识。一个 agent，一条长期 session。

插件不重做 Harness 已有的会话日志、压缩、提示词组装和工具循环。前缀、发送工具、入口队列和主意识回复轮是这个插件自己的。

## 前缀

固定提示词按 agent/session 装配，不再覆盖整个部署。`src/standing-prompts.ts` 导出 Cordis 子插件 `@elysia/conscious-mind/standing-prompts`，只能挂在 agent scope；全局挂载会失败。主意识运行层继续提供 pending 和发送服务，但不再注册全局 complete 前缀，因此普通 session 不会因为部署了主意识运行层就读到这份主意识前缀。

子插件配置如下：

| 字段 | 含义 |
|---|---|
| `baseDir` | 非空提示词目录。绝对路径直接使用；相对路径在挂载时按进程 cwd 解析。 |
| `files` | 非空、有序且不重复的文件名列表。只读取名单，不扫描目录或自动挑文件。 |
| `required` | 必须存在且非空的文件，默认 `['SOUL.md']`；每个必需文件都必须在 `files` 中。 |
| `complete` | 默认 `true`，拼接结果作为当前作用域的整份系统提示词；`false` 则注册普通提示词段，与其他段共同组装。 |

挂在 agent scope 中的子插件配置示例：

```yaml
baseDir: /home/ayerelysia/Elysia/Data/standing-prompts
files:
  - SOUL.md
  - USER.md
  - MEMORY.md
  - EXISTENCE.md
  - TOOLS.md
required:
  - SOUL.md
complete: true
```

主意识运行层仍接收 `baseDir`、`files` 和 `required`，在 `composeMainAgent` 中将它们以 `complete: true` 传给子插件。create 和 resume 使用同一个 setup 回调。既有主 session 的 id `elysia-conscious-mind` 与 cwd `/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/conscious-mind` 保持不变；这份实现不改写旧 session header，也不修改主体提示词正文。

主运行层为回复处理器保存所选配置的快照。文件名单属于该 agent 的固定装配，不在每轮重新挑选。每次 `systemPrompt.assemble()` 都按名单顺序重新读正文，去掉首尾空白后用空行拼接。必需文件缺失或为空时组装失败；可选文件缺失或为空则跳过，其他读盘错误继续抛出。文件名不能越出目录。没有文件监视器，也不回退到旧前缀缓存。

加载继续复用 `ctx.systemPrompt.section()`，使用 `interpolate: false` 和同步 `text` 回调，正文中的 `{{` 保持原样。complete 模式只让当前作用域的这段文本成为整份提示词，覆盖该 agent 的 Harness 身份段，不覆盖其他 session。后续模型步骤中的提示词变化由 DSH 既有投影处理；会话闲着时修改文件本身不会触发一轮。

Web profile 目前实际添加了一个 `elysia` preset，挂载同一子插件并选择上面五份文件。`elysia-core` 仍只有需求，尚无对应 preset 配置。preset 创建的 session 与平台主 session 分开；真实重启后是否保留 preset 装配仍需验证。主运行层只接受作用域装配凭据完整且配置匹配的 live agent，不会自动热迁移旧的未装配实例。独立终端入口也在自己的 scope 中挂载这个子插件。

主体文件正文保存在本包之外，插件只读取名单，不创作或迁移正文。当前渠道和会话现场仍来自入站事件，不写进稳定前缀。

## 文件能力

`@elysia/conscious-mind/file-capabilities` 只在目标 agent scope 内挂载 DSH 原生文件与搜索子插件，不在 host plane 启用文本文件或搜索工具；普通 standard、minimal 会话的原工具目录与原生文件权限不变。主 session 与固定提示词名单一同装配，Web preset 也可独立挂载同一个插件。`workspaceDir` 是允许递归读写的工作区；`baseDir` 只开放 `files` 精确列出的文件，`read_image` 仅开放工作区图片。`.migration`、备份路径、名单外提示词、符号链接逃逸和可检测硬链接均被拒绝。原始 session cwd header 不变，working-directory 服务将本 agent 的实际目录设为工作区；搜索省略 path 时按实际目录检查。

修改提示词前必须在 `backupDir` 保存逐字节备份，备份失败就拒绝修改。必需提示词不能变空；`maxPromptBytes` 默认 65,536 个 UTF-8 字节，包含 DSH 最终保留的换行。编辑中的美元符号序列按字面处理。DSH 的已读观察、陈旧版本、唯一匹配与原子写入规则继续生效，因此后续原生检查拒绝操作时可能保留一份修改前备份。提示词修改成功后，按 `backupRetention`（默认 20）保留每个文件的备份；备份属于运维材料，模型不能经这些工具读取。

搜索同时检查完整 canonical result 与显示用 metadata，不能借显示截断隐藏越界路径或硬链接；任一返回路径不合规时阻止整份结果。卸载文件能力 fiber 会移除其原生工具与守卫；子插件挂载失败或主意识后续装配失败也会回收已取得的插件。这里是原生文件工具外的路径策略，并非 shell 或内核隔离；外部进程并发改动仍需遵守文件所有权。工程 agent 和迁移程序不通过这项能力代写主体提示词正文。

## send_text

> 状态：工具已实现。QQ、飞书、KOOK 的 `conversation` 格式由各自的渠道插件定义。段间停顿和主动外联仍待定。

`send_text` 是主意识把文字发到外部渠道的工具。渠道是 QQ、飞书、Kook，以及以后接上的同类入口。

模型直接写出的 assistant 正文只留在这条 session 里，不会出现在任何渠道上。要让对方看见，必须调用 `send_text`。说话因此是一次有意动作，不是泄漏。

本工具对标 Elysium 的 `life_send_text`。`thought`、`mood`、`decision`、`expected_response` 四个内在字段继续保留：它们是主体在同一次表达动作里亲自提交的内在记录——不是 provider reasoning 的回填，也不同于 session 日志被动留存的 assistant 正文。这份显式记录供人格连续性与后训练使用，DSH 的账本是补充，不替代它。

与 Elysium 的一处语义差异：`content` 按换行拆分成多条消息发送。Elysium 里 `\n` 只负责同一条消息内的排版；这里 `\n` 就是分段。

## pending

入口消息不按渠道各自回复。渠道适配器应调用主意识的 `inboundPending.receive()`，让消息进入同一个 pending；目前 KOOK 已接入，QQ、飞书仍待接。每条新消息都会重置收集等待，队列连续静默 1.2 秒后，把**当时 pending 里的全部事件一次取走**，保留到达顺序，交给同一个回复轮；不同渠道、不同会话可以处在同一批。回复过程中新到的消息继续留在 pending，这一轮结束后再进入下一次静默收集等待。成功轮次不会因为某个会话没有收到回复而自动补答；轮次异常则将整批放回内存队首。

## 主意识回复轮

Harness 提供 `agents` 服务时，插件自动把 pending 接到主意识。主意识只有一个 agent、一条固定 id 为 `elysia-conscious-mind` 的长期 session：已有 live agent 必须具备完整且配置匹配的提示词/工具装配凭据，才可复用；没有 live agent 时尝试 resume。resume 失败后若没有兼容的并发恢复实例，当前代码仍会尝试按同一 id create，尚未区分 session 不存在与其他恢复失败。不兼容的 live 实例会明确失败，不执行 followup，入站批次留在 pending。每批事件写成一个 user message，通过 `followup()` 交给 Harness 原生 agent loop，并等待 `whenIdle()`。模型、会话历史、压缩和工具调用都由 Harness 管理，不再走独立的 chat-completions fetch。

create/resume 的 setup 路径通过 `composeMainAgent` 挂载作用域前缀，并暴露 `send_text`、`send_voice`、DSH 原生的 `read`、`read_image`、`write`、`edit`、`glob`、`grep` 和本作用域注册的 `pass`。setup 成功后，在以 agent context 为键的进程内 WeakMap 中记录固定配置签名和完成状态，不记录正文；相同配置重复 setup 复用同一 promise，不同配置拒绝替换，scope 卸载时清除凭据。既有或竞态恢复的 live agent 只有凭据完整且匹配时才能借用；旧未装配实例需经正常作用域恢复，不改写 header 或私有历史。代码执行及其他全局工具继续屏蔽；文件工具使用下述作用域权限。`read_image` 只用于主动读取工作区内获准的本地图片，聊天图片走独立的附件入站链路。`pass` 必填 `reason`，只记录这一轮为什么不说话，不触碰任何渠道。她可以回复一个或多个会话，也可以不说话，运行时不强迫二选一中的任何一个。已取走的事件留在长期 session 历史中。旧的 `createSendTextTurn` 仍保留给独立实验，但不是 ElyHarn 服务安装的主意识回复轮。

## 主意识上下文隔离

主意识在自己的 agent scope 内关闭 DSH 可选运行环境注入，并在 `agent/pre-step` 生产者完成后，按来源排除 `agent-instructions` 和 `runtime-context` 两类框架消息。普通用户消息即使提到 `AGENTS.md` 也会保留；其他 session 不受此过滤影响。装配时，已经可见的这两类旧框架消息通过追加空的 surface replacement 退出当前投影，原始事件和来源引用仍留在耐久日志中，重复装配不会重复替换空消息。其他来源（包括已有检查点）保持可见。

过滤器由当前 agent scope 持有；装配失败会立即撤销过滤器与运行环境抑制，scope 卸载也会清理。此隔离不改变原 session id/cwd，也不直接改写历史或主体文件。

### 主动压缩上下文

在 Web 的主意识会话输入框发送 `/compact`（不带参数），即可调用 DSH 原生的手动压缩命令。主意识作用域直接挂载 `@deepseek-ai/dsh-compaction-basic` 和 `@deepseek-ai/dsh-command-compact`，不是另写摘要逻辑，也不是给模型增加工具。后端配置为 `auto: false`，因此这里只提供人工入口，不新增自动压力压缩或上下文溢出重试行为。

命令要求 agent 处于 idle；正在回复时应等本轮结束后再执行。压缩使用当前会话的模型生成摘要，以 `compact-checkpoint` 替换本次选中的可见历史范围，原始事件仍保留在耐久日志中。没有可压缩历史时返回 `No compactable history yet.`，不会构造空摘要。主意识的 DSH 上下文过滤器只排除 `agent-instructions` 和 `runtime-context`，不会过滤压缩检查点。

## send_text 参数

| 参数 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `channel` | string | 是 | 渠道名：`qq`、`feishu`、`kook`，以及以后注册的同类名字。 |
| `conversation` | string | 是 | 哪一段对话。标识格式由渠道插件各自定义；入口消息自带这个现场，回复时照抄。 |
| `thought` | string | 是 | 本次主体自己选择提交的简洁内心活动。必须是非空自然语言，不从 provider reasoning 或 content 回填，也不当作可见正文；为空则整次调用失败。 |
| `mood` | string | 是（键） | 此刻的心情或情绪状态。没有明确情绪时传空字符串，禁止编造默认情绪。 |
| `decision` | string | 是（键） | 决定如何回应或行动。确实不适用时传空字符串，不要复制 content。 |
| `expected_response` | string | 是（键） | 预期对方看到回复后的反应。没有明确预期时传空字符串。 |
| `content` | string | 是 | 最后才写的、发给对方的纯文本正文。严禁写入 thought、reason 等元信息。 |
| `reply_to` | string | 否 | 引用回复的目标消息 ID，只跟随拆分后的第一段。私聊默认不用。 |

一次调用同时提交四个内在字段与正文，它们和最终回复落在同一模型轨迹中。

### Schema

用 `defineTool` 登记。参数根是一个对象，键的 `required: true` 编译进 JSON Schema 的 `required`。DSH 的字符串类型只有 `enum` 和 `const`，没有 `minLength`，所以「键必须出现」和「`thought` 必须有内容」是两件事。前者靠 Schema，后者在 `execute` 里检查：去掉空白后为空，就失败，一条都不发。`mood`、`decision`、`expected_response` 允许空字符串。

`channel` 不写成枚举。新渠道是挂载时登记的，不该为了加一个名字改 Schema。

```ts
defineTool({
  name: 'send_text',
  description: '把文字发到外部渠道。assistant 正文不会出现在任何渠道上。先写 thought、mood、decision、expected_response，最后写 content。content 里的换行会拆成多条消息。thought 必须是这次真实的非空思考。',
  parameters: {
    channel: {
      type: 'string',
      required: true,
      description: '渠道名，例如 qq、feishu、kook。必须是已经登记的渠道。',
    },
    conversation: {
      type: 'string',
      required: true,
      description: '这个渠道上的哪一段对话。入口消息里带着，回复时照抄。',
    },
    thought: {
      type: 'string',
      required: true,
      description: '这次表达自己写下的内心活动。必须非空。不要从 reasoning 或 content 回填，也不要写进发出去的正文。',
    },
    mood: {
      type: 'string',
      required: true,
      description: '此刻的心情。没有明确情绪时传空字符串，不要编造默认情绪。',
    },
    decision: {
      type: 'string',
      required: true,
      description: '决定如何回应。不适用时传空字符串，不要复制 content。',
    },
    expected_response: {
      type: 'string',
      required: true,
      description: '预期对方看到后的反应。没有明确预期时传空字符串。',
    },
    content: {
      type: 'string',
      required: true,
      description: '最后才写的、发给对方的纯文本。换行拆成多条消息。不要写入 thought、reason 等元信息。',
    },
    reply_to: {
      type: 'string',
      description: '要引用的消息 id。只挂在拆分后的第一段。私聊默认省略。',
    },
  },
})
```

模型收到的参数 Schema 是：

```json
{
  "type": "object",
  "properties": {
    "channel": { "type": "string", "description": "渠道名，例如 qq、feishu、kook。必须是已经登记的渠道。" },
    "conversation": { "type": "string", "description": "这个渠道上的哪一段对话。入口消息里带着，回复时照抄。" },
    "thought": { "type": "string", "description": "这次表达自己写下的内心活动。必须非空。不要从 reasoning 或 content 回填，也不要写进发出去的正文。" },
    "mood": { "type": "string", "description": "此刻的心情。没有明确情绪时传空字符串，不要编造默认情绪。" },
    "decision": { "type": "string", "description": "决定如何回应。不适用时传空字符串，不要复制 content。" },
    "expected_response": { "type": "string", "description": "预期对方看到后的反应。没有明确预期时传空字符串。" },
    "content": { "type": "string", "description": "最后才写的、发给对方的纯文本。换行拆成多条消息。不要写入 thought、reason 等元信息。" },
    "reply_to": { "type": "string", "description": "要引用的消息 id。只挂在拆分后的第一段。私聊默认省略。" }
  },
  "required": ["channel", "conversation", "thought", "mood", "decision", "expected_response", "content"]
}
```

成功时 `execute` 返回的值也有 Schema。`sent` 只含已经交给渠道的段，顺序与拆分后的顺序一致。整次失败且一条都没发出时，`sent` 为空数组。

```ts
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sent: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', required: true },
            text: { type: 'string', required: true },
            messageId: { type: 'string' },
          },
        },
      },
      stoppedAt: { type: 'integer' },
      error: { type: 'string' },
    },
  },
}
```

### 按 `\n` 拆分

一次调用的 `content` 按换行拆成多段，每段作为一条独立的平台消息依次发出：

- `\r\n`、`\r` 先归一为 `\n`，再按 `\n` 切段；
- 每段去掉首尾空白，空段不发送；
- 拆分后没有任何非空段，整次调用失败，一条都不发；
- 只含省略号等占位符的段不发送（沿用 Elysium 纪律）；
- 段与段之间插入短暂停顿，模拟连续打字（节奏参数待定）；
- `reply_to` 只在第一段生效。

### 路由

`send_text` 不实现 QQ、飞书、Kook 的连接和协议。每个渠道插件挂载时把自己的发送能力注册到统一入口（渠道名 → 发送能力），`send_text` 按 `channel` 查表，把正文和「发到哪」交给对应的渠道插件送出去。渠道名未注册时明确报错，不静默丢弃，不改投别的渠道。

### 失败语义

- 任一段发送失败即停止，后续段不再尝试；
- 已发出的段不自动重发，避免重复表达；
- 投递结果（成功、失败、状态未知，以及平台消息 ID）作为工具结果原样返回，由她自己决定要不要再说一次；
- 每次调用的完整参数与结果天然进入 session 日志，不需要另建账本。

### 待定

- 段间停顿的时长与归属：`send_text` 统一负责，还是渠道插件各自决定；
- 主动外联：给没有入口消息现场的会话发信，要不要先经过显式仲裁（Elysium 里是 `nucleus_proactive_query` 与 `nucleus_proactive_command` 两件套）；
- 渠道插件注册接口的形状（Cordis service 还是事件）。QQ、飞书、KOOK 的会话格式分别由 `qq-napcat`、`feishu-app`、`kook-bot` 定义。

## 第二阶段约定

### 看图片

聊天图片与 `read_image` 是两条不同链路。`read_image` 已独立开放给主意识，用于读取已有本地文件；聊天图片由渠道下载，文字和图片按平台顺序组成 DSH `PromptContentPart[]`，每条平台消息单独通过 `ctx.attachments.admitPromptContent()` 持久化，再进入全局 pending。KOOK 已接入这条链路，QQ 和飞书仍待接。图片入站本身不依赖 `read_image`，也不开放其他文件工具。

主意识回复轮把事件元信息放在文本块里，随后按原顺序放入文字和 `{ type: 'image', attachment }` 原生图片块。Session 只保存附件引用，图片投影和 Compact 交给 DSH；不把成功收到的图片降级成 `[图片]`，也不把 Base64 写进历史。下载或任一图片准入失败时，整条消息不入队并记录错误；回复轮重试复用同一附件引用。完整事件 Schema、顺序和验收要求见 `REQUIREMENTS.zh.md`。

### 发送语音

> 状态：工具已实现并开放给主意识。KOOK 上传一次音频后优先发送原生语音；平台明确拒绝该类型时，按旧版 Elysium 行为降级为音频文件消息，不重复上传。BreezeTTS 合成失败、平台发送失败和投递状态未知会分别返回。QQ、飞书的语音发送仍待接。

`send_voice` 只把 `text` 口语合成为爱莉的本地音色并发送，不接受 `path`。新需求约定已有图片、音频、视频和其他文件统一通过 `send_file(channel, conversation, path)` 发送，由共享层检查文件，再交给各渠道适配器转换和投递；不让多个工具重复承担已有文件发送。`send_file`、`OutboundFile` 和对应渠道注册尚未实现。

这是针对 BreezeTTS 的工具。原生声音事件和 `expression_instruction` 沿用 Elysium 的 `life_send_voice` 语义；参考音频、`ref_text`、可信基础 `instruction`、`cfg_scale`、`seed` 都由部署侧管理。工具不提供 `voice_style` 或 `text_language`，不能更换参考音色，也不使用 QQ 自带的角色语音。

主意识与直播复用 `breeze-tts.ts` 的 `requestBreeze`，向同一个部署服务提交一次请求。全局有界 FIFO 与唯一推理 worker 由独立 Breeze 服务持有；客户端不再各建推理队列或轮询重投 409。一次 caller/config/request 预算覆盖排队、执行和完整 PCM 读取；取消会关闭 HTTP 读取，断流、空 PCM、半个采样及超时都不产生可发送的 WAV。503/504 是可观察失败，不自动重投可能已受理的 POST。固定本地音色不变，无云端回退。

#### 参数 Schema

参数顺序固定为 `channel`、`conversation`、`text`、`expression_instruction`，仅前三项必填：

```ts
parameters: {
  channel: {
    type: 'string',
    required: true,
    description: '已登记且支持语音的渠道名。',
  },
  conversation: {
    type: 'string',
    required: true,
    description: '该渠道上的会话 ID，照抄入站事件。',
  },
  text: {
    type: 'string',
    required: true,
    description: '交给 BreezeTTS 合成的口语；可包含其原生声音事件标记。',
  },
  expression_instruction: {
    type: 'string',
    description: '可选的本次情绪、语气、速度、停顿等表达控制；会附加到可信 Breeze instruction 后，不能覆盖参考音色。',
  },
}
```

`text` 可直接包含 `[笑]`、`[叹气]`、`[咳嗽]`、`[清嗓子]`。单次合成后只尝试一次平台投递，不自动重新合成或重传；工具返回 `sent`、`synthesis-failed`、`send-failed` 或 `unknown`，并保留 `textCharacters`、`audioBytes`、`messageId`、`error` 等可用结果。

#### 用法怎样进入模型上下文

README 和需求文档本身不会进入模型上下文。`send-voice.ts` 通过 DSH `defineTool` 注册，DSH 在模型请求中下发工具的 `description` 与参数 Schema。这对应 Elysium 的 `action_description` 和 `Annotated` 参数说明，不另建提示词通道。

工具描述明确固定爱莉本地音色、`text` 中的 Breeze 原生声音事件、`expression_instruction` 只控制本次表达、已有音频改用 `send_file`、QQ 角色语音不是本地 TTS。底层采样与参考音频字段不写进模型说明。`TOOLS.md` 只写使用语音表达的稳定偏好，不复制参数 Schema。完整文案与测试要求见 `REQUIREMENTS.zh.md`。

## 终端入口

在当前仓库的 `dsh/` 目录下，用 Node 22：

```sh
pnpm exec tsx --tsconfig tsconfig.base.json ../plugins/conscious-mind/src/tui.ts
```

这台机器上的 Node 22 和 pnpm 在 `/home/ayerelysia/.local/share/node-v22/bin`。`/quit` 退出。

每一轮都重新组装前缀，再发给模型。模型默认走 Elysium `config/models.toml` 里的 `providers.NexusAI`，模型名 `gemini-3.8-flash`。可以用 `ELYSIA_BASE_URL`、`ELYSIA_API_KEY`、`ELYSIA_MODEL`，或 `--base-url`、`--model` 换掉。`--once "一句话"` 只问一轮。

这个独立入口在自己的 scope 中组装提示词，保留进程内历史并自行发起模型请求。它把模型正文打在终端上，不驱动平台主意识的耐久 session，也不发送到 QQ、飞书、Kook。
