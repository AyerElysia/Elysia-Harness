# @elysia/qq-napcat

[English](README.md) | 中文

QQ 渠道插件。它把 NapCat 的 OneBot 连接接到主意识的 `send_text`。

参考 Elysium 的 `plugins/napcat_adapter`：文字收发只使用 `send_private_msg` 和 `send_group_msg`，连接方式沿用现有的反向或正向 WebSocket。图片、语音、戳一戳、群管理不在这一版里。

## 会话窗口

`channel` 固定是 `qq`。`conversation` 选择这个 QQ 号上的一个窗口：

| 窗口 | id |
|---|---|
| 私聊 | `qq:private:<userId>` |
| 群 | `qq:group:<groupId>` |

`userId` 和 `groupId` 是 NapCat 事件里的正整数字符串。入口消息把这个 id 放进用户消息，回复时 `send_text` 原样抄回 `conversation`。

## 发送

插件挂载后登记：

```ts
ctx.outboundText.register('qq', async (delivery) => {
  const target = parseQqConversation(delivery.conversation)
  // private -> send_private_msg { user_id, message }
  // group   -> send_group_msg   { group_id, message }
  // delivery.replyTo 有值时，message 前加 { type: 'reply', data: { id } }
  return { messageId }
})
```

`send_text` 已经按 `\n` 拆成一段一条。这里每一段只发一条，不再按换行拆第二次。NapCat 回执超时抛 `OutboundDeliveryUnknown`，其余失败抛普通错误。成功时 `messageId` 用 OneBot 返回的 `message_id`。

## 接收

NapCat 的 `message` 事件收成：

```ts
interface QqInboundText {
  channel: 'qq'
  conversation: string
  target: { kind: 'private'; userId: string } | { kind: 'group'; groupId: string }
  messageId: string
  senderId: string
  senderName: string
  text: string
}
```

机器人自己发出的回声（`sender.user_id === self_id`）丢掉。`text` 只保留文字段。这条记录接着成为主意识 session 里的一条用户消息，并带上 `conversation`，供下一次 `send_text` 照抄。

## 连接配置

账号、端口和 token 直接读 Elysium 现有的 `config/plugins/napcat_adapter/config.toml`。当前是反向 WebSocket，本进程等 NapCat 连进来。`direct` 则由本进程去连 NapCat。

Elysium 已经占用配置里的 `8087`。NapCat 的 `onebot11_3427056465.json` 因此另有一条名为 `conscious-mind` 的 websocket client，指向 `ws://127.0.0.1:8097`。插件用 `port: 8097` 挂在这条连接上，原来给 Elysium 的那条保持不动。

## 验收

在 NapCat 已经连上这个 QQ 号的前提下：

1. 从小星星的私聊发来一句文字，主意识 session 里出现一条用户消息，`conversation` 是 `qq:private:<她的 QQ>`。
2. 用这一次的 `conversation` 调用 `send_text`，`channel` 为 `qq`，`content` 为两行非空文字。QQ 窗口里先后出现两条消息。
3. 再从同一个窗口回一句，session 里再出现一条用户消息，`conversation` 与第一次相同。
