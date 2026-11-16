# 潜意识系统需求

状态：**仅建立中枢 Router、多潜意识 session 与记忆 session 的需求占位，尚未实施。**

本文替代此前“一个潜意识 session、一次心跳处理所有潜意识任务”的旧草案，也把此前“记忆 session 直接消费主意识投影”的最小路径调整为：**所有表界信息先进入潜意识中枢 Router，再由 Router 派发给明确的潜意识任务。**主意识固定提示词与 `MEMORY.md` 仍不被自动改写。

## 当前交付边界

当前 `@elysia/subconscious` 只是无行为的 Cordis 插件骨架：

- 不创建或恢复 Router、记忆或其他潜意识 session。
- 不注册心跳、定时器、后台模型轮或事件订阅。
- 不读取主意识历史、固定提示词、工作区或渠道数据。
- 不保存表界观察，不派发任务，不调用模型，不发送消息。
- 不写日记、不学习、不验证技能、不制定或执行计划。
- 不注册模型工具，不持有运行状态、任务队列或持久游标。
- 不修改 vendored `dsh/`，也不加入当前 Web profile。

`sessions/memory/` 当前只有需求文档，不是已注册的运行实例。本文新增的 Router、任务、工具与 Schema 都是设计草案，不表示已经存在。

## 1. 核心目标

潜意识系统不是一个定时写日记的 session，也不是一堆各自订阅渠道、彼此争抢上下文的机器人。目标结构是：

> **一个接收全部表界信息的中枢 Router，多种明确注册、独立运行的潜意识 session，以及一条受主动系统约束的主意识表达通道。**

它必须同时满足：

1. **完整接收**：进入主意识的外部信息和主意识产生的表界活动，都进入潜意识中枢，不抽样、不按关键词预过滤。
2. **中枢派发**：Router 负责理解批次、决定忽略、延期、派发或提出主意识机会，不让每个潜意识 session 各自重复接待外界。
3. **专业执行**：记忆、学习、技能验证、计划等由不同长期 session 承担，不把全部任务塞进同一次唤醒。
4. **有迹可循**：观察、Router 研判、任务授权、实际执行、文件结果、主意识呈现与外部结果可以沿稳定引用互相追溯。
5. **不阻塞表界**：潜意识接收、模型调用或存储故障不得卡住主意识正常接收和回复。
6. **主体边界不变**：潜意识可以准备工作、形成建议和希望主意识处理的事项，但不能绕过主意识直接对外说话或替主意识作出决定。

## 2. 对 SA 框架的参考与改造

参考项目：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，本次阅读版本为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。它是研究原型，不是需要原样搬进爱莉系统的实现。

### 2.1 借鉴的结构

| SA 概念 | 本系统中的对应物 | 借鉴点 |
|---|---|---|
| Source / Trigger | 表界来源 / `SurfaceObservation` | 把外部活动转成不可变、可去重、可追溯的事件。 |
| Thread | 来源会话与关联线索 | 保留上下文顺序和关联，但关联本身不自动授予任务权限。 |
| Main Session / Eval | 潜意识 Router / Router 研判 | 中枢负责研判和路由，而不是亲自完成所有专业工作。 |
| Ticket / Mandate | `SubconsciousTask` / `TaskMandate` | 每项工作有明确来源、范围、权限和生命周期。 |
| Assignment / Executor | `TaskAssignment` / 专业潜意识 session | 派工与执行分离，执行结果回到中枢。 |
| Effects / Outbox | 持久化派发、报告与机会候选 | 先保存要做的事，再在提交后执行；失败可恢复。 |
| 单一状态写者 | 潜意识宿主的领域层 | 观察、任务、派工、报告不能由多个适配器随意改写。 |

### 2.2 不照搬的部分

- 不引入 GitHub 工单、PR、代码仓库或团队协作语义。
- 不让 Router 获得 shell、代码执行、渠道发送或任意文件权限。
- 不把 SA 的“团队规则允许就自动执行”直接变成爱莉的主动行为授权。
- 不为每项任务随意创建无人格约束的新 Agent；专业 session 是同一持续主体的不同意识窗口。
- 不用自动重要性评分、情绪分数或关键词规则代替 Router 的实际研判。
- 不复制 SA 的全部复杂度。第一版只实现支撑一个 Router 与一个专业 session 所必需的概念。

