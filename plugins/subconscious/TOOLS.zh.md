# 潜意识工具设计需求

状态：**Router 的 17 个通用工具、`subconscious_dispatch`，以及记忆 Session 的六个文件／图像工具、`subconscious_report` 均已实现；5 个测试文件共 36 项通过（Windows 口径另有 1 项 Linux 专用用例显式跳过），真实记忆派工与报告回传已验收。**旧的 `subconscious_read` 与 `subconscious_route` 已移除。本文规定中枢及各专业潜意识 Session 的通用能力和当前领域工具；不同 Session 不自动继承彼此权限。

## 1. 目标与定位

潜意识中枢不是只能分类和派单的受限 Session。它应当具备完整的通用能力，可以亲自阅读、调查、写作、查看图片、加载 Skill、运行命令和验证结果；持续性记忆、学习、技能验证、计划等专业工作，按职责通过已注册的专业 Session 分配。目前仅实现 `memory` 派工，其他专业类型仍需分别审定。

必须区分：

- **能力是否具备**：由 Agent 作用域中实际挂载的工具决定。
- **权限是否允许**：由宿主的工作区、文件、进程、网络、可见性和预算策略决定。
- **职责上是否应当亲自做**：由固定提示词与任务分工引导，不靠没收全部通用工具实现。

不能因为中枢拥有通用工具，就要求所有工作都在中枢完成；也不能因为存在专业派工，就禁止中枢完成简单的直接工作。

## 2. 范围

### 2.1 本文包含

| 分组 | DSH 原生工具 |
|---|---|
| 文件与图像 | `read`、`read_image`、`write`、`edit`、`glob`、`grep` |
| 网络 | `web_search`、`web_fetch` |
| Skills | `skill` |
| Shell 与后台任务 | `bash`、`job_output`、`job_list`、`job_kill` |
| Schedule | `schedule_create`、`schedule_list`、`schedule_view`、`schedule_edit` |

合计 17 个通用工具。全部优先复用 DSH 原生 Schema、执行与结果渲染，不在 `@elysia/subconscious` 另造同名替代工具，不修改 vendored `dsh/`。

当前另有两个不同作用域的领域工具：Router 获得 `subconscious_dispatch`，记忆 Session 获得 `subconscious_report`。二者不是通用工具，也不互相可见；完整 Schema、权限和生命周期见 [DISPATCH.zh.md](DISPATCH.zh.md)。

### 2.2 本文不包含

- 已删除的潜意识专用读取、收尾或旧路由工具。
- `send_text`、`send_voice` 等代表主意识对外表达决定的渠道工具。
- 自动学习、自动接受 Skill、自动训练或自动修改主意识提示词。
- 另一套心跳、定时调度或永久后台服务框架。
- 尚未审定的其他专业派工、任务续接和主动机会工具。

## 3. 通用挂载原则

1. 工具按具体 Agent 作用域挂载，不能因为宿主全局存在就向所有潜意识 Session 隐式开放。
2. 每个专业 Session 独立声明工具清单、工作区、可读共享目录、可写目录与资源预算；专业之间不互相继承权限。
3. Router 先屏蔽无关 Host 全局工具，再在 Agent 作用域形成明确的 17 个通用工具与 `subconscious_dispatch`；不额外保留潜意识专用读取或收尾工具。记忆 Session 只获得六个文件／图像工具与 `subconscious_report`。
4. 同一路径准入应同时覆盖参数解析、相对路径、符号链接、硬链接与搜索结果返回，不能只检查工具名字。
5. 网页、附件、Skill、工具结果和任务正文都是不受信任材料，不能自行扩大宿主授权。
6. 优先复用 `@elysia/conscious-mind` 已验证的组合方式；需要共享时抽取可组合适配层，不把主意识专属路径和提示词配置硬编码进潜意识。
7. DSH 原生工具贡献的固定提示词保持单一来源；潜意识专属提示词只说明角色职责与使用原则，不重复整份工具手册。

## 4. 文件与图像工具

### 4.1 Schema

