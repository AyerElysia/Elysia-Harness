# ElyH 代码实现质量与本地部署验收

> 验收时间 2026-11-19，代码基线 `bd3ecada81`（本地）与 `faad9d4ae3`（服务器工作树）。
> 范围：仓库内全部 15 个 `@elysia/*` 插件、web profile 挂载链路、本地部署可运行性。
> **B 站直播按要求未做任何真实连线/推流/登录**；KOOK、飞书、QQ、Ayla 后端、语音链路同样未做真实平台验收。
>
> 本报告只记录可复现的结论；逐插件的原始日志与四份深度评审（channels / misc / session / subconscious）在本机 `tmp/accept/`（未跟踪），不随仓库提交。

## 结论

**总体：不通过（C+）。** 三句话概括：

1. **已提交的 HEAD 不是验收通过的代码。** 服务器上通过验收的状态依赖工作树里 9 个未提交改动；只 checkout HEAD 时，subconscious 的 3 个测试文件里 2 个红、9 个用例失败（服务器实测）。
2. **两个最新功能各有一个 P0。** `session-communication` 对 Router 的投递调用了生产代码里不存在的方法，`session_send → router` 会永久重试而不达；`subconscious` 派工链依赖上述未提交修复才能工作。
3. **本机补齐 node24 + 依赖 + 构建后可以跑起来**（已拿到真实模型回复与 19 个工具的工具表），但这不是「仓库开箱即用」：还缺 profile 依赖声明、client 构建产物和 Windows 路径处理。

## 一、逐插件状态

「服务器」= 完整安装的同仓库工作树（含未提交改动），代表 HEAD 的真实运行基线；「本地」= 本机修复环境后（node22 跑测试、node24 跑服务）。

| 插件 | 服务器（HEAD 基线） | 本地（修复后） | 评级 | 一句话 |
|---|---|---|---|---|
| `session-communication` | 4/4 文件、16/16 绿 | 4/4、16/16 绿 | **C** | 测试全绿，但 Router 投递 P0 未覆盖，green 不成立 |
| `subconscious` | 3/3、24/24 绿（依赖未提交修复） | 1/3、14/23（HEAD） | **C** | 事务/幂等骨架好，但 HEAD 不自洽、事件 worker 未实现 |
| `session-compaction` | 1/1、5/5 绿 | 1/1、5/5 绿 | **B** | 正确的原生 scoped 包装，缺注入缺失/压力覆盖 |
| `proactive-system` | 4/4、16/16 绿 | 4/4、16/16 绿 | **B** | 复用原生 Host，隐患是隐式契约与无健康面 |
| `request-archive` | 2/2、10/10 绿 | 2/2、10/10 绿 | **B** | 正确但 O(N²) 重写、无保留策略 |
| `context-inspector` | 10/12、62/75（13 红） | 6/12、39/53 | **A**（代码）/失败为环境 | tokenizer 一致性通过，失败集中在缺包 |
| `dsh-livestream` | 41/44、327 过 / 2 红 / 6 跳过 | 38/44、322/329 | **B** | 安全边界扎实；2 例真红（Windows 路径/cookie 源） |
| `voice-call` | 11/15、159/177（18 红） | 8/15、123/139 | **B** | 已 `disabled`，但 18 例真红 + 与 gemini 代码耦合 |
| `gemini-cascade` | 7/7、31/31 绿 | 5/7、26/30 | **C** | 唯一全绿的语音插件，但 Windows 上桌宠必然挂不上（P1） |
| `conscious-mind` | 18/24、110/123（13 红） | 17/24、109/123 | **C** | 核心能力好，13 例真红 + guard 语义有洞 |
| `ayla-app` | 9/10、146/148（2 红） | 9/10、146/148 | **B** | 协议/重连是范本；HTTP 无超时（P1） |
| `kook-bot` | **套件加载失败**（缺 `@deepseek-ai/cordis`） | 1/1、13/13 绿 | **B** | 入站已接 pending；超时当失败（P1） |
| `qq-napcat` | 1 文件加载失败、2 例过 | 2/2、7/7 绿 | **C** | 入站未接 pending + 畸形帧可崩进程（P0） |
| `feishu-app` | **套件加载失败** | 1/1、4/4 绿 | **C** | 入站未接 pending、首连失败即死 |
| `memory` | 1/1、2/2 绿 | 1/1、2/2 绿 | — | **9 行占位、未被任何 profile 挂载**，实际记忆能力在 subconscious 内 |