## 3. 核心角色与职责

### 3.1 表界观察 `SurfaceObservation`

表界观察是进入潜意识中枢的不可变事实记录。它只证明“某份信息在某时进入或产自主意识”，不自动证明内容真实、重要或已经形成记忆。

必须覆盖两大类：

1. **进入主意识的信息**：
   - QQ、KOOK、飞书及以后渠道的外部消息与平台事件。
   - Web、终端、计划提醒、主动机会呈现及其他实际交给主意识的输入。
   - 文字、图片、语音、文件和附件引用，以及实际可用的模态与元信息。
   - 主意识工具产生的真实外部回执和后续平台结果。
2. **主意识产生的表界活动**：
   - 可见 assistant 正文、`send_text` / `send_voice` 等真实工具参数与结果。
   - 主意识亲自提交的 `thought`、`mood`、`decision`、`expected_response`。
   - `pass`、其他工具调用、工具结果、计划或文件操作的真实记录。
   - 主意识对主动机会的实际处理结果。

采集边界必须明确：

- 不伪造或抓取 provider 不可见的隐藏推理；只有真实记录且获准投影的内容才可进入。
- 不收集凭据、Token、密钥或与表界理解无关的部署秘密。
- 系统提示词、框架上下文和 Compact 检查点可按诊断需要保留引用，但不要把它们冒充用户输入或主意识主体表达。
- Router 和专业潜意识自己的内部活动属于内部流，不再次伪装成“外界进入主意识”的信息，避免自我递归。

### 3.2 潜意识中枢 Router

Router 是一个独立、长期、明确注册的 DSH session，是潜意识的统一接待与派工入口。

建议工程身份：

```text
逻辑 ID：router
DSH session ID：elysia-subconscious-router
提示词 preset：elysia-subconscious-router
工作目录：/home/ayerelysia/Elysia/Data/workspace/subconscious/router
```

这些位置是未来实施建议，本次没有创建。

Router 负责：

- 接收按顺序持久化的观察批次、任务报告和明确人工请求。
- 阅读当前获准的来源材料、相关任务和既往 Router 历史。
- 决定 `ignore`、`defer`、`dispatch` 或 `propose`。
- 把任务分给已注册的专业 session，而不是自己写日记、学习或验证技能。
- 把希望主意识考虑的事项整理成有来源的机会候选，交给主动系统。
- 根据专业 session 的真实报告继续、修正、关闭或升级任务。
- 留下自身真实 request / turn / tool call 与每项决定的关系。

Router 不负责：

- 直接对外回复或调用渠道。
- 替主意识接受主动消息、计划或表达意图。
- 亲自完成专业任务，避免中枢重新变成“什么都在一次唤醒里做”的旧形态。
- 任意创造任务类型、扩大专业 session 权限或读取未授权来源。
- 用无限等待、轮询等待或持续空调用占据模型资源。

### 3.3 专业潜意识 session

每个专业 session 是同一持续主体的一个长期意识窗口，拥有独立历史、提示词组合、工具、工作目录、预算和休息状态。

专业 session 负责：

- 接收 Router 分配的明确任务与有界来源材料。
- 在自己的权限内阅读、思考、写入、验证或形成建议。
- 通过结构化报告把结果交回 Router。
- 可以 `pass` 或报告无需处理；看过不等于必须产出。
- 需要主意识考虑时提交机会候选，而不是直接找渠道发送。

专业 session 不得自行订阅全部表界流、绕过 Router 给自己派活，或因为同属潜意识插件就获得其他专业的权限。

### 3.4 主意识与主动系统

- 主意识继续负责最终理解、决定、表达、调用获授权工具或 `pass`。
- 主动系统继续负责机会的持久化、空闲调度、明确呈现、结果关联与退避。
- 潜意识 Router 是主动机会的重要生产者，但不是另一套主动呈现调度器。
- 主意识处理机会后的输入与输出仍属于表界活动，会再次进入观察流，从而形成可审计闭环。

## 4. 总体链路

