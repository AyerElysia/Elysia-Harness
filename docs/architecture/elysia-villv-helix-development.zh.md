# Elysia/VillV-Helix 开发步骤与迁移边界

> 状态：2026-11-26。主体开发已完成；本文保留为迁移边界和后续扩展顺序。
> 当前架构见 [ElyH 扩展能力架构](../architecture.md)，当前工具面语义见
> [工具面与控制面板](elyh-control-panel.zh.md)。
> 规范见 [ElyH 插件开发规范](elyh-plugin-spec.zh.md)。
> 插件身份：**Elysia/VillV-Helix** / `@elysia/villv-helix` / `villv-helix`（Vill-V of Helix）。
>
> **2026-11-26 更新**：上下文事件订阅、注入队列与日志已拆到独立 `@elysia/context-gate`；健康统计已删除。
> 本文中涉及“Helix 事件总线 / 日志 / 健康 / 单排全部标签”的段落是拆分前历史步骤，以
> [Context Gate](elyh-context-gate.zh.md) 和 [工具面文档](elyh-control-panel.zh.md) 为准。

## 1. 这次重写做什么

目标不是把 `capability-core` 和 `capability-panel` 继续修补，而是写一个新的单一插件：

```text
@elysia/villv-helix
  Host：会话编排状态、工具限制、预设预览数据
  Client：工具/预设视图、模式胶囊

@elysia/context-gate
  Host：上下文 kind 订阅、持久队列、合并注入、注入日志
  Client：事件/日志视图
```

旧代码只保留为前端参考和迁移材料。新插件不依赖 `capability-core`，也不依赖旧的面板包。

## 2. 能搬什么

### 2.1 可以搬，但要改

| 内容 | 处理 |
|---|---|
| `capability-panel` 的工具列表、行、分组、折叠、空状态 | 搬视觉与交互；数据接口重写 |
| 上下文事件页、事件行、订阅开关 | 搬 UI；改为 session 作用域 |
| Context Gate 的事件/日志视图 | 已拆到独立包；per-session 数据，不再有健康页 |
| CSS modules、图标、配色、间距、响应式规则 | 可参考复用；去掉旧主面板布局 |
| `locales.ts` 的中英文文案 | 逐条审查后复用；删除“全局注入”旧文案 |
| 客户端 API 的响应校验/错误分类 | 参考实现，按新 RPC 重写 |
| 旧测试的断言场景 | 作为行为参考，不直接复制旧架构测试 |

### 2.2 不能直接搬

以下内容属于旧架构，必须重写：

- `capability-core`：状态机、catalog、gate、guard、持久化、`ensureCapabilityCore`、`capability-set`；
- `capabilityHost` 服务名、Remote 命名空间、旧 RPC 接口；
- 插件级 `global` 配置和“为模型全局注入……”开关；
- 全局/预设/session 三层工具状态和 `session > preset > global` 状态机；
- 主面板侧栏入口和整页 `ControlPanelPage` 路由；
- 旧的挂载顺序、core 状态目录、core/panel 同步事件；
- 以 catalog 推送工具的方式。

### 2.3 必须新建

- 一个完整包 `@elysia/villv-helix`，Host + Client 同包；
- session 的“会话编排模式”标记与持久化；
- 全局工具拉取、live Agent 的 `tools.restrict()`、`agent/created` / `tools/change` 自动重算；
- Helix 视图：`工具 | 预设`；
- Context Gate 视图：`事件 | 日志`，独立注册且不受编排模式管理；
- “预设”页签：静态工具面、当前 system prompt、提示词文件预览；
- 工具中文显示名元数据（上下文 kind 的中文名归 Context Gate）；
- 普通/编排模式切换只影响工具面，不影响 Context Gate 视图。

## 3. 开发顺序

### 第 0 步：冻结旧实现

- `capability-core` / `capability-panel` / 旧 capability 文档只读；
- 不再给旧面板加功能；
- 旧包在新包验收前继续可用，不做破坏性修改。

### 第 1 步：新包骨架

```text
plugins/villv-helix/
  package.json
  cordis.patch.yml
  src/index.ts
  src/client/
  tests/
```

