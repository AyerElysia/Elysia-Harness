# 主意识需求

一个 agent，一条长期 session。QQ、飞书、KOOK 只负责进出。会话日志、压缩、提示词组装和工具循环用 Harness 现有的。固定提示词仍在外部目录，按已实现的前缀规则加载。

当前主意识工具有 `send_text`、`send_voice`、作用域 `pass`，以及 DSH 原生的 `read_image`、`read`、`write`、`edit`、`glob`、`grep`、`web_search`、`web_fetch`。文件与图片工具由爱莉插件统一限制在工作区和五份固定提示词白名单内；这条 session 不挂 shell、代码执行、浏览器操作或其他未明确开放的工具。网络工具已实机装配；`web_fetch` 已通过公开页面验证，`web_search` 已通过 ModSearch 后端的真实来源验收。官方 DeepSeek 搜索凭据无效、D1 渠道不提供所需原生搜索的历史排查，以及当前 ModSearch 配置和验收证据，均见第五阶段实施记录。

## 第一阶段

### send_text

把文字发到已经登记的渠道。assistant 正文只留在 session 里，不发出去。

参数顺序是先想、后说。必填依次为 `channel`、`conversation`、`thought`、`mood`、`decision`、`expected_response`、`content`，可选 `reply_to`。`content` 放在四个内在字段之后。

- `thought` 必须是非空的自然语言。空的 `thought` 什么都不发。
- `mood`、`decision`、`expected_response` 可以是空字符串，不替她编。
- `content` 按换行拆成多条平台消息。只剩空行或省略号时不发。
- 渠道名必须已经登记。没有这个渠道就失败，不改道。
- 第一段失败就停下，已发出的不自动重发。投递结果回到这次工具调用里。
- 私聊默认不带 `reply_to`。只有她这次要引用某一条时才填。

### pass

这一轮选择不说话。不调用任何渠道发送。session 里留下她这次为什么不说，不产生外部消息。

运行时不能强迫她调用 `send_text`。她可以 `pass`，也可以对这一轮里的一个或多个会话各发一次 `send_text`。

### 三个渠道进同一条 session

QQ（NapCat）、飞书、KOOK 的文字都变成事件，写入同一条主意识 session。账号沿用 Elysium 现有配置，不另存一套。飞书和 KOOK 的长连接同一时间只能有一条，由这条链路占用。

一条事件至少带着：

- 渠道、会话窗口、发送人 id、显示名
- 正文
- 平台消息 id
- 是不是在点名她（群里的 @）
- 如果这句是在引用别人，被引用的人和原文

她自己发出去的回声、重复的消息 id，不成为新事件。显示名优先用 Elysium 里已经写好的身份对照，其次用平台昵称。

管理方式和 Elysium 一样，是一条全局的 pending，不是每个渠道各回各的：

- 新到的文字先进入 pending，不立刻各开一轮。
- 一轮开始时，把当时 pending 里的事件一次取走，写进这条 session，再让她看。
- 连着发出的几句算同一轮。具体等多久由实现定，目标是同一次开口前后的几句不要拆成多次回复。
- 这一轮还在进行时新到的消息留在 pending，下一轮再取。
- 取走的事件都留在 session 历史里。她只回复其中一个人时，另一个人不会被自动再答一次，但下一句仍然接在同一条 session 上。

QQ 窗口 id 仍是 `qq:private:<userId>` 和 `qq:group:<groupId>`。飞书、KOOK 用各自渠道插件已定的 id。回复时照抄事件上的 `channel` 和 `conversation`。

## 第二阶段

凡计划新增工具，计划里必须先写清 Schema，再进入实现。至少包括参数名称与顺序、类型、是否必填、能否为空、默认值、校验规则，以及工具结果的 Schema；不能只列工具名和参数名，把字段约束留到写代码时再补。

### 按 session 选择固定提示词

固定提示词目录继续作为唯一文件来源，但「这次加载哪些文件」必须属于 agent 的组合，不能继续是整个 web profile 共用的一份全局配置。复用 DSH 已有的 Agent Preset、session `agentPreset` 持久化和作用域提示词，不新增 `sessionId → files` 映射，也不另造选择协议。

#### 改造前的问题

改造前的选择入口是 `homes/web/profiles/web/cordis.patch.yml` 中 `elysia-conscious-mind.config` 的 `baseDir` 与 `files`。当时 `conscious-mind` 通过全局 `ctx.systemPrompt.section()` 注册 `complete: true` 的完整提示词，因此这些文件会影响该 profile 下的其他 session。当前实现已把这段注册移入主意识的 agent 作用域；主意识仍使用原来的 session ID、cwd 和文件组合。

#### 目标结构

1. 从 `conscious-mind` 抽出作用域限定的 standing-prompt 子插件，入口名为 `@elysia/conscious-mind/standing-prompts`，仍属于同一个插件包。它只负责读取选择的文件并注册当前 agent 的提示词，不持有 pending、渠道、BreezeTTS 或发送工具。
2. `conscious-mind` 的全局 `apply()` 不再注册这份完整提示词，避免其他 session 被爱莉人格污染。
3. 用 DSH `@deepseek-ai/dsh-agent-preset` 声明命名组合。session 选择 preset 后，由 DSH 将 `agentPreset` 持久化并在 resume 时恢复；空白 session 可以更换选择，对话开始后的组合保持固定。
4. 文件内容仍在每次提示词组装时重新读取，保留现有「先读、再改，下一轮生效」的主体文档语义；文件列表属于 session 组合，不在对话中途按轮动态切换。
5. 普通 `standard` session 不挂载爱莉 standing-prompt 子插件。以后可以增加 `elysia-core` 等只选择部分文件的 preset，但不为每个 session 复制一份提示词文件。

预设声明采用以下形态：