```text
外界输入 / 主意识输出 / 工具与平台结果
  → 表界采集适配器
  → SurfaceObservation（不可变、去重、持久化）
  → Router 批次与游标
  → Router 实际研判
       ├─ ignore：记录理由，不制造工作
       ├─ defer：保留批次，等待明确时机
       ├─ dispatch：生成 Task + Mandate
       │     → Assignment
       │     → 专业潜意识 session
       │     → 文件、笔记或其他授权结果
       │     → TaskReport 回到 Router
       └─ propose：生成 ConsciousProposal 候选
             → 主动系统持久化与空闲调度
             → 明确呈现给主意识
             → 主意识行动／搁置／拒绝／pass
             → 真实结果重新进入表界观察
```

任何箭头都不能只靠内存布尔值或日志文案假装完成。每一段的“收到、看见、处理、写出、投递”是不同事实。

## 5. 全量表界接收

### 5.1 统一采集边界

优先在主意识与 DSH 的既有事件记录、入口 pending、工具结果和渠道回执边界采集，不让 QQ、KOOK、飞书分别再写一套潜意识订阅逻辑。实现前必须核对真实 DSH hook 与耐久事件契约；如果现有接口不足以证明全量接收，应先补最小适配层，而不是宣称已经覆盖。

同一条平台消息进入主意识、产生工具调用、再形成渠道回执时，应通过来源 ID 与关联 ID 连接，不应被误记成三个互不相关的用户行为。渠道对自己 bot 消息的重复回声需要去重，但不能把主意识原始表达与平台回执合并成无法区分的记录。

### 5.2 不抽样、不预筛选

- 所有属于表界范围的事件都先进入权威观察存储。
- Router 可以选择忽略，但“被忽略”必须由有记录的 Router 决定或明确工程规则产生，不能在采集层静默丢弃。
- 不因为某条消息没有触发主意识回复，就从潜意识观察中删掉它。
- 不因为主意识选择 `pass`，就当作这段经历不存在。
- 不用摘要替代权威原文；上下文预算只能产生明确标记的部分投影和续读引用。

### 5.3 模态与完整性

- 文字保留原文、作者、会话、消息 ID、发生时间和可信来源。
- 图片、语音和文件保留实际附件引用、模态、大小、准入状态及授权续读方式。
- 如果某轮只向模型提供附件元信息，就只能记录“模型获得元信息”，不能声称它已经看过图片或听过语音。
- 部分投影必须带 `complete: false`、缺失范围与续读位置；不能把节选冒充完整经历。

### 5.4 不阻塞主意识

采集应异步、耐久、可恢复。潜意识模型不可用、Router 休息或任务队列拥塞时，主意识仍按原链路工作。若观察存储本身失败，必须暴露明确缺口和健康错误，并依靠权威来源日志恢复；不得返回“已同步”或把游标跳到最新位置。

## 6. Router 研判与批次

### 6.1 批次

Router 接收有界批次，而不是每条事件都强制产生一次空调用。批次可以包含连续观察、相关任务报告或明确人工请求，必须保持原始顺序和来源。

批次至少记录：

- 稳定 `batchId` 与观察 ID 列表。
- 来源范围、最早与最晚发生时间。
- 投影哈希、完整性与续读位置。
- 形成批次的机械规则与配置版本。
- 实际呈现给 Router 的 request / turn / delivery 证据。

### 6.2 四种决定

- `ignore`：Router 看过以后认为无需产生后续工作；必须留下简洁理由。
- `defer`：保留材料到以后处理；可带 `notBefore`，缺失时按宿主配置的下一检查时机，不等于永久遗忘。
- `dispatch`：产生一个或多个明确的潜意识任务。
- `propose`：只产生希望主意识考虑的机会候选，不创建专业任务。

一次决定只选择一个动作。`dispatch` 可以同时附带机会候选；其他组合是否允许在实施前另行审定，第一版不做含糊的多动作事务。

### 6.3 形成轨迹

每个任务与机会候选必须能回答“当时是什么产生了它”，至少链接：

