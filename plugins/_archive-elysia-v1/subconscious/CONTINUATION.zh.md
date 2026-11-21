# 潜意识任务续接最小版需求

状态：**需求草案，待审定；尚未实施。**

本文定义 `@elysia/subconscious` 如何让同一个 `SubconsciousTask` 在后续真实输入到来时追加新的 `TaskAssignment`，而不是每有一点新材料就创建一个彼此孤立的 Task。

本文只讨论**任务续接**。不实现 Subscription、自动语义归并、长任务进度、主动机会或其他专业 Session。现有 `subconscious_dispatch`、`subconscious_report`、Observation／Batch 接收线和通用工具契约继续有效。

## 1. 当前基础

已经真实跑通：

```text
主意识表界活动
→ Observation / Batch
→ Router 自主 subconscious_dispatch
→ Task / Mandate / Assignment / deliver_assignment Effect
→ 长期记忆 Session 执行并写入 diary.md
→ subconscious_report
→ Report / relay_report Effect
→ Report 真实回到 Router
```

当前模型能够可靠完成“一项短任务的一次执行”。任务、授权、执行、报告、形成轨迹和持久副作用均已有明确身份，Compact、重启和报告后溢出也有恢复语义。

但当前每次派工都创建新 Task；Report 保存时 Task 立即进入终态。系统尚不能表达：

> 这还是刚才那件事，现在有了新材料或明确的下一步，请同一个长期专业 Session 接着做。

## 2. 为什么需要续接

假设一段经历先后到来：

1. 对方说自己准备出门。
2. 十分钟后说已经到达。
3. 又补充今天身体仍然不舒服。

若每条信息都创建独立 Task，记忆 Session 会得到三份没有正式父子关系的工作。虽然长期 Session 的历史可能让它凭上下文猜出联系，但工程记录无法证明三件事属于同一持续经历，也无法稳定回答：

- 当前任务已经处理到哪个阶段；
- 哪份新材料补进了哪项既有工作；
- 哪个 Assignment 使用了哪一版指令和来源；
- 为什么 Router 认为应该续接，而不是另开任务；
- 重复调用、Compact 或重启后，会不会把同一段内容再写一次。

任务续接的目标不是让 Task 永不结束，而是让**同一件事可以拥有多个有明确边界的执行阶段**。

## 3. 核心结论

采用：

> **稳定 Task 身份 + 不可变 TaskRevision + 每次续接追加 Assignment + Report 驱动或 Batch 驱动的显式 Router 决定。**

不采用“直接修改原 Assignment 再跑一次”，也不采用“新消息根据相似度自动并入任务”。

一个 Task 表示一件可持续跟进的事；一个 Assignment 表示这件事在某个阶段交给专业 Session 的一次具体执行。专业 Session 始终是同一个长期主体，Assignment 结束不会删除其历史。

## 4. 目标

1. Router 能把当前真实输入显式续接到一个已有 Task。
2. 每次续接追加新的 Assignment，不覆盖旧 Assignment、Report 或 Effect。
3. 每个 Assignment 都能恢复出自己当时真实的指令、来源和形成轨迹。
4. 续接沿用原 Task 的类型、专业 Session、Mandate、可见性域和权限边界。
5. 重复工具调用、重启、Compact 和结果未知不会制造重复 Assignment 或重复执行。
6. 续接任务进入现有持久队列，不阻塞主意识，不产生任何渠道发送。
7. 不需要续接时仍保持现有“一次 Assignment、Report 后结束”的行为。

## 5. 非目标

本阶段明确不做：

- 不根据向量、关键词、情绪分数或话题相似度自动续接。
- 不实现专业 Session 自行订阅 Observation 或自行续接任务。
- 不实现通用 Subscription、Thread 自动跟踪和跨任务归并。
- 不实现 `progress / waiting`、心跳式推进或无限后台任务。
- 不实现取消、技术重试、返工和人工工单管理的完整协议。
- 不允许续接改变任务类型、专业 Session、模型、读写根或工具权限。
- 不允许一个 Task 同时存在多个活动 Assignment。
- 不做跨可见性域合并、跨专业依赖、Task 合并或拆分。
- 不给主意识或记忆 Session 暴露续接工具。
- 不让潜意识获得 `send_text / send_voice`。

