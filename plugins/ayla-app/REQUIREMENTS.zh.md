# Ayla 通道需求（DSH 侧插件 · 重写版）

> 状态：**需求，未实现**。本文只定义契约与验收，不代表任何代码已存在。
> 上一版（Ayla 调 DSH 入站 HTTP + 共享密钥 + 依赖 conscious-mind）**已作废**，被本文整体取代。
> 旧 Python Elysium 已废弃；阶段三接口（`/chat/messages:inject`、`/events/stream`、service credential）全部退役。
> 与代码冲突时以代码为准，并直接回填本文，不要让两种说法并存。
> 实施步骤见 [DEVELOPMENT.zh.md](./DEVELOPMENT.zh.md)。
> 核对基线（2026-11-09 本地）：Elysia-Harness `914db933d3`、Ayla `b4fc8ee`，两者工作树均干净。

## 1. 一句话

**Ayla 应用里的聊天进入 DSH，模型的回复回到 Ayla 的同一个会话。DSH 侧插件可独立安装，装了 conscious-mind 就融进爱莉主 session，没装就自建一条。**

## 2. 三条根约束（本次重写的起因）

这三条同时成立，决定了整个设计：

| # | 约束 | 推论 |
|---|---|---|
| C1 | **任意 dsh 可装，零本仓库依赖** | 插件不得 `import` 任何 `@elysia/*`；不得以 `inject` 声明 `inboundPending` / `outboundText`（声明即强制，缺服务插件就不挂） |
| C2 | **DSH 主动连 Ayla**（同 QQ/NapCat 形态） | DSH 不需要对外开放端口；入站由插件拉取/接收，出站由插件回写。Ayla 不需要知道 DSH 在哪 |
| C3 | **代码尽量写在 Ayla 侧** | 协议、重试、落库、广播、会话解析都在 Ayla 后端；DSH 插件只做协议转换与形态适配 |

C1 与「沿用 conscious-mind 的 `send_text`」直接冲突，因此引入**双形态**（§4）。

## 3. 主体性与边界（硬约束，不因重写而放松）

- Ayla 与 KOOK、QQ、飞书同级，是**事件源与回复目标**，不是第二个心智。
- 渠道插件**不持有主体语义**：它不写第一人称内容、不改主体文件（`SOUL.md`/日记等）。
- Ayla 侧**绝不生成爱莉的第一人称内容**；应用内以她为发送者的消息只能来自 DSH 出站。`display_name` 只用于 UI。
- 代码不替主体判断消息意义：不按关键词分类、不打标签、不因「像闲聊」就不入账。消息类型字段只表示**传输结构**。
- 用户消息进入权威历史后不得因预算或失败被改写或删除；失败必须显式报告。
- 出站失败不得伪造成「已发送」，也不得自动重放造成重复。

## 4. 双形态

插件只有一个包、一套协议；**形态是运行时判定 + 设置可覆盖**。

| 形态 | 触发条件 | 消息去哪 | 谁回复 |
|---|---|---|---|
| **elyh** | 设置显式选 `elyh`，或自动探测到 `inboundPending` 与 `outboundText` 均存在 | `ctx.get('inboundPending').receive(event)` | conscious-mind 自己的 `send_text` |
| **standalone** | 设置选 `standalone`，或未探测到上述服务 | 插件自建固定 session `ayla-channel` | 插件自注册的 `send_text`（agent 作用域） |

判定规则（顺序固定，结果写日志一行）：

1. 设置为 `elyh` 但服务缺失 → **加载即失败**（fail loud），不静默降级。
2. 设置为 `standalone` → 即使服务存在也用 standalone。
3. 设置为 `auto`（默认）→ 两个服务都在 = elyh，否则 standalone。

**不得**在 elyh 形态下重复注册 `send_text`：那会让模型看到两个同名工具。

## 5. 目标链路