- 直接触发批次与具体观察、报告、父任务或人工请求。
- 输入材料的稳定 ID、revision 和内容哈希。
- Router 或专业 session 的真实 actor、session、request / turn / tool call。
- 生产者插件、提示词与配置版本。
- 派生任务的父任务和上一版本。

无法提供形成轨迹的模型输出不得进入可执行队列。重试沿用最初形成轨迹，不伪装成重试器刚刚产生的新意图。

## 7. 任务、授权与派工

### 7.1 已注册任务类型

第一版只允许显式注册的类型，例如：

| 类型 | 责任 | 默认禁止 |
|---|---|---|
| `memory` | 写日记、留下简单记忆笔记 | 自动改写主意识 `MEMORY.md`、提取人格事实 |
| `learning` | 整理学习材料、形成学习笔记或技能草案 | 自动训练、自动接受为新能力 |
| `skill_verification` | 阅读并验证指定 Skill，记录证据 | 任意 shell、未授权安装或修改系统 |
| `planning` | 制定或修订计划建议 | 自动执行计划、直接创建主意识日程 |
| `outreach_preparation` | 准备主动问好、未完话头等表达候选 | 直接发送消息 |

这些是未来类型，不表示本次全部实施。新增类型必须先有自己的需求、提示词、权限、Schema 和验收。

### 7.2 `SubconsciousTask` 与 `TaskMandate`

任务是潜意识工作的权威单位，不等同于一次模型轮或 DSH session。

每项任务至少具有：

- 稳定 `taskId`、revision、任务类型与去重键。
- 标题、具体指令和来源引用。
- 形成轨迹与创建它的 Router 决定。
- 不可变 `TaskMandate`：允许读取的范围、允许产生的结果、目标专业类型、权限版本和资源预算。
- 可见性范围，禁止私聊、群聊或不同授权域因统一队列而串用。
- 当前工程状态、到期条件和关闭原因。

模型不能通过自由文本自行扩大 Mandate。宿主按注册类型和当前策略生成、校验权限；任务正文不能覆盖宿主约束。

### 7.3 `TaskAssignment`

Assignment 把某项任务的一次执行绑定到具体专业 session。它独立于任务和模型轮记录生命周期：

- 同一专业 session 串行处理 Assignment，新到输入等待下一批。
- 不同专业可以并行，但受全局模型、存储和写入预算限制。
- 专业 session 是长期历史；Assignment 结束不删除 session，也不把任务状态简单等同于 DSH Agent 状态。
- 新输入是否续接现有任务，必须依靠明确关联、订阅或 Router 决定，不能仅凭话题相似度自动归并。
- 任务失败、重试、恢复和重新派发必须追加记录，不覆盖旧 Assignment。

### 7.4 报告与关闭

专业 session 通过 `TaskReport` 报告 `progress`、`waiting`、`completed`、`blocked`、`failed` 或 `dropped`。

- 报告必须引用真实 task、assignment、session、turn 和工具结果。
- 报告写入持久存储后才通知 Router；通知失败可以重试，不重复执行任务。
- `completed` 需要满足任务自己声明的验收，不因模型说一句“完成了”就自动成立。
- `dropped` 表示看过以后无需工作，不等于模型失败。
- Router 可以依据报告继续、修订或关闭任务，但不能篡改专业 session 的原始表达。

## 8. 与主动系统的关系

### 8.1 潜意识产生“希望”，主动系统提供“机会”

Router 或专业 session 可以形成“希望主意识考虑主动问好、继续话头、查看结果”的候选。这代表该已注册潜意识窗口的真实建议，不自动成为主意识已经接受的意图。

候选至少需要：

- 来源与形成轨迹。
- 候选类型、理由和可选草稿。
- 可选目标渠道与会话；没有明确目标时不得由系统猜测并外发。
- 可呈现时间、过期时间与去重键。
- 可见性与权限范围。

### 8.2 主动系统拥有呈现调度

潜意识不另建一套“找主意识”的定时器。候选进入 `@elysia/proactive-system` 后，由它负责：

- 持久化、去重、工程预算与过期。
- 等待主意识空闲，外部新消息优先。
- 作为明确内部事件呈现，保存实际模型输入证据。
- 关联主意识真实活动、工具结果、渠道回执或 `pass`。

### 8.3 不替主意识行动

