# AGENTS.md

Constraints for work in this repository. `dsh/` carries its own upstream rules
at `dsh/AGENTS.md`; read those before changing anything inside it.

## What "ElyH" means

**ElyH** is the shorthand for this project (this repository directory:
`Elysium-AyerElysia/Elysium/Elysia-Harness`). Whenever an instruction, doc, or
conversation mentions ElyH, it means **this project directory's DSH** — the
application assembled from this checkout's `dsh/` vendored source, `plugins/`,
and `homes/`. It does not mean upstream DSH, a global npm package, another
machine's install, or the desktop profile under the user's `.dsh` directory.

## Where things live

| Path | Owns |
|---|---|
| `dsh/` | Vendored DSH source. Treat as a dependency: prefer adapting around it over patching it, and record any patch that is unavoidable. |
| `plugins/*` | Our packages. Each is a Cordis plugin with a `dsh.bundle.patch`, so it mounts and unmounts independently. |
| `homes/web`, `homes/tui` | One harness home per surface. Profile definitions are tracked; sessions, logs, credentials, and installed plugin deps are not. |
| `homes/shared` | Configuration both surfaces read, such as model providers. |
| `docs/` | Architecture notes. `docs/architecture.md` is the current ElyH extension architecture: Tool Provider, Event Adapter, Service, Policy, and UI over the DSH base. It is not a session-level "conscious mind" design. Read it before adding a tool, channel ingress, context provider, or orchestration behavior. |

## Rules

- **A plugin never edits `dsh/`.** If the harness needs different behavior, add a
  bundle row or a patch layer above it.
- **A setting belongs to one surface or to both, never implicitly.** Model
  providers go in `homes/shared`; anything one surface alone needs stays in its
  own home.
- **Tracked means reproducible.** If a file changes when a surface runs, it is not
  tracked. `.gitignore` states which paths those are and why.
- **Never commit credentials.** `.credentials.yaml` and `.env` stay ignored in
  every home.
- **Each plugin keeps its own test.** A plugin that mounts but cannot be removed
  cleanly is incomplete.

## Working on a plugin

All plugin work follows the project template and acceptance baseline:
[`docs/architecture/elyh-plugin-spec.zh.md`](docs/architecture/elyh-plugin-spec.zh.md).
A new plugin needs: a `package.json` whose name is `@elysia/<name>`, the
`dsh.bundle.patch` field pointing at its `cordis.patch.yml`, a `tsconfig.json`
extending the vendored harness base, and rows in the profile that mount it.

Non-negotiable invariants from that spec:

- **One plugin, one package.** A Host half and its strongly-coupled Web page
  ship in the same package (`dsh.client` + `dsh.bundle`); do not split them into
  two packages. There is no shared Host core package in the current target.
- **One bundle row.** `cordis.patch.yml` mounts the plugin once. Add the package
  to both the profile's `dependencies` and `dsh.profile.bundles`; remove both
  together.
- **Tool plugins are ordinary tool plugins.** They register with
  `ctx.tools.register()` at mount and dispose at unmount. They do **not** expose
  a `global` switch, do not maintain a private enabled state, and do not need
  the orchestrator to function.
- **The orchestrator is one plugin.** **Elysia/VillV-Helix** (`@elysia/villv-helix`)
  owns the session tool face in one Host + Client package. It pulls actual tool
  definitions, applies per-session `tools.restrict()` masks to global tools,
  locks official preset static tools, gates custom preset static tools through
  `tools/pre-execute`, and renders the tool/preset views. It has no external
  core dependency. Context events are owned by `@elysia/context-gate`, not by
  Helix.
- **Preset management is Elysia/Mobius-Infinity.** `@elysia/mobius-infinity`
  keeps preset management, but no longer exposes a “模型全局注入” switch.
- **No "conscious mind" or "subconscious" plugin types.** Those are product
  narratives. Split old implementations into Tool Provider, Event Adapter,
  Service, Policy, and UI contributions.
- **Every tool and context event carries a Chinese name.** Tool display names
  come from plugin metadata and fall back to the tool id when absent. Context
  kinds declare `nameZh` at registration. A new plugin without a Chinese name
  is incomplete.
- **Context events belong to Context Gate, not the tool face.** Providers call
  `contextGate.registerContextKind()` and `contextGate.publish()`; registration
  is disposed with `ctx.effect`. Context Gate is independent of the session
  orchestration mode. A provider without Context Gate must degrade explicitly,
  not invent a private bus the UI cannot see.
- **No plugin-level global injection switches.** The session tool face in
  VillV-Helix is the only place that changes tool visibility. Do not reintroduce
  “为模型全局注入……” switches or a core/catalog state machine.
- **No polling between capability UIs.** Session limits, tool changes, and open
  views are event-driven. A timer that re-reads a snapshot every few seconds is
  a regression.
- **Service mount is asynchronous.** Never use a one-shot `ctx.get()` followed
  by a permanent `return` during `apply`. Wait with `ctx.inject(...)`, await the
  service's readiness, and register from an effect.
- **Everything is disposable and tested.** Every tool, context kind, listener,
  timer, and slot registration lives inside `ctx.effect`; state stays under the
  harness home; the plugin has host and client tests plus `typecheck`, `test`,
  `build`, and `bundle` (when it has a client).

```powershell
cd plugins\<name>
pnpm install        # when dependencies changed
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle     # only when the package has dsh.client
```