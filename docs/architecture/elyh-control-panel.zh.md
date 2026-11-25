# ElyH 上下文事件 + 动态工具管理面板方案（v1.4）

> **已废弃，仅作前端参考。** 新实现是 **Elysia/VillV-Helix**（`@elysia/villv-helix`），见
> [开发步骤](elysia-villv-helix-development.zh.md) 与
> [插件规范](elyh-plugin-spec.zh.md)。本文中的 `capability-core`、全局工具状态、catalog 和主面板入口不再作为新插件模板。

> 状态：设计稿，2026-11-24；v1.3 修订动态工具发现：核心读取整个部署里所有预设/会话可见的工具并集，也支持 provider 通过 catalog 显式声明（带 `nameZh`）；只排除当前预设自带的静态工具，其余默认由 gate 关闭；被静态工具覆盖的项直接隐藏。
> v1.3 日期：2026-11-23；DSH 原生工具的判定基准是 `standard` 预设静态工具面加 base bundle 全局核心工具；`plugin_market`、`cordis_inspect_*` 和外部 MCP 属于插件工具，分类旁提供一键全选复选框。
> v1.3 面板交互：动态工具按功能分类、可折叠并显示类别启用数；工具名默认翻译，可关；工具组预设支持应用、命名创建、删除；工具开关只改草稿，动态工具区底部的“保存”才写入 Host；静态工具始终排在最后。
> 状态：v1.2 历史边界仍有效：preset-manager 保留静态工具面，核心管理动态工具与上下文事件，面板只展示/操作；静态工具只读锁定。
> 不在范围：预设内容编辑、预设创建/删除、提示词文件内容编辑、会话创建、模型选择、渠道桥接实现。
> 关键约束：预设的静态工具面由 preset-manager 拥有，面板不能关闭；共享 Host 核心拥有动态工具/全局状态/上下文事件；面板只是核心的可选 Client；动态工具默认关闭；不新开会话。
> v1.4 包边界：`@elysia/capability-core` 是 Host-only 核心；`@elysia/capability-panel` 是可选 Client 面板；`@elysia/preset-manager` 只依赖核心。核心状态目录统一为 `dshHomePath('capability-core')`，两个消费者传同一个值，不能由首个挂载者决定。面板与预设面板同浏览器时用 `elysia:capability-changed` 事件立即同步，不使用轮询。

## 1. 一句话

**预设管理器管“你是谁、看哪些文件、静态工具面”；面板管“你还能用什么动态工具、这轮看到什么事件”。**

面板由两部分组成：

- `@elysia/capability-core`（Host-only 库，不是插件/bundle）：负责 Tool Catalog、Gate、Context Bus、State Store、Session Registry、Capability Set、全局工具状态与持久化；不含 React/Client，也没有 `dsh.bundle`/`cordis.patch.yml`。
- `@elysia/capability-panel`（可选 Client 面板，仍是**一个插件包**）：Host 入口只调用 `ensureCapabilityCore`（已有核心复用，没有则挂一次）；`dsh.client` 负责会话/预设列表、静态工具只读展示、动态工具开关、上下文事件开关、事件日志、健康面。没有这个包时核心库和 preset-manager 仍然工作。

## 2. 组件

### 2.1 `@elysia/capability-core`（Host-only）

| 模块 | 职责 |
|---|---|
| Tool Catalog | 收集**动态工具**条目；每条声明 `scope: global \| agent`、factory、schema、required services；global 工具全局注册，agent 工具交给 Capability Set |
| Gate | `enabled(toolId, agent)`：静态工具恒开且只读；动态工具按 `session > preset > global` 判定；全局默认关；可选扩展 fail-closed，reply 组 fail-loud |
| Capability Set | 通用桥：由 Host controller 挂到 agent scope，按面板状态注册 agent-scoped 动态工具；不声明具体工具名单，不改预设 |
| Context Bus | 事件 schema、订阅、每会话队列/游标、去重、TTL、active/passive 分发、背压 |
| State Store | 存动态工具的 `global / presetId / sessionId -> tools/contexts`；静态工具不落开关；原子写/版本迁移；文件固定为 `capability-core/capability-state.json` |
| Session Registry | live + 持久化会话 -> 预设映射；`presetForSession()` + 持久化列表；不创建会话 |
| Static Tool Probe | 从预设组合读取静态工具（`agentPresets.compositionInventory()`），标 `origin:'static'`、`locked:true`；不注册、不注销 |