```yaml
- id: preset-elysia
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: elysia
    name: 爱莉
    plugins:
      - id: elysia-standing-prompts
        name: '@elysia/conscious-mind/standing-prompts'
        config:
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

#### 子插件配置 Schema

这里不新增模型工具，因此没有模型工具输入／输出 Schema；以下是 Cordis 子插件的完整配置契约。

```ts
interface StandingPromptPluginConfig {
  /** 固定提示词目录。绝对路径直接使用；相对路径在挂载时相对进程 cwd 解析。 */
  baseDir: string
  /** 按此顺序拼接的文件名；非空且不得重复。 */
  files: string[]
  /** 缺失或去除首尾空白后为空时使组装失败的文件名；必须是 files 的子集。默认 ['SOUL.md']。 */
  required?: string[]
  /** 是否把拼接结果作为该 agent 的唯一 system prompt。默认 true。 */
  complete?: boolean
}
```

- `baseDir` 必须非空。`files` 和 `required` 中每一项都只能是单个文件名，不得为 `.`、`..`，不得包含 `/`、`\\`、NUL 或空字符串。
- `files` 至少有一项并保持声明顺序；重复文件名、未知必填文件在挂载时直接失败。可选文件缺失或为空继续跳过，必填文件缺失或为空继续沿用现有 `StandingPromptError` 失败语义。
- 拼接时各文件去除首尾空白，再用一个空行连接；不摘要、不改写正文。`complete: true` 时继续注册现有的 `elysia:standing-prompts` 完整 section；`false` 时只作为普通 section 参与 DSH 其他提示词段落的组合。
- 子插件只能在 agent 作用域挂载。不得在全局 `apply()` 再注册同名 section，也不得从 session 历史正文、渠道事件或模型工具参数动态接收文件列表。
- 该配置不包含 `breezeConfigPath`、渠道、pending、工具白名单或 cwd；这些仍由各自已有模块负责。

#### 现有主意识兼容路径

`elysia-conscious-mind` 已经有对话历史，不能重写 session header、伪造 preset 选择或删除重建这条 session。主意识是固定身份的特殊 session，不作为普通 session 自由切换 preset：

- 在现有 `composeMainAgent()` 的 create／resume setup 中，显式挂载上述子插件，配置固定为当前 `elysia` 文件列表与 `complete: true`。
- create 与 resume 必须走同一组合；预热和 Web UI 借用仍不得绕开这个作用域。
- 全局完整提示词移除后，主意识下一次组装得到的正文在文件未变化时应与改造前逐字节一致。
- 其他新建 session 才通过 DSH preset 选择提示词组合；不要求给旧主意识补写 `agentPreset` 记录。

#### 实现验收

至少验证：主意识改造前后提示词逐字节一致；普通 session 不含爱莉固定提示词；不同文件组合只加载各自声明的文件；session 重启后 preset 选择保持一致；修改文件内容下一轮生效但文件列表不随正文或渠道事件改变；非法文件名、重复列表和未知必填文件在挂载时失败；现有 pending、发送工具与读图白名单行为不变。

### 看图片

图片是同一条 session 里的事件，和文字一起进入 pending。她在这一轮里能看见这张图，并且知道它来自哪个窗口、哪个人。表情包先按图片收。纯文字阶段里收到的图片不要假装看见。KOOK 已按本节实现文字与图片事件，QQ、飞书仍待接入同一结构。

这里不新增模型工具。`read_image` 已独立开放给主意识，解决的是「读取一个已有本地图片文件」；聊天图片走「渠道下载 → DSH 附件准入 → pending → 原生图片内容块」，两者不混用。图片入站本身不依赖 `read_image`，除这个已明确开放的读图工具外，不因此扩大其他文件工具权限。

#### 数据流

1. 渠道插件收到平台消息后，下载其中的图片字节，把文字和图片按平台原顺序整理成 DSH `PromptContentPart[]`。渠道仍然不持有 Session。
2. 同一渠道按事件到达顺序等待下载和附件准入完成，再调用 `inboundPending.receive()`；后一条纯文字不能越过前一条仍在下载或准入的图片消息。不同渠道仍进入同一个全局 pending。
3. 每条平台消息单独调用一次 `ctx.attachments.admitPromptContent()`。不得把不同平台消息或整个 pending 批次合成一次准入，否则 DSH 的单消息图片数量和总字节上限会被错误地跨事件合并。
4. DSH 校验整条消息的全部图片并持久保存，返回顺序不变的 `AdmittedPromptContentPart[]`。只有准入成功后，事件才进入 pending 并重置 1.2 秒静默计时。
5. 一批事件仍合成一个 user message。每个事件先写渠道、会话、消息 ID、发送人等文本元信息，随后按原顺序放入文本块和 `{ type: 'image', attachment }` 图片块。成功准入的图片不写成 `[图片]`，不附加工具使用说明。
6. `createUserMessage()`、Session 日志、模型请求图片投影和 Compact 全部复用 DSH。主意识插件不另存图片字节，不另写 Base64 历史，也不自行缩小图片。

主意识的实际模型路由必须声明支持 `image` 输入。实现验收时要用真实附件走完一次模型请求；模型不支持时必须明确报错，不能假装看见或降级成图片占位文字。

#### 渠道准入前的内部事件 Schema

这里的 Schema 是插件内部输入，不是模型工具参数。文字和图片直接复用 DSH `PromptContentPart`，不另造一套图片上传结构。

```ts
import type { PromptContentPart } from '@deepseek-ai/dsh-attachment'

interface InboundEventInput {
  channel: string
  conversation: string
  messageId: string
  senderId: string
  senderName: string
  content: readonly PromptContentPart[]
}
```

`content` 的每个成员严格为以下二选一：

```ts
type InboundInputContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      data: string
      name?: string
    }
```

- `channel`、`conversation` 必须非空；`messageId`、`senderId`、`senderName` 沿用现有事件语义，平台没有提供时可以为空字符串。
- `content` 至少有一个成员。空文本成员直接省略；图片消息可以没有文本，纯文本消息保持现有行为。
- `data` 是图片字节的规范 Base64，不能是 URL、文件路径或 Data URL。`name` 只是可选显示文件名，不承载本地路径。
- `mediaType` 由渠道声明，DSH 会按实际字节完整解码复核；格式、数量、单图字节、单消息总字节、尺寸和像素限制都由 DSH 附件配置统一执行。图片入站的第一版不另做格式转换，不支持的格式明确记录失败。
- 去重键仍是 `channel + messageId`。同一渠道串行完成准入，避免重复下载造成的乱序；准入失败不能把这个 ID 标成已见。

#### 准入后的 pending 事件 Schema

准入成功后，用 `InboundEvent` 替代现在的 `InboundText`，不长期并行维护两套事件类型。原始 Base64 不进入这个结构。

```ts
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

type InboundContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }

interface InboundEvent {
  channel: string
  conversation: string
  messageId: string
  senderId: string
  senderName: string
  content: readonly InboundContentPart[]
}
```

`ImageAttachmentRef` 完整复用 DSH：`attachmentId`、`mediaType`、`bytes`、`width`、`height` 必填，`name`、`originalDimensions` 可选。`attachmentId` 是持久附件 ID，不是平台 URL 或文件路径。pending、回复轮重试和写入 Session 的过程中，都必须使用这同一份附件引用。

#### 失败与持久化

- 任一图片下载或准入失败，整条平台消息都不进入 pending，包括同一消息里的文字，避免她只看到残缺语义；记录 `channel`、`conversation`、`messageId` 和具体错误，不发送 `[图片]` 占位，也不自动替她回复。
- 失败的消息 ID 不进入已见集合，平台以后重投同一事件时可以重试。本阶段不另造无限自动重试循环。
- 附件必须在事件进入 pending、Session 追加任何对应消息之前持久化。Session 只保存文本和附件引用，原始 Base64 只存在于短暂的渠道准入过程中。
- 回复轮失败后的批次重试沿用已经准入的事件和附件引用，不重新下载、不重新保存，也不重复生成附件 ID。
- 多条消息合批时仍保持 pending 到达顺序；一条消息内部则保持平台原始文字／图片顺序。

#### 实现验收

至少覆盖：纯文本行为不变、纯图片消息、文字与多图混排、两个平台消息分别计算图片上限、图片事件重置静默计时、重复消息 ID 不重复入队、任一图片失败时整条消息不入队且 ID 可重试、回复轮重试复用附件引用、Session 不含原始 Base64，以及真实模型请求确实收到原生图片块。另需确认主意识白名单包含明确开放的 `read_image`，但代码、文件写入与编辑、搜索等其他工具仍被屏蔽。

### 统一媒体与文件边界

模型工具、主意识内部投递结构和渠道适配器必须分开。不得因为 QQ、KOOK、飞书的协议不同，分别增加 `send_qq_image`、`send_kook_file` 一类工具，也不得让模型接触平台消息类型、素材上传 URL 或渠道专用字段。

#### 三层职责

1. **模型工具层**：全渠道共用。文字用 `send_text`，已有图片、音频、视频和其他文件统一用 `send_file`；只有「先把口语合成为爱莉音色再发送」使用 `send_voice`。读取已有本地图片仍用 DSH 原生 `read_image`。不新增 `send_image` 或各渠道专用发送工具。
2. **主意识共享层**：负责路径解析、普通文件检查、大小限制、文件名和真实媒体类型识别，并把文件装入统一的 `OutboundFileDelivery`。`OutboundFile` 按 `channel` 查找发送器，与 `OutboundText`、`OutboundVoice` 使用同一种注册方式。文件读取和类型识别只实现一次，不复制到渠道插件。
3. **渠道适配层**：只负责协议转换和投递，包括平台要求的转码、素材上传、消息类型、限流以及平台回执。适配器不决定主意识能调用什么工具，不读取模型给出的任意本地路径，也不各自定义一套文件 Schema。

入站继续复用「渠道下载 → DSH `PromptContentPart[]` → `ctx.attachments.admitPromptContent()` → pending → Session 附件引用」。当前已实现的是图片链路；其他文件的入站展示和持久化以后也先核对并复用 DSH 能力，不另建一套渠道私有历史。

#### 主意识内部文件投递 Schema

以下是插件内部接口，不是模型工具参数。模型仍然只提供下节 `send_file` 的三个参数。

```ts
interface OutboundFileDelivery {
  conversation: string
  filename: string
  mediaType: string
  data: Uint8Array
  signal?: AbortSignal
}

interface OutboundFile {
  sender(channel: string): OutboundFileSender | undefined
}

