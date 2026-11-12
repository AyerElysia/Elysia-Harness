# 自主记忆插件占位与需求草案

日期：2026-11-12。

用户要求先建立占位记忆插件，并准备需求讨论。设计起点是由爱莉自己管理记忆文件、索引和修订，工程侧提供可靠、可追溯的能力。

## 当前源码依据

- `plugins/subconscious/src/index.ts` 仍为无行为占位。
- `plugins/subconscious/sessions/memory/REQUIREMENTS.zh.md` 是未来日记与简单笔记消费者需求，不是已运行实例。
- `plugins/conscious-mind/src/file-capabilities.ts` 提供原生文件工具边界与提示词运维备份；默认保留 20 份备份，不足以单独证明长期修订史完整。
- `plugins/conscious-mind/src/standing-prompts.ts` 每次装配重读显式选定文件；这不等于自动记忆整理。

## 本次变更

新增 `@elysia/memory` 包，预留记忆工程边界，不再创建第二套潜意识宿主或私有会话历史。需求草案位于 [plugins/memory/REQUIREMENTS.zh.md](../../plugins/memory/REQUIREMENTS.zh.md)，区分已确认方向、实现建议、未决事项与按现象验收的建议场景。

占位不获取宿主能力。当前 Web / TUI profile、提示词正文、正式记忆、存储、服务进程与其他未提交修改均不在本轮改动范围；独立 bundle 可供以后显式挂载。暂不迁移旧 Elysium 记忆。

## 验证范围

插件自带测试检查占位不访问宿主能力，以及在新的 Cordis host 中可挂载、卸载和再次挂载。测试不使用正式来源，不调用模型，不证明尚未实现的记忆功能。

2026-11-12 在 Spark 使用现有 DSH 部署的 Node 22 完成：

- `pnpm --filter @elysia/memory test`：2 项通过，包含真实 Cordis 挂载与卸载。
- `tsc -p plugins/memory/tsconfig.json --noEmit`：通过；增量记录位于临时目录。
- `git diff --check`：通过；新包与文档另核对文件清单和空白。

非交互终端默认 Node 18 无法运行当前 pnpm，验证时仅为该命令选择了现有 Node 22，没有修改全局 Node 或运行服务。pnpm 在首次测试前自动完成依赖同步，已在原本就存在未提交修改的 `dsh/pnpm-lock.yaml` 中加入本包 importer；该共享 lockfile 未暂存，不能把其全部差异归为本任务。生产 profile 与服务进程未变，未提交或推送。
