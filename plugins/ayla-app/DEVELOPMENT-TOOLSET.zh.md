# Ayla-use 工具集 · 实施步骤

> 需求与验收口径见 [TOOLSET.zh.md](./TOOLSET.zh.md)，接口契约见 [AYLA-API.zh.md](./AYLA-API.zh.md)。
> 本文只写**怎么落地**：每一步改哪个文件、改到什么程度、用什么命令验证。
> 基线（2026-11-18 本地）：Elysia-Harness 工作树 + `Ayla/backend`。
>
> **先读 §0**。有两步需要你点头才能动（S1 改后端、S12 更名），其余可连续推进。

## 0. 开工前

### 0.1 三条不能违反的纪律

1. **每步之后立刻验证，不要攒到最后。** 后端每改一处就跑一次 `manage.py check`；
   插件每加一类工具就跑一次 `tsc --noEmit`。D-1 的教训就是「删完一起验」导致后端起不来。
2. **共享工作区**：`git status` 先看有没有别人的未提交改动。只动本任务文件。
3. **不改语义**：S1 只改「同一条消息怎么打包成帧」，不碰任何 `can_*` 权限函数、
   不改任何 REST 端点行为。

### 0.2 先确认的事实（已核对，写在这里防走偏）

| 事实 | 位置 |
|---|---|
| 入站只认 `{text, image}` | `apps/elysia_bridge/services.py:154` |
| `poke` / `system` 直接不入队 | `services.py` `enqueue_for_delivery` 开头 |
| 入站图片走「sign → 下载 → 准入」 | `plugins/ayla-app/src/inbound.ts` |
| 工具注册是 `agent.ctx.tools.register` | `plugins/ayla-app/src/form-standalone.ts:74`（现成范例） |
| 插件已自带登录/刷新 | `src/auth.ts` `AylaAuth`（直接复用） |

### 0.3 本期范围（一句话）

20 个工具 / 8 类；**收全 10 类消息**（要改后端）；**不发媒体**（无上传）；
直播只做标记层与弹幕；通知先做查询。

## 1. S1 · 后端入站扩展（需你点头）

> 这一步是本任务唯一改动 Ayla 的地方。不改它，「所有消息类型都能收到」无法成立。

### 1.1 改 `build_inbound_parts`

`Ayla/backend/apps/elysia_bridge/services.py`

现行逻辑只产出 `text` / `image` 两种 part，其余塞一个裸 `{"type": seg_type}` 让
`unsupported_parts()` 判整条不可投递。改成**每种消息都产出可描述自己的 part**：

| 消息类型 | 新 part 形状 |
|---|---|
| text | `{type:"text", text}`（不变） |
| image | `{type:"image", media_id, media_type}`（补 `media_type`，省一次嗅探） |
| emoji | `{type:"emoji", media_id, media_type, tag?}` |
| voice | `{type:"voice", media_id, duration, mime_type}` |
| file | `{type:"file", media_id, name, size, mime_type}` |
| video | `{type:"video", media_id, duration, thumbnail?, mime_type}` |
| mixed | `{type:"mixed", segments:[…]}`，各段沿用上面的形状 |
| share | `{type:"share", share_type, target_id, title, subtitle?, cover?}` |
| poke | `{type:"poke", target_id, target_name?}` |
| system | `{type:"system", text}` |

**关键**：`share` **不要**把目标内容（帖子正文之类）展开进去。需求 §1.4 C-4 明确
「可以而非必须看」，塞正文就是替她看了。只给 `target_id` + 标题，让她自己决定要不要
调 `ayla_posts(get)`。

### 1.2 改 `SUPPORTED_PART_TYPES` 与 `_undeliverable_reason`

`SUPPORTED_PART_TYPES` 扩到全部 10 种。`_undeliverable_reason` 里**保留**两条真限制：

- 文本超 32 KiB → 仍标 `failed`（协议上限，不放宽）；
- 未知段类型（未来新增但 DSH 不认识的）→ 仍整条 `failed`，不要静默丢段。

