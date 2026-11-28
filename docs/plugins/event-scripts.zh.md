# Event-Scripts（已合并进 ContextGate）

> 状态：已合并，不再是独立插件，不再单独安装、单独构建或单独运行。
>
> 新的职责文档见 [`@elysia/context-gate`](context-gate.zh.md)。

## 1. 结论

```text
@elysia/event-scripts  →  合并到 @elysia/context-gate
```

以下能力已归 ContextGate：

- Agent 自定义事件规则；
- 标准模板；
- 沙箱脚本；
- 内部事件触发；
- 外部 HTTP / webhook 触发；
- 时间触发、absence 和重复规则；
- 生成事件注册；
- 自定义事件订阅参数；
- 热加载和运行状态。

## 2. 不再存在

```text
@elysia/event-scripts 独立包
Event-Scripts standalone 模式
Event-Scripts manage 开关
Event-Scripts 独立 scheduler
Event-Scripts 独立投递队列
```

Event-Scripts 没有 manager，也没有 standalone，因为它已经成为 ContextGate 的一部分。

## 3. 迁移

- 插件文档索引不再把 Event-Scripts 列为独立插件；
- ContextGate 负责第二层自定义事件；
- ContextGate 负责第三层纯时间事件；
- 两者共用同一个 ContextGate 时间引擎；
- 第二层生成可订阅事件，第三层只注入 owner 会话。

## 4. 历史职责

合并前 Event-Scripts 负责：

```text
Agent 自定义事件
  → 声明式模板 / 沙箱脚本
  → 内部与外部触发器
  → 生成事件
  → 发布到 ContextGate
```

合并后这些职责没有消失，只是所有者改为 ContextGate。

## 5. 边界

- 纯时间事件使用 `timer_*` 工具，不使用 `event_rule_*`；
- 复杂事件使用 `event_rule_*`，可以包含时间条件；
- 两者不能为同一条纯时间规则各跑一套调度器；
- Event-Scripts 的脚本不能直接改 ContextGate 或 DSH 内部状态；
- 脚本隔离、限权、热加载要求继续有效。

## 6. 相关文档

- [ContextGate](context-gate.zh.md)
- [ContextGate 架构](../architecture/elyh-context-gate.zh.md)
- [插件文档索引](README.md)