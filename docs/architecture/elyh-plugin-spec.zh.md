# ElyH 插件开发规范（v2.0）

> 状态：2026-11-25。旧版 `capability-core` / `capability-host` / 全局工具开关方案已废弃；旧文档和旧代码只保留为前端参考与迁移材料。
>
> 本文是今后 `plugins/*` 的模板与验收基线。与本文冲突时，以本文为准。
> 迁移范围与开发顺序见 [Elysia/VillV-Helix 开发步骤](elysia-villv-helix-development.zh.md)。
>
> 原则：**插件独立运行；一个插件一个包；Host 与强相关 Client 不拆包；工具插件就是正常工具插件；编排插件单独负责会话编排；不引入插件级全局开关。**

## 1. 适用范围

适用于本仓库新增或重构的 `plugins/*` 插件，不适用于 `dsh/` 内的上游包。

一个插件至少满足：

- 能在 profile 中单独添加、单独移除；
- 移除后不留下工具、事件 kind、槽位、监听器、定时器或写文件句柄；
- 有自己的测试，覆盖挂载与卸载；
- 文档写清它提供什么、挂到哪里、权限、失败行为和状态位置。

## 2. 包的形状

| 类型 | 是否允许 | 结构 |
|---|---|---|
| Host-only | 允许 | `src/index.ts`，无 `dsh.client` |
| Host + Web 页面，强相关 | **默认** | 同一包内 `src/index.ts` + `src/client/*`；`package.json` 同时声明 `dsh.client` 与 `dsh.bundle` |
| 把一个插件的 Host 和 Client 拆成两个包 | 禁止 | 会造成安装、卸载、版本、依赖分裂 |
| 独立共享核心包 | 当前目标下不需要 | 新架构不再引入 `capability-core` 这类第三方共享状态包 |

规则：

- 本插件自己的 Host 状态与自己的 Web 页面，必须同包。
- 不要为了“以后可能复用”提前拆包；出现第二个真正独立的消费者时再评估。
- `villv-helix` 是一个完整的 Host + Client 编排插件，不是外部 core 的消费者。

### 2.1 Elysia 主题插件命名

主题插件使用统一身份格式：

```text
显示名：Elysia/<Character>-<Signet>
包名：@elysia/<character>-<signet>
插件 id：<character>-<signet>
目录：plugins/<character>-<signet>/
```

示例：

| 显示名 | 包名 / 插件 id | 目录 | 职责 |
|---|---|---|---|
| **Elysia/VillV-Helix** | `@elysia/villv-helix` / `villv-helix` | `plugins/villv-helix/` | 会话编排 |
| **Elysia/Mobius-Infinity** | `@elysia/mobius-infinity` / `mobius-infinity` | `plugins/mobius-infinity/` | 预设管理 |

规则的边界：

- 显示名使用角色与刻印的品牌写法；包名和 id 使用小写、连字符。
- 官方英文拼写可以与显示名不同：Vill-V of Helix、Mobius / Infinity；显示名由产品决定。
- 主题命名只用于 Elysia 系列；普通功能插件仍可使用功能性名字。
- 同一插件不能在文档、包名、插件 id 之间混用旧名字。

预设管理插件也按主题命名：

```text
显示名：Elysia/Mobius-Infinity
中文名：梅比乌斯 · 无限
包名：@elysia/mobius-infinity
插件 id：mobius-infinity
目录：plugins/mobius-infinity/
```

它保留预设管理职责，但**不再提供“为模型全局注入预设管理工具”开关**。

## 3. 目录模板

```text
plugins/<name>/
  package.json
  cordis.patch.yml
  README.md
  tsconfig.json
  tsconfig.build.json
  tsdown.config.ts          # 仅当有 dsh.client
  vitest.config.ts
  src/
    index.ts                # Host 入口：name / inject / Config / apply
    ...
    client/                 # 仅当有 Web 页面
      index.ts
      api.ts
      locales.ts
      *.tsx
      *.module.css
  tests/
    host.spec.ts
    client-*.spec.ts        # 仅当有 Web 页面
```

约定：

- `src/index.ts` 是 Host 的唯一入口；不要从 `src/client` 反向 import Host 内部实现。
- Client 只通过 Connection RPC / Remote 访问 Host，不直接读写 Host 状态文件。
- `cordis.patch.yml` 只放一个 bundle row。
- `lib/`、`node_modules/`、`pnpm-lock.yaml` 不提交；`lib/client.js` 由 `bundle` 生成。

