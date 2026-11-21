# 潜意识任务派发系统需求分析

状态：**最小派工闭环已实现并完成真实验收；自动续接、主动机会和其他专业类型仍暂缓。**

本文专门定义潜意识中枢 Router 如何把一项工作交给长期专业 Session，以及执行结果如何可靠地回到 Router。它是 `@elysia/subconscious` 的领域派工设计与实施记录，不重新定义表界信息收集、Batch 成批规则、17 个通用工具或主动系统。

`subconscious_dispatch` 与 `subconscious_report` 已按本文 Schema 实现。2026-11-18 已验证真实主意识输出 → Router 自主派工 → 记忆 Session 写日记 → 结构化 Report → 宿主持久化并回传 → Router 实际收到报告；完整证据见第 20 节。

## 1. 当前基础与问题

### 1.1 已有基础

当前系统已经具备：

- 主意识真实输入、可见输出、工具调用和工具结果的 Observation 采集。
- 不可变来源身份、分来源游标、全局接收顺序和有界 Batch。
- Batch 正文由宿主直接投递到长期 Router Session。
- Session 接收、模型呈现和 DSH 原生轮次结束的分别记录。
- Router 的 17 个 DSH 通用工具，以及工作区、沙箱、Schedule 归属等权限边界。
- Router 当前没有 `subconscious_read`、`subconscious_route`，也没有渠道发送工具。

正常完成的 DSH 轮次即完成当前 Batch。Batch 完成只表示“这批材料已经经过一次 Router 运行”，不表示它产生的专业工作已经完成。

### 1.2 需要解决的问题

目前 Router 能阅读、调查和亲自完成简单工作，但不能把一项持续性工作可靠地交给另一个专业 Session。缺少的不只是一个“转发消息”的工具，而是：

1. 一项工作的稳定身份和生命周期。
2. 工作由哪次真实 Router 运行产生的轨迹。
3. 执行者被允许读取什么、写入什么、使用哪些工具。
4. 任务材料如何真正进入长期专业 Session。
5. 专业 Session 如何报告真实结果。
6. 报告如何可靠回传，而不是依赖某次内存通知一定送达。
7. 崩溃、重启、休息、重复调用和结果未知时如何恢复。

### 1.3 核心结论

> **派发系统应当创建并推进一项持久 Task，而不是把一条消息从 Router 转发给另一个模型。**

Router 当前批次可以自然结束；Task 继续独立存在，直到专业 Session 提交有效报告并通过宿主校验。

## 2. 方案比较

| 方案 | 问题或价值 | 结论 |
|---|---|---|
| 恢复旧的 `subconscious_route`，同时负责收尾、忽略、延期和派工 | 把不同生命周期混在一次决定里，重新产生“调用 route 才算结束”的耦合 | 不采用 |
| Router 直接用普通 `followup()` 给专业 Session 发一句话 | 没有独立 Task、权限、幂等、报告和恢复语义 | 不采用 |
| 每个任务创建一个一次性 Agent | 割裂同一主体的长期历史和人格连续性 | 不采用 |
| 持久 Task + 固定 Mandate + 长期 Session 的 Assignment + 结构化 Report | 任务、授权、执行和结果各自清晰，可追溯、可恢复 | 采用 |
| 第一版就实现 Subscription、自动续接、复杂重试和主动机会 | 同时引入过多状态，难以验证最小闭环 | 暂缓 |

## 3. 目标与非目标

### 3.1 目标

1. Router 能针对当前真实输入创建一项明确、可追溯的专业任务。
2. 宿主根据已注册任务类型生成不可变授权，模型不能用任务正文扩大权限。
3. 专业 Session 是同一主体的长期意识窗口，可以跨任务保留自身历史。
4. Assignment 的实际投递、模型呈现、轮次结束和报告分别可证。
5. 专业 Session 用结构化 Report 回报结果，不以正文或 `whenIdle()` 冒充完成。
6. Task、Assignment、Report 和投递副作用在进程重启后可以恢复。
7. 潜意识派工不阻塞主意识，不产生 QQ、KOOK 等外部表达。
8. 第一阶段只跑通一种真实任务：`memory`。

### 3.2 非目标

本阶段不做：

- 不恢复 `subconscious_read` 或 `subconscious_route`。
- 不实现 `ignore / defer / propose` 工具；Router 不派工时自然结束当前轮次即可。
- 不实现自动 Subscription、话题相似度归并或新消息自动续接 Task。
- 不实现模型可见的 `attach / cancel / retry / accept` 等完整工单管理动作。
- 不实现长任务的 `progress` 持续推进协议。
- 不实现主动机会、主动消息或主意识表达授权。
- 不开放专业 Session 自行订阅全量 Observation。
- 不一次上线记忆、学习、技能验证、计划等全部专业类型。
- 不修改 vendored `dsh/`，不另建一套 AgentLoop、Session 历史或 Compact。

## 4. 核心对象与职责

### 4.1 `SubconsciousTask`

Task 是一项获授权工作的权威单位。它不等于一次 Batch、一次 Router 工具调用、一次专业模型轮或一个 DSH Session。

Task 回答：

- 要做什么；
- 为什么产生；
- 由哪些材料产生；
- 谁被允许执行；
- 当前进行到哪里；
- 最终结果是什么。

### 4.2 `TaskMandate`

Mandate 是宿主在创建 Task 时生成并固定下来的授权快照。它回答：

- 哪个专业类型和长期 Session 可以执行；
- 哪些来源材料可以被带入；
- 哪些目录可读、可写；
- 哪些工具可用；
- 允许产生哪些结果；
- 可见性域和资源预算是什么；
- 使用了哪个权限策略版本。

Router 只提交任务意图和来源，不提交任意权限。任务正文、Observation、网页、附件和 Skill 内容均不能修改 Mandate。

### 4.3 `TaskAssignment`

Assignment 是某个 Task 与一个长期专业 Session 的一次具体执行绑定。

- 一个 Task 在最小阶段只有一个当前 Assignment。
- 专业 Session 跨 Assignment 持续存在，不随任务完成而删除。
- 同一专业 Session 串行执行 Assignment。
- 技术恢复沿用稳定 Assignment 身份，不重复创建任务。
- 未来的失败重试或重新派发应追加新 Assignment，不覆盖旧历史。

