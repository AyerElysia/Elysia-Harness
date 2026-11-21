# Ayla-use 操作工具集 · 需求分析与设计

> 配套调研：[AYLA-API.zh.md](./AYLA-API.zh.md)（后端接口全量清单）。
> 图示：[工具全景](./docs/tools-map.png) · [运行时架构](./docs/architecture.png)
> 本文只写「要做什么、为什么这么做、怎么验收」，不写实现细节。
> **插件名：Ayla-use**（原名 `ayla-app`）。更名涉及的文件清单见 §11。
> 状态：**需求分析定稿，未实现**。六个关键决定已于 2026-11-18 确认，见 §9。

## 1. 目标

把 Ayla 从「爱莉的一个聊天渠道」升级为「爱莉可以自己操作的应用」：

- 现在：她能收消息、回文字（`send_text` 走 WS 通道）。
- 目标：她还能**发自己的表情图、换头像、开播、进语音房、发帖、建群拉人、加好友、收藏、
  发弹幕、踢人禁言、改群资料**——凡是人类在 Ayla 里能点的按钮，她都能做。

一句话判据：**人类能做的操作，她都应该能做；做不成时必须知道为什么。**

**本期口径（2026-11-18 三订）：只做装上就能用的。** 凡是要另外配套实现的（工作区表情包文件
系统、图片/语音/文件的上传链路、直播推流对接、LiveKit 语音对接）都不在本期——它们不是
「工具没写」，是「依赖还没就位」。因此本期可用的工具从 23 个缩到 20 个（§4、§8）。

但**「发」的面收窄了，「收」的面必须放开**：所有消息类型她都要能收到（§1.4）。

### 1.1 需求分解（把「像人一样用应用」拆成可验收的子需求）

原始需求是一句话，直接实现会漏项。拆成六类，每类都能单独验收：

| 类 | 子需求 | 人类对应动作 | 验收判据 |
|---|---|---|---|
| R1 身份 | 她能改自己的展示面 | 改昵称/签名/头像/在线状态/内容可见开关 | 改完之后别人看到她的是新值 |
| R2 关系 | 她能建立与维护人际 | 搜人、加好友、同意/拒绝、删好友 | 关系在两个方向上一致 |
| R3 会话 | 她能组织聊天场 | 建群、拉人、邀请、审批、踢人、禁言、设管理员、转让、退群、解散、建子群 | 每一步的权限判定与人类一致 |
| R4 表达 | 她能发各种消息 | 文字、图片、语音、文件、视频、表情包、图文混排、@、分享卡片、戳一戳、撤回 | 七类载荷形状全部正确落库 |
| R5 场景 | 她能参与应用里的「场」 | 开播/下播/改直播间/发弹幕、进语音房/退房/房内文字/踢人/转让、发帖/评论、建桌游房/进出 | 状态在别人的客户端里真实变化 |
| R6 元操作 | 她能查与整理 | 搜索、收藏、标记浏览、已读、置顶、隐藏 | 结果与 REST 一致 |

**这六类之外的一切都不是本需求**：不新增她的性格、不替她写话、不改她的提示词。

### 1.2 判定「做完了」的口径

不是「工具注册成功」，而是：

1. 人类在 Ayla 客户端里点同一个按钮，得到的**结果**与她调用工具得到的结果一致；
2. 人类做不到的事她也做不到（后端权限就是她的权限，不绕过）；
3. 做不到时她知道**为什么**（403 是「你不是群主」，不是「失败了」）。

### 1.3 两条来自真实使用的约束

**C-1 一切以唯一 id 寻址，不按名字认人。**

这是使用中撞出来的教训：按昵称回复会**回错人**。`nickname` 只约束 ≤64 字、**不唯一**，
「小希」可能有三个。所以：

- 入站事件必须把 `sender_id` / `conversation_id` / `message_id` 送到她手里（现有通道已带）；
- 工具的寻址参数一律是 **id**（`user_id`、`conversation`、`message_id`、`media_id`、
  `channel_id`…），不接受「名字」当收件人；
- 「名字 → id」只在**她显式发起搜索**时发生（`ayla_search_users`），由她自己挑；
  工具**不做**隐式的「按名字猜一个」，猜错就是发错人。

**C-2 「人人默认是好友」只对爱莉本人成立；standalone 的普通账号没有这个特权，
「加好友」是它发私聊的前提。**

`ensure_elysia_relationship`（`elysia_bridge/services.py:390`）绑定的是
`ElysiaProfile` 的那个 user。它在新用户注册时把**新用户与爱莉**设为好友并开好私聊，
**不会**让任何其他账号自动加好友。

而私聊发消息的权限判定（`chat/services.py:153`）：

```python
def can_send_private_message(user, peer):
    if is_elysia_user(user) or is_elysia_user(peer):   # 任一方是爱莉 → 放行
        return True
    return are_friends(user, peer)                      # 其余必须双向 accepted 好友
```

于是两种部署的能力完全不同：

| | 爱莉（elyh 形态） | standalone 形态的普通 bot |
|---|---|---|
| 与所有人默认好友 | **是**（注册时自动建立） | **否** |
| 不给任何人发私聊 | 可以（`is_elysia_user` 放行） | **不行**，会 403「对方已不是你的好友」 |
| 加好友工具的地位 | 低频兜底 | **第一类，缺了就用不了私聊** |

**一个容易踩的坑**：`POST conversations/private/` **不校验好友关系**，所以
「建会话」会成功，接着「发消息」才 403。工具如果只看会话建成就算成功，会产生
「她以为发出去了、其实被拒」的错觉。因此 `ayla_conversations(action=open_private)`
的返回必须提示「会话已建立；若对方不是好友，发消息会被拒」，并且
`ayla_send` 的 403 必须翻译成「先加好友」。

