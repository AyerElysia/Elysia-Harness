# ElyH 插件开发规范（v1.0）

> 状态：2026-11-24。依据 `@elysia/preset-manager`、`@elysia/capability-core`（Host-only）与 `@elysia/capability-host`（可选 Client 面板）的现有实现整理。
> 本文是今后 `plugins/*` 的模板与验收基线；与代码冲突时先改代码或先改本文，不要让两种说法并存。
> 原则：**插件独立运行；一个插件一个包；Host 与强相关 Client 不拆包；共享 Host 核心只允许一个 Host-only 包；上下文事件必进面板；工具默认不全局注册。**

## 1. 适用范围

适用于本仓库新增或重构的 `plugins/*` 插件，不适用于 `dsh/` 内的上游包。

一个插件至少满足：

- 能在 profile 中单独添加、单独移除；
- 移除后不留下工具、事件 kind、槽位、监听器或写文件句柄；
- 有自己的测试，测试覆盖挂载与卸载；
- 文档写清它提供什么、挂到哪、默认状态、权限和失败行为。

## 2. 包的形状：一个插件只做一个包

| 类型 | 是否推荐 | 结构 |
|---|---|---|
| Host-only | 可以 | `src/index.ts`、无 `dsh.client` |
| Host + Web 面板，强相关 | **默认做法** | 同一包内 `src/index.ts` + `src/client/*`；`package.json` 同时声明 `dsh.client` 与 `dsh.bundle` |
| 共享 Host 核心 | 允许（确有多个消费者时） | 独立 Host-only 包，无 `dsh.client`、无 React；面板插件只做可选消费者 |
| 把 Host 和 Client 拆成两个包 | 禁止（强相关时） | 会让安装/卸载/版本/依赖分裂 |

判定规则：

- 面板只是为了展示或编辑本插件自己的 Host 状态 → 必须同包。
- Client 是可替换的独立产品，且 Host 没有它也能完整工作 → 才允许拆包；目前本仓库的**共享 Host 核心**是唯一例外。
- 不要为了“以后可能复用”拆包。先同包，等出现第二个独立消费者再拆。

### 2.1 共享 Host 核心（允许的唯一拆包例外）

当两个以上独立插件需要**同一份** Host 状态（例如全局工具开关、catalog、gate、guard）时，抽出 Host-only 核心包：

- 核心包无 `dsh.client`、无 React、无面板 CSS，不 import 任何面板包；
- 核心包拥有状态、catalog、优先级解析、`when` 门、call guard、变更事件与持久化；
- 面板包是核心的**可选消费者**，只负责展示与操作，不拥有第二份状态；
- 每个消费者依赖核心包，不依赖面板包；
- 核心提供 `ensure<Core>(ctx, config)`：首次调用在 application root 挂载一次，后续消费者复用同一个服务；消费者自己的 `apply()` 不得因为“核心当时不在”而永久跳过注册；
- 示例：`@elysia/capability-core` 由 `@elysia/preset-manager` 与可选面板 `@elysia/capability-host` 共用。服务名保留 `capabilityHost` 仅为兼容现有面板 RPC，包依赖必须写 `@elysia/capability-core`，不得写面板包。

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
    ...                     # Host 服务、状态、校验、错误
    client/                 # 仅当有 Web 面板
      index.ts
      api.ts
      locales.ts
      <Pages>.tsx
      <Pages>.module.css
  tests/
    host.spec.ts
    client-*.spec.ts        # 仅当有 Web 面板