## 二、关键结论

### 2.1 HEAD 不是通过验收的代码（P0）

服务器 `git status` 有 9 个未提交改动，且它们正是让 subconscious 验收通过的原因：

| 文件 | 改动 |
|---|---|
| `plugins/subconscious/tests/store.spec.ts` | 断言 `'presenting'` → `'presented'`（1 行） |
| `plugins/subconscious/tests/router-integration.spec.ts` | 补挂 `CommandRuntime`（`inject: ['commands']` 的硬依赖）+ 两处 reattach 场景 |
| `plugins/subconscious/src/dispatch-store.ts` | `recover()` 同事务化；对「已出报告但 effect 仍 stale」的 Assignment 做 reconcile（+8 行） |
| `plugins/subconscious/src/memory-session.ts` | 已存在的 Session scope 不符时**就地重新 setup**，而不是抛错（+4 行，配套 1 行） |
| `plugins/subconscious/src/router-session.ts` | 同上（+4 行） |
| `plugins/subconscious/tests/dispatch.spec.ts` | 新增 1 个「报告后上下文溢出仍要回传」用例 |
| `homes/web/profiles/web/cordis.patch.yml` | provider `nexus-a6-gemini` → `a6`、新增 `readOnlyDirs`、default provider `d1api` → `a6` |

同一份代码，只 checkout HEAD：`subconscious` 在服务器上也是 **1/3 文件、14/23 用例**（本地一致）。
**因此「远端已实现」与「远端已验收」不是同一件事**：验收状态只存在于服务器工作树，尚未提交。

### 2.2 `session-communication`：Router 投递必然失败（P0）

`plugins/session-communication/src/participants.ts:17,39` 调用 `owner.session.ensureExisting()`；
而生产侧 `subconsciousRouter.session` 是 `RouterSession`（`runtime.ts:24`），它只有 **private `ensure()`**（`router-session.ts:99`），全仓库 `ensureExisting` 只出现在本插件接口与测试 mock 里。

- 运行时：`session_send(target=router)` → `TypeError` → 被 `runtime.ts` 吞成 `DELIVERY_UNKNOWN` → 按 60s 无限重试；消息存了但**永远不达**。
- 测试：`tests/participants.spec.ts:15-21` 自己 mock 了 `ensureExisting`，所以 16/16 全绿也发现不了。
- 同类风险：`main` 冷恢复时直接抛 `RESTORE_FAILED`（可接受），`memory` 走 `sessionController.resolveAgent` 会落到 `standard` preset（见 3.2）。

### 2.3 本地部署链路：能跑，但不是开箱即可（P0/P1）

可复现的启动步骤（本次实测）：

```text
1. Node ≥ 24.9（dsh engines 要求）。本机原为 22.20，临时取官方 node v24.22.3 到 tmp/node24 后启动成功。
2. cd dsh && pnpm install --frozen-lockfile   # 不装则 tsx 源码启动直接失败（缺 js-temporal/hosted-git-info/birpc 等）
3. cd dsh && pnpm run build:lib && pnpm run build:web   # 不构建则 17 个 client 包缺 lib/client.js，client-modules(required) 启动失败
4. DSH_HOME=<临时 home> node24 node_modules/tsx/dist/cli.mjs apps/cli/src/bin.ts --profile web --no-open --port 3417
```

实测耗时：install 29.3s（npmmirror）、`build:lib` 8m35s、`build:web` 9.5s、**启动 14.9s**。

