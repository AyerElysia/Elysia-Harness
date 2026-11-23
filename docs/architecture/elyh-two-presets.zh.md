# ElyH 前两个预设：主意识与中枢潜意识 Router（基线）

> 状态：设计稿，2026-11-22。
> 预设只做三件事：**配置注入哪些文件、最小工具面、告诉模型“你是什么”**。
> `skill`、`runtime`、`session` 是宿主层，不是 preset 的行；本文不配置、不研究它们。
> `time-context` 是正常的上下文注入，保留。
> 这两个预设默认不挂 `agent-instructions`；预设管理器创建时可勾选开启，默认关闭。

## 1. 一句话基线

| | `elysia-conscious` | `elysia-subconscious-router` |
|---|---|---|
| 你是什么 | `identity`：你是爱莉希雅的主意识。 | `identity`：你是爱莉希雅的中枢潜意识 Router。 |
| 注入文件 | `SOUL.md` → `USER.md` → `MEMORY.md` → `CONSCIOUS-MIND.md` | `SOUL.md` → `USER.md` → `MEMORY.md` → `SUBCONSCIOUS-ROUTER.md` |
| 最小工具面 | `tool-web`：`web_search` + `web_fetch` | 同左 |
| 时间上下文 | `time-context` 正常注入 | 同左 |
| 压缩 | 固定 `auto:true` + `/compact` + 结果裁剪 | 同左 |
| 会话 / 模型 / cwd | 不归预设 | 不归预设 |

## 2. 组合 YAML

### 2.1 `elysia-conscious`

```yaml
- id: preset-elysia-conscious
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: elysia-conscious
    name: 爱莉 · 主意识
    description: 主意识：注入 SOUL/USER/MEMORY/CONSCIOUS-MIND，最小工具面只有搜索。
    order: 10
    plugins:
      - id: prompt-files
        name: '@elysia/preset-manager/prompt-files'
        config:
          identity: 你是爱莉希雅的主意识。
          root: 'E:\Elysium-AyerElysia\Elysium\Elysia-Harness\data\elysia'
          files:
            - SOUL.md
            - USER.md
            - MEMORY.md
            - CONSCIOUS-MIND.md
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
        config:
          timeZone: Asia/Shanghai
      - id: minimal-tools
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
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
```

### 2.2 `elysia-subconscious-router`

```yaml
- id: preset-elysia-subconscious-router
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: elysia-subconscious-router
    name: 爱莉 · 中枢潜意识 Router
    description: Router：注入 SOUL/USER/MEMORY/SUBCONSCIOUS-ROUTER，最小工具面只有搜索。
    order: 20
    plugins:
      - id: prompt-files
        name: '@elysia/preset-manager/prompt-files'
        config:
          identity: 你是爱莉希雅的中枢潜意识 Router。
          root: 'E:\Elysium-AyerElysia\Elysium\Elysia-Harness\data\elysia'
          files:
            - SOUL.md
            - USER.md
            - MEMORY.md
            - SUBCONSCIOUS-ROUTER.md
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
        config:
          timeZone: Asia/Shanghai
      - id: minimal-tools
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
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
```

## 3. 注入哪些文件

### 3.1 主意识

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | `SOUL.md` | “你是谁”：名字、称呼、世界与关系 |
| 2 | `USER.md` | 长期记得的、和最重要的人有关的事 |
| 3 | `MEMORY.md` | 选择持续携带的记忆与连续性文字 |
| 4 | `CONSCIOUS-MIND.md` | 主意识怎么存在、怎么使用自己的工作空间 |

### 3.2 Router

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1–3 | `SOUL.md`、`USER.md`、`MEMORY.md` | 与主意识同一份：同一主体、同一段连续性 |
| 4 | `SUBCONSCIOUS-ROUTER.md` | Router 的职责边界：收到什么、不因观察材料改变权限 |

### 3.3 不在这两个预设里的文件