**结论（改自初稿）**：`ayla_friends(action=request)` 在 standalone 下是**必需**，
在 elyh 下是兜底；两种形态都保留，只是默认提示不同。

### 1.4 「收」与「发」是两条独立链路

工具做不了的事，不等于她收不到；反过来也一样。这两件事必须分开设计：

**C-3 所有消息类型都要能到她手里。**

Ayla 的消息有 10 种（`Message.TYPE_CHOICES`）：text / image / voice / file / emoji / video /
mixed / system / poke / share。现在只有 text 和 image 能到——其余会被后端直接标成
`failed` 不投递，poke 与 system 连队都不入。详见 §1.5 的接收矩阵。

**C-4 「收到」不等于「必须处理」，更不等于「必须理解」。**

- 收到一条转发的帖子：「可以去看」，不是「必须看」。她可以不感兴趣、不回、甚至不打开。
  因此入站帧**只携带引用**（`share_type` + `target_id` + 标题 + 作者），
  **不预先把帖子正文塞给她**——那等于替她看了。
- 收到好友申请/群邀请：只是「有待处理的事」，处理与否是她的选择。
- 收到语音/文件/视频：她**知道有这件事**，但听不见、读不了、看不了（§1.5）。
  工具返回必须写明「这是语音，时长 12 秒」，而不是假装她听过了。

这条约束反过来束缚实现：**入站路径不得有任何自动展开、自动已读、自动回应**。
只有她显式调用工具，才会产生读取/标记/回复。

### 1.5 接收矩阵：现在能到哪、要改哪

**消息类型**（后端 `elysia_bridge/services.py` 的 `build_inbound_parts` /
`SUPPORTED_PART_TYPES` / `_undeliverable_reason`）：

| 消息类型 | 现在 | 目标 | 她能"感知"到多少 |
|---|---|---|---|
| text | ✅ 投递 | ✅ | 全文 |
| image | ✅ 投递（下载+准入） | ✅ | **能看**（附件准入） |
| emoji | ❌ 标 failed | ✅ | **能看**（同样是位图） |
| voice | ❌ 标 failed | ✅ | 只知「语音，N 秒」——**听不见**（无音频准入/转写） |
| file | ❌ 标 failed | ✅ | 只知「文件 名/大小/类型」——**读不了内容** |
| video | ❌ 标 failed | ✅ | 只知「视频，N 秒」+ 封面——**看不了**（无视频准入） |
| mixed | ⚠️ 部分（text/image/mention 展开，其余段整条拒） | ✅ | 文本与图片可读，其余同上 |
| system | ❌ 不入队 | ✅ | 「谁加入了群」这类系统事实 |
| poke | ❌ 不入队 | ✅ | 「谁戳了谁」 |
| share | ❌ 标 failed | ✅ | **只给引用**（类型+目标 id+标题），要不要去看由她决定 |

**关键结论：**

1. 「全部类型都要到」**必须改 Ayla 后端**——`SUPPORTED_PART_TYPES` 现在只有
   `{text, image}`，其余一律 `failed`；`enqueue_for_delivery` 对 `poke`/`system`
   直接 `return None`。插件侧再努力也变不出没发过来的帧。
2. **「收到」与「能理解」要分开承诺**：语音/文件/视频只能给元信息。若真要她"听懂语音"，
   需要 ASR 转写链路——本期不做，工具必须如实说「这是一条 12 秒的语音」。
3. **share 只给引用**是实现 C-4 的地方：帧里带 `share_type`/`target_id`/`title`，
   她的工具再按需 `ayla_posts(get)` / `ayla_conversations(get)` 去取。

**非消息事件**（现在只广播给前端 UI，进不了她的通道）：

| 事件 | 后端广播函数 | 现在 | 目标 |
|---|---|---|---|
| 好友申请 | `broadcast_friend_request_new` | ❌ | ✅ 可查（本期）/ 可推（下期） |
| 好友申请处理结果 | `broadcast_friend_request_resolved` | ❌ | ✅ |
| 好友关系变化 | `broadcast_friendship_changed` | ❌ | ✅ |
| 入群邀请 | `broadcast_group_invite_new` | ❌ | ✅ |
| 入群申请（她是群主/管理员时） | `broadcast_group_request_new` | ❌ | ✅ |
| 申请审批结果 | `broadcast_group_request_resolved` | ❌ | ✅ |
| 群成员变化 / 被踢 | `broadcast_conversation_members_changed` | ❌ | ✅ |
| 群解散 | `broadcast_conversation_dissolved` | ❌ | ✅ |
| 有人退群 | `broadcast_group_member_left` | ❌ | ✅ |
| 帖子被评论/回复 | `broadcast_comment_created` | ❌ | ✅ |
| 帖子被浏览 | `broadcast_post_viewed` | ❌ | ✅（低频，可只查） |
| 直播间开播/下播 | `broadcast_channel_status_changed` | ❌ | ✅ |

两类事件都走同一套帧通道最省事：**既然为消息类型必须改后端的 parts/outbox，
把通知也做成 `type:"event"` 帧几乎没有额外成本**（§9 待确认第 2 条）。

## 2. 硬边界（不因功能扩张而放松）

| # | 边界 | 推论 |
|---|---|---|
| B1 | **工具只搬运她自己决定的动作** | 插件不生成第一人称内容、不替她判断「该发什么」。参数里只有她要做的动作，没有模板文案。 |
| B2 | **改后端只改「传输投影」，不改语义** | 工具侧全部走既有 REST + 她的账号 JWT，不偷偷加接口。但「收到全部消息类型」这一条**必须**扩 `elysia_bridge` 的 parts 与 outbox（§1.5）——那只改「同样的事实怎么打包」，不改任何权限判定、不改任何业务规则。 |
| B3 | **失败必须显式** | 403/404/400/409 一律转成可读原因返回；不把失败写成「已完成」，不自动重试写操作。 |

