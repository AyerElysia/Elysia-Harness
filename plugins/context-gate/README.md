# @elysia/context-gate

**Display identity:** Elysia/Context-Gate · 爱莉希雅 · 门扉

Provider-registered context kinds, per-session subscriptions, per-session
queues, and one merged snapshot injected before each step. The gate is the
generic context-event manager of the ElyH extension layer: source plugins decide
which events may be published and provide their params and admitted content;
the gate owns subscription, queueing, TTL, dedupe, backpressure, batching, and
injection. It is independent of VillV-Helix and of its tool editing mode.

Per-plugin contract: [`docs/plugins/context-gate.zh.md`](../../docs/plugins/context-gate.zh.md).

## What it owns

| Surface | Responsibility |
|---|---|
| Host service `contextGate` | Kind registration, publication, subscriptions, queues, event log, and the Remote snapshot |
| Context bus | Envelope normalization, TTL, dedupe, visibility, per-kind queue backpressure, merged pre-step injection, and batching of active wake-ups |
| State document | Per-session subscriptions, queues, and the injection log under `context-gate-state.json` |
| Web views | Context subscriptions and the injection log, registered by the client half |

Out of scope: tool registration and tool visibility (VillV-Helix), preset
management (Mobius-Infinity), Helix's tool editing mode, channel ingress
sources (Channel-IM / Ayla-Channel), Session-Communication, Event-Scripts,
native Schedule interception, and health/status counters. Providers publish
through this service; the gate is ready for those source plugins.

## Host API

`ContextGate` (`ctx.contextGate`) is a `TypertRemoteService` on the
`contextGate` namespace.

```ts
registerContextKind(registration: ContextKindRegistration): () => void
publish(input: ContextEventInput): Promise<PublishReceipt>
subscribe(sessionId: string, kind: string): Promise<void>
unsubscribe(sessionId: string, kind: string): Promise<void>
```

The Remote surface is exactly two endpoints:

| Endpoint | Result |
|---|---|
| `contextGate/list` with `{ sessionId }` | `ContextSnapshot`: `{ contexts: ContextEntry[], events: EventLogEntry[] }` |
| `contextGate/setContext` with `{ sessionId, kind, enabled }` | `void` |

`ContextEntry` carries `kind`, `nameZh`, `description`, `ttlMs`, `backlog`, and
`enabledBy` (keyed by session id). `EventLogEntry` carries `id`, optional
`eventId`, `kind`, optional `source`, optional `origin`, optional `summary`,
optional `causationId`, `outcome`, `at`, and optional `detail`. There is no
`status`, health, or `HostStatus` surface.

Refusals cross the wire as `contextGate/<CODE>`: `CONTEXT_UNKNOWN`,
`SESSION_NOT_FOUND`, `EVENT_INVALID`, `EVENT_PAYLOAD_INVALID`,
`EVENT_TOO_LARGE`, `STATE_INVALID`, `STATE_WRITE_FAILED`.

## Event envelope

```ts
interface ContextEventInput {
  id?: string
  kind: string
  source: string
  origin?: {
    plugin: string
    instance?: string
    sessionId?: string
    channel?: string
    conversation?: string
  }
  summary: string
  params?: unknown
  content?: ContentBlock[]
  visibility?: ContextVisibility
  active?: boolean
  dedupeKey?: string
  ttlMs?: number
  maxBytes?: number
  causationId?: string
  createdAt?: number
}
```

- `source` is the compatibility producer id. `origin` adds optional
  plugin/instance/session/channel/conversation provenance.
- `params` is the structured JSON body. The old `payload` field is still
  accepted as a compatibility alias; new providers should use `params`.
- `content` is a list of content blocks the source plugin has already
  admitted. The gate validates that it is JSON-serializable and bounded, then
  appends the blocks to the injected message unchanged.
- `causationId` records the event or action that caused this publication.
- `source`, `origin`, and `causationId` are metadata for the log and causal
  chain. None of them filters delivery.

## Delivery

A publication reaches a session only when that session subscribed the kind and
the publisher's `visibility.sessionIds` allows it. A publisher can narrow the
target set, never widen it.

- **Queue** — events are stored per session, oldest first. A dedupe key is
  scoped to its kind and source, and a repeat within the kind's TTL suppresses
  the publication for that session. Retaining more than `maxQueueDepth` events
  of one kind drops the oldest event of that kind and logs a `dropped` row;
  other kinds in the same session are unaffected.
- **Injection** — `agent/pre-step` merges the unexpired queue into one
  `user/message` with source kind `context-gate-context-relay` and
  `form: 'snapshot'`. Each event contributes its rendered summary and
  `params` to the text block, and its admitted `content` blocks follow in
  publication order. Consumed ids are committed before the message enters the
  loop, and the previous relay snapshot is replaced rather than accumulated.
