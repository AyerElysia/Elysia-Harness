# Ayla 后端接口全量调研

> 调研基线（2026-11-18 本地）：`Ayla/backend`（Django 4 + DRF + Channels），
> 代码位置 `E:\Elysium-AyerElysia\Elysium\Ayla\backend`。
> 本文只描述**代码里真实存在的端点**，每条都标注了实现文件，便于回查。
> 与代码冲突时以代码为准，并回填本文。

## 0. 一句话

Ayla 是**纯 REST + JWT** 的应用后端：所有人能做的操作都有对应端点，爱莉用自己账号的
Bearer token 直接调即可 —— **不需要为工具集改 Ayla 后端一行代码**。
唯一的例外是实时链路（聊天推送、直播弹幕、语音房），它们走 WebSocket，而 REST 已经
覆盖了「动作本身」（发消息、发弹幕、进房），WS 只是广播投影。

## 1. 通用约定

### 1.1 基址与鉴权

| 项 | 值 |
|---|---|
| 基址 | `http://<host>:8100/api/v1/`（本机部署 daphne 绑 127.0.0.1:8100） |
| 鉴权 | `Authorization: Bearer <access>`（SimpleJWT） |
| 登录 | `POST auth/login/` `{username,password}` → `{access, refresh}` |
| 刷新 | `POST auth/refresh/` `{refresh}` → `{access, refresh}`；`ROTATE_REFRESH_TOKENS=True`，**refresh 会变，必须落盘** |
| 令牌寿命 | access 短（分钟级），refresh 长；401/403 → 刷新一次并重放 |
| 媒体直链 | 预签名 GET URL，`POST media/{id}:sign` 签发，600s 有效 |

### 1.2 分页（三种，形状不同，读错会拿不到数据）

| 家族 | 触发条件 | 不触发时返回 | 触发时返回 |
|---|---|---|---|
| social（会话/成员/好友/申请/邀请/通知） | `pagination=cursor` | **裸数组** | `{results,total,has_more,next_cursor}` |
| catalog（直播/语音/桌游/收藏/表情包） | 带 `limit` 或 `cursor` | **裸数组** | `{results,next_cursor,has_more,total}` |
| media（表情项/弹幕/语音房成员/语音房聊天） | 带 `pagination`/`cursor`/`before_id`（成员端点强制） | 裸数组 | `{results,next_cursor,has_more,total}` |

- `limit` 一律 `1..100`（social/catalog/media 同）；超过 3 位或非十进制 → 400。
- cursor 是**签名串**，绑定「用户 + 资源 + 查询条件」；换条件必须从头取。
- 少数端点**强制**分页：`chat/me/join-requests/`、`chat/subscriptions/`、
  `boardgame/rooms/<id>/members/`、`voice/channels/<id>/members/` —— 不带参数直接 400。
- 消息历史 `chat/conversations/<id>/messages/` 是**裸数组**，用 `before_seq` 翻页，不走 cursor。

### 1.3 幂等

| 位置 | 幂等键 | 重复调用 |
|---|---|---|
| 发消息 | `idempotency_key`（≤64，全局唯一） | 同 key 同内容 → 200 + 原消息；同 key 内容不同 → 409 |
| 媒体 complete | `upload_id` | 返回同一 `media_id`，不重复建对象 |
| 好友申请 | (from,to,pending) | 复用既有 pending，200 |
| 入群申请/邀请 | (conv,applicant/invitee,pending) | 复用，200 |
| 收藏 | (user,target_type,target_id) 唯一 | 200 + 原记录 |
| 桌游 join / 语音 join / 群成员 add | DB unique | 幂等返回 |
| 撤回 | 已撤回直接返回 | 幂等 |

### 1.4 权限语义（全部在视图/服务层判定，工具层要如实转述）

| 判据 | 含义 |
|---|---|
| `user_can_access(user, conv)` | 是会话成员 |
| `can_manage_group(user, conv)` | 群主或管理员（改群资料/加踢人/禁言/审批/子群） |
| `user_role_in(user, conv) == 'owner'` | 仅群主（设管理员/转让/解散/改群表情上传开关） |
| `owner_id == user.id` | 内容 owner（直播频道、语音房、桌游房、帖子） |
| `visible_queryset / can_view / can_join` | 可见性 public / friends / group（`allowed_groups` 白名单） |
| 私聊发消息 | 双方仍是好友，**或任一方是爱莉**（`can_send_private_message` 对爱莉放行）。非爱莉账号**必须先成为好友**，否则 403「对方已不是你的好友」 |
| 禁言 | `ConversationMember.muted` → 403「你已被禁言」 |
| 子群禁言 | 子群 `muted=True` 时仅群主/管理员可发言 |
| 撤回时限 | `MESSAGE_RECALL_SECONDS`（默认 120s），超时 400 |

