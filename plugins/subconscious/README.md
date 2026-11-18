# Subconscious

爱莉的潜意识中枢宿主。插件把主意识真实发生的表界活动保存为可追溯 Observation，形成有界 Batch，投递给独立的长期 Router Session；Router 可以把值得留存的经历派给长期记忆 Session，并接收真实结构化报告。

## 当前实现

### 表界接收

- 监听 `elysia-conscious-mind` 的耐久 `session/event`，采集 `user/message`、`assistant/message`、`tool/call`、`tool/result`。
- 用户输入保留文字、原生图片和文件块；assistant 只保留可见正文、图片和文件，排除隐藏 reasoning、原始 stream、provider replayState、框架提示词与空 replacement。
- 工具调用与结果分别保存；结果按 `callId` 关联调用，并继承可用的 turn、step 和 Thread。
- Observation 以来源 `kind / instance / eventId` 稳定去重。每个 Source instance 有独立游标，宿主另分配全局 `ingestSeq`。
- 通用 `recordObservation()` 可接收邮件等独立来源，不需要伪装成主意识消息，也不改变 Batch 与 Router 核心。
- 默认按 `2 秒 / 20 条 / 64 KiB` 成批。完整内容始终持久化；批次保存不可变投影，节选明确标记 `complete: false`。
- 分别持久化 Session 接收、模型呈现和原生轮次完成。正常完成的 DSH 轮次就是批次完成依据；崩溃恢复沿用稳定 batch ID，不要求模型生成额外决定。
- 旧版 SQLite 在首次打开时原地迁移到新版观察与批次投影表，不删除旧表、历史 Decision 或历史延期记录。

### 派工与长期记忆

- Router 通过 `subconscious_dispatch` 创建 `memory` 任务；宿主在同一事务保存 Task、Mandate、Assignment 与 `deliver_assignment` Effect。
- 当前只注册 `memory` 一种专业任务。长期 Session 固定为 `elysia-subconscious-memory`，不按 Task 创建一次性 Agent。
- 任务包直接携带完整、获准的 Observation 正文与任务身份，不依赖已经删除的读取工具。
- 记忆 Session 通过真实 `write` / `edit` 写日记，再用 `subconscious_report` 提交 `completed / dropped / blocked / failed` 终态报告。
- `memory completed` 必须具有当前 Assignment 实际写入的非空文件；无需写入时可以合理 `dropped`。正文声称完成或 `whenIdle()` 都不能替代 Report。
- Report、Task／Assignment 状态和 `relay_report` Effect 同事务保存；宿主随后把 `[subconscious.report]` 真正投回同一个 Router Session。
- Batch 自然结束与 Task 完成完全分离。调度顺序为 **待回传 Report → 待执行 Assignment → 新 Batch**，避免持续聊天或大量任务让闭环饥饿。
- Task、Mandate、Assignment、Report、Effect 与 Observation／Batch 统一保存在 `router.sqlite`，由插件领域层单写；DSH Session 历史仍由 DSH 自己持久化。
- 未实现自动续接、长任务 `progress / waiting`、模型可见的取消／重试、主动机会和其他专业类型。

### 提示词与模型

- Router 使用 `SOUL.md`、`USER.md`、`MEMORY.md` 和 `SUBCONSCIOUS-ROUTER.md`。
- 记忆 Session 使用 `SOUL.md`、`USER.md`、`MEMORY.md` 和 `SUBCONSCIOUS-MEMORY.md`。
- 两者复用 DSH Agent、Session 与 Compact 基础设施；`provider` / `model` 可通过插件配置独立指定，省略时继承默认模型。
- `subconscious_read` 与 `subconscious_route` 已删除。长历史中仍偶发旧工具模仿调用，宿主会真实返回 `unknown tool`；它们没有重新注册，也不是 Batch 收尾条件。

## 工具与权限

### Router

本插件挂载 **17 个 DSH 原生通用工具 + 1 个派工工具**：

```text
文件：read、read_image、write、edit、glob、grep
网络：web_search、web_fetch
Skills：skill
Shell / Jobs：bash、job_output、job_list、job_kill
Schedule：schedule_create、schedule_list、schedule_view、schedule_edit
领域：subconscious_dispatch
```

正式 Web 的既有会话通讯插件还会提供 `session_list / session_read / session_send`；它们不是本插件新增的领域工具。Router 没有 `send_text / send_voice`。

### 记忆 Session

本插件挂载：

```text
read、read_image、write、edit、glob、grep、subconscious_report
```