其中，“返工”和“技术重试”与续接共享部分底层机制，但语义不同，不能借续接工具悄悄实现。

## 6. 概念边界

| 动作 | 含义 | 本阶段 |
|---|---|---|
| `dispatch` | 创建一项新的工作 | 已有 |
| `continue` | 已有工作出现新材料或明确的后续阶段，追加 Assignment | 本文实现范围 |
| `retry` | 同一 Assignment 因技术故障结果未知，由宿主恢复投递 | 沿用现有恢复，不由模型决定 |
| `rework` | Router 认为已交付结果不满足要求，需要专业 Session 修正 | 暂缓 |
| `subscribe` | 声明以后某类材料可能与 Task 有关 | 暂缓 |
| `progress` | 长任务尚未结束，只报告阶段进度 | 暂缓 |

特别需要防止把“收到 Report，想让对方再确认一下”当成无条件续接理由。仅仅知悉报告不需要产生新工作。

## 7. 最小触发范围

`subconscious_continue` 只允许在当前真实输入的处理过程中调用，`trigger_ref` 必须是以下二者之一：

### 7.1 当前 Report

```text
report/report_<id>
```

适用于：专业 Session 的结果已经回来，Router 根据该结果确认存在明确的下一阶段。

此时 `source_refs` 只能继承该 Report 对应 Assignment 的任务版本来源，不能借 Report 引用任意历史 Observation。

### 7.2 当前 Batch

```text
batch/batch_<id>
```

适用于：新的表界材料到来，Router 明确判断它属于一个已知 Task。

此时 `source_refs` 只能来自当前 Batch。旧材料若确需重新呈现，必须由既有任务版本或未来受控续读机制提供，不能伪造为当前 Batch 的来源。

### 7.3 Task 身份从何处获得

Report 输入天然包含 `task_id`，因此 Report 驱动续接没有发现问题。

Batch 驱动续接要求 Router 已经从自身真实历史或当前输入中知道目标 `task_id`。本阶段**不新增任务搜索／列表工具**；Router 不知道准确 ID 时不得猜测，应维持新任务或暂不处理。未来若自然使用证明“找不到旧任务”成为主要问题，再单独设计只读任务索引及其 Schema。

## 8. Router 工具 Schema

新增唯一一个领域工具：`subconscious_continue`。

### 8.1 输入

```ts
interface ContinueInput {
  task_id: string
  trigger_ref: string
  source_refs: string[]
  reason: string
  instruction: string
}
```

字段约束：

| 字段 | 必填 | 约束 |
|---|---|---|
| `task_id` | 是 | 已存在且当前允许续接的 Task；不得伪造 |
| `trigger_ref` | 是 | 必须等于宿主当前正在处理的 Batch 或 Report |
| `source_refs` | 是 | 1～20 个不重复的 `observation/obs_...`，顺序保留 |
| `reason` | 是 | 1～2000 字；说明为什么属于同一 Task，以及为什么现在需要下一阶段 |
| `instruction` | 是 | 1～8000 字；只描述本次新 Assignment 的具体工作 |

建议工具描述：

> 把一个已存在的潜意识 Task 显式续接到当前真实 Batch 或 Report，并追加一次新的专业 Assignment。只在确有后续工作时使用；不要用于确认收到、无限跟进、修改权限或对外表达。沿用原任务类型、专业和 Mandate，旧 Assignment 与 Report 不会被修改。

### 8.2 输出

```ts
interface ContinueResult {
  task_id: string
  assignment_id: string
  task_revision: number
  kind: string
  state: 'assigned'
  idempotent_replay: boolean
}
```

`task_revision` 必须大于上一版本。输出只证明续接已持久化，不证明专业 Session 已接收或完成。

### 8.3 可见性

- 只在 Router 的当前 Batch／Report 执行作用域注册。
- 主意识不可调用。
- 记忆 Session 不可调用。
- 不随通用文件、网络、Schedule 或 Shell 工具共享给其他 Session。

## 9. 不可变 TaskRevision 是前置条件

### 9.1 当前风险

