# Subconscious

爱莉的潜意识中枢宿主。插件把主意识真实发生的表界活动保存为可追溯 Observation，形成有界 Batch，投递给独立的长期 Router Session。

## 当前实现

- 监听 `elysia-conscious-mind` 的耐久 `session/event`，采集 `user/message`、`assistant/message`、`tool/call`、`tool/result`。
- 用户输入保留文字、原生图片和文件块；assistant 只保留可见正文、图片和文件，排除隐藏 reasoning、原始 stream、provider replayState、框架提示词与空 replacement。
- 工具调用与结果分别保存；结果按 `callId` 关联调用，并继承可用的 turn、step 和 Thread。
- Observation 以来源 `kind / instance / eventId` 稳定去重。每个 Source instance 有独立游标，宿主另分配全局 `ingestSeq`。
- 通用 `recordObservation()` 可接收邮件等独立来源，不需要伪装成主意识消息，也不改变 Batch 与 Router 核心。
- 默认按 `2 秒 / 20 条 / 64 KiB` 成批。完整内容始终持久化；批次保存不可变投影，节选明确标记 `complete: false`，不引用不存在的模型续读工具。
- Router 运行期间的新观察进入后续批次；Session 串行、不重入。
- 分别持久化 Session 接收、模型呈现和原生轮次完成。正常完成的 DSH 轮次就是批次完成依据；崩溃恢复沿用稳定 batch ID，不要求模型生成额外决定。
- 已移除 `subconscious_read` 与 `subconscious_route`。当前批次由宿主直接放入上下文，历史材料未来由宿主按明确工作重新呈现；真正的路由与派工另行设计。
- 旧版 SQLite 在首次打开时原地迁移到新版观察与批次投影表，不删除旧表、历史 Decision 或历史延期记录；这些旧记录不再对应可用模型工具。
- Router 使用 `SOUL.md`、`USER.md`、`MEMORY.md` 和 `SUBCONSCIOUS-ROUTER.md`，复用 Web 的共享 Compact 服务。
- `provider` / `model` 可通过插件配置独立指定，并通过原生 `agent.model.select()` 持久覆盖旧 Session 选择；省略时继承当前默认模型。

## Router 工具

Router 在自己的 Agent 作用域内挂载 **17 个 DSH 原生通用工具**，没有潜意识专用读取或路由工具。无关 Host 全局工具仍被隔离，尤其没有 `send_text` / `send_voice`。

```text
文件：read、read_image、write、edit、glob、grep
网络：web_search、web_fetch
Skills：skill
Shell / Jobs：bash、job_output、job_list、job_kill
Schedule：schedule_create、schedule_list、schedule_view、schedule_edit
```

权限边界：

- 文件写入仅限 Router 工作区；选定固定提示词和 Skills 目录只读，Skill 附属资料可以通过文件工具续读。
- Shell 使用 workspace-write 沙箱；禁止模型自主升权，前台超时不自动转后台，最多 4 个活动后台 Job，并回收超龄任务。
- Schedule 只允许 `this_session`，实际目标固定为 Router；列表、查看、修改和删除均校验归属，不能管理其他 Session 的任务。
- Shell 沙箱负责文件系统写入边界，不等同于网络或完整进程隔离；Schedule 的原生服务没有原子归属授权条件，归属检查与修改之间理论上仍存在并发改投间隙。

## 运行位置

```text
插件：/home/ayerelysia/Elysia/Elysium/Elysia-Harness/plugins/subconscious
Router cwd：/home/ayerelysia/Elysia/Data/workspace/subconscious/router
状态库：/home/ayerelysia/Elysia/Data/subconscious/router/router.sqlite
专属提示词：/home/ayerelysia/Elysia/Data/standing-prompts/SUBCONSCIOUS-ROUTER.md
```

Web 在 `homes/web/profiles/web/cordis.patch.yml` 中挂载插件。

## 验证与边界

```sh
export PATH=/home/ayerelysia/.local/share/node-v22/bin:$PATH
node ../../dsh/node_modules/typescript/bin/tsc --noEmit --incremental false --composite false -p tsconfig.json
node ../../dsh/node_modules/vitest/vitest.mjs run
```

10 项隔离与集成测试覆盖多来源去重、四类主意识事件、框架与 reasoning 过滤、旧库迁移、完整观察保存、真实 AgentLoop 自然轮次收尾、投递证据、离线补漏，以及文件、Skill 附属资料、Web fixture、Shell 沙箱、Jobs 和 Schedule 归属与真实投递；不向真实渠道发送测试消息。Web fixture 证明工具注册、参数、执行与结果链，不冒充真实互联网验收。

2026-11-17 最新简化验收：真实模型请求只包含上述 17 个通用工具，固定提示词和工具清单均不再引用旧 `subconscious_read` / `subconscious_route`；工程批次 `batch_afd90cfc-140a-4a6d-93d7-01cd0fe5d1ea` 没有收尾工具决定，已在原生 turn 240 正常完成。

此前通用工具真实验收：`write → read` 已在 Router 工作区生成并读回 `live-tool-check.txt`；Schedule 已真实创建、列表确认并删除 `schedule-513136c0-dcaa-4d9f-b32e-b56e2e22971d`，未留下测试任务。Router 专属沙箱的真实 `bash` 执行 `printf 'router shell live ok'` 后返回相同文本。`web_search` 已真实进入 ModSearch 工具链，但 firecrawl、keenable、youcom 上游均连接超时，因此真实互联网搜索仍记为外部依赖不可用，不算验收通过。

当前仍未实现 `dispatch`、专业潜意识 Session、专业记忆写入、主动机会和对外发送。长期设计见 [REQUIREMENTS.zh.md](REQUIREMENTS.zh.md)，通用工具与权限见 [TOOLS.zh.md](TOOLS.zh.md)。接收线与历史最小链路文档中的旧领域工具描述不再代表当前实现。