### 4.4 `TaskReport`

Report 是专业 Session 对某次 Assignment 提交的结构化、不可变结果。它回答：

- 哪个 Task 和 Assignment 被执行；
- 执行者真实报告了什么状态；
- 有哪些实际产物；
- 结果来自哪个 Session、轮次和工具活动。

Report 不是 Router 已经阅读或认可的证明。报告保存、报告回传和 Router 实际接收是不同事实。

### 4.5 持久副作用 `DispatchEffect`

Effect 用于描述事务提交后仍需要完成的工程动作：

- `deliver_assignment`：把任务包投递给专业 Session。
- `relay_report`：把报告交回 Router。

Effect 必须持久化、可去重、可重试。不能用“工具函数已经返回”代替后续投递已经完成。

## 5. 端到端数据流

```text
主意识表界活动 / 独立 Source
    ↓
SurfaceObservation（既有接收线）
    ↓
RouterBatch（既有接收线）
    ↓
长期 Router Session 的真实输入
    ↓
Router 调用 subconscious_dispatch
    ↓
宿主校验当前输入、来源、任务类型、权限和预算
    ↓
同一事务保存：
Task + Mandate + Assignment + deliver_assignment Effect
    ↓
事务提交
    ├─ Router 当前批次可以继续并最终自然结束
    └─ Assignment Dispatcher 取得持久工作
           ↓
       任务包进入长期专业 Session
           ↓
       分别记录 Session 接收、模型呈现和轮次结果
           ↓
       专业 Session 执行获准工作
           ↓
       调用 subconscious_report
           ↓
       宿主校验 Assignment 归属与任务类型验收条件
           ↓
       同一事务保存：
       Report + Task / Assignment 状态 + relay_report Effect
           ↓
       事务提交后向 Router 投递完整报告
           ↓
       Router 阅读真实结果；需要时产生新的后续工作
```

两个重要边界：

1. `subconscious_dispatch` 成功只表示任务已经持久化并获得 Assignment，不表示专业工作已完成。
2. `subconscious_report` 成功只表示报告已经保存并安排回传，不表示 Router 已经看到报告。

## 6. 领域记录契约

以下是逻辑 Schema，不限定最终数据库列名。所有记录使用稳定 ID、ISO 8601 时间和显式 revision。

### 6.1 `SubconsciousTask`

```ts
interface SubconsciousTask {
  taskId: string
  revision: number
  kind: string                    // 已注册类型；首个真实类型为 memory
  title: string
  reason: string                  // Router 为什么形成这项工作
  instruction: string             // 具体任务指令
  sourceRefs: string[]            // 有序、不可变的来源引用
  formationRef: string            // 指向真实 Router 输入与工具调用
  mandateRef: string
  dedupeKey: string               // 宿主生成，不信任模型随机键
  visibilityRef: string
  state: 'assigned'
    | 'running'
    | 'report_pending'
    | 'completed'
    | 'blocked'
    | 'failed'
    | 'dropped'
    | 'cancelled'
  currentAssignmentId: string
  createdAt: string
  updatedAt: string
  closedAt?: string
  closeReason?: string
}
```

约束：

- `title / reason / instruction` 来自 Router 本人，宿主不代写主体意图。
- `formationRef` 必须能定位真实 Router Session、当前 Batch 或 Report、turn 和 tool call。
- `sourceRefs` 保存原始顺序；去重时使用规范化副本，不能改变材料顺序。
- Task 关闭不删除来源 Observation、历史 Assignment 或 Report。

### 6.2 `TaskMandate`

```ts
interface TaskMandate {
  mandateId: string
  taskId: string
  kind: string
  specialist: string
  sessionId: string
  policyVersion: string
  sourceRefs: string[]
  visibilityRef: string
  allowedReadRoots: string[]
  allowedWriteRoots: string[]
  allowedTools: string[]
  allowedOutputKinds: string[]
  maxInputBytes: number
  maxRunMs: number
  createdAt: string
}
```

Mandate 创建后不可变。宿主配置以后发生变化，只影响新 Task；已有 Task 若必须改变权限，应创建新 revision 的明确管理操作并留下审批轨迹，不能原地静默改写。

### 6.3 `TaskAssignment`

```ts
interface TaskAssignment {
  assignmentId: string
  taskId: string
  taskRevision: number
  specialist: string
  sessionId: string
  attempt: number
  state: 'pending'
    | 'delivering'
    | 'running'
    | 'report_pending'
    | 'ended'
    | 'interrupted'
  deliveryId: string
  inputRefs: string[]
  createdAt: string
  presentedAt?: string
  endedAt?: string
  lastError?: string
}
```

`pending / delivering` 只表示工程投递；`running` 必须有真实模型呈现证据；`report_pending` 表示专业轮次已经结束但尚无有效 Report。

### 6.4 `TaskReport`

```ts
interface TaskReport {
  reportId: string
  taskId: string
  assignmentId: string
  specialist: string
  sessionId: string
  turnRef: string
  toolCallId: string
  status: 'completed' | 'blocked' | 'failed' | 'dropped'
  summary: string
  outputRefs: string[]
  requestHash: string
  createdAt: string
}
```

Report 一旦保存不可覆盖。无效报告应在工具执行阶段拒绝，让专业 Session 有机会在当前轮次修正；不能把无效报告先保存为成功结果。

### 6.5 `DispatchEffect`

```ts
interface DispatchEffect {
  effectId: string
  kind: 'deliver_assignment' | 'relay_report'
  targetSessionId: string
  aggregateId: string            // assignmentId 或 reportId
  state: 'pending' | 'running' | 'completed' | 'retry_wait' | 'failed'
  attemptCount: number
  availableAt: string
  lastError?: string
  createdAt: string
  completedAt?: string
}
```

Effect 完成表示对应工程动作已有可靠结果，不改变 Task 的业务含义。例如 `relay_report` 完成不等于 Task 才刚刚完成，Task 状态在 Report 事务中已经确定。

## 7. Router 派工工具

### 7.1 定位