```

约定：

- `src/index.ts` 是 Host 的唯一入口；不要从 `src/client` 反向 import Host 内部实现。
- `src/client` 只通过 Connection RPC 或 `ctx.remote` 访问 Host；不得直接读写 Host 的状态文件。
- `cordis.patch.yml` 只放一个 bundle row；包内部子插件（如 capability-set）按需由预设/Agent 挂载，不在 patch 里重复。
- `lib/`、`node_modules/`、`pnpm-lock.yaml` 不提交；`lib/client.js` 由 `bundle` 生成。

## 4. `package.json` 模板

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

- 没有 Web 面板时删除 `exports["./client"]`、`files` 里的客户端项、`dsh.client`、`tsdown.config.ts`。
- `peerDependencies` 只列运行时真正需要的服务包；`devDependencies` 用 `link:` 指到 `dsh/`。
- 需要 `capabilityHost` 服务的插件必须显式声明对 `@elysia/capability-core` 的依赖（profile 依赖或包内 peer），不要靠“碰巧被别的 bundle 装了”；不要依赖 `@elysia/capability-host` 面板包。
- 客户端 bundle 的产物名必须是 `@elysia/<name>/client`；`tsdown.config.ts` 只过滤自己的客户端入口。

## 5. `cordis.patch.yml` 模板

```yaml
# <name>: one bundle row owns Host and (optional) browser half.
- insert:
    - id: elysia-<name>
      name: '@elysia/<name>'
      config:
        stateDir: !!js dshHomePath('<name>')
        global: false
```

规则：

- row id 使用 `elysia-<name>`，与包名对应。
- 有持久状态才传 `stateDir`；状态目录必须在 harness home 下，通过 `dshHomePath()` 生成，不写绝对机器路径。
- `global` 是**工具全局注册开关**，只对提供工具的插件有意义；默认必须是 `false`（见第 6 节）。
- 一个 bundle 只插一行。不要在这里再插 `@elysia/<name>/client`；Client 由同包的 `dsh.client` 自动进入浏览器 roster。
- profile 的 `dependencies` 与 `dsh.profile.bundles` 各加一次 `@elysia/<name>`，移除时两处一起删。

## 6. 工具规范

### 6.1 中文名参数（强制）

每个工具和每个上下文事件都必须有中文显示名，字段名固定为 `nameZh`。它是面板显示名，不参与模型 schema，也不改变工具 id。

- 面板 catalog 工具：在 `ToolCatalogEntry` 上设置 `nameZh`。
- 直接 `ctx.tools.register` 的工具：调用 `capabilityHost.registerToolName(toolId, nameZh)` 补充显示名；该调用只提供标签，不把工具变成面板开关。
- 上下文事件：在 `registerContextKind({...})` 中设置 `nameZh`。

```ts
host.registerToolName('<domain>_<action>', '中文动作名')
```

要求：

- 中文名必须短、可读、动作明确，例如“创建预设”“列出预设”“读取后台任务输出”。
- 不得写成工具 id 的重复，例如 `preset_create` 不能再显示成 `preset_create`。
- 不得在中文名里拼动态状态、版本号或参数；需要时用描述表达。
- 未提供 `nameZh` 的新插件视为不合规；面板会退回原始 id，这是兼容行为，不是推荐行为。
- 中文名与英文/原始 id 同时显示时，中文名在前，id 作为代码保留。

### 6.2 默认不全局注册（强制）

**默认禁止全局挂载工具。** 每个提供工具的 Host 插件必须暴露一个布尔配置，名字固定为 `global`，默认 `false`：

```ts
export interface Config {
  /** 是否把本插件工具注册到 root scope；默认关闭。 */
  global?: boolean
}

export const Config = z.object({
  global: z.boolean().default(false),
})
```

- `global: false`（默认）：**严禁**直接用 `ctx.tools.register` 把工具变成模型可见的 root 工具；安装插件本身不得改变任何会话的工具面。需要逐预设开关的 catalog 条目可以存在，但必须由 core gate 默认关闭，模型 schema 不可见。
- `global: true`：profile 的启动默认值；独立 UI 开关可以把 core 的 global state 打开到 `true`，并在重启后保留。
- 独立 UI 开关可以从默认 `false` 打开到 `true`；这是用户明确 opt-in 的运行时路径，不能靠代码默认值或环境变量隐式打开。
- 预设行/Agent 行挂载的 scoped 工具不受 `global` 影响；它们只在该作用域出现。
- 全局开关必须写进 README，并有一个测试断言 “默认 false 时模型看不到工具、显式 true 后才出现、重启保持”。
- 默认关是安全默认：插件装了但没配 `global: true` 时，模型看不到工具，这是预期行为。

```ts
export const name = 'elysia-<name>'
export const inject = ['tools']