### 1.5 错误形状

DRF 默认：`{"detail": "..."}` 或字段错误 `{"field": ["..."]}` / `{"field": "..."}`。
少数端点返回业务码字符串作为 detail（如 `media_not_found`、`media_type_mismatch`、
`media_expired`、`group_pack_not_found`、`payload_too_large`）。

### 1.6 身份标识：每种资源的唯一 id 从哪来

按「一律用 id 寻址」的要求，先钉死每类资源的主键形态与**获取入口**：

| 资源 | id 形态 | 从哪拿到 |
|---|---|---|
| 用户 | 32 位 uuid hex（`User.id`） | 入站消息的 `sender_id`；会话详情的 `members[].user.id`；`users/search`；`friends/` |
| 会话 | 正整数（`Conversation.id`） | 入站消息的 `conversation_id` / DSH 侧 `ayla:private:17`；`conversations/` |
| 消息 | 正整数（`Message.id`）+ 会话内 `seq` | 入站帧 `message.id`；`messages/` 历史；`reply_to` 用 id，翻页用 seq |
| 群聊子群 | 正整数 | `conversations/<id>/subgroups/` |
| 直播频道 | 正整数 | `live/channels/`；`User.live_room_id` |
| 语音房 | 正整数 | `voice/channels/`；`User.voice_room_id` |
| 帖子 / 评论 | 正整数 | `posts/`、`posts/<id>/comments/` |
| 桌游房 | 正整数 | `boardgame/rooms/` |
| 媒体 | 32 位 uuid hex（`media_id`） | 上传 `:complete` 返回；消息/帖子里的 `media.media_id` |
| 表情包 / 表情项 | 整数（序列化成字符串） | `emoji/packs/`、`pack/items/` |
| 收藏 | 正整数 | `favorites/` |
| 好友申请 / 入群申请 / 邀请 | 正整数 | 对应列表接口 |

**推论**：
- 入站事件天然带着 `sender_id` 与 `conversation_id`，回复时**照抄**即可，不需要按名字猜。
- 需要「从名字到 id」的场合只有一个：她主动想找某个还没与她产生对话的人 → 先
  `users/search` 拿到 id，再动别的。**搜索是显式动作，不是工具内部的隐式兜底**。
- 同名/同昵称是常态（`nickname` 只要求 ≤64 字、不唯一），按名字匹配会把人认错。

## 2. 接口清单

### 2.1 accounts —— 账号、资料、好友（`/api/v1/`）

| 方法 | 路径 | 入参 | 出参 | 权限 | 实现 |
|---|---|---|---|---|---|
| GET | `health/` | — | `{status,...}` | 公开 | accounts/health.py |
| GET | `health/live/` | — | 同上 | 公开 | accounts/health.py |
| POST | `auth/register/` | `{username,email,password,nickname?,code}` | `{user,access,refresh}` 201 | 公开（需邮箱验证码） | views.RegisterView |
| POST | `auth/send-email-code/` | `{email}` | `{detail,code}` | 公开（限流） | views.SendEmailCodeView |
| POST | `auth/login/` | `{username,password}` | `{access,refresh}` | 公开 | SimpleJWT |
| POST | `auth/refresh/` | `{refresh}` | `{access,refresh}` | 公开 | SimpleJWT |
| POST | `auth/change-password/` | `{code,new_password}` | `{detail}` | 登录（邮箱验证码） | views.ChangePasswordView |
| POST | `auth/change-email/` | `{new_email,new_code,current_code?}` | `{detail,email}` | 登录（双验证码） | views.ChangeEmailView |
| GET | `me/` | — | UserPublic + `email` | 登录 | views.MeView |
| GET | `me/profile/` | — | UserPublic | 登录 | views.ProfileView |
| PATCH | `me/profile/` | `{nickname?,avatar?,signature?,status?,show_content?}` | UserPublic | 登录 | views.ProfileView |
| GET | `me/badges/` | — | `{private_unread,group_unread,mention_unread,friend_requests,group_invites,join_requests_pending}` | 登录 | views.BadgesView |
| GET | `users/search/?q=` | `q` | UserPublic[]（无 q → 空） | 登录 | views.UserSearchView |
| GET | `users/<user_id>/` | — | UserPublic + `relation` | 登录 | views.UserDetailView |
| GET | `friends/` | 分页可选 | Friendship[] | 登录 | views.FriendListView |
| GET | `friends/requests/` | `direction,status` 分页可选 | FriendRequest[] | 登录 | views.FriendRequestListView |
| POST | `friends/requests/` | `{to_user_id,message?}` | FriendRequest 201/200 | 登录（不能加自己/已是好友） | 同上 |
| POST | `friends/requests/<id>/action/` | `{action: accept\|reject}` | `{detail,status}` | 收件人本人 | views.FriendRequestActionView |
| DELETE | `friends/<user_id>/` | — | 204 | 登录（双向删除） | views.FriendDeleteView |