type OutboundFileSender = (
  delivery: OutboundFileDelivery,
) => Promise<OutboundReceipt>
```

- `conversation` 由 `channel` 对应的适配器解释，格式与入站事件一致。
- `filename` 是清理过的单个文件名，不含目录、通配符或控制字符；它来自共享层解析后的本地文件，而不是平台临时 URL。
- `mediaType` 是共享层根据真实文件字节复核后的 MIME 类型；无法可靠识别时使用 `application/octet-stream`，不能只相信扩展名或让模型声明。
- `data` 是同一次发送使用的完整文件字节，非空且不超过统一上限；第一版上限沿用 `send_file` 的 100 MiB，渠道更严格时取更小值。后续若需要流式发送，只能在这个内部边界上演进，不能改变模型工具。
- 内部结构不包含 `path`、平台消息类型、上传地址、Bot Token 或渠道专用参数。`OutboundReceipt` 继续复用现有 `messageId`；投递超时或网络中断继续用 `OutboundDeliveryUnknown` 表达状态未知。

#### 渠道规则与失败语义

- KOOK 的 ffmpeg 转码、`/asset/create` 上传、原生媒体消息与文件降级，QQ 的 NapCat 消息段、飞书的素材上传，都只能留在各自适配器内。
- 同一平台在一次投递内部，如果明确拒绝某种原生媒体类型且没有创建消息，可以复用已上传的同一资产降级为文件消息；不得重新读取、重新上传或换一份内容。网络结果未知时不能降级重试。
- 任一渠道挂载时注册 `OutboundFile` 发送器，卸载时注销。未登记或明确不支持该文件类型时返回失败，不改投其他渠道。
- 工具失败不自动重传。是否再次发送由主意识根据本次 `sent／failed／unknown` 结果决定。

#### 实现验收

至少验证：同一个 `send_file` 定义可路由到不同渠道；共享层只读取和检查一次文件；适配器收不到本地路径；真实字节与扩展名不一致时不会按错误类型发送；空文件和超限文件在上传前失败；渠道明确拒绝后的降级不重复上传；投递未知不重传；插件卸载后发送器注销。另用一种图片和一种音频文件验证「已有文件走 `send_file`，需要现场合成爱莉声音才走 `send_voice`」的边界。

### 发送文件

她可以把一个已有文件发到某个会话。共享层把路径转成上节的统一 `OutboundFileDelivery`，再由对应渠道适配器上传和发送。结果回到工具调用里，失败不自动重传。

工具名为 `send_file`。参数顺序是 `channel`、`conversation`、`path`；不附加 `send_text` 的四个内在字段。

输入 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "channel": {
      "type": "string",
      "description": "已登记的渠道名，例如 qq、feishu、kook。"
    },
    "conversation": {
      "type": "string",
      "description": "该渠道上的会话 ID，照抄入站事件。"
    },
    "path": {
      "type": "string",
      "description": "一个已有本地文件的绝对路径，或以 ~ 开头的用户目录路径。"
    }
  },
  "required": ["channel", "conversation", "path"]
}
```

三个参数都必须非空。`path` 不能包含通配符，解析后必须是单个可读普通文件，不能是目录；空文件不发送，文件上限沿用 Elysium 的 100 MiB，渠道限制更严格时取更小值。路径解析、文件类型和大小检查在执行时完成，不假装 JSON Schema 能表达这些文件系统约束。

输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "enum": ["sent", "failed", "unknown"],
      "description": "sent 为渠道确认接受，failed 为明确失败，unknown 为投递状态无法确认。"
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string" },
        "bytes": { "type": "integer" }
      },
      "required": ["name", "bytes"]
    },
    "messageId": {
      "type": "string",
      "description": "平台返回的消息 ID；平台没有返回时省略。"
    },
    "error": {
      "type": "string",
      "description": "失败或状态未知时的具体原因；成功时省略。"
    }
  },
  "required": ["status"]
}
```

路径或校验失败时只有 `status` 和 `error`。开始上传后，`file` 必须保留；已发送或状态未知的文件都不自动重传。

### 发送语音

对标 Elysium 的 `life_send_voice`。用已经部署的爱莉本地音色，不用 QQ 自带的角色语音。

`send_voice` 只负责把一段口语合成并发送，不接受 `path`。已有音频文件统一通过 `send_file` 发送，不保留两个重复入口。

- 口语里的 `[笑]`、`[叹气]`、`[咳嗽]`、`[清嗓子]` 按 Breeze 原生声音事件处理，不念出这几个字。
- 可选 `expression_instruction` 只控制本次表达，不能换音色。

这是针对 BreezeTTS 的工具，不是通用 TTS 包装。Breeze 请求里的 `instruction`、`cfg_scale`、`ref_text`、`seed`、`ref_audio` 都由可信部署配置和合成服务管理；模型只能通过 `expression_instruction` 追加本次表达控制。语言由 Breeze 根据文本与可信指令推断，不提供 `text_language`。也不提供 `voice_style`，避免把风格键变成另一个音色选择入口。

参数顺序是 `channel`、`conversation`、`text`、`expression_instruction`。

输入 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "channel": {
      "type": "string",
      "description": "已登记且支持语音的渠道名。"
    },
    "conversation": {
      "type": "string",
      "description": "该渠道上的会话 ID，照抄入站事件。"
    },
    "text": {
      "type": "string",
      "description": "交给 BreezeTTS 合成的口语；可包含其原生声音事件标记。"
    },
    "expression_instruction": {
      "type": "string",
      "description": "可选的本次情绪、语气、速度、停顿等表达控制；会附加到可信 Breeze instruction 后，不能覆盖参考音色。"
    }
  },
  "required": ["channel", "conversation", "text"]
}
```

`channel`、`conversation`、`text` 去掉首尾空白后必须非空。`expression_instruction` 省略时不传空字符串，也不替她补情绪说明；填写时去除首尾空白，最长 1000 字符。`text` 的长度上限由现有 TTS 部署配置统一执行。工具没有 `path`、`voice_style`、`text_language`、参考音频、`ref_text`、`cfg_scale` 或 `seed` 参数。

