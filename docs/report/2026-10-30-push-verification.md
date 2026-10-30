# 2026-10-30 推送前验收记录

本记录是本次提交的工程验收证据，时间均为 Asia/Shanghai（UTC+08:00）。它描述观察时点，不代表持续健康保证，也不把单元测试等同于所有部署链路验收。

## 真实运行证据

- Spark 上 ElyHarn 主进程 PID `2521909` 于 `2026-10-30 18:32:24` 启动；检查时仍存活并监听 `127.0.0.1:3299`。
- 核心源码修改时间早于该进程：`plugins/conscious-mind/src/main-session.ts` 为 `18:26:49`；`plugins/conscious-mind/src/send-voice.ts` 为 `18:32:20`。该时间对比仅针对这两份源码，不扩展为所有后续修改均已在此进程加载。
- 只读解压现有主 session 归档，未调用模型、发送平台消息、创建会话或重启服务。归档路径：
  `/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/sessions/--home-ayerelysia-Elysia-Elysium-Elysia-Harness-homes-web-conscious-mind--/elysia-conscious-mind/session.v4.jsonl.zstd`
- 归档最后修改于 `18:39:43`。进程启动后的记录包含 33 个事件、2 个完成轮次；两个 `turn/end` 的 `reason.kind` 均为 `completed`。

| 时间 | 事件 seq | 工具及渠道 | 结果 |
|---|---:|---|---|
| 18:33:45 | 3048 | `send_voice` → KOOK | `isError 未标记错误`，`status=sent`，`audioBytes=472364`；平台消息 ID 存在，不记录其值 |
| 18:33:52 | 3053 | `send_text` → KOOK | `isError 未标记错误`，4 段接受成功，无错误；平台消息 ID 存在，不记录其值 |
| 18:39:39 | 3066 | `send_text` → KOOK | `isError 未标记错误`，3 段接受成功，无错误；平台消息 ID 存在，不记录其值 |

这些既有事件证明当前进程启动后完成过模型生成、语音合成、文字/语音工具执行以及 KOOK 平台投递。记录不包含聊天正文、内心活动、消息 ID 值、凭据或带令牌链接。

## 混合日志的解释

`/home/ayerelysia/Elysia/DataInfra/logs/elyharn-web.log` 混合了多轮运行历史，且缺少逐行时间戳。其历史错误包括工具注册、agent factory 和 session persistence 相关失败。不能仅凭这些混合错误或日志中缺少完成标记，认定当前进程仍然失败；当前运行结果以上述带时间的 session 事件及工具回执为证。启动操作者未根据进程账户作推断。

## 本次工程检查

- Node `v22.20.0`、Vitest `v4.1.11`，使用 `vitest.elysia.config.ts`、`--maxWorkers=1`：12 个测试文件、57 项定向测试通过。
- 5 个插件完成无输出类型检查；QQ 旧桥接入口缺少新事件 `content` 字段的问题修复后，QQ 类型检查为 0 diagnostics，已有 QQ 测试 2 个文件、7 项通过。
- 临时源码解析配置下再次运行同批 57 项测试，全部通过，避免仅依赖既有构建产物判断。
- 本次 shell 语法及锁文件一致性检查通过。
- 网络与模型调用使用 mock，文件写入测试临时目录。QQ 挂载测试使用检查为空闲的 `127.0.0.1:8098`，结束后端口已释放；未操作正式平台连接或正式服务生命周期。

以上测试数量和结果仅是本次检查记录，后续修改仍需与风险相称的验证。

## 未覆盖范围

本次没有实测 QQ、飞书、聊天图片的完整平台/模型链路，也没有穷尽所有重启恢复、异常恢复和迁移边界。已有 KOOK 成功回执与定向测试不能代替这些尚未取得的验收证据。