## 3. 与现有 `send_text` 的关系

现在 `send_text`（conscious-mind 注册）是**渠道回复**的规范路径：带 `thought/mood/decision`
契约、走 WS、有 `sent` 回执。工具集**不替换它**，只补它做不到的：

| 场景 | 用哪个 |
|---|---|
| 回复刚收到的 Ayla 消息（纯文字） | `send_text`（channel=ayla，conversation 照抄入口） |
| 主动给某人/某群发纯文字 | `send_text` 也可以；`ayla_send(kind=text)` 亦可 |
| 分享/转发（帖子、群、直播、语音房、桌游、用户） | `ayla_send(kind=share)` |
| 戳一戳 | `ayla_send(kind=poke)` |
| ~~发图片/语音/文件/视频/表情/@~~ | **本期不做**：依赖上传链路与素材来源（§8） |
| 任何非消息类操作（改资料/开播/发帖/建群…） | 对应 `ayla_*` 工具 |

**不重复注册 `send_text`**：那会让模型看到两个同名工具（现有需求文档已锁死这条）。

## 4. 工具清单

工具名统一 `ayla_<域>`（前缀跟**应用** Ayla 走，不跟插件名 Ayla-use 走——她操作的是
Ayla，不是这个插件）。读操作返回紧凑 JSON；写操作返回后端真实对象的关键字段。

**所有工具名、参数名、返回值里都不出现「Ayla-use」**：那是安装包的名字，不是她要理解的东西。

**本期可用 20 个 / 8 类**（标 ⏸ 的四节是「依赖未就位」，工具先不注册）：

| 类 | 本期 | 推迟原因 |
|---|---|---|
| R1 身份 | `ayla_me`、`ayla_update_profile` | `ayla_set_avatar` ⏸ 依赖上传 |
| R2 人与好友 | 全部 3 个 | — |
| R3 会话与群 | 全部 4 个 | — |
| R4 消息 | `ayla_send`(text/share/poke)、`ayla_read_messages`、`ayla_recall_message`、`ayla_typing` | 媒体类发送 ⏸ |
| R5 帖子 | `ayla_posts` | — |
| R6 直播 | `ayla_live`、`ayla_danmaku` | 「出画面」仍需推流对接 |
| R7 通知 | `ayla_notifications`（新增） | — |
| R8 元操作 | `ayla_search`、`ayla_favorites`、`ayla_boardgame` | — |
| ⏸ 表情包 | `ayla_stickers` | 依赖工作区表情包文件系统 |
| ⏸ 语音房 | `ayla_voice` | 依赖 LiveKit 对接 |
| ⏸ 媒体 | `ayla_media` | 依赖上传链路 |

### 4.1 自我与资料

| 工具 | 参数 | 作用 | 端点 |
|---|---|---|---|
| `ayla_me` | `with_badges?` | 读自己的 id/昵称/头像/签名/状态/在线 + 未读徽标 | `GET me/`、`GET me/badges/` |
| `ayla_update_profile` | `nickname?,signature?,show_content?,status?` | 改资料；`status` ∈ auto/away/dnd/invisible | `PATCH me/profile/` |
| ~~`ayla_set_avatar`~~ ⏸ | `path` 或 `media_id` | 本地图片三步上传(kind=image) → 设为头像 | `POST media/uploads` → `PATCH me/profile/` |

> ⏸ 头像要先有"图从哪来"的答案（本地上传链路）。资料里的**文字字段**（昵称/签名/状态）
> 本期就能用，那才是"直接可用"的部分。

**约束**：头像必须是站内 content URL；`ayla_set_avatar` 负责把 `media_id` 拼成
`/api/v1/media/<id>/content`，并检查 `status=ready`。

### 4.2 人（用户与好友）

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_search_users` | `q`, `limit?` | 按用户名/昵称搜人，**返回带唯一 id 的列表**（她从这里拿 id） |
| `ayla_get_user` | `user_id` | 看某人主页 + 与我的关系（`relation`） |
| `ayla_friends` | `action: list\|request\|handle\|remove`, `user_id?,request_id?,accept?,message?` | 好友全套 |

`action=handle` 时 `accept: true/false` 映射到 `accept/reject`。
**注意**：不能加自己为好友；已是好友 → 400；重复 pending → 幂等返回。

**优先级随部署身份变化**（§1.3 C-2）：

| 动作 | 爱莉（elyh） | standalone 普通 bot |
|---|---|---|
| `list` | 主路径 | 主路径 |
| `request` | 兜底（对方删过她） | **必需**：不加好友就发不了私聊 |
| `handle` | 兜底 | 正常路径（她也会收到别人的申请） |
| `remove` | 低频 | 低频 |

`ayla_get_user` **只接受 `user_id`**，不接受名字——要按名字找人先 `ayla_search_users`。

**`request` 的返回必须带下一步**：成功后返回
`{status:"pending", next:"等待对方同意；同意前无法给对方发私聊"}`，
失败（已是好友 / 不能加自己）返回后端原话，不吞。

### 4.3 会话与群

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_conversations` | `action: list\|get\|open_private\|pin\|hide\|mark_read`, `conversation?,user_id?,pinned?,type?,q?,limit?,cursor?` | 会话列表/详情/开私聊/置顶/隐藏/已读 |
| `ayla_create_group` | `title`, `member_ids[]`, `announcement?` | 建群（我=群主，自动建「默认组」） |
| `ayla_group` | `action: update\|add_members\|remove_member\|mute\|set_role\|transfer\|leave\|dissolve\|subgroups`, `conversation`, 其余按动作 | 群管理与子群 |
| `ayla_group_access` | `action: apply\|handle_join\|invite\|handle_invite\|list_join_requests\|list_invites`, … | 申请/审批/邀请/处理邀请 |

