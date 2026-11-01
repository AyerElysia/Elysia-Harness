# 主意识需求

一个 agent，一条长期 session。QQ、飞书、KOOK 只负责进出。会话日志、压缩、提示词组装和工具循环用 Harness 现有的。固定提示词仍在外部目录，按已实现的前缀规则加载。

当前工具只有 `send_text`、`send_voice`、`pass` 和 DSH 原生的 `read_image`。`read_image` 只读取已有本地图片；这条 session 不挂代码、文件写入与编辑、搜索那类工具。

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

## 这两阶段先不做

心跳和主动开口、把新记忆写回文件、单独的路由模型、撤回、戳一戳、群管理。连发时的打字间隔仍然待定，不挡第一阶段。