### 2.2 `@elysia/capability-panel`（可选 Client 面板）

- 列出会话与预设，自动识别当前会话的预设；离线会话按持久化列表展示。
- **静态工具**：只读展示，标 `locked`，提示“预设默认工具，不能关闭”；没有开关，不能发 `setTool`。
- **动态工具**：按 session/preset 开/关；显示 `scope`（global / agent）、挂载位置、当前 step 是否生效。
- 上下文事件开关：按预设/会话订阅；显示主动/被动、TTL、backlog。
- 事件日志：最近发布、投递、消费、失败、合并。
- 健康面：工具注册失败、上下文积压、gate 错误、队列延迟。
- 通过 RPC 读写 Host；不直接操作文件、不直接 mount 会话插件；agent-scoped 动态工具由 Host 的 Capability Set 挂载。

### 2.3 与预设管理器的边界

- 预设管理器独立可用：`id/name/description/identity/promptRoot/files/order` + **静态工具面**。它只依赖 `@elysia/capability-core`，不依赖面板包；没有面板时自行 `ensureCapabilityCore`。
- 面板是可选消费者；没有面板时预设管理器的全局工具开关仍可直接写核心状态。
- 预设的静态工具面由 preset definition 里的 tool rows 决定；当前系统最小面是 `tool-web`（`web_search` / `web_fetch`），具体由 preset-manager 配置决定。
- 面板不编辑预设、不改静态工具面、不能关闭静态工具；只在其上叠加动态工具和上下文事件。
- 面板看到的静态工具来自预设组合，不是面板 catalog；两者同名时静态优先，动态条目 `shadowed`，不重复注册。
- 预设不需要挂 `capability-set`；agent-scoped 动态工具由 Host controller 在 agent scope 挂载，preset-manager 保持原样。

## 3. 工具层

### 3.1 静态工具：预设拥有，面板只读

静态工具是 preset definition 挂载的工具，当前典型是 `tool-web` 的 `web_search` / `web_fetch`。

- 由 preset-manager 创建、修改、删除；面板不碰。
- 对所有使用该预设的会话常开。
- 面板只读展示：`origin:'static'`、`locked:true`、来源预设、当前 step 状态。
- `setTool` 对静态工具返回 `TOOL_STATIC_LOCKED`；UI 不渲染开关，只显示“预设默认工具，不能关闭”。
- 静态工具即使被面板同名动态工具覆盖，也不注销；动态条目标 `shadowed`，不重复注册。

### 3.2 动态工具：自动发现，默认关闭

动态工具来自 core catalog（`scope: 'global' | 'agent'`，带 `nameZh`）以及部署实际可见工具的并集；catalog 条目默认由 gate 关闭，可按预设/会话显式开启，核心还可自动发现未显式注册的工具。被当前预设静态工具覆盖的条目从列表隐藏，不显示不可用行；每次修改只进入客户端草稿，用户点击动态工具区底部的“保存”才逐条写入 `setTool`。

- `reply`：`send_text` / `send_voice` / `pass`（`send_file` 未实现，预留）。**不可拆**：主意识预设开启后必须同时拥有 `pass` 与至少一个发送工具；面板可以关闭某个渠道，但不能让会话失去“沉默”能力。
- `files-read`：`read` / `read_image` / `glob` / `grep`（agent-scoped）
- `files-write`：`write` / `edit`（agent-scoped）
- `skill`（agent-scoped）
- `schedule`：`schedule_create/list/view/edit`
- `comm`：`session_list/send/read`
- `router`：`subconscious_dispatch`
- `dev`：`bash` / `job_*`（agent-scoped，仅 Router，可选）
- 以后新增能力按同一 catalog 条目加入。