实测证据：`http://127.0.0.1:3417` 打开正常；新建会话 → 输入「本地部署验收：请只回复四个字」→ 模型真实回复「**验收通过**」，1 轮 1 步 41 tok/s、11.7K tok；request/header 工具表 **19 个**：`edit glob grep pass read read_image schedule_* send_text send_voice session_list session_read session_send skill web_fetch web_search write`。主会话 `elysia-conscious-mind` 首启创建、之后 resume，并在其中真实回复。

但同一次验收里，**首个 memory 派工失败**：`EPERM mkdir 'E:\home\ayerelysia\Elysia\Data\workspace\subconscious'`——`memoryWorkspaceDir` 回落到 `subconscious/src/dispatch.ts:17` 的 Linux 默认值；Windows 上该路径落到当前盘符根，且父目录创建被拒。这条是 D3（硬编码路径）的直接后果，不是模型或凭据问题。

阻碍与缺陷：

| # | 级别 | 问题 |
|---|---|---|
| D1 | **P0** | `homes/web/profiles/web/package.json` **没有声明 `@elysia/subconscious`**（服务器也没有，只靠手工装的 node_modules）。干净 checkout 解析该 mount 行直接 `ERR_MODULE_NOT_FOUND`，潜意识链路不启动。`@elysia/memory` 同理，但它本来就没被挂载。 |
| D2 | P1 | `homes/web/profiles/web/node_modules` 里的 `@elysia/*` 是 5 天前的 **file: 副本**，不是 link：`conscious-mind` 缺 `skill-capabilities.ts`、`external-reply-guard.ts`，`proactive-system` 2 个文件不同。**「已安装的部署树」≠ 当前代码**。 |
| D3 | P1 | 24 处硬编码 `/home/ayerelysia/...` 默认路径；其中 4 个是不可配置的模块常量：`MAIN_SESSION_CWD`（`conscious-mind/src/main-session.ts:49`）、`ROUTER_SESSION_CWD`（`subconscious/src/model.ts:14`）、`LIVESTREAM_SESSION_CWD`（`dsh-livestream/src/dsh/session.ts:19`）、`DEFAULT_MEMORY_SESSION_CWD`（`subconscious/src/dispatch.ts:17`）。Windows 上必须造影子目录才能完整验收这三个 session。 |
| D4 | P1 | `docs/operations/development.md` 指定的团队测试入口 `dsh/vitest.elysia.config.ts` 已被 `812c78fca2`（vendored sync）删除；`dsh/pnpm-workspace.yaml` 里的 `../plugins/*` 同时被删，而 profile 注释仍声称存在。文档失真。 |
| D5 | P2 | `plugins/*/node_modules` 缺 `@deepseek-ai/*` 链接（本机 subconscious 原来只有 1 个，服务器 38 个）；`@types/node` 为悬空 junction。本次用 69 个 junction 临时补齐（未跟踪）。 |
| D6 | P2 | 服务器上 `kook-bot` / `feishu-app` / `qq-napcat` 的测试**套件加载失败**（`Cannot find package '@deepseek-ai/cordis'`），即三个渠道插件在服务器没有任何可执行的测试证据。 |
| D7 | P2 | node24 + vitest(vite8) 在本机 `EPERM mkdir %TEMP%\<rand>\ssr`，最小用例可复现；插件单测必须用 node22。 |

### 2.4 本地 vs 服务器：失败归因

本地修复后仍有真红的插件，都在服务器基线同样红（`conscious-mind` 13、`context-inspector` 13、`voice-call` 18、`ayla-app` 2、`dsh-livestream` 2），说明不是本机环境问题。
本地独有的红（`gemini-cascade` 2 文件、`dsh-livestream` 额外、`context-inspector` 额外）来自缺包与 lib 重建，服务器上对应为绿。

## 三、缺陷清单

### 3.1 P0

| # | 位置 | 问题 |
|---|---|---|
| A1 | `session-communication/src/participants.ts:17,39` | `ensureExisting` 不存在 → Router 投递永久失败（见 2.2） |
| A2 | `qq-napcat/src/session.ts:76` + `link.ts:147-149` | WebSocket 帧 `JSON.parse` 无守卫；畸形帧抛 `uncaughtException` → dsh `installFailLoud` 直接 `exit(1)`。评审方用真实 `NapcatLink` 探针复现 `uncaught exceptions: 1`。 |
| A3 | `homes/web/profiles/web/cordis.patch.yml:112` vs `package.json` | 挂载了未声明的 `@elysia/subconscious`（见 D1） |
| A4 | 服务器工作树 | 通过验收的 9 个修复未提交，HEAD 不可复现验收（见 2.1） |