export function apply(ctx: Context, config: Config): void {
  if (config.global !== true) return
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '<domain>_<action>',
    description: 'One sentence the model can act on.',
    parameters: {
      // JSON Schema only; no hidden state.
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      // ...
    },
  })), 'elysia-<name>.global-tool')
}
```

### 6.3 三种注册方式

| 方式 | 是否进面板 | 默认可见性 | 适用 |
|---|---|---|---|
| 直接 `ctx.tools.register` | 不要求；实际挂载后面板会自动读到 | 由挂载作用域决定 | 普通工具，不需要逐预设开关 |
| 预设/Agent 行内注册 | 不要求 | 只在该作用域 | 只有某些预设需要的能力 |
| `capabilityHost.registerTool` catalog | 是 | 由 capability core 的 gate 控制 | 需要逐预设/会话开关、工具组、统一 guard 的工具 |

关键边界：

- **工具不需要为了存在而注册到面板。** 面板会自动发现实际挂载的工具；只有需要面板开关/工具组时才注册 catalog。
- 注册 catalog 不等于自动全局注册；`scope: 'global'` 条目可以存在，但必须由 gate 默认关闭，模型 schema 不可见；`scope: 'agent'` 由 capability-set 在预设/Agent 作用域挂载。`global` 配置只作为首次默认值，不得用来阻止 catalog 发布（否则 global=false 时无法按预设单独开启）。
- 同一个工具名只能有一条注册路径：要么直接注册，要么 core catalog 托管；不得两处同时注册同名工具。
- 面板只管理它知道的动态/实际工具，不会替插件保存一份独立的“启用列表”。

### 6.4 可选的面板 catalog

需要面板开关时，插件先 `ensureCapabilityCore`，再用 `ctx.inject(['capabilityHost'], ...)` 注册 catalog；`scope: 'global'` 条目默认由 gate 关闭，等待预设/会话显式开启（异步时序见 13.1）：

```ts
await ensureCapabilityCore(ctx, config)
ctx.inject(['capabilityHost'], async scope => {
  const host = scope.get('capabilityHost')
  if (host === undefined) return
  await host.ready
  scope.effect(() => host.registerTool({
    id: '<domain>_<action>',
    nameZh: '中文动作名',
    scope: 'agent',                 // 或 'global'；global 条目默认 gate 关闭
    description: 'One sentence the model can act on.',
    required: ['tools'],
    group: '<optional group>',
    failureMode: 'closed',
    factory: scope => defineTool({
      name: '<domain>_<action>',
      description: 'One sentence the model can act on.',
      parameters: {},
      async execute(args, exec) {
        exec.signal.throwIfAborted()
      },
    }),
  }), 'elysia-<name>.catalog')
})
```

要求：

- `id` 必须稳定、snake_case、全局唯一；不能随配置改名。
- `description` 同时是模型描述和面板说明，写清边界，不写实现细节。
- `factory` 必须是同步纯构建；不要在 factory 里发网络请求或写文件。
- 有 `required` 服务时，缺失就报 `TOOL_MOUNT_FAILED`，不要静默注册一个坏工具。
- 面板开关只控制这个 catalog 条目；真正的调用 guard 由 Host/Capability Set 负责，插件不要另写一套“面板开关”状态。

### 6.5 命名、schema 与执行

- 工具名：`snake_case`，带领域前缀，如 `team_task_create`、`schedule_create`；不要用 `run`、`do`、`tool1`。
- 描述：第一句写动作和对象；第二句写边界/副作用；不要靠参数名解释一切。
- 参数：只用 JSON Schema；所有必填项显式声明；不把 secrets 放进默认值或描述。
- 执行：首行 `exec.signal.throwIfAborted()`；尊重 `exec.signal`；外部调用要有超时/错误分类。
- 输出：返回结构化、可序列化结果；需要模型展示的文本在 `output.render` 明确生成。
- 审批：有写副作用、安装、账号、外发消息的工具，必须走 DSH 的 approval/permission 机制；不要自己弹确认框。
- 失败：抛带稳定 code 的错误；不要返回“成功但什么都没做”的模糊结果。
- 不要创建 session；不要替用户选择预设；不要把工具调用变成隐式后台任务。

### 6.6 独立全局工具开关（UI 规范）

当插件在自己的设置页或面板里提供“让所有会话都能用这个工具”的开关时，必须遵守本节。

**文案固定**：

```text
为模型全局注入<nameZh>工具
```

例如 `nameZh = '创建预设'` 时，开关必须是 **“为模型全局注入创建预设工具”**。一个开关覆盖多个工具时，`xxx` 用该组的中文名，例如 **“为模型全局注入预设管理工具”**。不要写成“全局注入模型工具”“全局开启”“对所有会话生效”“Enable globally”等自由文案。

**位置固定**：开关放在插件页面标题栏的右侧，与页面主操作按钮同一行，做成紧凑的一行控件（标签 + 复选框）；不要单独占一张“模型工具”设置卡片。

必须满足：

- **默认关闭**：新装的插件不自动开启任何全局工具。
- **使用共享核心的同款方案**：开关只能绑定 `@elysia/capability-core` 的 global tool catalog/state/gate/guard，不得用插件自己的布尔值、重新注册/注销工具或重启进程来模拟。面板包只是这个核心的可选消费者，不是依赖目标。
- **可自由开关**：每次切换都写核心的全局工具状态；状态跨重启保留，显式关闭优先。
- **优先级固定**：`session 显式 > preset 显式 > global 默认`。因此 `global=false + preset=true` 只开该预设；`global=true + preset=false` 只关该预设；没有显式覆盖时继承 global。
- **实时注入**：
  - 开启后，下一次模型请求的 tool schema 立即包含该工具及其中文名/描述；不需要新会话、不需要重启。
  - 关闭后，下一次模型请求不再包含该工具；已准入但尚未执行的调用由 Host guard 拦截。
  - 用 `capability-core/change`（兼容别名 `capability-host/change`）通知 UI / Capability Set 重新同步，不允许插件自己维护第二套“已注入”状态。
- **提示模型**：工具出现/消失由 DSH 每步重新组装的 tool schema 自然完成；如果还需要额外说明，使用每步可重读的 system-prompt section 或工具 description，不得伪造一条 `user/message` 当作注入提示。
- **启动默认与运行时开关**：插件的 `global` 配置只是启动默认值，默认 `false`；独立开关必须能从关切换到开。开关为关时不得让模型在 root 工具清单里看到该工具；全局 catalog 条目可以存在，但必须由 Host gate 默认关闭。用户显式开启后才允许注入。开关状态必须持久化，不能每次重挂载都回到默认。
- 插件卸载、Host 重启、会话切换都不能把用户关闭的全局工具重新打开。

实现状态：

- `@elysia/capability-core` 的 global tool scope 已实现：`globalTools`、`setTool({ kind: 'global' })`、`capability-state.json` 持久化、step gate 和 call guard 共用同一状态；服务名保留 `capabilityHost` 以兼容面板 RPC。
- `preset-manager` 是本节参考实现：两个工具始终作为 `scope: 'global'` catalog 条目发布；开关只写核心全局状态，不重新注册工具；包依赖只写 `@elysia/capability-core`，不 import 面板包。旧的两态切换（root 注册 / catalog 互斥）已删除，不得复制。
- 仍然禁止用插件本地开关冒充“全局生效”，禁止直接 `ctx.tools.register/unregister` 绕过核心 gate。
- **异步挂载**：不得在 `apply` 里用一次性的 `ctx.get('capabilityHost')` 判空后永久返回；应先 `ensureCapabilityCore(ctx, config)`，再用 `ctx.inject(['capabilityHost'], ...)`、`await host.ready`，在 effect 里注册和清理。核心后挂载时工具也必须出现；这是 13.1 记录的实际事故。

验收至少覆盖：

- 只安装 preset-manager、不安装面板：预设工具可以全局开关，下一步能看到/失去工具；
- 只安装面板、不安装 preset-manager：面板自身正常，catalog 为空；
- 两者都装、任意挂载顺序：面板出现 `preset_create` / `preset_list`，且只有一个核心实例；
- 优先级：`session > preset > global`；global=false + preset=true 只开该预设；global=true + preset=false 只关该预设；无显式覆盖时继承 global；
- 开关默认关闭；切换后不新开会话、不重启，下一步 tool schema 改变；
- 关闭发生在一步中间时，已准入调用被 guard 拒绝；
- 重启后状态保持；显式关闭不会被重新挂载恢复；
- 卸载 preset-manager 后，面板不残留其 catalog 行；重新挂载不重复注册；
- preset-manager 的源码、`package.json` 和构建产物都不出现 `@elysia/capability-host` 依赖。

## 7. 上下文事件规范

### 7.1 必须注册到面板

上下文事件与工具不同：面板无法自动猜出 kind，因此**每个 context provider 必须在挂载时调用 `capabilityHost.registerContextKind()`**。

```ts
export const inject = ['capabilityHost']