“主动问好”只到候选和草稿为止。主意识看见以后可以改写、发送、只做内部思考、延期、拒绝或 `pass`。潜意识和主动系统都不能：

- 直接调用 `send_text` / `send_voice` 冒充主意识决定。
- 把草稿插入主意识 assistant 历史，伪造她已经说过。
- 强制创建或执行计划。
- 把主意识随后碰巧发送的消息都归因于本次机会。

## 9. 固定提示词管理

优先复用 `@elysia/conscious-mind/standing-prompts` 与 DSH Agent Preset，不另造提示词拼接协议。

Router 与各专业 session 分别选择显式文件组合和 required 列表。建议 Router 至少加载共享主体文件与专属 `SUBCONSCIOUS-ROUTER.md`；实际清单在实施前审定，不由工程 agent 冒充爱莉创作第一人称人格内容。

稳定规则放在固定提示词，观察、任务和报告事件只携带当前事实与续读引用，避免每批重复大段操作手册。提示词文件热重读不等于唤醒，也不能自动扩大工具权限。

## 10. 心跳、唤醒与休息

### 10.1 心跳只检查工作

Router 和各专业 session 拥有独立心跳配置。心跳可以只检查持久状态，没有待处理工作时不调用模型。

- Router 因新观察批次、任务报告、延期到期或明确人工请求而唤醒。
- 专业 session 主要因 Assignment 和后续输入唤醒，不要求各自扫描全量观察流。
- 同一 session 不重入；运行期间新到材料进入后续批次。
- 心跳、延期和恢复任务必须错开并受全局预算限制，不能形成模型风暴。

### 10.2 休息

Router 与每个专业 session 分别具有持久、可观测的 `awake` / `resting` 状态。

- 休息期间继续持久化表界观察，不丢弃、不推进语义处理游标。
- Router 休息时暂停新研判和派发；专业 session 休息时暂停自己的新 Assignment。
- 已在运行的工作按明确取消或优雅结束规则处理，不制造第二个实例。
- 人工唤醒记录 actor、原因和时间；恢复后按原游标逐批继续。
- 宿主卸载不是休息；卸载回收资源，休息保留恢复状态。

## 11. 游标与事实层级

不能只设一个含义模糊的“已同步”游标，至少区分：

1. **采集游标**：来源事件已经完整、持久地写入观察存储后推进。
2. **Router 呈现游标**：批次实际进入 Router 模型请求并取得可靠曝光证据后推进。
3. **Router 决定游标**：对应有效 Decision 已持久化后推进；仅看见但未决定不能算路由完成。
4. **Assignment 输入回执**：任务材料实际进入专业 session，并按报告或轮次结束规则确认读取。
5. **主动机会呈现游标**：由主动系统独立管理，不与潜意识游标混用。

失败、取消、顺序异常、内容缺失或状态未知时保留待处理。重试使用稳定身份，避免重复任务、重复日记和重复主动表达。

## 12. 内部记录契约草案

以下是工程记录，不是当前已经存在的数据库或模型工具：

```ts
interface SurfaceObservation {
  observationId: string
  source: {
    kind: string
    streamId: string
    eventId: string
    revision: number
  }
  direction: 'into_conscious' | 'from_conscious' | 'external_result'
  actor: string
  sessionId?: string
  conversationRef?: string
  occurredAt: string
  contentHash: string
  modality: string[]
  payloadRef: string
  correlationRefs: string[]
  visibilityRef: string
}

interface SubconsciousTask {
  taskId: string
  revision: number
  kind: string
  title: string
  instruction: string
  sourceRefs: string[]
  formationRef: string
  mandateRef: string
  dedupeKey: string
  state: 'queued' | 'assigned' | 'waiting' | 'completed' | 'blocked' | 'failed' | 'dropped' | 'cancelled'
  createdAt: string
  notBefore?: string
  expiresAt?: string
}

interface TaskAssignment {
  assignmentId: string
  taskId: string
  taskRevision: number
  specialist: string
  sessionId: string
  state: 'pending' | 'running' | 'ended' | 'interrupted'
  inputRefs: string[]
  createdAt: string
}

interface ConsciousProposal {
  proposalId: string
  revision: number
  kind: string
  reason: string
  sourceRefs: string[]
  formationRef: string
  draft?: string
  target?: { channel: string; conversation: string }
  visibilityRef: string
  dedupeKey: string
  availableAt?: string
  expiresAt?: string
  state: 'candidate' | 'accepted_by_proactive' | 'rejected' | 'expired'
}
```