**UserPublic 字段**：`id, username, nickname, avatar, signature, status, online,
display_status, date_joined, is_in_voice, voice_room_id, is_live, live_room_id, show_content`。

**`status` 取值**：`auto`（跟随在线）/ `away` / `dnd` / `invisible`。
**`avatar` 契约**：必须是站内媒体 content URL `/api/v1/media/<media_id>/content`，
媒体 kind=image、原图未过期、调用者有访问权；空串 = 清除头像。

### 2.2 chat —— 会话、消息、群管理（`/api/v1/chat/`）

#### 会话

| 方法 | 路径 | 入参 | 说明 |
|---|---|---|---|
| GET | `conversations/` | `type=all\|group\|private`、`q`、分页 | 裸数组为 ConversationList（带 `peer`）；分页为 Directory |
| GET | `subscriptions/` | **必须** `pagination=cursor` | `[{id,last_message_seq}]` |
| POST | `group-presence/` | `{conversation_ids:[1..100]}` | `{presences:{id:{live,voice,game}|null}}` |
| GET | `me/join-requests/` | **必须**分页 | 我管理的群待审批申请 |
| POST | `conversations/private/` | `{user_id}` | 开/取私聊会话（幂等） |
| POST | `conversations/group/` | `{title,member_ids[],announcement?}` | 建群（owner=我），自动建「默认组」子群，201 |
| GET | `conversations/<id>/` | `metadata=1\|directory` | 详情（成员/我的角色/未读） |
| PATCH | `conversations/<id>/` | `{title?,announcement?,join_policy?,avatar?}` | 群主/管理员 |
| GET | `conversations/<id>/public-summary/` | — | 无需入群：`{id,title,announcement,join_policy,avatar,member_count}` |
| POST | `conversations/<id>/pin/` | `{pinned}` | 本人视图置顶 |
| POST | `conversations/<id>/hide/` | — | 本人视图隐藏（软删，不删消息） |
| GET | `conversations/highlights/?ids=1,2` | `ids` | 批量群动态封面 |
| GET | `conversations/<id>/highlights/` | — | 单群动态 |

#### 子群（群内频道）

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `conversations/<id>/subgroups/` | 分页可选 | 群成员 |
| POST | `conversations/<id>/subgroups/` | `{name}` | 群主/管理员 |
| GET | `conversations/<id>/subgroups/<sid>/` | — | 群成员 |
| PATCH | `conversations/<id>/subgroups/<sid>/` | `{name?,muted?}` | 群主/管理员 |
| DELETE | `conversations/<id>/subgroups/<sid>/` | — | 群主/管理员；默认组不可删 |
| POST | `conversations/<id>/subgroups/<sid>/read/` | — | 本人 |

#### 消息

| 方法 | 路径 | 入参 | 说明 |
|---|---|---|---|
| GET | `conversations/<id>/messages/` | `before_seq`、`limit(1..200)`、`subgroup_id` | 裸数组、按 seq 升序；`subgroup_id` 缺省=全部 |
| POST | `conversations/<id>/messages/` | 见 §3 | 201 落库 + 广播；幂等重放 200 |
| POST | `conversations/<id>/read/` | `{through_seq?,exclude_message_ids?,preserve_special?}` | 整会话已读 |
| POST | `conversations/<id>/messages/<mid>/read/` | `{exact?}` | 精确已读 |
| POST | `conversations/<id>/messages/<mid>/recall/` | — | 仅发送者、120s 内 |
| POST | `conversations/<id>/typing/` | `{is_typing}` | 触发 typing 广播 |
| GET | `leave-notices/` | 分页可选 | 未读退群通知 |
| POST | `leave-notices/<id>/read/` | — | 标记已读 |

#### 群管理

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `conversations/<id>/members/` | **必须**分页；`q`、`exclude_self` | 成员 |
| POST | `conversations/<id>/members/` | `{user_ids:[]}` | 群主/管理员 |
| DELETE | `conversations/<id>/members/<user_id>/` | — | 群主/管理员；不能踢自己/越级 |
| POST | `conversations/<id>/members/<user_id>/mute/` | `{muted}` | 群主/管理员；不能禁言自己 |
| PATCH | `conversations/<id>/members/<user_id>/role/` | `{role: member\|admin}` | **仅群主** |
| POST | `conversations/<id>/transfer-owner/` | `{user_id}` | 群主 |
| POST | `conversations/<id>/leave/` | — | 成员（群主需先转让） |
| DELETE | `conversations/<id>/dissolve/` | — | 群主 |