export function apply(ctx: Context): void {
  const host = ctx.get('capabilityHost')
  if (host === undefined) {
    throw new Error('elysia-<name> requires @elysia/capability-core for context registration')
  }

  ctx.effect(() => host.registerContextKind({
    kind: '<plugin>.<event>',
    nameZh: '中文事件名',
    description: 'One line describing what the event carries.',
    activeByDefault: false,
    ttlMs: 15 * 60_000,
    maxBytes: 65_536,
    maxQueueDepth: 64,
  }), 'elysia-<name>.context-kind')
}
```

规则：

- `kind` 用 `<plugin>.<event>` 点号命名，例如 `app.message`、`prompt.change`；全局唯一，不带版本号。
- `nameZh` 必填，写短而明确的中文事件名；面板优先显示它，缺失时退回 kind。
- `description` 是面板和模型都能读的一行说明，不写营销文案。
- `activeByDefault: false` 表示默认不唤醒轮次；主动事件才设 `true`，并在描述里说明。
- `ttlMs`、`maxBytes`、`maxQueueDepth` 只在确实需要覆盖 Host 默认值时填写。
- 注册必须包在 `ctx.effect` 中，卸载插件时 kind 和面板条目一起消失。
- 重复 kind 是提供方 bug，Host 会抛错；不要捕获后静默继续。
- 没有 `capabilityHost` 时**失败挂载**，不要注册一个面板看不见的私有事件总线。

### 7.2 发布事件

```ts
await ctx.capabilityHost.publish({
  kind: '<plugin>.<event>',
  source: '<plugin>',
  summary: 'Short, model-readable sentence; no secrets.',
  payload: { /* JSON-serializable, bounded by maxBytes */ },
  active: false,                 // 默认用 kind 的 activeByDefault；主动事件显式 true
  dedupeKey: '<stable-key>',     // 同一 TTL 内重复发布会抑制
  visibility: { presetIds: ['...'] }, // 可选，只能收窄目标，不能扩大订阅
})
```

要求：

- `source` 用稳定插件 id，便于面板事件日志归因。
- `summary` 一行，不能把完整 payload/隐私字段塞进去。
- `payload` 必须 JSON 可序列化、有大小上限；不要放函数、类实例、循环引用。
- `dedupeKey` 用于重试/重复投递；同一语义事件用同一个 key。
- `visibility` 是“再收窄”，不是“白名单绕过订阅”；面板订阅仍是 AND 条件。
- `publish` 返回投递计数；不要假设所有会话都收到，失败/抑制是正常结果。
- 事件是上下文注解，不是用户指令；不要把“请执行 X”写成事件 payload 让模型当命令。
- 发布前先完成注册；未注册 kind 会被 `CONTEXT_UNKNOWN` 拒绝。

### 7.3 面板行为

- 事件 kind 注册后自动出现在“上下文事件”页。
- 默认订阅状态是关闭；用户在预设/会话上显式开启后才投递。
- 面板的“保存上下文”是唯一写入路径；provider 不要自动写订阅状态。
- 事件队列、TTL、去重、合并和投递由 Host 统一负责；插件不要自建第二套队列。
- 卸载 provider 只删除 kind；不清理用户已保存的订阅记录；重新挂载后恢复。

## 8. Client 半规范

只有需要 Web 页面时才写 `src/client`。

### 8.1 入口模板

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { NS, en, zh, type LocaleKey } from './locales.ts'
import { Page } from './Page.tsx'
import { Icon } from './Icon.tsx'

export const inject = ['slots', 'locale', 'connection']
export const PANEL_ID = '<name>' as MainPanelId

export function apply(ctx: Context): void {
  const { rpc } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'elysia-<name>: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createApi(rpc)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ api }),
  }, Page))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS,
    label: () => t('panel'),
  }, Icon))
}
```