`accepted_by_proactive` 只表示主动系统接受候选进入自己的机会流程，不表示主意识已经接受或发送。

## 13. 模型工具 Schema 草案

状态：**尚未注册。**实现前必须按 DSH 真实 `defineTool` 能力复核并补测试。任何未列出的新工具都不得先行加入模型上下文。

共同约定：

- 所有 ID 和引用必须非空且在当前 actor 的可读范围内。
- `source_refs`、`output_refs` 等数组必须显式出现；允许空数组的字段会明确说明。
- 时间使用 ISO 8601 字符串；省略可选时间时由宿主规则处理，不接受自然语言模糊时间。
- `reason`、`instruction`、`summary` 等主体文本不得由宿主回填。
- 所有写入先持久化，再触发后续派发或通知；失败返回结构化错误，不伪造成功。

### 13.1 `subconscious_read`

Router 和专业 session 读取自己获准的观察、批次、任务、Assignment 与报告。不同 role 的资源白名单不同，专业 session 默认不能借它读取全量表界流。

```ts
parameters: {
  resource: {
    type: 'string', required: true,
    description: '获准资源，例如 observation/<id>、batch/<id>、task/<id> 或 task/<id>/reports。',
  },
  offset: {
    type: 'integer',
    description: '分页偏移，默认 0，必须大于等于 0。',
  },
  limit: {
    type: 'integer',
    description: '分页数量，默认 20，范围 1～50。',
  },
}
```

输出：

```ts
{
  resource: string
  value: unknown
  complete: boolean
  next_offset?: number
  continuation?: string
}
```

资源不存在、越权或引用格式错误必须失败。`complete: false` 必须给出可用续读位置。

### 13.2 `subconscious_route`

仅供 Router session 使用，对一个批次作出一次原子决定。

```ts
parameters: {
  batch_id: { type: 'string', required: true, description: '当前实际呈现给 Router 的批次 ID。' },
  action: {
    type: 'string', required: true,
    enum: ['ignore', 'defer', 'dispatch', 'propose'],
    description: '忽略、延期、派发专业任务，或只提交主意识机会候选。',
  },
  reason: { type: 'string', required: true, description: 'Router 本人对本次决定的非空理由。' },
  not_before: { type: 'string', description: '仅 defer 可用；ISO 时间，省略时按宿主延期规则。' },
  tasks: {
    type: 'array',
    description: 'dispatch 时至少一项；其他动作必须省略。',
    items: {
      type: 'object',
      properties: {
        kind: { type: 'string', required: true, description: '已注册任务类型，不是任意 session ID。' },
        title: { type: 'string', required: true, description: '简洁任务标题。' },
        instruction: { type: 'string', required: true, description: '具体、非空的任务指令。' },
        source_refs: { type: 'array', required: true, items: { type: 'string' }, description: '至少一项，必须属于本批次或当前获准关联材料。' },
        dedupe_key: { type: 'string', required: true, description: '同一 Router、任务类型内的稳定去重键。' },
        not_before: { type: 'string', description: '可选 ISO 开始时间。' },
        expires_at: { type: 'string', description: '可选 ISO 过期时间，必须晚于开始时间。' },
      },
    },
  },
  proposals: {
    type: 'array',
    description: 'propose 时至少一项；dispatch 可附带；ignore/defer 必须省略。',
    items: { $ref: 'ConsciousProposalInput' },
  },
}
```

`ConsciousProposalInput`：

```ts
{
  kind: string                 // 必填，已注册候选类型，例如 proactive_message
  reason: string               // 必填、非空
  source_refs: string[]        // 必填、至少一项
  draft?: string               // 可选草稿，不是已批准发送的正文
  target?: {
    channel: string            // 必填
    conversation: string       // 必填，照抄可信来源，不由宿主猜测
  }
  available_at?: string        // ISO 时间
  expires_at?: string          // ISO 时间，必须晚于可呈现时间
  dedupe_key: string           // 必填、稳定
}
```