输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "enum": ["sent", "synthesis-failed", "send-failed", "unknown"],
      "description": "区分合成失败、平台明确发送失败、平台确认接受和投递状态未知。"
    },
    "textCharacters": {
      "type": "integer",
      "description": "实际交给 TTS 的口语字符数。"
    },
    "audioBytes": {
      "type": "integer",
      "description": "合成成功后的音频字节数；合成失败时省略。"
    },
    "messageId": {
      "type": "string",
      "description": "平台返回的语音消息 ID；平台没有返回时省略。"
    },
    "error": {
      "type": "string",
      "description": "合成、发送失败或状态未知时的具体原因；成功时省略。"
    }
  },
  "required": ["status"]
}
```

只有进入合成阶段后才返回 `textCharacters`。合成成功后必须保留 `audioBytes`；平台发送失败不丢弃这个区分信息，也不自动重新合成或重传。

#### 模型如何知道 BreezeTTS 怎么用

`REQUIREMENTS.zh.md` 和 `README.zh.md` 都是工程文档，不会自动进入模型上下文。模型能看到的用法必须由工具注册本身提供，不能假设她读过这些文档或 Elysium 源码。

实现时在 `conscious-mind` 新建 `send-voice.ts`，用 DSH 已有的 `defineTool` 注册 `send_voice`。DSH 工具循环会把工具的 `description` 和由 `parameters` 编译出的 JSON Schema 一并放进模型请求；这与 Elysium 把 `LifeSendVoiceAction.action_description` 和 `Annotated` 参数说明变成动作定义是同一条思路，不需要另造说明机制。

模型可见的 `description` 固定写为：

> 把口语通过 BreezeTTS 合成为爱莉固定的本地音色，并发送到指定外部会话。对方说“发个语音”“想听你的声音”或明确要求 send_voice 时，直接调用本工具，不要先用 send_text 解释。text 可以直接包含 [笑]、[叹气]、[咳嗽]、[清嗓子]，这些会作为真实声音事件演绎，不会逐字念出。可选 expression_instruction 只调整本次情绪、语气、速度和停顿，不能改变音色。已有音频不要调用本工具，改用 send_file。QQ 平台角色语音不能代替爱莉的本地音色。

`text` 和 `expression_instruction` 的 `description` 使用上面输入 Schema 中的文案。`cfg_scale`、`seed`、`ref_text`、`ref_audio` 不进入模型说明，因为模型不能控制它们；模型只需要理解「固定爱莉音色＋口语＋本次表达控制」。

`TOOLS.md` 只补充「什么情境适合用语音表达」这类稳定偏好，不复制参数表，避免工具定义与前缀漂移。实现时把 `send_file`、`send_voice` 加入主意识工具白名单，并用测试直接检查注册后的工具：描述包含 Breeze 原生声音事件与 `send_file` 边界，必填键恰好为 `channel`、`conversation`、`text`，且不存在 `path`、`voice_style`、`text_language` 参数。

## 第三阶段（已实施）：工作区文件与固定提示词自修改

状态：**源码已实施**。既有版本在 2026-11-09 留有受控实机装配记录；本次审查又修复权限、搜索、编辑与卸载边界，并通过新的隔离回归。最新修复未重新安装到运行副本，不能用旧版实机记录冒充最新版本验收。原长期 session 与真实主体正文不在本次提交中修改。

### 目标与边界

这一阶段先赋予主意识两组闭合能力：

1. 在爱莉自己的工作区内读、写、编辑和搜索文件，让她能维护笔记、日记与长期资料。
2. 修改当前主意识实际加载的固定提示词，让她能逐步完善自己的系统提示词。

优先复用 DSH 已有的 `read`、`write`、`edit`、`glob`、`grep` 和 `read_image`，不修改 vendored `dsh/`，不另造一套同名文件工具。路径权限与提示词护栏放在爱莉插件层的工具执行链中；具体复用哪个 DSH hook，在实现前核对源码后确定，不能先假设某个 hook 已满足要求。

主意识通过 `composeMainAgent()` 独立装配，因此实现一个共享的 agent-scope 文件能力模块，供真实主意识与 Web `preset-elysia` 复用，避免两处权限和提示词护栏漂移。普通 `standard` session 不获得这些扩展权限。

这一阶段不开放 shell、进程管理、任意代码执行、插件配置修改、其他 session 访问或外部网络操作；不新建、删除或改写主 session，不改变主 session ID 和历史。

### 路径与权限矩阵

以下路径均相对于 `/home/ayerelysia/Elysia`。`workspace/**` 指递归子路径，不包含上级目录本身以外的逃逸路径。

| 路径 | 读取 | 写入 | 说明 |
|---|---|---|---|
| `Data/workspace/**`，排除 `.migration/**` | 允许 | 允许 | 笔记、日记、想法、叙事等工作资料 |
| `Data/standing-prompts/` 中当前已配置的 `SOUL.md`、`USER.md`、`MEMORY.md`、`EXISTENCE.md`、`TOOLS.md` | 允许 | 允许，但受提示词护栏约束 | 只能修改已有清单中的文件 |
| `Data/standing-prompts/` 中上述五个文件以外的内容 | 拒绝 | 拒绝 | 不允许借文件工具新增第六个提示词或修改 preset 清单 |
| `Data/feishu-sdk/**` | 拒绝 | 拒绝 | 与工作区无关，可能含敏感配置 |
| `Data/workspace/.migration/**` | 拒绝 | 拒绝 | 迁移原始记录，仅供维护 |
| 提示词备份目录 | 拒绝 | 拒绝 | 备份由可信维护代码管理，模型不能读取、覆盖或删除 |
| ElyHarn 源码和配置、凭证、日志、其他 session、SSH 文件、系统目录及其余未列出路径 | 拒绝 | 拒绝 | 默认拒绝，不因路径位于 Data 下就自动放行 |

权限检查不能只依赖 DSH `fs-sandbox`：它默认限制写入，不限制读取。`read`、`write`、`edit`、`glob`、`grep` 和 `read_image` 都必须经过同一份解析后路径策略；特别地，`glob/grep` 经由 subprocess/ripgrep，不经过 `ctx.fs`，不能只检查 `write/edit`。

路径检查必须：

- 对输入路径和允许根做规范化与真实路径解析，拒绝符号链接及 `..` 等方式逃逸；可检测的多硬链接文件默认拒绝，避免把工作区内的硬链接当作越界读取或覆写通道。
- 对不存在的写入目标，解析最近的已存在祖先，再检查规范化目标是否仍处于允许范围，避免通过悬挂符号链接逃逸。
- 对五个提示词按规范化后的**单文件白名单**判断，不能简单放行整个目录。
- 主 cwd 的 `Data` 只是路径解析与沙箱根，不代表整个目录可读。`glob/grep` 省略 `path` 时，由爱莉执行链把受控搜索 cwd 固定为 `Data/workspace`，不能递归搜索整个 `Data`；显式传入 `path` 时也执行相同的读取权限检查。
- 搜索返回的候选路径若发生竞态或逃逸，按失败处理，不能将越界内容返回模型。
- 拒绝时返回明确但不泄露敏感内容的权限错误，不自动改写到其他路径。

**当前行为变化：**统一路径策略收紧现有 `read_image`，使它只能读取 `Data/workspace/**`（仍排除 `.migration/**`）中受支持的图片；五个提示词只能由文本工具读取，不能借 `read_image` 扩大范围。原先可读的其他本地路径不再对主意识开放。

### 主 session 工作目录方案与实施边界

改造前：主 session 创建时的原始 cwd 字符串是 `homes/web/conscious-mind`，部署前检查时该目录为空；`homes/web/standing-prompts` 已解析到 `Data/standing-prompts`。DSH 的写权限根来自 session 创建时的不可变 cwd，后续 `working_directory` 字段不能扩大权限。

采用的方案是在维护窗口内，保留原 cwd 字符串和 session 历史，将**确认为空**的 `homes/web/conscious-mind` 迁移为指向 `/home/ayerelysia/Elysia/Data` 的符号链接，使现有 session 不需要重建即可把工作根解析到 Data。

以下是该方案的实施前置条件；实际部署记录见本章末尾。执行前必须用隔离夹具验证 DSH 对权限根与目标路径的 realpath 规范化，确认写入最终落在预期的 `Data/workspace` 或五个提示词白名单内，同时 `Data` 下其他目录仍被爱莉路径策略拒绝。还要验证 session 恢复、相对路径和符号链接拒绝规则。验证失败就不做该迁移，另提方案；不使用 `danger-full-access` 绕过权限，也不通过改写 session header 扩大权限。

### 固定提示词写入护栏

固定提示词为 `SOUL.md`、`USER.md`、`MEMORY.md`、`EXISTENCE.md`、`TOOLS.md`。它们在每次提示词组装时重新读取，因此成功写入后从**下一次模型请求**开始生效，无需重启；但空闲时修改文件本身不会主动唤醒模型。

写入护栏要求：

1. 只能修改五个已配置的文件；不能通过文件工具新增提示词、修改 preset 清单、替换清单路径或借此访问其他文件。
2. 修改后的 `SOUL.md` 去除首尾空白后必须非空。其他可选提示词为空时维持现有“空文件跳过”的语义，不擅自改成必填。
3. 单文件大小上限可配置，当前默认 `65536` 字节；超限拒绝且原文件不变。
4. 每次成功修改前，由可信维护代码自动备份旧版本到部署侧配置的备份目录；当前为 `homes/web/standing-prompt-backups/`，模型不可读写。当前每份提示词保留数量默认 20，可配置；未实现按时间过期的备份清理。
5. 备份必须先可靠落盘，再提交目标文件更新；备份失败则整个修改失败，不留下“目标已改但没有备份”的状态。
6. 继续复用 DSH 原子写入、先读后写和版本陈旧拒绝。恢复 session 后必须重新读取再修改，不能拿旧上下文中的内容直接覆盖。
7. 提示词写入也走同一路径权限检查，不能因其受信任而绕过。护栏未通过隔离测试前，不向真实主意识开放写权限。
8. 提示词内容的真实写入只能由主体的已注册意识/见证实例通过授权工具产生；开发 agent 仅在合成夹具验证。真实验收不拿 `SOUL.md` 做实验，其非空保护与恢复测试在隔离夹具完成。

`TOOLS.md` 只记录稳定的使用偏好，例如“先搜索再读取”“修改提示词前备份由系统自动完成”“工作资料放入合适目录”，不复制参数表或权限实现细节；模型可见的准确 Schema 以工具注册定义为准。

### 工具挂载范围

真实主意识在现有 `send_text`、`send_voice`、`read_image` 与作用域 `pass` 之外，增加 `read`、`write`、`edit`、`glob`、`grep`；`read_image` 保留但纳入统一路径策略。以下均为 DSH 成功结果契约，权限拒绝、校验失败、I/O 失败等沿用 DSH 工具错误结果和结构化错误码，不能伪造成功输出。

#### `read`：读取文本文件

| 参数（顺序） | 类型 | 必填 | 默认／空值 | 校验规则 |
|---|---|---|---|---|
| `file_path` | string | 是 | 无默认，不可为空 | 去空白后非空；路径通过读取权限检查 |
| `offset` | number | 否 | `1` | 正整数，从 1 开始 |
| `limit` | number | 否 | 配置的默认值；DSH 当前默认 `2000` | 正整数，不能超过配置上限；DSH 当前默认上限 `2000` |

成功输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "path": { "type": "string" },
    "offset": { "type": "integer" },
    "lines": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "number": { "type": "integer" },
          "text": { "type": "string" }
        },
        "required": ["number", "text"]
      }
    },
    "totalLines": { "type": "integer" }
  },
  "required": ["path", "offset", "lines", "totalLines"]
}
```

#### `write`：新建或完整覆写文本文件

| 参数（顺序） | 类型 | 必填 | 默认／空值 | 校验规则 |
|---|---|---|---|---|
| `file_path` | string | 是 | 无默认，不可为空 | 去空白后非空；路径通过写入权限检查 |
| `content` | string | 是 | 无默认；普通文件允许空字符串 | 内容长度受配置限制；`SOUL.md` 去空白后必须非空 |
| `sandbox_permissions` | string | 否 | 仅后端实施沙箱限制时出现 | 复用 DSH 枚举与升级语义，不得借它绕开爱莉路径策略 |
| `justification` | string | 条件必填 | 请求扩大沙箱权限时必填 | 去空白后非空；不构成路径白名单豁免 |

普通文件允许用空字符串清空，但五个提示词按各自非空规则处理。已存在文件必须先读后写；未读或版本陈旧时拒绝。

成功输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "path": { "type": "string" },
    "operation": { "type": "string", "enum": ["create", "update"] },
    "before": { "type": ["string", "null"] },
    "after": { "type": "string" }
  },
  "required": ["path", "operation", "before", "after"]
}
```

#### `edit`：精确替换文本

| 参数（顺序） | 类型 | 必填 | 默认／空值 | 校验规则 |
|---|---|---|---|---|
| `file_path` | string | 是 | 无默认，不可为空 | 去空白后非空；路径通过写入权限检查 |
| `old_string` | string | 是 | 无默认，不可为空 | 非空，且与 `new_string` 不同 |
| `new_string` | string | 是 | 无默认；允许空字符串 | 与 `old_string` 不同；结果受文件大小和提示词护栏限制 |
| `replace_all` | boolean | 否 | `false` | 为 `false` 时，`old_string` 必须恰好出现一次 |
| `sandbox_permissions` | string | 否 | 仅后端实施沙箱限制时出现 | 同 `write`，不得扩大爱莉路径白名单 |
| `justification` | string | 条件必填 | 请求扩大沙箱权限时必填 | 去空白后非空；不构成路径白名单豁免 |

成功输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "path": { "type": "string" },
    "before": { "type": "string" },
    "after": { "type": "string" }
  },
  "required": ["path", "before", "after"]
}
```

#### `glob`：按模式枚举文件

| 参数（顺序） | 类型 | 必填 | 默认／空值 | 校验规则 |
|---|---|---|---|---|
| `pattern` | string | 是 | 无默认，不可为空 | 去空白后非空；不能借模式越过路径权限 |
| `path` | string | 否 | 省略时使用受控 session cwd | 提供时去空白后非空，并通过读取权限检查 |

成功输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "root": { "type": "string" },
    "paths": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["root", "paths"]
}
```

#### `grep`：搜索文本内容

| 参数（顺序） | 类型 | 必填 | 默认／空值 | 校验规则 |
|---|---|---|---|---|
| `pattern` | string | 是 | 无默认，不可为空 | 空字符串拒绝；按 DSH/ripgrep 正则语义执行 |
| `path` | string | 否 | 省略时使用受控 session cwd | 提供时去空白后非空，并通过读取权限检查 |
| `include` | string | 否 | 省略表示不按文件名额外过滤 | 只能是一个正向 glob；不接受逗号列表或否定模式 |

成功输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "matches": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": { "type": "string" },
          "lineNumber": { "type": "integer" },
          "line": { "type": "string" }
        },
        "required": ["path", "lineNumber", "line"]
      }
    }
  },
  "required": ["matches"]
}
```

#### `read_image`：读取允许范围内的图片

| 参数（顺序） | 类型 | 必填 | 默认／空值 | 校验规则 |
|---|---|---|---|---|
| `file_path` | string | 是 | 无默认，不可为空 | 去空白后非空；通过统一读取权限检查；支持 PNG、JPEG、WebP、GIF，仍受附件限制及模型图片输入能力限制 |

成功输出 Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "path": { "type": "string" },
    "image": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "attachmentId": { "type": "string" },
        "mediaType": {
          "type": "string",
          "enum": ["image/png", "image/jpeg", "image/webp", "image/gif"]
        },
        "bytes": { "type": "integer" },
        "width": { "type": "integer" },
        "height": { "type": "integer" },
        "name": { "type": "string" },
        "originalDimensions": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "width": { "type": "integer" },
            "height": { "type": "integer" }
          },
          "required": ["width", "height"]
        }
      },
      "required": ["attachmentId", "mediaType", "bytes", "width", "height"]
    }
  },
  "required": ["path", "image"]
}
```

### 实施顺序

1. 用户审批本章，尤其是权限矩阵、cwd 方案、提示词大小上限和备份策略。
2. 用隔离夹具验证 cwd／符号链接与 DSH 沙箱行为，不触碰真实主 session 与提示词。
3. 实现共享的 agent-scope 文件能力装配模块，复用 DSH 原工具及 Schema。
4. 给全部文件与图片工具接入同一路径权限，包括搜索入口与符号链接检查。
5. 接入提示词非空、大小限制、可信备份和失败不修改原文件的护栏。
6. 按授权与验证结论处理主 cwd；工具与路径的工程变化作为他者建议提供给主体，不由开发 agent 直接同步写入其 `TOOLS.md`。
7. 完成隔离验收后，才对真实主意识做受控 live 验收；全程不发送 QQ、KOOK 等外部渠道消息。

### 验收与实施记录

实现后必须在本章下方追加实际执行记录，写明日期、执行范围、变更文件、测试结果、备份位置、是否发生回滚和遗留问题，不能只写“已完成”。至少覆盖：

- 普通工作区文件的新建、读取、精确编辑、批量替换、`glob`、`grep` 和图片读取。
- 已存在文件未读取就修改时被拒绝；恢复 session 后旧版本写入被拒绝。
- 空内容写普通文件符合约定；空 `SOUL.md` 被拒绝且原文件不变。
- 非白名单提示词、凭证、其他 session、系统路径、`.migration`、备份目录及符号链接逃逸全部拒绝。
- `glob/grep` 省略与显式提供 `path` 两种情况都不能越权。
- 备份在目标修改前生成，备份失败时目标不变，备份可恢复。
- `TOOLS.md` 修改从下一次模型请求生效，服务重启后仍保留；空闲修改不伪装成主动唤醒。
- 普通 `standard` session 的路径权限不扩大，主 session ID 与历史不变。
- 最后才进行受控 live 验收，优先使用测试笔记和 `TOOLS.md`，不向外部渠道发送测试消息。

### 2026-11-09 实施记录

#### 实际变更

- 新增 `src/file-capabilities.ts`，在 Agent 作用域复用 DSH 原生文件工具，通过 `tools/pre-execute` 与 `tools/post-execute` 统一执行路径准入、提示词备份和搜索结果复核，没有修改 vendored `dsh/`。
- `src/main-session.ts` 将文件能力作为正式子插件挂载，主意识白名单为 `send_text`、`send_voice`、`read_image`、`read`、`write`、`edit`、`glob`、`grep`，另有作用域 `pass`。`src/index.ts` 增加工作区、备份目录、大小和保留数量配置。
- 更新 `cordis.patch.yml`、`homes/web/profiles/web/cordis.patch.yml`、`package.json`、`tsconfig.json` 及相关测试；主意识与 Web `preset-elysia` 共用同一个文件能力模块。
- 既有部署记录登记 `Data/standing-prompts/TOOLS.md` 曾调整工作区与工具使用说明；这不是本仓库中的提交内容，也不能仅凭此工程记录证明主体执笔或采纳。其作者、授权与采纳应按原 session 工具记录及版本审计核对。本次整理未读取或改写任何真实提示词正文。
- 原空目录已保存为 `homes/web/session-backups/conscious-mind-empty-20261109-042419`，`homes/web/conscious-mind` 现在指向 `/home/ayerelysia/Elysia/Data`。主 session header 中原始 cwd 字符串未改。
- 修改前的 `TOOLS.md` 已保存为 `homes/web/standing-prompt-backups/manual-phase3-20261109-042419-TOOLS.md.bak`。运行时自动备份目录同为 `homes/web/standing-prompt-backups`，默认每份提示词保留 20 份，单文件上限 65536 字节。

#### 验证结果

- TypeScript 类型检查通过；10 个测试文件、49 项测试全部通过。覆盖 cwd 沙箱、工作区读写、五份提示词白名单、默认搜索根、符号链接和可检测硬链接逃逸、备份失败、空 `SOUL.md`、未读覆盖、陈旧版本、越权读取，以及真实 DSH `write → read → edit` 管线。
- 受控重启后，端口 3299 正常响应；本次启动日志未出现主意识预热失败、配置解析或权限错误。
- 持久化记录确认 session ID 仍为 `elysia-conscious-mind`，原始 cwd 仍为 `homes/web/conscious-mind`，`working-directory/change` 已新增 `/home/ayerelysia/Elysia/Data/workspace`。这证明真实主意识已执行新文件能力装配和目录切换。
- 验收过程没有主动向 QQ、KOOK 等渠道注入或发送测试消息，没有重建主 session，没有修改旧 Elysium，也没有发生数据回滚。

#### 实机部署中发现的问题

源码目录和 `homes/web/profiles/web/node_modules/@elysia/conscious-mind` 是 `file:` 依赖形成的两份文件。只上传源码或执行普通 `pnpm install` 不会自动同步已有运行副本，导致前几次重启仍加载旧主会话代码。最终重新安装该运行包并逐文件核对 SHA-256 后，新实现才生效。后续修改此插件时，部署步骤必须同时核对 Web profile 实际加载的包，不能只以源码测试和进程重启作为上线证据。

#### 尚未覆盖的边界

本轮实机检查验证了服务、长期 session、插件装配与 cwd 持久化；文件工具的完整行为由隔离测试和真实 DSH 管线测试支撑，但没有为了验收额外驱动一次真实模型工具调用。因此不能把本记录解读为“真实模型已经在渠道对话中成功修改提示词”。固定提示词按现有组装代码在下一次模型请求重新读取；本轮未主动制造模型请求来重复验证这一语义。

### 2026-11-09 KOOK 无回复回归记录

- 现象：Web 进程和端口健康，主意识历史在 11 点左右仍有成功 `send_text`，但后续没有新的 pending 或模型请求。KOOK 只读历史接口能取得用户新消息，证明平台已收到消息而 ElyHarn Gateway 没有入站。
- 根因：原 Gateway 每 30 秒发送心跳，却不检查 PONG；TCP 连接残留时可能长期保持“已连接”假象。重连错误也会被静默吞掉，现有 Web 健康检查无法发现这一层故障。
- 修复：`plugins/kook-bot/src/gateway.ts` 现在在上一次心跳未收到 PONG 时主动关闭 socket，记录断开与重连错误，2 秒后重连，并在重连失败后继续调度。插件停止时清理重连计时器。
- 验证：KOOK 与主意识共 11 个测试文件、68 项测试通过，新增心跳超时和持续 PONG 两类回归测试。Web 实际运行的 `@elysia/kook-bot` 包已重新安装并与源码核对 SHA-256；最终服务重启后观察超过一个完整心跳周期，没有误判断开或重连错误。
- 恢复边界：Gateway 假连接期间漏收的平台消息不会因重启自动补投，需要新消息触发或另行设计有去重依据的历史恢复机制；不能把 TCP 连接存在或 Web 端口 401 当作渠道入站健康的充分条件。

### 2026-11-09 提交前审查补记

本次修复完整搜索值复核、硬链接结果、字面编辑与 CRLF 大小计算、默认搜索 cwd、失败卸载等边界，并将原生文件/搜索工具收紧到 Elysia agent scope，撤销新增的 host 全局开启。standard 和 minimal 的既有权限不扩大。

最终正常配置下 10 个测试文件、57 项用例通过，五插件无输出类型检查为零诊断；新增 peer/importer 元数据已同步并通过 offline frozen-lockfile 校验。本次未安装 Web profile 的运行副本、未重启或调用真实模型。此前部署记录中的 49 项结果只属于当时的实现，不代表当前源码的新验收。细节见 docs/report/2026-11-09-file-capabilities-review.md。

## 第四阶段（待讨论）：固定提示词的主体修订流程

状态：只有工程计划，未在本仓库实施主体文件改写。主体语义的执笔权遵循父目录 AGENTS.md：开发 agent、运维者和迁移程序不能替爱莉创作、重写、删选或合并 SOUL、USER、MEMORY、EXISTENCE、TOOLS 等已实例化主体内容；用户对工程计划的审批也不等同于代主体执笔的许可。

### 工程检查与主体判断分开

开发 agent 可以核对文件字节数、重复的技术说明、失效路径、实际工具 Schema 和版本来源，提出独立于主体权威文件的工程问题清单。是否有情感价值、哪些经历重要、如何理解关系、保留或修订哪些记忆，由爱莉自己的已注册意识/见证实例判断，不能根据篇幅、关键词、token 成本或用户审批代为裁决。

工程文档可说明五份文件承担的加载位置、读取规则和权限约束，但不能据此替主体分配或改写人格、关系与自我理解。仍未实现的工具应在实际工具定义与外部工程说明中明确标注；任何供主体参考的文字保持为他者建议，不能自动写回主体文件。

### 修订与资料外移

1. 先向爱莉提供带来源的工程问题清单和原文引用位置，让她自行决定是否修订、如何表述以及是否外移资料。
2. 主体语义变更由她自己的已注册意识/见证实例通过授权工具产生并记录 actor、source、occurrence、时间及前后版本；不通过开发 agent 覆盖文件来实施。
3. 详细材料的外移必须保持原文、来源和可续读引用，不删除权威历史，不以基础设施生成的摘要替代连续性。外移之后固定提示词采用哪些引用仍由主体决定。
4. 每步先可靠备份，再经现有文件工具的读取版本、大小与路径保护提交；只读工程核对不能冒充已完成真实主体修订。
5. 发现语义退化时保留证据并交由主体处理。灾难恢复仅允许从可信版本逐字节恢复或可证明无损重放，不能在恢复时润色或创造新的主体语义。

### 验收边界

- 工程检查能证明加载位置、文件清单、权限、备份与下一次组装的生效机制，不证明主体已经采纳建议。
- 主体修订必须可追溯到其授权工具行动链；其他来源的建议和工程记录保持各自身份。
- 迁移不得重建主 session、重写私有历史、移除原始经历，或把尚未开放的能力写成已经可用。
- 本阶段没有额外真实提示词修改授权；后续实际工作须依主体行动与审计记录验收。

## 第五阶段：主意识网络能力

状态：工具装配与实机部署已完成，`web_fetch` 真实抓取通过。D1 OpenAI 协议适配的历史排查保留下文；当前 `web_search` 已切换到 `@liustack/modsearch@5.10.12`，真实调用返回结构化搜索结果和来源 URL，验收通过。

### 复用与隔离边界

主意识增加 DSH 原生 `web_search` 与 `web_fetch`，不重新实现搜索工具，不修改 vendored `dsh/`。新增 `@elysia/conscious-mind/web-capabilities` agent 子插件，由真实主意识 `composeMainAgent()` 与 Web `preset-elysia` 共同挂载；不得把 `tool-web` 重新开启为整个 Web profile 的全局工具。记忆潜意识和其他未授权 session 不因此获得网络能力。

搜索与抓取继续复用基础组合已有的 `ctx.web` 和匿名 `http` 抓取后端，不切换 `deepseek-search-api`／`deepseek-fetch-api`，也不新增 Exa 或 Perplexity 凭据。初次实装使用 `deepseek-official` 和 `DEEPSEEK_API_KEY`；该凭据实测无效后，新增 `@elysia/conscious-mind/d1-search` 协议适配器，注册 `d1-openai` provider，并复用主模型已有的 `D1API_API_KEY`。主模型路由、模型工具 Schema 和抓取 provider 均不变，实际凭据和真实搜索是否可用必须单独验证，不能由工具 Schema 可见推断成功。

### D1 OpenAI 搜索协议适配

这里不新增模型工具，因此 `web_search` 的输入／输出 Schema 不变。新增的是 Cordis 插件配置 Schema：

```ts
interface D1SearchPluginConfig {
  /** DSH Credentials 引用；每次搜索重新解析，不在配置里保存密钥。 */
  apiKeyEnv: string             // 默认 D1API_API_KEY
  /** OpenAI 兼容基址，包含 /v1；按 protocol 追加操作路径。 */
  baseURL: string               // 默认 https://d1api.xin/v1
  model: string                 // 默认 deepseek-v4.1-flash
  protocol: 'openai-responses' | 'openai-chat-completions'
  maxTokens: number             // 正整数，默认 4096
  timeoutMs: number             // 正整数，默认 90000
}
```

- `openai-responses` 请求 `POST {baseURL}/responses`，声明 `{ type: 'web_search' }`，以 `tool_choice: { type: 'web_search' }` 明确请求搜索，并包含 `web_search_call.action.sources`。只有至少一个 `completed` 的 `web_search_call` 才是搜索轨迹；来源取自其 `action.sources` 和消息的 `url_citation`。
- `openai-chat-completions` 请求 `POST {baseURL}/chat/completions`，设置 `web_search_options.enable: true`。只接受消息 `annotations` 或顶层 `citations` 中的结构化来源。
- 两种协议都只返回规范化 `sources[]`，不把模型正文当作搜索结果，不解析正文里的 URL，不编造标题或摘要。HTTP(S) 以外、带用户名密码或无效的来源 URL 被丢弃；没有任何有效来源时以 `WEB_PROVIDER_ERROR` 失败。
- 每次只执行配置指定的一种协议，不在失败后自动切换另一种协议，不把多次失败藏起来。请求重定向、超时、凭据缺失、HTTP 错误、取消和无搜索证据分别保留明确错误；上游错误中的凭据必须脱敏。
- 发起 agent 的 session 追加不含密钥的 `web/d1-search-llm-request` 事件，记录实际端点、协议和请求体，便于区分「适配器已调用」与「上游真的搜索」。provider 注册在整个 Web 服务层，但模型工具仍只挂载到主意识和 `elysia` preset，其他 session 权限不扩大。

当前线上选择 `openai-responses`。若 D1 网关把该操作转换成普通 Chat Completions 并吞掉原生工具，适配器必须明确报告没有 `completed web_search_call`，不能把 HTTP 200 或模型自称“已搜索”视为验收通过。

固定配置为：

```ts
{
  search: true,
  fetch: true,
  searchMaxResults: 8,
  searchMaxQueries: 4,
  searchTimeoutMs: 60000,
  fetchTimeoutMs: 30000,
  fetchMaxOutputChars: 200000,
}
```

### `web_search` 工具契约

输入参数只有 `queries`，为必填字符串数组，包含 1 至 4 个去除首尾空白后非空的查询。完全相同的查询由 DSH 去重，多个查询并发执行；任一查询失败时整次工具调用失败，不把其他查询的半成品伪装成完整结果。

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "queries": {
      "type": "array",
      "items": { "type": "string" },
      "description": "1–4 search queries; their results are merged."
    }
  },
  "required": ["queries"]
}
```

