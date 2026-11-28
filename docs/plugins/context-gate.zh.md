# @elysia/context-gate

> 状态：当前启用；事件 envelope、订阅、队列、注入和日志已存在。定时引擎与自定义事件脚本属于本轮落地目标。
>
> 本文是 ContextGate 的正式契约；包级快速说明见
> [`plugins/context-gate/README.md`](../../plugins/context-gate/README.md)。

## 1. 身份

| 项 | 值 |
|---|---|
| 显示名 | Elysia/Context-Gate（爱莉希雅 · 门扉） |
| 包名 | `@elysia/context-gate` |
| 插件 id | `context-gate` |
| 目录 | `plugins/context-gate/` |
| Host + Web | 是 |
| 角色 | 上下文事件 manager + 时间引擎 + 自定义事件引擎 |
| 管理插件 | 自身 |
| standalone | 作为 manager 独立可用；不显示 manage 开关 |

`Event-Scripts` 已合并进本插件，不再是独立包，也没有独立 standalone 模式。

## 2. 三层事件模型

```text
第一层：独立源插件
  Channel-IM / Ayla-Channel / Session-Communication
  → 注册 kind
  → 发布触发式事件
  → 多会话订阅

第二层：ContextGate 自定义事件
  模板 / 脚本 / 内部与外部触发器
  → 生成可订阅事件

第三层：ContextGate 时间事件
  当前会话 timer / timer preset / absence
  → 直接注入 owner
  → 不订阅
```

第一、二层是触发式事件；第三层是时间式事件。

## 3. 职责

- 注册事件 kind，强制中文名和说明；
- 维护每会话订阅；
- 支持订阅参数 schema，例如多选来源会话、来源客户端、全部、未来新会话；
- 持久化 per-session 队列；
- TTL、dedupe、按 kind 背压；
- `agent/pre-step` 合并注入，保留已准入 content；
- 静默窗口和唤醒策略；
- 注入日志；
- 作为 Channel-IM、Ayla-Channel、Session-Communication 的 manager；
- 内置时间引擎：相对/绝对/重复/秒级/absence；
- 内置 timer preset；
- 内置自定义事件引擎：声明式规则、标准模板、沙箱脚本、内部和外部触发器；
- 提供对应模型工具和 Web 面板。

## 4. 非职责

- 不管理工具面（VillV-Helix）；
- 不管理预设（Mobius-Infinity）；
- 不创建或切换 Session；
- 不实现渠道协议、session 通信传输和 turn delta 生成；
- 不实现原生 Schedule，也不拦截它的投递；
- 不提供健康/status 计数；
- 不要求源插件暴露通用 source 过滤；能不能发布由源插件决定；
- 不把 `session_send` 改成广播事件；
- 不让脚本直接改 ContextGate 或 DSH 内部状态。

## 5. 触发式事件

### 5.1 Envelope

```text
EventEnvelope
  id
  kind
  source
  origin { plugin, instance?, sessionId?, channel?, conversation? }
  summary
  params
  content: ContentBlock[]
  visibility
  active
  dedupeKey
  causationId
  createdAt
```

- `source` / `origin` 是显示、去重和因果元数据；
- 普通事件不做通用 source 过滤；
- `visibility` 只能收窄目标，不能被订阅扩大；
- `content` 必须由源插件准入；
- 旧 `payload` 作为 `params` 的兼容别名。

### 5.2 订阅

```text
订阅 = (subscriberSession, kind, params)
```

所有第一、二层事件都支持多会话订阅。
订阅可以由源插件声明参数 schema：

```text
EventParameterSchema
  key
  labelZh
  type: session | source | enum | boolean | number | string
  multiple
  allowAll
  allowFuture
  optionsProvider?
```

例如：

- 多选来源会话；
- 多选来源客户端；
- 选全部当前会话；
- 未来新会话自动订阅。

面板渲染参数并保存值，源插件解释参数；ContextGate 不重新实现来源插件的消息准入。

### 5.3 队列与注入

```text
publish
  → 按订阅和 visibility 路由
  → per-session 队列
  → TTL / dedupe / 背压
  → active：静默窗口 batchMs
  → passive：等下一 step
  → agent/pre-step 合并快照注入
```

默认：

```text
batchMs   = 1200
maxWaitMs = 5000
```

Agent 忙时不强行开第二轮；事件等待 pre-step 或 idle。

## 6. 时间引擎

ContextGate 自己实现时间引擎，不依赖 DSH 原生 Schedule。
重复规则使用通用 RRULE / 时区库，支持到秒。

### 6.1 TimerInstance

```text
id
ownerSessionId
presetId?
name
schedule:
  once at
  after
  rrule
content
wake
enabled
nextDueAt
lastFiredAt
```

- 创建在哪个会话，就属于哪个会话；
- 同一会话可有多个 timer；
- 到期只注入 owner；
- 不注册成可被其他会话订阅的 kind；
- 秒级最小 1 秒；
- 高频 timer 走 batch，不逐 tick 唤醒；
- 错过多轮只补一次；
- 重启后重建 nextDue。

### 6.2 TimerPreset

```text
TimerPreset = schedule / content 模板
```

- 其他会话“采用”preset 后生成自己的 TimerInstance；
- 每个实例独立 nextDue、状态、暂停；
- 同一 preset 被多个会话采用不会 fan-out；
- 修改 preset 不自动改已采用实例；
- 需要同步时显式“从 preset 更新”。

