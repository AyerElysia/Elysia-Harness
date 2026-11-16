# 主意识原生 Skills 实施与验收记录

日期：2026-11-15  
状态：已部署到固定主意识与 Web `elysia` preset；定向测试和两条真实模型轮次通过。

## 1. 本次范围

本次只把 DSH 已有 Skills 能力原生接入爱莉主意识：

- 根目录固定为 `/home/ayerelysia/Elysia/Data/workspace/skills`。
- 只组合 `@deepseek-ai/dsh-skill-filesystem` 与 `@deepseek-ai/dsh-tool-skill`。
- 配置为 `includeDefaultRoots: false`、`watch: true`，只发现工作区直属 Skill。
- 只新增原生 `skill({ name })`，没有 `skill_create/edit/delete/list`。
- 不开放 shell、脚本执行或额外文件权限，不实现学习、审核、归档或潜意识系统。
- 不修改 vendored DSH 源码，不改变语音、直播和普通 Session 的工具范围。

## 2. 实现落点

### 新增子插件

`plugins/conscious-mind/src/skill-capabilities.ts` 导出 `elysia-skill-capabilities`，声明 `inject = ['skills']`，接受必填且必须为绝对路径的 `rootDir`。它只允许挂在 Agent scope，先挂载 filesystem provider，再挂载 `SkillTool`；第二步失败会回收已取得的 provider。

`plugins/conscious-mind/package.json` 增加 `./skill-capabilities` 导出及相应 peer/dev dependencies。插件依赖按该包现有方式链接到 vendored DSH：

- `@deepseek-ai/dsh-skill`
- `@deepseek-ai/dsh-skill-filesystem`
- `@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-tool-executor-native`
- `@deepseek-ai/dsh-tool-testkit`

曾尝试 filtered pnpm install，但返回 `No projects matched the filters`，没有用该命令完成依赖安装。实际采用上述符号链接。`dsh/pnpm-lock.yaml` 在任务前已有修改，该命令又刷新了其中的差异；未盲目回滚或覆盖，以免抹掉既有工作。

### 固定主意识

`src/main-session.ts` 的 `composeMainAgent()` 挂载同一个薄子插件。根目录从有效工作区推导：

```ts
resolve(config.workspaceDir ?? resolve(config.baseDir, '../workspace'), 'skills')
```

装配结果保存为 fiber，后续装配失败会清理。原有工具 restrict 规则保持，真实运行确认 scoped `skill` 对模型可见。

### Web preset

实际配置 `homes/web/profiles/web/cordis.patch.yml` 的 `preset-elysia` 增加：

```yaml
- id: elysia-skill-capabilities
  name: '@elysia/conscious-mind/skill-capabilities'
  config:
    rootDir: /home/ayerelysia/Elysia/Data/workspace/skills
```

全局 `dsh-skill-filesystem` 和 `dsh-tool-skill` 在插件管理列表仍为 disabled，这是预期的作用域部署，不是加载失败。

### 固定提示词

`/home/ayerelysia/Elysia/Data/standing-prompts/CONSCIOUS-MIND.md` 增加 `skills/` 工作区说明和“技能”小节，使用 `SKILLS-PLAN.zh.md` 第 5.1 节既定原文。没有新建 `TOOLS.md` 或 `SKILLS.md`，也没有把动态目录复制进固定提示词。

## 3. 原生运行语义

- DSH 目录是 durable user-role `<system-reminder>`，不是稳定 system prompt 的一部分。
- 目录只含名称和描述；模型调用 `skill` 后才看到 `<skill_content>` 与资源基目录。
- 加载时重新读取当前 `SKILL.md`，不是永久使用旧正文缓存。
- Watcher 让新增、删除及 frontmatter 变化进入后续模型步骤；文件变化本身不唤醒空闲 Session。
- Skill 的 `scripts/` 只是资源目录，不会因为被发现或加载而获得执行能力。
- 平台事件不会因为文本写成 `/name` 就伪装成 Web 直接用户的显式调用；本次未另写斜杠解析器。

