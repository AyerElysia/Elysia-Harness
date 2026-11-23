# ElyH 预设管理器方案（v2）

> 状态：已实现，2026-11-22。范围：本地 Web 的预设创建、列表、删除与工具面配置。
> 不在范围：提示词内容编辑、会话创建、模型选择、cwd/workspace、渠道桥接、记忆检索。
> 关键约束：预设只做“这个预设是谁、看哪些提示词文件、给哪些工具”；工具面由代码维护的封闭目录生成，每个可选项在宿主启动后都经过一次真实激活探测。

## 1. 目标

让操作者可以：

1. 在左侧栏进入预设管理页，查看全部预设并删除管理器创建的预设。
2. 点“新建预设”进入独立创建页；页面上有可见的“返回”，返回列表不丢已读取的列表。
3. 创建时配置工具面：每个可用工具一个开关；默认工具面只有网络搜索；可选默认/常见/现有预设/自定义工具面；选面即改写全部开关。
4. 自定义工具面可命名保存、可删除；默认、常见、现有预设工具面只读。
5. 创建后不编辑内容；要改就删除后重建。

预设管理器不创建会话。创建预设只是把一份 composition 注册进 DSH roster；会话仍然由用户或会话运行时创建。

## 2. 决策摘要

| 决策 | 结论 |
|---|---|
| 入口 | 左侧栏 `sidebar.panellist`（id `presets`，order 30）+ keyed `main` 页面 `presets`；不再使用 `settings.section` |
| 创建表单位置 | 独立创建视图，带“返回”；列表页只保留入口按钮 |
| 内容编辑 | 不做。提示词 md 由外部编辑器维护，管理器只引用 |
| 工具目录 | 代码维护的封闭目录（`src/tool-catalog.ts`），只列本部署能真正组装的工具 |
| 可用性 | `listToolFaces()` 对每个工具注册单行预设、读诊断后销毁；不可用的工具照常列出但标灰并给原因，不进工具面 |
| 工具面 | 默认（仅 `tool-web`）、常见（`none`/`search`/`search-files`/`full`）、现有预设（`compositionInventory()`）、自定义（文档持久化） |
| 选面行为 | 选面重建全部开关；`none` 会把所有开关关掉；之后手动改开关即脱离该面 |
| 删除工具面 | 只删自定义；内置/常见/现有预设面拒绝并返回 `TOOL_FACE_READONLY` |
| 最小工具面 | `web_search` + `web_fetch`（`tool-web`） |
| AGENTS.md | 创建预设时可开关；默认关闭；开启才挂 `agent-instructions` |
| 读图 | 粘贴图走原生视觉输入；`read_image` 不进 Base |
| 文件选择 | 复用 DSH directory picker 选目录，再由 Host 扫描 `.md` 让用户勾选 |
| 运行策略 | code-owned；所有预设自动压缩全开；面板不编辑 |
| 预设持久化 | 管理器自己的文档（v2）+ 启动时 `agentPresets.register()` |
| 删除 | 只删管理器自己的；有会话引用默认拒绝；自定义工具面不随预设删除 |
| 活会话更新 | 预设定义变更不影响活会话；新会话才用新定义 |

## 3. 预设结构

一个预设仍是一份 `@deepseek-ai/dsh-agent-preset` 声明：