“采用 preset”不是事件订阅。

### 6.3 Absence

```text
AbsenceTimer
  ownerSessionId
  kinds[] | '*'
  quietMs
  lastSeenAt
  fired
```

- 全局记录每个 kind 的 lastSeen；
- 不看 owner 是否订阅该 kind；
- 只要事件**发布到 ContextGate**就更新 lastSeen；
- 超过 quietMs 触发一次，注入 owner；
- 触发后等该 kind 再次出现才重新武装；
- 重启后按 lastSeen 计算剩余等待；
- 长期安静后新建 timer，按创建时间与全局 lastSeen 计算；
- timer 事件默认不计入 absence，避免自触发。

### 6.4 时间预设与原生 Schedule

```text
原生 DSH Schedule：不使用、不导入、不拦截
ContextGate timer：唯一 ElyH 时间事件来源
```

不把原生 Schedule 任务列进面板，也不做 adapter。

## 7. 自定义事件引擎（合并 Event-Scripts）

### 7.1 定义

```text
EventRule
  id
  ownerSessionId
  name
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

第二层的时间条件复用 ContextGate 时间引擎；第三层的纯时间事件使用 timer 工具。

### 7.2 脚本

- 声明式模板优先；
- 复杂条件才使用脚本；
- 脚本隔离执行，不把 Node `vm` 当安全边界；
- 限制网络域名、文件路径、CPU、内存、运行时长；
- 凭证使用 secret ref；
- 一个脚本失败不能带崩 ContextGate；
- 支持热加载；新增 native 依赖或扩展宿主能力仍可能需要重启。

### 7.3 生成事件

```text
kind: agent.script.<ruleId>
```

- 只有生成事件注册为可订阅 kind；
- 原始 `tool/call` 等内部事件不直接出现在面板；
- 生成事件允许多会话订阅，初始可见性由 owner 决定；
- 不允许规则消费自己生成的因果链，防自触发循环。

## 8. 视图

标签顺序：

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

`定时` 是独立标签，不塞进 `事件`。
ContextGate 不注册工具页、预设页或健康页。

## 9. 模型工具

时间：

```text
timer_create
timer_list
timer_update
timer_pause
timer_cancel
timer_preset_create
timer_preset_list
timer_preset_adopt
absence_create
absence_list
absence_update
absence_cancel
```

自定义事件：

```text
event_rule_create
event_rule_list
event_rule_update
event_rule_test
event_rule_pause
event_rule_resume
event_rule_cancel
```

工具说明必须写清：

```text
纯时间 → timer_*
复杂条件/脚本 → event_rule_*
```

可以合并成更少的工具，但必须保留这个语义分流。

## 10. 状态

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

旧版 `payload` 文档无需版本升级即可读取；新字段可选。

## 11. standalone / managed

ContextGate 是 manager，不是 standalone 源：

```text
它始终拥有自己的订阅、队列、注入、timer 和 rule engine
它不显示 manage 开关
```

支持 standalone 的源插件：

| 源插件 | 管理插件 | 说明 |
|---|---|---|
| Channel-IM | Context-Gate | 有 Context-Gate 才显示 manage 开关 |
| Ayla-Channel | Context-Gate | 有 Context-Gate 才显示 manage 开关 |
| Session-Communication | Context-Gate | 管理 turn 订阅；`session_send` 定向语义不变 |

Event-Scripts 不再有 standalone 或 manage 开关。

## 12. 权限与安全

- 源插件负责事件能否发布和内容准入；
- ContextGate 负责谁订阅了；
- visibility 不能被订阅扩大；
- 外部消息是 untrusted input；
- 订阅参数由源插件解释，不形成通用 source 过滤；
- 时间事件只注入 owner，不跨会话 fan-out；
- 脚本必须隔离和限权；
- 事件、timer、rule 和队列都有大小/数量上限；
- 所有监听器、timer、Remote 在 effect 内清理。

## 13. 失败与恢复

- 源插件卸载：kind 注销，相关订阅不投递；
- ContextGate 卸载：timer/rule 调度停止，状态保留；
- 重启：队列、timer nextDue、absence lastSeen、rule runtime 恢复；
- 时间规则错过多轮：只补一次；
- 脚本失败：记录错误并隔离，不影响其他 rule；
- Manager 消失：managed 源插件进入 unavailable，不自动 fallback；
- 不自动重发状态未知的消息。

## 14. 测试

```powershell
cd plugins/context-gate
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

覆盖：

- kind 注册/注销、envelope 和旧 payload 兼容；
- 多会话订阅、订阅参数、visibility；
- 队列、TTL、dedupe、背压；
- 批处理、静默窗口、忙/闲注入；
- timer：once/after/RRULE/seconds/timezone；
- timer preset 采用与独立实例；
- absence 全局 lastSeen、重启、重新武装；
- 自定义 rule 的模板、脚本、内部/外部触发、热加载；
- 防循环和资源限制；
- 标签顺序与工具编辑模式下的隐藏；
- 卸载清理。

## 15. 相关文档

- [Context Gate 架构](../architecture/elyh-context-gate.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)
- [插件文档索引](README.md)
- [Event-Scripts 合并说明](event-scripts.zh.md)