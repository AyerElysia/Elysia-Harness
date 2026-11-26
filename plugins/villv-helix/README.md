# @elysia/villv-helix

**Display identity:** Elysia/VillV-Helix · 维尔薇 · 螺旋

VillV-Helix owns the **session tool face**: official preset lock, custom-preset static gating, managed extension tools, the tool panel, and the tool-editing-mode capsule.

It does **not** own context events. Those live in [`@elysia/context-gate`](../context-gate/README.md): subscriptions, durable queues, batched injection, and the injection log.

## What it owns

| Surface | Responsibility |
|---|---|
| Host service `villvHelix` | Reads real tool definitions, installs per-session `tools.restrict()` deny masks, mounts managed tool suites, gates custom-preset static tools, and persists tool-face state |
| Tool face | Official preset static tools are locked; custom preset static tools are gated without duplicate registration; managed extension tools keep stable declarations |
| State document | Per-session tool-editing flag, enabled tools, disabled tools, tool-group preset library; legacy context fields are ignored |
| View `helix-tools` | Tool categories, static card, bulk selection, draft/save, tool-group presets |
| View `helix-preset` | Current preset static tools, system prompt, prompt-file preview (read-only) |
| Header capsule | Tool editing mode |

## Tool semantics

```text
official preset static   locked / TOOL_STATIC_LOCKED
custom preset static     pre-execute gate / disabled => schema + UNKNOWN_TOOL
Helix extension          stable declaration / disabled => schema + UNKNOWN_TOOL
custom + managed id      switchable special row, never a locked static row
```

`tools.restrict()` only handles global tools. It cannot revoke a preset/Agent-scoped registration; the custom static case uses `tools/pre-execute`.

## Context views

The `事件` and `日志` conversation views belong to `@elysia/context-gate`. They are registered independently and stay visible when tool editing mode is off. The `工具` and `预设` tabs are hidden in that mode.

## Event API

Providers register and publish through the Context Gate service:

```ts
ctx.inject(['contextGate'], scope => {
  const gate = scope.get('contextGate')
  if (gate === undefined) return
  scope.effect(() => gate.registerContextKind({
    kind: 'demo.ping',
    nameZh: '示例事件',
    description: 'One line describing the payload.',
    activeByDefault: false,
  }), 'demo.context-kind')
})
```

Do not register context kinds or queues in Helix.

## Status

- stateDir: `dshHomePath('villv-helix')`
- document: `villv-helix-state.json`
- tool-group presets are shared; application target is session-scoped
- no health/status surface
- no Server push; UI refreshes on its own writes, cross-panel browser events, and visibility

## Verification

```powershell
cd plugins/villv-helix
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

The tests mount the real DSH tool registry and Agent scope through the AgentLoop testkit. Context tests live in `plugins/context-gate/tests`.