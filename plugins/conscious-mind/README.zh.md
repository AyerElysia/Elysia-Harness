# @elysia/conscious-mind

[English](README.md) | 中文

爱莉希雅的主意识。一个 agent，一条长期 session。

插件不重做 Harness 已有的会话日志、压缩、提示词组装和工具循环。前缀、发送工具、入口队列和主意识回复轮是这个插件自己的。

## 前缀

前缀是系统提示词里那一段稳定身份。固定提示词都放在一个目录里。插件不扫描这个目录，只按配置里的文件名顺序读取、拼成一段。

目录和文件名都写在本插件的配置里，例如：

```yaml
baseDir: /home/ayerelysia/Elysia/Data/standing-prompts
files:
  - SOUL.md
  - USER.md
  - MEMORY.md
  - EXISTENCE.md
  - TOOLS.md
```

`baseDir` 可以是绝对路径。相对路径在插件挂载时按进程的当前目录解析。Harness 没有「提示词目录」这个配置；`personaPrefix` 只接受一段写死在配置里的字符串。目录路径由本插件自己的配置字段保存。

加载复用 `ctx.systemPrompt.section()`。注册一段 `complete: true`、`interpolate: false` 的段，`text` 是函数。agent loop 每个模型步骤都会 `assemble()`，函数在这一刻按 `files` 顺序把文件读出来，用空行接上。段的 `text` 回调是同步的，而 `complete` 段在异步 waterfall 之前就定稿，所以这里用同步读盘，不用 `ctx.fs.readText`。`interpolate: false` 让正文里的 `{{` 保持原样。`complete` 让这一段成为整份系统提示词，盖住 Harness 自带的 `harness:identity`。

`SOUL.md` 读不到或是空的，这一轮中止，不用上一轮的缓存继续说。名单里其他文件缺失或为空就跳过。文件名必须落在这个目录里。

爱莉的五份正文不放在这个包里，放在 `/home/ayerelysia/Elysia/Data/standing-prompts`：`SOUL.md`、`USER.md`、`MEMORY.md`、`EXISTENCE.md`、`TOOLS.md`。

文件变动也不另做监视。`ctx.fs.watch` 和技能目录用的 Chokidar 都没有接到系统提示词上；`system-prompt/change` 只在注册或卸下提示词段时发出，文件内容变了不会发。下一轮 `assemble()` 会重新读盘，agent loop 拿渲染后的整段字符串和当前 `system/message` 比较：一样就不写会话；不一样就由 `SystemPromptProjection` 更新。路由声明了 `systemPromptUpdate: 'in-history'` 且这次请求序列还在延续，新前缀追加到历史后面；否则原地替换开头那一条。会话闲着的时候改文件，要等到下一次模型步骤才会被读到。

现在在哪个聊天、直播怎么接话，不写进前缀。那是入口消息上的现场。说话习惯写在这些文件里，不写在插件代码里。

## send_text

> 状态：工具已实现。QQ、飞书、KOOK 的 `conversation` 格式由各自的渠道插件定义。段间停顿和主动外联仍待定。

`send_text` 是主意识把文字发到外部渠道的工具。渠道是 QQ、飞书、Kook，以及以后接上的同类入口。

模型直接写出的 assistant 正文只留在这条 session 里，不会出现在任何渠道上。要让对方看见，必须调用 `send_text`。说话因此是一次有意动作，不是泄漏。

本工具对标 Elysium 的 `life_send_text`。`thought`、`mood`、`decision`、`expected_response` 四个内在字段继续保留：它们是主体在同一次表达动作里亲自提交的内在记录——不是 provider reasoning 的回填，也不同于 session 日志被动留存的 assistant 正文。这份显式记录供人格连续性与后训练使用，DSH 的账本是补充，不替代它。

与 Elysium 的一处语义差异：`content` 按换行拆分成多条消息发送。Elysium 里 `\n` 只负责同一条消息内的排版；这里 `\n` 就是分段。

## pending

入口消息不按渠道各自回复。渠道适配器应调用主意识的 `inboundPending.receive()`，让消息进入同一个 pending；目前 KOOK 已接入，QQ、飞书仍待接。每条新消息都会重置收集等待，队列连续静默 1.2 秒后，把**当时 pending 里的全部事件一次取走**，保留到达顺序，交给同一个回复轮；不同渠道、不同会话可以处在同一批。回复过程中新到的消息继续留在 pending，这一轮结束后再进入下一次静默收集等待。成功轮次不会因为某个会话没有收到回复而自动补答；轮次异常则将整批放回内存队首。

## 主意识回复轮

Harness 提供 `agents` 服务时，插件自动把 pending 接到主意识。主意识只有一个 agent、一条固定 id 为 `elysia-conscious-mind` 的长期 session：先复用已有 agent，再尝试 resume。resume 失败后若没有并发恢复出的 agent，当前代码仍会尝试按同一 id create，尚未区分 session 不存在与其他恢复失败。每批事件写成一个 user message，通过 `followup()` 交给 Harness 原生 agent loop，并等待 `whenIdle()`。模型、会话历史、压缩和工具调用都由 Harness 管理，不再走独立的 chat-completions fetch。

这条 session 暴露 `send_text`、DSH 原生的 `read_image` 和本作用域注册的 `pass`；代码、文件写入与编辑、搜索等其他全局工具都被屏蔽。`read_image` 只用于主动读取已有本地图片，聊天图片走独立的附件入站链路。`pass` 必填 `reason`，只记录这一轮为什么不说话，不触碰任何渠道。她可以回复一个或多个会话，也可以不说话，运行时不强迫二选一中的任何一个。已取走的事件留在长期 session 历史中。旧的 `createSendTextTurn` 仍保留给独立实验，但不是 ElyHarn 服务安装的主意识回复轮。

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

## 终端入口

在 `deepseek-harness` 目录下，用 Node 22：

```sh
pnpm exec tsx --tsconfig tsconfig.base.json packages/elysia/conscious-mind/src/tui.ts
```

这台机器上的 Node 22 和 pnpm 在 `/home/ayerelysia/.local/share/node-v22/bin`。`/quit` 退出。

每一轮都重新组装前缀，再发给模型。模型默认走 Elysium `config/models.toml` 里的 `providers.NexusAI`，模型名 `gemini-3.8-flash`。可以用 `ELYSIA_BASE_URL`、`ELYSIA_API_KEY`、`ELYSIA_MODEL`，或 `--base-url`、`--model` 换掉。`--once "一句话"` 只问一轮。

这一入口把模型正文打在终端上，还没有发到 QQ、飞书、Kook。