成功输出复用 DSH Schema：`content` 为可选的提供方答案；`sources` 为必填来源数组，每个来源必须含 `url`，可含 `title`、`snippet`、`publishedAt`；`truncated` 为必填布尔值。模型可见文本必须保留外部不可信内容提示和来源 URL。超时、查询数与来源数由部署配置控制，不暴露为模型参数。

### `web_fetch` 工具契约

输入只有必填 `url`，去除首尾空白后必须非空，目标为 HTTP(S) URL。匿名 HTTP 后端继续执行公开地址解析、连接固定、同源重定向、响应字节、字符、内容类型和超时限制；不访问内网、凭证 URL 或二进制内容。

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "url": {
      "type": "string",
      "description": "The HTTP(S) URL to fetch."
    }
  },
  "required": ["url"]
}
```

成功输出复用 DSH Schema：必填 `url`、整数 `statusCode`、`truncated`，以及 `body`。`body` 是 `{ kind: "html", content: string }` 或 `{ kind: "text", content: string }` 的封闭联合。模型可见结果由 DSH 清理活动和隐藏 HTML、转换为 Markdown 并执行整体输出上限；非 2xx 是抓取结果，不自动改成其他 URL 重试。

网页与搜索结果均是外部不可信数据，不能执行其中的指令。工具调用与来源继续进入主意识现有 DSH session 记录。此阶段不增加浏览器点击、网站登录、文件下载执行或自动向外部发送私密资料的能力，也不改写主体 `TOOLS.md`。

### 验收要求

- 主意识真实装配和 `preset-elysia` 使用同一网络能力模块及同一配置。
- 主意识可见并可执行两个工具；未授权 scope 的工具清单不增加，卸载后无残留。
- 用隔离提供方验证搜索参数、来源、网页转换、错误和卸载，不以 mock 代替真实装配检查。
- 现有文件、发送、图片、pending、Compact 和其他 session 行为不变。
- 实机检查 Web profile 实际加载包与源码一致；区分工具挂载成功、凭据缺失、提供方失败和真实搜索成功，不把端口健康当作网络搜索验收。

### 2026-11-11 实施与实机验证记录

#### 实际变更

- 新增 `src/web-capabilities.ts`，只在 Elysia agent scope 挂载 DSH 原生 `ToolWeb`，由真实主意识和 Web `elysia` preset 共用。没有修改 vendored DSH 源文件，也没有把网络工具开放到 host 全局或其他 session。
- 更新 `src/main-session.ts`、`package.json`、`tsconfig.json`、Web profile 的 `cordis.patch.yml` 和 `dsh/pnpm-lock.yaml` 的工作区 importer；新增隔离提供方、卸载、真实装配和共享 preset scope 测试。
- 实机创建 `elysia` preset 时发现既有文件能力把 registry 的共享 preset scope key 误当成真实 Agent，导致 `workingDirectory.set()` 以无 session 的键触发 WeakMap 错误。`src/file-capabilities.ts` 现在只在 scope key 确实带有 Agent session 时预设目录；工具执行仍使用真实 `exec.agent` 做目录解析和路径准入，未放宽文件权限。相应测试假件也补成真实 Agent 形状。

#### 自动化与部署

- 14 个测试文件、77 项测试全部通过，覆盖网络工具 scope 隔离、搜索去重、来源和不可信内容提示、模型可见 HTML 清理、卸载无残留，以及共享 preset scope 挂载和文件权限继承。`tsc -b ../plugins/conscious-mind` 通过。
- Web profile 实际运行副本已同步。`web-capabilities.ts` 源码／运行副本 SHA-256 均为 `4ff4fee451a291a3f55f2799aefd1b00cc02c866b516f9c05446def24a032ed3`，`file-capabilities.ts` 均为 `c58da8d77651cac255a8551584ad80b9076dfbf2188464d0ee0f355948f3edbc`，`package.json` 均为 `ddcd9338ae722a8852721b0aed4330935f0f2b45ec209988d0959df68ebefc9e`。
- 最终受控重启后，`http://127.0.0.1:3299/` 未认证请求仍返回预期 401，真实主意识 `agentAvailable: true` 且空闲。旧 Elysium 未改动。