动态工具由面板按 session/preset 开启；默认关闭。主意识的 `reply` 组视为安全基线：开启后不能被拆散；面板故障时 reply 组 fail-loud，不静默消失。

### 3.3 注册与门

动态工具分两类，不能都全局注册：

**global 动态工具**（`reply`、`comm`、`schedule`、MCP 等无 agent 作用域依赖的）：

```ts
ctx.tools.register(def, {
  when: ({ agent }) => host.enabled(agent, 'app_reply'),
})
```

**agent-scoped 动态工具**（`files-*`、`skill`、`dev` 等需要 preset/agent 作用域服务的）：

- 由 Host controller 把通用 `capability-set` 挂到目标 agent scope；
- 在 `apply` 里用 `agent.ctx.tools.register(...)` 注册；
- 面板只写状态，Host controller 负责 dispose/remount 整个 Capability Set；
- 不改预设 definition，preset-manager 保持独立。

- `when` 每个 step 评估一次；条件收到 `{ agent, modelSelection, signal }`。
- false：不进 schema、不进 PTC、不可执行。
- 静态工具恒开，不经过 `when`；动态工具默认 false。
- `enabled` 支持精确 session 集合，也支持预设集合。
- 每条动态 Catalog 条目必须声明 `scope`，未知 scope 拒绝注册。

### 3.4 硬阻断

| 场景 | 当前 step | 下一 step | 执行 |
|---|---|---|---|
| 静态工具（预设自带） | 有 schema | 仍有 | 可执行；面板不能关 |
| 动态工具 step 开始时 false | 无 schema | 仍无 | 硬调 -> `UNKNOWN_TOOL` |
| 动态工具 step 开始时 true | 有 schema | 看下一次评估 | 可执行 |
| 动态工具 step 中途关闭 | 当前 step 已冻结 | 消失 | 当前 step 仍可能执行 |
| 动态工具全局 dispose | 未开始调用拒绝 | 消失 | 已开始按取消契约 |

需要“关了连当前 step 也不能调用”时，加调用级 guard：

```ts
ctx.tools.guard(exec => {
  if (!exec.agent) return undefined
  if (exec.name === 'app_reply' && !host.liveEnabled(exec.agent, 'app_reply')) {
    return 'app_reply 已关闭'
  }
})
```

`when` 是 step 级门，`guard` 是调用级门。guard 必须 fail-closed；`exec.agent` 可能为空，程序化调用不能因此崩溃。

### 3.5 工具更新提示

- 动态工具集变化后，agent loop 在下一请求比较 request header，写 `developer/message` 的 `tool-addition` / `tool-removal`。
- Chat 显示“工具已更新”；Trajectory 显示请求级变化。
- `tools/change` 是注册表通知，不是这条提示的来源。
- 静态工具不由面板开关，不会因面板操作产生增减提示。

### 3.6 工具 Provider 的挂载

- 静态工具由 preset-manager 的预设行挂载；`dsh-web-app` 在 host 层禁用了 `tool-web`，由预设行提供，面板不要重复挂。
- 动态工具由面板 catalog 挂载：
  - **global-safe**：`reply`、`comm`、`schedule`、MCP；Host 全局注册。
  - **agent-scoped**：`files-*`、`skill`、`dev`；Host controller 在 agent scope mount `capability-set`。
- 不要一次性禁用所有 `tool-*` host 行；先按作用域盘点。对仍留在 host 的全局工具，用 `tools.restrict` 或 `when` 收窄。
- 动态重工具可惰性挂载：首次启用时 mount 全局 Provider，最后一个关闭时 dispose；仍然不是每会话一份。
- 静态工具与动态工具同名时，静态优先；动态不注册同名定义，只标 `shadowed`。

