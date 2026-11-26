# ElyH v1 plugin archive

Archived on 2026-11-21 from `plugins/*` before the v2 preset/capability-host rewrite. The capability core and panel split was retired later, on 2026-11-26, after orchestration was consolidated into `villv-helix` and preset management into `mobius-infinity`. These packages are **not mounted** by the local Web or TUI profiles. The server was not touched.

## Contents

- `ayla-app`
- `capability-core` — retired host-side capability library; no bundle row
- `capability-panel` — retired panel split; superseded by the `villv-helix` Web panel
- `conscious-mind`
- `context-inspector`
- `dsh-livestream`
- `feishu-app`
- `gemini-cascade`
- `kook-bot`
- `memory`
- `proactive-system`
- `qq-napcat`
- `request-archive`
- `session-communication`
- `session-compaction`
- `subconscious`
- `voice-call`

## Local profile changes

The local Web and TUI profiles no longer declare `@elysia/*` dependencies, bundles, or Cordis rows. The only retained installed plugins are:

- `@liustack/modsearch`
- `@linxin666/dsh-remote-web-ui`
- `dshmarket` / `@deepseek-ai/dsh-experimental-plugin-market-bundle`
- `billion-context`

`pnpm-lock.yaml` and pnpm's `node_modules` metadata may retain historical `@elysia/*` entries until the next `pnpm install`; they are not mounted by the local profiles.

Original manifests are preserved under `_profile-backups/`:

- `homes/web/profiles/web/cordis.patch.yml`
- `homes/web/profiles/web/package.json`
- `homes/web/profiles/web/pnpm-lock.yaml`
- `homes/tui/profiles/tui/cordis.patch.yml`
- `homes/tui/profiles/tui/package.json`
- `homes/tui/profiles/dsh-tui/cordis.patch.yml`
- `homes/tui/profiles/dsh-tui/package.json`
- `homes/tui/profiles/_core/package.json`

## Restore

Move the package directory back to `plugins/<name>`, restore the matching profile manifests if needed, and run the profile install. Do not restore only the Cordis rows without the package declarations: the loader resolves mounted packages from the profile's `node_modules`.