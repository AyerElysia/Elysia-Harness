# 主意识原生 Skills 接入计划

状态：已按本文方案实施，并于 2026-11-15 完成定向测试和真实模型验收。固定主意识与 Web `elysia` preset 均已接入原生 `skill`，唯一根目录为 `/home/ayerelysia/Elysia/Data/workspace/skills`；第 5.1 节固定提示词已写入 `CONSCIOUS-MIND.md`。部署探针已删除，当前不附带示例或生产 Skill。

定向测试 3 个文件、28 项全部通过；固定主意识和 preset 的真实模型轮次均实际发现目录、调用 `skill` 并读到探针正文。完整插件套件仍有与新增 Skills 无关的既存失败，不能表述为全绿。详细修改、运行重载、真实 requestId、失败清单和遗留项见[实施与验收报告](../../docs/report/2026-11-15-conscious-mind-skills.zh.md)。

以下保留原设计与核对依据，作为已实现契约的说明；不再扩张为学习系统。

## 1. 本阶段只做什么

只做一件事：把 DSH 已有的 Skills 系统原生接入爱莉的主意识 Session。

接入后，主意识能够：

1. 在会话中收到当前可用 Skill 的名称和描述。
2. 使用原生 `skill` 工具按精确名称加载完整 `SKILL.md` 正文。
3. 在工作区约定目录中新增、删除或修改 Skill，并在后续模型步骤看到目录变化。
4. 通过已有文件工具按需读取 Skill 的 `references/`、`scripts/`、`assets/` 等资源；是否执行脚本仍取决于实际工具，本次不开放执行能力。

本阶段不设计学习系统，不讨论自动总结、草稿审核、技能归档、潜意识学习或技能评价。

## 2. 复用哪些 DSH 模块

| 模块 | 当前 Web 状态 | 作用 | 接入方式 |
|---|---|---|---|
| `@deepseek-ai/dsh-skill` | enabled、active | 统一注册表：合并目录、按名称选择并加载定义 | 复用现有服务，不重复挂载 |
| `@deepseek-ai/dsh-skill-filesystem` | disabled | 扫描本地目录、解析 frontmatter、监听变化 | 只在爱莉作用域挂载 |
| `@deepseek-ai/dsh-tool-skill` | disabled | 提供 `skill` 工具、动态目录和 `/name` 显式调用 | 只在爱莉作用域挂载 |
| `@deepseek-ai/dsh-client-ui-skill` | enabled、active | 既有 UI | 保持原样 |

不新增独立 ElyHarn 插件包，不修改 vendored `dsh/`，不重写目录、Watcher、加载工具或 UI。

### 固定主意识与 preset 必须同时接入

只把模块写进 `preset-elysia` 不够。固定主意识 `elysia-conscious-mind` 由 `composeMainAgent()` 自己执行 create/resume 装配，并不会因为 Web 存在 `elysia` preset 就自动继承这两个模块。

因此在 `conscious-mind` 包内增加一个很薄的作用域装配子插件：

```text
@elysia/conscious-mind/skill-capabilities
```

它只做两件事：按给定根目录挂载 DSH filesystem provider，再挂载 DSH `skill` 工具。以下两处复用同一个子插件和同一份目录配置：

- `composeMainAgent()`：覆盖固定主意识长期 Session。
- Web `preset-elysia`：覆盖从该 preset 新建的 Session。

这个子插件只是组合既有 DSH 模块，不实现另一套 Skills 系统。其他 Agent、语音 Session、直播和潜意识不因它获得工具。

## 3. 唯一 Skill 根目录与文件格式

根目录定为：

```text
/home/ayerelysia/Elysia/Data/workspace/skills
```

本阶段统一使用目录包：

```text
skills/
└── <skill-name>/
    ├── SKILL.md
    ├── references/    # 可选
    ├── scripts/       # 可选，不自动获得执行权限
    └── assets/        # 可选
```

最小文件示例：