#### 申请与邀请

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `conversations/<id>/join-requests/` | 分页可选 | 群主/管理员 |
| POST | `conversations/<id>/join-requests/` | `{message?}` | 任何登录用户；公开群直接入群（`{status:"accepted"}`），申请制建申请 |
| POST | `join-requests/<id>/action/` | `{action: accept\|reject}` | 群主/管理员 |
| POST | `conversations/<id>/invites/` | `{invitee_id}` | 群成员（可邀请任意登录用户） |
| GET | `me/invites/` | 分页可选 | 本人收到的待处理邀请 |
| POST | `invites/<id>/action/` | `{action}` | 仅被邀请人 |

### 2.3 emoji —— 表情包（`/api/v1/emoji/`）

| 方法 | 路径 | 入参 | 说明 |
|---|---|---|---|
| GET | `packs/` | 分页可选 | 我的 + 系统包（含 items） |
| POST | `packs/` | `{name}` | 建个人包，201 |
| GET | `packs/<pack_id>/items/` | 分页 | 包内表情（owner 或系统包） |
| POST | `packs/<pack_id>/items/` | `{media_id,tag?}` | 收藏表情；media 必须 kind=emoji |
| DELETE | `packs/<pack_id>/items/<item_id>/` | — | 取消收藏，204 |
| POST | `packs/<pack_id>/set_system/` | `{is_system}` | 仅超管 |
| POST | `search/` | `{keyword}` | 按 tag/包名检索 |
| GET | `groups/<conv_id>/pack/` | `summary=1` | 群表情包；未建 → 404 |
| PATCH | `groups/<conv_id>/pack/` | `{allow_member_upload}` | **仅群主** |
| GET/POST | `groups/<conv_id>/pack/items/` | `{media_id,tag?}` | 群成员可见；上传需群主/管理员或开关放开 |
| DELETE | `groups/<conv_id>/pack/items/<item_id>/` | — | 群主/管理员 |

**EmojiPack**：`{id,owner_id,name,is_system,item_count,items[],created_at,allow_member_upload?}`
**EmojiItem**：`{id,media,<descriptor>,tag,created_at}`

**两种「表情包」在实现上是同一张表，但用法完全不同**（`emoji/services.py`）：

| 形态 | 建包 | 包内 media 的 kind | 发消息时怎么用 |
|---|---|---|---|
| **群里已有的表情包**（群表情包，`group` 非空） | 有群就有（`get_or_create_group_pack`） | **kind=emoji** | `type=emoji` + `media_id` |
| 系统包（`is_system=True`） | 运维建 | kind=emoji | `type=emoji` + `media_id` |
| 个人包（`owner` 非空） | `POST packs/` | **kind=emoji**（`add_item` 硬校验） | `type=emoji` + `media_id` |

要点：
- `add_item` 对**任何**包都强制 `media.kind == emoji`（`emoji/services.py:123`）；
  想把自己的一张图收进「个人包」，必须按 **kind=emoji** 重新上传一次。
- 但**发出去**不需要包：她自己的图按 **kind=image** 上传、以 `type=image` 发，就是
  「发了一张自己的表情图」。这条路径与包无关，也不受 5 MB 的 emoji 上限约束。
- 前端目前只有**群表情包**面板（`EmojiPackPanel` → `uploadMediaFile(file,"emoji")`），
  没有个人包 UI —— 印证「个人表情包 = 自己存的图」。

### 2.4 live —— 直播（`/api/v1/live/`）

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `channels/` | `only_live=1`、`scope=group:<id>`、`owner=`、`visibility=`、`friends=1`、`status=live\|idle\|ended\|offline`、分页 | 登录（可见性过滤） |
| POST | `channels/` | `{title,description?,cover?,group?,visibility?,allowed_group_ids?}` | 登录；201 回显 `stream_key`/`rtmp_url`（仅 owner） |
| GET | `channels/<id>/` | — | 可见即可 |
| PATCH | `channels/<id>/` | `{title?,description?,cover?,visibility?,allowed_group_ids?}` | owner |
| DELETE | `channels/<id>/` | — | owner；直播中 400，须先 `:stop` |
| POST | `channels/<id>:start/` | — | owner；同一 owner 只能一个 live |
| POST | `channels/<id>:stop/` | — | owner |
| GET | `channels/<id>/status/` | — | 可见即可；`{status:live\|idle\|degraded,source,optimistic}` |
| GET | `channels/<id>/viewers/` | — | 可见即可；`{count,has_more,viewers[]}`；Redis 不可用 → 503 |
| GET | `channels/<id>/danmaku/` | `limit`、分页 | 可见即可 |
| POST | `channels/<id>/danmaku/` | `{content(≤200),media_id?}` | `can_join`；201 |

**LiveChannel descriptor**：`id,title,description,cover,status,visibility,group,group_name,
allowed_group_ids,allowed_group_names,owner_id,owner_nickname,is_owner,stream_key,rtmp_url,
hls_url,flv_url,viewer_count,started_at,ended_at,created_at`。
`stream_key/rtmp_url` 对非 owner 恒为 null；`hls_url/flv_url` 全员可见。