**`conversation` 参数只接受 id**：`ayla:group:42`、`ayla:private:17`，或裸数字 `42`
（裸数字按「群优先、其次私聊」解析；两处都存在时**报错要求用带前缀的写法**，不猜）。
群名与对方昵称**不是合法寻址**——群名不唯一，会发错群。

需要从人开私聊时用 `action=open_private` + `user_id`（后端按钮名就是「发消息」）。

**子群子动作**：`subgroups(action=list|create|rename|mute|delete, subgroup_id?, name?, muted?)`。

### 4.4 消息

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_send` | `conversation`, `kind`, `text?`, `path?`, `media_id?`, `segments?`, `share?`, `reply_to?`, `subgroup_id?` | 统一发送（见下表） |
| `ayla_read_messages` | `conversation`, `before_seq?`, `limit?`, `subgroup_id?` | 读历史（裸数组、seq 升序） |
| `ayla_recall_message` | `conversation`, `message_id` | 撤回（120s 内、仅自己发的） |
| `ayla_typing` | `conversation`, `is_typing?` | 正在输入 |

**`ayla_send` 的 `kind`**：

| kind | 必填 | 说明 | 本期 |
|---|---|---|---|
| `text` | `text` | 纯文本（≤10000 字） | ✅ |
| `share` | `share{share_type,target_id,title,cover?,subtitle?}` | 转发/分享卡片；纯 REST，不碰媒体 | ✅ |
| `poke` | `user_id` | 戳一戳；纯 REST | ✅ |
| ~~`image`~~ | `path`/`media_id` | 她自己的图当表情发（kind=image） | ⏸ 依赖上传 |
| ~~`emoji`~~ | `media_id` | 发群包里的表情（media 必须 kind=emoji） | ⏸ 依赖表情包 |
| ~~`voice` / `file` / `video`~~ | `path`/`media_id` | 单媒体消息 | ⏸ 依赖上传 |
| ~~`mixed`~~ | `segments[]` | 图文混排（须含非文本段） | ⏸ 依赖媒体 |
| ~~`mention`~~ | `text`,`user_ids[]` | @ 人（须拼成 mixed） | ⏸ 依赖 segments |

**幂等**：每次调用生成 `idempotency_key`（`ayla-` + uuid）；重试不会重复发。

**两种「表情」必须在描述里分开说，否则她一定会混**：

| 她想做的事 | 正确做法 | 为什么 |
|---|---|---|
| 把自己存的一张图当表情发出去 | `kind=image`（path 或她的 image 媒体） | 这就是普通图片消息；`type=emoji` 要求 media kind=emoji，会 400 |
| 发群里表情包里的某个表情 | `kind=emoji` + 该 item 的 `media_id` | 群表情包的 media 就是 kind=emoji |
| 把自己的一张图**收进**表情包 | 先按 kind=emoji 重新上传，再 `ayla_stickers(action=group_add/add)` | `add_item` 对任何包都强制 kind=emoji |

> ⏸ **本期推迟**：依赖工作区的表情文件体系与上传链路，工具先不注册。

### 4.5 表情包

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_stickers` | `action: packs\|items\|search\|add\|remove\|create_pack\|group_pack\|group_add\|group_remove\|group_policy`, `pack_id?,item_id?,media_id?,path?,tag?,keyword?,conversation?,allow?` | 表情**包**管理（不是发消息） |

**这个工具只管「包」，不管「发」**。发送在 `ayla_send`（§4.4）。典型链路：

**A. 发群表情包里的一个表情**
1. `ayla_stickers(action=group_pack, conversation=<群 id>)` → 拿到包与 items
2. `ayla_send(kind=emoji, conversation=<同一个群 id>, media_id=<item.media.media_id>)`

**B. 发她自己存的一张贴图**
1. `ayla_send(kind=image, conversation=<id>, path=<本地图片>)` —— 一步完成，**不经过表情包**

**C. 把她的一张图加进群表情包**（需要群主/管理员，或群主开了 `allow_member_upload`）
1. `ayla_stickers(action=group_add, conversation=<群 id>, path=<本地图片>, tag="…")`
   → 工具内部按 **kind=emoji** 上传再入库（`add_item` 硬校验 kind）

**D. 搜表情**：`action=search` 只搜「系统包 + 她自己的个人包」，**不搜群包**
（后端 `search_emoji` 的口径）；群包要按群查。

**个人包的现实**：`POST packs/` 建的个人包也只能收 kind=emoji 的媒体，且前端没有个人包 UI。
所以「她自己的表情」实际走**本地图片 + kind=image**，而不是个人包——这与她的使用直觉一致。