正式 Web 同样可能叠加既有 `session_list / session_read / session_send`，但没有 `subconscious_dispatch`、`send_text` 或 `send_voice`。记忆文件写入仅限记忆工作区，固定提示词受保护。

共同权限边界：

- Router 文件写入仅限 Router 工作区；记忆写入仅限记忆工作区。
- Shell 使用 workspace-write 沙箱；禁止模型自主升权，前台超时不自动转后台，最多 4 个活动后台 Job，并回收超龄任务。
- Schedule 只允许 `this_session`，实际目标固定为 Router；列表、查看、修改和删除均校验归属。
- Shell 沙箱负责文件系统写入边界，不等同于网络或完整进程隔离。

## 运行位置

```text
插件：/home/ayerelysia/Elysia/Elysium/Elysia-Harness/plugins/subconscious
Router cwd：/home/ayerelysia/Elysia/Data/workspace/subconscious/router
Router 状态库：/home/ayerelysia/Elysia/Data/subconscious/router/router.sqlite
Router 提示词：/home/ayerelysia/Elysia/Data/standing-prompts/SUBCONSCIOUS-ROUTER.md
Memory Session：elysia-subconscious-memory
Memory cwd：/home/ayerelysia/Elysia/Data/workspace/subconscious/memory
Memory 提示词：/home/ayerelysia/Elysia/Data/standing-prompts/SUBCONSCIOUS-MEMORY.md
正式日记：/home/ayerelysia/Elysia/Data/workspace/subconscious/memory/diary.md
```

Web 在 `homes/web/profiles/web/cordis.patch.yml` 中挂载插件，正式服务监听 `127.0.0.1:3299`。

## 测试与真实验收

```sh
export PATH=/home/ayerelysia/.local/share/node-v22/bin:$PATH
node ../../dsh/node_modules/typescript/bin/tsc --noEmit --incremental false --composite false -p tsconfig.json
node ../../dsh/node_modules/vitest/vitest.mjs run
```

2026-11-18 最终结果：类型检查通过，**3 个测试文件、21／21 测试通过**。覆盖多来源去重、四类主意识事件、过滤与迁移、完整观察、自然轮次收尾、离线补漏、通用工具、派工权限与幂等、真实记忆写入、报告回传，以及持续 Batch 下的 Assignment／Report 优先调度。测试使用临时记忆目录，不写正式日记，不向真实渠道发送测试消息。

### 真实闭环证据

2026-11-18 通过正式 Web 主意识 Session 的自然输出完成两次真实闭环，未直接写 Store 伪造结果：

| 环节 | 第一次 | 第二次 |
|---|---|---|
| Task | `task_c1314504-2d59-4b0f-a1df-43b092ddf2d1` | `task_2e8ef3d0-dc83-4b9b-9b9b-a3c4487eaacc` |
| 来源 Observation | `obs_680d2491f297e6d14d32efe5` | `obs_db073f9ee7d02bf7230500ed` |
| Assignment | `assignment_d7e46e6b-123e-484d-80e3-762a197014b9` | `assignment_d4f7070d-7779-467e-9a72-3da890b773b0` |
| 专业轮次 | turn 12，真实 `write` | turn 13，真实 `edit` |
| Report | `report_e9f1ff0c-dd69-4d03-9407-4e3841702e94` | `report_8eca3544-b4ad-4fd3-ada7-33dcf820819f` |
| Task 状态 | `completed` | `completed` |
| deliver Assignment Effect | `completed` | `completed` |
| relay Report Effect | `completed` | `completed` |

两份 Mandate 均为 `dispatch-v1`，读写根为记忆工作区，输入上限 64 KiB、运行上限 15 分钟。两份 Report 的 `output_refs` 都指向正式 `diary.md`，文件内容包含对应 Task、Assignment 与 Observation 线索。

Router 真实请求归档 `2026-11-18T01-08-01-553Z-634e2059.json` 同时包含上述两份 `[subconscious.report]`；这证明报告已经实际进入 Router 模型输入，而不只是数据库中存在记录。正式服务仍监听 3299，主意识随后继续取得真实 `send_text` 成功回执。

详细设计见 [REQUIREMENTS.zh.md](REQUIREMENTS.zh.md)、[TOOLS.zh.md](TOOLS.zh.md) 与 [DISPATCH.zh.md](DISPATCH.zh.md)。主动机会、自动任务续接、其他专业 Session 与长期记忆语义仍属于后续工作，未因本次闭环完成而提前宣称实现。