- **Batching** — the first active event starts a quiet window (`batchMs`,
  default 1200 ms). Further active events inside that window extend the
  window; `maxWaitMs` (default 5000 ms) caps total postponement from the first
  event. When the window closes while the Agent is idle, the gate opens one
  follow-up turn. Passive events never open a turn.
- **Busy Agent** — no second turn is opened. Events stay queued and drain at
  the next pre-step; if a turn ends before that step, the `agent/status` idle
  transition re-arms the batch.
- **Disposal** — the pre-step listener, status listener, and every quiet-window
  timer are registered through `ctx.effect`, so unmounting the plugin leaves no
  timer or listener behind.

Every queued mutation for one session is serialized through a per-session
promise chain, so a publication cannot overwrite a concurrent injection.

## State

`stateDir` is `dshHomePath('context-gate')`. The document is
`context-gate-state.json`:

```json
{
  "version": 1,
  "sessions": {
    "s1": {
      "contexts": { "demo.ping": true },
      "events": [{
        "id": "row-1",
        "eventId": "evt-1",
        "kind": "demo.ping",
        "source": "demo",
        "origin": { "plugin": "demo", "instance": "example" },
        "summary": "hello",
        "causationId": "evt-parent",
        "outcome": "consumed",
        "at": 0,
        "detail": "injected evt-1"
      }]
    }
  },
  "queues": {
    "s1": {
      "events": [{
        "id": "evt-1",
        "kind": "demo.ping",
        "source": "demo",
        "origin": { "plugin": "demo", "instance": "example" },
        "summary": "hello",
        "params": { "n": 1 },
        "content": [{ "type": "text", "text": "admitted body" }],
        "visibility": {},
        "active": false,
        "dedupeKey": "evt-1",
        "createdAt": 0
      }],
      "consumed": [],
      "dedupe": {}
    }
  },
  "updatedAt": "2026-11-28T00:00:00.000Z"
}
```

The document is separate from every other plugin's state. New envelope fields
are additive and optional; a document written before the generic envelope is
read without a version bump, and a later write emits only fields the current
build knows. Each write goes through a temporary file and one rename.

## Composition

The package is one bundle row in `cordis.patch.yml`:

```yaml
- insert:
    - id: elysia-context-gate
      name: '@elysia/context-gate'
      config:
        stateDir: !!js dshHomePath('context-gate')
```

Add `@elysia/context-gate` to the profile's `dependencies` and
`dsh.profile.bundles` to mount it. Providers declare a kind inside an effect
and publish through the service:

```ts
ctx.inject(['contextGate'], scope => {
  const gate = scope.get('contextGate')
  if (gate === undefined) return
  scope.effect(() => gate.registerContextKind({
    kind: 'demo.ping',
    nameZh: '示例事件',
    description: 'One line describing the event body.',
    activeByDefault: false,
  }), 'demo.context-kind')
  scope.effect(() => {
    void gate.publish({
      kind: 'demo.ping',
      source: 'demo',
      origin: { plugin: 'demo', instance: 'example' },
      summary: 'hello',
      params: { n: 1 },
      content: [{ type: 'text', text: 'admitted body' }],
    })
    return () => {}
  }, 'demo.publish')
})
```

No VillV-Helix row is required. Without the orchestrator the gate still
registers kinds, queues events, injects at pre-step, and serves the Remote
panel.

Context Gate is also the manager for Channel-IM, Ayla-Channel,
Session-Communication, and Event-Scripts. Those source plugins show their
manage switch only while this service is mounted; without it they are forced
standalone and show no switch.

## Develop

```powershell
cd plugins/context-gate
pnpm install          # one project-local workspace; `link:` deps reach ../../dsh
pnpm run typecheck    # tsc --noEmit
pnpm test             # vitest, Host behavior
pnpm run build        # emits lib/ for the Host
pnpm run bundle       # emits lib/client.js for the Web shell
```

The package is outside the vendored `dsh/` workspace, so it resolves workspace
packages through `node_modules` links to the vendored build (`lib/`), the
artifact plane the shipped profiles load. Tests mount the real AgentLoop
dependencies and the real pre-step waterfall; no Helix plugin is
mounted.

## Known Limitations and Deferred Work

- **No channel ingress sources.** The gate accepts publications and exposes the
  subscription surface; QQ/KOOK/Feishu/Ayla adapters are future rows.
- **No Host-push change event for the browser.** The two views use a
  browser-local window/BroadcastChannel notification and refresh after their own
  writes; they do not poll.
- **Live-session writes.** `list`, `setContext`, and the Host
  `subscribe`/`unsubscribe` helpers require a live Agent. A publication may
  still queue for a persisted session whose subscription is in the document.
- **A single Host owns the document.** The store serializes within one process;
  two Host processes sharing one `stateDir` are not coordinated.