# @elysia/conscious-mind

English | [中文](README.zh.md)

Elysia's conscious mind: one agent, one long-lived session.

The plugin does not redo the session log, compaction, prompt assembly, or tool loop the Harness already provides. The prefix, sending tool, inbound queue, and conscious-mind reply turn are its own.

## Prefix

Standing prompts are composed per agent/session, not across the deployment. `src/standing-prompts.ts` exports the Cordis subplugin `@elysia/conscious-mind/standing-prompts`. It must be mounted in an agent scope; mounting it globally fails. The conscious-mind runtime still owns pending and outbound services, but no longer registers a global complete prompt. Ordinary sessions therefore do not inherit the main conscious mind's file prefix from that runtime.

The scoped plugin takes these fields:

| Field | Meaning |
|---|---|
| `baseDir` | Non-empty prompt directory. Absolute paths are used directly; relative paths resolve against the process cwd when the plugin mounts. |
| `files` | Non-empty, ordered list of unique file names inside the directory. No directory scan or automatic file selection. |
| `required` | Files that must exist and be non-empty; defaults to `['SOUL.md']`. Every required name must also be in `files`. |
| `complete` | Defaults to `true`: the joined text is the scoped agent's complete system prompt. `false` registers an ordinary section alongside other prompt sections. |

For example, a scoped plugin row can use:

```yaml
baseDir: /home/ayerelysia/Elysia/Data/standing-prompts
files:
  - SOUL.md
  - USER.md
  - MEMORY.md
  - EXISTENCE.md
  - TOOLS.md
required:
  - SOUL.md
complete: true
```

The main runtime's own configuration retains `baseDir`, `files`, and `required`; it passes them to this subplugin with `complete: true` in `composeMainAgent`. The same setup callback is supplied to main-agent create and resume. The existing main session id `elysia-conscious-mind` and its cwd `/home/ayerelysia/Elysia/Elysium/Elysia-Harness/homes/web/conscious-mind` are unchanged. This code does not rewrite an existing session header or edit the subject's prompt files.

The main runtime snapshots the selected configuration for its turn handler. The file selection is part of that agent's composition and is not reselected each turn. Contents are re-read in the configured order at each `systemPrompt.assemble()`, trimmed, and joined with a blank line. Missing or empty required files abort assembly; optional missing or empty files are skipped, while other read errors propagate. File names cannot escape the directory. There is no file watcher or fallback to a cached prefix.

Loading reuses `ctx.systemPrompt.section()` with `interpolate: false` and a synchronous `text` callback. Literal `{{` stays literal. In complete mode, the section supplies this scoped agent's whole prompt, including replacing the Harness identity; it does not replace other sessions' prompts. DSH's existing prompt projection handles changes on the next model step. Editing a file while the session is idle does not itself trigger a turn.

The Web profile currently adds one `elysia` preset, mounting the same scoped subplugin with the five files above. `elysia-core` remains a requirement, with no configured preset yet. A preset-created session is separate from the platform main session. Preset composition across a real restart still needs verification. The main runtime accepts a borrowed live agent only when its scope has a matching completed composition receipt; it does not automatically migrate an older unscoped agent. The standalone terminal entry also mounts this subplugin in its own scope.

The subject's prompt bodies live outside this package. This plugin reads the selected files; it does not author or migrate their text. Channel/conversation setting stays in inbound events rather than being written into the stable prefix.

## File capabilities

`@elysia/conscious-mind/file-capabilities` mounts DSH's native filesystem/search plugins as children of the target agent scope. Text/search tools are not enabled on the host plane: ordinary standard and minimal sessions retain their previous tool catalog and native filesystem policy. The main session mounts it with the standing-prompt selection; Web presets can mount the same plugin independently. `workspaceDir` is the recursive read/write root. `baseDir` grants access only to the exact names in `files`, and `read_image` remains workspace-only. `.migration`, backup paths, unlisted prompt files, paths escaping through symlinks, and detectable hard links are denied. The immutable session cwd header stays unchanged; the working-directory service sets this agent's effective directory to the workspace. An omitted search path is checked against that actual effective directory.

Prompt mutation requires a byte-for-byte backup in `backupDir` before DSH executes. A backup failure denies the mutation. Required prompt files cannot become empty, and `maxPromptBytes` defaults to 65,536 UTF-8 bytes, including the line endings DSH preserves. Literal dollar sequences in edits remain literal text. The guard leaves DSH's observation, stale-version, unique-match, and atomic-write rules in control; a later native rejection can leave a harmless pre-mutation backup. Successful prompt mutations prune backups to `backupRetention` (default 20) per file. Backups are maintenance-only and cannot be read through these tools.

Search admission checks the complete canonical result as well as its displayed metadata, so presentation limits cannot hide an escaped path or hard link from the guard. The whole result is blocked if any returned path violates admission. Unloading the file-capabilities fiber removes its native tools and guards; a failed child mount or later main-agent composition also cleans up the acquired plugins. This is a path policy around native tools, not a shell or a kernel isolation boundary; concurrent changes by external processes still require normal filesystem ownership. Engineering agents and migration scripts do not author the subject's prompt bodies through this feature.

## send_text

> Status: the tool is implemented. QQ, Feishu, and KOOK `conversation` formats are defined by their own channel plugins. Inter-segment pauses and proactive outreach remain open.

`send_text` is how the conscious mind sends text to an external channel. Channels are QQ, Feishu, KOOK, and comparable entry points added later.

