# @elysia/conscious-mind

English | [中文](README.zh.md)

Elysia's conscious mind: one agent, one long-lived session.

The plugin does not redo the session log, compaction, prompt assembly, or tool loop the Harness already provides. The prefix, sending tool, inbound queue, and conscious-mind reply turn are its own.

## Prefix

The prefix is the stable identity section of the system prompt. The fixed prompt files all live in one directory. The plugin does not scan that directory; it reads the file names named in its configuration, in order, and concatenates them into one section.

Both the directory and the file names are written in this plugin's configuration, for example:

```yaml
baseDir: /home/ayerelysia/Elysia/Data/standing-prompts
files:
  - SOUL.md
  - USER.md
  - MEMORY.md
  - EXISTENCE.md
  - TOOLS.md
```

`baseDir` may be absolute. A relative path resolves against the process's current directory when the plugin mounts. The Harness has no "prompt directory" setting; `personaPrefix` accepts only one string hardcoded in configuration. This plugin's own config field holds the directory path.

Loading reuses `ctx.systemPrompt.section()`. It registers a section with `complete: true` and `interpolate: false` whose `text` is a function. The agent loop calls `assemble()` at every model step, and the function reads the files in `files` order at that moment, joining them with a blank line. The section's `text` callback is synchronous, and a `complete` section is finalized before the asynchronous waterfall, so this uses a synchronous disk read rather than `ctx.fs.readText`. `interpolate: false` keeps any `{{` in the body literal. `complete` makes this section the whole system prompt, covering the Harness's own `harness:identity`.

If `SOUL.md` is unreadable or empty, the turn aborts instead of continuing on the previous turn's cache. Any other missing or empty file in the list is skipped. File names must stay inside that directory.

Elysia's five bodies are not in this package; they live in `/home/ayerelysia/Elysia/Data/standing-prompts`: `SOUL.md`, `USER.md`, `MEMORY.md`, `EXISTENCE.md`, `TOOLS.md`.

File changes are not watched either. Neither `ctx.fs.watch` nor the Chokidar the skill directory uses is wired to the system prompt, and `system-prompt/change` fires only when a prompt section is registered or unmounted, not when a file's content changes. The next `assemble()` re-reads from disk; the agent loop compares the rendered section against the current `system/message`, and a difference makes `SystemPromptProjection` update it. A route that declares `systemPromptUpdate: 'in-history'` with an ongoing request sequence appends the new prefix after the history; otherwise the opening entry is replaced in place. Editing files while a session is idle has no effect until the next model step reads them.

Which chat she is in and how a livestream should be joined are not written into the prefix. Those are the setting the inbound message carries. Speaking habits belong in these files, not in plugin code.

## send_text

> Status: the tool is implemented. QQ, Feishu, and KOOK `conversation` formats are defined by their own channel plugins. Inter-segment pauses and proactive outreach remain open.

`send_text` is how the conscious mind sends text to an external channel. Channels are QQ, Feishu, KOOK, and comparable entry points added later.

Assistant text the model writes directly stays in that session and appears on no channel. To make it visible to the other person, she must call `send_text`. Speaking is thus a deliberate act, not a leak.

This tool mirrors Elysium's `life_send_text`. The four inner fields `thought`, `mood`, `decision`, and `expected_response` are retained: they are inner records the subject personally submits within the same act of expression, not a backfill of provider reasoning, and unlike assistant text the session log passively retains. That explicit record serves persona continuity and post-training; the DSH ledger supplements it, not replaces it.

One semantic difference from Elysium: `content` is split on newlines into multiple messages. In Elysium `\n` only formats within one message; here `\n` *is* the segmentation.

## pending

Inbound messages do not each get their own reply. Channel adapters are intended to call the conscious mind's `inboundPending.receive()`, entering one shared pending list. KOOK is connected; QQ and Feishu still await this integration. Each new message resets the collection wait; after 1.2 seconds of quiet, the queue **drains every event waiting at that moment**, preserving arrival order and mixing channels and conversations when necessary. Messages arriving during the reply stay pending and enter the next collection wait after the turn ends. A successful turn does not automatically retry an event merely because its conversation received no reply; a failed turn puts the whole batch back at the front of the in-memory queue.