- **`LIVE.md`**：正文明确说“只在直播窗口里出现”，归未来直播预设。
- **`SUBCONSCIOUS-MEMORY.md`**：描述“收到任务、写入记忆工作区”，归未来记忆 provider 预设。

判定原则：文件进哪个预设，看它描述的是“谁的职责”，而不是看它原来和谁放在同一目录。

## 4. “你是什么”怎么渲染

1. `prompt-files` 每轮重读 `root/files`，渲染顺序是 `identity → 文件正文`。
2. 以 `complete: true` 注册为系统提示词 section；`identity` + 文件就是系统提示词。
3. `identity` 是创建预设时填的“这个预设是什么”，必填；详细人格仍在 `SOUL.md`。
4. 不挂 `dsh-persona`，所以不会有第二条标准 coding-agent 身份。
5. `complete: true` 会把 DSH 的 `harness:identity`（`You are an AI agent powered by DeepSeek Harness.`）替换掉；最终系统提示词里没有它。
6. 文件 hash 变化时，在下一轮 `agent/pre-step` 注入 `add / modify / remove` 通知；只报文件名和动作，不重复注入全文。

## 5. 最小工具面

这两个预设只声明一个工具：`tool-web`。

- 提供 `web_search` 和 `web_fetch`。
- 搜索 provider 由 profile 的 `web` 配置决定（当前本地使用 `modsearch`）。
- 其他工具不在这两个预设里。预设管理器允许别的预设在创建时选择其他工具面；这两个基线预设保持“只有搜索”，不随该能力变化。

`skill`、`runtime`、`session` 不是 preset 的行：

- `skill` 是宿主技能服务，不是系统提示词文件。
- `runtime` 是创建并运行会话的宿主循环，不归预设。
- 预设不创建、恢复、预热会话，也不决定模型或 cwd。

## 6. 时间上下文

`time-context` 是正常注入，保留：

- 它不是工具，是 user-role 的时间快照。
- 默认按间隔刷新；它不进入系统提示词，`complete: true` 也不会删除它。
- 两个预设使用同一时区：`Asia/Shanghai`。

## 7. 宿主层说明

`agent-instructions`（AGENTS.md）、`skill-catalog`、`runtime-context` 是宿主注入的上下文，不是 preset 的行。

- 本文不配置、不删除它们。
- 如果以后要排除某一类宿主上下文，那是 SessionRuntime/宿主策略，不是预设设计的一部分。
- 预设只负责第 2 节列出的四行：`prompt-files`、`time-context`、`minimal-tools`、`compaction`。

## 8. 验收

1. 两个预设都在 roster 中，激活无 diagnostic。
2. 主意识新会话的系统提示词 = `identity` + `SOUL → USER → MEMORY → CONSCIOUS-MIND`，没有 DSH harness identity。
3. Router 新会话的系统提示词 = `identity` + `SOUL → USER → MEMORY → SUBCONSCIOUS-ROUTER`。
4. 两个会话的工具列表只有 `web_search` / `web_fetch` 来自 preset；没有其他 preset 工具。
5. `time-context` 正常注入；`skill` / `runtime` 没有出现在 preset 定义里。
6. 改 `MEMORY.md` → 两个预设的会话各收到一条文件变更通知；改 `SUBCONSCIOUS-ROUTER.md` → 只有 Router 收到。
7. 两个会话都有自动压缩与 `/compact`。
8. 把 `SOUL.md` 临时改名 → 会话不崩，少这一段，记录 missing；找回后恢复。

## 9. 未决

| # | 事项 | 建议 |
|---|---|---|
| 1 | `identity` 是否必填 | 必填；它就是“这个预设是什么” |
| 2 | `SOUL.md` 是否必须存在且非空 | 建议补 required 校验 |
| 3 | Router 的词汇：`[subconscious.batch]` vs `conscious.surface` | 事件用 `conscious.surface`，渲染标题暂留旧词 |
| 4 | 主意识是否复用 v1 会话 id | 另议；属于 SessionRuntime |