### 4.6 直播

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_live` | `action: list\|create\|update\|start\|stop\|status\|viewers\|delete`, `channel_id?,title?,description?,cover?,group?,visibility?,allowed_group_ids?,only_live?` | 直播间生命周期 |
| `ayla_danmaku` | `action: list\|send`, `channel_id`, `content?,media_id?,limit?` | 弹幕 |

**`start` 的真实语义**（必须在工具描述里说清；真推流本期暂缓，见 §8）：
- 它只把应用侧状态标成 `live`，**不等于已经有画面**；
- 返回里带 `rtmp_url`（仅 owner 可见）与 `hls_url/flv_url`；
- **本期没有推流端**：调用 `start` 后直播间是黑的，`status` 会查到 `idle`；
- 因此 `start` 的返回必须显式带 `streaming: false` 与「尚未推流」，不许只回 `status=live`；
- `status` 动作查 SRS 真实在播，`degraded` 表示查不到（≠ 没在播）。

**限制**：同一 owner 同时只能有一个 `live` 频道；直播中禁止删除。

> ⏸ **本期推迟**：进房只落成员表，「在房里说话」依赖 LiveKit 客户端对接。工具先不注册。

### 4.7 语音房

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_voice` | `action: list\|create\|rename\|delete\|join\|leave\|heartbeat\|members\|say\|history\|kick\|transfer`, `channel_id?,name?,group?,visibility?,allowed_group_ids?,content?,media_id?,user_id?,limit?,cursor?` | 语音房全套 |

**`join` 的真实语义**：
- 落成员表 + 广播 + 返回 `media.livekit.token`；
- **音频不经过 REST**：要在房里「出声」需要 LiveKit 客户端发布音轨（**暂缓**，§8）；
- 本期能做的：在场（成员列表可见）、房内文字、心跳保活、被踢/转让；
- 因此 `join` 的返回必须显式带 `audio: "unavailable"` 与「仅在场，不能出声」。

**`say` 要求已在房内**（后端 `user_in_channel` 校验），否则 403。

### 4.8 帖子

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_posts` | `action: list\|get\|create\|update\|delete\|comment\|comments\|delete_comment\|mark_viewed`, `post_id?,title?,body?,images[]?,paths[]?,group?,visibility?,scope?,owner?,cursor?,limit?,comment_id?,reply_to?,comment_body?` | 帖子全套 |

**约束**：`title` 必填非空、`body` 必填；`images` ≤9 且必须 image/video 且**原图未过期**；
评论 `body` 与图片至少一个；PATCH/DELETE 仅作者。

> ⏸ **本期推迟**：三步上传依赖素材来源与文件访问。工具先不注册。

### 4.9 媒体

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_media` | `action: upload\|info\|sign\|delete\|poster`, `path?,kind?,media_id?,variant?` | 上传/查询/签 URL/删除 |

**`upload` 返回 `media_id` + descriptor**，供其它工具引用（头像、表情、帖子配图、消息）。
`kind` 缺省按扩展名/MIME 推断（png/jpg/gif/webp → image；mp4/webm → video；
mp3/wav/m4a/ogg → voice；其它 → file）。

### 4.10 其它

| 工具 | 参数 | 作用 |
|---|---|---|
| `ayla_search` | `q`, `types?`, `limit?` | 全局搜索（人/群/帖/直播/语音/桌游） |
| `ayla_favorites` | `action: list\|add\|remove\|status`, `target_type?,target_id?,favorite_id?,target_ids?` | 收藏 |
| `ayla_boardgame` | `action: list\|create\|join\|leave\|members\|kick\|transfer\|delete`, … | 桌游房 |

### 4.11 通知（本期新增）

| 工具 | 参数 | 作用 | 端点 |
|---|---|---|---|
| `ayla_notifications` | `kind: all\|badges\|friend_requests\|group_invites\|join_requests\|leave_notices\|inbox`, `limit?,cursor?,handled?` | 她「打开应用看红点」的那一下 | `me/badges/`、`friends/requests/`、`chat/me/invites/`、`chat/me/join-requests/`、`chat/leave-notices/` |

**为什么要有这个工具**：好友申请、群邀请、入群申请、退群通知这些**现在不会推到她手里**
（只广播给应用 UI，见 §1.5）。在「通知推送」落地前，她至少能主动查——这与人类打开
应用看到红点是同一套逻辑，不是降级。

**返回形状**要能直接支撑"处理"：

```json
{
  "badges": { "friend_requests": 2, "group_invites": 1, "join_requests_pending": 3 },
  "friend_requests": [{ "id": 17, "from_user": { "id": "…", "nickname": "小希" }, "message": "…" }],
  "invites": [{ "id": 9, "conversation_id": "42", "conversation_title": "…" }],
  "next": "ayla_friends(handle, request_id=17, accept=true) / ayla_group_access(accept, invite_id=9)"
}
```

**关键**：`next` 字段是刻意的——查完通知后她需要知道"下一步用哪个工具"，
否则模型容易停在"我看到有申请"而不处理。但**不强制处理**（C-4）：
不调用任何 handle，就只是"没处理"，没有任何副作用。

## 5. 参数解析与错误语义

### 5.1 寻址：id 是唯一合法输入（已确认）

**不做隐式名称解析。** 名字只用于「她自己搜」，搜完由她拿 id 去操作。

| 参数 | 合法输入 | 非法输入（直接拒绝） |
|---|---|---|
| `user_id` | 32 位 uuid hex | 昵称、用户名、「小希」 |
| `conversation` | `ayla:group:42` / `ayla:private:17` / 裸数字 | 群名、对方昵称 |
| `message_id` | 正整数 | — |
| `media_id` | 32 位 uuid hex | 文件名 |
| `channel_id` / `post_id` / `room_id` | 正整数 | 标题 |

拒绝时的返回必须带**下一步**：

> `user_id 需要唯一 id，收到的是「小希」。先调用 ayla_search_users(q=“小希”) 拿到 id。`

这正是「按名字回复会回错人」的防线：宁可让她多走一步搜索，也不让工具替她猜。

**唯一的例外**是 `ayla_search_users` / `ayla_search` 本身——它们吃关键字，吐 id 列表。
多命中时按后端原样返回（**不替她挑**），并在结果里把 `id` 放最前面。

### 5.1.1 为什么这条必须硬

