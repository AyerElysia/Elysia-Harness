# ElyH 扩展组件架构

> 状态：2026-11-26。本文是 [ElyH 扩展能力架构](../architecture.md) 的组件展开。
> 旧的 `capability-core` / `capability-panel` / “主意识插件 / 潜意识插件”设计已归档，不再代表当前实现。

![ElyH 扩展组件架构](elyh-plugin-architecture.png)

## 1. 组件分层

```text
外部世界
  QQ / KOOK / 飞书 / Ayla / 语音 / 直播 / Web UI
        │
        ▼
Event Adapter
  Event Source / Event Consumer / Context Provider
        │
        ▼
DSH 基础层
  Agent / Session / Tool Registry / Context Injector / Lifecycle Events
        │
        ├───────────────┐
        ▼               ▼
Tool Provider       Context Provider
        │               │
        ▼               ▼
Service / Transport  Model-visible Context
  sender / TTS / ASR / store / index
        │
        ▼
外部平台 / 存储 / UI
```

DSH 原生工具位于 Tool Registry 内，但在本架构中只作为**依赖**出现，不逐项列出。

## 2. 当前运行组件

### `@elysia/villv-helix`

- **职责**：会话级工具面、门禁、工具面板
- **不是**：工具提供者、会话创建者、主意识插件
- **会做**：
  - 读取当前 Agent 的实际工具定义；
  - 区分静态工具 / 动态扩展工具；
  - 对官方预设静态工具锁定；
  - 对自定义预设静态工具做执行门禁；
  - 对 Helix 挂载的扩展工具做启用集合；
  - 未启用时保留 schema，执行返回 `UNKNOWN_TOOL`；
  - 提供工具面板与工具编辑模式胶囊。
- **不会做**：
  - 注册 `send_text`、`send_voice`、`session_*` 等业务工具；
  - 管理预设创建；
  - 管理上下文事件订阅/队列/注入日志（已拆到 Context Gate）；
  - 创建或切换 Session；
  - 用私有布尔值代替宿主工具状态。

### `@elysia/context-gate`

- **职责**：上下文事件 kind、通用 envelope（origin/params/content/causation）、session 订阅、持久队列、TTL/dedupe/按 kind 背压、下一 step 注入、注入日志
- **模型工具**：无
- **Remote**：`contextGate/list`、`contextGate/setContext`
- **不是**：工具面、预设、Session 创建者、健康面板
- **边界**：独立于 Helix 和工具编辑模式；作为 Channel-IM、Ayla-Channel、Session-Communication、Event-Scripts 的 manager，但不实现这些源插件。

详见 [Context Gate](elyh-context-gate.zh.md)。

### `@elysia/mobius-infinity`

- **职责**：预设组合、提示词文件、工具组、预设 UI
- **模型工具**：`preset_list`、`preset_create`
- **不是**：Session 编排器；不创建或切换 Session
- **组合内容**：
  - prompt files；
  - 原生 time-context；
  - 所选工具组；
  - 固定 compaction 组。
- **边界**：预设内工具由预设组合拥有；Helix 只处理当前会话的工具面，不改写预设定义。

### 第三方扩展

插件市场、ModSearch、技能中心、远程 UI、文件/浏览器/电脑操作等由 profile 独立挂载。它们可以提供工具、上下文、UI 或 MCP 连接，但不属于 ElyH 核心扩展架构。

### 管理插件与 standalone

ElyH 的事件源插件可以有两种运行方式：

```text
standalone：自己保存订阅、队列和注入
managed：只触发/发布，订阅和注入交给管理插件
```

对应关系：

| 源插件 | 管理插件 | manage 开关 |
|---|---|---|
| Channel-IM | Context-Gate | 有 Context-Gate 才出现 |
| Ayla-Channel | Context-Gate | 有 Context-Gate 才出现 |
| Session-Communication | Context-Gate | 有 Context-Gate 才出现；`session_send` 定向语义不变 |
| Event-Scripts | Context-Gate | 有 Context-Gate 才出现 |

规则：

- 没有管理插件时强制 standalone，不显示 manage 开关；
- 有管理插件时，默认仍是 standalone，显式打开才 managed；
- 管理插件消失时，managed 进入 unavailable，不自动 fallback；
- `VillV-Helix` 和 `Mobius-Infinity` 是管理者，不是 standalone 源，没有 manage 开关。