规则：

- `dsh.client.inject` 与 Client 的 `inject` 保持一致；缺服务就挂载失败，不要空转。
- 一个插件最多一个 sidebar 入口、一个主面板；不要给每个子功能加一组入口。
- `api.ts` 只做 RPC 适配和形状校验；不要把 Host 类型、状态机、校验逻辑复制到客户端。
- 页面不直接读写文件，不创建 session，不修改 Host 状态文件。
- 页面开关默认只改草稿；只有底部固定“保存”才发写 RPC。初始化显示实际状态，不伪造默认值。
- 长列表要分页/筛选；分类折叠状态只属于 UI，不持久化成权限。
- 文案走 `locales.ts`：中文为 key 源，英文逐 key 对齐；不要在 JSX 里散落中文/英文硬编码。
- CSS 用 `*.module.css` 和 DSW token（`var(--dsw-...)`），不写死颜色；不使用全局选择器污染其他面板。
- 需要固定操作栏时，把 footer 放在滚动容器外；不要让按钮跟着内容滚走。

## 9. 状态、权限与失败

### 9.1 状态

- 只有需要跨重启保存的数据才建 `stateDir`；目录名用插件名。
- 文档必须带 `version`；写入原子化、串行化；未知字段保留或显式诊断。
- 运行态文件放在 harness home，绝不写进源码树；在 `.gitignore` 增加 `homes/*/<name>/`。
- 删除 home 应同时删除插件状态；插件卸载不自动删用户数据，除非 README 明确说明。

