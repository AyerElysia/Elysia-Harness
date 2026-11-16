# 主意识固定提示词合并记录（2026-11-14）

## 目标与结果

将原 `EXISTENCE.md` 改为明确的主意识专属文件 `CONSCIOUS-MIND.md`，并把 `TOOLS.md` 的稳定使用约定合并进去。合并不是原样拼接：存在方式、工作区、工具原则、开口与安静、声音、图片、文件维护和记忆记录被统一整理为一份主意识提示词。

主意识固定提示词现在为：

1. `SOUL.md`
2. `USER.md`
3. `MEMORY.md`
4. `CONSCIOUS-MIND.md`

目录仍是 `/home/ayerelysia/Elysia/Data/standing-prompts`。新文件权限为 `0600`。

直播仍只加载 `SOUL.md`、`LIVE.md`，实时通话仍只加载 `SOUL.md`；本次没有修改它们的现场与工具隔离。Skills 计划中的提示词引用已同步到 `CONSCIOUS-MIND.md`，但本次没有实施 Skills 接入。

## 修改位置

- `plugins/conscious-mind/cordis.patch.yml`
- `plugins/conscious-mind/src/tui.ts`
- `plugins/conscious-mind/tests/standing-prompt.spec.ts`
- `plugins/conscious-mind/README.md`
- `plugins/conscious-mind/README.zh.md`
- `plugins/conscious-mind/SKILLS-PLAN.zh.md`
- `homes/web/profiles/web/cordis.patch.yml`
- `homes/tui/profiles/dsh-tui/cordis.patch.yml`
- `homes/tui/profiles/tui/cordis.patch.yml`

Web preset 的固定提示词与文件能力名单、固定主意识、插件 profile、两个终端 profile 和独立终端入口均使用同一份四文件名单。没有修改 vendored `dsh/`。

## 旧文件保留

原文件没有删除，已逐字保留在：

`/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/standing-prompt-backups/manual-conscious-prompt-merge-20261114/`

其中包含 `EXISTENCE.md` 与 `TOOLS.md`，权限均保持 `0600`。它们已不在主意识提示词目录和任何当前加载名单中。

## 验证

### 自动测试

使用 Node 22 执行：

```sh
cd /home/ayerelysia/Elysia/Elysium/Elysia-Harness/plugins/conscious-mind
../../dsh/node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
```

本次修改直接覆盖的 `tests/standing-prompt.spec.ts` 为 9/9 通过，其中真实验证了四份文件按名单顺序组成同一份 complete prompt，并继续排除 Harness 身份段。

完整套件结果为 15 个测试文件通过、7 个失败；109 项测试中 93 项通过、16 项失败。失败不在本次修改的提示词组装测试中，报错涉及 DSH 包路径与配置/服务接口漂移、既有计划工具名称（`schedule_view`/`schedule_edit` 与旧断言）以及测试环境。本次没有为这些无关失败修改 DSH 或其他功能源码，因此不能把完整插件套件记为全绿。

### 真实文件离线组装

用真实目录和上述四文件名单执行 `systemPrompt.assemble()` 与 `renderPrompt()`，结果与逐份读取、trim 后按空行拼接的期望文本逐字一致；仅产生 `elysia:standing-prompts` 段，新合并正文存在。验证没有打印私有提示词正文，也没有发起模型请求。

### 受控运行重载

重载前确认主意识 Agent 空闲，实时语音插件 active，并通过 LiveKit 只读查询确认活动通话房间为 0。随后仅对 `@elysia/conscious-mind` 调用原生 `pluginManager/setBundleEnabled` 做一次 disable → enable；两次均为 `applied`。

重载后：

- 主意识插件 `enabled: true`、`fiberPhase: active`；
- `elysia-conscious-mind` Agent 可用且空闲；
- 实时语音插件仍为 `enabled: true`、`fiberPhase: active`；
- Web 进程 PID 与启动标识不变，没有重启整个 Web 或执行全 profile reconcile；
- 重载后活动通话房间仍为 0。

本次未额外发送真实渠道消息或制造一轮真实模型对话，因此不声称已完成模型行为与渠道回复验收。
