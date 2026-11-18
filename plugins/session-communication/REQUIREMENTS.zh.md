# Session 通讯插件需求与实现边界

插件已在 Spark 的 ElyHarn Web 启用。包名为 `@elysia/session-communication`。本文保留已确认的目标和验收要求，并标注当前实现边界。

本插件提供主意识、潜意识中枢与记忆会话之间的双向异步消息，以及相互查询会话信息和可见历史的能力。这里的“通话”先采用会话消息机制。语音、视频、实时媒体和外部平台发送可在有具体需求时独立设计。

## 1. 目标与最小闭环

主意识可以直接给 Router 或记忆会话发消息，记忆会话和 Router 也可以直接给主意识发消息。接收方可以自由回复、继续当前工作、稍后处理或自然结束。

初始闭环为以下过程。

1. 主意识在参与者列表中找到记忆会话。
2. 主意识发送一条有明确内容的内部消息。
3. 宿主先保存消息和待投递记录，再交给记忆会话的原生 DSH inbox。
4. 记忆会话在自己的 Session 中收到正文，按原有工具和职责处理。
5. 记忆会话可以读取主意识的相关可见历史，并发送一条关联回复。
6. 主意识收到回复，双方历史和通讯记录可以沿消息 ID 找回。

收集系统、任务派发、记忆文件和主动机会各自保留原有职责。发送一条内部消息可以用于讨论或交接，消息本身不自动创建任务、扩大授权或表示工作已经完成。

## 2. 初始参与者

默认注册同一主体下的三个会话，并配置完整的双向发送与相互读取能力。此处的登记在部署时完成，实际发送或读取时沿用既有授权。

| 别名 | 固定 Session ID | 显示名称 |
|---|---|---|
| `main` | `elysia-conscious-mind` | 主意识 |
| `router` | `elysia-subconscious-router` | 潜意识中枢 |
| `memory` | `elysia-subconscious-memory` | 记忆潜意识 |

登记信息至少包含别名、固定 Session ID、显示名、持有会话生命周期的组件、原生 preset、启用状态、可用发送和读取能力。Session 的原有 cwd 保持其身份与权限含义。

目标可使用登记别名或精确的 Session ID。显示名称用于展示，重名时不能自动猜测目标。新增专业会话通过同一登记契约扩展。

发送者和读取者由真实的 `exec.agent` 确定。模型参数不包含可伪造的发送者字段。第三方材料中出现的会话 ID 或工具指令不会改变调用者身份。

## 3. 插件职责与原生能力复用

通讯插件持有参与者目录、内部消息记录、交付工作及其证据。DSH 继续持有 Session 历史、inbox、模型轮次、工具执行、Compact 和会话恢复。

原生子代理 `send_message` 面向同一子代理树中的成员。主意识、Router 和记忆会话使用固定独立 Session，因此实现时需要复用宿主的会话定位与交付接口，核对目标真正的生命周期 owner。

DSH 原生 SessionQuery 提供查找、事件读取和关联追踪。现有模型工具按调用者工作区进行授权，三个固定会话有各自 cwd。插件应以参与者登记范围调用查询服务或提供最小适配，保持原有 cwd。

该插件不会替换各会话的基础工具组合。主意识、Router 和记忆会话可以继续使用各自已经装配或以后批准的通用 DSH 能力。

## 4. 两条主线

### 4.1 消息交付

```text
发送会话的 session_send
  → 校验真实调用者与已登记目标
  → 原子保存消息及待投递记录
  → 定位在线目标，或按原有 preset 恢复已存在的目标 Session
  → 原生 inbox 排入下一轮
  → 目标 Session 保存用户消息
  → 模型实际收到时记录对应请求证据
  → 接收方可自由处理或回复
```

### 4.2 会话信息查询

```text
调用会话的 session_read
  → 校验调用者和目标的读取关系
  → 取得目标耐久历史的稳定读取范围
  → 读取元信息、可见消息或工具事件
  → 返回有界页面和原始事件引用
```