### 9.2 权限

- 修改预设/会话开关必须有 owner 校验；没有 owner 时只允许进程内调用（按 Host 现有约定）。
- 工具副作用按 DSH 权限系统处理；不绕过 approval。
- 面板的“关闭”优先级高于插件注册；显式关闭必须跨重启保留（由 Host guard/state 完成，provider 不要自己恢复）。
- 不要用客户端可见的布尔值伪造权限；Host 的 guard 才是权威。

### 9.3 错误

- 自定义错误用稳定 code，命名空间为 `<plugin>/<CODE>`；Remote 包装成 `RemoteError`。
- 用户可读消息写清“发生了什么/怎么修”；技术细节放 details，不塞进一句话。
- 缺少必需服务、状态损坏、重复 kind、未知工具都要 fail loud；不要静默降级成另一个行为。
- Client 只对已知 code 做分类提示；未知错误保留原始信息，不吞掉。

## 10. 测试模板

每个插件至少覆盖：

### Host

- 挂载后注册了什么、卸载后是否全部释放；
- `global: false` 时模型可见工具为空（catalog 条目可以存在，但 gate 必须关闭）；`global: true` 或显式预设/session 开启后才出现；
- 工具参数/返回/错误 code；
- 状态读写、版本、原子写、重启恢复；
- 权限拒绝和 owner 校验；
- 如果使用 catalog：未知 id、静态工具、scope 不存在、重复注册；
- 如果提供 context：kind 出现在 `list().contexts`、publish 校验、订阅/可见性、卸载后 kind 消失。

