# ElyH Context Gate

> 状态：2026-11-28。`@elysia/context-gate` 是 ElyH 的上下文事件平台：
> 事件注册、会话订阅、持久队列、TTL/dedupe/背压、批处理与注入，以及
> 每会话时间事件和自定义事件规则。
>
> `Event-Scripts` 已合并进本插件，不再是独立包。
> 架构总览见 [ElyH 扩展能力架构](../architecture.md)。
> 包内实现见 [`plugins/context-gate/README.md`](../../plugins/context-gate/README.md)。
> 每插件契约见 [`docs/plugins/context-gate.zh.md`](../plugins/context-gate.zh.md)。

## 1. 三层事件模型

```text
第一层：独立源插件
  Channel-IM / Ayla-Channel / Session-Communication
  → registerKind + publish
  → 多会话订阅

第二层：ContextGate 自定义事件
  模板 / 脚本 / 内部和外部触发器
  → 生成可订阅事件

第三层：ContextGate 时间事件
  timer / timer preset / absence
  → 注入 owner 会话
  → 不订阅
```

第一、二层是触发式事件；第三层是时间式事件。
ContextGate 同时承载第二、三层，源插件仍是独立包。

## 2. 事件模型

### Envelope

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
  content?: readonly ContentBlock[]
  visibility?: { sessionIds?: readonly string[] }
  active?: boolean
  dedupeKey?: string
  ttlMs?: number
  maxBytes?: number
  causationId?: string
  createdAt?: number
}
```

- `source` / `origin` 只做显示、去重和因果元数据；
- 普通事件不做通用 source 过滤；
- `visibility` 只能收窄目标；
- `content` 必须由源插件准入；
- 旧 `payload` 仍作为 `params` 的兼容别名。

### Kind

```ts
interface ContextKindRegistration {
  kind: string
  nameZh: string
  description: string
  activeByDefault?: boolean
  ttlMs?: number
  maxBytes?: number
  maxQueueDepth?: number
  parameters?: readonly EventParameterSchema[]
}
```

`parameters` 允许源插件声明自定义订阅参数：

```text
session[] | source[] | enum | boolean | number | string
multiple
allowAll
allowFuture
optionsProvider
```

面板渲染并保存参数，源插件负责解释。
ContextGate 不重新实现源插件的消息准入。

## 3. 订阅与路由

```text
订阅 = (subscriberSession, kind, params)
```

- 所有第一、二层事件都支持多会话订阅；
- 可以选多个来源会话；
- 可以选来源客户端；
- 可以选全部当前会话；
- 可以选未来新会话自动订阅；
- 时间事件不走订阅，直接注入 owner。

订阅策略需要持久化：

```text
SubscriptionRule
  kind
  params
  target:
    explicitSessionIds
    allCurrent
    allFuture
    sourceFilter?
  enabled
```

新会话创建时，匹配 `allFuture` 的规则自动注册订阅。

## 4. 队列与注入

```text
publish
  → 按订阅和 visibility 路由
  → per-session 队列
  → TTL / dedupe / 按 kind 背压
  → active：静默窗口 batchMs
  → passive：等下一 step
  → agent/pre-step 合并快照注入
```

默认：

```text
batchMs   = 1200 ms
maxWaitMs = 5000 ms
```

Agent 忙时不强行开第二轮；事件等待 pre-step 或 idle。

## 5. 时间引擎

ContextGate 自己实现时间引擎，不依赖 DSH 原生 Schedule。

```text
once       绝对时间
after      相对时间
rrule      任意重复
absence    某类事件一段时间未发生
```

- RRULE / 时区使用通用库；
- 支持到秒；
- 每个 timer 有 owner session；
- 同一会话可有多个 timer；
- timer 到期只注入 owner；
- timer 不注册为可订阅 kind；
- 秒级 timer 有频率、数量、合并和过期保护；
- 重启后重建 nextDue；
- 错过多轮只补一次。

### TimerPreset

```text
preset 是模板
其他会话采用 → 创建自己的 TimerInstance
每个实例独立 nextDue / 状态 / 暂停
不 fan-out
修改 preset 不自动改已采用实例
```

### Absence

```text
AbsenceTimer
  ownerSessionId
  kinds[]
  quietMs
  lastSeenAt
  fired
```

- 全局记录每个 kind 的 `lastSeenAt`；
- 不看 owner 是否订阅该 kind；
- 只要事件发布到 ContextGate 就更新；
- 超过 quietMs 触发一次，注入 owner；
- 下一次该 kind 事件到来才重新武装；
- timer 事件默认不计入 absence；
- 重启后按 lastSeen 计算剩余时间。

### 原生 Schedule

```text
不使用原生 DSH Schedule
不导入它的 scheduler
不把原生任务列进面板
不拦截它的 delivery
```

ContextGate timer 是 ElyH 唯一时间事件来源。

## 6. 自定义事件引擎

合并 Event-Scripts 后，ContextGate 负责：

```text
EventRule
  id
  ownerSessionId
  trigger
  where[]
  contentTemplate
  wake
  visibility
  cooldownMs
  maxFires
  expiresAt
```

触发源：

```text
time        at / after / rrule / absence
internal    session/event / tool/call / tool/result / turn / job / subagent
external    http-poll / webhook
composite   all / any / not / sequence
```

- 声明式模板优先；
- 复杂条件使用隔离脚本；
- 生成的 `agent.script.<ruleId>` 事件才进入订阅；
- 原始内部事件不直接暴露给订阅者；
- 纯时间规则推荐使用 timer 工具，而不是 event rule；
- 第二层的时间条件复用同一个时间引擎。

## 7. 管理插件与 standalone

ContextGate 是 manager：

```text
Channel-IM
Ayla-Channel
Session-Communication（turn 订阅）
```

源插件在 ContextGate 挂载时才显示 manage 开关；默认仍 standalone。
ContextGate 自身不显示 manage 开关。
Event-Scripts 已合并，没有 standalone。

## 8. 视图

```text
事件 | 定时 | 日志
```

完整标签顺序：

```text
工具 | 预设 | 事件 | 定时 | 日志
```

工具编辑模式关闭：

```text
事件 | 定时 | 日志
```

| 视图 | 内容 |
|---|---|
| 事件 | 来源 kind、订阅、订阅参数、自定义事件规则 |
| 定时 | 当前会话 timer、timer preset、absence |
| 日志 | published / queued / delivered / consumed / failed / dropped |

`定时` 是独立视图，不并入 `事件`。

## 9. 状态

```text
stateDir = dshHomePath('context-gate')
file     = context-gate-state.json
```

```text
version
sessions:
  contexts
  subscriptions
  events
queues:
  events
  consumed
  dedupe
timers:
  instances
  presets
  absence
  lastSeenByKind
  nextDue
rules:
  definitions
  runtime
updatedAt
```

旧文档的 `payload` 读取兼容；新字段可选。
与 `villv-helix-state.json` 分离。

## 10. 当前未完成

当前 HEAD 的事件 envelope、订阅、队列、注入和日志已经存在。
本轮继续实现：

- timer engine；
- timer preset；
- absence；
- 自定义事件规则与脚本宿主；
- 订阅参数 schema 和未来会话订阅；
- `定时` 视图；
- manager 的 source 参数；
- 工具和测试。

## 11. 边界

ContextGate 不处理：

- 工具面与工具限制；
- 预设创建；
- Session 创建和切换；
- 渠道协议、附件下载和发送；
- turn delta 生成；
- `session_send` 的目标选择；
- 原生 Schedule。

这些分别属于 Helix、Mobius、Channel-IM、Ayla-Channel 和
Session-Communication。