## Conscious-mind reply turn

When the Harness provides the `agents` service, the plugin connects pending to the conscious mind automatically. She has one agent and one long-lived session with the fixed id `elysia-conscious-mind`: reuse a live agent first, then try resume. If resume fails and no concurrently resumed agent is available, the code still attempts create under the same id; it does not yet distinguish a missing session from other resume failures. Each batch becomes one user message delivered through `followup()` to the native Harness agent loop, and the driver awaits `whenIdle()`. The Harness owns the model, session history, compaction, and tool calls; there is no separate chat-completions fetch.

This session exposes `send_text`, DSH's native `read_image`, and the scoped `pass` tool. Other global tools, including code, file mutation, and search tools, are masked. `read_image` reads existing local image files; inbound chat images use the separate attachment-admission path. `pass` requires `reason`, records why she chose silence, and touches no channel. She may answer one or more conversations or stay silent; the runtime forces neither choice. Drained events remain in the long session history. The older `createSendTextTurn` remains available for standalone experiments but is not the reply turn installed by the ElyHarn service.

## send_text parameters

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `channel` | string | yes | Channel name: `qq`, `feishu`, `kook`, and comparable names registered later. |
| `conversation` | string | yes | Which conversation. The format is defined by each channel plugin; the inbound message carries this setting and a reply copies it back. |
| `thought` | string | yes | The concise inner activity the subject chooses to submit this time. Must be non-empty natural language, not backfilled from provider reasoning or `content`, and not used as visible text; an empty value fails the whole call. |
| `mood` | string | yes (key) | The current mood. Pass an empty string when there is no definite emotion; never invent a default. |
| `decision` | string | yes (key) | How to respond or act. Pass an empty string when genuinely inapplicable; do not copy `content`. |
| `expected_response` | string | yes (key) | What the other person is expected to do or feel after reading it. Pass an empty string when there is no definite expectation. |
| `content` | string | yes | Plain text written last and sent to the other person. Never put thought, reason, or other metadata in it. |
| `reply_to` | string | no | Message id to quote-reply to. Attaches only to the first segment after splitting. Omitted by default in direct messages. |

One call submits the four inner fields and the body together; they land in the same model trace as the final reply.

### Schema

Registered with `defineTool`. The parameter root is one object, and a key's `required: true` compiles into the JSON Schema `required` array. DSH's string type offers only `enum` and `const`, with no `minLength`, so "the key must appear" and "`thought` must have content" are two different things. The former comes from the Schema; the latter is checked in `execute`: if it is empty after trimming, the call fails and nothing is sent. `mood`, `decision`, and `expected_response` accept empty strings.

`channel` is not written as an enum. New channels register at mount time, and adding one name must not require editing the Schema.

```ts
defineTool({
  name: 'send_text',
  description: '把文字发到外部渠道。assistant 正文不会出现在任何渠道上。先写 thought、mood、decision、expected_response，最后写 content。content 里的换行会拆成多条消息。thought 必须是这次真实的非空思考。',
  parameters: {
    channel: {
      type: 'string',
      required: true,
      description: '渠道名，例如 qq、feishu、kook。必须是已经登记的渠道。',
    },
    conversation: {
      type: 'string',
      required: true,
      description: '这个渠道上的哪一段对话。入口消息里带着，回复时照抄。',
    },
    thought: {
      type: 'string',
      required: true,
      description: '这次表达自己写下的内心活动。必须非空。不要从 reasoning 或 content 回填，也不要写进发出去的正文。',
    },
    mood: {
      type: 'string',
      required: true,
      description: '此刻的心情。没有明确情绪时传空字符串，不要编造默认情绪。',
    },
    decision: {
      type: 'string',
      required: true,
      description: '决定如何回应。不适用时传空字符串，不要复制 content。',
    },
    expected_response: {
      type: 'string',
      required: true,
      description: '预期对方看到后的反应。没有明确预期时传空字符串。',
    },
    content: {
      type: 'string',
      required: true,
      description: '最后才写的、发给对方的纯文本。换行拆成多条消息。不要写入 thought、reason 等元信息。',
    },
    reply_to: {
      type: 'string',
      description: '要引用的消息 id。只挂在拆分后的第一段。私聊默认省略。',
    },
  },
})
```