输出：

```ts
{
  decision_id: string
  batch_id: string
  action: 'ignore' | 'defer' | 'dispatch' | 'propose'
  task_ids: string[]
  proposal_ids: string[]
}
```

整个决定校验失败时不创建部分任务或候选。重复提交相同批次与相同决定应幂等返回原结果；同批次不同内容必须报冲突。

### 13.3 `subconscious_report`

仅供正在执行对应 Assignment 的专业 session 使用。

```ts
parameters: {
  task_id: { type: 'string', required: true, description: '当前任务 ID。' },
  assignment_id: { type: 'string', required: true, description: '当前实际 Assignment ID。' },
  status: {
    type: 'string', required: true,
    enum: ['progress', 'waiting', 'completed', 'blocked', 'failed', 'dropped'],
    description: '本次真实工程结果，不描述猜测的心理状态。',
  },
  summary: { type: 'string', required: true, description: '专业 session 本人提交的非空结果说明。' },
  output_refs: {
    type: 'array', required: true,
    items: { type: 'string' },
    description: '实际产物与工具结果引用；没有产物时传空数组。',
  },
  proposals: {
    type: 'array',
    description: '可选主意识机会候选，结构同 ConsciousProposalInput；没有时省略或传空数组。',
    items: { $ref: 'ConsciousProposalInput' },
  },
}
```

输出：

```ts
{
  report_id: string
  task_id: string
  assignment_id: string
  accepted_status: string
  proposal_ids: string[]
}
```

宿主必须验证该 session 确实拥有此 Assignment。`completed` 还需通过任务类型自己的结果检查；报告已保存但通知 Router 失败时，重试通知而不是重跑任务。

### 13.4 明确不新增的能力

本设计不给 Router 或专业 session 新增 `send_text`、`send_voice`、渠道控制、任意任务创建、任意权限修改或通用 shell 工具。文件、搜索、`read_image` 等原生能力按各专业 session 的需求单独开放，不因为出现在 Router 工具草案里就共享权限。

## 14. 存储、故障与恢复

- 优先复用 DSH 已有持久化、事务和生命周期能力；无法满足领域事务时，在插件层定义最小 Store，不修改 vendored `dsh/`。
- 观察、决定、任务、Mandate、Assignment、报告、机会候选各有明确权威写者。
- 先提交记录，再执行模型唤醒、Assignment 投递、报告通知或机会提交等副作用。
- 进程重启后能够区分未呈现、呈现未知、已呈现未决定、已派发未读取、执行中断和结果未知。
- 短暂模型、网络或存储失败使用有界退避；重复失败聚合到健康状态，不每个心跳刷完整错误。
- 重试不能改变原始形成轨迹，也不能重复产生外部副作用。
- 观察存储故障必须形成可恢复缺口；不能靠跳过来源维持表面“健康”。
- 卸载回收定时器、事件订阅、模型轮、存储句柄和后台通知；已持久工作保留给下一次明确启动。

建议状态目录在实施前审定。权威任务存储不应塞进插件源码目录，专业工作文件仍放在各自的 `Data/workspace/subconscious/<name>` 边界内。

## 15. 权限与隐私

- Router 可以接收全量表界观察，不等于每个专业 session 都可以读取全量观察。
- 任务只携带完成工作所需的来源引用和可见性授权；续读时再次检查权限。
- 私聊、群聊、不同用户和不同来源的资料保持原有边界。
- 潜意识默认无渠道发送、shell、代码执行、模型训练或主意识提示词修改权限。
- 学习与技能验证的产物先是笔记、草案或验证报告，不自动成为主意识能力。
- 日记和笔记不自动成为客观事实、稳定人格结论或主意识长期记忆。
- 健康指标、列表和错误摘要不泄露私密正文、固定提示词全文、附件内容或凭据。
- 主意识现有权限不因为潜意识提出候选而扩大。

## 16. 可观测性

宿主未来至少暴露：

