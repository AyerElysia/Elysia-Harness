# @elysia/feishu-app

English | [中文](README.zh.md)

The Feishu channel plugin. It connects the self-built app Elysium already uses to the conscious mind's `send_text`.

The account is not stored twice. `app_id`, `app_secret`, and the API base URL come from `config/plugins/feishu_adapter/config.toml`.

## Conversation windows

`channel` is always `feishu`.

| Window | id |
|---|---|
| Direct | `feishu:private:<open_id>` |
| Group | `feishu:chat:<chat_id>` |

An `open_id` starts with `ou_`; a `chat_id` starts with `oc_`. The inbound message carries this id, and a reply copies it back into `conversation` unchanged.

## Sending

When `reply_to_message` is true and a `replyTo` is present, delivery uses Feishu's message-reply endpoint. Otherwise a direct message uses `receive_id_type=open_id` and a group uses `receive_id_type=chat_id`. Each segment sends one text message.

## Receiving

Text from `im.message.receive_v1` on the long connection becomes:

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

Messages the app itself sent are dropped. With `listen: true` the plugin opens this long connection. One Feishu app can hold only one, and connecting again displaces the running Elysium instance.