```markdown
---
name: example-skill
description: 一句话说明这个技能适用于什么任务。
---

这里写加载后才需要遵循的完整步骤。
```

规则：

- `name` 必须使用 kebab-case，`description` 必须是非空字符串。
- 本阶段约定目录名与 frontmatter 的 `name` 相同，便于维护；DSH 原生解析器并不强制二者一致，所以这是一层我们的管理约定，不要误写成原生校验。
- DSH 只发现根目录直属的 `<name>/SKILL.md` 或 `<name>.md`，不递归发现更深的 `**/SKILL.md`；本阶段不使用平铺文件。
- 不在 `skills/` 根目录放 README、索引或普通笔记，避免被当成平铺 Skill 解析。
- `includeDefaultRoots: false`：不加载项目、用户、DSH 开发或 bundled 默认来源，只看上述工作区目录。
- `scripts/` 只是资源目录，不因接入 Skills 而新增 shell 或代码执行能力。

可选 frontmatter：

| 字段 | 原生效果 |
|---|---|
| `whenToUse` | 保存在定义元数据中；当前模型目录和 `<skill_content>` 包装都不显示它，路由仍应写进 `description` |
| `metadata` | 保存在定义元数据中；当前模型目录不显示 |
| `disable-model-invocation: true` | 不出现在模型目录中，模型也不能通过 `skill` 工具加载；仍可由用户 `/name` 显式调用 |
| `user-invocable: false` | 不响应用户 `/name` 显式调用；默认允许 |

缺少有效 frontmatter、缺少 `name`/`description`、名称非法或调用开关非法时，DSH 记录警告并跳过该 Skill；模型目录不会显示这条诊断，不能把“目录里没有”直接等同于“文件不存在”。

## 4. 新增工具：只有 `skill`

本阶段只新增 **1 个模型工具**。没有 `skill_create`、`skill_edit`、`skill_delete`、`skill_list` 等新工具；目录由 DSH 自动提供，维护文件继续使用已有的 `read`、`write`、`edit`、`glob`、`grep`。

### 4.1 注册定义与输入 Schema

以下为 DSH 原生定义，不自拟另一套参数：

```ts
defineTool({
  name: 'skill',
  description: 'Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.',
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'The exact skill name from the available skills list.',
    },
  },
})
```

模型收到的输入 JSON Schema 等价为：

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The exact skill name from the available skills list."
    }
  },
  "required": ["name"]
}
```

调用示例：

```json
{
  "name": "example-skill"
}
```

`name` 不是模糊搜索词，也不是文件路径。名称不是合法 kebab-case 时返回 `Error: invalid skill name "<name>"`；目录中不存在或刚刚被删除时返回 `Error: skill "<name>" is unknown or no longer available`；禁止模型调用时返回 `Error: skill "<name>" is not available for model invocation`。

### 4.2 工具内部返回值的输出 Schema

```ts
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      provider: { type: 'string', required: true },
      resourceBase: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'directory' },
              path: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'url' },
              url: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'opaque' },
              description: { type: 'string', required: true },
            },
          },
        ],
      },
      content: { type: 'string', required: true },
    },
  },
}
```

本次本地文件 provider 实际返回：

- `name`：加载后的 Skill 名称。
- `provider`：默认是 `filesystem`。
- `resourceBase`：`{ kind: 'directory', path: '<skill-name> 目录' }`。
- `content`：去掉 YAML frontmatter 并 trim 后的 Markdown 正文。

工具结果还带有原生 `output.render`，所以模型最终看到的不是一段裸 JSON，而是第 5.4 节的 `<skill_content>` 文本。结果作为普通工具历史保留，不另外复制一份到固定提示词。

## 5. 会增加哪些系统提示词和模型可见文字

这里有三层，必须区分：

1. **我们手写的固定提示词**：加入 `CONSCIOUS-MIND.md`，只写稳定约定。
2. **DSH 自动产生的 Skill 目录**：是 durable 的 user-role `system-reminder` 消息，不是改写成固定 system prompt。
3. **被加载的 Skill 正文**：是工具结果或用户显式调用产生的 `<skill_content>`，不是每轮固定注入的全部技能正文。

### 5.1 写入 `CONSCIOUS-MIND.md` 的固定提示词原文

在工作区目录说明中增加：

```markdown
- `skills/`：当前主意识可发现和加载的技能目录。每个技能是这里的一个直属目录，内含 `SKILL.md` 和可选的资源目录。目录名与 frontmatter 的 `name` 都使用相同的 kebab-case 名称。这里不要放普通笔记或无关 Markdown 文件。
```

在同一文件中新增：

```markdown
## 技能