- 包名、插件 id、profile dependency、bundle row；
- 不引入 `@elysia/capability-core`；
- 先只做空 Host + 空 Client，确保能挂载/卸载。

### 第 2 步：会话编排模式

- session 标记的存储位置（专用 preset / session metadata / 编排插件状态）；
- 胶囊开关：`会话编排模式`；
- 关闭：普通会话，不限制工具；
- 开启：编排会话，所有 global 工具初始 deny；
- 切换持久化，下一步生效，不新开会话。

### 第 3 步：工具限制

- Host 拉 `ctx.tools.definitions()`；
- 对 live Agent 安装 `tools.restrict`；
- 监听 `agent/created`、`agent/disposed`、`tools/change`；
- 状态变化后只刷新受影响的 session；
- 编排会话默认只保留预设静态工具；
- 官方预设 static 工具锁定，`setTool` 返回 `TOOL_STATIC_LOCKED`；
- 自定义预设 static 工具不重复注册，使用 `tools/pre-execute` 门禁；关闭时 schema 保留、执行 `UNKNOWN_TOOL`；
- Helix 挂载的扩展工具保留稳定声明，未启用执行 `UNKNOWN_TOOL`；
- 普通会话不安装编排限制。

### 第 4 步：Context Gate（拆分后）

- 从旧 `context-bus` 只参考队列/TTL/订阅语义，代码重写到独立包；
- provider 向 `contextGate.registerContextKind()` / `publish()` 注册与发布；
- per-session 队列、TTL、dedupe、背压、合并注入；
- 事件/日志两个视图独立于 Helix；
- 健康统计删除，不再有 status/健康页。

### 第 5 步：预设页签

只读：

- 当前预设的静态工具面；
- 当前会话实际 system prompt；
- 预设引用的提示词文件；
- 文件内容预览。

需要新的只读 RPC/查询，不从旧 `capabilityHost/list` 硬拼。

### 第 6 步：顶部视图（拆分后）

```text
Helix:        工具 | 预设
Context Gate: 事件 | 日志
```

- 两组视图分别注册，不互相挤占；
- 上下文视图不受编排模式管理；
- 普通模式仍显示工具/预设，并提示编排模式未开启；
- 窄屏横向滚动，不折行。

### 第 7 步：切换与清理

- profile 切到新插件；
- 旧 `capability-panel` 从 bundle 移除；
- `capability-core` 不再作为依赖；
- 旧状态文件只做迁移说明，不继续写；
- 卸载新插件时清理所有 restriction、监听器、slot、事件 kind。

### 第 8 步：验收

- 普通工具插件不依赖新插件也能运行；
- 新插件无外部 core 依赖；
- 现有 live session 切换编排模式；
- 新 session `agent/created` 自动安装限制；
- 新工具 `tools/change` 自动进入控制；
- 编排会话初始只有静态工具；
- 预设页签数据正确、只读；
- 工具/预设与 Context Gate 的事件/日志视图各自注册；模式胶囊、中文/英文 locale；
- typecheck / test / build / bundle 全绿。

## 4. 待定但不阻塞开发

- 编排会话是否要为基础 global 工具保留 allowlist（当前先不做，按“除静态工具外全部 deny”实现）；
- “预设”页签的 system prompt 是显示最终组装结果，还是分段展示；先显示最终结果 + 文件列表；
- 预设管理插件改名后的正式身份：**Elysia/Mobius-Infinity** / `@elysia/mobius-infinity` / `mobius-infinity`；保留预设管理职责，删除旧的全局注入开关。旧 `preset-manager` 文档只作前端参考。
- 编排会话的 session 标记最终用 dedicated preset 还是 metadata，先按实现成本最低的方案落地。

## 5. 不要做的事

- 不要将旧 core 改个名字继续用；
- 不要把旧 `capabilityHost` RPC 原样复制；
- 不要重新引入插件级全局开关；
- 不要用轮询刷新会话状态；
- 不要把工具/事件状态分散到多个包；
- 不要为了兼容旧面板保留第二套状态机。