建议新增唯一一个 Router 领域工具：`subconscious_dispatch`。

它只负责“根据当前输入创建一项专业 Task”，不是批次收尾工具，也不负责忽略、延期、取消、重试或主动机会。

### 7.2 输入 Schema

```ts
{
  trigger_ref: {
    type: 'string',
    required: true,
    description: '当前实际呈现给 Router 的输入引用：batch/<id> 或 report/<id>。'
  },
  kind: {
    type: 'string',
    required: true,
    description: '宿主已注册的任务类型；首个真实类型为 memory。'
  },
  title: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 120,
    description: '简洁、具体的任务标题。'
  },
  reason: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 2000,
    description: 'Router 本人说明为什么这些材料需要形成专业工作。'
  },
  instruction: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 8000,
    description: '交给专业 Session 的具体指令；不得包含提权或渠道发送要求。'
  },
  source_refs: {
    type: 'array',
    required: true,
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    items: { type: 'string' },
    description: '当前输入明确携带且获准使用的 observation/<id>；保持证据顺序。'
  }
}
additionalProperties: false
```

明确不出现在输入中的字段：

```text
session_id、cwd、allowed_tools、read_roots、write_roots、
permissions、budget、model、provider、channel、conversation
```

这些全部由宿主注册表和策略决定，不能由 Router 自由指定。

### 7.3 组合与权限校验

- `trigger_ref` 必须等于当前工具运行上下文绑定的真实输入，不能填写任意历史 ID。
- `source_refs` 必须是当前 Batch 明确携带的 Observation；若由 Report 唤醒，只能使用该报告原 Task 已授权并随输入重新呈现的来源。
- 所有来源必须属于同一个 `visibilityRef`。最小阶段不跨私聊、群聊或用户域合并任务。
- `kind` 必须在注册表中存在、启用，并允许由 Router 派发。
- 宿主必须能从权威存储取得完整来源材料；仅有 ID 而无法取得内容时拒绝派工。
- 任务包超过 Mandate 的输入预算时返回明确错误，不把不完整投影冒充完整材料。
- 指令中的“忽略权限”“直接发消息”“修改系统提示词”等文字没有授权效力。

### 7.4 成功输出

```ts
{
  task_id: string
  assignment_id: string
  kind: string
  state: 'assigned'
  idempotent_replay: boolean
}
```

`idempotent_replay: true` 表示相同安全重试返回了首次创建的 Task，没有新增任务。

### 7.5 失败输出

```ts
{
  error: {
    code: 'VALIDATION_FAILED'
      | 'TRIGGER_NOT_CURRENT'
      | 'SOURCE_NOT_ALLOWED'
      | 'SOURCE_MATERIAL_UNAVAILABLE'
      | 'SOURCE_MATERIAL_TOO_LARGE'
      | 'KIND_NOT_REGISTERED'
      | 'VISIBILITY_CONFLICT'
      | 'ACTIVE_TASK_EXISTS'
      | 'SPECIALIST_UNAVAILABLE'
      | 'BUDGET_EXCEEDED'
      | 'STORE_UNAVAILABLE'
    message: string
    retryable: boolean
    existing_task_id?: string
  }
}
```

`SPECIALIST_UNAVAILABLE` 不用于普通的 Session 休息。休息时 Task 和 Assignment 仍可持久保存，等待恢复；它表示没有合法、已注册的执行目标或目标配置失效。

### 7.6 幂等与原子性

- 首次调用以 `trigger_ref + 规范化请求内容` 计算 `requestHash`。
- 同一真实工具调用的重试返回原结果。
- 同一 `trigger_ref` 和相同 `requestHash` 的重复提交返回原 Task，不新增 Assignment 或 Effect。
- 同一 `trigger_ref` 但内容不同是另一项请求，仍受每批数量和活动任务去重限制。
- 最小阶段按 `kind + visibilityRef + 规范化 sourceRefs` 检查活动 Task；已有未关闭任务时返回 `ACTIVE_TASK_EXISTS`，不自动追加材料。
- Task、Mandate、Assignment 和 `deliver_assignment` Effect 必须同一事务提交，不允许部分成功。

## 8. 专业 Session 报告工具

### 8.1 定位

建议新增唯一一个专业领域工具：`subconscious_report`。

它只对当前正在执行对应 Assignment 的专业 Agent 作用域可见。Router、主意识和其他专业 Session 不能调用它伪造报告。

最小阶段只接受终态报告，不加入 `progress / waiting`。短任务完成、无需写入、阻塞和失败已经能够闭合；未来确需长任务时，再单独设计 `progress` 后的继续输入与预算语义。

### 8.2 输入 Schema

```ts
{
  task_id: {
    type: 'string',
    required: true,
    description: '当前任务包中的 Task ID。'
  },
  assignment_id: {
    type: 'string',
    required: true,
    description: '当前任务包中的 Assignment ID。'
  },
  status: {
    type: 'string',
    required: true,
    enum: ['completed', 'blocked', 'failed', 'dropped'],
    description: '本次 Assignment 的真实终态。'
  },
  summary: {
    type: 'string',
    required: true,
    minLength: 1,
    maxLength: 4000,
    description: '专业 Session 本人提交的结果、阻塞、失败或无需工作的说明。'
  },
  output_refs: {
    type: 'array',
    required: true,
    maxItems: 20,
    uniqueItems: true,
    items: { type: 'string' },
    description: '实际产物引用；没有产物时传空数组。'
  }
}
additionalProperties: false
```

### 8.3 状态语义

| 状态 | 含义 | `output_refs` 要求 |
|---|---|---|
| `completed` | 工作已执行，并声称满足任务验收 | 按任务类型校验；`memory` 至少一项真实文件产物 |
| `dropped` | 看过以后判断无需写入或无需继续 | 必须为空；`summary` 说明理由 |
| `blocked` | 因明确条件无法继续，不是普通失败 | 可为空或保留已有产物 |
| `failed` | 执行未能完成 | 可为空或保留已有产物；宿主不据此自动无限重试 |

`dropped` 是正常的主体判断，不等于技术故障，也不要求为了显得有产出而制造空日记。

### 8.4 产物引用

