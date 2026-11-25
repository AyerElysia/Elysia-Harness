# @elysia/villv-helix

**Display identity:** Elysia/VillV-Helix · 维尔薇 · 螺旋

The session-level capability panel. It is the original `@elysia/capability-panel`
page — tool categories, folding, counts, bulk selection, draft/save, tool-group
presets, static tools, context subscriptions, the event log, and health — with
one change of granularity: the panel manages the **current session**, not a
preset or a global scope.

The entry is one native Conversation view named **能力**, registered on
`conversation.view`. Its body is the ported panel page. There is no floating
drawer, no second tab strip, and no sidebar page.

## What it owns

| Surface | Responsibility |
|---|---|
| Host service `villvHelix` | Reads the real global tool definitions, installs per-session `tools.restrict()` deny masks on every live Agent, owns the context bus, the event log, health, and the state document |
| Context bus | Provider-registered kinds, per-session subscriptions and queues, dedupe, TTL, backpressure, one merged snapshot per step, and the active-event wake-up |
| State document | Per-session disabled tools, context subscriptions, queues, and event log; plus the shared tool-group preset library |
| View `conversation.view` id `capabilities` | The ported panel page for the active session |

Out of scope: registering tools, preset management, session creation or
switching, a plugin-level global enable flag, and any dependency on
`@elysia/capability-core` or `@elysia/capability-panel`.

## Session scope

- There is exactly one `ScopeRef`: `{ kind: 'session', id }`. Every
  `villvHelix/list`, `status`, `setTool`, and `setContext` call names that
  session; the client adapter binds it when the view is registered.
- A global tool is **enabled by default**. Disabling it stores the id in the
  session document and installs `agent.ctx.tools.restrict({ deny: [...] })` on
  the live Agent, so schemas, lookup, and execution all agree.
- A preset's static tools are registered in the Agent scope. The Host reports
  them as `origin: 'static'` with `locked: true`; `setTool` refuses them with
  `villvHelix/TOOL_STATIC_LOCKED`.
- A global row whose id a static row shadows stays registered but is not offered
  as a switch; the client derives that from the static id set.
- The preset/session scope switcher, the preset list, and the workspace filter
  are removed by design: the Conversation view already selects the session.

## Context events

Providers declare kinds and publish through the service:

```ts
ctx.inject(['villvHelix'], scope => {
  const helix = scope.get('villvHelix')
  if (helix === undefined) return
  scope.effect(() => helix.registerContextKind({
    kind: 'demo.ping',
    nameZh: '示例事件',
    description: 'One line describing the payload.',
    activeByDefault: false,
  }), 'demo.context-kind')
})
```

A publication reaches a session only when that session subscribed the kind and
the publisher's `visibility.sessionIds` allows it. A subscribed, expired, or
over-capacity event produces a `dropped` log row; a consumed snapshot produces
`consumed`. The merged snapshot is a `user/message` with source kind
`villv-helix-context-relay` and `form: 'snapshot'`, injected through
`agent/pre-step`.

## State

`stateDir` is `dshHomePath('villv-helix')`. The document is
`villv-helix-state.json`, rewritten through a temporary file and one rename.
Tool-group presets are a shared library: applying one rewrites the session draft,
and saving one captures the tools the session currently has enabled.

## Verification

```powershell
cd plugins/villv-helix
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

Tests mount the real DSH tool registry and Agent scope through the AgentLoop
testkit: the mask cases assert `ctx.tools.schemas(agent)`, not a stub.

## Known Limitations and Deferred Work

- The panel refreshes on its own writes, on the cross-panel browser event, and
  on page visibility. It does not subscribe to a server-push channel, so a
  provider that registers a kind while the panel is open appears after a
  refresh.
- Static-tool attribution uses the session header's recorded `agentPreset`. A
  session whose header carries no preset still lists its static rows, without a
  "source preset" badge.
- The two tool parent groups are display-only. `DSH base tools` follows the
  base bundle's global tool ids; `Other global tools` holds optional packages
  (plugin market, Cordis inspection, external MCP) and any id this build does
  not classify. The Host has no per-tool provider metadata, so the split cannot
  be derived from registration ownership.
- Tool-group presets are shared across sessions; only their application target
  is session-scoped.
- `tools.restrict()` can only remove global tools. The panel does not promise to
  switch preset- or Agent-scoped tools, and it does not.
- One `conversation.view` entry serves every session. Native per-session tab
  visibility is not a slot capability, so the 能力 tab is always registered.