### 1.3 让 `poke` / `system` 入队

`enqueue_for_delivery` 开头现在有：

```python
if message.type in ("poke", "system"):
    return None
```

删掉这一条。注意时代价：poke 会出现在她的入站流里，且不需要未读/已读回执
（现有未读口径本来就排除 poke，不用改）。

### 1.4 验收

```powershell
cd Ayla/backend
python manage.py check
python -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql
```

补测试：10 种类型各一条消息，断言 `build_inbound_parts` 产出预期 part、
`_undeliverable_reason` 返回空串、outbox 行为 `pending`。

### 1.5 陷阱

| 陷阱 | 说明 |
|---|---|
| `db_constraint=False` 的历史 | `AylaInboundOutbox.message` 是 OneToOne 但没 DB 约束，别顺手加 |
| 32 KiB 判定按**字节** | `_text_bytes` 已按 UTF-8 算，别改成 `len(str)` |
| mixed 的 `content` 是冗余拼接 | 只用于搜索/预览，别拿它当唯一来源 |
| 别动 `mark_acked` / `pending_after` | 补投语义与本次无关，动它容易破坏断线重连 |

## 2. S2 · 插件骨架

> 目标：能挂载、能登录、能注册工具，但工具还是空的。

### 2.1 新增 `src/api.ts`

一个薄封装，只做三件事：拼 URL、带 Bearer、把错误翻成人话。

```ts
export class AylaApiError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly path: string) {}
}
export interface AylaApi {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  del<T>(path: string): Promise<T>
}
```

错误映射（对齐需求 §5.2）：
`401/403 → 没有权限：<detail>`、`404 → 不存在：…`、`400 → 参数被拒：…`、
`409 → 冲突：…`、`410 → 已过期：…`、`413 → 文件超过上限`、`503 → 服务不可用：…`。

**不要**在这里重试写操作。

### 2.2 新增 `src/address.ts`

只做**校验**，不做名字解析：

```ts
export function assertUserId(v: string): string      // 32 位 hex 或 UUID 形态
export function assertPositiveInt(v: string | number, label: string): string
export function assertConversation(v: string): { kind: 'group' | 'private'; id: string }
```

`assertConversation` 的规则（需求 §4.3）：

- `ayla:group:42` / `ayla:private:17` → 直接用；
- 裸数字 → **默认按 group 解析**，但若该 id 同时是私聊（需要一次查询才知道），
  返回错误要求带前缀。**本期简化**：裸数字一律当 group，错误文案里说明"私聊请用
  `ayla:private:N`"。这条要写进工具描述。

拒绝时的文案必须带下一步：
`user_id 需要唯一 id，收到的是「小希」。先调用 ayla_search_users(q=…)。`

### 2.3 新增 `src/tools/register.ts`

```ts
export const DEFAULT_TOOL_SESSIONS = [
  'elysia-conscious-mind',
  'elysia-livestream',
  'elysia-voice-call',
  'ayla-channel',
] as const

export function registerAylaTools(ctx: Context, api: AylaApi, opts: {
  sessions: readonly string[]
  form: AylaForm
  logger: Logger
}): void
```

实现要点：

1. `ctx.on('agent/created', ({ agent }) => …)`，`agent.id` 命中 `sessions` 才注册；
2. 挂载时遍历 `ctx.agents.list()`（若存在）对已存在的命中 agent 补注册；
3. standalone 形态下白名单含 `ayla-channel`（它也会触发 `agent/created`，无需另写）；
4. 全部用 `ctx.effect(() => register(...), 'label')` 包住，卸载时自动清理。

**判据**：注册后 `elysia-subconscious-router` 里 `tools.list()` 不含任何 `ayla_*`。

### 2.4 配置