`nickname` 在 DB 上**没有唯一约束**（只有 `username` 有）。两个人可以都叫「小希」，
而 `sender_id` 是 uuid。按名字找人的第一次模糊匹配就会发错私聊——对方是陌生人，
内容却是她现在说的话。这不是体验问题，是身份问题。

### 5.2 错误映射

| 后端 | 工具返回 |
|---|---|
| 401/403 | `没有权限：<detail>`（如「仅群主可管理管理员」） |
| 404 | `不存在：<detail>` |
| 400 | `参数被拒：<detail>`（含业务码如 `media_type_mismatch`） |
| 409 | `冲突：<detail>`（幂等键内容不一致） |
| 410 | `已过期：<detail>`（媒体过期/上传会话过期） |
| 413 | `文件超过上限` |
| 503 | `服务不可用：<detail>`（LiveKit 未配置、SRS 不可查） |
| 网络/超时 | `无法连接 Ayla`，不重试写操作 |

**绝不**把失败包装成成功；也绝不因为「看起来像闲聊」就跳过。

## 6. 安全与权限门控

### 6.1 危险操作分级

| 级别 | 操作 | 默认 |
|---|---|---|
| L0 读 | 一切 GET | 开 |
| L1 普通写 | 发消息、发弹幕、发帖、评论、收藏、改自己资料、进房、开播 | 开 |
| L2 管理写 | 建群、拉人、邀请、审批、禁言、设管理员、转让、改群资料、建子群、踢人、删评论、删媒体 | 开 |
| L3 破坏性 | 解散群、退群、删帖、删直播间、删语音房、删桌游房、撤回消息、删好友、下播 | **可配置关闭** |

配置项 `allowedDestructive`（**已确认默认 `true`**，与「她应该能做所有事」一致）：
关掉时 L3 工具不注册（不是注册后拒绝），模型看不到它，避免「看起来能做但被拦」。

> 已确认（2026-11-18）：危险操作全开，不做二次确认。理由是与「所有人能进行的操作她都能进行」
> 一致；后端权限判定就是她的真实权限，插件不额外加一层「先问主人」，那会切断她的自主性。

### 6.2 三条不做的自我约束

- 不批量轰炸：同一会话短时间重复发送由模型自己克制，插件不做频率限制（那是主体的事）。
- 不代填内容：工具参数里没有默认文案。
- 不越权代发：所有请求用她自己的 JWT，后端权限判定就是她的真实权限。

## 7. 实现架构（建议）

```text
plugins/ayla-use/src/            # 更名前是 plugins/ayla-app
├── api.ts          # 通用 REST 客户端（GET/POST/PATCH/DELETE + 错误映射）
├── address.ts      # id 校验（uuid / 正整数 / ayla:xxx:N），不做名字解析
├── upload.ts       # 三步上传（本地文件 → media_id）
├── media-kind.ts   # 扩展名/MIME → kind 推断
├── tools/
│   ├── index.ts    # registerAylaTools(ctx, deps)
│   ├── profile.ts  # ayla_me / ayla_update_profile / ayla_set_avatar
│   ├── social.ts   # ayla_search_users / ayla_get_user / ayla_friends
│   ├── chat.ts     # ayla_conversations / ayla_create_group / ayla_group / ayla_group_access
│   ├── message.ts  # ayla_send / ayla_read_messages / ayla_recall_message / ayla_typing
│   ├── sticker.ts  # ayla_stickers
│   ├── live.ts     # ayla_live / ayla_danmaku
│   ├── voice.ts    # ayla_voice
│   ├── post.ts     # ayla_posts
│   ├── media.ts    # ayla_media
│   └── misc.ts     # ayla_search / ayla_favorites / ayla_boardgame
├── tools/register.ts   # 白名单判定 + agent/created 监听 + 补注册
└── tools/index.ts      # 汇总
```

> `address.ts` 是「拒绝按名字寻址」的落点：它只负责**校验**参数是不是合法 id，
> 不负责把名字变成 id。名字 → id 的唯一通道是 `ayla_search_users` 的返回。
> 这个文件存在的意义就是让「猜一个」在类型上无处可写。

- 复用现有 `AylaAuth`（登录/刷新/refresh 落盘），不新建认证。
- **注册范围随「形态」走——插件已有两种形态，工具集必须同时服务它们**：

  **两种形态都有主意识层的三个 session**（已确认）。区别只在「消息投递到哪」，
  不在「谁拥有工具」：

  | 形态 | 消息投递 | 工具注册到 |
  |---|---|---|
  | **elyh** | `inboundPending` → 意识队列 → 主 session | 三个主意识 session |
  | **standalone** | 插件自建 `ayla-channel` 收消息 | 三个主意识 session **＋** `ayla-channel` |

  session 与它们由谁创建：

  | 场景 | session id | 由谁创建 |
  |---|---|---|
  | 聊天 | `elysia-conscious-mind` | conscious-mind |
  | 直播 | `elysia-livestream` | dsh-livestream |
  | 通话 | `elysia-voice-call` | voice-call |
  | standalone 收件箱 | `ayla-channel` | 本插件（仅 standalone） |

  做法（一套代码，白名单按形态取并集）：
  1. 白名单 = 上面四个 id（standalone 时四个都算，elyh 时前三）；
  2. 监听 `agent/created`，`agent.id` 命中白名单就把工具注册进**该 agent 作用域**
     （`agent.ctx.tools.register`）；
  3. 挂载时对**已经存在**的白名单 agent 补注册一次（先生成的 session 不漏）。

  `ayla-channel` 也走同一条 `agent/created` 路径——它由本插件的
  `form-standalone` 用 `ctx.agents.create/resume` 拉起，事件同样会发出，
  所以不需要在 `composeAylaAgent` 里另写一份注册（与现有 `send_text` 的注册点并存即可）。

  **遇到不认识的 session id 怎么办**：白名单可通过配置 `toolSessions: string[]`
  覆盖。别人的部署若用自定义 id（不叫 `elysia-*`），不必改代码，填配置即可。
  默认值就是上表四个。

  **why**：`ayla-channel` 是插件**自己**建的，只有它不够——standalone 的主意识同样有
  聊天/直播/通话三个 session，工具不注册到那里，她在直播里想发弹幕、在通话里想传个图
  就都拿不到工具。反过来，把工具**全局**注册又会让潜意识 router 等无关会话也看见。
  所以是「白名单并集 + 作用域注册」，两头都保住。