```text
Ayla 前端 ──WS──► Ayla 后端(chat) ──落库 + broadcast_message_new──► 用户立刻看到自己的消息
                        │
                        │ 同事务写 outbox 行
                        ▼
              Ayla 通道 consumer（新建，ws /ws/elysia-bridge/?token=<jwt>）
                        ▲                                    │
                        │  出站帧 reply / typing / ack        │ 入站帧 inbound
                        │                                    ▼
        ┌───────────────┴──────────────┐          DSH  ayla-app 插件（零依赖）
        │ outbox worker 串行、退避重试  │                    │
        └──────────────────────────────┘          ┌─────────┴─────────┐
                                                  │                   │
                                            elyh 形态            standalone 形态
                                        inboundPending.receive   自建 ayla-channel
                                                  │                   │
                                                  ▼                   ▼
                                        elysia-conscious-mind   ayla-channel
                                                  │                   │
                                              send_text          send_text(插件自带)
                                                  └─────────┬─────────┘
                                                            ▼
                                                  出站帧回到同一条 WS
```

**链路里没有**：SSE 订阅、credential 换发、事件账本投影、DSH 对外 HTTP 端点、共享密钥。

## 6. 连接与鉴权

| 项 | 值 |
|---|---|
| 方向 | DSH 主动拨 Ayla |
| 地址 | 设置项「Ayla 后端地址」，默认 `http://127.0.0.1:8100`（由它派生 WS 地址） |
| 路径 | `/ws/elysia-bridge/?token=<access_jwt>`（沿用 Ayla 既有 WS 鉴权约定，见 `apps/accounts/consumers.py`:36） |
| 账号 | **爱莉自己的 Ayla 账号**。插件用账号密码换 JWT，不新增认证方式 |
| 登录 | `POST /api/v1/auth/login/` → `{access, refresh}` |
| 刷新 | `ROTATE_REFRESH_TOKENS=True`：刷新后 refresh 会变，**必须持久化新值**；`POST /api/v1/auth/refresh/` |
| 401/403 | 刷新一次并重连；刷新也失败 → 显式报错，不静默重试成死循环 |
| 令牌存放 | 内存持有 access；refresh 落盘到 DSH 家目录下的运行文件（0600），**不进 Git、不进日志** |
| 密码存放 | 设置页 `role('secret')` 字段，脱敏显示；**不进日志、不进异常栈** |
| 明文传输 | 仅允许 `http`/`ws` 指向 loopback 或私网；非 loopback 且非 https/wss → **加载失败并给出明确文案** |

> 部署现状：Ayla 后端 `daphne` 绑 `127.0.0.1:8100`（host 网络），DSH 在同一台机器，走回环、不经 nginx、不经过任何隧道。

## 7. 协议（Ayla 定义，DSH 实现）

一条 WS、JSON 文本帧、双向。所有帧带 `v`（当前 1）与 `type`。

### 7.1 入站帧（Ayla → DSH）