**`:start` 只是乐观标记**：真实在播以 `/status/` 的 SRS 判定为准。
有画面需要推流端向 `rtmp_url` 推流（见 §6 缺口）。

### 2.5 voice —— 语音房（`/api/v1/voice/`）

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `channels/` | `scope=group:<id>`、`visibility`、`friends`、`occupied=1`、`owner=`、分页 | 登录（可见性过滤） |
| POST | `channels/` | `{name,group?,visibility?,allowed_group_ids?}` | 登录；201 |
| GET | `channels/<id>/` | — | 可见即可 |
| PATCH | `channels/<id>/` | `{name,visibility?,allowed_group_ids?}` | owner |
| DELETE | `channels/<id>/` | — | owner |
| POST | `channels/<id>/join/` | `{}` | `can_join`；落成员表 + 广播 + `media.livekit` |
| POST | `channels/<id>/media-token/` | `{}` | 续签；媒体未配置 → 503 |
| POST | `channels/<id>/leave/` | — | 成员 |
| POST | `channels/<id>/heartbeat/` | — | 成员（非成员 403） |
| GET | `channels/<id>/members/` | **必须**分页 | 可见即可 |
| POST | `channels/<id>/members/<user_id>/action/` | `{action: kick\|transfer}` | 房主 |
| GET | `channels/<id>/messages/` | `limit`、分页 | 可见即可 |
| POST | `channels/<id>/messages/` | `{content(≤2000),media_id?}` | **必须在房内** |

**join 响应**：`{channel_id, room_name, joined, media:{livekit:{url,token,ttl,expires_at,
room_name,identity}|null}}`。媒体面不可用时 `livekit=null`（进房仍成功）。

### 2.6 posts —— 帖子（`/api/v1/posts/`）

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `` | `scope=feed\|mine\|group:<id>`、`owner=`、`visibility=`、`friends=1`、`cursor`、`limit` | 登录（可见性过滤） |
| POST | `` | `{title,body,images[]≤9,group?,visibility?,allowed_group_ids?}` | 登录；201 |
| POST | `views/` | `{post_ids:[]}` | 登录；`{updated:{id:count}}` |
| GET | `<post_id>/` | — | 可见即可 |
| PATCH | `<post_id>/` | `{title?,body?,images?,visibility?,group?,allowed_group_ids?}` | **仅作者** |
| DELETE | `<post_id>/` | — | 仅作者 |
| GET | `<post_id>/comments/` | 分页 | 可见即可 |
| POST | `<post_id>/comments/` | `{body?,reply_to?,media_id?,images[]≤4}` | 可见即可；body 与图片至少一个 |
| DELETE | `comments/<comment_id>/` | — | 仅评论作者 |

**Post descriptor**：`id,author,author_id,title,body,visibility,group,group_name,
allowed_group_ids,allowed_group_names,images[],comment_count,is_author,view_count,
is_viewed,created_at,updated_at`。
`title` 必填且非空；`body` 必填；图片必须 image/video 且**原图未过期**。

### 2.7 media —— 媒体（`/api/v1/media/`）

| 方法 | 路径 | 入参 | 说明 |
|---|---|---|---|
| POST | `uploads` | `{kind,expected_size,mime_type}` | 201 `{upload_id,kind,max_bytes,expires_at,presigned_url}` |
| PUT | `uploads/<upload_id>` | 原始字节 | 也可直接 PUT 到 `presigned_url`（旁路应用服务器） |
| POST | `uploads/<upload_id>:complete` | — | 201 `{media_id,descriptor}`；幂等 |
| DELETE | `uploads/<upload_id>` | — | 取消上传，204 |
| GET | `<media_id>/` | — | descriptor |
| DELETE | `<media_id>` | — | 仅上传者 |
| POST | `<media_id>:sign` | `{variant?: original\|thumb\|waveform}` | `{url,expires_at}`；过期 → 410 |
| GET | `<media_id>/content` | — | 流式原对象（Range/ETag） |
| GET | `<media_id>/thumbnail` | — | 缩略图；无 → 404 |
| GET | `<media_id>/waveform` | — | 语音波形；无 → 404 |
| POST | `<media_id>:poster` | JPEG 字节 ≤2MB | 仅视频、仅上传者 |
| POST | `<media_id>:save` | — | **501 未实现**（爱莉媒体投影通道预留） |

**kind 与限制**（`media/services.py` `_max_bytes`）：

