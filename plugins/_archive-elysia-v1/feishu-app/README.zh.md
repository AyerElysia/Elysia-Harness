# @elysia/feishu-app

[English](README.md) | 中文

飞书渠道插件。它把 Elysium 已经在用的自建应用接到主意识的 `send_text`。

账号不另存一份。`app_id`、`app_secret` 和 API 地址读 `config/plugins/feishu_adapter/config.toml`。

## 会话窗口

`channel` 固定是 `feishu`。

| 窗口 | id |
|---|---|
| 私聊 | `feishu:private:<open_id>` |
| 群 | `feishu:chat:<chat_id>` |

`open_id` 以 `ou_` 开头，`chat_id` 以 `oc_` 开头。入口消息带上这个 id，回复时原样抄回 `conversation`。

## 发送

`reply_to_message` 为真且带了 `replyTo` 时，走飞书的消息回复接口。否则私聊用 `receive_id_type=open_id`，群用 `receive_id_type=chat_id`。每一段只发一条文字。

## 接收

长连接收到 `im.message.receive_v1` 的文字后收成：

```ts
interface FeishuInboundText {
  channel: 'feishu'
  conversation: string
  target: { kind: 'private'; openId: string } | { kind: 'chat'; chatId: string }
  messageId: string
  senderId: string
  text: string
}
```

应用自己发出的消息丢掉。`listen: true` 时插件打开这条长连接。同一个飞书应用只能保持一条，再连一次会把正在跑的 Elysium 顶掉。