当前 `SubconsciousTask` 直接保存：

```text
revision / reason / instruction / sourceRefs / formation
```

`TaskAssignment` 只保存 `taskRevision` 数字。如果续接时直接更新 Task 的指令和来源，而不保存历史版本，那么旧 Assignment 再次加载任务包时就会读到新内容。

这会破坏最基本的审计承诺：**历史 Assignment 实际执行过什么，不能因为后续续接而改变。**

### 9.2 新增记录

建议新增 `task_revision` 持久记录：

```ts
interface TaskRevision {
  taskId: string
  revision: number
  reason: string
  instruction: string
  sourceRefs: string[]
  formation: Formation
  continuedFromReportId?: string
  createdAt: number
}
```

约束：

- `(taskId, revision)` 唯一。
- Revision 1 在 `subconscious_dispatch` 创建 Task 时形成。
- 每次续接追加 Revision N+1，不更新旧 Revision。
- Task 标题在最小版本中保持稳定；确实需要改名属于后续任务管理，不混入续接。
- `continuedFromReportId` 在 Report 驱动时记录直接因果；Batch 驱动时为空，但 `formation.triggerRef` 仍指向当前 Batch。
- Formation 必须包含真实 Router Session、turn 和工具调用 ID。

### 9.3 当前投影与历史记录

为了兼容现有读取路径，Task 行仍可保存当前 Revision 的投影：

```text
revision / reason / instruction / sourceRefs / formation
```

但这些字段只是“当前阶段”的快捷视图，不再是全部历史。

所有 Assignment 的任务包必须按 `assignment.taskRevision` 加载对应 Revision，不能默认读取 Task 当前投影。

既有 Task 在迁移时补建 Revision 1，内容逐字段来自原 Task；已有 Assignment、Report 和 Effect 不改写。

## 10. Task、Mandate 与 Assignment 的职责

### 10.1 Task

Task 保存持续工作的聚合身份：

- 稳定 `task_id`、`kind`、`title`；
- 当前 `revision` 和 `current_assignment_id`；
- 固定 `visibility_ref` 和 `mandate_id`；
- 当前状态与当前阶段投影；
- 创建时间、更新时间和当前关闭信息。

Task 的原始 `formation` 仍表示它如何首次形成；每个后续阶段的形成轨迹由对应 Revision 保存。

### 10.2 Mandate

续接不创建新 Mandate，沿用原 Task 的 Mandate：

- `kind / specialist / session_id` 不变；
- 读写根、工具、输出类型和预算不变；
- `visibility_ref` 不变；
- `policy_version` 不因续接自动升级。

Mandate 中已有的 `sourceRefs` 保留为首次授权材料记录，不再被解释为这项持续任务全部历史材料的完整清单。每个阶段实际使用的来源由 TaskRevision 和 Assignment 确定。

若工作需要另一种专业、权限或可见性域，必须创建新 Task，而不是续接。

### 10.3 Assignment

每次续接创建全新的：

```text
assignment_id
task_revision = previous_revision + 1
attempt = 1
delivery_id
state = pending
input_refs = 当前 Revision 的 source_refs
```

旧 Assignment 保持 `ended`，旧 Report 保持不可变，旧 Effect 保持其真实完成历史。

## 11. 来源、可见性与权限

续接必须同时满足：

1. 所有 `source_refs` 都存在且正文可用。
2. 来源属于当前 `trigger_ref` 的获准集合。
3. 所有来源与 Task 原有 `visibility_ref` 完全一致。
4. 当前任务包总输入仍不超过现有 `maxInputBytes`。
5. Mandate 的专业、读写根和工具不因工具参数发生变化。
6. Report 驱动时，该 Report 必须属于 Task 的当前 Assignment，不能拿旧 Report 反复续接最新状态。

最小版本不允许跨 `kook:direct:*`、其他 Thread 或 `conscious:*` 可见性域续接。跨域长期记忆抽象仍是独立问题。

## 12. 状态语义

### 12.1 可续接状态

最小版本只允许对 `completed` Task 显式续接。