当前会话如果提供了技能目录，其中的名称和描述只是摘要。小星星点名某个技能，或任务明确符合某个技能的描述时，先用 `skill` 工具按精确名称加载完整内容，再遵循它处理任务；不要仅凭摘要猜测步骤。

如果这一轮已经出现对应的 `<skill_content>`，直接遵循，不为同一份内容重复调用；之后文件明确更新而需要新版时，可以重新加载。

我的技能位于工作区的 `skills/`。使用现有文件工具维护它们，修改前先读取当前文件。技能引用的资源按工具返回的基目录解析，只在需要时读取。

技能只是组织指令与资源的方式，不会赋予我额外工具或权限，也不代表其中的脚本已经执行。
```

这里不写动态技能清单、完整 Schema、“何时应该学习”或“怎样从日记形成技能”。

### 5.2 DSH 首次注入的技能目录原文

当 `skill` 工具可见，并且至少有一个允许模型调用的 Skill 时，DSH 在模型执行任务的步骤前加入以下耐久目录消息。以第 3 节的示例 Skill 为例：

```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `example-skill`: 一句话说明这个技能适用于什么任务。
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

目录行为：

- 条目按名称排序。
- 描述先把连续空白归一为一个空格，再按 `catalogDescriptionMaxLength` 截断；本阶段使用默认值 500。
- 只显示 `name` 和 `description`，不显示正文、绝对路径、provider、`whenToUse` 或其他元数据。
- 如果首次发现完成且没有任何可用 Skill，DSH 不发送空目录，避免无意义地占用上下文。
- 如果发现不完整，即使条目为 0 也会给出目录和警告，避免把“检查失败”误报成“确认没有技能”。

发现不完整时额外出现：

```markdown
Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.
```

### 5.3 目录变化后的替换提示词原文

Skill 新增、删除、描述或调用可见性发生变化时，DSH 不修改旧目录文本，而是在后续模型步骤追加一份完整的替换目录：

```markdown
<system-reminder>
The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:

<available_skills>
- `example-skill`: 一句话说明这个技能适用于什么任务。
</available_skills>

Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

如果曾经有目录、后来所有 Skill 都被删除，也会追加空目录，并明确告诉模型不要继续使用旧名称。`skill` 工具被隐藏或被同名工具遮蔽时，目录也会随之退出，避免“没有工具却仍有工具使用指引”。

### 5.4 加载成功后模型看到的正文格式

```markdown
<skill_content name="example-skill">
<skill_resources>
Base directory for this skill: /home/ayerelysia/Elysia/Data/workspace/skills/example-skill
Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
</skill_resources>

