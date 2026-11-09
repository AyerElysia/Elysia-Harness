# Ayla 通道开发文档

> 配套需求：[REQUIREMENTS.zh.md](./REQUIREMENTS.zh.md)（本文不重复契约，只写怎么落地）。
> 基线（2026-11-09 本地）：Elysia-Harness `914db933d3`、Ayla `b4fc8ee`。
> 执行顺序按 D-1 → D-9；每个 Dx 完成即可独立验证，不必等全部做完。

## 0. 开工前必读

1. 仓库根 `AGENTS.md`（工程约束）、`dsh/AGENTS.md`（上游规则）、`dsh/packages/AGENTS.md`（包规则）。
2. 需求文档 §2 的三条根约束 C1/C2/C3 —— 本文每个决定都从它们推出来。
3. 检查工作树：`git status`。**共享工作区可能有别人的未提交改动，只动本任务文件。**

## 1. 总览：谁改什么

| 侧 | 目录 | 改动 |
|---|---|---|
| Ayla | `Ayla/backend/apps/elysia_bridge/` | 重写：删除旧桥接，新增 WS consumer + outbox + 出站端点 |
| Ayla | `Ayla/backend/config/{asgi.py,settings.py,urls.py}` | 路由与配置 |
| DSH | `Elysia-Harness/plugins/ayla-app/` | 新建插件 |
| DSH | `Elysia-Harness/homes/web/profiles/web/cordis.patch.yml` | 挂载一行 |

顺序上**先做完 Ayla 侧**（D-1 ~ D-4），因为 DSH 插件要连它才有意义。

## 2. D-1 清理旧代码（Ayla）

### 目标

协议已不存在，保留旧实现只会让下一个人误以为它在工作。

> **本节已按 `D1-AUDIT.md` 重写。** 初版的步骤顺序会直接导致后端无法启动——必须先断开 import 点，再删被 import 的文件。审计全文见 `Elysia-Harness/plugins/ayla-app/D1-AUDIT.md`。

### 前置：确认工作树归属

并行 agent 可能正在改前端。开工前：

```bash
cd Ayla && git status --porcelain | awk '{print $1}' | sort | uniq -c
git status --porcelain | grep -v 'web/' | grep -v 'flutter/' | head
```

**后端改动必须与前端撤下分开提交**，不要混在一批。

### 步骤（顺序不可调换）

**第 0 步：断开所有 import 点（先做，不删任何文件）**

| 位置 | 改法 |
|---|---|
| `apps/elysia_bridge/apps.py:9-13` | 删掉 `ready()` 里的 `from ...inline import start_bridge_thread` 与调用；`ready()` 可整体删除 |
| `config/asgi.py` | 删 `_lifespan_app` / `wrapped_application` 与两处 `start_inline_bridge`/`stop_inline_bridge` 调用，恢复标准 `ProtocolTypeRouter` |
| `views.py:25` | `from .services import ProfileNotConfigured` 若指向待删段，改为保留该异常类或本地定义 |
| `serializers.py:17` | **`generate_elysia_stream_id` 必须保留**，不要动这行 import |
| `apps/chat/consumers.py` | 移除 `elysia_voice` 组与两个 handler（150、179、615–624） |
| `apps/chat/tests/test_friend_private_send.py` | 改掉 `stream_id=generate_elysia_stream_id(...)` 三处 |

改完立刻验证：`python manage.py check` **必须通过**。

**第 1 步：删除文件**

按需求 §13.1 的 12 个整文件删除。

**第 2 步：裁剪 services.py**

删 82–1216，保留 1–81（异常类）与 1247–1278。删完再跑一次 `manage.py check`。

**第 3 步：清理视图与路由**

- `views.py` 的 `ElysiaVoiceCall*` 5 视图 + 3 helper（141–306）
- `urls.py` 的 5 条 `voice-calls/` 路由（17–42）

**第 4 步：配置与依赖**

- `settings.py`：`ELYSIA_BASE_URL`、`ELYSIA_CREDENTIAL_FILE`、`ELYSIA_SSE_*`、`ELYSIA_BRIDGE_INLINE`、`VOICE_OBSERVER_ENABLED`
- `settings_test.py:34`
- `pyproject.toml` 的 `websockets`（唯一使用者已删）
- `backend/.env` 与 `.env.example` 同步删键

**第 5 步：重写 test_inject.py**

只保留「非爱莉会话不 inject / 爱莉本人不入站」语义。

### 验收

- `Ayla/backend/{apps,config,tests}/` 下的 `*.py` **零命中**旧符号（不是全仓——历史文档必然命中，见需求 §13.5）。
- `python manage.py check` 通过。
- `python -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql` 通过（数量会减少）。
- 后端能启动，`/api/v1/health/` 200。

### 已知陷阱

