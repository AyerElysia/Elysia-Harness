# ElyH 预设管理

> 状态：2026-11-26。当前实现是 `@elysia/mobius-infinity`，旧 `preset-manager` 与
> `capability-core` 组合已归档。
> 架构总览见 [ElyH 扩展能力架构](../architecture.md)。

## 1. 职责

`@elysia/mobius-infinity` 管理：

- Agent preset 元数据；
- 提示词文件（SOUL / USER / MEMORY 等）；
- 预设工具组；
- 固定 compaction 组；
- 预设创建页面与侧栏入口；
- 模型工具 `preset_list`、`preset_create`。

它不创建、不切换 Session，也不管理当前会话的工具开关。

## 2. 预设结构

一个托管预设由以下行组成：

```yaml
# 可选
- agent-instructions

- prompt-files

- time-context

# 聊天面才省略；否则包含所选工具组
- tools

- compaction
```

- `identity` 必填；预设自身渲染身份，不再挂 `persona`。
- `tools` 组只包含记录中保存的工具 id。
- 空工具集直接省略 `tools` 组，不挂空 group。
- compaction 固定为：
  - `compaction-basic`
  - `command-compact`
  - `tool-result-pruner`

## 3. 工具目录

`src/tool-catalog.ts` 是预设可组合工具的封闭清单，不通过运行时探测扩展：

| 工具组行 | 模块 | 说明 |
|---|---|---|
| `tool-web` | `@deepseek-ai/dsh-tool-web` | 搜索 + 抓取；聊天面默认 |
| `tool-fs` | `@deepseek-ai/dsh-tool-fs` | 文件读写 |
| `tool-fs-search` | `@deepseek-ai/dsh-tool-fs-search` | glob / grep |
| `tool-bash` | `@deepseek-ai/dsh-tool-bash` | 非 Windows |
| `tool-pwsh` | `@deepseek-ai/dsh-tool-pwsh` | Windows |
| `tool-todo` | `@deepseek-ai/dsh-tool-todo` | |
| `tool-ask-user` | `@deepseek-ai/dsh-tool-ask-user` | |
| `tool-skill` | `@deepseek-ai/dsh-tool-skill` | |
| `tool-jobs` | `@deepseek-ai/dsh-tool-jobs` | |
| `tool-goal` | `@deepseek-ai/dsh-tool-goal` | |
| `tool-subagent` | `@deepseek-ai/dsh-tool-subagent` | spawn |
| `tool-agent-team` | `@deepseek-ai/dsh-tool-agent-team` | |
| `tool-present` | `@deepseek-ai/dsh-tool-present` | |
| `tool-office` | `@deepseek-ai/dsh-tool-office` | |

不进入预设工具目录的内容包括：

- `working_directory`：Host 总是提供，预设不能再加一份；
- `workflow`：需要预设 isolate group 中的 `workflowEngine`；
- `schedule`：Host provider 依赖 profile；
- `lsp`：shipped bundle 不提供；
- `plugin-manager`：profile 级安装面；
- `minimal` 的 persistent terminal 组：需要 terminal service；
- 未由 shipped bundle 挂载的实验工具。

## 4. 当前会话工具面

预设负责**组合**，Helix 负责**当前会话的工具面**。

```text
preset
  → 静态工具注册在该 preset/agent scope
  → Helix 识别 official preset 时锁定
  → 自定义预设的同名特殊工具由 Helix 加执行门禁
  → 扩展工具由 Helix 在会话内挂载
```

- 官方预设静态工具不能由 Helix 关闭。
- 自定义预设的静态特殊工具可开关，关闭后 schema 保留、执行 `UNKNOWN_TOOL`。
- 预设本身不维护“全局注入开关”。

## 5. 模型工具

### `preset_list`

列出可管理的预设：

- id / name / description；
- prompt files；
- tool face；
- 是否可删除；
- 注册表诊断。

### `preset_create`

创建 / 更新托管预设：

- 校验 id、prompt root、文件列表；
- 校验工具组是否在封闭目录中；
- 合并为 Cordis preset definition；
- 持久化到 manager 文档；
- 不创建 Session。

中文显示名是可选编排元数据，不参与预设行为。

## 6. 提示词文件

- `prompt-files` 子插件只读取配置的文件列表；
- 每次都重新读正文；
- 文件缺失、为空或不可读时按配置报错；
- 不写主体 prompt 文件；
- 不改变已存在 Session 的 header 或历史。

## 7. 持久化与边界

- 状态目录使用 `dshHomePath('mobius-infinity')`；
- 预设文档与注册表分开；
- 删除只删除 manager 自己的记录，不删除外部注册的预设；
- 预设创建不改变当前 Session 的 preset；
- 不依赖 `capability-core`、`capability-panel` 或私有工具开关。

## 8. 验收

- 创建、列出、删除预设；
- `preset_create` 拒绝空工具组、未知工具、非法 prompt 路径；
- 工具组能真实挂载并出现在该预设的 agent 工具面；
- 官方预设静态工具锁定；
- 自定义预设静态特殊工具开关语义正确；
- 预设删除后无残留文件、监听器或 row；
- 不影响当前已存在 Session 的 preset/header。

当前实现细节以 `plugins/mobius-infinity/README.md` 和源码为准。