```json
{
  "v": 1,
  "type": "inbound",
  "seq": 1024,
  "message": {
    "id": "90211",
    "conversation_id": "17",
    "conversation_type": "private",
    "sender_id": "8d9c72a75f634ff1b4980f504c375f8b",
    "sender_name": "小希",
    "sent_at": "2026-11-09T16:20:00+08:00",
    "parts": [
      { "type": "text", "text": "好了，我吃完了" },
      { "type": "image", "media_id": "a1b2c3d4", "media_type": "image/png" }
    ]
  }
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `seq` | 是 | 单调递增整数，DSH 用于 ack 与断线续传 |
| `message.id` | 是 | Ayla `Message.id` 十进制字符串；与 `conversation_id` 组成 DSH 去重键 |
| `conversation_type` | 是 | `private` / `group` |
| `parts` | 是 | ≥1，保持平台原顺序；只接受 `text`、`image` |

**图片不给字节，给 `media_id`**：DSH 用同一枚 JWT 调 `POST /api/v1/media/{media_id}:sign` 取短时 GET URL 再下载，然后走 `ctx.attachments.admitPromptContent()` 准入。这样 WS 帧保持小、不阻塞心跳，且复用 Ayla 已有的媒体鉴权（`media/views.py`:252）。

未知 `parts[].type` 的处置，**已按实现分档**（原稿把 `mention`/`mixed` 与 voice/file 并列，实现时判定需要细分）：

| type | 处置 | 理由 |
|---|---|---|
| `text` | 原样投递 | — |
| `image` | `media_id` → 签名 URL → 下载 → 准入 | — |
| `mention` | **展开成 `@昵称` 文本**，不整条拒绝 | 丢掉它等于让她看不见自己被点名 |
| `mixed` | **按 `segments` 逐段投影**（text/image/mention） | 有真实可投递的段，逐段投影比整条拒绝更保真 |
| `voice` / `file` / `video` / `emoji` / `share` | **整条消息不可投递**，Ayla 侧标 `failed` 并记原因 | 本期不支持，且丢弃后只投文字等于伪造她收全了 |

实现见 `Ayla/backend/apps/elysia_bridge/services.py` 的 `SUPPORTED_PART_TYPES` 与
`build_inbound_parts`。改判据只需动这一处。

### 7.2 出站帧（DSH → Ayla）

> **本节已按实现回填。** 初版只定义了 `error`，漏了成功回执 `sent` —— 没有它
> 每次 `send_text` 都会超时并误报「投递状态未知」。实现见
> `Ayla/backend/apps/elysia_bridge/consumers.py` 与
> `plugins/ayla-app/src/protocol.ts`，两侧已对齐。

```json
{ "v": 1, "type": "reply", "client_message_id": "ayla-channel:875:1:0",
  "conversation_id": "17", "conversation_type": "private",
  "content": "这个决定对呀，有太阳的时候先把自己晒热", "reply_to": null }