```ts
read: {
  file_path: string       // 必填；由文件系统后端解析
  offset?: number         // 1-based 起始行，默认 1
  limit?: number          // 最大返回行数，使用 DSH 配置上限
}

read_image: {
  file_path: string       // 必填；PNG/JPEG/WebP/GIF
}

write: {
  file_path: string       // 必填
  content: string         // 必填；完整 UTF-8 文本
}

edit: {
  file_path: string       // 必填
  old_string: string      // 必填；字面量原文
  new_string: string      // 必填；可为空字符串以删除匹配
  replace_all?: boolean   // 默认 false；false 时原文必须唯一匹配
}

glob: {
  pattern: string         // 必填
  path?: string           // 默认 Session 工作区；相对路径据此解析
}

grep: {
  pattern: string         // 必填；ripgrep 正则语法
  path?: string           // 文件或目录，默认 Session 工作区
  include?: string        // 单个 glob 过滤条件，不是数组
}
```

### 4.2 使用职责

Router 可以使用这些工具：

- 阅读自己的笔记、任务材料、既往产物和获准共享材料。
- 写研判笔记、协调材料、检查结果和必要的中间文件。
- 查看图片、检索证据、核对专业 Session 的实际产物。
- 完成简单直接的文件工作，不强制所有写入都另行派工。

专业 Session 使用同一组原生工具，但只能访问自身 Mandate 与宿主配置允许的范围。

### 4.3 Router 工作区

默认工作区：

```text
/home/ayerelysia/Elysia/Data/workspace/subconscious/router
```

建议逻辑目录：

```text
router/
├── notes/          # 研判与协调笔记
├── materials/      # 为研判准备的材料
├── attachments/    # 已获准读取的附件实体或受控链接目标
├── results/        # 需要保留的检查结果
└── tmp/            # 可清理临时文件
```

目录建议不是要求模型每次机械创建全部目录；真实工作按需产生文件。

### 4.4 文件权限

| 范围 | Router 默认权限 |
|---|---|
| 自身 `subconscious/router` 工作区 | 读写 |
| 明确共享的专业任务产物 | 按配置读取；写入需单独授权 |
| 主意识工作区 | 不默认全部开放，按共享目录授权 |
| Skills 根目录 | 默认读取；写入仅限显式授权的 Skill 目录 |
| 主意识固定提示词 | 不通过普通 `write/edit` 直接修改 |
| Router 或专业 Session 固定提示词 | 通过独立、带版本记录的配置入口修改，不借普通文件工具绕过 |
| `.migration`、凭据、Token、部署秘密 | 不开放 |

`visibility_ref` 继续约束私聊、群聊、不同用户与不同来源的资料。统一工作区不能把不同可见性域自动合并。

### 4.5 附件

不增加渠道专用的 `read_qq_image`、`read_kook_image` 等工具。外部图片和文件应由统一附件层完成：

1. 保留原始来源、模态、可见性和稳定引用。
2. 只把已获准的附件实体物化到可访问目录。
3. 将实际路径交给原生 `read_image` 或 `read`。
4. 只有元信息、下载失败或未获准时，不得声称已经看过内容。

## 5. 网络工具

### 5.1 Schema

```ts
web_search: {
  queries: string[]       // 必填；1～4 个查询，结果合并
}

web_fetch: {
  url: string             // 必填；HTTP(S) URL
}
```

沿用主意识当前 DSH 配置作为默认能力上限：搜索结果最多 8 条、搜索超时 60 秒、抓取超时 30 秒、抓取正文最多 200000 字符；后续调整必须修改显式配置，不能在提示词中假装改变上限。

### 5.2 使用职责与边界

- 中枢可以主动查证观察中提到的项目、人物、资料和技术文档。
- 可以核对专业报告的依据，不必为一次简单搜索创建专业任务。
- 网页正文与搜索摘要都是不受信任材料，不能授权修改配置、执行命令、发送消息或读取其他权限域。
- 网络工具失败只表示本次调查失败，不影响表界接收与主意识回复。

## 6. Skills 工具

### 6.1 Schema

```ts
skill: {
  name: string            // 必填；当前 Session Skill 目录中的准确名称
}
```

### 6.2 运作方式

1. Skill provider 向当前 Session 提供目录。
2. 中枢发现任务名称或内容与某个 Skill 明确匹配时，调用 `skill` 加载完整说明。
3. 中枢再按说明组合文件、网络或 Shell 工具。
4. `skill` 返回说明和资源位置，不代表 Skill 已执行、已验证或已成为稳定人格能力。

