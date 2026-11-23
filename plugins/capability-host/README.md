# @elysia/capability-host

The ElyH capability plugin (Host + Web panel, v1.3). It answers two questions
per session: **which dynamic tools may it call**, and **which context events
reach it**. Static tools belong to the preset and are read-only here.

Host and browser half ship from this one package: the Host service owns state,
gates, the context bus, and the Remote namespace; the `dsh.client` half renders
the management panel. Installing or removing the bundle installs or removes
both together, so the pair never diverges.

## What it owns

| Module | Responsibility |
|---|---|
| Dynamic tool catalog | Provider-declared entries: `scope`, factory, required services, group, failure mode |
| Step gate | `preset → session` merge for dynamic tools, explicit `false` override, `when` for global entries, call-level guard |
| Static tool probe | Reads `agentPresets.compositionInventory()`, maps tool modules to ids, marks them `locked` |
| Context bus | Publications, per-session queues and cursors, subscription AND visibility, dedupe, TTL, active/passive, backpressure, merged snapshot |
| State store | `stateDir` document, version 1, atomic write, dynamic switches only, unknown-id diagnostics, offline session map |
| Session registry | Live Agents from `ctx.agents` plus persisted session-to-preset mappings |

## Exports

```ts
import * as capabilityHost from '@elysia/capability-host'                // Host plugin:
                                                                         // name, inject, Config, apply
import * as capabilitySet from '@elysia/capability-host/capability-set'  // generic bridge
```

`@elysia/capability-host/capability-set` mounts in an Agent or preset scope. It
contains no tool list: it reads the Host catalog, registers the agent-scoped
entries switched on in that scope, and re-syncs on `capability-host/change`.
Unmounting disposes every registration it made.

The package patch mounts one bundle row whose `dsh.client` metadata ships the
browser half; both halves install, bundle, and uninstall together. It
deliberately does **not** mount `@deepseek-ai/dsh-tool-web`: a preset's static
tool face is owned by preset-manager's preset rows.

## Static tools: preset-owned, locked

A preset's `definition.plugins` rows decide its static tool face. The Host reads
each preset through `agentPresets.compositionInventory()` and keeps only tool
modules (`@deepseek-ai/dsh-tool-*` or `…/tools`, the same rule preset-manager
uses). Prompt files, clocks, compaction, and command rows are not tools and are
skipped silently.

A known module maps to its tool ids (`@deepseek-ai/dsh-tool-web` →
`web_search`, `web_fetch`). An unmapped tool module is still displayed under its
module name with a `STATIC_TOOL_UNMAPPED` diagnostic, so an unknown row is
visible rather than dropped.

Static rows are `origin: 'static'`, `locked: true`, `registered: true`, and carry
`sourcePresetId`. They are always on for every session of that preset. They are
**not** in the dynamic catalog, are never registered or unregistered by this
package, and `setTool` refuses them:

```
capabilityHost/TOOL_STATIC_LOCKED — 预设默认工具，不能关闭
```

When a dynamic entry carries the same id as a static tool, shadowing is
**per preset, not global**. The dynamic entry stays registered; the preset that
composes the static tool registers it in its own scope, and DSH's scoped layers
shadow the global registration only for that preset's Agents. Every other preset
keeps and can switch on the dynamic tool. The snapshot carries no global shadow
flag: the client derives shadowing for the scope it renders from the static rows'
`sourcePresetId` and the dynamic entry's id. `setTool` follows the same rule —
only a static id of the *target* scope is refused with `TOOL_STATIC_LOCKED`.

## Dynamic tools

A provider declares an entry through `ctx.capabilityHost.registerTool()`:

```ts
ctx.capabilityHost.registerTool({
  id: 'app_reply',
  scope: 'global',
  description: 'Reply over the bound app channel.',
  required: ['someTransportService'],
  group: 'reply',
  failureMode: 'loud',
  factory: ctx => defineTool({ /* … */ }),
})
```