| 陷阱 | 说明 |
|---|---|
| `generate_elysia_stream_id` | 名字带 elysia 但**不能删**：`serializers.py:17` 模块级 import，删了 URLconf 挂 |
| 本地库有 1 行 | 生产 0 行，本地 `ayla.elysia_profiles` 有 1 行；`stream_id` 是 unique+非空+无 default，`0004` 回退可能失败。**回退前先备份该表** |
| `test_inject.py` 假绿 | 现有 `:172-174` 的 monkeypatch 无效，测试通过是因为异常被 `except` 吞了。重写时不要复制这个模式 |
| 死配置 | `ELYSIA_SSE_RECONNECT_SECONDS` / `ELYSIA_SSE_EVENT_TYPES` 早已无读取，删了不影响行为 |
| 同名异义 | `conscious-mind/src/tui.ts` 的 `ELYSIA_BASE_URL` 是 LLM provider 地址；`apps/releases/*` 的 `platform` 是发布平台。**不要误伤** |

> ⚠️ 删除是破坏性操作。每步之后立刻 `manage.py check`，不要攒到最后一起验。删前记录 `git status` 与 HEAD。

## 3. D-2 数据模型：ElysiaProfile 收敛 + outbox

### ElysiaProfile

保留 `user`、`enabled`、`display_name`、`created_at`；删除 `stream_id`、`platform`、`chat_type`。新迁移 `0004`（现有到 `0003`）。

**删除前必须先改消费者**（需求 §13.4）：`serializers.py:33-35,44,47`、`views.py:69-70,137`、`apps/chat/tests/test_friend_private_send.py`。这些是模块级或测试级引用，先改再删字段。

**数据前提**：生产库 0 行（迁移到 0003），但**本地开发库有 1 行**。`stream_id` 是 `unique` + 非空 + 无 default，回退 `0003` 可能失败——回退前先 `mysqldump` 该表。

### 新增 AylaInboundOutbox

```python
class AylaInboundOutbox(models.Model):
    """一条用户消息待投递给 DSH 通道。与 Message 同事务写入。"""

    STATUS_PENDING = "pending"
    STATUS_DELIVERED = "delivered"
    STATUS_FAILED = "failed"
    STATUS_DEAD = "dead"

    message = models.OneToOneField(
        "chat.Message", on_delete=models.CASCADE, related_name="ayla_outbox"
    )
    seq = models.BigIntegerField("通道序号", unique=True)   # 单调递增，DSH ack 用
    status = models.CharField(max_length=16, default=STATUS_PENDING)
    attempts = models.IntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

- `seq` 唯一且单调：用 `SELECT ... FOR UPDATE` 取 max+1（或在专用序列表上加锁），**不得**用 `Message.id` 当通道序号。
- 索引：`(status, seq)`。

### 验收

- 迁移可前进可回退（`migrate elysia_bridge 0004` / `0003`）。
- `Message.objects.create(...)` 与 outbox 写入在同一 `transaction.atomic()`。

## 4. D-3 WS 通道 consumer

### 路由

`apps/elysia_bridge/routing.py`：

```python
from django.urls import path
from .consumers import AylaBridgeConsumer

websocket_urlpatterns = [
    path("ws/elysia-bridge/", AylaBridgeConsumer.as_asgi()),
]
```

并在 `config/asgi.py` 的 `chat_ws + ...` 之后追加 `elysia_ws`。

### 鉴权（复用现有约定）

```python
# 与 apps/accounts/consumers.py:36 同一手法：query string 的 token
from rest_framework_simplejwt.tokens import AccessToken
from urllib.parse import parse_qs

