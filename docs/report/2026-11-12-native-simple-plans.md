# 最小原生计划接入与运行验收（2026-11-12）

## 范围

用户决定先实现“爱莉写计划内容、多久后再提醒”的最小系统。本次原样复用 @deepseek-ai/dsh-tool-schedule 四个模型工具和原生 ScheduleService。主路径为 prompt、title、after_seconds；提醒回到创建者的同一 session，不代主体执行事项或直接发送渠道消息。

没有新增计划调度器、定时器、业务数据库或完整事项状态机，没有修改 DSH 实现源码、既有 session header/preset 或主体文件。主意识和 profile 原有 D1/ModSearch 变更均保留，只按最小范围叠加接入。

## 实现与原因

工具以 plan-tools 子插件挂到固定主意识 scope；不加入 global restrict allow，因为原生限制仅针对全局工具，本地注册本就可见。原生工具绑定执行者 session，没有新增任意目标 sessionId 参数。

原生 Schedule 到期会通过通用 sessionController.resolveAgent 恢复目标。主意识原有预热与这个恢复并无启动顺序保证，旧主意识也没有可随意改写的 preset。新增 plan-host 只等待本次正确主意识 handle 已装配且已发布，再挂载原生 Host；profile 禁用旧的直接 Schedule 行，避免双 Host。主意识 owner 退出则关闭自有 Host，不让它回退到默认 preset。ready 与 whenIdle 分开，忙时提醒照常由原生 followup 写入 inbox，再 flush 确认耐久。

新增 createMainSessionTurn.ready 表达这个真实发布边界；scheduledPlans 是明确开关，默认 false，当前 Web 主意识开启。完整主动框架默认入口继续为占位。

## 验证

- 专属可复现配置：plugins/proactive-system/vitest.config.mjs。15 项通过，包括作用域隔离、当前 session 绑定、never-ready/late-ready/owner dispose/并发清理，以及真实 Schedule＋JSON domain＋JSONL session＋本地模型 adapter 的忙时递送与重启逾期恢复。
- 原生工具、持久化重启、递送和主意识相关定向回归 214 项通过；与专属配置有部分重叠，不相加宣称独立总数。
- 集成测试及相关源码 519 文件类型检查零诊断；门控模块和测试的独立类型检查也通过。现有 main 的 sessionPersistence:unknown 旧声明已移除，使用原生真实服务类型。
- 没有调用真实模型、写正式测试计划、发送平台消息或改动私人正文。现存正式 catalog 有一条较早的 inactive 记录，未删除、修改或重放。

## 真实运行

重载前通过原生鉴权只读 API 确认 16 条 session 均无 running，直播回应 off。核对旧 launcher 3626017 / Web 3626029，uid=1000，cwd=Elysia-Harness/dsh，Node22、完整 argv、父子关系与 3299/3300 端口精确对应。

仅 SIGTERM 该 Web child，确认原父子退出及端口释放；保留原 argv 与环境，日志追加启动一次。新 launcher 3800957 / Web 3800969。原生鉴权界面可用、固定主意识 live，schedule/catalog 可读，直播管理 API 与 /source 舞台可用；新启动区间未见计划 Host 或主意识预热错误。未新增守护或自启动，未重启 Python Elysium、NapCat 或 Breeze。

运行元信息：/tmp/elyharn-plan-runtime-nov12.json；日志新启动偏移 1459223。测试日志：/tmp/elyharn-plans-tracked-config-nov12.log、/tmp/elyharn-plans-focused-nov12.log、/tmp/elysia-plans-integration.log。锁与 JSON 的接手基线/精确补丁保留于 /tmp/elyharn-plans-locks-12205l_i 和 /tmp/elyharn-plans-json-r8iexk_c；接线前文件备份位于 /tmp/elyharn-plan-bindings-before-nov12。恢复接入配置时只逆向本任务补丁，并在核对 owner 后受控重载，不能覆盖其他工作。

## 保留的原生边界

创建成功代表提醒已保存；入箱成功不代表模型已理解或事项已执行。应用停机时不自动启动应用。崩溃窗口可能重复投递，删除调度记录不撤回已入箱消息。完整事项的再次出现、语义关闭、外部事件条件和正文来源展示继续留待后续设计。

原生 reminder 固定说明为 This is a scheduled message from the user，结构 source.kind=schedule；本版保持原生文案，实际作者以原始工具活动与计划原文追溯，不将通用说明提升为新的人类发言或权限。

没有提交或推送；代码与文档留在原 checkout，混合文件中的其他改动仍保留。