`src/settings.ts` 增两个字段（都是 `.volatile()`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolSessions` | `[]` | 空 = 用 `DEFAULT_TOOL_SESSIONS`；非空 = 覆盖（别人的自定义 id） |
| `enableTools` | `true` | 关掉后不注册工具，只保留通道（迁移期的保险） |

`allowedDestructive` **不加**：需求已定「全开，不做二次确认」，加个开关只会多一条
没人用的分支。

### 2.5 验收

```powershell
cd Elysia-Harness
dsh/node_modules/.bin/tsc --noEmit -p plugins/ayla-app/tsconfig.json --typeRoots ./dsh/node_modules/@types
cd dsh; node_modules/.bin/vitest run --config vitest.elysia.config.ts ../plugins/ayla-app/tests
```

新增测试：注册器对四个 id 各注册一次、对第五个 id 零注册、未配置凭据时零注册。

## 3. S3 · R1 身份与资料（2 个工具）

`src/tools/profile.ts`

| 工具 | 端点 | 要点 |
|---|---|---|
| `ayla_me` | `GET me/` + `GET me/badges/` | `with_badges` 缺省 false；badges 可并入可选字段 |
| `ayla_update_profile` | `PATCH me/profile/` | 只接受 `nickname/signature/status/show_content`；**不接受 `avatar`** |

**陷阱**：`PATCH` 是部分更新，只传提供的字段。`status` 必须是
`auto|away|dnd|invisible` 之一，传别的后端 400。

**验收**：改昵称后 `ayla_me` 读回一致；传 `avatar` 被本地拒绝并提示「本期不支持换头像」。

## 4. S4 · R2 人与好友（3 个）

`src/tools/social.ts`

| 工具 | 端点 |
|---|---|
| `ayla_search_users` | `GET users/search/?q=`（无 q 返回空，别当失败） |
| `ayla_get_user` | `GET users/<id>/`（带 `relation`） |
| `ayla_friends` | `GET friends/`、`POST friends/requests/`、`POST friends/requests/<id>/action/`、`DELETE friends/<id>/` |

**要点**：

- `request` 成功后返回要带 `next: "等待对方同意；同意前发不了私聊"`（需求 §1.3 C-2）；
- `handle` 的 `accept: boolean` 映射成 `accept/reject`；
- 特殊账号差异（爱莉 vs standalone bot）**不进工具逻辑**，只进描述文案——
  后端会给出 400/403，工具如实翻译即可。

**验收**：重复 request 幂等返回 200；给自己加好友被本地拒绝。

## 5. S5 · R3 会话与群（4 个）

`src/tools/chat.ts`

| 工具 | 端点 | 注意 |
|---|---|---|
| `ayla_conversations` | `conversations/`、`conversations/<id>/`、`conversations/private/`、`pin/`、`hide/`、`read/` | 裸数组 vs 分页两种形状 |
| `ayla_create_group` | `conversations/group/` | `member_ids` 最多 200，自动排除自己 |
| `ayla_group` | members 增删、mute、role、transfer、leave、dissolve、subgroups | 权限错误必须原样翻译 |
| `ayla_group_access` | join-requests、invites、action | 审批与邀请分开 |

**三个必须处理的坑**：

1. `GET conversations/<id>/members/` **强制分页**：不带 `pagination=cursor&limit=` 直接 400。
2. `GET chat/me/join-requests/` 同样强制分页。
3. `open_private` **不校验好友关系**：返回 Success 但发消息才 403。所以它的返回必须带
   `note: "会话已建立；若对方不是好友，发消息会被拒（先 ayla_friends(request)）"`。

**验收**：建群后 `ayla_conversations(get)` 能看到 `my_role=owner` 与「默认组」子群。

## 6. S6 · R4 消息（4 个）

`src/tools/message.ts`

| 工具 | 端点 |
|---|---|
| `ayla_send` | `POST conversations/<id>/messages/`（kind ∈ text/share/poke） |
| `ayla_read_messages` | `GET conversations/<id>/messages/`（裸数组、seq 升序） |
| `ayla_recall_message` | `POST …/messages/<mid>/recall/` |
| `ayla_typing` | `POST …/typing/` |

### 6.1 `ayla_send` 的三种载荷

```ts
// text
{ type: 'text', content, idempotency_key, reply_to?, subgroup_id? }

