# Session Compaction

Mounts DSH's native compaction capabilities on every existing and future Agent Session.

- A Session without a compaction service receives `BasicCompactionEngine` with `auto: true`.
- A Session without `/compact` receives the native `CommandCompact` command.
- Existing services and commands are preserved. The conscious mind therefore keeps its intentional manual-only policy.
- Agent-owned fibers are also disposed when this Host plugin unloads.

Mount the plugin early in each surface profile. Session presets and fixed-channel integrations do not need to import this package themselves.
