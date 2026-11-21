# @elysia/qq-napcat

English | [中文](README.zh.md)

The QQ channel plugin. It connects NapCat's OneBot socket to the conscious mind's `send_text`.

It follows Elysium's `plugins/napcat_adapter`: text send and receive use only `send_private_msg` and `send_group_msg`, over the existing reverse or forward WebSocket. Images, voice, pokes, and group administration are out of scope here.

## Conversation windows

`channel` is always `qq`. `conversation` selects one window on this QQ number:

| Window | id |
|---|---|
| Direct | `qq:private:<userId>` |
| Group | `qq:group:<groupId>` |

`userId` and `groupId` are the positive-integer strings NapCat events carry. The inbound message puts this id into the user message, and `send_text` copies it back into `conversation` unchanged.

## Sending

The plugin registers on mount:

```ts
ctx.outboundText.register('qq', async (delivery) => {
  const target = parseQqConversation(delivery.conversation)
  // private -> send_private_msg { user_id, message }
  // group   -> send_group_msg   { group_id, message }
  // delivery.replyTo 有值时，message 前加 { type: 'reply', data: { id } }
  return { messageId }
})
```

`send_text` has already split the content on `\n` into one segment per message. Each segment here sends exactly one message and is not split again. A NapCat receipt timeout throws `OutboundDeliveryUnknown`; any other failure throws an ordinary error. On success `messageId` is the `message_id` OneBot returned.

## Receiving

A NapCat `message` event becomes:

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

The bot's own echo (`sender.user_id === self_id`) is dropped. `text` keeps only the text segments. The record then becomes one user message in the conscious mind's session, carrying `conversation` for the next `send_text` to copy.

## Connection settings

Account, port, and token are read directly from Elysium's existing `config/plugins/napcat_adapter/config.toml`. The current mode is reverse WebSocket: this process waits for NapCat to connect. `direct` makes this process dial NapCat instead.

Elysium already holds the `8087` in that configuration. NapCat's `onebot11_3427056465.json` therefore carries an additional websocket client named `conscious-mind` pointing at `ws://127.0.0.1:8097`. The plugin mounts on that connection with `port: 8097`, leaving the Elysium connection untouched.

## Acceptance

With NapCat already connected to this QQ number:

1. Send one line of text from Xiaoxingxing's direct chat. One user message appears in the conscious mind's session with `conversation` equal to `qq:private:<her QQ>`.
2. Call `send_text` with that `conversation`, `channel` `qq`, and a `content` of two non-empty lines. Two messages appear one after the other in the QQ window.
3. Reply once more from the same window. Another user message appears with the same `conversation`.