// share —— 纯 REST，无媒体；payload 是重点
{ type: 'share', share_payload: {
    share_type: 'group'|'voice'|'live'|'post'|'boardgame'|'user',
    target_id, title, cover?, subtitle?, extra? },
  content: '' /* 服务端会补 [分享]标题 */ , idempotency_key }

// poke —— content 就是目标 user_id
{ type: 'poke', content: <target user_id>, idempotency_key }
```

**校验（本地先挡，不等后端）**：

- `share_payload.title` 必填非空；`cover` 如果给，**必须以 `/` 开头**（否则 400）；
- `poke` 的目标必须在本会话成员里（本地可用 `ayla_conversations(get)` 的结果校验，
  或直接让后端拒绝并翻译 `目标用户不在会话中`）。

### 6.2 幂等

每次调用生成 `idempotency_key = 'ayla-' + uuid`。**不要**让模型自己传——
模型传同一个 key 会触发 409「内容不一致」。

### 6.3 陷阱

| 陷阱 | 说明 |
|---|---|
| `limit` 上限 200、下限 1 | 超范围后端钳制，不报错 |
| 私聊发消息要先是好友 | 403「对方已不是你的好友」，翻译成"先加好友" |
| share/poke 不支持 `reply_to` | 后端 400，本地先拒 |
| 撤回 120s | 超时 400「超过撤回时限」，不要重试 |
| 子群禁言 | 群消息归默认组时也会受子群 muted 影响 |

**验收**：三种 kind 各一条，断言 body 形状与需求一致；同参数重复调用不产生第二条消息。

## 7. S7 · R5 帖子（1 个）

`src/tools/post.ts`

`ayla_posts` 覆盖：`list|get|create|update|delete|comment|comments|delete_comment|mark_viewed`。

要点：

- `title` 与 `body` 都必填（`title` 非空）；
- `images` **本期不传**（无上传），传了就本地拒绝并说明；
- `scope` ∈ `feed|mine|group:<id>`；
- 评论 `body` 必填（图片本期无）；
- `delete_comment` 只删自己的。

**这条工具直接支撑**「她能看别人帖子、能发评论、能收到回复」中的前两项；
「收到回复」在 S9 的通知里。

## 8. S8 · R6 直播（2 个）

`src/tools/live.ts`

| 工具 | 端点 |
|---|---|
| `ayla_live` | `live/channels/`、`<id>/`、`<id>:start/`、`<id>:stop/`、`<id>/status/`、`<id>/viewers/` |
| `ayla_danmaku` | `GET/POST live/channels/<id>/danmaku/` |

**硬要求（需求 §8.3）**：`start` 的返回**必须**带

```json
{ "status": "live", "streaming": false,
  "note": "已标记开播，但尚未推流，观众看到的是黑屏；可用 status 查真实在播" }