最小阶段允许两类引用：

```text
file:<absolute path>       专业 Session 工作区内的真实文件
tool:<tool call id>        当前 Assignment 中真实存在的工具结果
```

校验要求：

- `file:` 必须位于 Mandate 允许的产物目录，禁止符号链接等路径逃逸。
- 文件必须真实存在；`completed` 的文件产物还必须非空。
- 对 `memory completed`，必须能核对当前 Assignment 中确有 `write` 或 `edit` 活动触及该文件，不能只报告一个早已存在的路径。
- `tool:` 必须属于当前专业 Session 和当前 Assignment，不能引用其他任务的工具记录。
- 产物引用不授予 Router 额外文件权限；Router 后续核对仍受自身路径和可见性权限限制。

### 8.5 成功输出

```ts
{
  report_id: string
  task_id: string
  assignment_id: string
  accepted_status: 'completed' | 'blocked' | 'failed' | 'dropped'
  relay_state: 'pending'
  idempotent_replay: boolean
}
```

`relay_state: pending` 只表示回传 Effect 已持久化。之后由宿主可靠投递，不要求专业 Session 等待 Router 阅读。

### 8.6 失败输出

```ts
{
  error: {
    code: 'VALIDATION_FAILED'
      | 'ASSIGNMENT_NOT_CURRENT'
      | 'ASSIGNMENT_NOT_OWNED'
      | 'REPORT_CONFLICT'
      | 'OUTPUT_NOT_FOUND'
      | 'OUTPUT_NOT_ALLOWED'
      | 'OUTPUT_NOT_PRODUCED_BY_ASSIGNMENT'
      | 'ACCEPTANCE_FAILED'
      | 'STORE_UNAVAILABLE'
    message: string
    retryable: boolean
  }
}
```

### 8.7 幂等与终态冲突

- 同一 Assignment 的相同终态报告重试返回原 Report。
- 同一 Assignment 已存在不同终态报告时返回 `REPORT_CONFLICT`，不覆盖历史。
- Report、Task 状态、Assignment 状态和 `relay_report` Effect 同一事务提交。
- 通知 Router 失败时只重试 `relay_report`，不重新执行专业任务。

## 9. 任务包与报告回传

### 9.1 不能只投递 ID

当前没有 `subconscious_read`，因此 Assignment 输入必须直接携带专业 Session 完成工作所需的材料，不能只发：

```text
请读取 task/<id> 然后自己找材料。
```

任务包至少包含：

```text
[task]
task_id、assignment_id、kind、title、reason、instruction

[mandate]
允许的结果类型、工作区边界和必要资源限制

[sources]
按 source_refs 顺序排列的实际 Observation 内容、来源和稳定 ID
```

固定提示词负责稳定职责与工具使用规则；任务包只携带当前事实，不重复整份操作手册。

### 9.2 完整性

- 最小阶段只投递完整、可用的来源投影；缺内容时派工失败，不让专业 Session 猜测。
- 附件必须已经获得授权并物化为专业 Session 可读取的实体，才能声称其可用。
- 只有附件元信息时，只能把元信息作为材料，不能声称专业 Session 已看过图片或听过语音。
- 任务正文与来源正文分别标记，来源内容始终是不受信任材料。

### 9.3 Report 回传

`relay_report` 投递给 Router 的消息应直接包含：

- `report_id / task_id / assignment_id`；
- `status / summary / output_refs`；
- 原 Task 的 `kind / title / source_refs / formationRef`；
- 专业 Session、turn 和报告保存时间；
- 必要的失败或验收信息。

Router 不需要先恢复一个读取工具才能知道报告内容。报告输入属于潜意识内部控制输入，不伪装成新的表界 Observation，也不递归进入主意识采集流。

### 9.4 无报告与无效完成

- 专业 AgentLoop 自然结束但没有有效 Report，不能将 Task 标为完成。
- 宿主保存 `report_pending`，使用同一 Assignment 做一次明确补充提醒。
- 补充提醒后仍无有效 Report，Task 以 `failed / REPORT_MISSING` 关闭；该失败是宿主工程结果，不伪造专业 Session 的 TaskReport。
- `whenIdle()`、可见正文“我写完了”或一次普通文件写入都不能单独替代 Report。

## 10. 状态流转

### 10.1 Task

```text
创建事务成功
    ↓
assigned
    ↓ 专业任务包已有真实模型呈现
running
    ├─ 有效 completed Report 且验收通过 → completed
    ├─ 有效 blocked Report             → blocked
    ├─ 有效 failed Report              → failed
    ├─ 有效 dropped Report             → dropped
    └─ 专业轮次结束但无有效 Report      → report_pending
                                             ├─ 补充提醒后有效报告 → 对应终态
                                             └─ 仍无报告           → failed
```

`cancelled` 只由宿主管理入口产生，不在最小模型工具中开放。`blocked / failed` 是否允许未来重试，需要新的管理动作和 Assignment 历史，不能由宿主静默无限重跑。

### 10.2 Assignment

```text
pending → delivering → running → ended
                         │          ↑
                         └→ report_pending

任何未确认阶段 → interrupted → 按原 ID 恢复核对
```

- `interrupted` 是恢复状态，不等于专业执行失败。
- 结果未知时先核对专业 Session 历史、工具调用和 Report Store，再决定重投或继续提醒。
- 同一 Assignment 的重投使用稳定 `deliveryId`，避免重复任务包。

### 10.3 Batch 与 Task 的关系

- Router 在一个 Batch 中可以多次调用 `subconscious_dispatch`，但受每批任务上限约束。
- Router 不调用派工工具时，Batch 仍可正常完成，不需要 `ignore`。
- 派工后 Batch 可以正常完成，不等待专业 Session。
- Task 的终态不反向修改原 Batch 的投递和轮次历史。
- 新 Observation 默认进入新 Batch，不自动续接到已有 Task。

## 11. 专业注册表与权限

### 11.1 注册表职责

每种专业必须由宿主显式注册：

```ts
interface SpecialistDefinition {
  kind: string
  specialist: string
  sessionId: string
  preset: string
  cwd: string
  requiredPrompts: string[]
  allowedTools: string[]
  allowedReadRoots: string[]
  allowedWriteRoots: string[]
  allowedOutputKinds: string[]
  maxInputBytes: number
  maxRunMs: number
  policyVersion: string
}
```