| kind | MIME 白名单 | 大小上限 |
|---|---|---|
| image | png/jpeg/jpg/pjpeg/gif/webp/avif/heic/heif/heix/bmp/tiff/ico/svg | 不设上限（配置 0） |
| emoji | 同 image | 5 MB |
| voice | wav/mpeg/mp4/ogg/m4a/webm/octet-stream | 不设上限 |
| video | mp4/webm/quicktime/x-m4v/x-matroska/3gpp/3gpp2 | 不设上限 |
| file | 除可执行文档（html/svg/js/xml）外任意 | 50 MB |

**魔数嗅探**：complete 时读头部 64 字节校验，声明 kind 与真实字节必须匹配
（`media_integrity_failed` 即此）。`expected_size` 必须与实际上传字节数**完全相等**。

### 2.8 favorites —— 收藏（`/api/v1/favorites/`）

| 方法 | 路径 | 入参 |
|---|---|---|
| GET | `` | `type=post\|message\|live\|voice\|game`、分页 |
| POST | `` | `{target_type,target_id}` → 201/200 |
| POST | `status/` | `{target_type,target_ids[]≤100}` → `{statuses:{id:favId\|null}}` |
| DELETE | `<favorite_id>/` | — |

群（`group`）已不支持收藏；存量记录列表显式排除。

### 2.9 boardgame —— 桌游（`/api/v1/boardgame/`）

| 方法 | 路径 | 入参 | 权限 |
|---|---|---|---|
| GET | `rooms/` | `scope=group:<id>`、`mine=1`、`owner=`、`visibility`、`status`、分页 | 登录 |
| POST | `rooms/` | `{name,group?,visibility?,game_type?,allowed_group_ids?}` | 登录 |
| GET | `rooms/<id>/` | — | 可见即可 |
| DELETE | `rooms/<id>/` | — | owner |
| POST | `rooms/<id>:join/` | — | `can_join`；幂等 |
| POST | `rooms/<id>:leave/` | — | 成员 |
| GET | `rooms/<id>/members/` | **必须**分页 | 可见即可 |
| POST | `rooms/<id>/members/<user_id>/action/` | `{action: kick\|transfer}` | owner |

### 2.10 search / releases / elysia_bridge

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `search/?q=&types=&limit=` | `types` ⊂ user,group,post,live,voice,game | `{users?,groups?,posts?,lives?,voices?,games?}` |
| GET | `updates/check/` | `platform,version,...` | 客户端更新清单 |
| GET | `elysia/profile/` | — | 爱莉 profile（单例） |
| POST/PATCH/PUT | `elysia/profile/` | `{user_id?,enabled?,display_name?}` | 超管 |
| POST | `elysia/profile/:test` | — | 超管；通道连通探测 |
| GET | `elysia/bridge/health/` | — | `{ok,profile,pending,active_connections}` |

### 2.11 WebSocket（工具集不直接用，但要知道）

| 路径 | 用途 |
|---|---|
| `/ws/elysia-bridge/?token=` | DSH ↔ Ayla 通道（现有插件已用） |
| `/ws/chat/?token=`（apps/chat） | 前端聊天推送：`message.new`、`typing`、`read`、`recall` 等 |
| `/ws/live/...`（apps/live） | 直播弹幕 + 在看人数 |
| `/ws/voice/...`（apps/voice） | 语音房状态/聊天/麦位 |

REST 已覆盖动作本身；WS 只做广播，工具集不需要订阅。

## 3. 发消息载荷契约（最复杂，工具集的核心）

`POST /api/v1/chat/conversations/<conv_id>/messages/`

| 字段 | 类型 | 规则 |
|---|---|---|
| `type` | enum | `text/image/voice/file/emoji/video/mixed/system/poke/share`，默认 text |
| `content` | string | ≤10000 字；text 必填；file 存文件名；poke 存目标 user_id；share 可空（自动填 `[分享]标题`） |
| `media_id` | string | 单媒体消息必填；kind 必须等于 type；必须 READY 且我有访问权 |
| `segments` | array | 与 `media_id` **互斥**；传了就强制 `type=mixed`，且**至少一个非文本段** |
| `share_payload` | object | 仅 `type=share`；`{share_type,target_id,title,cover?,subtitle?,extra?}` |
| `reply_to` | int | 本会话内消息 id；share/poke 不支持 |
| `subgroup_id` | int | 仅群聊；不传归默认组 |
| `idempotency_key` | string | ≤64；不传服务端生成 |

**segments 段类型**：
- `{type:"text",text}` —— 非空
- `{type:"image"|"video",media_id}` —— 必须存在、READY、kind 匹配、有访问权
- `{type:"mention",user_id}` —— 必须是本会话成员

**由此得出的关键结论**：
- **「发个人表情包」不是 `type=emoji`，而是普通图片消息 `type=image`**：她自己存的图
  （本地文件 / 已上传的 image 媒体）直接当图片发出去即可，媒体 kind=image。
