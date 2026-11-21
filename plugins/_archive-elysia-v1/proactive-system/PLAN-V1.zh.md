# 第一版：复用 DSH 的简单计划

状态：第一版计划接入的代码、隔离端到端测试与 Web 实际重载验证完成。完整主动机会框架继续保留为后续需求；这一版只接入已有定时提醒能力。初次接入验收未做真实对话测试；用户现已授权真实对话验收，结果见 [计划工具说明验收记录](../../docs/report/2026-11-12-plan-tool-guidance.md)。

## 使用方式

爱莉在当前主意识里写下要做什么、多久后再提醒自己。内容直接保存为她给未来自己的计划文字，可以包含她愿意补充的缘由、必要的会话目标与上下文引用。到时原生 DSH 把它递回同一主意识，由她决定接下来做什么；不直接向 QQ、KOOK 等平台发送，也不宣称计划事项已经执行完成。

创建使用原生工具，不新增 create_plan、事项数据库、定时器或语义调度器：

~~~json
{
  "prompt": "想重新看看小星星有没有吃饭；这里由爱莉自己补充当初的来由和必要的会话信息。",
  "title": "关注小星星吃饭",
  "rrule": "DTSTART;TZID=Asia/Shanghai:20270101T183000\nRRULE:FREQ=DAILY;COUNT=1",
  "target": "this_session"
}
~~~

上例仅说明结构，不表示她已经建立了这条计划，也不会作为测试内容注入正式会话。

## 六类中文工具说明

[src/plan-guidance.ts](src/plan-guidance.ts) 保存六类中文案例：关心对方日常、了解后续进展、接回中断话题、记住自己答应的事、安排自己的具体事情，以及接住对方明确提出的提醒。案例说明提醒可以怎么写，不是关键词触发器、固定调度规则或授权。只有对方明确要求时才创建或改动定时任务；此前明确授权且正在执行的任务仍可按该授权处理。

[plan-tools](src/plan-tools.ts) 使用 DSH 支持的必需运行上下文提供中文指导。只有当前作用域精确匹配工具的挂载者且原生工具可用时，该说明才会进入模型请求；其他作用域（包括后代 agent）不会收到。

工具参数、校验、返回值、执行与模型可见的工具描述均使用原生定义。主体提示词正文保持不变，不改写 SOUL.md、USER.md 或 MEMORY.md，也不把案例当成已发生经历或已建立的正式计划。

## 原生工具与 Schema

参数与结果 Schema 的唯一实现位于 [tool-schedule](../../dsh/packages/schedule/tool-schedule/src/index.ts)，记录及结果类型位于 [schedule types](../../dsh/packages/schedule/schedule/src/types.ts)。

一次提醒的创建参数：

| 参数 | 类型 | 必填 | 空值、默认与校验 |
|---|---|---|---|
| prompt | string | 是 | 去除首尾空白后非空，无默认；保存待提醒的原文 |
| title | string | 是 | 去除首尾空白后非空，至多 120 字符，无默认；按原生说明填写简短名称 |
| rrule | string | 是 | `DTSTART` 指定未来绝对时间，下一行为 `RRULE:FREQ=DAILY;COUNT=1`；相对延迟先换算成绝对时间 |
| target | string | 是 | `this_session` 递回当前会话 |

原生 `schedule_create` 还支持循环规则及新会话目标；同一主意识提醒使用 `this_session`，不新建会话。

成功结果含 `id`、`scheduledAt`、`scheduledAtLocal`、`target`、`status` 等。错误返回原生 `{code, message}`；错误不能当成已设好提醒。

其他三个工具也原样保留，完整输入与结果 Schema 直接复用上述唯一实现：

- `schedule_list`：分页列出 Host 任务，可按活动状态筛选。
- `schedule_view`：按 `id` 查看一条 Host 任务，包括目标会话。
- `schedule_edit`：按 `id` 更新、暂停、恢复或删除；可提供 `expectedUpdatedAt` 防止覆盖较新更改。删除不能撤回已经入箱的提醒。

工具可见性受挂载作用域限制。原生管理接口按 Host 任务 ID 操作，不再按调用者会话分区；修改前应核对任务及其目标。委派子代理沿用原生拒绝规则。

## 接入范围

- 本插件只向选择开启本能力的主意识 agent scope 新增计划工具，不修改 standard、minimal 或直播 preset。Host Schedule 是共享原生服务；其他 preset 若本来就声明了原生计划工具，会按 DSH 自身规则在 Host 启用后可用，这不来自本插件的作用域工具注册。
- 复用 Web 已有原生 ScheduleService、storageDomain 和 Session 入箱持久化；停用 profile 原先直接启动的 Host Schedule 行，改由主意识装配完成后挂载同一个原生 Host。
- 主意识固定 ID、cwd、提示词正文与旧历史不改写；不修改其持久 preset，不修改 DSH 源码。
- Host 启动等待的是主意识装配并发布到 registry，不等待 whenIdle。到时仍由原生 followup 递回同一 session，正在处理其他输入也可入箱。
- 主意识 owner 释放时停止本次 Host，避免调度器随后通过通用默认 preset 冷恢复一个装配不同的主意识。正常应用重启时先恢复正确主意识，再加载原生持久计划。
- 本轮不改 pending、外部消息优先级、事项意义判断、复杂事件条件或完整事项／机会状态机。

## 验收与限制

定向隔离测试应覆盖：作用域工具可见性与卸载、调用者 session 绑定、未 ready 不启动 Host、ready 后启动一次、owner 退出关闭 Host、卸载时未完成的 ready 不阻塞、迟到 ready 不再启动、忙时到期入箱、原生持久化与恢复。所有测试使用临时目录和假模型，不建立正式计划或发送平台消息。

计划保存不等于事项完成；原生投递回执只证明已递交并耐久入箱，不证明模型已经理解、工具已执行或外部消息已送达。进程未运行时不会唤起应用或向平台发消息，恢复后的到期行为沿用 DSH；崩溃窗口可能重复投递，不宣称跨服务 exactly-once。

已核对：原生文本包含固定说明 This is a scheduled message from the user，结构来源仍是 source.kind=schedule。本版保留这一原生展示；工具调用与计划原文才是作者来源依据，不能把通用说明当成一条新的人类发言或新授权。该文案的归属展示没有在此最小版本中定制。


## 初次接入验证记录

从 Harness 根目录运行：

~~~sh
node dsh/node_modules/vitest/vitest.mjs run --config plugins/proactive-system/vitest.config.mjs
~~~

专属 15 项测试通过，包含真实原生 Schedule、JSON 任务域、JSONL 会话、主意识 ready 路径和本地假模型。另通过原生工具、持久化重启、到期递送及现有主意识的定向回归；相关源码与集成测试的类型检查零诊断。测试不创建正式计划，不发送平台消息。

2026-11-12 受控重载 Web 前核对准确 owner、进程参数、运行目录、端口与全部会话空闲状态。保持环境和启动参数，以原生 profile 手动启动一次。主意识 live，原生 schedule/catalog 已恢复可读，直播管理 API 与本机舞台仍可用，启动区间没有计划启动或主意识预热错误。未增加应用自启动或自动恢复。工程证据与前后 PID 见 docs/report/2026-11-12-native-simple-plans.md。