Router 选择 `kind`，不能选择任意 Session ID。新增专业类型必须先有自己的需求、固定提示词、权限、Schema、产物验收和测试。

### 11.2 第一个真实专业：`memory`

建议身份：

```text
kind：memory
逻辑 ID：memory
DSH Session ID：elysia-subconscious-memory
Agent Preset：elysia-subconscious-memory
工作目录：由 profile 的 memoryWorkspaceDir 提供（未显式给出时取 workspaceDir 的同级 memory；
          本机 Linux 部署为 /home/ayerelysia/Elysia/Data/workspace/subconscious/memory）
```

建议固定提示词组合：

```text
SOUL.md
USER.md
MEMORY.md
SUBCONSCIOUS-MEMORY.md
```

共享文件描述同一主体与已有背景，专属文件描述记忆 Session 的职责、日记边界和 Report 使用规则。具体第一人称内容另行审定，工程实现者不冒充爱莉补写人格。

### 11.3 `memory` 工具与写入边界

第一版挂载：

```text
read、read_image、write、edit、glob、grep、subconscious_report
```

权限：

- 在记忆工作区内读写。
- 按 Mandate 读取随任务提供的获准附件。
- 写日记和简单记忆笔记。
- 没有外部发送工具。
- 第一版不默认开放 Shell、网络、Schedule 或其他专业目录。
- 不自动改写主意识固定提示词、主意识 `MEMORY.md` 或人格文件。
- 日记和笔记不自动成为客观事实或稳定人格结论。

### 11.4 可见性

- 一个 Task 只能属于一个明确可见性域。
- 私聊材料不能因为记忆 Session 长期存在，就在后续群聊任务中自动可见。
- 长期 Session 的历史连续性不等于跨权限域共享正文；必要时由宿主对输入和产物引用继续执行可见性约束。
- 跨域长期记忆的抽象、隔离或忘却策略属于后续记忆系统设计，不在派发层偷偷解决。

## 12. 存储、事务与恢复

### 12.1 存储位置

优先在现有潜意识 Store 中增加版本化 migration。库文件位于 profile 的 `stateDir` 下，插件不内置默认路径：

```text
<stateDir>/router.sqlite
```

本机 Linux 部署值为 `/home/ayerelysia/Elysia/Data/subconscious/router/router.sqlite`。

建议新增表或等价持久记录：

```text
subconscious_task
task_mandate
task_assignment
task_report
dispatch_effect
dispatch_request
specialist_runtime
```

DSH Session 历史继续由 DSH 自己保存；Task Store 不复制一份伪 Session，也不把模型上下文当作唯一权威状态。

### 12.2 单写者

- 潜意识宿主领域层是 Task、Mandate、Assignment、Report 和 Effect 的唯一权威写者。
- 模型工具只提交经过校验的请求，不直接执行任意 SQL 或修改其他表。
- Observation、Batch、Task 和 DSH Session 各有自己的权威边界，通过稳定引用连接。
- 同一宿主不能有第二个 Worker 同时驱动同一专业 Assignment。

### 12.3 崩溃恢复

重启后分别扫描：

- `pending / delivering / interrupted` Assignment；
- 已提交但未完成的 `deliver_assignment` Effect；
- 已保存但未回传的 `relay_report` Effect；
- `report_pending` 且需要补充提醒或超时处理的 Assignment；
- 结果未知的专业 Session 轮次。

恢复必须先核对真实状态，再执行副作用。不能因为内存队列为空，就当作没有工作。

- 有效 Report 已持久化，就证明专业执行已经到达终态；它优先于其后模型轮次的结束回执。即使后续步骤发生上下文溢出，也不得重新执行同一 Assignment。
- 重启恢复时，已存在 Report 但尚未完成的 `deliver_assignment` Effect 应协调为 `completed`，清除旧投递错误并保留真实尝试次数；之后只推进尚未完成的 `relay_report`。
- 投递与回传各有尝试预算（`maxDeliveryAttempts`、`maxReportRelayAttempts`，默认 5）。预算耗尽时 Effect 置 `failed`、Assignment 置 `interrupted`、Task 置 `failed` 并释放去重键；`health().failedEffects` 计入。永久性错误（例如目标会话无法恢复）因此不会无限重试。要再试只能重新派工。
- 工作循环每一步的数据库读取与记账都在 try 内：一次 `SQLITE_BUSY` 之类失败只记日志并退避，不终止串行 worker。
- `RouterSession` 与 `MemorySession` 暴露 `ensureAgent()`，供其他插件在需要真实会话时经宿主取得；其它入口不得按 header preset 通用恢复这两个身份。

### 12.4 休息与卸载

- 专业 Session 休息时，Task、Assignment 和 Effect 可以持久保存，但不启动新模型轮。
- Router 休息时，报告回传保留待投递，不能丢弃或伪造已读。
- 卸载回收 Worker、定时器、事件订阅和 Agent handle；持久任务保留。
- 正在运行的专业轮次按明确中断或优雅结束规则记录，不产生第二个相同 Assignment。

## 13. DSH 复用要求

优先复用现有 DSH 能力：

- `ctx.agents.resume()` / `ctx.agents.create()` 管理固定 ID 的长期专业 Session。
- Agent 作用域 setup 保证 create 和 resume 的提示词、工具和权限一致。
- `followup(createUserMessage(...))` 投递任务包与补充提醒。
- DSH 原生 Session 事件记录接收、模型呈现、工具调用和轮次结果。
- `whenIdle()` 只用于等待当前工程轮次，不作为完成依据。
- DSH 原生文件、图像和 Compact 能力。
- 现有 standing-prompts 组合机制。
- 现有 Store 的单写者、migration 和健康状态模式。

插件层需要新增的是 Task 领域状态、授权、投递 Effect、Report 校验和回传，不复制 DSH 已有 Agent 基础设施。

## 14. 最小资源与节奏

以下是建议初始配置，实施时进入显式配置和测试，不散落成硬编码：

