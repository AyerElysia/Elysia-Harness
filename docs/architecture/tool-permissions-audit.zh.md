# 工具权限实况与目标差距（历史审计）

> **状态：历史审计，2026-11-26 不再描述当前实现。**
> 文中 `conscious-mind`、`subconscious`、`master/session` 等旧插件路径已经归档；当前扩展架构见
> [ElyH 扩展能力架构](../architecture.md)。本文只保留旧实现的权限教训和迁移参考。
>
> 记录 2026-11-20 对 `6622e7bd8f` 的核查结论：实现的工具面比 [目标用例图](elyh-usecase.png) 宽，最宽的一处不在图上任何会话里。
> 本文只记录旧实现的现状与选项；不能作为当前验收依据。

## 1. 最严重的一条：外发工具是全局注册

`plugins/conscious-mind/src/index.ts:113-121` 把 `send_text` 与 `send_voice` 注册在插件根上下文的**全局工具表**上，不是注册进主意识的 agent scope。工具表里任何会话默认都能看见它们；平时只有主意识能用，是因为四个会话各自做了屏蔽：

| 会话 | 屏蔽方式 | 位置 |
|---|---|---|
| 主意识 | `restrict({ allow: ['send_text','send_voice','read_image'] })`——白名单保留，说明这两个工具本来就在继承集合里 | `main-session.ts:225` |
| Router | `restrict({ allow: [] })` | `subconscious/src/router-session.ts:91` |
| 记忆 | `restrict({ allow: [] })` | `subconscious/src/memory-session.ts:77` |
| 直播 | `restrict({ allow: [] })` | `dsh-livestream/src/dsh/session.ts:51` |

**标准 Web 会话与 `preset-elysia`（界面上「爱莉」预设）没有任何插件给它们做 restrict**，`file-capabilities` 的 `restrictInheritedTools` 默认 false（`file-capabilities.ts:58`）。因此在 ElyH Web 里新建标准会话或「爱莉」预设会话，模型直接调用 `send_text(channel, conversation, ...)` 就能往真实渠道发消息。

这把「外发唯一」从注册位置的硬保证降级为「三个会话自觉」。

## 2. Router 比目标多出的执行面

目标是纯编排者（[target-session-capabilities.zh.md](target-session-capabilities.zh.md)：读工作区 ❌、网络 ❌、终端 ❌、不对外表达）。实现给的是通用调查与执行能力：

| 能力 | 实际形态 | 目标 |
|---|---|---|
| 文件读写 | `FileCapabilities`，workspaceDir 为 Router 自己的工作区 | 只读且不含工作区 |
| 终端 | `bash`，sandbox `workspace-write`，禁升权，前台 120s / 上限 600s | ❌ |
| 后台任务 | `job_list`/`job_output`/`job_kill`，自建 `LocalJobRegistry`，≤4 个、30min 回收 | ❌ |
| 联网 | `web_search`/`web_fetch` | ❌ |
| 技能 | `skill` + `skillsDir` | 未列 |
| 自调度 | `schedule_create`/`schedule_edit`（guard 只限「投递给自己的」） | 心跳由宿主计时器承担 |

这些是旧设计的合法产物而非越权：`REQUIREMENTS.zh.md:47` 要求「不把中枢写死成无能分类器」，`DISPATCH.zh.md:26` 说「Router 能阅读、调查和亲自完成简单工作」。冲突来自 11-18 的新目标文档。

最值得单独点名的是 **`schedule`**：Router 能给自己排唤醒，等于实现了第二套心跳，与宿主的观察批次触发并存，两套触发下的行为不可预测。

## 3. 主意识比目标多出的

- **工作区写**：`write`/`edit` 落在 `workspaceDir`（文件和代码）；目标把工作区文件列为「读」，写只列文字/图片/语音/给会话发消息。
- **自调度**：`schedule_*` 经 `proactive-system` 的 PlanHost（profile 里 `scheduledPlans: true`）；目标把定时提醒归给主动系统。
- **skill 加载**：能力上无害，图上未列。

## 4. 反向缺口：图上画了、实现没有

- 主意识：Ayla 任意操作、图片/文件外发（无 `send_file`）、长期记忆检索（只有 MEMORY.md 提示词，没有库）。
- 通话：挂断后文字留言、Ayla 操作。
- 直播：发弹幕、live2d 表情/动作、平台写操作（`allowedWriteActions: []` 直接关闭）。
- Router：`ConsciousProposal`、心跳唤醒、主意识状态感知。
- Worker：通用与事件 worker 完全没有；记忆 worker 无 memory skill 注入、无记忆库/索引；派工只支持 `kind=memory`。

## 5. 收口选项（未执行）

| 优先级 | 项 | 做法 | 代价 |
|---|---|---|---|
| P0 | 外发工具全局化 | 把 `send_text`/`send_voice` 注册进主意识 agent scope；或给 `preset-elysia` 与标准会话补 `restrictInheritedTools: true` | 前者彻底——「外发唯一」应由注册位置保证；后者只是补屏蔽 |
| P1 | Router 执行面 | 先收执行类（bash/jobs/schedule 写），保留读与联网；通用 worker 落地后再连读一起收 | 没有 worker 时全收会让 Router 失去调查能力 |
| P2 | 主意识工作区写与自调度 | 工作区写可保留（写日记/笔记的实际用法）；`schedule` 应与主动系统合并 | 需先定主动系统的边界 |
| P3 | `skill` | 图上补一行即可 | 无 |

## 6. 验收时需要额外验证的

改完 P0 后，用本地 web 面新建一个标准会话，让它调用 `send_text` 发往一个未登记的 channel：正确表现是「渠道未登记」的工具错误，而不是实际投递成功。