- **`type=emoji` 只属于「包里的表情」**（系统包 / 群表情包）：这些 media 的 kind=emoji，
  与 image 是两套媒体（同一张图以 image 传过再以 emoji 传会得到两个 media_id，见 §4 去重规则）。
- **@ 某人必须走 segments**（`type=mixed` + mention 段）；纯文本不能 @。
- **图文混排**（文字 + 图片）= `segments:[{type:"text"},{type:"image"}]`。
- 分享卡片（群/直播/语音房/帖子/桌游/用户）= `type=share` + `share_payload`。

## 4. 媒体三步上传（换头像、发表情、发图、发帖配图的前置）

```text
1. POST /media/uploads {kind, expected_size, mime_type}
   → {upload_id, max_bytes, expires_at, presigned_url}
2. PUT  <presigned_url>  (Content-Type: <mime>)   或 PUT /media/uploads/<upload_id>
3. POST /media/uploads/<upload_id>:complete
   → {media_id, descriptor}
```

- `expected_size` 必须与真实字节数**完全一致**，否则 `media_size_mismatch`。
- 会话 TTL 默认 600s；过期 → 410。
- 完成后按 `content_hash + kind` 去重：同图先以 image 传过、再以 emoji 传会得到
  **不同 media_id**（kind 不同不复用）——这是刻意设计，否则表情包会拿到 kind=image 的媒体。
- 头像/封面/帖子配图要求**原图未过期**（`original_expired_at`/`expired_at` 均空）。

## 5. 能力矩阵：人类操作 → 端点

| 人类操作 | 端点 | 前置 |
|---|---|---|
| 改昵称/签名/状态/展示开关 | `PATCH me/profile/` | — |
| 换头像 | 三步上传(kind=image) → `PATCH me/profile/ {avatar:"/api/v1/media/<id>/content"}` | 媒体 READY、原图未过期 |
| 搜人 | `GET users/search/?q=` | — |
| 加好友 | `POST friends/requests/ {to_user_id}` | 非自己、非好友 |
| 同意/拒绝好友 | `POST friends/requests/<id>/action/` | 收件人 |
| 删好友 | `DELETE friends/<user_id>/` | — |
| 看会话列表 | `GET conversations/` | — |
| 开私聊 | `POST conversations/private/ {user_id}` | — |
| 建群 | `POST conversations/group/ {title,member_ids}` | — |
| 拉人进群 | `POST conversations/<id>/members/ {user_ids}` | 群主/管理员 |
| 邀请进群 | `POST conversations/<id>/invites/ {invitee_id}` | 群成员 |
| 处理邀请 | `POST invites/<id>/action/` | 被邀请人 |
| 申请入群 | `POST conversations/<id>/join-requests/` | 非成员 |
| 审批入群 | `POST join-requests/<id>/action/` | 群主/管理员 |
| 踢人 | `DELETE conversations/<id>/members/<uid>/` | 群主/管理员 |
| 禁言 | `POST .../members/<uid>/mute/ {muted}` | 群主/管理员 |
| 设/撤管理员 | `PATCH .../members/<uid>/role/ {role}` | 仅群主 |
| 转让群主 | `POST .../transfer-owner/ {user_id}` | 群主 |
| 退群 | `POST .../leave/` | 成员 |
| 解散群 | `DELETE .../dissolve/` | 群主 |
| 改群名/公告/头像/加入方式 | `PATCH conversations/<id>/` | 群主/管理员 |
| 建/改/删子群 | `.../subgroups/` | 群主/管理员 |
| 发文字 | `POST .../messages/ {type:text,content}` | 成员、未禁言 |
| 发图片/语音/文件/视频 | 三步上传 → `POST .../messages/ {type:<kind>,media_id}` | kind 匹配 |
| **发个人表情包（自己的图）** | 三步上传(kind=image) → `{type:image,media_id}` | 就是图片消息 |
| **发包里的表情（群/系统）** | `{type:emoji,media_id}` | media kind=emoji |
| 图文混排 | `{segments:[text,image...]}` | — |
| @ 某人 | `{segments:[{type:mention,user_id},...]}` | 目标在群内 |
| 分享卡片 | `{type:share,share_payload}` | — |
| 戳一戳 | `{type:poke,content:<uid>}` | 目标在会话内 |
| 撤回 | `POST .../messages/<mid>/recall/` | 发送者、120s |
| 已读 | `POST .../read/` | 成员 |
| 置顶/隐藏会话 | `POST .../pin/ · .../hide/` | 成员 |
| 建个人表情包 | `POST emoji/packs/ {name}` | — |
| 收藏表情 | `POST emoji/packs/<id>/items/ {media_id}` | media kind=emoji |
| 群表情包上传 | `POST emoji/groups/<conv>/pack/items/` | 群主/管理员或开关 |
| 建直播间 | `POST live/channels/ {title,...}` | — |
| 开播/下播 | `POST live/channels/<id>:start\|:stop/` | owner |
| 改直播间资料 | `PATCH live/channels/<id>/` | owner |
| 发弹幕 | `POST live/channels/<id>/danmaku/` | 可见 |
| 看真实在播状态 | `GET live/channels/<id>/status/` | 可见 |
| 看观众 | `GET live/channels/<id>/viewers/` | 可见 |
| 建语音房 | `POST voice/channels/ {name}` | — |
| 进房 | `POST voice/channels/<id>/join/` | 可见 |
| 退房 | `POST voice/channels/<id>/leave/` | 成员 |
| 房内心跳 | `POST voice/channels/<id>/heartbeat/` | 成员 |
| 房内文字 | `POST voice/channels/<id>/messages/` | **在房内** |
| 踢人/转让房主 | `POST voice/channels/<id>/members/<uid>/action/` | 房主 |
| 发帖 | `POST posts/ {title,body,images}` | — |
| 编辑/删帖 | `PATCH/DELETE posts/<id>/` | 作者 |
| 评论/删评论 | `POST posts/<id>/comments/` · `DELETE posts/comments/<cid>/` | 作者 |
| 标记浏览 | `POST posts/views/ {post_ids}` | — |
| 收藏/取消 | `POST favorites/` · `DELETE favorites/<id>/` | — |
| 建桌游房/进出/踢人/转让 | `boardgame/rooms/...` | — |
| 全局搜索 | `GET search/?q=&types=` | — |

