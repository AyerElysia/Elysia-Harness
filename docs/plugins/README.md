# ElyH 插件文档索引

> 状态：2026-11-28。每个 ElyH 插件一份独立文档；开发约束见
> [插件开发规范](../architecture/elyh-plugin-spec.zh.md)。
>
> 本文解决两个问题：
> 1. 每个插件负责什么、暴露什么、状态放在哪里；
> 2. 需要 standalone 的插件，什么时候出现 manage 开关，开关前后由谁负责。

## 1. 插件总表

| 插件 | 包名 | 当前状态 | 角色 | 管理插件 | 支持 standalone |
|---|---|---|---|---|---|
| [VillV-Helix](villv-helix.zh.md) | `@elysia/villv-helix` | 当前启用 | 工具面 / 门禁 / 工具面板 | 无 | 否 |
| [Context-Gate](context-gate.zh.md) | `@elysia/context-gate` | 当前启用；定时/自定义事件本轮实现 | 事件面板 / 订阅 / 队列 / 时间引擎 / 自定义事件 | 自身是 manager | 作为 manager 独立可用 |
| [Mobius-Infinity](mobius-infinity.zh.md) | `@elysia/mobius-infinity` | 当前启用 | 预设管理 | 无 | 否 |
| [Channel-IM](channel-im.zh.md) | `@elysia/channel-im` | 规划 | QQ / KOOK / 飞书入站与出站 | Context-Gate | 是 |
| [Ayla-Channel](ayla-channel.zh.md) | `@elysia/ayla-channel` | 规划 | Ayla 入站与出站 | Context-Gate | 是 |
| [Session-Communication](session-communication.zh.md) | `@elysia/session-communication` | 规划 | session 工具 + turn 增量订阅 | Context-Gate | 是 |
| [Event-Scripts](event-scripts.zh.md) | 已合并 | 已合并进 Context-Gate | Agent 自定义事件脚本 / 触发条件 | 不适用 | 否 |

“规划”表示只定义了契约，代码尚未实现。不要把规划中的包当作当前运行组件描述。
Event-Scripts 不再安装为独立包。

## 2. 三层事件模型

```text
第一层：独立源插件事件
  Channel-IM / Ayla-Channel / Session-Communication
  → 多会话订阅

第二层：ContextGate 自定义事件
  模板 / 脚本 / 内部和外部触发
  → 多会话订阅

第三层：ContextGate 时间事件
  timer / timer preset / absence
  → 注入 owner 会话
  → 不订阅
```

ContextGate 自己同时承载第二层和第三层；Channel-IM、Ayla-Channel、
Session-Communication 仍是独立源插件。

## 3. 视图顺序

```text
工具 | 预设 | 事件 | 定时 | 日志
```

工具编辑模式关闭时：

```text
事件 | 定时 | 日志
```

`定时` 是独立视图，不并入 `事件`。

## 4. manage 开关规则

### 2.1 基本规则

```text
只有“支持 standalone 的插件”才可能有 manage 开关。
只有对应的管理插件已经挂载时，才显示这个开关。
没有管理插件时：强制 standalone，不显示开关。
```

manage 开关只负责选择：

```text
standalone：插件自己保存订阅、排队、注入
managed：管理插件保存订阅、排队、注入，源插件只负责触发和发布
```

它不负责：

- 启动/停止源插件；
- 改变事件协议；
- 在两种模式之间自动迁移订阅；
- 自动 fallback。

### 2.2 四种状态

| 管理插件 | 当前模式 | 开关 | 行为 |
|---|---|---|---|
| 不存在 | standalone | 不显示 | 插件独立运行 |
| 不存在 | managed | 不显示 | **错误状态**：不投递，不自动降级 |
| 已挂载 | standalone | 显示（关） | 插件独立运行 |
| 已挂载 | managed | 显示（开） | 管理插件接管订阅、队列、注入 |

默认模式是 **standalone**。
即使管理插件存在，也不会因为检测到它就自动接管；必须显式打开 manage。

### 2.3 管理插件消失

```text
managed + manager unmount
  → 不自动切 standalone
  → 源插件进入 unavailable / paused
  → 保留自己的事件定义和状态
  → 明确报错，等待 manager 回来，或由用户手动切 standalone
```

禁止：

```text
管理插件消失 → 偷偷自己接管
管理插件回来 → 偷偷把 standalone 改成 managed
```

这两种都会造成重复投递或订阅丢失。

### 2.4 开关的可见性

开关由**源插件的 Client** 渲染，但它必须从 Host 得到：

```text
managerAvailable: boolean
mode: 'standalone' | 'managed'
```

Client 不能靠“包是否安装”猜测 manager 是否运行。
只有管理服务实际可用时，开关才出现。

## 5. 当前谁管理谁

```text
VillV-Helix
  管理工具面；不管理事件源。
  没有 manage 开关。

Mobius-Infinity
  管理预设；不管理事件源。
  没有 manage 开关。

Context-Gate
  管理上下文事件的订阅、队列和注入。
  自己承载时间引擎和自定义事件引擎。
  是所有支持 standalone 的事件源的对应 manager。
  它自身不显示 manage 开关。

Channel-IM / Ayla-Channel
  manager = Context-Gate
  standalone = 自己的入站订阅与投递

Session-Communication
  manager = Context-Gate（仅管理 turn 订阅）
  standalone = 自己的 turn 订阅条目
  session_send 始终是定向工具，不随 manage 改变
```

## 6. 每插件文档模板

新增插件必须提供以下章节：

```text
1. 身份与状态
2. 职责与非职责
3. 包内结构
4. 事件 / 触发器
5. 工具与 RPC
6. standalone / managed
7. 状态与持久化
8. 权限、隐私、安全
9. 生命周期、失败与恢复
10. 测试与验收
11. 边界与迁移
```

文档中的“当前状态”必须是实际状态：
- 当前启用
- 规划
- 归档
- 已移除

不能把未实现的事件、工具或 UI 写成已经可用。

## 7. 文档与代码的一致性

- 插件 README 可以保留包级快速说明；架构文档和本目录以本索引为准。
- 事件 kind、工具名、RPC 名、状态目录必须与代码一致。
- 改变 manage 开关、manager 服务名或 standalone 行为时，必须同时更新：
  - 本索引；
  - 插件文档；
  - `elyh-plugin-spec.zh.md`；
  - 相关架构图或数据流（如果有）。