## 4. 上下文事件层

### 4.1 事件

```ts
interface ContextEvent {
  id: string
  kind: string              // app.message, conscious.surface, prompt.change, live.event
  source: string
  summary: string
  payload: unknown          // 必须 JSON-serializable；按订阅复制，禁止跨会话复用可变对象
  visibility: { presetIds?: string[]; sessionIds?: string[] } // 与订阅 AND；发布者只能缩小范围
  active: boolean           // true: wake a turn; false: next pre-step
  dedupeKey: string
  ttlMs?: number
  maxBytes?: number         // 单事件上限；超限拒绝发布，保留原队列
  createdAt: number
}
```

### 4.2 订阅与 fan-out

- Provider 向 `contextBus.publish(event)` 发事件。
- Harness 按订阅解析目标会话集合：
  - 预设订阅：该预设的所有会话；
  - 会话订阅：精确会话；
  - `visibility` 做二次过滤，必须是 **AND**：发布者只能缩小，不能绕过面板订阅。
- “所有会话”的准确含义：**所有开启了这个事件的预设对应的所有会话**，不是字面全库。
- 同一会话的多个 active 事件在唤醒前合并为一批；有并发上限，避免一次发布制造多轮。

### 4.3 主动与被动

- **被动**：只让会话知道，下一次 `agent/pre-step` 注入；不唤醒。
- **主动**：除注入外，`agent.followup(...)` 唤醒一轮；消息 `source.kind` 标明触发来源。
- active 事件按会话合并：会话 running 时排到下一 step/turn，不重复 followup；连续事件不得制造无界轮次。
- 被动队列按 `createdAt` 排序；超过 `ttlMs` 丢弃并记日志。

### 4.4 注入

一个全局 `agent/pre-step` 监听器：

1. 取该会话未消费的事件，按 `createdAt` 排序并做字节/条数上限；
2. 生成**一条** snapshot（多事件合并），`source.kind = 'elysia-context-relay'`，`form: 'snapshot'`；
3. 用 `surfaceOp: 'replace'` 清掉上一轮同源旧快照；
4. 标记已消费；`dedupeKey` 防重复；失败不标记，留待重试。

`form: 'snapshot'` 让 subconscious 的 `isExternalInput` 忽略它，不把注入当新的外部输入。**但 app 消息本身不能只靠 snapshot**：

- managed bridge 必须同时投递一条真实 `user/message`，`source.kind='app-message'`，承载正文/附件，让 Router 观察；
- snapshot 只写“这条 app 消息触发了本轮”，是因果注解，不是消息本体。
- 只发 snapshot：Router 看不到 app 渠道；只发 user message：主意识不知道触发来源。两者都要。

### 4.5 新会话与重启

- 新会话：预设订阅立即生效；默认只收未来事件；历史事件补发必须显式配置 `ttlMs/backlog`，默认不补发。
- 重启：Host 挂载一次，读 State Store；全局监听和订阅自动恢复。**没有逐会话重新注入这一步。**
- 事件队列、每会话游标/已消费集合必须持久化；否则 idle 会话在重启后会丢事件或重复消费。
- 会话被归档/删除时清理其队列；离线会话的订阅仍保留，恢复后继续。

## 5. State Store

建议结构：

```json
{
  "version": 1,
  "presets": {
    "elysia-conscious": {
      "tools": ["reply", "files-read"],
      "contexts": ["prompt.change", "app.message"]
    }
  },
  "sessions": {
    "<sessionId>": {
      "tools": ["reply"],
      "contexts": ["prompt.change"]
    }
  },
  "updatedAt": "..."
}
```