def _jwt_user_from_scope(scope): ...  # 直接复用 accounts 的实现，不要复制
```

> 复用而非复制：`apps/accounts/consumers.py` 的 `_jwt_user_from_scope` 已经是既有实现，import 它。

连接后必须校验：该 user 是某个启用的 `ElysiaProfile.user`，否则 `close(4403)`（不是爱莉账号不得占用通道）。

### 帧处理

| 收到 | 处理 |
|---|---|
| `ping` | 回 `pong` |
| `resume{seq}` | 从 `seq+1` 起重投 pending |
| `ack{seq}` | 把 `≤seq` 的 outbox 置 `delivered`，推进游标 |
| `reply{...}` | 落库 + `broadcast_message_new`，回 `{type:"sent", client_message_id, message_id, seq}` |

出站帧组装与 `services.py` 的投影逻辑同形（单条消息 → 一帧），但**不再走 SSE**。

### 单实例语义

同一 profile 只允许一条活跃连接：新连接进来先关闭旧连接（需求 §10）。用 Channels group + 进程内字典都行，但**必须记一行日志**说明发生了顶替。

### 验收

- 单测：无 token 拒绝、非爱莉账号 4403、ping/pong、resume 重投、ack 推进、reply 落库并广播一次。
- 用 `channels.testing.WebsocketCommunicator`，配 `settings_test_mysql`（与既有测试一致）。

## 5. D-4 出站端点与鉴权回退

出站走 WS 帧（§7.2），不需要额外 HTTP 端点。但要提供一个**只读探测**给设置页与运维：

```text
GET /api/v1/elysia/bridge/health/   （JWT，任意登录用户）
→ { "ok": true, "profile": {...}, "pending": 3, "active_connections": 1 }
```

同时把 `POST /api/v1/elysia/profile/:test` 的语义改为「探测通道是否连通」，删掉凭据换发逻辑。

### 验收

- health 在无连接时返回 `active_connections: 0` 且 200，不 500。
- 不泄露待发消息正文。

## 6. D-5 DSH 插件骨架

### 目录

```text
plugins/ayla-app/
├── package.json          # 零依赖，private
├── tsconfig.json         # 继承 ../../dsh/tsconfig.base.json
├── cordis.patch.yml      # dsh.bundle.patch 指向它
├── src/
│   ├── index.ts          # name / inject / Config / apply
│   ├── settings.ts       # Config schema（.volatile() 字段）
│   ├── conversation.ts   # ayla:private:N ⇄ {kind,id}
│   ├── protocol.ts       # 帧类型与解析（纯函数，最好测）
│   ├── client.ts         # WS 连接、心跳、重连、resume/ack
│   ├── auth.ts           # login / refresh / refresh 持久化
│   ├── inbound.ts        # 帧 → InboundEvent（含图片下载与准入）
│   ├── outbound.ts       # conversation → reply 帧 → 结果
│   ├── form-standalone.ts# 自建 session + send_text
│   └── form-elyh.ts      # 探测 + inboundPending.receive
├── tests/
│   ├── protocol.spec.ts
│   ├── conversation.spec.ts
│   ├── forms.spec.ts
│   └── outbound.spec.ts
└── README.zh.md
```

### package.json 要点

```json
{
  "name": "@elysia/ayla-app",
  "private": true,
  "type": "module",
  "dependencies": {},
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:~",
    "@deepseek-ai/schemastery": "workspace:~"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:~",
    "@deepseek-ai/schemastery": "workspace:~"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

> 不写 `@elysia/*`，也不写 `ws`。需要 dsh 服务类型时用 `import type {} from '@deepseek-ai/dsh-…'`（type-only，不影响运行）。

### Config（settings.ts）

```ts
export interface Config {
  baseUrl: string
  username: string
  password: string
  mode: 'auto' | 'elyh' | 'standalone'
  workspaceDir: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8100').volatile(),
  username: z.string().default('').volatile(),
  password: z.string().role('secret').default('').volatile(),
  mode: z.union([z.const('auto'), z.const('elyh'), z.const('standalone')])
    .default('auto').volatile(),
  workspaceDir: z.string().default('').volatile(),
})
```

`.volatile()` 是设置页出现表单行的开关（参照 `dsh/packages/web/web-deepseek-api/src/index.ts`:48）。

### 地址校验

```ts
// 非 loopback/私网 且非 https/wss → 抛错，加载即失败
function assertBaseUrl(raw: string): URL { ... }
```

校验规则：`http:` 仅允许 `127.0.0.1`、`::1`、`localhost`、`10/8`、`172.16/12`、`192.168/16`；`https:` 任意。

### 验收

- `pnpm exec tsc --noEmit -p plugins/ayla-app` 零 diagnostics。
- `pnpm exec vitest run --config dsh/vitest.elysia.config.ts ../plugins/ayla-app/tests` 通过。

## 7. D-6 形态判定与两条实现

### 判定（index.ts 的 apply）

```ts
const pending = ctx.get('inboundPending')
const outboundText = ctx.get('outboundText')
const resolved = resolveForm(config.mode, pending, outboundText)
ctx.logger('ayla-app').info(`ayla 通道形态: ${resolved}`)
```

规则见需求 §4。**`mode:'elyh'` 而服务缺失 → `throw`**，不降级。

### form-elyh.ts

```ts
export function installElyhForm(pending: { receive(e: InboundEvent): void }): void {
  // 只提供 receive；不注册工具、不建 session
}
```

注意 `InboundEvent` 的结构要与 conscious-mind 一致（`channel/conversation/messageId/senderId/senderName/content`）。**不要 import 它的类型文件**（违反 C1），在插件内自己声明同构接口，靠结构类型兼容。

### form-standalone.ts

要点：

1. session id 固定 `ayla-channel`，`cwd = workspaceDir || process.cwd()`。
2. 用 `ctx.agents.create / resume`（`meta: { cwd }`），setup 里注册工具。
3. **工具注册必须在 agent 作用域**：
   ```ts
   const setup = (agentCtx) => { agentCtx.tools.register(defineSendTextTool(send)) }
   ```
   不要用全局 `ctx.tools.register`。
4. 入站一批 → 一条 user message（`createUserMessage`，结构与 conscious-mind 的 `formatInboundBatch` 同形），然后 `agent.whenIdle()`。
5. 不装提示词：工作区 `AGENTS.md` 由 dsh 自动注入。

### 验收

- 单测（用手工 ctx 或 mock）：四种 mode 组合的判定结果；`elyh` 缺服务时抛错。
- 断言全局工具表**不含** `send_text`（standalone 下它只在 agent scope）。
- grep 断言：`plugins/ayla-app/src` 内无 `@elysia/`。

## 8. D-7 协议实现

### protocol.ts（纯函数，先写这个）

```ts
export type InboundFrame = { v: 1; type: 'inbound'; seq: number; message: {...} }
export type ReplyFrame = { v: 1; type: 'reply'; client_message_id: string; ... }
export function parseFrame(raw: string): Frame | undefined   // 未知 type 返回 undefined
export function buildReply(...): ReplyFrame
export function buildAck(seq: number): AckFrame
export function buildResume(seq: number): ResumeFrame
```

规则：帧必须 ≤ 1 MiB（需求 §10）；`v !== 1` 视为不可解析并记一行。

### client.ts

- 用全局 `WebSocket`（Node 22 自带），**不引入 `ws`**。
- 连接：`new WebSocket(url + '?token=' + access)`，`url` 由 `baseUrl` 派生（`http→ws`，`https→wss`）。
- 心跳 30s；两轮无 pong → 断开重连。
- 重连退避 1→2→…→60s 带抖动；**只在状态变化时记日志**。
- 断开时把未收到结果的 `send_text` 调用全部以 `OutboundDeliveryUnknown` 结算（不能挂死）。

### inbound.ts

图片：拿到 `media_id` 后用同一枚 JWT 调 `POST /api/v1/media/{media_id}:sign`，取 `url` 再 `fetch` 下载，然后：

```ts
const admitted = await ctx.attachments.admitPromptContent(parts)
```

**失败则整条消息不可投递**（与 KOOK 同规则），并**不回 ack**，让 Ayla 重投。

### 验收

- protocol 单测覆盖：正常帧、未知 type、缺字段、超大帧、v≠1。
- 出站超时 → `OutboundDeliveryUnknown`；`error` 帧 → 失败带 `stoppedAt`。

## 9. D-8 挂载与配置

`homes/web/profiles/web/cordis.patch.yml` 的 `insert` 段追加：

```yaml
    - id: elysia-ayla-app
      name: '@elysia/ayla-app'
      config:
        baseUrl: !!js process.env.AYLA_BASE_URL ?? 'http://127.0.0.1:8100'
        username: !!js process.env.AYLA_BOT_USER ?? ''
        password: !!js process.env.AYLA_BOT_PASSWORD ?? ''
        mode: auto
        workspaceDir: ''
```

同时把新包加进 `homes/web/profiles/web/package.json` 的 `dependencies`（`file:../../../../plugins/ayla-app`）与 `dsh.profile.bundles`。

> **部署坑（已踩过）**：`file:` 依赖会在 `node_modules/@elysia/ayla-app` 留一份副本，只改源码不重装不生效。部署后必须逐文件比对 SHA-256。

## 10. D-9 验收与文档回填

1. 定向测试（两侧）：`pnpm exec vitest run --config dsh/vitest.elysia.config.ts ../plugins/ayla-app/tests`；`python -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql`。
2. 类型检查：`tsc --noEmit` 零 diagnostics。
3. 真实链路（受控）：Ayla 发文字 → DSH 收 → 回复 → Ayla 显示；图片一次；断线恢复一次。
4. 回填 `docs/architecture.md` §3/§4/§5/§9 与本文 §7 帧定义。
5. 写 `plugins/ayla-app/README.zh.md`（安装、设置项、两形态、排障）。

## 11. 风险与执行注意

| 风险 | 规避 |
|---|---|
| 删除旧代码时误删仍有消费者的模块 | 删前 grep 全仓；删除后立即 `manage.py check` |
| `seq` 并发取号重复 | 事务内 `SELECT FOR UPDATE`；唯一索引兜底 |
| DSH 侧把 `ws` 当依赖引入 | 代码评审 + `package.json` 依赖断言 |
| 两形态下 `send_text` 重复注册 | 判定后只装一条路径；单测断言全局工具表 |
| 插件副本未更新导致「改了没生效」 | 部署后 SHA-256 比对，不只看进程重启 |
| 共享工作区有他人改动 | 提交前 `git status` 区分，只暂存本任务文件 |

## 12. 不做

需求 §11 列的本期不做项，本文件不给实现步骤。语音与直播的旧对接按 §13 删除，不写兼容层。