Assistant text is the reply for local DSH chat and call transcripts. External channel inputs carry trusted provenance, and `send_text` delivers text to those channels. An explicit request from a local DSH turn to send elsewhere uses DSH's native question panel to confirm the destination and content before delivery.

This tool mirrors Elysium's `life_send_text`. The four inner fields `thought`, `mood`, `decision`, and `expected_response` are retained: they are inner records the subject personally submits within the same act of expression, not a backfill of provider reasoning, and unlike assistant text the session log passively retains. That explicit record serves persona continuity and post-training; the DSH ledger supplements it, not replaces it.

One semantic difference from Elysium: `content` is split on newlines into multiple messages. In Elysium `\n` only formats within one message; here `\n` *is* the segmentation.

## pending

Inbound messages do not each get their own reply. Channel adapters are intended to call the conscious mind's `inboundPending.receive()`, entering one shared pending list. KOOK is connected; QQ and Feishu still await this integration. Each new message resets the collection wait; after 1.2 seconds of quiet, the queue **drains every event waiting at that moment**, preserving arrival order and mixing channels and conversations when necessary. Messages arriving during the reply stay pending and enter the next collection wait after the turn ends. A successful turn does not automatically retry an event merely because its conversation received no reply; a failed turn puts the whole batch back at the front of the in-memory queue.

## Conscious-mind reply turn

When the Harness provides the `agents` service, the plugin connects pending to the conscious mind automatically. She has one agent and one long-lived session with the fixed id `elysia-conscious-mind`. A live agent is reused only after its completed prompt/tool composition receipt matches the selected configuration. With no live agent, the runtime tries resume. If resume fails and no compatible concurrently resumed agent is available, the code still attempts create under the same id; it does not yet distinguish a missing session from other resume failures. An incompatible live agent instead fails explicitly without followup, leaving the inbound batch pending. Each batch becomes one user message delivered through `followup()` to the native Harness agent loop, and the driver awaits `whenIdle()`. The Harness owns the model, session history, compaction, and tool calls; there is no separate chat-completions fetch.

On the create/resume setup path, `composeMainAgent` installs the scoped prefix and exposes `send_text`, `send_voice`, DSH's native `read`, `read_image`, `write`, `edit`, `glob`, `grep`, and the scoped `pass` tool. Setup success is recorded in a process-local WeakMap keyed by the agent context, using a fingerprint of the fixed prompt configuration rather than file contents. Repeated setup with the same configuration reuses its promise; a different configuration is rejected. The receipt is cleared when the scope is disposed. Existing or concurrently recovered live agents are borrowed only with a matching completed receipt; an older uncomposed instance must go through normal scoped restoration rather than having its header or history rewritten. Code execution and other global tools remain masked. The file tools use the scoped admission rules below; `read_image` reads admitted workspace images; inbound chat images use the separate attachment-admission path. `pass` requires `reason`, records why she chose silence, and touches no channel. She may answer one or more conversations or stay silent; the runtime forces neither choice. Drained events remain in the long session history. The older `createSendTextTurn` remains available for standalone experiments but is not the reply turn installed by the ElyHarn service.

## Main-session context isolation

The main agent suppresses optional DSH runtime context in its own scope. After the `agent/pre-step` producers finish, a source-based filter removes only `agent-instructions` and `runtime-context` messages for the fixed main session. Ordinary user messages mentioning `AGENTS.md` and other sessions remain untouched. During setup, previously visible messages from those two framework sources receive empty surface replacements; the original events and source references remain in the durable log. Empty replacements are not repeated, and other sources, including existing checkpoints, remain visible.

The agent scope owns both registrations. Failed composition immediately removes the filter and runtime suppressor; scope disposal also cleans them up. This does not change the session id/cwd or rewrite subject files or existing events.

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

## send_voice

`send_voice` synthesizes spoken text with the fixed local BreezeTTS voice and routes the audio through a registered voice sender. The optional `expression_instruction` controls this expression without changing the reference voice. It reports `sent`, `synthesis-failed`, `send-failed`, or `unknown` rather than automatically synthesizing or sending again.

KOOK voice delivery is implemented: upload once, prefer a native voice message, and fall back to an audio-file message only after the platform explicitly rejects the native type. QQ and Feishu voice senders are still pending. `send_voice` does not accept an existing audio path. The updated requirement reserves one shared `send_file(channel, conversation, path)` for existing images, audio, video, and other files, with shared file checks and channel-specific delivery. `send_file`, `OutboundFile`, and its adapter registrations are not implemented yet.

## Terminal entry

From this checkout's `dsh/` directory, using Node 22:

```sh
pnpm exec tsx --tsconfig tsconfig.base.json ../plugins/conscious-mind/src/tui.ts
```

On that machine Node 22 and pnpm are in `/home/ayerelysia/.local/share/node-v22/bin`. `/quit` exits.

Every turn re-assembles the prefix and sends it as the system message. The model defaults to `providers.NexusAI` in Elysium's `config/models.toml`, model name `gemini-3.8-flash`. `ELYSIA_BASE_URL`, `ELYSIA_API_KEY`, `ELYSIA_MODEL`, or `--base-url`, `--model` replace those. `--once "one sentence"` asks a single turn.

This standalone entry uses its own scoped prompt composition and process-local history, then makes its own model request. It prints the model's text to the terminal; it does not drive the persistent platform main session or send to QQ, Feishu, or Kook.
