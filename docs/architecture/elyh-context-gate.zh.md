# ElyH Context Gate

> 状态：2026-11-26。`@elysia/context-gate` 从 VillV-Helix 拆出，负责上下文事件订阅、队列和注入日志。
> 它独立于 Helix 的工具编辑模式，也不再拥有健康统计。
>
> 架构总览见 [ElyH 扩展能力架构](../architecture.md)。
> 包内实现见 [`plugins/context-gate/README.md`](../../plugins/context-gate/README.md)。

## 1. 职责边界

Context Gate 只处理模型可见上下文事件：

```text
Provider → kind 注册 → publish
Session → 订阅
Gate → per-session 队列 → TTL / dedupe / 背压
Agent 下一 step → 合并快照注入
```

它不处理：

- 工具注册与工具面；
- 会话创建与工具限制；
- 渠道消息本身；
- 外发发送；
- 健康统计。

工具面由 `@elysia/villv-helix` 管理；预设由 `@elysia/mobius-infinity` 管理。

## 2. 模型

### Context Kind

Provider 注册：

```text
kind       <plugin>.<event>
nameZh     必填中文名
description 一行说明
ttlMs      默认过期时间
maxBytes   单条上限
queueDepth 队列上限
```

### 订阅

```text
Session × kind → subscribed / not subscribed
```

每个 session 有自己的订阅和队列，不按预设叠加。

### 发布与可见性

- Provider 发布事件时可收窄 `visibility.sessionIds`；
- 可见性不能绕过订阅；
- 发布事件进入所有已订阅、可见的 session 队列；
- 重复 `dedupeKey` 在 TTL 内抑制；
- 超队列上限时淘汰最旧事件并记录 dropped。

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
- 同一 step 的多条事件合并，不重复发送；
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

## 5. 与工具编辑模式无关

Context Gate 不读取 Helix 的 `orchestrated` 状态。

- 工具编辑模式关闭：上下文事件订阅和注入照常工作；
- 工具编辑模式开启：同样工作；
- Context Gate 和 Helix 可以独立挂载：
  - 只有 Context Gate；
  - 只有 Helix；
  - 两者都有。

## 6. UI

Context Gate 注册两个原生 Conversation view：

```text
事件 — kind 列表、订阅开关、TTL、积压
日志 — 发布/投递/消费/失败/丢弃记录
```

没有健康页、没有工具页、没有预设页。

## 7. 状态

```text
stateDir = dshHomePath('context-gate')
file     = context-gate-state.json
```

文档包含：

```text
sessions: contexts + events
queues: events + consumed + dedupe
updatedAt
```

与 `villv-helix-state.json` 分离；不读取 Helix 文档，不做跨包迁移。

## 8. 当前未做

- 渠道消息 / 内部消息的通用入站缓冲；
- 统一的 ContextGate 入口 API（当前只有 kind publish）；
- 将消息源接入 Context Gate；
- Agent 创建上下文事件的工具；
- 健康统计（按本次要求已删除）。

这些是后续 Infrastructure 工作，不应再塞回 Helix 或 Context Gate 的工具面。