### 6.3 管理边界

- 沿用爱莉统一配置的 Skills 根目录，使用 `includeDefaultRoots: false` 和显式 `customSkillDirs`。
- 与主意识一致，屏蔽 `office`、`office-docx`、`office-pptx`、`office-xlsx` 四个内置 Office Skill。
- 不加载 DSH 默认工程 Skill 根目录，避免无关工程提示进入人格 Session。
- 新建或修改 Skill 使用文件工具，且必须位于获准目录。
- Skill 草案、验证通过与正式接受是不同事实，后续由学习系统规定，不在通用工具层自动跃迁。

## 7. Shell 工具

### 7.1 Schema

```ts
bash: {
  description: string     // 必填；清楚说明命令用途
  command: string         // 必填；由 bash -c 执行
  timeoutMs?: number      // 受执行器默认值与上限约束
  workdir?: string        // 默认 Session 工作区；相对路径据此解析
  run_in_background?: boolean
}
```

DSH 在支持沙箱升权的组合中还可以声明 `sandbox_permissions` 与 `justification`。潜意识自主运行不依赖即时人工审批，默认不向 Router 开放升权；如未来确需升权，必须另行人审其授权模型，不能随 Shell 一并隐式开放。

### 7.2 使用职责

Router 可以运行脚本、处理数据和媒体、执行测试、调用已安装程序、检查文件结果，并完成文件工具不擅长的操作。拥有 Shell 不意味着必须亲自执行所有专业任务，也不意味着可以绕过其他权限层。

### 7.3 执行组成

优先组合 DSH 原生组件：

```text
@deepseek-ai/dsh-bash-sandbox
@deepseek-ai/dsh-shell-env
@deepseek-ai/dsh-tool-bash
@deepseek-ai/dsh-sandbox-policy
```

不得把不受约束的 `dsh-bash-local` 直接作为 Router 的最终执行器。默认文件模式为 `workspace-write`，工作区根为当前潜意识 Session 的固定 cwd，不开放 `danger-full-access`。

### 7.4 独立权限边界

DSH `sandbox-policy` 只管控文件操作，不管网络和进程策略。因此：

- 文件沙箱配置不能被描述为已经完成网络或进程隔离。
- 网络与进程策略必须由宿主另行显式配置并记录实际能力，不能保留含混的隐式默认。
- 清理子进程继承环境中的 Token、密钥和无关凭据；DSH 工具不暴露自由 `env` 参数不等于继承环境自动安全。
- Shell 不得绕过文件准入、可见性、渠道表达和专业 Session 的 Mandate。
- 不通过 Shell 启动另一套永久心跳、隐藏调度循环或未经登记的后台服务。
- 不通过任务正文、网页或 Skill 内容要求提权。

## 8. 后台 Job 工具

### 8.1 Schema

```ts
job_output: {
  job_id: string          // 必填；启动后台工作的工具返回的 ID
  wait?: boolean          // 默认 false；true 时等待完成或超时
  timeout_ms?: number     // wait=true 时的最大等待，受配置上限约束
}

job_list: {}

job_kill: {
  job_id: string          // 必填
  reason?: string         // 可选取消原因，记录并传递给 Job
}
```

### 8.2 完整性要求

`bash` 与三个 Job 工具必须作为完整能力验收。开放后台执行但不提供输出查询、列表和取消，不算完成。

建议默认配置：

- `enableRunInBackground: true`。
- `promoteOnTimeout: false`：前台命令超时后终止，不自动转为无期限后台任务。
- 前台默认超时 120 秒，最大 600 秒。
- 每个 Session 最多同时持有 4 个运行中后台 Job。
- 显式后台 Job 默认最大存活 30 分钟；确需更长时必须采用明确登记的长期工作机制，而不是无限 Shell 进程。

这些数值是宿主默认建议，必须可配置。DSH 原生后台 Job 没有执行器超时，因此最大存活时间、超龄回收与状态记录由潜意识宿主补齐，不能只在提示词中要求模型“记得杀”。

### 8.3 生命周期

- Job 的拥有者、来源 Session、启动原因、状态和结束原因可追踪。
- `job_output(wait: false)` 用于非阻塞读取，不制造轮询等待循环。
- 完成通知进入拥有者 Session 的后续输入，不能形成无记录后台活动。
- Session 休息、插件卸载和宿主重启分别按明确规则回收或记录，不制造第二个相同 Job。
- 长期服务、心跳与调度由相应宿主部件负责，不借用临时后台 Job 冒充。