### 3.2 P1

| # | 位置 | 问题 |
|---|---|---|
| B1 | `gemini-cascade/src/desktop-host.ts:25` | key 权限校验 `stat.mode & 0o077` + `stat.uid !== process.getuid?.()` 是 POSIX 语义，**Windows 上恒真 → 桌宠插件永远挂不上**；而桌宠本身就是 Windows 功能。其 `desktop.integration.spec.ts` 4/5 红在 `desktop_key_permissions`。 |
| B2 | `subconscious/src/memory-session.ts` + `participants.ts:41-53` | 记忆 Session 冷恢复走通用 `resolveAgent` → 用 `standard` preset 组装（bash/subagent/web 全在），随后 `MemorySession` 因 scope 不符抛错 → 派工链坏、模型也回落到默认 provider。服务器未提交改动只修了「live 已存在」路径的一半。 |
| B3 | `conscious-mind/src/external-reply-guard.ts:25-38` | 工具「失败/被拒」也计入「已选择」：平台+本地混合轮里 `local-send-confirmation` 拒绝 `send_text` 后，守卫判定满足 → **外部消息被静默丢弃**；且不校验 channel/conversation，多会话批次只回一个即满足。 |
| B4 | `conscious-mind/src/reply-origin.ts:17-18` | 内部消息（session-communication）被判为 local，混合轮里主意识对外回复可能被本地确认守卫拦下。安全上是改进，交互上有副作用。 |
| B5 | `kook-bot/src/client.ts:205` / `feishu-app` | `OutboundDeliveryUnknown` 只在 KOOK 的**语音**路径映射；文本路径与飞书整体没有该映射，超时一律按失败处理，违反架构「投递未知≠失败」。仅 ayla-app 完整遵守（5 处）。 |
| B6 | `qq-napcat/src/link.ts:159-161` | 反向监听**空 token 恒放行**，且无条件开监听。 |
| B7 | `ayla-app/src/auth.ts` / `client.ts` | HTTP 全程无超时（sign、media 下载、发送），一条慢媒体可钉死串行入站链。 |
| B8 | `request-archive/src/index.ts` | 每次写重写全部历史 → O(N²)；无保留策略；单条实测 112 KB（`null,2` 美化占 35%）。 |
| B9 | `subconscious/src/dispatch-store.ts` / `runtime.ts:166-214` | `maxRunMs` 只写入 Mandate **从不执行**；重试无上限、无 `failed` 终态；`attempt_count` 只增不读；无 lease（多进程可重复执行）；`work()` 里读 DB 在 try 之外（unhandled rejection）。 |
| B10 | `session-communication/src/index.ts:106` + `participants.ts:10-14` | 只有 main/router/memory 三个硬编码参与者，与「所有 session 都能通信」目标不一致；无 per-pair 权限位；relay 正文主动邀请回复且无 hop/速率限制（A→B→A 是鼓励而非抑制）。 |
| B11 | `subconscious/src/general-capabilities.ts` | Router 有 bash / web_fetch，与「Router 不读工作区、不联网」的目标冲突。 |
| B12 | `homes/web/profiles/web/cordis.patch.yml` | `elysia-voice-call` 行 `disabled: true` 但配置里 `enabled: true`，翻一个开关就武装付费链路。 |

### 3.3 P2 择要

