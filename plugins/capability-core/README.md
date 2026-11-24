# @elysia/capability-core

Host-only capability core for ElyH. It has **no React, no client bundle, and no
dependency on the capability panel package**.

The core owns one source of truth for:

- the dynamic tool catalog (`registerTool`, `registerToolName`);
- global, preset, and session tool switches;
- the effective-state gate (`session > preset > global`);
- the step `when` condition and the call-level guard;
- change events (`capability-core/change` plus the legacy
  `capability-host/change` alias);
- persistence and restart recovery.

The panel package (`@elysia/capability-host`) and the preset manager both
consume this service. Either can mount it when the other is absent.

## Mounting and sharing

`ensureCapabilityCore(ctx, config)` checks the application root for the service
and mounts one root-owned core on first use. Concurrent consumers share the
same in-flight mount; a consumer that starts later reuses the provided service.
The panel and the preset manager both call it, so either of these works:

- only the preset manager installed;
- only the panel installed;
- both installed in either order.

The core's tool switches are persisted in `<stateDir>/capability-state.json`.
`global` is the deployment-wide default; `presets` and `sessions` store explicit
overrides. An explicit preset `false` hides a globally enabled tool for that
preset, and a session override wins over both.

## Service surface

The service keeps the `capabilityHost` name for the panel's existing Remote
namespace. It exposes:

| Operation | Purpose |
|---|---|
| `registerTool(entry)` | Register a catalog entry; global entries are gated by the step `when`. |
| `registerToolName(id, nameZh)` | Attach a Chinese panel label to a directly registered tool. |
| `globalTools()` | Read `{ enabled, stored }` for every global catalog entry. |
| `setTool(scope, id, enabled)` | Write a global, preset, or session switch. |
| `isEnabled(agent, id)` | Resolve the effective state for one Agent. |
| `list()` | Read the panel snapshot (tools, contexts, scopes, diagnostics). |

`setTool` writes the document, emits the change event, and lets the step gate
and call guard read the same state. Tools are never re-registered to toggle
them.

## Configuration

The row config is `stateDir` plus optional delivery limits (`hostState`,
`contextTtlMs`, `contextMaxBytes`, `contextQueueDepth`, `snapshotMaxEvents`,
`snapshotMaxBytes`, `ownerId`). The core's Host entry is a normal bundle row when
a deployment wants it explicitly; consumers can also mount it on demand.

## Tests

`pnpm test` covers the catalog, global/preset/session precedence, persistence,
the step `when`, the call guard, context delivery, the capability set, and
`ensureCapabilityCore` (29 tests).