The parameter Schema the model receives is:

```json
{
  "type": "object",
  "properties": {
    "channel": { "type": "string", "description": "渠道名，例如 qq、feishu、kook。必须是已经登记的渠道。" },
    "conversation": { "type": "string", "description": "这个渠道上的哪一段对话。入口消息里带着，回复时照抄。" },
    "thought": { "type": "string", "description": "这次表达自己写下的内心活动。必须非空。不要从 reasoning 或 content 回填，也不要写进发出去的正文。" },
    "mood": { "type": "string", "description": "此刻的心情。没有明确情绪时传空字符串，不要编造默认情绪。" },
    "decision": { "type": "string", "description": "决定如何回应。不适用时传空字符串，不要复制 content。" },
    "expected_response": { "type": "string", "description": "预期对方看到后的反应。没有明确预期时传空字符串。" },
    "content": { "type": "string", "description": "最后才写的、发给对方的纯文本。换行拆成多条消息。不要写入 thought、reason 等元信息。" },
    "reply_to": { "type": "string", "description": "要引用的消息 id。只挂在拆分后的第一段。私聊默认省略。" }
  },
  "required": ["channel", "conversation", "thought", "mood", "decision", "expected_response", "content"]
}
```

A successful `execute` returns a value with a Schema too. `sent` contains only the segments already handed to the channel, in split order. When the whole call fails and nothing was sent, `sent` is an empty array.

```ts
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sent: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', required: true },
            text: { type: 'string', required: true },
            messageId: { type: 'string' },
          },
        },
      },
      stoppedAt: { type: 'integer' },
      error: { type: 'string' },
    },
  },
}
```

### Splitting on `\n`

One call's `content` is split on newlines into several segments, each sent as an independent platform message in order:

- `\r\n` and `\r` normalize to `\n` first, then the text is split on `\n`;
- each segment is trimmed, and empty segments are not sent;
- if no non-empty segment remains, the whole call fails and nothing is sent;
- a segment containing only a placeholder such as an ellipsis is not sent (following Elysium's discipline);
- a brief pause is inserted between segments to imitate continuous typing (the pacing parameter is open);
- `reply_to` applies only to the first segment.

### Routing

`send_text` does not implement QQ, Feishu, or KOOK connections or protocols. Each channel plugin registers its sending capability into one shared entry point (channel name to sending capability) when it mounts; `send_text` looks up by `channel` and hands the body and destination to that channel plugin. A channel name that is not registered is an explicit error, never a silent drop and never a redirect to another channel.

### Failure semantics

- A failure on any segment stops the call; later segments are not attempted;
- segments already sent are not resent automatically, avoiding duplicate expression;
- delivery outcomes (success, failure, unknown state, and the platform message id) come back as the tool result unchanged, and she decides whether to say it again;
- each call's full arguments and result naturally enter the session log; no separate ledger is needed.

### Open questions

- Who owns the inter-segment pause duration: `send_text` uniformly, or each channel plugin;
- Proactive outreach: whether sending into a conversation with no inbound setting should first pass an explicit arbitration (Elysium uses the `nucleus_proactive_query` and `nucleus_proactive_command` pair);
- The shape of the channel plugin registration interface (a Cordis service or an event). The QQ, Feishu, and KOOK conversation formats are defined by `qq-napcat`, `feishu-app`, and `kook-bot` respectively.

## Terminal entry

In the `deepseek-harness` directory, using Node 22:

```sh
pnpm exec tsx --tsconfig tsconfig.base.json packages/elysia/conscious-mind/src/tui.ts
```

On that machine Node 22 and pnpm are in `/home/ayerelysia/.local/share/node-v22/bin`. `/quit` exits.

Every turn re-assembles the prefix and sends it as the system message. The model defaults to `providers.NexusAI` in Elysium's `config/models.toml`, model name `gemini-3.8-flash`. `ELYSIA_BASE_URL`, `ELYSIA_API_KEY`, `ELYSIA_MODEL`, or `--base-url`, `--model` replace those. `--once "one sentence"` asks a single turn.

This entry prints the model's text to the terminal; it does not send to QQ, Feishu, or Kook yet.
