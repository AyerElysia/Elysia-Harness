# ElyHarn 开发与提交

源码目录：`/home/ayerelysia/Elysia/Elysium/Elysia-Harness`。先完整阅读祖先与仓库的 `AGENTS.md`，如有本机 `COLLABORATION.md` 也先阅读，再检查工作树与文件归属。

## 工具与定向测试

Spark 当前使用 Node `v22.20.0` 和 pnpm `11.28.5`；pnpm 版本与 `dsh/package.json` 的 `packageManager` 一致。工具位于 `/home/ayerelysia/.local/share/node-v22/bin`。

插件位于 `plugins/*`，不在 DSH 默认测试范围内。使用专用配置：

```sh
cd /home/ayerelysia/Elysia/Elysium/Elysia-Harness/dsh
export PATH=/home/ayerelysia/.local/share/node-v22/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run --config vitest.elysia.config.ts --maxWorkers=1 --no-file-parallelism
```

只检查某个插件时，在命令末尾追加其路径，例如 `../plugins/conscious-mind/tests`。配置发现 `../plugins/*/tests/**/*.spec.ts`；不能把零测试收集当作通过。定向单元测试只验证对应契约，不代替真实模型、平台投递、重启恢复或完整构建验收。

## 改动边界

`dsh/` 是依赖源码。插件通过自己的 Cordis bundle/patch 层适配，不为插件功能顺手修改上游源码、依赖版本或锁文件；不可避免的上游改动必须单独说明并先阅读 `dsh/AGENTS.md`。本仓库的 `dsh/vitest.elysia.config.ts` 是插件测试入口，不代表应改动 DSH 运行逻辑。

构建生成在 `src/` 旁的 `.js`、`.js.map`、`.d.ts`、`.d.ts.map` 不作为本次源码变更提交。会话、日志、备份、安装缓存、`node_modules`、私有模型配置与凭据同样不提交。不得删除或覆盖共享工作树中的未知文件来清理状态。

服务保持用户手动控制；测试与文档整理不自动启动、停止、重启服务，也不安装或推荐自动拉起循环。

## 提交前检查

按功能明确列出本次文件；混合修改需检查对应 hunk，禁止 `git add .` 或 `git add -A`。检查相关源码、测试、配置和文档是否说明同一最终行为，再运行与风险相称的定向检查。

暂存后核对：

```sh
git diff --cached --name-status
git diff --cached --check
git diff --cached
```

确认没有生成文件、正式数据、凭据或其他人的改动。提交说明记录实际验证与未验收部分；本地提交不等于推送或部署。涉及运行链路的推送仍须满足祖先 `AGENTS.md` 的人工启动验收要求。