## 4. 自动化测试

定向命令在 `plugins/conscious-mind` 下运行：

```sh
../../dsh/node_modules/.bin/vitest run tests/skill-capabilities.spec.ts tests/main-session.spec.ts tests/standing-prompt.spec.ts --maxWorkers=1 --no-file-parallelism
```

结果：**3 个测试文件全部通过，28/28 项通过**。

新增 `tests/skill-capabilities.spec.ts` 的 3 项测试覆盖：

- Agent scope 与绝对路径校验。
- 目标 Agent 能使用能力，host 和其他 Agent 不获得该能力。
- 只读 custom root、目录去重、原生正文加载与正文重读。
- 卸载清理，以及 Watcher 对 frontmatter 更新的处理。

`tests/main-session.spec.ts` 同时断言固定主意识完成 Skills 挂载。

### 完整套件状态

完整插件套件结果为 **17 个文件通过、6 个失败；99 项通过、13 项失败**。新增 Skills 测试通过，没有新增 Skills 相关失败，但完整套件不是全绿。现存失败包括：

- `restore-direct-session-model.spec.ts`：缺少 `dsh-api-session-controller/src/model-selection-projection.ts`。
- `local-send-confirmation.spec.ts`：7 项，`ctx.agents.enter` 为 undefined。
- `file-capabilities-integration.spec.ts`、`tool-registration.spec.ts`、`web-capabilities.spec.ts`：`$.mode expected nullable but got native`。
- `context-isolation-integration.spec.ts`：新的空 runtime snapshot 仍含 `Current runtime context`。

这些失败未在本次 Skills 任务中顺带修改。

## 5. 受控重载与运行恢复

原单独 disable→enable 脚本返回：

```json
{
  "application": "restart-required",
  "restartReason": "unmanaged-plugin",
  "enabled": false,
  "changed": true
}
```

脚本随后恢复启用。确认主意识 `running: false`、LiveKit `activeCallRooms: 0` 后，使用项目现有入口：

```sh
bash scripts/dsh-web-restart.sh
```

Web 服务于 3299 端口恢复；`@elysia/conscious-mind` 与 `@elysia/gemini-cascade` 均恢复 enabled/active，主 Agent available、`running: false`，语音没有活动房间。本次没有重启旧 Python Elysium。

## 6. 真实模型验收

验收使用无副作用的 `deployment-probe`，正文含 `ELYSIA_SKILL_PROBE_20261115`，没有脚本、文件写入或外部发送要求。不是只检查插件列表或静态工具 Schema，而是让真实模型完成轮次并检查耐久 Session 轨迹。

| 目标 | Session | requestId | 结果 |
|---|---|---|---|
| 固定主意识 | `elysia-conscious-mind` | `2026-11-14T17-37-16-856Z-066d8f27` | 工具可见、目录存在、正文存在；实际调用 `skill` 2 次；工具总数 16；最终 idle |
| Web preset | `elysia-skill-verification-1794677857546` | `2026-11-14T17-37-40-722Z-e8e72859` | 工具可见、目录存在、正文存在；实际调用 `skill` 1 次；工具总数 12；最终 idle |

两轮都实际读到 `<skill_content>` 中的探针正文。主意识按指示调用 `pass`，没有向 QQ、KOOK、飞书或其他外部渠道发送验收消息。

探针目录 `/home/ayerelysia/Elysia/Data/workspace/skills/deployment-probe` 已在验收后删除，因此本次不附带示例或生产 Skill。临时 preset 验证 Session 保留；固定主意识历史中保留一条部署自检轮次。这些只是验收记录，不是新增外部表达。

## 7. 当前边界

- 当前技能根目录为空；之后新增的合法 Skill 才会出现在目录中。
- 已有文件权限不变，Skill 不是权限提升通道。
- 目录和正文仍占用模型上下文，具体投影与压缩继续交给 DSH。
- 空闲时修改 Skill 不会主动唤醒主意识。
- 没有实施自动学习、记忆提炼、技能评价或审核流程。