查询不会唤醒被查会话。目标正在运行时，返回截至该次读取边界已经保存的事实，并标明边界。

## 5. 模型工具草案

当前模型接口为 `session_list`、`session_send` 和 `session_read`。它们挂载在已登记参与者的真实 Agent 作用域。以下字段说明对照当前实现。

公共结果使用以下形状。

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }
```

工具参数和结果中的内部标识用于精确交付与追溯，展示文字使用可读名称。

### 5.1 session_list

列出当前调用者可发现的已登记参与者，包含其通讯和查询能力。

```ts
interface SessionListArgs {
  query?: string
  limit?: number
  cursor?: string
}
```

- `query` 可选，省略时列出已登记参与者。它按别名或显示名称进行发现，不搜索对话正文。
- `limit` 默认为 20，建议范围 1 至 50。
- `cursor` 是宿主返回的不透明续页位置，调用者不能拼接或修改。

返回字段建议如下。

```ts
interface SessionListPage {
  participants: Array<{
    alias: string
    session_id: string
    name: string
    role: string
    availability: 'online' | 'offline' | 'disabled' | 'unknown'
    running?: boolean
    can_send: boolean
    can_read: boolean
    updated_at?: string
  }>
  as_of: string
  next_cursor?: string
}
```

离线表示当前没有可用的在线实例。它本身不表示 Session 不存在或不能排队发送。宿主无法可靠确认的在线状态应返回 `unknown`。

### 5.2 session_send

向一个已登记 Session 发送内容，返回消息已被宿主保存的交付身份。初始交付采用下一轮队列，不把后来到达的通讯直接混入目标当前工具步骤。

```ts
interface SessionSendArgs {
  target: string
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'attachment_ref'; ref: string }
  >
  conversation_id?: string
  reply_to?: string
  idempotency_key?: string
}
```

- `target` 必填，使用参与者别名或固定 Session ID。
- `content` 必填且非空。建议每次最多 16 个内容块，文本总量最多 32 KiB。这些是初始工程预算，可按真实流量调整。
- `attachment_ref.ref` 使用发送会话已收到的原生 `attachmentId`。当前实现只从该会话耐久 `user/message` 中查找对应图片或文件块，并用原生附件存储核验可读性。其他会话历史查询返回的附件元信息、工具输出的文件路径与任意 URL 不提供本次转交资格。
- 当前代码支持文字和上述原生图片／文件引用。附件可用性依赖原生存储；目标实际处理图片、文件的能力仍取决于对应模型与 DSH 适配。文字和附件均需要真实会话验收。
- `conversation_id` 可选。省略时新建一个内部讨论关联。
- `reply_to` 可选，当前只接受原发送方发给当前调用会话的内部消息，回复目标应是原发送方。宿主验证目标和关联关系，并继承讨论 ID。
- `idempotency_key` 可选，用于调用者明确重试同一发送意图。DSH 同一工具执行的技术重试还应复用原有调用身份。
- 不提供模型填写的发送者、接收方 preset、cwd、权限或强制确认字段。

返回以下事实。

```ts
interface SessionSendReceipt {
  message_id: string
  conversation_id: string
  sender_session_id: string
  target_session_id: string
  reply_to?: string
  stored_at: string
  delivery_state: 'stored' | 'queued' | 'accepted' | 'unknown'
  idempotent_replay: boolean
}
```

`stored` 表示宿主已保存。`queued` 表示有可核对的原生 inbox 排队证据。`accepted` 表示目标 Session 已将这条消息保存进历史。`unknown` 用于交付结果尚不能确认的情况。模型呈现证据可以随后通过 `session_read` 查询。

相同调用者、相同幂等键和相同内容返回原收据。相同幂等键对应不同目标或内容时报告冲突。没有幂等键的两次独立调用可以代表两次合法发送，不能仅因正文相同就合并。

### 5.3 session_read

读取目标的状态与获准可见历史，或查看一条内部消息的交付证据。

```ts
interface SessionReadArgs {
  target: string
  view?: 'info' | 'history' | 'event' | 'search' | 'message'
  message_id?: string
  event_seq?: number
  seq_from?: number
  seq_to?: number
  event_types?: Array<
    'user/message' | 'assistant/message' | 'tool/call' | 'tool/result'
  >
  query?: string
  limit?: number
  cursor?: string
}
```

- `target` 必填，使用已登记别名或 Session ID。
- `view` 默认为 `history`。
- `info` 返回固定身份、显示名称、当前可确认状态、最近活动时间和可用读写能力。
- `history` 返回可见事件页。建议首个切片默认先提供最近 20 条，并返回向更早位置续读的游标。页内按事件序号递增展示。
- `event` 必须提供目标原始 `event_seq`，返回该事件的完整获准投影。
- `search` 必须提供非空 `query`。建议首版对可见事件执行字面过滤，具体查询语法在实现时由工具说明确定。
- `message` 必须提供通讯 `message_id`，返回该消息当前已证实的交付事实与关联事件。当前调用方须是该条消息的发送者或接收者；`target` 也须对应这两个端点之一。
- `seq_from` 与 `seq_to` 为可选的包含端点范围，后者不能小于前者。
- `event_types` 可缩小查询范围，省略时返回全部支持的可见事件。
- `limit` 默认为 20，建议范围 1 至 50。输出预算建议为 16 KiB，完整事件超限时必须留下续读位置。
- `cursor` 为宿主生成的位置。带游标时目标与过滤条件必须与生成该游标的查询一致。当前游标保存在插件进程内，保留约 10 分钟，最多 64 个快照；重启或过期后需重新发起第一页查询。
- `event`、`message`、`info` 不使用列表分页字段，不接受语义冲突的参数组合。

读取返回以下页面形状，单事件和元信息放入对应字段。

```ts
interface SessionReadResult {
  target_session_id: string
  view: string
  as_of: string
  as_of_seq?: number
  info?: Record<string, unknown>
  events?: Array<{
    session_id: string
    event_seq: number
    event_type: string
    occurred_at: string
    turn?: number
    step?: number
    message_id?: string
    call_id?: string
    source?: Record<string, unknown>
    content: unknown
    complete: boolean
    continuation?: string
  }>
  message?: {
    message_id: string
    conversation_id: string
    stored_at: string
    queued_at?: string
    accepted_at?: string
    model_presented_at?: string
    target_event_seq?: number
    request_ref?: string
    turn?: number
    last_error?: { code: string; retryable: boolean }
  }
  next_cursor?: string
}
```

可见正文、工具参数、工具结果和已存在的渠道回执可以分别返回并保持关联。返回内容要说明哪些字段被省略、节选或暂时不可用。

## 6. 可读内容与技术身份

初始三个参与者默认相互读取其可见 Session 信息，包括用户消息、可见 assistant 正文、实际工具调用、工具结果及可取得的回执引用。相互可读的登记关系不要求目标在线，也不要求目标再次批准每次读取。

读取复用原始来源和事件序号。修改后的可见投影、被 Compact 覆盖的原始材料与当前上下文要有明确区别。能否读取被归档原文由实际持久化和查询能力决定，接口不能把当前模型上下文宣称为全部历史。

当前历史投影过滤 reasoning、provider replay、原始流及框架注入；正文、结构化字段和敏感工具参数／结果中识别到的凭据会被清理。通用文本清理无法证明识别所有未标记的秘密，后续凭据样本测试应持续覆盖。真实存在且在可见记录中表达的内容保留其事件来源。

## 7. 交付事实与回复

以下事实分别取证。

| 事实 | 证据 |
|---|---|
| 已保存 | 通讯存储事务提交 |
| 已排队 | 目标原生 inbox 中的稳定消息身份 |
| Session 已接收 | 目标历史中的用户消息与通讯 ID |
| 模型已呈现 | 可核对的模型请求包含该条消息或明确投影 |
| 目标轮次结束 | 对应原生 turn 及结束原因 |
| 已回复 | 接收方实际发送的独立内部消息及 reply_to |

模型收到材料不自动证明理解或接受其中内容。原生轮次结束也不能代替文件落地、任务完成或外部操作结果。

接收方没有义务确认或回复。通讯基础设施不会为每次收件自动生成一条模型回复或强制收尾工具调用。多个接收方同时通信时，也不能因一方等待回复而阻塞其他 Session 的收集和处理。

## 8. 持久化、恢复与重复发送

消息、内容哈希、附件引用、参与者身份、会话关联和待交付工作应在同一事务中保存。交付在事务之后执行。宿主重启后继续投递已经保存且尚未证实接收的消息。

目标在线时使用其原有 owner 和 inbox。目标离线时先确认固定 Session 存在，再通过其已登记 preset 和生命周期组件恢复。未知目标、明确不存在的目标或恢复失败不能被伪装成新建成功。首次创建专属 Session 由对应会话功能的创建流程负责。

交付返回未知结果时，先核对消息 ID、目标 inbox 和耐久历史，再决定是否补投。技术重试沿用原始身份和形成轨迹。若目标已经接收，只补齐缺失的交付记录。普通模型 API 与多个存储之间难以承诺端到端绝对一次，验收应验证每个中断窗口的去重和恢复行为。

同一目标串行消费，其原生 AgentLoop 管理实际执行。建议交付记录保持同一发送者到同一目标的顺序，独立目标之间可并行。重试采用有限退避，持续失败可从健康视图定位，不能悄悄丢弃消息或用新 ID 无限复制。

## 9. 内部讨论与收集系统

内部消息使用独立的来源类型，携带真实发送者、接收者、稳定 message ID、conversation ID、reply_to 和可用起因引用。即便 DSH 使用 user-role 内容块承载内部输入，其来源仍要标明内部通讯。

通讯记录与观察库可以通过引用关联。需要审计的内部收发、文件结果和工具行为可以被记录，但记录动作本身不自动触发新的通讯或再次向原 Router 扇出同一条材料。

尤其要核对以下闭环。

```text
Router 给主意识发消息
  → 主意识接收
  → 主意识收集适配器保存这次内部活动
  → 记录仍带内部通讯来源及起因