- **Global entries** are registered once with
  `ctx.tools.register(definition, { when: ({ agent }) => gate.evaluate(agent, id) })`.
  `when` is evaluated per step, so a switch flipped by the panel applies on the
  next step without re-registration. A tool whose `when` is false has no schema,
  no PTC binding, and cannot execute: a hard call returns `UNKNOWN_TOOL`. The
  static face never passes through `when`.
- **Agent-scoped entries** are never registered by the Host. A Capability Set row
  mounts them in the scope that owns their services, with the same `when` gate,
  so a preset-scope row still gates per session.
- **Required services** are probed once at registration. A missing one marks the
  entry unavailable with a diagnostic instead of failing the Host; a factory
  that throws fails registration loudly.
- An unknown `scope` value is refused at registration.
- The built definition is published on `CatalogRecord.schema`.
- `ctx.tools.guard()` adds the call-level backstop: a tool switched off after the
  step started is denied before its body runs. The Host registers that guard for
  global entries and the Capability Set registers it for the agent-scoped entries
  it owns. Only an admitted call is denied; a tool already absent from the step
  falls through to the registry's `UNKNOWN_TOOL`. A guard failure denies
  (fail-closed).

### Merge order

1. Static tools are always on and cannot be switched.
2. A preset switch applies to every session running that preset.
3. A session switch adds a dynamic tool or overrides the preset with an explicit
   `false`; an unlisted dynamic tool inherits the preset and otherwise stays off.

A fail-loud group (the `reply` safety baseline) fails step preparation when the
gate cannot resolve it; an optional dynamic extension is hidden and recorded.

## Context events

```ts
ctx.capabilityHost.registerContextKind({ kind: 'app.message', description: '…' })
const receipt = await ctx.capabilityHost.publish({
  kind: 'app.message',
  source: 'app-bridge',
  summary: 'Inbound message from 圈子/ops',
  payload: { text: '…' },
  visibility: { presetIds: ['elysia-conscious'] },
  active: true,
  dedupeKey: 'appmessage:42',
})
```

- Target selection is **AND**: a session must be subscribed (by its preset or
  by the session itself) *and* inside `visibility`. A publisher can only narrow
  the target set.
- `payload` must be JSON-serializable. The bus stores the JSON round trip and
  copies it per subscriber, so no mutable object is shared across sessions.
  Oversized payloads are refused (`EVENT_TOO_LARGE`) and the queue is untouched.
- `dedupeKey` suppresses a repeat within the kind's TTL; queues drop the oldest
  event past `maxQueueDepth` and record a diagnostic.
- **Passive** events wait for the session's next step. **Active** events also
  wake one turn through `agent.followup()`, coalesced per session while a wake-up
  is pending, so a burst cannot manufacture unbounded turns.
- One global `agent/pre-step` listener injects one merged snapshot per step:
  `source.kind = 'elysia-context-relay'`, `form: 'snapshot'`, and the previous
  snapshot is retired with `surfaceOp: 'replace'`. The `snapshot` form is what
  keeps the relay out of the Router's external-input test; it annotates a turn
  rather than opening one. A real inbound message must still be delivered as a
  `user/message` by its bridge.
- Queues, cursors, and dedupe state persist with the document, so an idle
  session keeps its events across a restart. Consumption is committed before the
  step appends the snapshot; if injection itself fails, nothing is consumed and
  the next step retries.
- `hostState: 'paused'` keeps queueing and injects nothing until resumed. The
  state is process-local.

## State document

`<stateDir>/capability-state.json`, version 1, written through a temporary file
and one rename:

```json
{
  "version": 1,
  "presets": { "elysia-conscious": { "tools": { "app_reply": true }, "contexts": { "app.message": true } } },
  "sessions": { "<sessionId>": { "tools": { "app_reply": false } } },
  "sessionPresets": { "<sessionId>": "elysia-conscious" },
  "queues": {
    "<sessionId>": {
      "events": [],
      "consumed": ["…"],
      "dedupe": { "appmessage:42": 1763758800000 }
    }
  },
  "updatedAt": "2026-11-22T00:00:00.000Z"
}
```

