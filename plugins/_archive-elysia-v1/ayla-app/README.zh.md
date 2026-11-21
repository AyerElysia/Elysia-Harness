# @elysia/ayla-app

Ayla 应用里的聊天进 DSH，模型的回复回到 Ayla 的同一个会话。插件由 DSH 主动拨 Ayla，自己不开放任何端口。

包内不依赖任何 `@elysia/*`，`dependencies` 为空；WebSocket 用 Node 22 自带的全局 `WebSocket`。

## 安装

插件通过 profile 挂载，与其它 Ayla 渠道同一条路径：

```json
// homes/web/profiles/web/package.json
"dependencies": { "@elysia/ayla-app": "file:../../../../plugins/ayla-app" },
"dsh": { "profile": { "bundles": [ ..., "@elysia/ayla-app" ] } }
```

`cordis.patch.yml` 自带一条 `insert`，字段也可以由环境变量起手：`AYLA_BASE_URL`、`AYLA_BOT_USER`、`AYLA_BOT_PASSWORD`。

profile 侧的挂载行带 `disabled: !!js process.env.AYLA_BASE_URL === undefined`：**没设
`AYLA_BASE_URL` 时整行禁用、插件根本不挂载**，与 `qq-napcat` / `feishu-app` / `kook-bot`
的「未配置就禁用」同形。

因此启用分两步，顺序不能反：

1. 先给出地址，让这一行不再是 `disabled`：

   ```sh
   export AYLA_BASE_URL=http://127.0.0.1:8100   # 或别的私网/https 地址
   ```

2. `username` / `password` 可以直接用 `AYLA_BOT_USER` / `AYLA_BOT_PASSWORD`
   环境变量给，也可以留空、等 profile 起来后在设置页填（设置页的表单由组合后的
   条目树生成，`disabled` 行仍在其中）。改完重挂 profile 才生效。

被 `disabled` 的行不挂载：登录、WS 连接、重连都不发生。这是「未配置不拖垮整个
profile」的取舍——直接挂上会让一台没配 Ayla 的机器无限退避重连。

> `file:` 依赖会在 `node_modules/@elysia/ayla-app` 留副本：只改源码而不重装不生效，部署后应逐文件比对 SHA-256。

## 设置项

全部字段是 `.volatile()`：设置页出现表单行，保存不会因为值变化而重挂插件。

但要分清两件事：

- **`.volatile()` 保证的是「改设置不会重启插件」**，不是「改完就自动重连」。
- `apply()` 在挂载时用 `.get()` 读一次 `baseUrl` / `username` / `password` / `mode`，
  之后没有 `loader/volatile-update` 监听。所以改完这几个字段要**重挂插件**
  （重启 profile）才会用新账号连上；已经建立的 socket 不会因为改了设置而重连。

