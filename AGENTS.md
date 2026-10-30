# AGENTS.md

Constraints for work in this repository. `dsh/` carries its own upstream rules
at `dsh/AGENTS.md`; read those before changing anything inside it.

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

```sh
cd dsh && pnpm install
pnpm --filter @elysia/<name> test
```

A new plugin needs: a `package.json` whose name is `@elysia/<name>`, the
`dsh.bundle.patch` field pointing at its `cordis.patch.yml`, a `tsconfig.json`
extending `../../dsh/tsconfig.base.json`, and a row in the profile that mounts it.