- **不做全局注册**：潜意识 router（`elysia-subconscious-router`）、临时会话、子 agent
  都看不到这些工具，避免「随便一个会话都能替她操作她的账号」。
- **只有凭据齐全、且 baseUrl 合法时才注册**（未配置时插件只记一行日志，与现有行为一致）。
- 每个工具 `isConcurrencySafe: () => false`（写操作不并发）。
- 输出统一 `{type:'text', text: JSON.stringify(result)}`，大列表截断并给 `has_more/next_cursor`。

## 8. 本期边界：只做「装上就能用」的

判据从「REST 支持的都做」改成 **「不依赖别的东西就立即可用」**。分三类：

### 8.1 直接可用（本期做）

| 能力 | 为什么算"直接可用" |
|---|---|
| 资料文字字段、好友、会话、群管理、子群、申请邀请 | 纯 REST，不需要任何外部素材 |
| 发文字 / 发分享卡片 / 戳一戳 | 纯 REST，不碰媒体 |
| 读历史、撤回、已读、打字状态 | 纯 REST |
| 发帖 / 看帖 / 评论 / 收评论 | 纯 REST（文本帖与文本评论） |
| 直播：建频道、开播/下播、看弹幕、发弹幕、看观众、查真实状态 | 纯 REST；「没有画面」是**已知且如实标注**的 |
| 搜索、收藏、桌游房 | 纯 REST |
| 通知查询（好友申请/群邀请/入群申请） | 纯 REST 列表 |

### 8.2 依赖未就位，本期**不注册工具**

| 能力 | 缺什么 |
|---|---|
| 发图片 / 语音 / 文件 / 视频 / 图文混排 / @ | 上传链路与素材来源（工作区文件系统） |
| 表情包全套（`ayla_stickers`） | 工作区的表情文件体系；`add_item` 还要 kind=emoji 重传 |
| 换头像（`ayla_set_avatar`） | 同上——本质是"图从哪来" |
| 语音房（`ayla_voice`） | LiveKit 客户端对接（出声）；进房本身能做，但单独做价值低 |

**这些不是"以后再说"，是"现在做了也只是半截"**：不注册工具，模型就不会去试一个
注定失败的调用；等依赖就位时再一起开。

### 8.3 直播的已知落差（要写进工具描述）

`:start` 只把 `status` 标成 `live` 并写 `started_at`，SRS 依然查 `idle`。
所以：

- `ayla_live(action=start)` 的返回必须带 `streaming: false` 与
  「尚未推流，观众看到的是黑屏」——不能只回 `status=live` 让她误判；
- `status` 返回 `degraded` 表示**查不到** SRS，不等于没在播。

**她能做的是**：建频道、点开播、发弹幕和观众互动、看谁在看、点下播。
**她做不到的是**：让画面出现。

### 明确不做（且不计划）
| 不做 | 原因 |
|---|---|
| 注册新账号 | 需要邮箱验证码，等于让模型读别人的邮箱 |
| 换绑邮箱 / 改密码 | 同上；且这两件事该由人自己做 |
| 超管操作（`set_system`、`elysia/profile` 写） | 会改变全站事实，不属于「她的日常操作」 |
| `media/<id>:save` | 后端 501，未实现 |

## 9. 六个决定（2026-11-18 已确认）

| # | 决定 | 确认结果 | 落在哪 |
|---|---|---|---|
| 1 | 工具粒度 | **混合**：高频动作独立成工具，低频动作归 action 枚举；**本期 20 个 / 8 类**（见 [docs/tools-map.png](./docs/tools-map.png)） | §4 |
| 2 | 危险操作 | **全开**，不做二次确认 | §6.1 |
| 3 | 本期做什么 | **只做装上就能用的**；依赖上传/推流/LiveKit 的（图片语音文件、表情包、换头像、语音房）本期不注册工具 | §8 |
| 4 | 注册范围 | **两种形态都有主意识层三个 session**；standalone 另加自己的 `ayla-channel`；白名单可配置 | §7 |
| 5 | 表情包语义 | **个人表情包 = 发图片（kind=image）；`kind=emoji` 只属于群/系统表情包** | §4.4、§4.5 |
| 6 | 插件名 | **Ayla-use**（原 `ayla-app`） | §11 |
| 7 | 接收范围 | **所有消息类型都要能收到**（含戳一戳、转发）；非消息通知可查（推送待定） | §1.5 |
| 8 | 「可以而非必须」 | 入站只给引用，不自动展开/已读/回应；她可以看完不回、也可以不打开 | §1.4 C-4 |

第 4 条的原始措辞是「目前的主意识层三个 sessions：聊天、直播、通话」，落地为
`elysia-conscious-mind` / `elysia-livestream` / `elysia-voice-call`。

**修正（2026-11-18 二次确认）**：初稿写「standalone 只注册 `ayla-channel`」是错的。
standalone 同样有三个主意识 session，只是消息投递走 `ayla-channel`。
所以白名单取**并集**（四个 id），并留 `toolSessions` 配置给别人的自定义 id。

