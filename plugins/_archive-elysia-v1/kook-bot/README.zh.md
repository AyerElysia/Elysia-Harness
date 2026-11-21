# @elysia/kook-bot

[English](README.md) | 中文

KOOK 渠道插件。它把 Elysium 已经在用的 Bot 接到主意识的 `send_text`。

账号不另存一份。Bot Token 读 `config/plugins/kook_adapter/config.toml`。

## 会话窗口

`channel` 固定是 `kook`。

| 窗口 | id |
|---|---|
| 私信 | `kook:direct:<userId>` |
| 频道 | `kook:channel:<channelId>` |

`userId` 和 `channelId` 是 KOOK 事件里的正整数字符串。入口消息带上这个 id，回复时原样抄回 `conversation`。

## 发送

私信用 `/direct-message/create`，频道用 `/message/create`。`use_kmarkdown` 为真时消息类型是 9，否则是 1。`reply_with_quote` 为真时，`replyTo` 放进 `quote`。每一段只发一条文字。

## 接收

Gateway 信令 0 里的文字（类型 1）、KMarkdown（类型 9）和图片（类型 2）收成：

```ts
interface KookInboundEvent {
  channel: 'kook'
  conversation: string
  target: { kind: 'direct'; userId: string } | { kind: 'channel'; channelId: string }
  messageId: string
  senderId: string
  senderName: string
  content: readonly (
    | { type: 'text'; text: string }
    | { type: 'image'; url: string }
  )[]
}
```

机器人自己的消息丢掉。`listen: true` 时插件打开 Gateway。同一枚 Token 只能保持一条，再连一次会把正在跑的 Elysium 顶掉。

`forwardKookInbound` 按事件顺序处理每条消息。文字直接进入 DSH `admitPromptContent()`；图片先通过 HTTPS 下载，不往图片 URL 发送 Bot Token，再经过同一个附件准入。成功后，`kook/message` 给观察者保留原始渠道事件，主意识共享 pending 收到的是文字和持久 `ImageAttachmentRef`。原始 Base64 和图片 URL 不进入主意识事件或 Session。下载、格式或附件校验失败时整条消息不入队并记录错误，不生成 `[图片]` 占位。pending 只负责收集和唤醒，本插件不决定怎么回复。

`kookInboundText` 只保留给读取历史私信的纯文字辅助接口；Gateway 正式入站使用 `kookInboundEvent`。

## 部署开关

web 面启动脚本 `scripts/dsh-web.sh` 注入 `ELYSIA_KOOK_CONFIG`（指向 Elysium 的 kook_adapter 配置），profile 因此挂载本插件、注册 `kook` 发送能力。

2026-10-26 起 KOOK 已移交 ElyHarn：Python 侧 kook_adapter 自 2026-10-23 16:23 停用（`enabled = false`，Gateway 已停止），`dsh-web.sh` 默认注入 `ELYSIA_KOOK_LISTEN=1`，本插件持有所属 Gateway。同一枚 Token 只能保持一条连接，跑多个 ElyHarn 实例时，其余实例必须显式 `ELYSIA_KOOK_LISTEN=0`。