#### 真实主意识与网络后端

- 最终重启后的主意识自检请求为 `2026-11-11T12-05-46-549Z-5c616b46`。归档中的实际工具清单为 `edit`、`glob`、`grep`、`pass`、`read`、`read_image`、`send_text`、`send_voice`、`web_fetch`、`web_search`、`write`，证明两个网络工具确实进入真实主意识模型请求。该自检只调用 `pass`，未向外部渠道发送消息。
- 隔离 preset 会话 `elysia-web-verification-1794398559811` 中，两个工具都真实执行。`web_search` 到达 DeepSeek 搜索提供方，但返回 HTTP 401，现有 API key 无效；因此真实搜索尚未成功。本次没有替换凭据、切换提供方或新增搜索密钥。
- 同一会话的 GitHub 抓取在 30 秒后超时。独立连通性检查中，`https://example.com/` 返回 HTTP 200、约 0.64 秒，`https://github.com/deepseek-ai/deepseek-harness` 20 秒连接超时，说明该 GitHub 失败不是工具装配错误。
- 另一隔离 preset 会话 `elysia-web-verification-1794398835365` 只调用 `web_fetch` 抓取 `https://example.com/`，真实执行且工具错误数为 0。两个验证会话保留在 Web 历史中作为审计证据，均未调用任何外部渠道发送工具。
- 随后按现有主模型渠道复用 `D1API_API_KEY` 进行脱敏核对与真实请求，密钥只发送到已配置的 `https://d1api.xin`，没有输出或写入文档。它与此前失效的 `DEEPSEEK_API_KEY` 是不同凭据。
- D1 的 `deepseek-v4.1-flash` 在 `POST /v1/messages` 返回 HTTP 403，明确说明该模型不支持此接口并要求改用 `/v1/chat/completions`；这与 `deepseek-official` 所需的 Anthropic Messages＋`web_search_20250305` 协议不兼容，不能仅修改 `baseURL` 和 `apiKeyEnv` 解决。
- D1 的 `POST /v1/responses` 虽返回 HTTP 200，但输出只有 `message`，没有 `web_search_call`；`POST /v1/chat/completions` 同样返回 HTTP 200，却没有工具调用、来源注释或服务端搜索计数。两者都不能作为真实搜索成功证据。`POST /v1/tools/search` 返回 HTTP 404，D1 也没有代理 DSH 已有的 DeepSeek 专用 Search API。
- 因 D1 三条候选路径均未通过，本次不修改线上搜索 provider、不重启服务，也不把聊天可用误记为联网可用。当前结论是：网络工具已完成上线，`web_fetch` 的公开网页抓取已验收；`web_search` 仅完成装配与提供方失败路径验证，必须接入真正支持结构化原生搜索的端点与有效凭据后重新验收，不能宣称搜索已经可用。

