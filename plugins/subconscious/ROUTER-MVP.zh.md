# 潜意识中枢 Router：最小实现与验收记录

## 1. 当前链路

```text
主意识 Session 实际收到的 user/message
  → session/event 监听与 SessionPersistence 补读
  → SQLite 持久观察与来源游标
  → 宿主形成有界批次，随 followup 推送正文
  → 独立 elysia-subconscious-router Session / DSH AgentLoop
  → 宿主根据原生会话事件记账
```

Router 在输入中直接收到文字、图片和文件块，并按普通 DSH 会话运行。宿主记录交付和原生轮次结果，技术失败保留批次供重试。Router 可以自然结束，完成条件独立于它有没有输出文字或特定字样。

## 2. 输入边界

当前“全量”只指：**全部实际进入固定主意识 Session、且符合下述规则的 `user/message`**。

- 采集文字、原生图片块和文件块，正文不是只有一条到达通知。
- 排除 `agent-instructions`、`runtime-context`、`time-context`、`elysia-calendar-context` 和空 replacement。
- 只接受主意识 Session ID，Router 自己的 Session 不会重新进入观察，避免自我递归。
- 重启和重新挂载从持久游标补读。
- 这是主意识统一入口的观察，不是 NapCat、KOOK、飞书等平台网关的独立审计日志。平台收到但被准入拒绝、尚未 pending 或未进入主意识的内容，不在当前保证内。

尚未采集：`assistant/message`、主意识工具调用、工具结果、渠道投递回执，以及隐藏的模型推理。

## 3. Session 与提示词

```text
主意识 Session：elysia-conscious-mind
Router Session：elysia-subconscious-router
Router cwd：/home/ayerelysia/Elysia/Data/workspace/subconscious/router
状态库：/home/ayerelysia/Elysia/Data/subconscious/router/router.sqlite
```

有首批工作时才确保 Router 存在，固定 ID 优先 `resume`；仅在持久化层明确返回 `SessionPersistenceNotFoundError` 时才 `create`。其他恢复错误必须暴露，不能伪装成首次创建。

create 与 resume 使用相同 setup：

- `SOUL.md`
- `USER.md`
- `MEMORY.md`
- `SUBCONSCIOUS-ROUTER.md`

其中 `SOUL.md` 与 `SUBCONSCIOUS-ROUTER.md` 必需。Router 不加载 `CONSCIOUS-MIND.md`，并过滤 DSH 的 AGENTS／runtime 上下文。每轮使用 `CurrentTime` 的单一 `YYYY/MM/DD HH:mm` 时间快照。

Web 已注册共享 Compact 服务时直接复用；只有隔离宿主没有 `compaction` 服务时，才安装 `BasicCompactionEngine({ auto: true })`，避免重复注册导致 Session 初始化失败。

## 4. 会话权限

Router 作用域没有模型工具，包含渠道、文件、Shell、网络、Skill 和计划能力在内的全局工具也不进入其上下文。

## 5. 存储、唤醒与恢复

`node:sqlite` 保存不可变观察、来源游标、有序批次、宿主记录的交付结果和休息状态。处理当前批次期间，新输入进入后续批次。卸载停止监听与计时器并释放会话和数据库。重新挂载从持久状态恢复。

## 6. 实际验证

### 6.1 隔离检查

```sh
cd /home/ayerelysia/Elysia/Elysium/Elysia-Harness/plugins/subconscious
export PATH=/home/ayerelysia/.local/share/node-v22/bin:$PATH
node ../../dsh/node_modules/typescript/bin/tsc --noEmit --incremental false --composite false -p tsconfig.json
node ../../dsh/node_modules/vitest/vitest.mjs run
```

隔离测试使用真实 DSH AgentLoop、JSONL 会话持久化与测试模型适配器，覆盖正文送达、普通轮次收尾、工具隔离、卸载重挂补读和持久状态恢复。

### 6.2 历史 Web 验收

2026-11-17，旧版在真实“主意识”Web Session 发送一条部署自检，要求主意识只回答“主意识收到”，不调用渠道工具。

观察到的结果：

1. 主意识完成回答。
2. Router SQLite 新增对应观察，`event_seq=27804`、`source_kind=user`。
3. 首次运行暴露共享 Compact 重复注册；修复后重启，持久批次没有丢失。
4. 真实 Router Session 和模型完成 `subconscious_route(action=ignore)`，理由明确指向该自检消息。
5. 批次最终为 `decided`，观察为 `closed`，游标继续推进。
6. Router 的持久 Session 文件位于其专属 cwd 对应的 DSH sessions 目录；服务继续监听 `127.0.0.1:3299`。
7. 验证未向 QQ、KOOK、飞书或其他外部渠道发送测试消息。

该记录验证当时的主意识输入观察和独立会话链路。旧版决定仅作为历史证据，新链路的验收以当前代码和测试为准。

## 7. 已知限制与下一步

- 目前只采集进入主意识的外界输入，主意识输出与工具结果仍待接入。
- 尚未实现记忆 Session、日记写入、学习、计划或主动表达候选。
- 尚无面向用户的状态面板；内部健康快照可通过 `ctx.subconsciousRouter.health()` 获取。
- 多宿主互斥、完整崩溃恢复矩阵和逐渠道验收属于后续工作。

下一步应优先扩展表界事件覆盖并补齐关联轨迹，再讨论第一个专业 Session；不要在当前 Router 中直接塞入记忆写入或主动消息副作用。