```yaml
- id: preset-<id>
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: <id>
    name: <display name>
    description: <description>
    order: <optional>
    plugins:
      # 可选：仅当创建时勾选 agentInstructions
      - id: agent-instructions
        name: '@deepseek-ai/dsh-agent-instructions'
      - id: prompt-files
        name: '@elysia/preset-manager/prompt-files'
        config:
          identity: <required preset identity>
          root: <absolute prompt root>
          files: [SOUL.md, USER.md, MEMORY.md]
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
      # 纯对话面（无工具）时整组省略
      - id: tools
        name: cordis:group
        group: true
        config:
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config:
              auto: true
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

注意：

- `tools` 组只包含记录里保存的工具 id；每个 id 由目录解析成固定的模块与配置。
- `prompt-files` 是预设子插件，不是管理器本身；它负责读取文件、注册系统提示词、监听变化。
- `identity` 必填，渲染在文件内容之前；不要同时再挂 `dsh-persona`，避免两个身份源。
- `time-context` 正常注入；压缩组固定由管理器模板生成，用户不可编辑。
- `tool-bash` / `tool-pwsh` 带 Loader `!!js` 平台门；平台不符时该行不启动，预设仍可组装。

## 4. 工具目录与可用性

### 4.1 目录

`src/tool-catalog.ts` 是唯一来源，当前包含：

`tool-web`、`tool-fs`、`tool-fs-search`、`tool-bash`、`tool-pwsh`、`tool-todo`、`tool-ask-user`、`tool-skill`、`tool-jobs`、`tool-goal`、`tool-subagent`、`tool-agent-team`、`tool-present`、`tool-office`。

目录项自带该行固定配置（例如 `tool-web` 的 `fetch: true, searchTimeoutMs: 60000`），所以同一个 id 永远意味着同一份行配置。

### 4.2 排除项（README 同步说明）

- `tool-working-directory`：宿主层已为每个 Agent 挂载 `working_directory`，预设再挂一行只会重复一个始终存在的工具；预设也无法把它关掉。
- `tool-workflow`：依赖 `workflowEngine`，标准预设是在 preset 内的 isolate 组里用 `workflow-ptc` 提供；裸行会等不到服务。
- `tool-schedule`：宿主 provider 取决于 profile（本 Web profile 自己关掉了 `schedule` 行），可能出现等待或调用失败。
- `tool-lsp`：shipped bundle 没有 `lsp` 宿主行。
- `dsh-plugin-manager/tools`：profile 级插件安装工具，不是预设该选的能力。
- `tool-terminal` / `tool-bash-persistent` / `tool-pwsh-persistent`：属于 `minimal` 预设的终端 isolate 组，需要该组同时挂 `terminal` / `terminals`。
- 实验性工具（`tool-worktree`、`tool-session-query`、`tool-ralph` 等）：其包不在 shipped bundle 中。

### 4.3 可用性探测

`listToolFaces()` 对目录里每个工具：

1. 注册一个只含该工具行的临时预设（id 带随机后缀）；
2. 用 `agentPresets.resolve(id)` 读诊断；
3. 立即 dispose。

诊断为空说明该行真的挂载成功、依赖服务也都满足。不可用的工具仍出现在 `tools` 列表里（`available: false` + `reason`），但不会进入任何工具面。探测结果按进程缓存：宿主服务集合在重启前不会变；如果注册表对所有探测都直接拒绝（说明不是单个工具的问题），则回退到静态目录并打警告日志。

### 4.4 工具面

| family | id | 可编辑 |
|---|---|---|
| default | `default`：仅 `tool-web` | 否 |
| common | `none`（无工具）、`search`、`search-files`、`full` | 否 |
| existing | 每个已注册预设一个，来自 `ctx.agentPresets.compositionInventory()` | 否 |
| custom | 操作者创建，存管理器文档 | 只可删除 |

- 选面即用该面重建全部开关；`none` 会关闭所有开关。
- 之后单独改开关会清掉“当前面”标记，保存的是操作者自己的工具集。
- 现有预设的工具面只保留目录里有的 id；被过滤掉的行写进 `missing`，面标 `partial`。

## 5. 创建流程

### 5.1 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写字母、数字、连字符；创建后不可改 |
| `name` | 是 | 显示名 |
| `description` | 否 | 列表里的说明 |
| `identity` | 是 | “这个预设是什么”；会进入系统提示词 |
| `agentInstructions` | 否 | 是否注入工作区 `AGENTS.md` / `AGENTS.local.md`；默认关闭 |
| `promptRoot` | 是 | 绝对目录；DSH 目录选择器选择 |
| `promptFiles` | 是 | 根目录下的文件列表，至少一个非空 |
| `order` | 否 | roster 顺序 |
| `tools` | 否 | 工具 id 列表；缺省为 `["tool-web"]`，空数组表示纯对话 |
| `toolFace` | 否 | `{ kind, id }`，记录来源面；手动改开关后不写 |

### 5.2 步骤

1. 列表页点“新建预设”进入创建视图。
2. 填写元数据。
3. 选目录；Host 扫描候选文件，用户勾选并排序。
4. 选工具面（默认面已选中，开关为仅 `tool-web`），或逐项开关工具。
5. 如需保存当前开关：填名字 → “保存当前开关为工具面”。
6. 创建：生成 definition（`prompt-files` + `time-context` + `tools` + 固定压缩组；只有勾选时才加 `agent-instructions`），校验后 `agentPresets.register()`，成功再写文档。
7. 回到列表并提示已创建。
8. 任何时候点“返回”直接回列表，不创建。

校验：id 唯一、identity 非空、目录存在、文件在根目录下、至少一个非空文件、工具 id 在目录内、自定义面必须存在。

## 6. 文件选择

DSH 暴露的是 **directory picker**，不是通用文件选择器：

- Windows 桌面：原生资源管理器目录选择器；
- Linux：原生目录选择器；
- Web/browse 后端：应用内目录浏览。

流程：

1. Client 调 `remote.directoryPicker.pick()`，拿到绝对目录。
2. Host 校验目录存在、可读、不是文件。
3. Host 扫描候选文件：默认 `*.md`，按名称排序；返回相对路径与字节数。
4. UI 多选 + 排序。
5. 保存 `root + relative files`。

不要用 `ui-conversation.pickFiles` 的浏览器上传；那是附件上传，不是主机路径选择。若以后要真正的多文件选择器，需要新增 Host `filePicker` seam，不复用 directory picker。

## 7. 列表与删除

### 7.1 列表

合并两个来源：

- `agentPresets.list()`：所有 roster 预设，包括 bundle/profile 声明的。
- 管理器文档：哪些是管理器创建的。

每条显示：

- `id`、`name`、`description`
- `managed: true/false`
- `inUse`: 使用该预设的会话 id
- `diagnostic`: 激活失败原因
- `promptRoot`、文件数、工具数
- `unknownTools`: 文档里本版本目录不认识的工具 id
- `createdAt`

### 7.2 删除

- 非 `managed`：拒绝，提示“bundle/profile 声明，管理器不能删”。
- `managed` 但有会话引用：默认拒绝，返回 `PRESET_IN_USE` + 会话列表。
- `managed` 且无引用：dispose registration，删除管理器文档条目。
- 可选 `force`：仅用于注册已丢失的文档条目；有活会话时仍然拒绝。
- 删除预设不删提示词文件，也不删自定义工具面。

## 8. 持久化与生命周期

管理器文档（`presets.json`，`$DSH_HOME/preset-manager/`）：

```json
{
  "version": 2,
  "presets": [
    {
      "id": "elysia-conscious",
      "name": "爱莉 · 主意识",
      "description": "...",
      "identity": "...",
      "promptRoot": "E:/.../data/elysia",
      "promptFiles": ["SOUL.md", "USER.md", "MEMORY.md"],
      "tools": ["tool-web"],
      "toolFace": { "kind": "default", "id": "default" },
      "order": 10,
      "createdAt": "..."
    }
  ],
  "toolFaces": [
    { "id": "custom-1a2b3c4d", "name": "写作", "tools": ["tool-web", "tool-fs"] }
  ]
}
```

- 读取 v1 文档不重写：没有 `tools` 的记录按 `["tool-web"]` 组装，文档保持 v1，直到下一次写入才升到 v2。
- 显式空数组就是纯对话面，不会被改写成默认面。
- `toolFaces` 只存自定义面；默认/常见/现有预设面每次从代码与注册表重新计算。

生命周期：

1. Host 启动时读取文档。
2. 逐个构造 definition，调 `agentPresets.register()`。
3. 保存每个返回的 disposer；失败保留 diagnostic，不阻塞其他预设。
4. 创建：先 register，成功再写文档。
5. 删除：先 dispose，再删文档；dispose 失败则保留。
6. 进程退出：dispose 所有 manager-owned registrations。

重要：`agentPresets.register()` 是**运行时定义**，不写入 `cordis.patch.yml`，也不写 DSH 的 preset 声明。管理器文档才是事实源。要变成 bundle 内置预设，需要另外生成并安装 bundle，v2 不做。

## 9. 提示词文件监控

`@elysia/preset-manager/prompt-files` 是预设子插件，负责：

1. 每轮组装时重新读取 `root/files`，拼成系统提示词 section（`complete: true`）。
2. 按文件 hash 维护快照，检测 `add / modify / remove`。
3. 在 `agent/pre-step` 注入一条上下文通知：
   - `source.kind = 'elysia-prompt-change'`
   - `form = 'snapshot'`
   - `changes: [{ action, path }]`
   - 只报文件名/动作/摘要，不重复注入全文（全文已经在系统提示词里）。
4. 用 `surfaceOp: 'replace'` 清掉上一轮旧快照，避免越积越多。
5. 每个会话各自维护已通知的 hash，避免重复。

按当前口径：**目录里的所有文件都是可变输入，不做“SOUL 不变”假设**。任何文件变动都通知该预设对应的会话。

当前部署路径：

- 本地开发：`E:\Elysium-AyerElysia\Elysium\Elysia-Harness\data\elysia`
- 服务器：`/home/ayerelysia/Elysia/Data/standing-prompts`

2026-11-22 已从服务器只读复制 7 个文件到本地：`SOUL.md`、`USER.md`、`MEMORY.md`、`CONSCIOUS-MIND.md`、`SUBCONSCIOUS-ROUTER.md`、`SUBCONSCIOUS-MEMORY.md`、`LIVE.md`。服务器配置未改；复制后 SHA-256 全部一致。

## 10. 与工具面板的边界

- 预设管理器：`id/name/description/identity/promptRoot/promptFiles/order/tools/toolFace`。
- 预设管理器负责“这个预设天生带哪些工具”，即预设自身的工具面。
- 工具面板：运行期扩展工具、State Store、`when` 门、`guard`；不替换预设的工具面。
- `modsearch` 是 `web_search` 的 provider，不属于预设。
- 面板扩展默认关闭，按 session/preset 开启；不新开会话。

“一键应用已有预设的工具面”属于预设管理器，入口在创建页的工具面选择器。

## 11. API

```ts
interface PresetDraft {
  id: string
  name: string
  description?: string
  identity: string
  agentInstructions?: boolean
  promptRoot: string
  promptFiles: string[]
  order?: number
  tools?: string[]
  toolFace?: { kind: 'default' | 'common' | 'existing' | 'custom'; id: string }
}