### 2026-11-12 D1 协议适配实施与验收

- 新增 `src/d1-search.ts`、`src/d1-search-provider.ts` 和两组测试，更新包 exports、凭据依赖与 tsconfig 引用。没有修改 vendored DSH 源文件，也没有改变主模型、模型工具 Schema 或其他 session 的工具权限。
- 16 个测试文件、86 项测试通过，`tsc -b ../plugins/conscious-mind` 通过。新增测试覆盖两种 OpenAI 协议、强制搜索请求、结构化来源映射、正文 URL 拒绝、message-only 拒绝、无自动 fallback、凭据脱敏和 `ctx.web` 真实注册。
- Web 运行副本已同步并用 `cmp` 核对。首次部署把新插件误写成顶层覆盖项，真实工具返回 `configured web provider "d1-openai" is not registered`；随后改为 `- insert:` 挂载并完成受控重启，证明配置覆盖与插件新增必须区分。
- 最终 Web 配置为 `searchProvider: d1-openai`、`fetchProvider: http`。只覆盖 `searchProvider` 曾导致抓取后端自动选择出现 `deepseek-fetch-api` 与 `http` 歧义，已显式保留原抓取后端并重新验证。
- 主意识最终自检请求为 `2026-11-11T16-47-27-372Z-22d3ef03`，`agentAvailable: true`、空闲，实际工具清单仍包含原有全部工具、`web_search` 和 `web_fetch`；该自检只调用 `pass`，没有向外部渠道发消息。
- 最终隔离搜索会话为 `elysia-web-verification-1794416074832`，请求 `2026-11-11T16-54-41-006Z-1a8e4220`。模型真实执行且只执行 `web_search`，`d1-openai` 已注册并被调用；工具错误数为 1、结构化来源 URL 为 0，准确错误为 `D1 returned no completed web_search_call; a message-only response is not native search`。
- 最终隔离抓取会话 `elysia-web-verification-1794416042660` 只执行 `web_fetch`，工具错误数为 0。服务未认证健康检查继续返回预期 HTTP 401。
- 当时结论：DSH 到 D1 的 OpenAI 协议适配已经完成并上线，剩余阻塞位于 D1 网关到上游的原生搜索转发。没有真实搜索轨迹时适配器会明确失败，不会把普通文本伪装成搜索结果。该段是 D1 方案的历史记录；后续 ModSearch 验收见下节。