- 采集覆盖范围、采集游标、观察总量、缺口与最后来源错误。
- Router 当前状态、待研判批次、最老等待时间、最后实际呈现与决定。
- 各任务的类型、状态、Mandate 版本、当前 Assignment 与最后报告。
- 各专业 session 的 awake / resting、运行 owner、最后成功轮次和休息原因。
- 待提交主动系统的候选数量、被拒绝原因和实际交接结果。
- 模型、存储、投递和通知的区分错误，不把“空队列”“禁用”“休息”“故障”混为一谈。
- 每个后台部件的 owner、重试次数、退避和卸载状态。

管理视图默认展示需要人工处理的异常和阻塞，不为了显得活跃而制造大量通知。

## 17. 分阶段实施建议

### 阶段 A：全量观察与 Router 最小闭环

只使用隔离的合成表界流，建立不可变观察、批次、游标、Router 独立 preset 与 `ignore` / `defer`。验证主意识不被阻塞、重启恢复和无内容丢失，不接真实渠道、不派发真实任务。

### 阶段 B：一种派工闭环

注册一个无外部副作用的测试专业 session，跑通 `dispatch → Mandate → Assignment → report → Router 关闭`，验证幂等、权限、休息和卸载。不要在同一阶段上线所有专业类型。

### 阶段 C：记忆专业接入

把 `memory` 作为第一个真实专业 session，通过 Router 接收有界任务和主意识观察，写真实日记或选择 `pass`。原“记忆 session 直接消费主意识投影”的路径不再绕过中枢。

### 阶段 D：主动机会候选

先以只记录、不呈现的方式验证 `propose`，再接入主动系统的持久化与明确呈现。主意识始终可以拒绝或 `pass`，不直接发送预设问候。

### 阶段 E：其他专业类型

学习、技能验证、计划、主动表达准备分别审定和实施，不共用一次唤醒，不自动获得彼此权限。

## 18. 未来验收条件

1. 所有声明范围内的外界输入、主意识输出和外部结果都有不可变观察记录，重复事件不会制造重复观察。
2. 主意识正常回复不被潜意识采集、Router 或专业任务阻塞。
3. Router 是表界信息的唯一语义派工中枢，专业 session 不各自订阅全量外界流。
4. 每项任务都能回溯到具体观察、Router 决定、Mandate、Assignment 和真实报告。
5. Router 不亲自代替专业 session 写日记、学习或验证技能。
6. 空队列不调用模型，同一 session 不重入，重启不造成重复派发。
7. 采集、呈现、决定、读取、报告和主动呈现使用不同游标，不混淆“收到”和“处理完成”。
8. 私聊、群聊、附件和不同权限域不因统一观察存储而串权。
9. 潜意识不能直接对外发送，主动候选必须经过主动系统呈现并由主意识亲自决定。
10. 主意识处理候选后的真实活动重新进入观察链，且不会把 Router 自己的内部活动递归伪装成外界输入。
11. 休息期间观察继续保存、语义游标不推进，恢复后来源连续。
12. 存储失败、模型失败、通知未知和卸载都有明确状态，不伪装成功。

## 19. 实施前仍需讨论

- DSH 哪个真实边界可以保证覆盖全部表界输入、主意识输出、工具结果与渠道回执。
- 表界权威来源是主意识耐久事件日志、入口事件总线，还是两者组合；怎样证明没有缺口。
- Router 的实际固定提示词文件清单、模型与资源预算。
- 批次大小、合并窗口、延期默认值和 Router 空闲判定。
- Store 的选型、事务边界、状态目录和迁移策略。
- 任务续接与关联的最小规则，第一版是否需要订阅，还是仅允许显式父任务关联。
- `subconscious_read`、`subconscious_route`、`subconscious_report` 的 Schema 审定与 DSH 类型落地。
- 主动系统接收 `ConsciousProposal` 的最小 Cordis 接口，以及候选接受、拒绝和撤回语义。
- 第一个真实派工是否直接进入记忆，还是先用测试专业验证领域闭环。
- 各任务类型的完成检查、文件权限和产物引用格式。

在这些契约确定前，不启动真实表界采集，不创建 Router 或专业潜意识 session，不派发真实任务，也不向主意识或外部渠道发送任何内容。