- `plugins/memory`：9 行空 `apply`、不在任何 profile、与 subconscious 无代码关系，**死包**。
- 文档失真：`README.md:10`「Five packages」实为 15；`plugins/subconscious` 文档宣称 21/21 通过，HEAD 实际 23 个 `it()`；`README.zh.md:102` 与 `pass.ts:24` 对「不强迫选择 send_text」的描述与 guard 实际行为矛盾。
- 构建产物泄漏：`dsh/packages/client/ui-theme/src/client/styles.d.ts` 为未跟踪生成物，而 `.gitignore:140` 用 `!` 反忽略该模式。
- `context-inspector`：tokenizer 校验失败会在 `apply()` 抛出，连只读查看一起拖垮，已有 heuristic 回退未用。
- `dsh-livestream`：`settings.json` 实测 0666 却存 `stageToken`；`allowedWriteActions: []` 与 `publisher=livehime` 的语义只写在文档里。
- `voice-call`：`VoiceAgent` 缺当前 `Agent.model`（`runtime-types.ts:191-197`），tsc 11 处 TS2420/TS2345，会话不能参与模型选择/展示。
- `ayla-app`：设置页可把密码写进**被 git 跟踪**的 profile 补丁；`client/index.tsx:92` `Property 'secret'`（唯一与本机环境无关的 tsc 错误）。

## 四、架构文档与实现落差

`docs/architecture/target-session-capabilities.zh.md` 描述七用例、三类 worker，当前实现只到：

| 文档承诺 | 实现 |
|---|---|
| 记忆 worker（每次新建 + 注入记忆 skill） | 有，但实际是**长期 Session** + 提示词文件（`memory-session.ts`），不是每次新建、也没有 skill 注入 |
| 通用 worker / 事件 worker（Router 建触发器自动跑） | **0 实现**：`dispatch-store.ts:408` 只接受 `kind='memory'`；代码里的 `trigger_ref` 是「当前输入凭据」，不是触发器实体 |
| 主意识不直接派工 | ✅ 成立（只有 Router 有 dispatch 工具） |
| 通信工具全员可用 | ◐ 只有 3 个参与者（B10） |
| Ayla 任意操作工具 | **0 实现**：`ayla-app` 三份 TOOLSET 文档 20 个工具一个都没有，入站也只收 text/image |
| 心跳（第二种触发，不是独立 session） | ◐ 有 2s 收集定时器，空队列不调模型；没有心跳判定 |

## 五、未验收项（明确空白）

- **B 站直播**：按要求未测。开播/推流、弹幕收发的真实链路、扫码登录、私信/评论/动态/点赞投币、视频 CDN 全部未验证；`dsh-livestream` 只做了静态审查 + 单元测试。
- **真实平台渠道**：KOOK（服务器 token 为空）、飞书、QQ（无 NapCat 连接）、Ayla 后端（`AYLA_BASE_URL` 指本机 8100，本机无服务）。
- **语音链路**：BreezeTTS、Gemini cascade bridge、LiveKit、桌宠；无 bridge key / 无扬声器麦克风验收。
- **重启恢复**：主意识/ Router / 记忆 Session 的崩溃恢复只做了单元级（`recover()`），没有真实进程 kill-restart 验收。
- **线上服务器运行态**：进程 11-18 23:16 启动，HEAD `faad9d4ae3`；本地 HEAD 比它多 1 个文档提交。未做线上重启验收。

## 六、建议的下一步（按优先级）

1. **把服务器那 9 个未提交修复提交**（2.1）——否则 HEAD 与验收状态永远分裂。
2. **修 `participants.ts` 的 Router 接口**：给 `RouterSession` 暴露 `ensureExisting()`（或改调 `ensure()` 并公开发布），并补 router 投递的集成测试（2.2）。
3. **给 QQ 的帧解析加守卫**，并把畸形帧作为测试用例（A2）。
4. **把 `@elysia/subconscious` 与 `@elysia/memory` 写进 profile 依赖**，并确认 `link:` 与 `file:` 的取舍一致（D1/D2）。
5. **Windows 修正**：`desktop-host.ts` 的 POSIX 权限检查、4 个不可配置的 session cwd、24 处硬编码路径（B1/D3）。
6. **补文档**：删掉已被删除的 `vitest.elysia.config.ts` 引用、修正插件数量与验收数字、同步 guard 行为（D4/3.3）。
7. **决定 `plugins/memory` 的去留**：删掉或明确标注「由 subconscious 内部实现替代」。