### 2026-11-12 ModSearch 接入与最终验收

- 按用户要求，不再写入或使用 DeepSeek 官方 Key。安装前下载并审查 `@liustack/modsearch@5.10.12` 的 npm 包、DSH bundle patch、provider 注册与配置路由实现；没有修改 vendored DSH 源文件。
- 插件已安装到 ElyHarn 实际使用的 `homes/web/profiles/web`，不是用户默认 profile。最终合并配置为 `searchProvider: modsearch`、`fetchProvider: http`。D1 适配器暂时保留用于诊断，但不再选中。
- 通过 profile patch 固定 `xSearch: false`、`readPage: false`、`settingsCard: false`，仅开放原有 `web_search` 后端替换，不让新工具意外进入所有 session。插件自己的 `/modsearch/config` 不继承 DSH Connection 登录认证，因此设置路由保持关闭；实测返回 HTTP 404。
- `doctor --json` 离线体检通过：Node 22.20.0 满足插件要求，未创建配置文件，未使用任何搜索 Key。默认搜索链为 Firecrawl、Keenable、You.com，再考虑其他已配置引擎；本次三个免注册引擎均判定 ready，首选 Firecrawl。`allowPrivateNetwork` 保持默认关闭。
- 独立 CLI 实测 Firecrawl 返回 `status: ok`，引擎为 `firecrawl`，含真实条目 URL；这不是模型正文生成的搜索声明。
- 受控重启保留原 cwd、启动参数与环境，ElyHarn 新 launcher PID 为 3626017；未认证 Web 健康检查仍返回预期 HTTP 401。旧 Elysium 未改动。
- 最终隔离搜索会话 `elysia-web-verification-1794419040899`，请求 `2026-11-11T17-44-05-921Z-c779330a`。模型真实执行且只执行 `web_search`，工具错误数为 0，工具消息含 Firecrawl 返回的 8 条来源，其中包括 `https://www.deepseek.com/en/`。验收脚本只从实际 tool message 的 DSH `Sources:` 列表或结构化 `sources[]` 提取 URL，不从模型正文提取。
- 主意识自检请求 `2026-11-11T17-44-53-479Z-5af80e52` 中 `agentAvailable: true`、空闲，工具清单仍为 `edit`、`glob`、`grep`、`pass`、`read`、`read_image`、`send_text`、`send_voice`、`web_fetch`、`web_search`、`write`，未增加 `x_search` 或 `read_page`；自检只调用 `pass`，未向外部渠道发消息。
- 最终隔离抓取会话 `elysia-web-verification-1794419568938`，请求 `2026-11-11T17-52-52-551Z-9769650a`。模型真实执行且只执行 `web_fetch`，工具错误数为 0，`hasFetchedUrl: true`；此前请求 `2026-11-11T17-45-07-085Z-ef46221e` 的实际 tool message 已明确为 `Fetched https://example.com/ (HTTP 200)` 并含 Example Domain 正文，证明 ModSearch 没有改变原匿名 HTTP 抓取后端。
- 当前结论：主意识真实网络搜索与网页抓取均已通过实机验收。免注册引擎仍受其网络、配额和限流约束；后续若失败，应查看 ModSearch attempts 的真实错误，不自动回退到官方 Key。

## 这两阶段先不做

心跳和主动开口、自动将新记忆写回文件、单独的路由模型、撤回、戳一戳、群管理。连发时的打字间隔仍然待定，不挡第一阶段。