完整的每插件契约见 [插件文档索引](../plugins/README.md)。

## 3. 扩展包的形状

| 形状 | 作用 | 典型内容 |
|---|---|---|
| Tool Provider | 提供模型可调用工具 | `send_text`、`session_send`、`memory_*` |
| Event Source | 把外部事件接入宿主 | 渠道入站、直播事件、实时音频 |
| Event Consumer | 监听 DSH 生命周期 | `session/event` 观察、`llm/stream` 归档 |
| Context Provider | 注入模型可见上下文 | 入站摘要、记忆、运行环境 |
| Service | 为工具/事件提供底层能力 | sender、TTS、ASR、SQLite、索引 |
| Policy / Gate | 控制可见性与执行 | 工具面、确认、权限、压缩策略 |
| UI | 浏览器面板或页面 | 能力面板、预设管理、请求查看器 |
| Orchestration | 组合和调度扩展 | Helix 工具面、Context Gate 队列、Mobius 预设 |

一个包可以同时承担多项，但文档必须把它写成“提供哪些扩展点”，不能写成“某个意识的插件”。

## 4. 工具面

### 官方预设静态工具

```text
preset plugin row
  → tool-fs / tool-pwsh / ...
  → tool definition at preset/agent scope
  → Helix origin: static, locked: true
```

Helix 只读显示，`setTool` 拒绝。不能通过 `tools.restrict()` 移除预设自身注册的工具。

### 自定义预设静态工具

```text
preset plugin row
  → same tool id present in agent scope
  → Helix does not register a duplicate
  → tools/pre-execute checks session enabled set
  → disabled: schema remains, execution = UNKNOWN_TOOL
  → enabled: preset implementation executes
```

这样避免同名注册失败，也保留“关掉后名字还在，但调用失败”的语义。

### Helix 挂载的扩展工具

```text
Helix mounts managed suite in session context
  → stable tool declarations
  → execution gate reads enabled set
  → disabled: UNKNOWN_TOOL
```

工具声明在会话生命周期内保持稳定；不会因为用户关闭而消失。

## 5. Event Adapter

### 入站渠道

```text
QQ / KOOK / 飞书 / Ayla
  → Event Source
  → attach sender / conversation / attachment metadata
  → DSH Agent turn / pending queue
```

渠道插件不创建主 session，不拥有 Agent 生命周期。

### Session 观察

```text
session/event
  → Observation consumer
  → bounded batch / durable store
  → optional Router or memory session
```

这是可选能力域；当前未挂载。

### 请求归档

```text
llm/stream
  → request archive hook
  → immutable JSON + per-session index
  → context inspector UI
```

归档失败应阻断该次模型调用，不静默跳过。

### Context Provider

```text
external state / memory / runtime
  → Context Gate publish
  → session subscription
  → durable queue + TTL/dedupe/backpressure
  → merged snapshot on agent/pre-step
```

Context Gate 只处理模型可见上下文，不是 DSH 的全部事件系统。它独立于 Helix 和工具编辑模式；active 事件在空闲 Agent 上走 `batchMs` 静默窗口，最多等 `maxWaitMs`，忙时只排队等待下一个 pre-step。

## 6. 控制流

### 渠道收发

```text
入站事件
  → Event Adapter
  → DSH Agent / Session
  → send_text Tool Provider
  → Channel Sender Service
  → 外部平台
```

### 工具开关

```text
UI / Helix state
  → setTool
  → session enabled set
  → tools/restrict (global tools)
  → tools/pre-execute (static custom + managed)
  → schema lookup / execution
```

### 上下文注入

```text
Provider publish
  → Context Gate queue
  → subscribed session
  → merged snapshot
  → agent/pre-step
  → model request
```

## 7. 状态与边界

| 状态 | 含义 |
|---|---|
| 当前启用 | `villv-helix`（工具）、`context-gate`（上下文）、`mobius-infinity`（预设）、profile 第三方包 |
| 目标能力 | 渠道消息、会话通信、语音媒体、可观测 |
| 可选能力 | 感知 / 记忆 |
| 已归档 | 旧 conscious-mind、subconscious、渠道、语音、直播、归档插件 |

## 8. 相关图

- [插件文档索引](../plugins/README.md)
- [插件架构图](elyh-plugin-architecture.html)
- [能力关系图](elyh-capability-relationships.html)
- [用例图](elyh-usecase.html)
- [数据流图](elyh-dataflow.html)