## 4. package.json

```json
{
  "name": "@elysia/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./src/client/index.ts",
      "default": "./lib/client.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "files": [
    "lib/**/*.js",
    "lib/**/*.d.ts",
    "lib/**/*.map",
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.css",
    "cordis.patch.yml",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "bundle": "tsdown",
    "test": "vitest run --maxWorkers=1 --no-file-parallelism",
    "typecheck": "tsc --noEmit"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-slots"
      ]
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

规则：

- 没有 Web 页面时删除 `exports["./client"]`、客户端 `files`、`dsh.client` 和 `tsdown.config.ts`。
- `peerDependencies` 只列真正需要的运行时服务；`devDependencies` 用 `link:` 指向 `dsh/`。
- 不再声明 `@elysia/capability-core` 或 `@elysia/capability-panel` 依赖。
- 工具插件不安装编排插件也能运行；编排插件只是可选的会话管理层。

## 5. cordis.patch.yml

```yaml
# <name>: one bundle row owns Host and (optional) browser half.
- insert:
    - id: elysia-<name>
      name: '@elysia/<name>'
      config:
        stateDir: !!js dshHomePath('<name>')
```

规则：

- row id 使用 `elysia-<name>`，与包名对应。
- 有持久状态才传 `stateDir`；状态目录必须在 harness home 下，通过 `dshHomePath()` 生成。
- **不再有 `global` 配置项，也没有插件级全局开关。**
- 一个 bundle 只插一行；Client 由同包的 `dsh.client` 自动进入浏览器 roster。
- profile 的 `dependencies` 与 `dsh.profile.bundles` 各加一次，移除时两处一起删。

## 6. 工具插件规范

### 6.1 正常注册，不做开关

工具插件就是普通工具插件：

```ts
export const name = 'elysia-<name>'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '<domain>_<action>',
    description: 'One sentence the model can act on.',
    parameters: {},
    async execute(args, exec) {
      exec.signal.throwIfAborted()
    },
  })), 'elysia-<name>.tool')
}
```

规则：

- 工具插件**不提供** `global` 配置，不提供“为模型全局注入……”开关，不读写全局工具状态。
- 不做“注册/注销”式开关；工具在插件挂载时注册，在卸载时 dispose。
- 不依赖编排插件也能工作；编排插件不在时，工具就是正常全局工具。
- 不把工具注册到 `villv-helix` 的 catalog；编排插件只“拉取”实际工具，不接收工具推送。
- 同一个工具名只能有一条注册路径。

### 6.2 作用域

| 方式 | 适用 |
|---|---|
| 全局 `ctx.tools.register()` | 普通工具；所有普通会话可见，编排会话由编排插件按 session 限制 |
| 预设 / Agent 行内注册 | 只有该预设或 Agent 需要的工具；不进入编排插件控制范围 |
| 编排插件按 session 限制 | 只作用于全局工具；不能凭空创建或恢复未注册的工具 |

如果需要“只在某个预设出现”，就在该预设行挂载工具，不要做插件级开关。

### 6.3 中文显示名

工具和上下文事件仍然必须有中文显示名，但不再通过 `capabilityHost.registerToolName` 或 catalog 提供。

推荐方式：

- 工具插件在客户端或 Host 侧提供一份**显示名元数据**：`toolId -> nameZh`；
- 编排插件存在时，工具栏显示中文名；不存在时退回原始工具 id，不影响工具运行；
- 上下文事件在注册 kind 时直接带 `nameZh`。

工具插件可选地调用编排插件的**纯显示元数据**接口：

```ts
ctx.inject(['villvHelix'], scope => {
  const helix = scope.get('villvHelix')
  if (helix === undefined) return

  scope.effect(
    () => helix.registerToolName('<domain>_<action>', '中文动作名'),
    'elysia-<name>.tool-name',
  )
})
```

这个调用只影响显示名，不改变工具注册、可见性或开关；没有编排插件时直接跳过，工具照常工作。

要求：

- 中文名短、可读、动作明确，例如“创建预设”“列出任务”。
- 不得把中文名写成工具 id 的重复或拼动态状态。
- 中文名只影响展示，不参与模型 schema，不影响工具可见性。
- 新增工具没有中文名时，编排插件显示 id 并记录诊断，不得伪造翻译。

### 6.4 工具命名、schema 与执行

- 工具名：`snake_case`，带领域前缀，如 `team_task_create`、`schedule_create`。
- 描述：第一句写动作和对象，第二句写边界/副作用。
- 参数：JSON Schema；必填项显式声明；不要把 secrets 放进默认值或描述。
- 执行：首行 `exec.signal.throwIfAborted()`；外部调用有超时和错误分类。
- 输出：结构化、可序列化；模型展示文本在 `output.render` 明确生成。
- 审批：有写副作用、安装、账号、外发消息的工具必须走 DSH approval/permission。
- 失败：抛稳定 code 的错误，不返回“成功但没做什么”。
- 不创建 session；不替用户选择预设；不把工具调用变成隐藏后台任务。

## 7. 上下文事件规范

上下文事件与工具不同：编排插件无法从工具注册表推断事件 kind，因此 provider 必须声明并发布。

### 7.1 注册 kind

```ts
ctx.inject(['villvHelix'], scope => {
  const helix = scope.get('villvHelix')
  if (helix === undefined) return

  scope.effect(() => helix.registerContextKind({
    kind: '<plugin>.<event>',
    nameZh: '中文事件名',
    description: 'One line describing what the event carries.',
    activeByDefault: false,
    ttlMs: 15 * 60_000,
    maxBytes: 65_536,
    maxQueueDepth: 64,
  }), 'elysia-<name>.context-kind')
})
```

规则：

- `kind` 用 `<plugin>.<event>`，全局唯一，不带版本号。
- `nameZh` 必填。
- `description` 是面板和模型都能读的一行说明。
- `activeByDefault: false` 表示默认不唤醒轮次；主动事件才显式 `true`。
- 注册必须放在 `ctx.effect` 中，卸载时 kind 一起消失。
- 重复 kind 是 provider bug，编排插件应抛错，不要静默覆盖。
- 没有编排插件时，上下文功能没有 Host 总线；provider 应明确降级，不要注册私有总线伪装成面板事件。

### 7.2 发布事件

```ts
await ctx.villvHelix.publish({
  kind: '<plugin>.<event>',
  source: '<plugin>',
  summary: 'Short, model-readable sentence; no secrets.',
  payload: { /* JSON-serializable */ },
  active: false,
  dedupeKey: '<stable-key>',
  visibility: { presetIds: ['...'] },
})
```

要求：

- `source` 用稳定插件 id，方便事件日志归因。
- `summary` 一行，不塞完整 payload 或隐私字段。
- `payload` 必须 JSON 可序列化、有大小上限。
- `dedupeKey` 用于重试/重复投递。
- `visibility` 只能收窄目标，不能绕过订阅。
- `publish` 返回投递计数；失败/抑制是正常结果。
- 事件是上下文注解，不是用户命令；不要把“请执行 X”写进 payload。
- 发布前先注册 kind；未注册 kind 应被拒绝。

## 8. 编排插件规范：Elysia/VillV-Helix

### 8.1 身份

```text
显示名：Elysia/VillV-Helix
中文名：维尔薇 · 螺旋
Official identity：Vill-V of Helix
English package：@elysia/villv-helix
Plugin id：villv-helix
目录：plugins/villv-helix/
```

官方英文写法是 **Vill-V of Helix**；显示名使用 **Elysia/VillV-Helix**，包名使用小写 `@elysia/villv-helix`。用户界面的模式名仍是 **会话编排模式**。

### 8.2 一个包

`@elysia/villv-helix` 是**一个插件包**：

```text
src/index.ts        Host：会话模式、工具限制、事件总线、预设预览数据
src/client/*        会话页、顶部标签、模式胶囊
```

没有外部 `capability-core`，没有第二个“panel”包。

### 8.3 会话编排模式

- 会话标题栏有一个胶囊：**会话编排模式**。
- 关闭：普通会话，只显示 `对话 | 轨迹 | 上下文`；全局工具正常可见。
- 开启：编排会话，显示全部标签；所有全局工具初始 deny；预设静态工具保留。
- 模式持久化到 session；切换不新开会话；下一次 step 生效。
- 现有会话和新会话都可以切换。
- 关闭编排模式时移除限制；开启时安装限制。

### 8.4 顶部标签

不换排、不加第二排：

```text
对话 | 轨迹 | 上下文 | 工具 | 事件 | 日志 | 健康 | 预设
```

- 普通会话只显示前三个。
- 编排会话显示全部。
- 窄屏时横向滚动，不折行。
- 当前停在编排标签时关闭模式，自动回到“对话”。

### 8.5 各标签职责

| 标签 | 职责 |
|---|---|
| 工具 | 当前会话全局工具的实际状态；只写 session 限制 |
| 事件 | 当前会话的上下文事件订阅 |
| 日志 | 当前会话的事件日志 |
| 健康 | 当前会话队列、消费、失败；Host 全局健康只做摘要 |
| 预设 | 当前预设的工具面、系统提示词、注入的提示词文件预览；只读 |

### 8.6 会话工具限制

- 工具插件只负责全局注册。
- 编排插件从 `ctx.tools.definitions()` 拉取全局工具。
- 每个 live Agent 安装 `tools.restrict`；新 Agent 在 `agent/created` 安装；现有 Agent 在启动时枚举安装。
- 工具注册/注销时监听 `tools/change` 并重算。
- 只有 global 工具可被限制；预设/Agent scoped 工具只展示，不承诺控制。
- 默认普通会话不限制；编排会话 deny 全部 global，只保留静态工具；用户按 session 放行。

### 8.7 预设标签

只读展示：

- 当前预设的静态工具面；
- 当前会话实际组装的 system prompt；
- 预设引用的提示词文件列表；
- 提示词文件内容预览。

不在此页编辑预设、提示词或文件。

### 8.8 中文翻译

- 编排插件所有 UI 文案必须有中文和英文 locale。
- 工具/上下文显示名优先中文，id 作为代码保留。
- 编排插件暴露 `registerToolName(toolId, nameZh)` 作为可选显示元数据；它不控制工具开关。
- 事件 kind、工具 id、包名、插件 id 不翻译。
- 缺少中文名时显示 id 并记录诊断，不在 UI 里伪造名称。

## 9. Client 规范

只有需要 Web 页面时才写 `src/client`。

- 使用 Connection RPC / Remote 访问 Host，不直接读状态文件。
- 所有 slot、listener、定时器、订阅必须在 effect 内清理。
- 不在 Client 重新实现 Host 状态机；Client 只投影 Host 数据。
- 动态标签必须通过会话 header/view slot 条件注册，不要直接改 DSH 原生导航。
- 同一文档的多个 UI 用事件同步；跨标签页用 BroadcastChannel；禁止轮询。

## 10. 测试与验收

工具插件至少覆盖：

- 单独安装、单独卸载；
- 工具真的注册、真的 dispose；
- 没有编排插件时仍可用；
- 中文显示名元数据存在时显示中文，不存在时退回 id。

编排插件至少覆盖：

- 普通/编排模式切换，持久化，下一步 schema 变化；
- 现有 live Agent 和新 `agent/created` 都会安装限制；
- `tools/change` 后新工具进入控制；
- 编排会话初始只有静态工具；
- session 放行/关闭正确；
- 顶部标签在普通/编排模式下正确出现/消失；
- 事件日志、健康、预设预览按 session 取数；
- 切换模式不新开会话；
- 卸载时清理所有 restriction、监听器、slot。

## 11. 踩坑

### 11.1 不要用一次性 `ctx.get` 后永久 return

服务异步挂载；需要等待时使用 `ctx.inject` / 生命周期事件，不要在 `apply` 里判断一次就退出。

### 11.2 不要把工具开关做成插件私有布尔值

新架构没有插件级全局开关。工具插件只注册普通工具；会话限制由编排插件统一管理。

### 11.3 `restrict` 只作用于 global 工具

预设/Agent scoped 工具不受影响；不要承诺控制它们。

### 11.4 不要靠轮询

会话限制、工具变化、标签状态都应由事件驱动。

## 12. 交付清单

- [ ] 一个插件一个包；Host 与强相关 Client 未拆包。
- [ ] 没有 `capability-core` / `capability-panel` 依赖。
- [ ] 工具插件没有 `global` 配置和全局注入开关。
- [ ] `cordis.patch.yml` 只有一行；profile 依赖与 bundle 同步。
- [ ] 工具/事件有中文显示名或明确降级诊断。
- [ ] 编排插件只依赖自己的 Host + Client。
- [ ] 所有注册、监听、定时器、slot 都在 effect 内。
- [ ] 状态目录在 home 下，并加入 `.gitignore`。
- [ ] `typecheck`、`test`、`build`、`bundle` 通过。
- [ ] README 和架构文档已更新。