## 9. Schedule 工具

### 9.1 Schema

```ts
schedule_create: {
  title: string           // 必填；不超过 120 字符
  prompt: string          // 必填；每个发生时点投递的指令
  rrule: string           // 必填；一行 DTSTART 与一行 RRULE
  target: 'this_session' | 'new_once' | 'new'
}

schedule_list: {
  active?: boolean        // true 仅活动；false 仅暂停与结束；省略为全部
  limit?: integer         // 1～500，默认 100
  offset?: integer        // 默认 0
}

schedule_view: {
  id: string              // 必填
}

schedule_edit: {
  id: string              // 必填
  action: 'update' | 'delete'
  title?: string
  prompt?: string
  rrule?: string
  target?: 'this_session' | 'new_once' | 'new'
  active?: boolean
  expectedUpdatedAt?: string
}
```

`update` 至少提供一项修改；`delete` 不接受补丁字段。`expectedUpdatedAt` 用于避免基于旧版本覆盖新修改。

### 9.2 中枢归属与目标限制

DSH 原生 Schedule 工具是宿主级管理接口：原生 `schedule_list` 能看到其他 Session 的任务，`schedule_view` 与 `schedule_edit` 也能按 ID 读取或改变任意任务。潜意识必须在其外层增加归属保护，而不是直接裸挂载：

- Router 创建任务只接受 `target: 'this_session'`，不向 `new_once/new` 随意创建无人格约束的新 Session。
- 任务的实际投递目标必须解析为 `elysia-subconscious-router`。
- `schedule_list` 只返回目标属于 Router 的任务，分页计数基于过滤后的结果，不能泄露其他任务的标题、正文、时间或 ID。
- `schedule_view`、`schedule_edit` 只能读取、暂停、恢复、更新或删除属于 Router 的任务；其他 ID 返回不允许访问，不因错误差异探测任务内容。
- `schedule_edit` 不允许把任务目标改为其他 Session 或新建 Session。
- 归属检查必须在修改前执行，不能仅靠事后过滤结果；读取与修改都需要覆盖测试。
- Schedule 任务使用 DSH 宿主持久化与投递，不另造调度存储，不把临时 Shell Job 当定时任务。

如果未来专业 Session 需要日程，应分别定义其目标与归属范围，不能通过 Router 的权限间接管理其他 Session。

### 9.3 使用职责

Schedule 用于明确的未来唤醒、复查和持续安排，不用于每秒轮询，不绕过 Router 休息与资源预算。原生提示词要求创建或修改日程具有用户明确授权；中枢自行提出的内部复查是否属于可持久授权，由专属提示词与宿主策略另行明确，不能悄悄扩大。

## 10. 主体与外部副作用边界

通用工具不等于主意识表达授权：

- 不向 Router 或专业潜意识默认挂载 `send_text`、`send_voice`。
- 希望主意识表达时，未来通过机会候选交主动系统，由主意识亲自决定。
- 不将草稿伪造成主意识 assistant 历史。
- Shell、网络、文件和 Schedule 能力不能被用来绕过这一边界，间接操纵渠道或冒充主意识。
- 其他外部副作用是否允许，由具体宿主权限与未来 Task Mandate 决定，并留下真实工具与结果记录。

## 11. 实施要求

### 11.1 文件、网络与 Skills 工作包

- 复用 DSH 原生工具与主意识现有组合经验。
- 抽取适合潜意识的 Agent 作用域配置和路径准入，不修改 `dsh/`。
- 只挂载明确批准的通用工具，不再保留旧的潜意识读取与收尾工具。
- 明确 Router 工作区、Skills 根目录、共享目录和提示词保护边界。

### 11.2 Shell 与 Jobs 工作包

- 组合沙箱执行器、统一策略、Shell 环境、Jobs runtime 与控制工具。
- 完成环境清理、网络／进程策略说明、Job 数量与寿命约束。
- 默认关闭自主升权和前台超时自动转后台。
- 将 Job 状态纳入宿主可观测性与卸载生命周期。

### 11.3 Schedule 工作包

