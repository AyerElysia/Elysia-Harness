# @elysia/session-communication

> 状态：规划。负责 Session 间定向消息、turn 增量订阅和会话读取。
>
> 本文定义目标契约，代码尚未实现。

## 1. 身份

| 项 | 值 |
|---|---|
| 包名 | `@elysia/session-communication` |
| 插件 id | `session-communication` |
| 目录 | `plugins/session-communication/`（规划） |
| 角色 | Tool Provider + Event Source |
| 管理插件 | `@elysia/context-gate` |
| standalone | 是 |
| manage 开关 | 仅当 Context-Gate 挂载时出现 |

## 2. 职责

- 模型工具：

```text
session_list
session_read
session_send
```

- `session_send` 定向消息：

  - 发给一个或多个订阅者；
  - 发送前可用 `session_list` 查看谁接受 `session_send`；
  - 目标忙时排队；
  - 保留消息 id、reply 关系、投递状态；
  - 投递状态未知时不要自动重发。

- turn 增量事件：

  - 订阅者选择一个或多个来源 turn；
  - 每个订阅者独立 cursor；
  - 只发送可见增量；
  - 不发送 reasoning、system prompt、私有工具参数；
  - 反向来源和自身来源排除。

## 3. 非职责

- 不创建或切换 Session；
- 不管理工具面；
- 不管理上下文事件队列（managed 模式交给 Context-Gate）；
- 不负责外部渠道；
- 不把 `session_send` 变成广播事件；
- 不把每个 turn 默认自动发送到所有订阅者。

## 4. `session_send` 语义

```text
session_send(recipients = [B, C], content, replyTo?)
```

- 发给谁就是谁；
- 一个或多个目标；
- 目标必须接受该事件（subscription opt-in）；
- 目标没有订阅：返回明确的 `TARGET_NOT_SUBSCRIBED`；
- 目标忙：排队/等待；
- 每个目标独立状态；
- 消息 id 用于 reply 和幂等。

`session_list` 返回参与会话、可读性、是否接受 `session_send`、可用状态。
`session_read` 只读目标会话的可见历史，做分页、脱敏和大小限制。

## 5. turn 订阅

数据结构：

```text
TurnEntry
  id
  subscriber: sessionId
  sources: sessionId[]
  enabled
  cursorBySource: Record<sessionId, seq>
  createdAt
```

支持：

```text
多来源 → 单订阅者
单来源 → 多订阅者
多来源 → 多订阅者
```

一个条目只属于一个订阅者；同一订阅者可以有多条。
订阅时选择来源 turn，支持多选。

每个来源维护独立 cursor，不能共用一个全局 seq。

## 6. 两种模式

### standalone

本插件自己保存：

```text
session_send 接受者
turn 订阅条目
每个目标的 cursor / 待投递队列
```

自己注入目标会话。

### managed

本插件只负责：

```text
发布 session.message 事件
发布 session.turn 事件
提供 session_* 工具
```

Context-Gate 负责：

```text
session.message 的订阅/队列
session.turn 的订阅/来源选择/注入
```

`session_send` 仍然是定向工具；manager 不把它改成广播。

### manage 开关

```text
Context-Gate 不存在：standalone，无开关
Context-Gate 存在：开关出现，默认 standalone
开启：turn 订阅和 session.message 接受表交给 Context-Gate
```

manager 消失：managed 进入 unavailable，不自动切 standalone。

## 7. 状态

```text
session-communication-state.json
  acceptance（standalone）
  turnEntries（standalone）
  cursors
  outbox
  lastErrors
```

managed 模式下订阅和队列状态归 Context-Gate；本地只保留工具调用证据和必要 cursor 镜像。

## 8. 权限与隐私

- `session_list` 只暴露参与会话，不泄露全部 Session；
- `session_read` 过滤 reasoning、私有工具参数、凭证类内容；
- `session_send` 不得默认 fan-out；
- turn delta 不包含私有上下文；
- 目标会话可以拒绝接受；
- 所有跨会话访问都要有 source/target 权限校验。

## 9. 失败与恢复

- 目标 session 离线：持久化 outbox，恢复后投递；
- 目标 busy：等待；
- 投递未知：记录，不自动重发；
- Context-Gate 不可用：managed 模式不投递；
- 卸载：释放监听器、队列和待投递状态。

## 10. 测试

- `session_list` 可见性；
- `session_send` 单目标/多目标；
- 目标未订阅拒绝；
- 目标忙/离线；
- 幂等和 reply；
- turn 多来源/多订阅者；
- 每来源 cursor；
- 防回环；
- delta 脱敏；
- managed / standalone 切换；
- 卸载。

## 11. 相关文档

- [插件文档索引](README.md)
- [Context Gate](context-gate.zh.md)
- [插件开发规范](../architecture/elyh-plugin-spec.zh.md)