```

```json
{ "v": 1, "type": "ack", "seq": 1024 }
```

| 帧 | 语义 |
|---|---|
| `reply` | 发一条文本消息。`conversation_type` 必须与真实类型一致，否则 Ayla 回 `error`（防止把私聊回复发进群） |
| `ack` | 确认已处理到 `seq`（含），Ayla 据此推进 outbox 游标；未 ack 的会重投 |

Ayla → DSH 的回执与错误帧：

```json
{ "v": 1, "type": "sent", "client_message_id": "…", "message_id": "90211", "seq": 813 }
```

```json
{ "v": 1, "type": "error", "client_message_id": "…", "code": "conversation_not_found", "detail": "…" }
```

| 帧 | 语义 |
|---|---|
| `sent` | `reply` 已落库。DSH 据此回填 `send_text` 的 `messageId`。`seq` 可选（Ayla 建帧时若尚无 seq 可只回 `message_id`） |
| `error` | `reply` 被拒。DSH 把该次 `send_text` 记为失败（带 `stoppedAt`），**不重试** |

**error code 词表**（实现口径，DSH 按 code 分支时以此为准；未列出的 code 一律按失败处理）：

| code | 触发条件 |
|---|---|
| `conversation_not_found` | 会话不存在 |
| `conversation_not_a_member` | 爱莉不是该会话成员 |
| `conversation_type_mismatch` | 声明类型与真实类型不一致（**不落库**） |
| `content_too_large` | 正文超 32 KiB（UTF-8 字节） |
| `bad_frame` / `unknown_type` / `unsupported_version` | 帧结构非法 |

**close code**：`4401` 未认证（沿用 accounts 约定）、`4403` 非爱莉账号、
`4409` 被新连接顶替、`4413` 超帧上限。

### 7.3 心跳与重连

- DSH 每 30 秒发一帧 `{"v":1,"type":"ping"}`，Ayla 回 `pong`；两轮无响应视为断开。
- 重连：指数退避 1s → 2s → … → 60s（带抖动），无限重连但**不刷日志**（状态变化才记一行）。
- 重连后 DSH 发送最后已 ack 的 `seq`（`{"v":1,"type":"resume","seq":N}`），Ayla 从 N+1 起重投。

### 7.4 会话标识

与 KOOK/QQ 同构，便于模型理解：

| Ayla 会话 | DSH `conversation` |
|---|---|
| 私聊 conv 17 | `ayla:private:17` |
| 群聊 conv 42 | `ayla:group:42` |

解析失败必须抛错，**不得**降级成默认会话。

## 8. DSH 插件契约

### 8.1 包与依赖

- 包名 `@elysia/ayla-app`，`dsh.bundle.patch` 指向自己的 `cordis.patch.yml`，`tsconfig.json` 继承 `../../dsh/tsconfig.base.json`（与 `plugins/request-archive` 同构）。
- **`dependencies` 为空**，`peerDependencies` 只允许 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与所用 dsh 服务包；**不得出现任何 `@elysia/*`**。
- 运行时零第三方依赖：WS 用 Node 内置全局 `WebSocket`（Node ≥ 22），不得引入 `ws`。
- `package.json` 保持 `private: true`：不发布 npm，只在仓库内与复制安装两种方式。

### 8.2 服务注入

`inject` 只声明**必然存在**的服务：`agents`、`sessionPersistence`、`attachments`、`tools`。

`inboundPending` / `outboundText` **一律用 `ctx.get()` 探测**，绝不写进 `inject`（写进去就等于强制依赖，违反 C1）。这与 dsh 包规则「可选服务用 `ctx.get(name)`」一致。

### 8.3 设置页字段（`.volatile()`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8100` | Ayla 后端地址；校验 scheme 与 loopback/私网规则（§6） |
| `username` | string | 空 | 爱莉的 Ayla 账号 |
| `password` | string `role('secret')` | 空 | 自动脱敏 |
| `mode` | `auto` / `elyh` / `standalone` | `auto` | 形态选择（§4） |
| `workspaceDir` | string | 空 | **仅 standalone 形态使用**；为空则使用该 dsh 的默认工作区 |

其余（重连退避、限额、心跳周期、提示词）**不进设置页**，走 `cordis.patch.yml` 配置或代码常量。

### 8.4 standalone 形态

- 自建固定 session id `ayla-channel`，`cwd` 取自 `workspaceDir`（绝对路径；为空用 `process.cwd()`）。
- **不写提示词**：工作区的 `AGENTS.md` 由 dsh 自带的项目指令机制注入，插件不重复实现 standing prompt。
- 在**该 session 的 agent 作用域**注册 `send_text`（`agentCtx.tools.register`），不全局注册——否则宿主里其他 session 会凭空多一个能往 Ayla 发消息的工具。
- 一条 user message = 一个入站批次；批次内多个会话的消息合并成一条消息（与 conscious-mind 的 `formatInboundBatch` 同形）。
- 工具参数与语义**与 conscious-mind 的 `send_text` 保持一致**（`channel`、`conversation`、`thought`、`mood`、`decision`、`expected_response`、`content`、`reply_to`），使模型在两种形态下看到同样的能力，无需两套提示词。

### 8.5 elyh 形态

- 把入站事件组装成 conscious-mind 的 `InboundEvent` 结构后调 `inboundPending.receive()`。
- 不注册任何工具、不建 session、不安装回复轮。
- `channel` 恒为 `ayla`。

### 8.6 出站

两种形态共用同一段出站代码：`conversation` → 校验 → 组 `reply` 帧 → 等 `error` 或超时 → 回 `messageId` / 抛 `OutboundDeliveryUnknown`。**不自动重试**（与 `send_text` 既有契约一致：第一段失败即停）。

## 9. 可靠性（Ayla 侧）

- 入站 outbox 与消息落库同事务写入，字段至少：`message`、`status`（pending/delivered/failed/dead）、`attempts`、`next_attempt_at`、`last_error`、`created_at`。
- WS 断开期间消息堆积，重连后按 `seq` 升序补投；收到 `ack` 才置 `delivered`。
- 同一会话严格串行；跨会话可并发。
- **取号实现**：专用序号行 `AylaChannelSequence` + `SELECT ... FOR UPDATE`。
  文档初版写的「`SELECT ... FOR UPDATE` 取 max+1」经 4 连接压测在 MySQL 8
  REPEATABLE READ 下**不可用**（表尾是不存在的 gap，多个事务可同时持有该 gap
  的 X 锁，实测三种写法均为 `Deadlock 1213` 或 `Duplicate entry 1062`）。
  改用专用序号行后 16 并发全通过，序号连续，最大等锁 0.042s。
- 超过重投上限 → `dead`，保留现场，人工处置，不静默丢弃。
- 出站 `reply` 的幂等：Ayla 用 `client_message_id` 派生幂等键（`"ayla-" + sha256(id).slice(0,24)`，≤64 字符，符合 `Message.idempotency_key` 的 `max_length=64`）。

## 10. 限额

| 项 | 上限 | 行为 |
|---|---|---|
| 单条文本 | 32 KiB | 超出：入站标 `failed`；出站回 `error` |
| 每条消息图片数 | `attachments.imageLimits.maxImagesPerMessage` | 超出：整条不可投递 |
| 单图字节 | `attachments.imageLimits.maxImageBytes` | 超出：整条不可投递 |
| 单帧字节 | 1 MiB | 超帧直接断连并记一行 |
| WS 并发连接 | 1（同一账号） | 新连接顶替旧连接并记一行 |

## 11. 本期不做

语音（`send_voice` 到 Ayla）、直播、文件/视频投递、撤回、戳一戳、群管理、已读回执同步、消息编辑、持久化去重（DSH 侧仍为进程内 `Set`）。

**但旧代码里的语音/直播对接按废弃处理删除**，不在本期重写（见 §13）。

## 12. 验收

### 12.1 DSH 插件（隔离测试，不连真实 Ayla）

- 形态判定：`mode=elyh` 且缺服务 → 加载失败；`auto` 两服务在 → elyh；`auto` 缺一 → standalone；`standalone` 强制独立。
- 依赖断言：包内**没有** `@elysia/*` 导入（可用 grep 断言 + 类型检查）。
- 地址校验：非 loopback 的 `http://` 被拒；`https` 允许。
- WS 帧：入站解析、图片 `media_id` 下载 + 准入、未知 part 整条拒绝、ack 发出、resume 帧。
- 出站：`error` 帧 → 工具失败带 `stoppedAt`；超时 → `OutboundDeliveryUnknown`；成功回填 `messageId`。
- standalone：注册的 `send_text` 只在该 agent 作用域可见，全局工具表不含它。
- 断连退避与静默：反复断连不刷日志；状态变化才记一行。
- 类型检查零 diagnostics；`git diff --check` 通过。

### 12.2 Ayla 侧（隔离测试）

- consumer：无 token / 错 token 拒绝；正确 token 接入并绑定 profile。
- 入站：落库后 outbox 行出现；WS 推送帧内容与落库一致；图片以 `media_id` 传递。
- ack：收到 ack 后状态置 `delivered`，游标推进。
- 重连：断开后重连，`resume` 从正确位置补投，不重复不遗漏。
- 出站：`reply` 帧落库 + `broadcast_message_new` 一次；同 `client_message_id` 两次 → 一条消息。
- 类型不符 → `error` 帧，不落库。
- 旧代码已删除：无 SSE、无 credential 文件、启动日志不再出现 `no enabled elysia profile`。

### 12.3 端到端（真实环境，受控）

- Ayla 里给爱莉发文字 → DSH 主 session（或 ayla-channel）出现该事件 → 回复回到 Ayla，`seq` 连续、未读正常。
- 发图片 → 她能看见（真实模型图片输入），回复引用图内事实。
- 断 DSH 进程 → Ayla 侧积压；重启后补齐，除进程内去重窗口外不重复。
- 验收过程不向 KOOK/QQ 发测试消息；不动主 session 的 id、cwd、header。

## 13. 废弃与删除清单（Ayla 侧）

> **本节已按 `D1-AUDIT.md`（2026-11-09 只读勘察，923 行）重写。** 初版有 5 处事实错误，其中 3 处会让后端无法启动或全站 500。凡是与审计冲突的，以审计为准。

### 13.1 整文件删除（12 个）

| 文件 | 行数 | 说明 |
|---|---:|---|
| `apps/elysia_bridge/elysia_client.py` | 821 | 阶段三 HTTP 客户端 |
| `apps/elysia_bridge/inline.py` | 312 | SSE 出站投影线程 |
| `apps/elysia_bridge/voice_observer.py` | 328 | 语音 observer WS |
| `management/commands/run_bridge.py` | 116 | SSE 订阅循环入口 |
| `tests/test_elysia_client.py` | 467 | 旧契约测试 |
| `tests/test_bridge_loop.py` | 592 | 同上 |
| `tests/test_outbound.py` | 281 | 同上 |
| `tests/test_inline.py` | 109 | **初版漏列** |
| `tests/test_voice_observer.py` | 341 | **初版漏列** |
| `tests/test_voice_call_client.py` | 419 | **初版漏列** |
| `tests/test_voice_call_api.py` | 203 | **初版漏列** |
| `tests/test_voice_live_projection.py` | 320 | **初版漏列** |

### 13.2 片段删除与重写

| 对象 | 范围 | 说明 |
|---|---|---|
| `services.py` | 删 82–1216（**1135 行**，初版估 1000 偏低） | 保留 1–81（含 `ProfileNotConfigured` 等异常类）与 1247–1278 |
| `tests/test_inject.py` | 重写 | 只保留「非爱莉会话不 inject / 爱莉本人不入站」语义，其余随旧 inject 删除 |

### 13.3 必须同步修改的连带对象（初版完全漏列）

| # | 对象 | 为什么必须同批改 |
|---|---|---|
| B1 | `apps/elysia_bridge/apps.py:9-13` | `ready()` 里 `from ...inline import start_bridge_thread`。删 `inline.py` 后 **`django.setup()` 阶段 ModuleNotFoundError，后端起不来**，`manage.py check` 也挂 |
| B2 | `config/asgi.py` | `start_inline_bridge` / `stop_inline_bridge` 两个调用点 + lifespan 包装，恢复标准路由 |
| B3 | `views.py:25` | **模块级** `from .services import ProfileNotConfigured`。services.py 骨架若删掉该异常类，URLconf 直接挂 |
| B4 | `serializers.py:17` | **模块级** `from .models import generate_elysia_stream_id`。**该函数不能删**，否则 URLconf 挂 |
| B5 | `views.py` 的 `ElysiaVoiceCall*` 5 个视图 + 3 个 helper（141–306） | 语音编排端点 |
| B6 | `apps/elysia_bridge/urls.py` 的 5 条 `voice-calls/` 路由（17–42） | 同上 |
| B7 | `apps/chat/consumers.py` 的 `elysia_voice` 组 + 2 个 handler（150、179、615–624） | 语音 observer 广播接收端 |
| B8 | `settings.VOICE_OBSERVER_ENABLED`（settings.py:282） | 生产 `.env:65` 为 `true`，删代码后成为死配置 |
| B9 | `settings.ELYSIA_BASE_URL / ELYSIA_CREDENTIAL_FILE / ELYSIA_SSE_* / ELYSIA_BRIDGE_INLINE` | 其中 `ELYSIA_SSE_RECONNECT_SECONDS` / `ELYSIA_SSE_EVENT_TYPES` **早就是死配置**（定义但全仓无读取） |
| B10 | `settings_test.py:34` | `ELYSIA_BRIDGE_INLINE` 测试开关 |
| B11 | `pyproject.toml` 的 `websockets` 依赖 | 唯一使用者是 `voice_observer.py:151` |
| B12 | `apps/chat/tests/test_friend_private_send.py:14,32,140` | **保留目录里的字段消费者**，传 `stream_id=generate_elysia_stream_id(...)`。初版与 D-2 都未提 |

### 13.4 字段删除的前提（初版判断错误）

`ElysiaProfile.stream_id / platform / chat_type` **不是「无消费者」**：后端有 3 处消费者（`serializers.py:33-35,44,47`、`views.py:69-70,137`）+ 2 个测试文件。可删，但必须同步改这些位置。

**数据前提也不成立**：初版写「表内 0 行」——生产库确实 0 行且迁移到 `0003`，但**本地开发库 `ayla.elysia_profiles` 有 1 行**（id=1, platform=ayla, chat_type=private）。`stream_id` 是 `unique` + 非空 + 无 default，`0004` 回退大概率失败（审计标注为推断，未实测）。

### 13.5 验收口径修正

初版写「全仓 grep 旧符号为零」——**不可达**，历史文档与记忆必然命中（`Ayla/docs/plans/阶段四-M4-4…`、`README.md`、`.workbuddy/memory/`）。

正确口径：**`Ayla/backend/{apps,config,tests}/` 下的 `*.py` 零命中**。

### 13.6 保留（已按实际执行回填）

- `ElysiaProfile`（`user`/`enabled`/`display_name`/`created_at`）
- `services.py` 的异常类骨架 `BridgeError` / `ProfileNotConfigured` 与 `broadcast_elysia_profile_updated`（共 63 行）
- `views.py` 的 profile 管理端点（语义改为探测通道连通性）

> **`models.generate_elysia_stream_id` 已删除**，与本节初版写的「B4 依赖，不得删」不符。
> 原因：初版的约束前提是 `serializers.py:17` 存在模块级 import；D-2 把那个 import
> 一并移除后，全仓消费者归零，留着就是死代码。删除时算法内联进迁移 0004 的
> `_derive_stream_id`，回滚仍可确定性重建。见 §14-R10 的更正。
>
> 实测验证：删除后 `manage.py check` 通过、URLconf 正常加载、
> `serializers.py` 不再引用该符号。

> 主动授权：**遇到旧时代遗留的废弃代码直接删除**，不为其写兼容层或迁移路径。但删除必须遵守 13.3 的连带修改清单——**先改 import 点，再删被 import 的文件**，每步之后跑一次 `manage.py check`。

## 14. 风险与取舍

| # | 取舍 | 理由 | 后果 |
|---|---|---|---|
| R1 | DSH 主动连，一条 WS 双向 | 同 QQ 形态，DSH 不开端口、不暴露公网 | Ayla 必须新增一个 consumer；DSH 侧要写重连 |
| R2 | 插件零仓库依赖 → 双形态 | 满足「任意 dsh 可装」 | 多一条代码路径，两形态各自验收 |
| R3 | 用爱莉自己的账号 JWT | 复用 Ayla 现有鉴权，不新增认证方式 | 插件凭据等于她的完整权限（可加好友、改资料）。本轮接受，后续可在 Ayla 侧加 scope 收紧 |
| R4 | standalone 自建 `ayla-channel` 一条 | 装完即用，不依赖宿主已配 preset | 所有 Ayla 会话共享上下文，靠 `conversation` 区分回谁 |
| R5 | 不写提示词，靠工作区 `AGENTS.md` | 避免重复实现 standing prompt | 用户要自定义人格得改工作区文件 |
| R6 | 图片走 `media_id` + 签名 URL，不走 base64 | 帧小、不阻塞心跳、复用 Ayla 媒体鉴权 | DSH 要多次 HTTP 往返 |
| R7 | 出站不重试 | 与 `send_text` 契约一致，避免重复发送 | 网络抖动会丢该段；由她看到失败自行决定是否重发 |
| R8 | 删除旧桥接全部代码 | 协议已不存在，保留只会误导 | 语音/直播需在下一期从头设计 |
| R9 | 按审计结果而非初版清单执行删除 | 初版 5 处事实错误，3 处会导致后端无法启动或全站 500 | 删除顺序被约束为「先改 import 点、再删文件」，每步 `manage.py check` |
| R10 | ~~`generate_elysia_stream_id` 保留不删~~ → **已更正为删除** | 初版理由（`serializers.py:17` 模块级 import）在 D-2 移除该 import 后不再成立；全仓消费者归零 | 算法内联进迁移 0004 供回滚；实测 check 通过、URLconf 正常 |

## 15. 实现后需回填

- `docs/architecture.md`：§3 目标链路、§4 边界表、§5 状态表「入站 Ayla」一行、§9 工具面。
- `plugins/ayla-app/README.zh.md`：安装、设置项、两种形态、排障。
- 本文 §7 的帧定义：以实际实现为准回填。