- `assigned / running / report_pending`：已有活动 Assignment，拒绝续接。
- `blocked / failed`：可能涉及返工或重试，暂不借续接处理。
- `dropped`：表示当时无需工作；若以后确需重新处理，先另行审定恢复语义。
- `cancelled`：当前尚未实现完整取消协议，不允许续接。

### 12.2 续接事务发生时

在一个 SQLite 事务中完成：

1. 校验当前 Trigger、Task、Report／Batch、来源、权限与预算。
2. 追加 TaskRevision N+1。
3. 追加 Assignment N+1 对应的执行记录。
4. 追加新的 `deliver_assignment` Effect，状态为 `pending`。
5. 更新 Task 当前投影：
   - `revision = N+1`；
   - `current_assignment_id = 新 Assignment`；
   - `state = assigned`；
   - `closed_at = NULL`；
   - `close_reason = NULL`；
   - 更新当前 Revision 的 `reason / instruction / sourceRefs / formation`。
6. 写入幂等请求记录。

事务提交后才允许 worker 投递，沿用现有 Outbox 语义。

### 12.3 后续状态

新 Assignment 完全沿用现有生命周期：

```text
pending → delivering → running → report_pending → ended
```

对应 Report 保存后，Task 再次进入该 Report 的终态。Task 可以经历多次：

```text
assigned → running → completed
        → assigned → running → completed
```

每次重新打开都由一个真实 Revision 和 Assignment 解释，不覆盖前一次闭环证据。

## 13. 任务包与 Report 的兼容要求

### 13.1 新任务包

在现有 `[subconscious.task]` 中增加：

```text
task_revision: N
```

如由续接产生，还可包含：

```text
continued_from_report: report_<id>
```

任务包展示的是**当前 Assignment 对应 Revision** 的 `reason / instruction / source_refs`，不是 Task 创建以来所有指令的拼接。

记忆 Session 不需要学习新工具；仍使用同一个 `subconscious_report` 提交当前 Assignment 的终态。

### 13.2 Report 回传

`reportContent()` 必须读取该 Report 所属 Assignment 的 Revision 来源，不能读取 Task 后来更新的当前 `sourceRefs`。

否则旧 Report 在重试回传时可能被贴上后续 Revision 的来源，造成历史污染。

### 13.3 输出验收

现有验收继续按 Assignment 边界执行：

- `memory completed` 的文件必须是当前 Assignment 实际 `write / edit` 产生；
- 不允许拿上一 Assignment 的写入记录冒充本次完成；
- 新 Assignment 使用新的起点事件和 Report 身份；
- 已存在有效 Report 后，仍优先完成回传，不因后续溢出重跑 Assignment。

## 14. 幂等与重复调用

### 14.1 幂等键

沿用稳定请求哈希思路，对完整 ContinueInput 计算哈希，并以：

```text
(trigger_ref, request_hash)
```

作为幂等身份。

可复用现有 `dispatch_request` 作为领域动作幂等记录，但需明确：此时其中的 `task_id` 可以表示“被续接的 Task”，不一定表示新建 Task。

### 14.2 重放顺序

相同输入重放必须直接返回原结果，即使 Task 随后已经进入 `running` 或 `completed`，也不能因为“当前状态不再允许续接”而把历史成功变成错误。

因此实现不能先检查可变 Task 状态、再查幂等记录；必须能识别已提交的原始动作。

### 14.3 不同请求

同一个 Report 或 Batch 已经续接一次后，再用不同参数调用：

- 不得追加第二条续接链；
- 返回明确冲突或预算错误；
- 不修改第一次请求的指令和来源。

同一 Batch 中“创建新 Task”和“续接一个 Task”是否允许同时发生，最小版本建议不开放：一个 Trigger 最多一个续接动作，其他新工作仍遵守现有派工预算。

## 15. 恢复与并发

必须复用现有恢复原则：

- 续接事务提交后进程退出：重启投递同一个新 Assignment。
- `deliver_assignment` 处于 `running` 时退出：恢复为可投递状态。
- 任务包已呈现但结果未知：沿用稳定 Assignment／Delivery 身份查找真实完成轮次。
- Report 已保存但回传失败：只重试 `relay_report`，不重跑记忆工作。
- Router Compact 后重放工具结果：幂等返回，不追加 Revision。
- 同一专业 Session 仍串行执行；同一 Task 只有一个当前 Assignment。
- 宿主领域层仍是 Task、Revision、Assignment、Report 和 Effect 的唯一写者。