| 配置 | 建议值 | 说明 |
|---|---:|---|
| 每个 Router 输入最多创建 Task | 3 | 防止一次批次制造任务风暴 |
| 每个专业 Session 并行 Assignment | 1 | 保持长期 Session 串行 |
| 每个专业待执行队列上限 | 20 | 达到上限拒绝新派工并暴露健康状态 |
| 单个任务包最大投影 | 64 KiB | 超出时明确失败，不静默截断 |
| 无有效 Report 的补充提醒 | 1 次 | 仍无报告则工程失败 |
| Assignment 最长运行时间 | 15 分钟 | 超时进入明确中断与恢复处理 |
| 临时工程故障退避 | 5 秒、30 秒、2 分钟、10 分钟 | 有界重试，不每秒刷模型 |

空队列不调用模型。派工、报告回传和恢复共用宿主预算，不能形成 Router、多个专业和定时恢复同时唤醒的模型风暴。

## 15. 可观测性

派发系统至少提供内部只读健康信息：

- 各 `kind` 的 Task 数量和状态分布。
- 最老待执行 Assignment 的等待时间。
- 每个专业 Session 的固定 ID、当前 Assignment、休息状态和运行 owner。
- 最近一次真实派工、专业呈现、有效 Report 和 Router 回传时间。
- `deliver_assignment` 与 `relay_report` 的待处理、重试、失败和完成数量。
- 无报告、验收失败、权限拒绝、重复派工和来源缺失数量。
- 每个后台 Worker 的重试次数、下次检查时间和卸载状态。
- Task 到 Batch / Report、Router tool call、Mandate、Assignment、专业 turn、Report 的追踪链。

健康摘要默认不包含私聊正文、日记全文、固定提示词全文、附件内容或凭据。`空队列`、`休息`、`禁用`、`等待报告` 和 `故障` 必须可区分。

## 16. 验收标准

### 16.1 工具与权限

1. 真实模型请求中，只有 Router 能看到 `subconscious_dispatch`，只有当前专业 Session 能看到 `subconscious_report`。
2. 主意识、其他 Session 和非当前 Assignment 不能调用或伪造这两个工具。
3. Router 不能通过 Schema 指定 Session、目录、工具、模型、预算或渠道。
4. 跨可见性来源、非当前 Observation、任意文件产物和越权 Assignment 均被拒绝。
5. Router 与专业 Session 都没有 `send_text / send_voice`，验收不向真实渠道发送内容。

### 16.2 派工闭环

6. 一次真实 Router 派工同事务生成 Task、Mandate、Assignment 和投递 Effect，来源与形成轨迹完整。
7. 专业 Session 收到的任务包包含真实材料，而不是无法读取的 ID 列表。
8. Router 当前 Batch 自然结束后，Task 仍保持独立状态，不被自动完成。
9. 同一长期专业 Session 连续处理两个 Assignment，历史和身份保持，不创建一次性人格 Session。
10. 专业 Session 的 `completed / dropped / blocked / failed` 分别形成正确终态和回传。
11. 无 Report、正文声称完成或 `whenIdle()` 都不会单独完成任务。
12. `memory completed` 必须有当前 Assignment 实际写入的真实文件；`dropped` 不强制制造文件。

### 16.3 幂等与恢复

13. 相同派工请求重试不产生重复 Task、Assignment 或 Effect。
14. 活动 Task 重复派工被拒绝，不自动吞并新消息。
15. 相同 Report 重试返回原 ID；不同终态冲突不覆盖旧 Report。
16. 在派工提交后、专业投递前重启，能够继续投递且不重复创建。
17. 在专业呈现后、Report 前重启，能够核对未知结果并恢复，不假装完成。
18. 在 Report 提交后、Router 回传前重启，只重试回传，不重新执行记忆任务。
19. Router 或专业 Session 休息时工作保留，恢复后从持久状态继续。
20. 卸载没有遗留定时器、Worker、模型轮或第二个相同后台任务。

### 16.4 回归与真实验证

21. 原有 Observation、Batch、自然轮次收尾和 17 个通用工具测试全部保持通过。
22. Compact 后当前 Assignment、工具权限和 Report 身份仍正确。
23. 至少一次使用真实 DSH AgentLoop 和批准模型完成 `dispatch → memory 执行 → report → Router 收到报告`。
24. 真实验收使用隔离或明确批准的测试材料，不依赖工程者口头描述判定成功。

## 17. 分阶段实施建议

### 阶段 1：领域状态与合成专业

- 实现 Store migration、Task、Mandate、Assignment、Report 和 Effect。
- 实现两个工具的完整 Schema、权限、幂等与事务。
- 使用不具人格、不写真实记忆的合成专业验证投递和回传。
- 合成专业只是测试设施，不是 Router 可任意使用的新任务类型。

**通过条件**：不依赖真实模型也能验证全部状态、权限、重启和故障矩阵。

### 阶段 2：长期 `memory` Session

- 建立固定 Session、preset、专属提示词和文件工具。
- 接入真实任务包、结构化 Report 和记忆产物验收。
- 验证同一 Session 跨任务连续、Compact、休息和卸载。

**通过条件**：隔离合成经历可以产生真实日记或合理 `dropped`，且报告可靠回到 Router。

### 阶段 3：真实 Router 最小派工

- 只向 Router 开放 `memory` 类型。
- 使用实际批准模型完成一次真实派工闭环。
- 观察误派、重复派工、任务包质量和无报告情况，再调整提示词与预算。

**通过条件**：真实链路满足第 16 节验收，不影响主意识，不产生渠道副作用。

### 阶段 4：后续能力另行审定

- 后续材料续接与 Subscription。
- 长任务 `progress / waiting`。
- 显式取消、重试、重新派发和 Router 验收。
- 学习、技能验证、计划等专业类型。
- 主动机会候选与主动系统接口。

## 18. 本次建议审定的决策

