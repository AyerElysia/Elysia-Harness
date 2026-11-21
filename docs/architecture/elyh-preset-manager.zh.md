# ElyH 预设管理器方案（v1）

> 状态：设计稿，2026-11-22。范围：本地 Web/TUI 的预设创建、列表、删除。
> 不在范围：工具注册与开关、提示词内容编辑、会话创建、模型选择、cwd/workspace、渠道桥接、记忆检索。
> 关键约束：预设管理器只做“这个预设是谁、看哪些提示词文件”；工具统一由面板管理；所有 session 共用面板的最小工具面。

## 1. 目标

让操作者可以：

1. 创建一个新预设：设置 id、名称、说明、可选身份前缀、提示词根目录与文件列表。
2. 列出全部预设：区分“管理器创建的”和“bundle/profile 声明的”，显示诊断与会话引用。
3. 删除管理器创建的预设：有会话引用时默认拒绝，避免恢复失败。
4. 创建后不编辑内容；要改就删除后重建。

预设管理器不创建会话。创建预设只是把一份 composition 注册进 DSH roster；会话仍然由用户或会话运行时创建。

## 2. 决策摘要

| 决策 | 结论 |
|---|---|
| 内容编辑 | 不做。提示词 md 由外部编辑器维护，管理器只引用 |
| 工具管理 | 不做。工具由面板的 Tool Catalog / State Store 统一管理 |
| 工具面 | 全局 Base + 面板扩展；预设不声明工具 |
| 最小工具面 | `web_search` + `web_fetch`（`tool-web`）；`pass` 是第一个扩展 |
| 读图 | 粘贴图走原生视觉输入；`read_image` 不进 Base |
| 文件选择 | 复用 DSH directory picker 选目录，再由 Host 扫描 `.md` 让用户勾选 |
| 运行策略 | code-owned；所有预设自动压缩全开；面板不编辑 |
| 预设持久化 | 管理器自己的文档 + 启动时 `agentPresets.register()` |
| 删除 | 只删管理器自己的；有会话引用默认拒绝 |
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
      - id: prompt-files
        name: '@elysia/preset-prompt-files'
        config:
          root: <absolute prompt root>
          files: [SOUL.md, USER.md, MEMORY.md]
          identity: <optional short persona prefix>
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

注意：

- `plugins` 里**不出现工具插件**。工具由面板全局注册。
- `prompt-files` 是预设子插件，不是管理器本身；它负责读取文件、注册系统提示词、监听变化。
- `identity` 可选，渲染在文件内容之前；不要同时再挂 `dsh-persona`，避免两个身份源。
- 压缩组固定由管理器模板生成，用户不可编辑；`auto: true`。

## 4. 创建流程

### 4.1 表单

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写字母、数字、连字符；创建后不可改 |
| `name` | 是 | 显示名 |
| `description` | 否 | “这个预设是什么” |
| `identity` | 否 | 可选身份前缀；会进入系统提示词 |
| `promptRoot` | 是 | 绝对目录；DSH 目录选择器选择 |
| `promptFiles` | 是 | 根目录下的文件列表，至少一个 |
| `order` | 否 | roster 顺序 |

不包含：工具面、模型、cwd、渠道、记忆检索、运行策略。

### 4.2 步骤

1. 填写元数据。
2. 选目录（见第 5 节）。
3. Host 扫描候选文件，用户勾选并排序。
4. 生成 definition：`prompt-files` + 固定压缩组。
5. 校验 id 唯一、目录存在、文件在根目录下、至少一个非空文件。
6. 调 `agentPresets.register(definition)`。
7. 成功后写入管理器文档；失败回滚，不留下半成品。

### 4.3 创建后

- 立即可在 roster 中看到，可用于新会话。
- 活会话不会自动切换到新预设。
- 提示词文件可以继续被外部编辑；文件内容变化由 `prompt-files` 在下一轮重读并通知。

## 5. 文件选择

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

## 6. 列表与删除

### 6.1 列表

合并两个来源：

- `agentPresets.list()`：所有 roster 预设，包括 bundle/profile 声明的。
- 管理器文档：哪些是管理器创建的。

每条显示：

- `id`、`name`、`description`
- `managed: true/false`
- `inUse`: 使用该预设的会话 id
- `diagnostic`: 激活失败原因
- `promptRoot`、文件数
- `createdAt`

### 6.2 删除

- 非 `managed`：拒绝，提示“bundle/profile 声明，管理器不能删”。
- `managed` 但有会话引用：默认拒绝，返回 `PRESET_IN_USE` + 会话列表。
- `managed` 且无引用：dispose registration，删除管理器文档条目。
- 可选 `force`：仅在没有活会话、且用户明确确认时使用；有历史会话时仍不建议，因为恢复会缺定义。

删除预设不等于删除提示词文件。

## 7. 持久化与生命周期

管理器文档建议：

