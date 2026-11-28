# ElyH Context Gate

> 状态：2026-11-28。`@elysia/context-gate` 是 ElyH 的通用上下文事件 manager：
> kind 注册、会话订阅、持久队列、TTL/dedupe/背压、批处理与注入。
> 它独立于 Helix 的工具编辑模式，也不再拥有健康统计。
>
> 架构总览见 [ElyH 扩展能力架构](../architecture.md)。
> 包内实现见 [`plugins/context-gate/README.md`](../../plugins/context-gate/README.md)。
> 每插件契约见 [插件文档索引](../plugins/README.md)。

## 1. 职责边界

Context Gate 只处理模型可见上下文事件：

```text
Provider → kind 注册 → publish(ContextEventInput)
Session → 订阅 (session, kind)
Gate → per-session 队列 → TTL / dedupe / 背压
Agent 下一 step → 合并快照注入
```

它不处理：

- 工具注册与工具面；
- 会话创建与工具限制；
- 渠道消息本身；
- 外发发送；
- 原生 Schedule 拦截；
- 健康统计。

工具面由 `@elysia/villv-helix` 管理；预设由 `@elysia/mobius-infinity` 管理。

## 2. 模型

### 通用事件 envelope

源插件负责触发事件、决定哪些事件可以发布，并提供 `params` 和已准入的
`content`。Context Gate 负责把事件标准化、路由到订阅会话、排队和注入。

```ts
interface ContextEventInput {
  id?: string
  kind: string
  source: string
  origin?: {
    plugin: string
    instance?: string
    sessionId?: string
    channel?: string
    conversation?: string
  }
  summary: string
  params?: unknown
  content?: ContentBlock[]
  visibility?: ContextVisibility
  active?: boolean
  dedupeKey?: string
  ttlMs?: number
  maxBytes?: number
  causationId?: string
  createdAt?: number
}
```

- `source` 是兼容现有调用方的 producer id；
- `origin` 是可选的来源元数据（插件、实例、来源会话、渠道、会话 id）；
- `params` 是结构化 JSON 体，旧 `payload` 继续作为兼容别名接受；
- `content` 是源插件已经准入的 `ContentBlock[]`，Gate 只做 JSON/大小校验，
  不重新过滤或改写；
- `causationId` 记录因果链；
- `source` / `origin` / `causationId` 只参与日志、去重和因果，不参与路由过滤。

### Context Kind

Provider 注册：

```text
kind       <plugin>.<event>
nameZh     必填中文名
description 一行说明
ttlMs      默认过期时间
maxBytes   单条上限
maxQueueDepth 队列上限
```

### 订阅

```text
Session × kind → subscribed / not subscribed
```

每个 session 有自己的订阅和队列，不按预设叠加。所有 kind 都允许多个
session 同时订阅；订阅只有 `(subscriberSession, kind)`，没有通用 source
selector，也不按 source 过滤。

### 发布与可见性

- Provider 发布事件时可收窄 `visibility.sessionIds`；
- 可见性不能绕过订阅；
- 发布事件进入所有已订阅、可见的 session 队列；
- 重复 `dedupeKey` 按 kind + source 作用域在 TTL 内抑制；
- 每个 kind 单独计数队列深度；超上限时淘汰该 kind 最旧事件并记录 dropped，
  不影响同会话的其他 kind。

## 3. 注入

Agent 的 `agent/pre-step` 是唯一注入点：

```text
queue
  → 取当前会话的事件
  → 按 TTL 清理
  → 合并为一条 user/message 快照
  → 附加到本 step
```

- passive 事件只等待下一 step，不唤醒 Agent；
- active 事件可以唤醒空闲 Agent；
- 同一 step 的多条事件合并为一条 `user/message`，不重复发送；
- 每条事件的 `summary` 与 `params` 进入文本段，已准入的 `content` 块按发布
  顺序附加在同一消息中；
- 注入后队列消费并记录 consumed 日志；
- 注入失败不消费，保留到下一次重试。

## 4. 唤醒批处理

当前实现：

```text
第一个 active 事件 → 开一个静默窗口
窗口内后续 active 事件 → 合并
batchMs 到期 → 最多打开一个 follow-up turn
maxWaitMs → 强制上限，避免无限推迟
Agent 忙 → 不开第二轮，排队等 pre-step / idle
Agent 空闲 → 到期后唤醒
```

默认：

```text
batchMs   = 1200 ms
maxWaitMs = 5000 ms
```

这是上下文事件的门；未来渠道消息/内部消息的入口缓冲可以复用同样的语义，但当前没有接入这些 source。

## 5. 作为管理插件

Context Gate 是以下源插件的 manager：

```text
Channel-IM
Ayla-Channel
Session-Communication（turn 订阅）
Event-Scripts
```

这些源插件在 Context Gate 挂载时才会出现 manage 开关；默认仍是 standalone。
Context Gate 自身不显示 manage 开关，也不实现 Channel-IM、Ayla-Channel、
Session-Communication 或 Event-Scripts 的发送、工具和脚本逻辑。

## 6. 与工具编辑模式无关

Context Gate 不读取 Helix 的 `orchestrated` 状态。

- 工具编辑模式关闭：上下文事件订阅和注入照常工作；
- 工具编辑模式开启：同样工作；
- Context Gate 和 Helix 可以独立挂载：
  - 只有 Context Gate；
  - 只有 Helix；
  - 两者都有。

## 7. UI

Context Gate 注册两个原生 Conversation view：

```text
事件 — kind 列表、订阅开关、TTL、积压
日志 — 发布/投递/消费/失败/丢弃记录（含 kind/source/origin）
```

没有健康页、没有工具页、没有预设页。

## 8. 状态

```text
stateDir = dshHomePath('context-gate')
file     = context-gate-state.json
```

文档包含：

```text
sessions: contexts + events（日志行带 eventId/source/origin/causationId）
queues: events（含 origin/params/content/causationId） + consumed + dedupe
updatedAt
```

新字段全部可选，旧版 `payload` 文档无需版本升级即可读取；下一次写入会按当前
字段重新序列化。

与 `villv-helix-state.json` 分离；不读取 Helix 文档，不做跨包迁移。

## 9. 当前未做

- Channel-IM / Ayla-Channel 的渠道接入与发送；
- Session-Communication 的 turn 订阅与 `session_*` 工具；
- Event-Scripts 的脚本宿主与触发器；
- 原生 Schedule 拦截；
- 健康统计（按本次要求已删除）。

这些是后续 Infrastructure 工作，不应再塞回 Helix 或 Context Gate 的工具面。
Context Gate 只为这些源插件提供 manager 能力：kind 注册、订阅、队列和注入。