interface PresetSummary {
  id: string
  name?: string
  description?: string
  managed: boolean
  inUse: string[]
  diagnostic?: string
  promptRoot?: string
  promptFileCount?: number
  createdAt?: string
  tools?: string[]
  unknownTools?: string[]
}

interface ToolFaceCatalog {
  tools: { id: string; module: string; available: boolean; reason?: string; platform?: 'win32' | 'posix' }[]
  faces: {
    kind: 'default' | 'common' | 'existing' | 'custom'
    id: string
    name: string
    tools: string[]
    missing?: string[]
    partial?: boolean
  }[]
}

interface PresetManager {
  list(): Promise<PresetSummary[]>
  listToolFaces(): Promise<ToolFaceCatalog>
  createToolFace(input: { name: string; tools: string[] }): Promise<ToolFace>
  deleteToolFace(id: string): Promise<void>
  create(draft: PresetDraft): Promise<PresetSummary>
  delete(id: string, options?: { force?: boolean }): Promise<void>
  listPromptCandidates(root: string): Promise<{ path: string; bytes: number }[]>
}
```

Client 通过 RPC 调这些方法；不直接写文件、不直接调 `agentPresets.register()`。

## 12. 错误与安全

| 错误 | 行为 |
|---|---|
| `PRESET_ID_EXISTS` | 拒绝创建 |
| `PRESET_ID_INVALID` | 拒绝创建 |
| `PRESET_IDENTITY_INVALID` | 拒绝创建 |
| `PROMPT_ROOT_MISSING` | 拒绝创建 |
| `PROMPT_FILE_OUTSIDE_ROOT` | 拒绝创建 |
| `PROMPT_FILE_EMPTY` | 拒绝创建 |
| `TOOL_UNKNOWN` | 拒绝创建/保存工具面 |
| `TOOL_FACE_INVALID` | 拒绝创建/保存工具面（空名、空工具集） |
| `TOOL_FACE_EXISTS` | 拒绝保存同名自定义面 |
| `TOOL_FACE_NOT_FOUND` | 拒绝删除不存在的自定义面 |
| `TOOL_FACE_READONLY` | 拒绝删除默认/常见/现有预设面 |
| `PRESET_IN_USE` | 拒绝删除，返回会话列表 |
| `PRESET_NOT_MANAGED` | 拒绝删除 |
| `PRESET_REGISTER_FAILED` | 创建回滚，保留 diagnostic |

安全要求：

- 只有 owner 可以创建/删除；所有操作审计。
- `promptRoot` 必须是绝对路径、已存在目录、可读。
- 文件必须位于 root 下；拒绝 `..` 和符号链接逃逸。
- 管理器不读取/写入文件内容，只传路径给 `prompt-files`。
- 工具 id 只在代码目录里解析；文档里的未知 id 不会变成任意模块行。
- 创建预设不等于创建会话；不要顺手起会话。

## 13. 验收

1. 入口：左侧栏出现“预设”，点开进入列表页；资料页/设置页不再是唯一入口。
2. 创建页：列表页点“新建预设”进入；点“返回”回到列表，列表仍可读。
3. 默认面：新进创建页时只有“网络搜索”一个开关打开。
4. 选面：选 `none` 全部关闭；选 `full` 打开所有可用工具；选现有预设面得到该预设的工具集。
5. 逐项开关：任一开关可单独切换；切换后不再显示为某个面。
6. 自定义面：能命名保存当前开关；能删除；默认/常见/现有预设面没有删除入口，保存/删除都会被 Host 拒绝。
7. 创建：写入所选 `tools` 与 `toolFace`，definition 只组装这些工具。
8. 现有预设：`elysia-conscious`、`elysia-subconscious-router` 仍能列出/恢复；提示词文件不变。
9. 旧文档：v1 文档读取后按 `["tool-web"]` 组装，且不被读取动作重写。
10. 可用性：不可用工具在列表里标灰给原因，不进任何面。
11. 删除预设不删自定义工具面。
12. `pnpm test`、`pnpm run typecheck`、`pnpm run bundle` 全绿。

## 14. 未决

- `identity` 已定为必填的“预设说明”，由 `prompt-files` 注入；不挂 `dsh-persona`。
- 候选文件是否只允许 `.md`；当前只列 `.md`，避免误注入二进制。
- 删除有历史会话的预设是否提供 `force`；当前只用于“注册已丢失”的条目。
- 是否要把管理器文档导出成 bundle；当前不做，运行期注册 + 自持久化足够。
- 目录外的工具包（例如实验性工具）是否进入目录；需要先补齐它们依赖的宿主行。