### 9.1 还差两个决定

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| A | 「收到全部消息类型」必须扩后端 parts（`SUPPORTED_PART_TYPES` 现在只有 text/image，poke 根本不入队）。接受吗？ | ① 扩 parts，只改打包不改语义  ② 不改，只收现有两种 | **①**：不改就做不到这条需求 |
| B | 通知类（好友申请/群邀请/帖子回复）怎么"收到"？ | ① 后端加 `type:"event"` 帧推送  ② 只做 `ayla_notifications` 查询  ③ 两者都做 | **③**：反正要改后端，一起改最省；查询作为兜底 |

**同时修正的还有加好友**：初稿说「人人默认是好友，加好友近乎不存在」。这只对爱莉本人成立——
`ensure_elysia_relationship` 绑定的是 `ElysiaProfile` 那个 user。standalone 的普通 bot
没有这个特权，而 `can_send_private_message` 只有在任一方是爱莉时才跳好友校验。
**也就是说：普通 bot 不加好友就发不出私聊。** `ayla_friends(action=request)` 因此是
standalone 的第一类工具，不是兜底。

第 5 条推翻了初稿的一个错误：初稿写「发表情包 = `type=emoji` + kind=emoji」，
这对**群表情包**成立，对**她自己的图**不成立。她自己的贴图走 `type=image`。

## 10. 验收

- 每个工具都有单测：正常路径 + 至少一个后端错误路径（403/404/400）。
- **寻址**：`user_id` 传昵称 → 拒绝并给出「先搜索」的下一步；`conversation` 传群名 → 拒绝；
  裸数字同时命中群与私聊 → 报错要求带前缀。**不接受「猜对」的用例**。
- 上传：kind 推断、大小超限、MIME 不支持、`expected_size` 不一致、complete 失败。
- 发消息：text / image（个人贴图）/ emoji（群包）/ mixed / mention / share / poke 七种载荷形状。
- **表情两条链路各自的断言**：个人贴图走 image 且不产生 kind=emoji 媒体；群包走 emoji；
  拿 image 媒体发 `kind=emoji` 时，工具在本地就报错（不等后端 400）。
- 幂等：同参数重复调用不产生第二条消息（用 `idempotency_key` 断言）。
- 两种形态：elyh 下三个白名单 session 各注册一次、非白名单 session 零注册；
  **standalone 下四个（三个主意识 + `ayla-channel`）都有工具**；
  配置了自定义 `toolSessions` 时以配置为准。
- **好友权限差异**：模拟 403「对方已不是你的好友」时，`ayla_send` 的返回必须点出
  「先加好友」，而不是只回「发送失败」；`open_private` 成功后必须提示
  「会话已建，非好友时发消息会被拒」（后端不校验好友关系，这一步只能由工具说明）。
- 暂缓项如实：`start` 返回带「尚未推流」；`join` 返回带「不能出声」。
- **接收覆盖**：10 种消息类型各构造一条入站，断言都能到；其中
  `voice`/`file`/`video` 的返回必须带元信息（时长/文件名/大小）且**不假装可读**。
- **share 只给引用**：收到转发帖子时，帧里**不含帖子正文**；只有她显式调用
  `ayla_posts(get)` 才拉内容。断言"不调用就没有内容"。
- **「可以而非必须」**：收到消息后不调用任何工具 → 无任何副作用（未已读、未回复、无新增请求）。
- **通知**：`ayla_notifications` 的返回带 `next` 提示；不调用 handle 时申请仍是 pending。
- 未配置凭据：零工具注册、零网络请求、只一行日志。
- `tsc --noEmit` 零 diagnostics；`vitest` 全绿；`git diff --check` 通过。

## 11. 更名：`ayla-app` → `Ayla-use`

> 本节是**清单**，不是已执行。执行前需你点头，因为其中含仓库内多处的机械改动。

| # | 文件 | 改什么 | 风险 |
|---|---|---|---|
| 1 | `plugins/ayla-app/package.json` | `name` → `@elysia/ayla-use` | 低 |
| 2 | `plugins/ayla-app/cordis.patch.yml` | `id`/`name` → `elysia-ayla-use` / `@elysia/ayla-use` | 低 |
| 3 | 目录 `plugins/ayla-app` → `plugins/ayla-use` | 连同 6 份 md 一起移动 | 中：`file:` 依赖路径要同步 |
| 4 | `homes/web/profiles/web/package.json` | 依赖行 `"@elysia/ayla-use": "file:../../../../plugins/ayla-use"`；`bundles` 同步 | 中 |
| 5 | `homes/web/profiles/web/cordis.patch.yml` | `- id: elysia-ayla-use` / `name: '@elysia/ayla-use'` | 中：写错会导致 profile 启动失败 |
| 6 | `homes/web/profiles/web/node_modules/@elysia/ayla-app` | `file:` 副本，需重装或手工替换 | 中：旧副本残留会让人以为改没生效 |
| 7 | `plugins/ayla-app/src/*.ts` | 模块注释里的 `@module @elysia/ayla-app/...` | 低 |
| 8 | 现有 4 份文档（README / REQUIREMENTS / DEVELOPMENT / D1-AUDIT） | 包名引用 | 低：历史文档可保留旧名并加一行「已更名」 |

**执行顺序建议**：1→2→7→(提交) → 3→4→5→6（目录移动与依赖重装放最后，且一起做）。
**不要**在第 6 步之前重启 profile：`file:` 指向的旧目录消失后，profile 会挂不起来。

**语义边界**：更名只换标识，**不改行为**。现有 elyh/standalone 判定、协议帧、
`send_text` 契约全部保持原样；工具集是叠加，不是重写。