```json
{
  "version": 1,
  "presets": [
    {
      "id": "elysia-conscious",
      "name": "爱莉 · 主意识",
      "description": "...",
      "identity": "...",
      "promptRoot": "E:/.../data/elysia",
      "promptFiles": ["SOUL.md", "USER.md", "MEMORY.md"],
      "order": 10,
      "createdAt": "..."
    }
  ]
}
```

生命周期：

1. Host 启动时读取文档。
2. 逐个构造 definition，调 `agentPresets.register()`。
3. 保存每个返回的 disposer；失败保留 diagnostic，不阻塞其他预设。
4. 创建：先 register，成功再写文档。
5. 删除：先 dispose，再删文档；dispose 失败则保留。
6. 进程退出：dispose 所有 manager-owned registrations。

重要：`agentPresets.register()` 是**运行时定义**，不写入 `cordis.patch.yml`，也不写 DSH 的 preset 声明。管理器文档才是事实源。要变成 bundle 内置预设，需要另外生成并安装 bundle，v1 不做。

## 8. 提示词文件监控

`@elysia/preset-prompt-files` 是预设子插件，负责：

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

## 9. 与工具面板的边界

- 预设管理器：`id/name/description/identity/promptRoot/promptFiles/order`。
- 工具面板：Tool Catalog、Base 工具、扩展工具、State Store、`when` 门、`guard`。
- 预设 definition 不含工具插件；工具变化不触发预设变更。
- 面板 Base：`web_search` + `web_fetch`，所有 session 常开；`modsearch` 是 `web_search` 的 provider，不属于预设。
- 扩展：`pass` 第一个，然后是 files/web/write/skill/schedule/session/dispatch/bash/jobs。
- 面板扩展默认关闭，按 session/preset 开启；不新开会话。

“一键应用已有预设的工具面”不属于预设管理器。若以后需要，放在面板的 Tool Profile，不放在创建表单。

## 10. 运行策略

- 所有预设都使用同一套压缩组：`compaction-basic(auto:true)` + `command-compact` + `tool-result-pruner`。
- `/compact` 保留为手动补充，但不是唯一入口。
- 不再使用 `session-compaction` 插件；它是旧实现 workaround。
- guard、权限、sandbox 策略由 code-owned 默认提供，不在创建表单里编辑。

## 11. API 草案

```ts
interface PresetDraft {
  id: string
  name: string
  description?: string
  identity?: string
  promptRoot: string
  promptFiles: string[]
  order?: number
}

interface PresetSummary {
  id: string
  name: string
  description?: string
  managed: boolean
  inUse: string[]
  diagnostic?: string
  promptRoot?: string
  promptFileCount?: number
}

interface PresetManager {
  list(): Promise<PresetSummary[]>
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
| `PROMPT_ROOT_MISSING` | 拒绝创建 |
| `PROMPT_FILE_OUTSIDE_ROOT` | 拒绝创建 |
| `PROMPT_FILE_EMPTY` | 拒绝创建 |
| `PRESET_IN_USE` | 拒绝删除，返回会话列表 |
| `PRESET_NOT_MANAGED` | 拒绝删除 |
| `PRESET_REGISTER_FAILED` | 创建回滚，保留 diagnostic |

安全要求：

- 只有 owner 可以创建/删除；所有操作审计。
- `promptRoot` 必须是绝对路径、已存在目录、可读。
- 文件必须位于 root 下；拒绝 `..` 和符号链接逃逸。
- 管理器不读取/写入文件内容，只传路径给 `prompt-files`。
- 创建预设不等于创建会话；不要顺手起会话。

## 13. 验收

1. 创建：填元数据、选目录、勾文件，成功注册；新会话可用；旧会话不受影响。
2. 列表：内置预设显示 `managed:false`，管理器预设显示 `managed:true`；有会话引用时 `inUse` 正确。
3. 删除：无引用可删；有引用拒绝；内置预设拒绝。
4. 重启：管理器文档恢复，所有 manager-owned 预设重新注册；失败的保留 diagnostic。
5. 文件选择：Windows 原生目录选择器、Linux 原生目录选择器；选完能列出 `.md` 并多选。
6. 提示词变化：改任意 md，下一轮系统提示词更新，Chat 出现“上下文注入 · 文件已更新”通知。
7. 工具边界：预设 definition 中没有工具插件；Base `web_search/web_fetch` 仍由面板提供。
8. 压缩：两个预设都 `auto: true`，`/compact` 可用；没有 `session-compaction`。

## 14. 未决

- `identity` 是否独立成 persona prefix，还是完全由文件承担；v1 建议可选前缀，不挂 `dsh-persona`。
- 候选文件是否只允许 `.md`；v1 默认只列 `.md`，避免误注入二进制。
- 删除有历史会话的预设是否提供 `force`；v1 默认拒绝，`force` 只用于用户明确确认。
- 管理器预设是否需要在 Web roster 中显示“managed”徽标；v1 建议显示。
- 是否要把管理器文档导出成 bundle；v1 不做，运行期注册 + 自持久化足够。