- 挂载 DSH 原生四工具与宿主 Schedule 服务。
- 在插件层实现 Router 归属过滤、修改前检查和 `this_session` 目标限制。
- 验证暂停、恢复、版本冲突、删除和真实投递，不影响其他 Session 的任务。

三个工作包都属于本需求的完整范围，不能把“文件工具已接入”宣称为全部通用工具完成。

## 12. 验收标准

### 12.1 工具可见性

1. 本插件向 Router 提供本文批准的 17 个通用工具和 `subconscious_dispatch`，没有旧领域工具或 DSH 无关全局工具混入。正式 Web 的既有会话通讯插件还会叠加 `session_list / session_read / session_send`，验收时应单独识别其来源，不误算为本插件工具，也不得因此引入渠道发送能力。
2. 各专业 Session 只看到自己获授权的子集：当前记忆 Session 为六个文件／图像工具与 `subconscious_report`，没有 Router 的派工、Shell、网络或 Schedule 权限。
3. 四个内置 Office Skill 不出现在 Skill 目录中。

### 12.2 文件与图像

4. 能在 Router 工作区完成 `write → read → edit → glob/grep` 的真实闭环，结果与磁盘一致。
5. 能读取获准图片；无权限路径、符号链接逃逸、硬链接与搜索结果越界均被拒绝。
6. 主意识提示词、`.migration`、凭据和未授权共享目录不能被普通文件工具修改或读取。

### 12.3 网络与 Skills

7. `web_search` 和 `web_fetch` 能完成真实查询与抓取，失败时返回真实错误且不影响表界接收。
8. `skill` 能加载一个显式安装的测试 Skill；未安装名称返回真实失败，不伪造内容。

### 12.4 Shell 与 Jobs

9. `bash` 在指定工作区运行并返回真实退出码；工作区写入按策略生效，越界写入被拒绝。
10. 自主运行不出现人工升权依赖，子进程环境不包含已配置清除的测试凭据。
11. `run_in_background` 返回真实 Job ID，`job_output`、`job_list`、`job_kill` 能完成读取、列举和取消闭环。
12. 前台超时不会被静默转为永久后台任务；后台超龄、插件卸载和重复恢复均有可验证处理。

### 12.5 Schedule

13. 能创建投向 Router 的一次性及重复日程，并通过列表、查看、暂停、恢复和删除完成真实闭环。
14. Router 不能列出、查看、修改或删除其他 Session 的任务，也不能创建或改成 `new_once/new` 目标。
15. 日程到期后真实投递到 Router 长期 Session，不创建替代 Session，不伪造接收回执。

### 12.6 主体与回归

16. Router 和记忆 Session 均没有渠道发送工具，通用工具与派工测试不向 QQ、KOOK 等真实渠道发送消息。
17. 原有 Observation、Batch、原生轮次收尾、恢复与去重测试全部保持通过，不再要求 `ignore/defer`。
18. 类型检查、插件隔离测试与真实 AgentLoop 验证通过；最终以 5 个测试文件、36 项通过为准，不以静态配置文件或工具列表截图代替实际调用验收。
19. 四份实施文档与当前真实工具状态一致，未通过的项目明确保留为未完成，不提前宣称全部交付。
20. Router 真实调用 `subconscious_dispatch` 后，宿主持久化 Task、Mandate、Assignment 与投递 Effect；任务包直接包含完整 Observation，不依赖旧读取工具。
21. 记忆 Session 真实调用 `write` 或 `edit` 后提交 `subconscious_report`；完成状态具有真实文件证据，合理 `dropped` 不强制写日记。
22. Report 与 `relay_report` Effect 持久化后，报告实际进入 Router 模型输入；持续 Batch 和连续 Assignment 均不得让报告回传饥饿。真实验收 ID 与证据见 [DISPATCH.zh.md](DISPATCH.zh.md) 第 20 节。

## 13. 后续仍需分别审定

- 其他专业 Session 的具体工具子集、共享目录和预算。
- Shell 网络与进程策略的具体部署值。
- 固定提示词配置入口及其版本、备份和生效机制。
- Skill 草案、验证和正式接受的学习流程。
- 中枢自主创建内部复查日程的持久授权规则。
- 新专业派工、自动任务续接、长任务进度、取消重试和主动机会工具。
