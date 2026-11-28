# @elysia/context-gate

> 状态：当前启用。本文是上下文事件面板的正式文档；包级快速说明见
> [`plugins/context-gate/README.md`](../../plugins/context-gate/README.md)。

## 1. 身份

| 项 | 值 |
|---|---|
| 显示名 | Elysia/Context-Gate（爱莉希雅 · 门扉） |
| 包名 | `@elysia/context-gate` |
| 插件 id | `context-gate` |
| 目录 | `plugins/context-gate/` |
| Host + Web | 是 |
| 角色 | 上下文事件 manager |
| 管理插件 | 自身 |
| standalone | 作为 manager 独立可用；不显示 manage 开关 |

## 2. 职责

- 注册上下文事件 kind；
- 标准化通用事件 envelope（source/origin/params/content/causation）；
- 维护每会话订阅，所有 kind 支持多个会话同时订阅；
- 按订阅和发布可见性路由事件；
- 持久化 per-session 队列；
- TTL、dedupe、按 kind 背压；
- `agent/pre-step` 合并注入，保留已准入的 content blocks；
- 静默窗口和唤醒策略；
- 注入日志；
- 为支持 standalone 的事件源提供 manager 能力。

## 3. 非职责

- 不管理工具面（VillV-Helix）；
- 不管理预设（Mobius-Infinity）；
- 不创建或切换 Session；
- 不实现 Channel-IM、Ayla-Channel、Session-Communication、Event-Scripts；
- 不拦截原生 `tool/result`、subagent、Schedule 或 turn；
- 不提供健康/status 计数；
- 不要求源插件暴露 source 过滤；能不能收到由源插件决定。

## 4. 数据模型

```text
EventEnvelope
  id
  kind
  source
  origin { plugin, instance?, sessionId?, channel?, conversation? }
  summary
  params
  payload（兼容别名）
  content: ContentBlock[]
  visibility
  active
  dedupeKey
  ttlMs / maxBytes
  causationId
  createdAt
```

订阅是：

```text
订阅 = (subscriberSession, kind)
```

- 所有 kind 都允许多个会话同时订阅，不做单订阅者优化；
- `source` 只用于显示、日志、去重和因果，不做通用过滤；
- `origin` 只做来源元数据，不改变投递目标；
- panel 不能用订阅绕过源插件的可见性/准入决定。

## 5. 注入

```text
publish
  → 只接受源插件已经允许发布的事件
  → 标准化 origin/params/content/causationId
  → 按订阅和可见性进入 per-session 队列
  → TTL/dedupe（kind + source 作用域）/按 kind 背压
  → active：静默窗口 batchMs
  → passive：等下一 step
  → agent/pre-step 合并快照，附加已准入 content 块
```

默认：

```text
batchMs   = 1200
maxWaitMs = 5000
```

Agent 忙时不强行开第二轮；事件等待 pre-step 或 idle 再唤醒。

## 6. 当前视图

```text
事件
  kind 列表、中文名、说明、TTL、backlog、订阅状态

日志
  published / delivered / consumed / failed / dropped（带 kind/source/origin）
```

没有工具页、没有预设页、没有健康页。

## 7. 状态

```text
stateDir = dshHomePath('context-gate')
file     = context-gate-state.json
```

文档包含：

```text
sessions:
  contexts
  events（日志行带 eventId/source/origin/causationId）
queues:
  events（含 origin/params/content/causationId）
  consumed
  dedupe（kind + source 作用域）
updatedAt
```

新字段可选，旧版 `payload` 文档无需版本升级即可读取。

`list` 与 `setContext` 仍要求 live Agent；发布仍可为文档中已订阅的持久会话排队。

与 `villv-helix-state.json` 分离；不读取 Helix 状态。

## 8. standalone / managed

Context-Gate 是 manager，不是 standalone 源：

```text
它自己始终拥有订阅、队列和注入。
它不显示 manage 开关。
源插件在它存在时可以选择 managed；它不存在时源插件应独立运行。
```

## 9. 与其他插件的关系

| 插件 | 关系 |
|---|---|
| VillV-Helix | 无直接依赖；工具面与上下文事件分离 |
| Mobius-Infinity | 无直接依赖 |
| Channel-IM / Ayla-Channel | 作为它们的 manager |
| Session-Communication | 管理 turn 订阅；不接管 `session_send` 定向工具 |
| Event-Scripts | 管理脚本事件；不执行脚本本身 |

## 10. 权限与安全

- 外部消息是 untrusted input；注入时保留 source/origin 来源标签；
- 源插件负责“哪些事件可以发布”和内容准入，panel 负责“谁订阅了”；
- visibility 不能被订阅扩大；
- `params` 与 `content` 合计有大小上限；
- 关闭/卸载源插件后，相关 kind 从 UI 消失；
- 所有监听器、timer、Remote 都在 effect 内。

## 11. 测试

```powershell
cd plugins/context-gate
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

覆盖：

- kind 注册与注销；
- 通用 envelope：origin/params/content/causation 与旧 `payload` 兼容；
- 多会话订阅与 source 不过滤；
- 订阅/visibility；
- 队列、按 kind 的 dedupe 与 backpressure、TTL；
- pre-step 合并注入（含 content blocks）；
- 静默窗口与 maxWait；
- 忙 Agent 不开第二轮；
- 卸载清理；
- 事件/日志视图。

## 12. 相关文档

- [Context Gate 设计](../architecture/elyh-context-gate.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)
- [插件文档索引](README.md)