<skill_instructions>
这里写加载后才需要遵循的完整步骤。
</skill_instructions>
</skill_content>
```

这只是指令和资源提示：DSH 不会自动枚举、读取或执行 `references/`、`scripts/`、`assets/`。爱莉需要用本轮已有工具按需读取，且仍受原路径权限约束。

## 6. Skills 系统完整运作流程

### 6.1 装配：确定“谁能看到哪些技能”

1. 全局已有的 `dsh-skill` 提供 `ctx.skills` 注册表。
2. 爱莉作用域中的 filesystem provider 只登记 `workspace/skills` 这一个根目录。
3. 同一作用域中的 tool-skill 注册 `skill` 工具和两个 `agent/pre-step`  listener：一个处理 `/name`，一个维护目录。
4. 固定主意识和 Web preset 各自通过相同子插件完成装配；其他 Session 没有这两个作用域注册，就看不到这份目录和工具。

### 6.2 发现：从文件变成摘要目录

每个符合条件的 `agent/pre-step` 都会取得当前工作目录并请求 Skill 快照：

1. filesystem provider 扫描根目录的直属条目。
2. 对目录包读取 `<name>/SKILL.md`，解析 YAML frontmatter。
3. 校验名称、描述和调用开关；无效条目警告并跳过。
4. 注册表合并当前作用域可见的 provider，按名称去重并排序。
5. tool-skill 过滤出允许模型调用的条目，只保留名称和 capped description。
6. 对条目与“发现是否完整”计算摘要；与当前 Session 最新可见目录相同则不重复注入，不同则追加新目录。

发现阶段会读取 frontmatter，但不会把所有 Skill 正文一次性塞给模型。

### 6.3 加载：模型决定使用某个技能

1. 用户点名某技能，或任务明显匹配目录描述。
2. 模型先调用 `skill({ name: '<精确名称>' })`，再执行实质任务。
3. 工具重新查询当前目录，确认名称仍存在且允许模型调用。
4. provider 再读一次当前 `SKILL.md`，所以加载到的是调用当下的正文，不是旧的正文缓存。
5. 工具返回名称、provider、资源基目录和正文；原生 renderer 包装成 `<skill_content>`。
6. 模型遵循正文，并用已有工具按需读取资源或完成任务。

一个任务明确涉及多个技能时，原生目录指令要求加载所有适用技能，而不是只挑第一个。

### 6.4 用户显式调用：`/name` 不经过模型选择

DSH 还原生支持在直接用户输入中写 `/example-skill`：

- 匹配成功时，当前步骤直接追加同一个 `<skill_content>`，模型不需要再调用 `skill`。
- 同一步重复写同一个 `/name`，只注入一次。
- 未知名称和 `user-invocable: false` 的名称保持普通文字，不注入。
- 这是 `disable-model-invocation: true` Skill 的唯一使用入口：它不会出现在模型目录，也不能由模型主动加载，但用户仍能显式调用。
- 该监听器只扫描 `source.kind === 'user'` 的直接用户消息。因此 Web 主意识输入框可以使用；当前 KOOK 等平台入站使用平台事件来源，不会因为正文里写了 `/name` 就伪造一次用户显式调用。平台消息仍可由模型根据目录正常调用 `skill`。

本阶段不另写斜杠命令解析器。

### 6.5 热更新：什么会刷新，什么不会

| 变化 | 原生结果 |
|---|---|
| 新增、重命名、删除直属 Skill 目录 | Watcher 使目录缓存失效，下一模型步骤追加替换目录 |
| 新增、删除或修改直属 `SKILL.md` | 同上 |
| 使用 DSH `write`/`edit` 修改可能的 Skill 文件 | 除宿主 Watcher 外，还通过 `fs/observed` 立即使目录失效 |
| 只修改 `SKILL.md` 正文、frontmatter 没变 | 目录摘要不变，不追加新目录；下次调用 `skill` 会重读新正文 |
| 修改 `references/`、`scripts/`、`assets/` | 不触发 Skill 目录刷新；之后按需读取时看到当前文件 |
| 会话当前空闲 | 不会仅因文件变化而唤醒模型或开始一轮 |

已加载的旧 `<skill_content>` 是历史事实，不会被后续编辑原地改写。需要新版正文时应再次调用 `skill`；固定提示词中的“不重复加载”只针对本轮已经出现同一正文的情况，不应理解为永远不得重新加载更新后的技能。

Watcher 只负责让后续步骤看到变化，不承担主动唤醒。

### 6.6 持久化、压缩与上下文成本

- Skill 目录是带 `source.kind: 'skill-catalog'` 的耐久用户角色消息，包含结构化条目，消费者不需要反解析 XML 文本。
- 目录更新采用追加替换消息，旧事件仍留在耐久日志中；后续上下文投影和 Compact 继续交给 DSH。
- 加载正文是普通工具结果，会占用后续上下文，直到既有压缩机制处理。
- 目录成本随 Skill 数量和描述长度增长；加载正文没有原生大小上限，因此 Skill 正文应写任务所需内容，避免把整份资料库复制进 `SKILL.md`。
- 本阶段不实现另一套缓存、摘要或压缩。

## 7. 配置落点

作用域子插件接受一个明确根目录，例如：

```yaml
- id: elysia-skill-capabilities
  name: '@elysia/conscious-mind/skill-capabilities'
  config:
    rootDir: /home/ayerelysia/Elysia/Data/workspace/skills
