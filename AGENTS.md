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
| `docs/` | Architecture notes. `docs/architecture.md` states the target shape (one session, four channel ingresses) and marks what is done versus still missing; read it before changing how a channel reaches the conscious mind. |

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

- **One plugin, one package.** A Host half and its strongly-coupled Web panel
  ship in the same package (`dsh.client` + `dsh.bundle`); do not split them into
  two packages.
- **One bundle row.** `cordis.patch.yml` mounts the plugin once. Add the package
  to both the profile's `dependencies` and `dsh.profile.bundles`; remove both
  together.
- **Context events must register with the panel.** Providers call
  `capabilityHost.registerContextKind()` on mount and publish through
  `capabilityHost.publish()`; registration must be disposed with `ctx.effect`.
  A context provider without `capabilityHost` fails loud rather than hiding an
  event kind from the panel.
- **Tools are not forced into the panel.** Ordinary tools may register directly
  with `ctx.tools.register()`; only tools that need per-preset panel switches or
  tool groups use `capabilityHost.registerTool()`. Do not register the same tool
  through two paths.
- **Global tool registration is opt-in and off by default.** Every tool-providing
  plugin exposes a boolean `global` config defaulting to `false`; when false it
  must not register tools in the root scope. Preset/Agent-scoped tools are
  unaffected.
- **Actual state, not invented defaults.** The panel displays the tool state that
  is actually mounted; do not make checkboxes claim a default the runtime does
  not have. Explicit panel off-switches are authoritative and survive restart.
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