```

**其它约束**：同一 owner 只能一个 live（后开的报 400）；直播中禁止删除；
弹幕 ≤200 字；`viewers` 在 Redis 不可用时 503——**不能当成 0 人**。

## 9. S9 · R7 通知（1 个，新增）

`src/tools/notifications.ts`

`ayla_notifications` 聚合四处：

| kind | 端点 |
|---|---|
| `badges` | `GET me/badges/` |
| `friend_requests` | `GET friends/requests/?direction=received&status=pending`（**必须带分页**） |
| `group_invites` | `GET chat/me/invites/` |
| `join_requests` | `GET chat/me/join-requests/`（**必须带分页**） |
| `leave_notices` | `GET chat/leave-notices/` |

返回必须带 `next` 字段，指向下一步该用哪个工具（需求 §4.11）。
**不自动处理**——不 handle 就保持 pending，无副作用。

## 10. S10 · R8 元操作（3 个）

`src/tools/misc.ts`

| 工具 | 端点 | 注意 |
|---|---|---|
| `ayla_search` | `GET search/?q=&types=&limit=` | `types` 子集：user/group/post/live/voice/game |
| `ayla_favorites` | `favorites/`、`favorites/status/`、`<id>/` | `group` 不再是合法 target_type |
| `ayla_boardgame` | `boardgame/rooms/...` | `members` 端点强制分页 |

## 11. S11 · 形态与注册验证

两种形态各跑一遍：

| 形态 | 期望 |
|---|---|
| elyh | 三个 `elysia-*` session 各有 20 个 `ayla_*`；`elysia-subconscious-router` 零个 |
| standalone | 四个（含 `ayla-channel`）都有；且消息能被 `ayla-channel` 收到 |

**做法**：临时把 `toolSessions` 配成 `["fixture-session"]`，起一个测试 agent，
断言注册数量与名单。

## 12. S12 · 更名 Ayla-use（需你点头）

清单与顺序见 [TOOLSET.zh.md](./TOOLSET.zh.md) §11。要点重申：

1. `package.json` → `@elysia/ayla-use`；
2. `cordis.patch.yml` → `elysia-ayla-use`；
3. 源码 `@module` 注释；
4. 目录 `plugins/ayla-app` → `plugins/ayla-use`；
5. profile 的 `package.json`（依赖 + bundles）与 `cordis.patch.yml`；
6. 重装 `file:` 副本（`node_modules/@elysia/ayla-*`）。

**顺序**：1→2→3 提交后再 4→5→6 一起做。第 6 步之前重启 profile 会起不来。

## 13. 端到端验收

一条最小链路，全部走工具、不手改代码：

```text
1. ayla_me                      → 拿到自己的 id
2. ayla_search_users(q=…)       → 拿到对方 id
3. ayla_friends(request)        → 等待同意（她可以不管）
4. ayla_conversations(open_private, user_id) → 会话 id
5. ayla_send(text)              → 收到 messageId
6. ayla_send(poke)              → 对方看到被戳
7. ayla_send(share, post)       → 对方看到分享卡片
8. ayla_recall_message          → 120s 内撤回成功
9. ayla_create_group + ayla_group(add_members) → 群里出现成员
10. ayla_posts(create) + comment → 她的帖子下有评论
11. ayla_live(create→start)     → 返回 streaming:false
12. ayla_notifications          → 能看到第 3 步之外的待处理项
```

**反向验收**（同样重要）：

- 收到转发的帖子但**不调用** `ayla_posts(get)` → 会话里没有任何帖子正文（证明没替她看）；
- 收到消息后什么都不做 → 未读数不变（证明没有自动已读）；
- 用名字当 `user_id` → 被拒且文案给出下一步。

## 14. 命令速查

```powershell
# 后端
cd Ayla/backend
python manage.py check
python -m pytest apps/elysia_bridge -q --ds=config.settings_test_mysql

# 插件类型检查
cd Elysia-Harness
dsh/node_modules/.bin/tsc --noEmit -p plugins/ayla-app/tsconfig.json --typeRoots ./dsh/node_modules/@types

# 插件单测
cd Elysia-Harness/dsh
node_modules/.bin/vitest run --config vitest.elysia.config.ts ../plugins/ayla-app/tests

# 静态检查
cd Elysia-Harness
git diff --check
```

## 15. 步骤依赖图

```text
S1 后端入站 ──┐
              ├─► S11 形态验证 ─► S13 端到端
S2 骨架 ──────┤
  ├─ S3 身份  │
  ├─ S4 人    │
  ├─ S5 会话  │
  ├─ S6 消息  │
  ├─ S7 帖子  │
  ├─ S8 直播  │
  ├─ S9 通知  │
  └─ S10 元   ┘
S12 更名（独立，最后做）
```

S3~S10 之间**没有相互依赖**，可以并行或任意顺序；每个都只依赖 S2 的 `api`/`address`。