- **只存动态工具**；静态工具来自预设组合，不落开关，不在文档里重复。
- 合并优先级必须写死：**静态恒开 → preset 动态默认 → session 动态增量/覆盖**；session 只能增加或显式 `false` 关闭动态项，未列出的项继承 preset。
- 动态扩展默认关闭；显式开启才写入。
- 面板写入是唯一入口；Host 负责校验、原子写（临时文件 + rename）和版本迁移。
- 启动时 `reconcile`：静态工具从预设组合读取；动态工具按文档恢复；未知 tool/context 记 diagnostic，不阻塞；`scope` 不匹配记 diagnostic 并拒绝该条。
- 离线会话也要出现在 `sessions` 映射里；不能只依赖 live `agentPresets.presetForSession()`。

## 6. 面板 UI

### 6.1 会话/预设列表

- 会话：id、标题、预设、状态、最近活动。
- 预设：id、名称、session 数、是否 managed、静态工具面摘要。
- 自动识别：`agentPresets.presetForSession(session)`。

### 6.2 工具面板

- **静态工具**：只读，按预设展示 `origin:'static'`、`locked:true`、来源预设、当前 step；固定提示“预设默认工具，不能关闭”；不渲染开关。
- **动态工具**：按 session/preset 勾选；显示 `scope`（global / agent）、挂载位置、“当前 step 是否生效”。
- reply 组以组为单位展示，不能单独关掉 `pass`。
- 警告：工具注册失败、provider 缺失、`when` 抛错；agent-scoped 工具额外显示 Capability Set 状态。
- 若动态工具与静态工具同名：动态项标 `shadowed`，不可开启，提示“被预设默认工具覆盖”。

### 6.3 上下文事件面板

- 事件类型列表：`app.message`、`prompt.change`、`conscious.surface` 等。
- 按预设/会话订阅。
- 事件日志：发布、投递、消费、失败、丢弃（TTL/去重）。
- 主动/被动标记。

### 6.4 健康面

- 工具：静态数、动态注册总数、启用数、失败数；global vs agent-scoped 分开统计。
- 上下文：队列深度、最老事件、消费延迟、失败数、合并数。
- Gate：最近一次错误、错误率；区分 fail-closed（可选动态扩展）与 fail-loud（reply 组）。

## 7. App Bridge 集成

- **standalone**：桥接插件自己选一个会话、自己 followup；不经过面板。
- **managed**：
  - 向 Tool Catalog 注册 `app_reply`（global scope，动态工具）；
  - 向 Context Bus 注册 `app.message` 事件类型，并在收到消息时 publish；
  - 同时向目标会话投递一条真实 `user/message`（`source.kind='app-message'`），让 Router 观察；
  - 面板把 reply 组 + `app.message` 开给主意识预设；
  - 桥接插件不拥有会话，只持有 transport 和消息身份。
- `app_reply` 必须绑定当前入站消息的会话身份；不能由模型自由指定 channel/conversation。
- `app.message` 的 snapshot 只写触发因果；正文在 user message 里，不能二选一。

## 8. API 草案

```ts
interface CapabilityHost {
  list(): Promise<CapabilitySnapshot>
  setTool(scope: ScopeRef, toolId: string, enabled: boolean): Promise<void>
  setContext(scope: ScopeRef, eventKind: string, enabled: boolean): Promise<void>
  publish(event: ContextEvent): Promise<PublishReceipt>
  status(): Promise<HostStatus>
}

interface PublishReceipt {
  eventId: string
  delivered: number
  suppressed: number
  failed: number
}
```

`ScopeRef` 为 `{ kind: 'preset'; id: string } | { kind: 'session'; id: string }`。

- 静态工具没有可写 scope；`setTool` 对静态工具返回 `TOOL_STATIC_LOCKED`。
- 动态工具写 preset/session；session 增量/覆盖 preset。
- Client 通过 RPC 调用；不直接写 State Store 文件，不直接调 `ctx.tools.register()`。
- agent-scoped 动态工具的注册/注销由 Host 的 Capability Set 负责。

## 9. 错误与权限