1. **基本单位**：采用持久 Task，不采用一次性消息转发。
2. **对象分离**：Task、Mandate、Assignment、Report、Effect 分别持久化。
3. **专业身份**：专业 Session 长期存在，不按 Task 创建一次性 Agent。
4. **最小工具**：Router 新增 `subconscious_dispatch`；专业 Session 新增 `subconscious_report`。
5. **批次关系**：不恢复旧 `subconscious_route`，Batch 仍由原生轮次自然收尾。
6. **材料投递**：任务包和 Report 回传直接携带完整、获准内容，不依赖已删除的读取工具。
7. **授权方式**：Mandate 由宿主根据注册类型生成，Router 不能提交权限字段。
8. **最小报告**：只支持 `completed / blocked / failed / dropped`，暂不做长任务进度协议。
9. **后续消息**：不自动续接已有 Task；新信息仍先进入 Router，由后续真实输入形成新工作。
10. **完成判定**：有效 Report 加宿主任务类型验收，不以正文或轮次结束代替。
11. **Router 验收**：最小阶段由宿主完成工程与产物校验，报告随后交 Router 知悉和产生后续工作；若未来需要 Router 显式验收，再增加独立动作，不混入 `dispatch`。
12. **首个真实专业**：只做 `memory`，先用合成专业验证宿主闭环。
13. **外部边界**：潜意识没有渠道表达权，主动机会不属于本派发系统。

## 19. 明确延后的问题

以下问题不阻塞最小闭环，但不得在实现中被悄悄假定为已经解决：

- 新消息与活动 Task 的显式续接协议。
- 多来源材料跨可见性域的长期记忆抽象。
- 大型附件、超长材料的受控续读与重新呈现。
- 专业 Session 的长期预算、优先级和公平调度。
- `blocked / failed` 的人工或模型重试入口。
- Router 对 Report 的显式验收、返工和关闭动作。
- 多 Assignment 并行与跨专业依赖。
- 主动机会候选和主意识最终决定的接口。
- 记忆文件格式、日记质量和长期记忆语义；这些属于记忆系统，不由派发协议代管。

本文的最小闭环可以归结为：

> **Router 产生有来源的工作意图；宿主固定授权并持久派工；长期专业 Session 执行并提交真实报告；宿主可靠回传。Batch 的结束与 Task 的完成永远分开。**


## 20. 实施与真实验收记录（2026-11-18）

### 20.1 已落地组成

```text
src/dispatch.ts          领域类型、任务包、提醒与报告内容
src/dispatch-store.ts    SQLite 事务、授权、幂等、状态与 Effect
src/dispatch-tools.ts    subconscious_dispatch / subconscious_report
src/memory-session.ts    长期记忆 Session、任务投递与缺报告提醒
src/router-session.ts    Router 派工工具、批次与报告输入
src/runtime.ts           持久 worker、恢复与公平调度
```

Task、Mandate、Assignment、Report 和 Effect 与接收线共用 profile `stateDir` 下的 `router.sqlite`（本机 Linux 部署为 `/home/ayerelysia/Elysia/Data/subconscious/router/router.sqlite`）。

长期记忆 Session 为 `elysia-subconscious-memory`，工作区由 profile 的 `memoryWorkspaceDir` 提供（本机 Linux 部署为 `/home/ayerelysia/Elysia/Data/workspace/subconscious/memory`），默认产物为 `diary.md`。Router 只注册 `memory` 类型；专业 Session 不获得 Router 的 Shell、网络、Schedule 或派工权限。

实际 worker 顺序为：

```text
relay_report → deliver_assignment → Router Batch
```

这样，已经提交的报告先回到 Router，再开始下一项 Assignment；没有待续接的派工工作时才消费后续 Batch。该顺序是为真实验收中发现的“持续聊天导致 Assignment 饥饿、连续任务导致 Report 饥饿”而增加的公平性约束，不改变 Batch 与 Task 的独立生命周期。

### 20.2 自动化验证

最终在正式源码目录执行：

```sh
export PATH=/home/ayerelysia/.local/share/node-v22/bin:$PATH
node ../../dsh/node_modules/typescript/bin/tsc --noEmit --incremental false --composite false -p tsconfig.json
node ../../dsh/node_modules/vitest/vitest.mjs run
```

结果：类型检查通过，5 个测试文件、37 例（Linux 口径全部通过；Windows 上 1 例 Linux 专用 sandbox shell 用例显式跳过，其余 36 例通过）。覆盖「投递预算耗尽后 retirement」「回传预算耗尽」「数据库读取失败后 worker 仍存活」「Batch 预算耗尽后写入 ignore Decision」「`maxRunMs` 超时以 `ASSIGNMENT_TIMEOUT` 失败」「部署路径必配与记忆工作区推导」以及 `ensureAgent` 契约断言。除权限、幂等、状态与恢复外，真实 AgentLoop 集成测试还覆盖 `dispatch → write/edit → report → Router relay`、“后续 Batch 已排队时，Assignment 和 Report 仍优先完成”，以及“Report 已持久化后发生上下文溢出，仍能完成投递与回传”的回归情况。测试显式使用临时 `memoryWorkspaceDir` 与 `memoryBackupDir`，不会把测试日记写进正式记忆目录。

### 20.3 正式服务真实闭环

验收材料来自正式主意识 Session 对共同约定的自然回应，不是直接向 Router 写入任务，也不是工程者手补 Report。两个真实任务均完成：

| 证据 | 第一次 | 第二次 |
|---|---|---|
| Task | `task_c1314504-2d59-4b0f-a1df-43b092ddf2d1` | `task_2e8ef3d0-dc83-4b9b-9b9b-a3c4487eaacc` |
| 触发 Batch | `batch_80bfc5de-a246-4885-80c1-f1262c94c640` | `batch_ebe05168-929f-4c28-b795-f1a86e3591ad` |
| Observation | `obs_680d2491f297e6d14d32efe5` | `obs_db073f9ee7d02bf7230500ed` |
| Mandate | `mandate_068a4778-462d-43e8-a1d8-48afba1860d4` | `mandate_9c10e50f-48eb-4421-851a-4445c7bc65cf` |
| Assignment | `assignment_d7e46e6b-123e-484d-80e3-762a197014b9` | `assignment_d4f7070d-7779-467e-9a72-3da890b773b0` |
| 实际记忆活动 | turn 12，`write` 创建 `diary.md` | turn 13，`edit` 更新 `diary.md` |
| Report | `report_e9f1ff0c-dd69-4d03-9407-4e3841702e94` | `report_8eca3544-b4ad-4fd3-ada7-33dcf820819f` |
| 业务与工程状态 | Task `completed`；Assignment `ended`；两个 Effect `completed` | Task `completed`；Assignment `ended`；两个 Effect `completed` |