## 6. 缺口：REST 覆盖不到的三件事（本期暂缓其中两件）

这三件事**不是接口缺失，而是能力边界**。工具集必须如实告诉模型「我做到了哪一步」。
**结论已定：真开播与真通话暂缓**（2026-11-18），本期只做 API 能真实做到的。

### 6.1 直播「有画面」需要推流端 —— **暂缓**

- `:start` 只把 `status` 标成 `live` 并写 `started_at`；`/status/` 用 SRS 查询真实在播。
- 真正出画面要有人向 `rtmp://<host>:1935/live/<stream_key>` 推流（OBS / ffmpeg）。
- `stream_key` 只对 owner 可见 —— 爱莉能拿到，但需要一个推流进程与素材源。
- **本期口径**：能建频道、能 `:start`、能发弹幕、能看观众；**但直播间是黑的**，
  `status` 会查到 `idle`。工具返回必须明说「尚未推流」。

### 6.2 语音房「说话」需要 LiveKit 客户端 —— **暂缓**

- `join` 落成员表 + 广播 + 下发 `media.livekit.token`，但**音频不经过 REST**。
- 真正发声要 LiveKit WebRTC 客户端发布音轨（`livekit-client` / `livekit-server-sdk`）。
- **本期口径**：能进房、房内发文字、心跳保活、看成员；**但没人能听见她**。
  工具返回必须明说「仅在场，不能出声」。

### 6.3 收消息依赖 WS

- 入站消息由 `/ws/elysia-bridge/` 推给 DSH（现有插件已实现）。
- REST 侧只有「拉历史」（`messages/?before_seq`），没有「轮询新消息」端点。
- 工具集读消息走历史接口即可；实时性由现有通道保证。

## 7. 附：Ayla 侧与爱莉相关的既有约束

- `ElysiaProfile` 是应用级单例，绑定一个 `User`；爱莉就是普通 user。
- 所有新注册账号默认与爱莉互为好友，并有一条私聊会话（`ensure_elysia_relationship`）。
- 爱莉私聊不受好友校验限制（`can_send_private_message` 对她放行）。
- ElyH 通道连着 → `is_elyh_online` 为真 → 她在应用内显示「在线」（不参与隐身）。
- **主体性铁律**：应用侧代码绝不生成爱莉的第一人称内容；工具集只搬运她自己决定的动作。

### 7.1 非爱莉账号（standalone 形态的 bot）差在哪

同一套接口，换个账号登录，能力就不同。差异只有一处，但影响很大：

| 项 | 爱莉（`ElysiaProfile` 绑定的 user） | 任意其他账号 |
|---|---|---|
| 新用户注册时自动加好友 | **是**，双向 | 否 |
| 私聊是否需要好友 | **不需要**（`is_elysia_user` 直接放行） | **需要**，双向 accepted |
| 建私聊会话 | 可以 | 可以（后端不校验好友） |
| 往私聊会话发消息 | 可以 | **403**，除非是好友 |

因此对 standalone 的 bot 来说，链路是：

```text
搜索用户 → 发好友申请 → 对方同意 → 才能发私聊
   ↑ 缺任何一步，发消息都是 403「对方已不是你的好友，无法发送消息」
```

（群聊不受此限：只要是群成员、未被禁言，就能在群里发言。所以「先拉进群」是一条
不需要对方同意的沟通路径——这在实际使用中比好友申请更常用。）