### Client

- RPC 适配层对 malformed payload 报错，不崩溃；
- 页面 SSR/渲染：空态、错误态、只读态、实际默认状态；
- 保存按钮只在 dirty 时启用；保存后状态清空；
- 长列表/筛选/折叠不丢权限状态；
- 无 Host 面板时 client 不 import Host 内部模块。

### 验收命令

```powershell
cd plugins/<name>
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle   # 仅当有 dsh.client
```

## 11. 文档与交付清单

每个插件必须有 `README.md`，至少写：

- 包名、bundle id、profile 挂载位置；
- 提供哪些工具/上下文事件，默认状态；
- `global` 开关语义和默认值；
- 状态目录和删除行为；
- 权限、失败模式、已知限制；
- 测试命令和已验证范围（源码/单元/真实组合/重启）。

交付前逐项确认：

- [ ] 一个插件一个包；Host 与强相关 Client 未拆包；共享 Host 核心是唯一例外（Host-only、无 Client）。
- [ ] 只改 `plugins/*` 与 profile，不改 `dsh/`。
- [ ] `cordis.patch.yml` 只有一行；profile 依赖与 bundles 同步；共享核心由消费者 `ensure` 或独立行挂载。
- [ ] 工具和上下文事件都有 `nameZh`；直接注册的工具已调用 `registerToolName`。
- [ ] 工具默认不全局注册；`global:false` 时模型看不到工具（catalog 可存在但 gate 关闭），显式预设/session 或全局开关才能打开。
- [ ] 上下文 kind 已 `registerContextKind`，卸载可清理。
- [ ] 所有注册/监听/定时器都在 `ctx.effect` 内。
- [ ] 不创建 session；不替用户选预设；不自动写权限。
- [ ] 状态目录在 home 下，且已加入 `.gitignore`。
- [ ] 中文/英文 locale 对齐；CSS 只用 token。
- [ ] 测试通过；构建和客户端 bundle 均已产出。
- [ ] README 和架构文档已更新。

## 12. 最小骨架（复制起点）

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'elysia-<name>'
export const inject = ['tools', 'capabilityHost']

export interface Config {
  global?: boolean
}