| 错误 | 行为 |
|---|---|
| `TOOL_UNKNOWN` | 拒绝开启，提示 Provider 未注册 |
| `TOOL_STATIC_LOCKED` | 拒绝关闭/修改静态工具，提示“预设默认工具，不能关闭” |
| `CONTEXT_UNKNOWN` | 拒绝订阅，提示事件未注册 |
| `SCOPE_NOT_FOUND` | 拒绝，提示预设/会话不存在 |
| `SCOPE_READ_ONLY` | 静态工具 scope 不允许写，拒绝 |
| `GATE_FAILED` | 可选动态扩展 fail-closed 并记 diagnostic；reply 组 fail-loud，当前 step 失败 |
| `EVENT_TOO_LARGE` | 拒绝发布，保留原队列；记录 `maxBytes` |
| `EVENT_PAYLOAD_INVALID` | 拒绝非 JSON/超限/不可复制 payload |

- 只有 owner 可以改开关；所有变更审计（谁、何时、scope、tool/context、前后值）。
- 工具注册不等于授权；`tools.guard` / `pre-execute` 仍然拦截。
- 上下文 payload 不跨会话复用可变对象；按订阅复制；payload 必须 JSON-serializable。
- `tools.guard` 的 `exec.agent` 可能为空；guard 先判空，fail-closed。
- 面板不能创建会话、不能改预设、不能改提示词文件内容。

## 10. 验收

1. 静态：预设自带 `web_search` / `web_fetch` 在会话中常开；面板只读显示，提示“预设默认工具，不能关闭”；`setTool` 对静态返回 `TOOL_STATIC_LOCKED`。
2. 动态：给一个 session 开 `reply` 组，下一 step 出现；关闭后硬调返回 `UNKNOWN_TOOL`；当前 step 由 guard 拒绝。
3. agent-scoped：给会话开 `files-read`，`read/glob` 在下一 step 出现；workspace/守卫仍生效；关闭后 Capability Set dispose。
4. 工具提示：动态开关变化后的**下一 step**，Chat 显示“工具已更新”；当前 step 不变；静态不触发面板提示。
5. 上下文：三个会话订阅、两个未订阅；事件只到三个；`visibility` 只能缩小。
6. 主动/被动：主动事件合并唤醒一轮；被动事件只在下一次输入时可见；TTL 丢弃有日志。
7. 重启：Host 挂载一次，静态/动态/订阅/队列恢复；不逐会话重灌；离线会话恢复后继续。
8. App Bridge managed：app 消息 -> 真实 user message + snapshot -> 主意识回复 -> app 收到；Router 能看到 app 消息。
9. 失败语义：可选动态扩展 gate 抛错时该工具隐藏且 step 不失败；reply 组 gate 失败时 step 失败并报错。
10. 预设边界：preset-manager 独立可用；预设 definition 的静态工具面不被面板修改；面板没有“编辑预设”。
11. 包边界：只装 preset-manager（无面板）时它自行挂核心并全局开关；只装面板时核心正常、catalog 为空；两者任意顺序共用一个核心。
12. 优先级：`session > preset > global`；global=false+preset=true 只开该预设；global=true+preset=false 只关该预设；无覆盖时继承 global。

## 11. 参考

- [ElyH 插件架构 v2](elyh-plugin-architecture.zh.md)
- [ElyH 预设管理器方案](elyh-preset-manager.zh.md)
- [ElyH 前两个预设](elyh-two-presets.zh.md)
- [DSH tools：conditional tools 与 guard](../../dsh/packages/core/tools/README.md)
- [DSH web-app：tool-web/tool-fs/tool-skill 的 host/preset 分层](../../dsh/packages/bundle/web-app/cordis.patch.yml)
- [current-time：snapshot 注入范式](../../plugins/conscious-mind/src/current-time.ts)
- [subconscious model：isExternalInput 的 snapshot 过滤](../../plugins/subconscious/src/model.ts)
