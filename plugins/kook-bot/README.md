# @elysia/kook-bot

English | [中文](README.zh.md)

The KOOK channel plugin. It connects the Bot Elysium already uses to the conscious mind's `send_text`.

The account is not stored twice. The Bot Token comes from `config/plugins/kook_adapter/config.toml`.

## Conversation windows

`channel` is always `kook`.

| Window | id |
|---|---|
| Direct message | `kook:direct:<userId>` |
| Channel | `kook:channel:<channelId>` |

`userId` and `channelId` are the positive-integer strings KOOK events carry. The inbound message carries this id, and a reply copies it back into `conversation` unchanged.

## Sending

Direct messages use `/direct-message/create`; channels use `/message/create`. When `use_kmarkdown` is true the message type is 9, otherwise 1. When `reply_with_quote` is true, `replyTo` goes into `quote`. Each segment sends one text message.

## Receiving

Text (type 1), KMarkdown (type 9), and images (type 2) inside Gateway signal 0 become:

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

The bot's own messages are dropped. With `listen: true` the plugin opens the Gateway. One token can hold only one gateway, and connecting again displaces the running Elysium instance.

`forwardKookInbound` handles events in arrival order. Text goes directly through DSH `admitPromptContent()`; images are downloaded over HTTPS without sending the Bot Token to the image URL, then admitted through the same path. On success, observers receive the original channel event through `kook/message`, while shared pending receives text and durable `ImageAttachmentRef` values. Raw Base64 and image URLs never enter the conscious-mind event or Session. A download, format, or attachment-validation failure keeps the whole event out of pending and logs the error rather than emitting an `[image]` placeholder. Pending only collects and wakes; this plugin never decides how to reply.

`kookInboundText` remains only for the text-only direct-message history helper; live Gateway ingress uses `kookInboundEvent`.

## Deployment switches

The web surface's `scripts/dsh-web.sh` exports `ELYSIA_KOOK_CONFIG` (Elysium's kook_adapter config), so the profile mounts this plugin and registers the `kook` sender.

Since 2026-10-26 KOOK belongs to ElyHarn: the Python-side kook_adapter has been disabled since 2026-10-23 16:23 (`enabled = false`, gateway stopped), and `dsh-web.sh` exports `ELYSIA_KOOK_LISTEN=1` by default so this plugin holds the gateway. One token keeps one socket — when running several ElyHarn surfaces, every other surface must boot with `ELYSIA_KOOK_LISTEN=0`.
