# ElyH 工具面与控制面板

> 状态：2026-11-26。当前实现是 `@elysia/villv-helix`，不再是 `capability-core` + `capability-panel` 的共享 core 方案。
> 架构总览见 [ElyH 扩展能力架构](../architecture.md)。

## 1. 职责

`@elysia/villv-helix` 是**会话级工具面、执行门禁、Context Bus 和能力面板**。

它不是：

- 主意识插件；
- 业务工具提供者；
- Session 创建者；
- 预设管理器。

它不注册 `send_text`、`send_voice`、`session_*` 等业务工具。业务工具由各自的 Tool Provider 注册；Helix 只负责当前会话的可见性与执行门禁。

## 2. 工具面模型

### 2.1 官方预设静态工具

由官方预设的 plugin row 注册：

```text
origin: static
locked: true
```

- 显示在工具列表下方；
- 不能关闭；
- `setTool` 返回 `TOOL_STATIC_LOCKED`；
- `tools.restrict()` 不能撤销预设 scope 的注册。

### 2.2 自定义预设静态工具

由自定义预设注册了同名工具：

- Helix 不再注册一份同名动态工具；
- 通过 `tools/pre-execute` 按 session enabled set 放行；
- 关闭时 schema 仍然存在，执行返回 `UNKNOWN_TOOL`；
- 面板把可切换行放在上方，下方不重复显示锁定副本。

### 2.3 Helix 挂载的扩展工具

Helix 可以为当前 session 挂载工具套件，例如：

```text
read / write / edit / read_image
glob / grep
bash / pwsh
job_list / job_output / job_kill
plugin_market / plugin_manager
```

这些工具的声明保持稳定：

```text
已启用 → 正常执行
未启用 → schema 仍在，执行 UNKNOWN_TOOL
```

关闭工具不会注销定义，也不会让名字从模型 schema 消失后诱发替代工具。

## 3. 顶部标签

```text
对话 | 轨迹 | 上下文 | 工具 | 事件 | 日志 | 健康 | 预设
```

- 普通会话显示基础标签；
- 编排会话显示全部；
- 关闭编排模式时如果停留在编排标签，回到对话；
- 不新增第二排标签；
- 窄屏横向滚动。

## 4. 工具标签

- 全局工具按显示分组；
- 当前会话的 enabled set 保存在 `villv-helix-state.json`；
- 静态工具锁定分组在动态工具下方；
- 批量选择、草稿、保存、工具组预设；
- 同名静态行与动态行只显示一个可操作行。

UI 不伪造工具状态：显示的是 Host 实际快照。

## 5. 事件 / 日志 / 健康

### 事件

Context Bus 的 kind 订阅：

- Provider 注册 kind；
- Session 订阅；
- 合并快照在下一 step 注入；
- 面板显示订阅、队列、TTL、背压。

Context Bus 不是 DSH 全部生命周期事件；它只承载模型可见上下文。

### 日志

记录：

```text
delivered / consumed / dropped / denied
```

并带 kind、session、原因。

### 健康

- 工具注册 / 启用 / 静态数量；
- Context 队列深度；
- 失败 gate；
- 最后采样时间。

健康数据只做摘要，不能替代真实工具调用验收。

## 6. 预设标签

只读展示：

- 当前预设静态工具面；
- 当前会话实际 system prompt；
- 预设引用的提示词文件；
- 提示词文件内容预览。

不在此页编辑预设、提示词或文件。预设管理属于 `@elysia/mobius-infinity`。

## 7. 状态与边界

- 状态目录：`dshHomePath('villv-helix')`；
- 文档：`villv-helix-state.json`；
- 工具组预设是共享库，应用目标按 session；
- 面板刷新由自身写入、跨面板事件和页面可见性触发，不轮询；
- 没有 Server push，Provider 注册新 kind 后可能需要刷新才出现在面板。

## 8. 验收

必须覆盖：

- 官方静态工具 `TOOL_STATIC_LOCKED`；
- 自定义静态工具关闭后 schema 存在、执行 `UNKNOWN_TOOL`；
- 扩展工具未启用 / 启用两种执行结果；
- 同名工具只显示一个可操作行；
- 模式切换只影响下一步，不新开 session；
- 卸载后恢复所有 restriction、监听器和 slot。

当前实现与 `@elysia/villv-helix` 的源码、测试和 README 为准。