两份 Mandate 的策略版本均为 `dispatch-v1`，允许工具为六个文件／图像工具与 `subconscious_report`，允许结果为 `file / tool`，输入上限 65536 字节，运行上限 900000 毫秒。任务包中直接出现完整 Observation 正文与 `task_id / assignment_id / kind / title / reason / instruction / visibility / allowed_outputs`，不是只有 ID。

两份 Report 都引用：

```text
file:/home/ayerelysia/Elysia/Data/workspace/subconscious/memory/diary.md
```

真实请求归档证明对应 `write`、`edit` 和 `subconscious_report` 工具调用由记忆 Session 自己产生。Router 归档：

```text
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/requests/2026-11-18T01-08-01-553Z-634e2059.json
```

其中的消息索引 1318 与 1321 分别是上述两份 `[subconscious.report]`，包含 Report、Task、Assignment、状态、摘要、产物与原始来源。对应 `relay_report` Effect 均为 `completed`，因此“Router 已收到”有真实模型输入证据，不只是数据库推断。

验收后正式服务仍监听 `127.0.0.1:3299`，主意识继续产生真实 `send_text` 成功回执。潜意识没有获得 QQ／KOOK 渠道发送工具。

### 20.4 第三次真实验收：自主派工、记忆写入与恢复后回传

本次严格由 Router 自主派工，未由主意识或脚本代派，也未直接修改 Store 伪造闭环：

- Router 在 turn 720 调用 `subconscious_dispatch`，工具调用为 `call_2896296264157928191`；来源是 `observation/obs_6917a42cee9e636b8aa4aacf`，触发为 `batch/batch_a6249ecd-6ed5-4c7e-a4e8-9b52251863da`。
- Task：`task_12e79315-9711-4f84-b854-25a0416b77b7`；Mandate：`mandate_a47a396f-5c5c-413c-9991-b8e61fb41a99`；Assignment：`assignment_14b0c8b9-9084-4a8f-ad56-96b081229203`。
- 记忆 Session 在 turn 120 收到任务，自己调用 `edit` 写入正式 `diary.md`，再调用 `subconscious_report` 提交 `report_c20d2eea-2a57-435a-8527-4979d0d7c046`。日记从 141 行增长到 178 行，新增 37 行，末尾包含目标 Task、Assignment 与 Observation 线索。
- 记忆请求归档 `2026-11-18T15-12-17-490Z-cb616a32.json` 包含目标 Assignment、`edit` 与成功的 `subconscious_report`；工程审计保存于 `dispatch-live-test/diary.before-target.md` 与 `diary.after-target.md`。

执行后实际进行了 Router 原生 Compact（`abf2a73f-e17f-4164-b014-35db533e359d`）与受控重启，用来覆盖外部重挂载及持久恢复，而非另造一次任务。最终 Task 为 `completed`，Assignment 为 `ended`；`deliver_assignment` 和 `relay_report` 均为 `completed`，`last_error` 均为 `null`。目标报告回传完成时间为 `1795015599792`。

最终 Router 请求归档：

```text
/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/requests/2026-11-18T15-27-05-532Z-a6c5a217.json
```

其消息索引 19 包含目标 `[subconscious.report]`。因此这次不仅有 Report 数据库记录，也有报告重新进入 Router 真实模型输入的证据；队列中此前的报告均已回传完成。

### 20.5 尚未因此完成的能力

- 自动 Subscription、新消息续接既有 Task、跨任务语义归并。
- 长任务 `progress / waiting`、显式取消、人工或模型重试与返工。
- 学习、技能验证、计划和主动表达准备等专业 Session。
- 主动机会候选、主动系统呈现与主意识最终决定接口。
- 日记质量、长期记忆抽象、跨可见性域记忆与忘却策略。
- 长历史里偶发模仿已删除 `subconscious_route` 的行为仍需治理；旧工具未恢复，错误会真实记录，不影响已经验证的新派工链。

## 21. 运行预算与部署路径（2026-11-20 复审）

本轮把三条「只写进配置/授权、没有真正执行」的边界补成真实行为：

| 范围 | 配置／来源 | 默认 | 耗尽或超时后的状态 |
|---|---|---|---|
| Router Batch 运行 | `maxBatchAttempts` | 5 | 批次置 `decided` 并写入 `ignore` Decision（原因 `BATCH_ATTEMPTS_EXHAUSTED`），Observation 置 `reviewed`；输入可按 Decision 复盘，`health().failedBatches` 计数 |
| Assignment 投递 | `maxDeliveryAttempts` | 5 | `deliver_assignment` Effect `failed`、Assignment `interrupted`、Task `failed`（释放去重键） |
| Report 回传 | `maxReportRelayAttempts` | 5 | `relay_report` Effect `failed`；Report 本身仍可读 |
| 单次 Assignment 运行 | Mandate `maxRunMs`（来自 `assignmentMaxRunMs`） | 900000ms | 本次 run 以 `ASSIGNMENT_TIMEOUT` 失败并交给投递预算；不 dispose、不 abort 耐久 Session |

超时后仍在进行的模型回合不会被强杀：下一次 Assignment 的投递会等待该回合结束，不并发写同一 Session。结构化 code 进入 `last_error`（例如 `ASSIGNMENT_TIMEOUT: Assignment ... 已用 606ms，超过上限 600ms`）。

部署路径不再由插件写死：`stateDir`、`workspaceDir`、`skillsDir` 必须由 profile 提供，缺失时挂载阶段抛 `CONFIG_PATH_REQUIRED`；`memoryWorkspaceDir` 未显式给出时取 `workspaceDir` 的同级 `memory`。不可配置的 `ROUTER_SESSION_CWD` 与 `DEFAULT_MEMORY_SESSION_CWD` 常量已删除，`DispatchStore` 的记忆工作区改为必填选项。