export const Config = z.object({
  global: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): void {
  const host = ctx.get('capabilityHost')
  if (host === undefined) throw new Error('elysia-<name> requires @elysia/capability-core')

  ctx.effect(() => host.registerContextKind({
    kind: '<name>.changed',
    nameZh: '中文事件名',
    description: 'One line describing the event.',
    activeByDefault: false,
  }), 'elysia-<name>.context-kind')

  if (config.global !== true) return

  ctx.effect(() => host.registerToolName('<name>_action', '中文动作名'), 'elysia-<name>.tool-name')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '<name>_action',
    description: 'One sentence the model can act on.',
    parameters: {},
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return { ok: true }
    },
  })), 'elysia-<name>.global-tool')
}
```

> 工具不需要面板关联时，删掉 `host.registerTool` 相关代码即可；上下文事件注册不要删。
> 需要逐预设开关时，把直接 `ctx.tools.register` 换成 `host.registerTool({ scope: 'agent', ... })`，并在预设/Agent 行挂 `@elysia/capability-core/capability-set`。

## 13. 踩坑记录

### 13.1 核心/服务未就绪时一次性 `ctx.get`，工具永远不进入面板

**现象**

- 插件自己的 Host 已启动，UI 也能读到 `capabilityHost=true`。
- 能力面板里没有该插件的工具，`capabilityHost/list` 的 `tools` 数组里也没有。
- `capabilityHost/status` 没有 `TOOL_REGISTRATION_FAILED` / `TOOL_MOUNT_FAILED`，只有其他静态映射诊断。
- 面板按预设/会话显示正常，因此很容易误判成“面板过滤”或“nameZh 不显示”。

**根因**

插件在 `apply()` 里只读一次：

```ts
const host = ctx.get('capabilityHost')
if (host === undefined) {
  await manager.ready
  return
}
// host.registerTool(...) 只在这里执行
```

`capabilityHost` 是异步挂载的服务；`preset-manager` 的 `apply()` 可能先执行，此时 `ctx.get` 返回 `undefined`，代码直接 `return`。之后 core/Host 挂载完成，但**没有任何逻辑重试 catalog 注册**。所以：

- 注册代码从未执行，不是“注册失败”；
- 面板没有任何记录可显示；
- `presetManager/modelTools` 稍后查询时当然能看到 `capabilityHost=true`。

**正确做法**

- 不要用一次性的 `ctx.get` 加 `return` 判断服务存在性。
- 需要共享核心的插件先 `await ensureCapabilityCore(ctx, config)`；它会在 application root 挂载一次核心，后挂消费者复用同一服务。
- 然后用 `ctx.inject(['capabilityHost'], scope => ...)` 等待服务出现；在回调里注册 catalog 条目和名字提示。
- 注册前 `await host.ready`，避免核心 runtime 尚未初始化就调用 `registerTool`。
- 所有注册用作用域 `effect` 清理；回调可能晚于插件卸载，先检查 disposed。
- 如果插件允许无核心独立运行，未挂载核心时只跳过“核心相关”注册，不能连带跳过自己的普通工具。

示意：

```ts
function registerCatalogTools(host: CapabilityHost): () => void {
  const disposeCreate = host.registerTool({ /* ... */ })
  const disposeList = host.registerTool({ /* ... */ })
  return () => {
    disposeList()
    disposeCreate()
  }
}

await ensureCapabilityCore(ctx, config)
ctx.inject(['capabilityHost'], async (scope) => {
  const host = scope.get('capabilityHost')
  if (host === undefined) return
  await host.ready
  // Re-read after the await: the scope may have been replaced.
  const live = scope.get('capabilityHost')
  if (live === undefined) return
  scope.effect(() => registerCatalogTools(live), 'elysia-<name>.catalog')
})
```

**排查顺序**

1. 先调 `capabilityHost/list`，确认工具是否真的在 `tools` 数组里。
2. 不在数组里 → 查 provider 的注册路径和 `apply` 时序；不要再改面板过滤。
3. 在数组里但 UI 不显示 → 再查 `nameZh`、分类、shadowing、scope 选择。
4. 有 `TOOL_REGISTRATION_FAILED` → 查 `required` 服务、factory、重复 id；没有诊断但缺失 → 优先怀疑注册代码没执行。

**必须测试**

- 只挂 `preset-manager`（无面板）：它自行 `ensureCapabilityCore`，catalog 条目出现。
- 只挂面板（无 `preset-manager`）：核心正常、catalog 为空。
- 面板先挂、`preset-manager` 后挂；`preset-manager` 先挂、面板后挂。
- 两种顺序下 `capabilityHost/list` 都包含该插件的工具，且只有一个核心实例。
- 插件卸载后 catalog 条目和名字提示都消失，重新挂载不重复。