续接不能绕过近期已经修复的“Report 优先于后续轮次回执”和“外部重挂载后恢复装配”语义。

## 16. 队列与公平性

续接产生的新 Assignment 进入现有 `deliver_assignment` 队列，不另建高优先级通道。

保持：

```text
待回传 Report → 待执行 Assignment → 新 Batch
```

同类工作按既有创建顺序处理。续接不得插队，也不得因为持续聊天而饿死其他任务。

一个新 Assignment 的 Report 回来后，Router 可以决定结束或再次续接；在 Router 尚未收到 Report 前，不允许提前创建下一 Assignment。

## 17. 预算与防止无限续接

建议最小配置：

| 配置 | 建议默认值 | 含义 |
|---|---:|---|
| `maxAssignmentsPerTask` | 8 | 包含首次 Assignment；达到后不再允许续接 |
| `maxContinuationsPerTrigger` | 1 | 一个 Batch／Report 最多续接一个 Task |
| `maxInputBytes` | 65536 | 沿用当前单次任务包上限 |
| `maxQueuedTasks` | 20 | 沿用当前活动记忆任务上限 |

预算只是防止失控的工程护栏，不代替 Router 判断。

以下情况不应续接：

- 只是确认“Report 收到了”；
- 没有新信息、未满足事项或明确下一阶段；
- 想借新 Assignment 绕过失败、权限或预算；
- 想不断要求记忆 Session 检查同一份内容；
- 想维持一个永远不会结束的通用“关注这个人”任务。

达到预算后应让 Router 知悉无法继续追加，不自动另建 Task 绕过限制。是否开启一项真正新的工作必须由后续真实输入另行解释。

## 18. Router 提示词需要增加的规则

只增加简短、明确的判断规则：

1. 新主题、新目标或不同专业需求：使用 `subconscious_dispatch`。
2. 同一 Task 出现明确新材料或下一阶段：才考虑 `subconscious_continue`。
3. 没有后续工作：自然结束，不需要任何收尾工具。
4. 不得猜测 `task_id`、`trigger_ref` 或来源 ID。
5. 不得为了维持“持续关心”而制造无限任务。
6. 收到 Report 不等于必须续接；记忆质量由具体产物和真实需要判断。
7. 续接只产生潜意识工作，不产生主动消息或对外表达。

记忆 Session 的固定提示词无需加入路由规则，只需理解 `task_revision` 表示当前执行阶段，并始终报告当前 `assignment_id`。

## 19. 数据流示例

### 19.1 Report 驱动

```text
Task T / Revision 1 / Assignment A1
→ 记忆 Session 写日记
→ Report R1 completed
→ R1 回传 Router
→ Router 发现报告中存在明确的后续整理工作
→ subconscious_continue(
    task_id: T,
    trigger_ref: report/R1,
    source_refs: Revision 1 的获准来源,
    reason: 为什么仍属于 T,
    instruction: 下一阶段具体工作
  )
→ Revision 2 + Assignment A2 + deliver Effect
→ 记忆 Session 执行 A2
→ Report R2
→ R2 回传 Router
→ Router 不再续接，Task 保持 completed
```

### 19.2 Batch 驱动

```text
Task T 已完成 Revision 1
→ 新外部消息进入主意识
→ Observation O9 / Batch B4
→ Router 在当前上下文中确知 T，并判断 O9 是同一经历的后续
→ subconscious_continue(
    task_id: T,
    trigger_ref: batch/B4,
    source_refs: [observation/O9],
    ...
  )
→ Revision 2 + Assignment A2
```

不允许宿主仅因 O9 与旧 Task 在同一个 Thread，就自动产生上述调用；决定必须来自真实 Router 轮次。

## 20. 错误语义

沿用现有错误风格，至少区分：

