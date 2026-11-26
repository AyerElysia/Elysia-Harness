# @elysia/capability-panel

The ElyH capability panel: the Web UI that shows the shared tool catalog, the
per-preset/per-session switches, context subscriptions, and the Host
diagnostics.

This package is an **optional consumer** of
[`@elysia/capability-core`](../capability-core/README.md). It contains the
browser panel plus a tiny Host entry that ensures the core exists; the core
itself owns the catalog, global/preset/session state, the step gate, the call
guard, context delivery, change events, and persistence. There is no React or
client code in the core package.

## Mounting

- Panel alone: its Host entry calls `ensureCapabilityCore`; the panel opens even
  when no preset plugin is installed.
- Preset manager alone: the preset manager also calls `ensureCapabilityCore`;
  the panel is not required for the model tools.
- Both installed, either mount order: both consumers reuse one root-owned core;
  the panel sees the same catalog and switch state the preset manager writes.

The package's Host entry has no tool implementation of its own. `stateDir` in
the row config is the core document directory and is the canonical
`dshHomePath('capability-core')`; the preset manager passes the same value as
its `coreStateDir`. `hostState` and the context delivery limits are passed
through on the first core mount.

## Panel behavior

- **Tools:** static tools from the selected preset are locked; dynamic catalog
  entries can be switched per preset or session. The effective state is
  `session > preset > global`.
- **Context events:** subscribe or unsubscribe a kind per preset/session; the
  live event log and diagnostic rows are read-only views.
- **Actual state:** the panel renders the Host snapshot, not an invented
  default. A refused write is reported as a notice and the panel refreshes.
- **Sync:** the preset manager dispatches `elysia:capability-changed` after a
  core switch write; the panel refreshes immediately on that browser event or
  its BroadcastChannel counterpart (and on `visibilitychange`). There is no
  polling interval.

## Tests

`pnpm test` runs the client API, view, state, error, and mount specs (60 tests).
The Host/core specs — catalog, global scope, gate, guard, persistence, context
bus, capability set, and `ensureCapabilityCore` — live in the core package.