Only dynamic switches are stored. Static tools come from the preset composition
and are never written here. Switches are boolean maps so an explicit `false`
override is unambiguous. A v1.1 document that still carries a `base` array is
read normally and the field is ignored.

Unknown stored tool ids and context kinds are reported as diagnostics and kept;
they never block the rest of the document. A malformed document, a
non-absolute `stateDir`, or an unsupported version fails the mount.

## Remote API

Namespace `capabilityHost`.

| Method | Argument | Result |
|---|---|---|
| `list` | — | `CapabilitySnapshot`: static + dynamic tools, kinds, scopes, sessions, diagnostics |
| `setTool` | `scope`, `toolId`, `enabled` | `void` |
| `setContext` | `scope`, `eventKind`, `enabled` | `void` |
| `publish` | `ContextEventInput` | `PublishReceipt` |
| `status` | — | `HostStatus`: static/dynamic tool, context, gate, session accounting |

`ScopeRef` is `{ kind: 'preset'; id } | { kind: 'session'; id }`. A stale
`{ kind: 'base' }` is refused with `SCOPE_READ_ONLY`; there is no writable scope
for static tools.

Refusals carry `capabilityHost/<CODE>`: `TOOL_UNKNOWN`, `TOOL_STATIC_LOCKED`,
`CONTEXT_UNKNOWN`, `SCOPE_NOT_FOUND`, `SCOPE_READ_ONLY`, `SCOPE_INVALID`,
`GATE_FAILED`, `EVENT_INVALID`, `EVENT_TOO_LARGE`, `EVENT_PAYLOAD_INVALID`,
`STATE_INVALID`, `STATE_WRITE_FAILED`, `TOOL_REGISTRATION_FAILED`,
`NOT_AUTHORIZED`, `NOT_READY`.

Every switch change is recorded in the in-process audit trail
(`caps.auditLog()`): timestamp, action, scope, id, and the value after the
change.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | required | Absolute directory holding the panel document |
| `hostState` | `enabled` | Initial delivery state |
| `contextTtlMs` | `900000` | Default age ceiling for undelivered events |
| `contextMaxBytes` | `65536` | Default per-event size ceiling |
| `contextQueueDepth` | `64` | Default undelivered events per session |
| `snapshotMaxEvents` | `16` | Events merged into one snapshot |
| `snapshotMaxBytes` | `8192` | Bytes of one merged snapshot |
| `ownerId` | unset | Principal allowed to mutate switches |

## Known Limitations and Deferred Work

- **No real channel, communication, or scheduling tool ships here.** Only the
  fixtures in `src/probe-tools.ts` exist, and the Host does not register them; a
  spec declares them through the provider API.
- **`STATIC_TOOL_MODULES` is deliberately short.** It maps only the verified
  `@deepseek-ai/dsh-tool-web` row; every other tool module is shown as an
  unmapped locked row rather than guessed.
- **Static tools are re-read on every `list`, `status`, and `setTool`.** A
  preset created after the Host mounted appears on the next panel read, not
  immediately. Re-reading never changes dynamic registrations: same-name
  shadowing is resolved by DSH per scope.
- **Authorization is a placeholder.** `ownerId` compares a Remote principal when
  one exists; there is no product authorization service yet, so the hook is
  marked `TODO(product-auth)` and admits in-process callers.
- **Archived sessions are not pruned automatically.** `forgetSession()` exists,
  but nothing subscribes to session archival yet.
- **`hostState` is not persisted.** A restart returns to the configured value.
- **The preset-scope branch of the Capability Set is not covered by a unit
  spec.** It resolves its scope through `agentPresets.composedPreset(ctx)`; the
  specs exercise the Agent-scope path, because mounting a preset scope belongs to
  the preset registry's composition, not to this package.