| 错误 | 含义 |
|---|---|
| `TRIGGER_NOT_CURRENT` | 不是当前正在处理的 Batch／Report |
| `TASK_NOT_FOUND` | Task 不存在 |
| `TASK_NOT_CONTINUABLE` | 当前状态、旧 Report 或活动 Assignment 不允许续接 |
| `SOURCE_NOT_ALLOWED` | 来源不属于当前 Trigger |
| `SOURCE_MATERIAL_UNAVAILABLE` | 来源正文不存在或不可用 |
| `VISIBILITY_CONFLICT` | 试图跨 Task 可见性域续接 |
| `SOURCE_MATERIAL_TOO_LARGE` | 新任务包超过输入预算 |
| `CONTINUATION_BUDGET_EXCEEDED` | 超过每 Task 或每 Trigger 的续接预算 |
| `ASSIGNMENT_NOT_OWNED` | 非 Router 或错误作用域试图调用 |

错误不得修改旧 Revision、旧 Assignment 或旧 Report。

## 21. 验证要求

### 21.1 自动化测试

至少覆盖：

1. Report 驱动续接产生 Revision 2 和新 Assignment。
2. Batch 驱动续接只允许当前 Batch 来源。
3. 相同请求重放返回同一 Assignment，不新增 Revision。
4. 同一 Trigger 的不同续接请求被拒绝。
5. 非 completed Task、旧 Report 和越权 Session 被拒绝。
6. 跨可见性域、不存在来源和超长输入被拒绝。
7. 每个 Assignment 加载自己 Revision 的历史指令和来源。
8. 旧 Report 回传仍携带自己 Assignment 的来源。
9. 第二个 Assignment 的文件验收不复用第一个 Assignment 的写入证据。
10. 续接后、投递前重启能够恢复。
11. 投递后、Report 前 Compact／重启不会重复执行。
12. Report 后回传失败只重试回传。
13. 达到 Assignment／Trigger 预算后拒绝。
14. 持续新 Batch 下，续接 Assignment 和 Report 仍按公平顺序完成。
15. 既有 Revision 1 数据迁移后保持原任务包含义不变。

### 21.2 正式服务真实验收

自动化通过后，仍需一次真实链路：

1. 由 Router 自主创建一个实际记忆 Task。
2. 记忆 Session 亲自完成 Revision 1 并提交 Report。
3. Router 根据真实 Report 或后续自然 Batch，自主决定续接。
4. 记忆 Session 在同一长期 Session 中收到新 Assignment，并追加真实日记。
5. 第二份 Report 真正回到 Router。
6. 核对两个 Revision、两个 Assignment、两份 Report 和各自 Effect。
7. 核对旧任务包和旧 Report 未被后续内容改写。
8. 核对主意识没有获得续接工具，潜意识没有渠道发送工具。

不能用脚本直接写 Revision、Assignment 或 Report 代替真实验收。

## 22. 实施拆分建议

### 阶段 A：版本化基础

- 引入 TaskRevision。
- 回填既有 Revision 1。
- 任务包与 Report 按 Assignment 读取 Revision。
- 先证明“只重构存储，不改变现有行为”。

### 阶段 B：续接事务与工具

- 实现 `subconscious_continue` 完整 Schema、校验、幂等和预算。
- 追加 Assignment 与 Effect。
- 更新 Router 提示词。

### 阶段 C：恢复与真实验收

- 覆盖重启、Compact、结果未知和队列公平性。
- 完成一次真实两阶段记忆任务。
- 记录真实身份、归档和产物证据。

不要在阶段 A 尚未证明历史兼容前，就直接向正式 Router 暴露续接工具。

## 23. 留到后续的问题

以下不影响先审定最小续接，但不能提前宣称已经解决：

- Router 在 Compact 后如何可靠发现值得续接的旧 Task；
- 只读任务索引或 Subscription 的最小接口；
- `blocked / failed / dropped` 的恢复、返工和人工重试；
- 长任务 `progress / waiting`；
- Task 的显式验收、取消、合并、拆分与跨专业依赖；
- 跨可见性域的长期经历抽象；
- 日记语义、重复内容治理和记忆质量评价；
- 主动机会与主意识最终决定接口。

最小续接完成后的目标不是“任务永远运行”，而是：

> **该结束时结束；确有后续时，能够在同一个可持续、可审计的任务身份下继续。**
