# @elysia/event-scripts

> 状态：规划。所有 Agent 自定义事件统一放在这个插件里，不为每个事件生成新的 DSH 插件。
>
> 本文定义目标契约，代码尚未实现。

## 1. 身份

| 项 | 值 |
|---|---|
| 包名 | `@elysia/event-scripts` |
| 插件 id | `event-scripts` |
| 目录 | `plugins/event-scripts/`（规划） |
| 角色 | Agent 自定义事件宿主 / Event Source |
| 管理插件 | `@elysia/context-gate` |
| standalone | 是 |
| manage 开关 | 仅当 Context-Gate 挂载时出现 |

## 2. 目标

解决：

```text
Agent 想订阅一个非常自由的事件
  → 不想为每个事件写新的 DSH 插件
  → 不想因此重启 DSH
  → 但仍需要持久化、测试、暂停、日志和订阅
```

提供：

```text
稳定的脚本宿主
  + 声明式触发模板
  + 热加载
  + 隔离脚本（高级）
  + 标准事件发布
```

## 3. 非职责

- 不替代 Context-Gate 的订阅/队列/注入；
- 不替代 Session-Communication 的 turn/session_send；
- 不替代原生 Schedule；
- 不允许任意脚本直接改 DSH 内部状态；
- 不让模型生成新的 DSH 插件并热挂载；
- 不把脚本代码写进 Context-Gate。

## 4. 两种模式

### managed

```text
脚本核心运行
  → 注册生成的事件 kind
  → publish 到 Context-Gate
  → 不保存订阅
  → 不自己注入
```

### standalone

```text
脚本核心运行
  → 自己保存订阅条目
  → 自己排队
  → 自己向目标会话注入
  → 不注册到 Context-Gate
```

### manage 开关

```text
Context-Gate 不存在：standalone，无开关
Context-Gate 存在：开关出现，默认 standalone
开启：脚本事件交给 Context-Gate 管理
```

manager 消失：managed 进入 unavailable；脚本定义保留，不自动降级。

## 5. 触发源

### 外部

```text
http-poll
webhook
外部服务事件（通过 source adapter）
```

### 内部

```text
session/event
tool/call
tool/result
turn/start
turn/end
step/start
step/end
job 完成
subagent 完成
team task 变化
```

内部事件只**观察**，不拦截、不修改、不延迟原生工具或 turn。

### 时间

```text
at
after
every
cron / calendar（若由事件脚本宿主实现）
absence（一段时间没有某事件）
```

原生 DSH Schedule 不进入本插件；它保持原生投递。
如果确实需要把原生 Schedule 的 due 交给 Context-Gate，需要上游 Schedule 的 pre-delivery hook，不能在本插件里硬拦。

## 6. 触发器模型

事件定义 = 触发源 + 条件 + 内容模板 + 限制。

```ts
type Trigger =
  | { type: 'external'; source: 'http-poll' | 'webhook'; where?: Condition }
  | { type: 'internal'; event: InternalEventKind; where?: Condition }
  | { type: 'timer'; at?: string; afterMs?: number; everyMs?: number }
  | { type: 'absence'; event: string; forMs: number }
  | { type: 'composite'; all?: Trigger[]; any?: Trigger[]; not?: Trigger }
```

条件使用受控字段，不允许一开始就执行任意 JS：

```text
equals
contains
prefix
oneOf
exists
olderThanMs
countAtLeast
```

高级模式才允许沙箱脚本。

## 7. 生成事件

```text
kind: agent.script.<scriptId>
source:
  scriptId
  ownerSessionId
  triggerType
params
content: ContentBlock[]
occurredAt
dedupeKey
causationId
```

- 生成事件才注册给面板；
- 原始内部事件 `tool/call` 等不直接出现在面板；
- 一个脚本可以生成多个事件 kind，但必须显式声明；
- 脚本事件允许多个会话订阅；初始可见性由创建者或脚本定义决定，可以显式放宽到其他会话。

## 8. 工具

```text
event_create
event_list
event_update
event_test
event_pause
event_resume
event_delete
```

`event_test` 用模拟事件/样本 payload 运行条件，必须可用，否则模型很难验证规则。

工具只允许：

- 操作自己的脚本；
- 选择自己可见的 source；
- 受配额、冷却、最大触发次数、过期时间限制；
- 不创建新的 DSH 插件。

## 9. 状态

```text
event-scripts-state.json
  scripts:
    id
    name
    trigger
    condition
    emit
    wake
    visibility
    owner
    limits
    enabled
  runtime:
    lastFiredAt
    fireCount
    nextDueAt
    lastError
  subscriptions（仅 standalone）
```

脚本定义可以同时落成可审阅的文件；运行时状态与定义分离。

## 10. 热加载与重启

在没有新增依赖的前提下：

```text
写入脚本定义
→ 宿主 watch/validate
→ 重新编译规则
→ 生效
```

不需要重启 DSH。

以下情况仍可能需要重启或升级宿主：

- 新增 npm 包；
- 新增 native 依赖；
- 新增 DSH 内部能力/协议；
- 宿主本身更新。

不要承诺“任意脚本都能无重启生效”。

## 11. 安全

- 优先声明式模板；
- 脚本必须隔离执行，不能用 Node `vm` 作为安全边界；
- 限制网络域名、文件路径、CPU、内存、运行时间；
- 凭证使用 secret ref，不写入脚本和日志；
- 脚本输入输出大小上限；
- 失败隔离，一个脚本不能带崩整个宿主；
- 防自触发循环、防事件风暴；
- 支持暂停、删除和审计。

## 12. 直播示例

```text
Ayla 直播开始
  → Ayla 插件发布 ayla.live.started
  → 或 Event-Scripts 轮询 Ayla API
  → 脚本条件命中
  → 发布 alice.live.started
  → 主意识订阅
  → Context-Gate 注入
```

如果 Ayla 没有 live 事件源，脚本只能轮询；更好的做法是 Ayla 插件提供 `ayla.live.started`。
无论如何，不需要为这个事件新建并重启一个 DSH 插件。

## 13. 测试

- 模板 schema 校验；
- 外部 poll/webhook；
- 内部 tool/turn/job 触发；
- time/absence/composite；
- 多订阅者；
- standalone 本地投递；
- managed Context-Gate 投递；
- 没有 manager 时开关不出现；
- 热加载；
- 沙箱超时和崩溃隔离；
- 防循环；
- 卸载清理。

## 14. 相关文档

- [插件文档索引](README.md)
- [Context Gate](context-gate.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)