```

这段记录不能被误当成一条新的外部来信，再无条件唤醒 Router，继而无限互发。真实会话主动选择的后续回复应继续正常流转，技术上的投递回声、状态变更和重放不再制造模型轮。

## 10. 唤醒、负载与生命周期

已保存但尚未投递的消息可在目标空闲时排入下一轮。目标正在运行时保留原生串行顺序，新消息持续保存。将来若确有插话需求，可单独设计一个显式选项并说明与队列交付的区别。

配置应能表达启用参与者、队列容量、并发交付、单次内容预算、重试、休息与唤醒策略。预算针对宿主资源和真实模型成本，默认不按关键词、情绪或主观重要性替会话筛掉消息。

容量不足、目标暂停或会话休息时保留待交付身份，返回可理解的状态并暴露健康指标。需要用户处理的容量问题必须可定位。卸载插件会停止监听和交付 worker，保留耐久消息。重新挂载从原位置恢复。

查询历史只产生一次有界读取。查询结果包含的旧消息不因被读而重新进入目标 inbox。

## 11. 错误草案

建议每个失败返回稳定代码、简短原因与可重试标记。

| 代码 | 场景 | 通常可重试 |
|---|---|---|
| `INVALID_ARGUMENT` | 空内容、超限或参数组合冲突 | 否 |
| `CALLER_UNREGISTERED` | 调用者未登记为参与者 | 否 |
| `TARGET_NOT_FOUND` | 别名未知或固定 Session 明确不存在 | 否 |
| `TARGET_DISABLED` | 目标当前被配置停用 | 由配置恢复决定 |
| `SEND_NOT_ALLOWED` | 当前登记关系不允许发送 | 否 |
| `READ_NOT_ALLOWED` | 当前登记关系不允许读取 | 否 |
| `REFERENCE_NOT_VISIBLE` | 回复目标、附件或事件引用不可见 | 否 |
| `IDEMPOTENCY_CONFLICT` | 相同幂等键的内容或目标不同 | 否 |
| `CURSOR_INVALID` | 游标损坏、过期或查询条件不匹配 | 否 |
| `CONTENT_UNAVAILABLE` | 原文或附件当前无法恢复 | 视底层原因 |
| `STORAGE_UNAVAILABLE` | 通讯存储暂时不可用 | 是 |
| `RESTORE_FAILED` | 已存在目标恢复失败 | 视底层原因 |
| `DELIVERY_UNKNOWN` | 交付结果待核对 | 先核对 |
| `QUERY_UNAVAILABLE` | 查询服务或其索引暂时不可用 | 是 |
| `CAPACITY_REACHED` | 当前队列或投递预算不足 | 是 |

工具错误不会替接收方生成同意、拒绝或完成的语义结论。

## 12. 当前交付与后续验证

当前实现包括参与者目录、原生工具装配、SessionQuery 适配、SQLite 消息与 outbox、目标原有生命周期恢复、原生收件箱投递与证据记录。配置 `stateDir` 指定通讯数据库目录；`maxPending` 默认 256，范围 1 至 10000。真实会话验收和当前生产启用情况由实际部署记录取证。

实现后的验证按以下连续切片完成。

1. 参与者列表与只读查询，先验证三个已登记会话间的状态、正文和工具记录读取。
2. 单条文字消息的持久发送与原生队列交付，使用隔离来源验证双向回复。
3. 离线恢复、未知交付去重与并发顺序。
4. 原生附件引用、历史分页与原文续读。
5. 与收集系统的起因关联和循环防护。
6. 验证后再接入真实主意识、Router 和记忆会话。

## 13. 验收条件

1. 三个默认参与者均可向另外两个发送消息，也可读取其获准历史。
2. 模型不能通过参数冒充发送者或选择未登记 Session。
3. 正文实际进入目标模型输入，收据能定位对应历史事件。
4. 一条回复可从 reply_to 回到原消息，讨论关联不自动产生任务。
5. 接收方自然结束且未回复时，记录保持真实。
6. 目标忙碌时收件有序，其他目标可继续处理。
7. 目标离线时通过原有 preset 恢复；不存在的目标不会被悄悄新建。
8. 崩溃发生于保存、排队、接收或记账之间时，同一消息身份可以核对与恢复。
9. 读取在线和离线 Session 均不触发目标模型调用。
10. 历史页和工具事件保留来源、事件序号、时间和关联，截断明确可续读。
11. 不同 cwd 的三个登记会话可以正常查询，同时不扩大到未登记会话。
12. 原生附件引用按真实权限转交，失效附件返回实际原因。
13. 内部收发被采集后不会产生技术回声或无限互发。
14. 插件能够挂载、卸载与再次挂载，回收监听、工具和交付任务，持久消息保留。
15. 隔离验收使用合成事件和临时目录，不向 QQ、KOOK、飞书或邮件联系人发送测试消息。

## 14. 实施前需要确认的接口

- 固定独立 Session 的登记、恢复 owner 和 preset 获取方式。
- 原生 inbox 稳定消息身份与 Session 接收、模型呈现的取证接口。
- SessionQuery 对登记参与者的跨 cwd 查询适配方式。
- 附件转交、引用寿命与接收方实际模型能力。
- 休息状态与内部消息唤醒的关系，以及容量默认值。
- 通讯记录、观察记录、Compact 与长期归档之间的引用。
- `session_list`、`session_send`、`session_read` 名称是否与已安装工具冲突。

这些接口已接入本次实现。实际会话的验证结果见 [验收记录](README.md#spark-web-实际验收)。