`workspaceDir` 只在 standalone 形态挂载时读取，同样需要重挂。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8100` | Ayla 后端地址；WebSocket 地址由它派生 |
| `username` | 空 | 爱莉自己的 Ayla 账号 |
| `password` | 空 | 该账号密码；`role('secret')`，表单脱敏，不进日志 |
| `mode` | `auto` | `auto` / `elyh` / `standalone` |
| `workspaceDir` | 空 | 仅 standalone 用；为空取 `process.cwd()` |

`baseUrl` 在挂载时校验，不合法即失败：`https:` 任意主机都可以；`http:` 只允许 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`localhost` 与 `[::1]`。地址里不允许内嵌账号密码——那会把凭据带进日志。

## 连接与鉴权

| 项 | 实现 |
|---|---|
| 登录 | `POST /api/v1/auth/login/` → `{access, refresh}` |
| 刷新 | `POST /api/v1/auth/refresh/`；刷新后 refresh 会变，新值立刻落盘 |
| access | 只在内存，进程重启后重新换 |
| refresh 落盘 | `$DSH_HOME/ayla-app/refresh.json`（未设 `DSH_HOME` 时为 `~/.dsh/ayla-app/refresh.json`），`0600`，不进 Git、不进日志 |
| 401 / 403 | 刷新一次并重放该请求；刷新也失败 → 记一条 `failed` 并停止，不无限重试 |
| 地址 | `http→ws`、`https→wss`，路径 `/ws/elysia-bridge/?token=<access>` |

失败日志只带状态码与端点，不带令牌、密码或响应正文。

## 两种形态

| 形态 | 触发条件 | 消息去哪 | 谁回复 |
|---|---|---|---|
| elyh | `mode: elyh`，或 `auto` 且 `inboundPending` 与 `outboundText` 都在 | `inboundPending.receive()` | conscious-mind 自己的 `send_text` |
| standalone | `mode: standalone`，或 `auto` 且缺上述服务 | 自建 session `ayla-channel` | 插件在该会话作用域注册的 `send_text` |

判定顺序固定：

1. `mode: elyh` 而服务缺失 → **挂载失败**并指出缺哪个服务，不静默改去别处。
2. `mode: standalone` → 即使服务都在也用独立会话，且不注册第二个 `send_text`。
3. `mode: auto` → 两个服务都在用 elyh，否则 standalone。

`inboundPending` / `outboundText` 只用 `ctx.get()` 探测，**不进 `inject`**：写进 `inject` 就等于强制依赖，没装 conscious-mind 的 dsh 会连插件都挂不上。

elyh 形态只做两件事：把事件交给 `receive()`，并在 `outboundText` 上登记 `ayla` 渠道，供 conscious-mind 的 `send_text` 查找。它不注册工具、不建 session。

standalone 形态：

- 固定 session id `ayla-channel`，`cwd` 取 `workspaceDir`，为空用 `process.cwd()`。
- `send_text` 在 **agent 作用域**注册（`agentCtx.tools.register`），全局工具表里没有它。
- 一批入站合并成一条 user message，然后 `agent.whenIdle()`；投递失败的一批放回队首重试。
- 不装提示词：工作区的 `AGENTS.md` 由 dsh 自己注入。

## 协议

一条 WS、JSON 文本帧、双向，所有帧带 `v` 与 `type`。

| 方向 | 帧 | 语义 |
|---|---|---|
| Ayla → DSH | `inbound` | 一条用户消息，带单调递增 `seq` |
| Ayla → DSH | `pong` / `ping` | 心跳 |
| Ayla → DSH | `sent` | 该次 `reply` 已落库，回 `message_id` |
| Ayla → DSH | `error` | 拒绝该次 `reply`，带 `code` / `detail` |
| DSH → Ayla | `reply` | 一条文本回复 |
| DSH → Ayla | `ack` | 已处理到 `seq`（含）；未 ack 的会重投 |
| DSH → Ayla | `resume` | 重连后从 `seq+1` 起重投 |
| DSH → Ayla | `ping` / `pong` | 心跳 |

- 心跳 30s 一轮；连续两轮 ping 未收到 pong 即断开重连。
- 重连退避 1→2→4→…→60s，带 50%–100% 抖动；**只在状态变化时记一行日志**。
- 断开时把所有等回执的 `send_text` 以 `OutboundDeliveryUnknown` 结算，不挂死。
- 单帧上限 1 MiB，单条文本上限 32 KiB；未知 `parts[].type`（voice/file/video/emoji/…）整条拒绝。

图片不给字节：帧里只有 `media_id`。插件用同一枚 JWT 调 `POST /api/v1/media/{media_id}:sign` 取短时 URL，下载后交 `ctx.attachments.admitPromptContent()` 准入。**准入失败整条不可投递且不回 ack**，由 Ayla 重投。

## 出站

`conversation` → 校验 → 组 `reply` 帧 → 等 `sent` / `error` 或超时 → 回 `messageId` / 抛 `OutboundDeliveryUnknown`。**不自动重试**：`content` 按换行拆段逐段投递，第一段失败即停，后续段落不再发。

## 排障

| 现象 | 原因与处置 |
|---|---|
| 日志没有「Ayla 通道形态」 | 插件没被挂载：检查 profile 的 `dependencies` 与 `dsh.profile.bundles` |
| 挂载报 `baseUrl` 相关错误 | 地址为空、不是 http/https、内嵌了账号密码，或明文指向非 loopback/私网主机 |
| 挂载报「mode 设为 elyh，但缺少服务」 | 装 conscious-mind，或把 `mode` 改成 `standalone` |
| 日志停在「Ayla 通道状态: disconnected」 | Ayla 后端不可达或未启动；插件会继续退避重连，不会刷日志 |
| 日志出现「Ayla 通道状态: failed (Ayla 鉴权失败…)」 | 账号密码或 refresh 已失效；插件不再重试，改好设置后重挂 |
| 收不到消息但连接正常 | Ayla 侧 `ElysiaProfile` 未启用（consumer 会以 4403 拒绝），或 outbox 无 pending 行 |
| 图片消息反复重投 | 图片下载或准入失败：看「Ayla 消息 … 不可投递」那行的原因；按设计不回 ack |
| `send_text` 报「投递状态未知」 | 等回执期间连接断开或超时；按契约不重试，需要她自己决定是否重发 |
| 改了源码没生效 | `file:` 副本还在旧版本；重装 profile 依赖后逐文件比对 SHA-256 |

## 测试

```sh
cd Elysia-Harness
dsh/node_modules/.bin/tsc --noEmit -p plugins/ayla-app/tsconfig.json --typeRoots ./dsh/node_modules/@types
cd dsh && node_modules/.bin/vitest run --config vitest.elysia.config.ts ../plugins/ayla-app/tests
```

`--typeRoots` 是仓库既有环境的必要条件，缺了会报 TS2688。测试全部离线：WebSocket 与 HTTP 都是手写 double，不连真实 Ayla。

## 相关文档

契约见 [REQUIREMENTS.zh.md](./REQUIREMENTS.zh.md)，实施步骤见 [DEVELOPMENT.zh.md](./DEVELOPMENT.zh.md)。