```

子插件内部等价于：

```yaml
- name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - /home/ayerelysia/Elysia/Data/workspace/skills
    watch: true

- name: '@deepseek-ai/dsh-tool-skill'
```

`catalogDescriptionMaxLength` 使用 DSH 默认值 500，本阶段不另调。不启用全局 `include:skill-filesystem` 和 `include:tool-skill`，避免把主意识 Skill 暴露给其他 Agent。

## 8. 实施顺序

1. 创建空目录 `/home/ayerelysia/Elysia/Data/workspace/skills`。
2. 增加薄装配子插件及其导出，让固定主意识和 `preset-elysia` 同时复用。
3. 将第 5.1 节原文加入 `CONSCIOUS-MIND.md`，不改其他固定提示词。
4. 先用无副作用的最小测试 Skill 做隔离装配测试，再接入运行中的主意识。
5. 验证目录、工具 Schema、正文加载、用户显式调用边界和热更新。
6. 验收后保留或移除测试 Skill，再单独确认；不顺便创建学习管理设施。

## 9. 验收项目

- 固定主意识与 Web `elysia` preset 的实际工具列表都有原生 `skill`，其他 Session 不因此新增该工具。
- 工具输入、输出和描述与第 4 节一致，没有另造管理工具。
- 只看到 `workspace/skills` 中的测试 Skill，不出现 DSH 开发、默认根目录或 bundled Skill。
- 首次目录只提供名称和描述，不自动注入全部正文或路径。
- `skill({ name })` 返回完整正文和正确的资源基目录，模型实际看到 `<skill_content>`。
- 新增、删除、frontmatter 修改能在后续模型步骤刷新；正文修改后重新调用可读取新版。
- 资源子目录变化不伪造目录更新，文件变化也不会唤醒空闲 Session。
- 无效 Skill 不被报告为成功加载；发现失败与确认为空在目录中有不同表现。
- Web 直接用户的 `/name` 按原生规则工作；平台事件不会被误认为直接用户显式调用。
- 主意识原有文件权限不变，技能没有隐式脚本执行能力；语音 Session、直播和主动／潜意识占位不变。
- 固定提示词没有复制动态技能清单，也没有引入学习系统规则。

## 10. 明确不做

- 不设计学习、记忆、草稿、审核、归档或自动激活流程。
- 不新增技能管理插件包、数据库或额外管理工具。
- 不执行 Skill 脚本、安装依赖或开放 shell。
- 不修改 DSH 源码、语音通话、直播、普通聊天或其他 Session。

## 11. 本文核对的原生实现

- `dsh/packages/skill/skill/src/index.ts`：注册表、定义校验和 `<skill_content>` 渲染。
- `dsh/packages/skill/skill-filesystem/src/index.ts`：本地发现、frontmatter、资源基目录与 Watcher。
- `dsh/packages/skill/tool-skill/src/index.ts`：`skill` Schema、动态目录、`/name` 和结果渲染。
