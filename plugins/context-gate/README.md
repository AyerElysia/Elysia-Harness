# @elysia/context-gate

**Display identity:** Elysia/Context-Gate · 爱莉希雅 · 门扉

Context Gate is the ElyH context-event platform. It owns provider-registered
event kinds, generic event envelopes, per-session subscriptions and queues, TTL,
dedupe, per-kind backpressure, batched pre-step injection, and the injection log.
It also owns the merged custom-event engine and the per-session time engine.

Per-plugin contract: [`docs/plugins/context-gate.zh.md`](../../docs/plugins/context-gate.zh.md).

## Event layers

```text
Layer 1  source plugins (Channel-IM / Ayla-Channel / Session-Communication)
         register kinds and publish trigger events; multi-session subscriptions
Layer 2  ContextGate custom rules/scripts; generated events; multi-session subscriptions
Layer 3  ContextGate per-session time events; timer / timer preset / absence; no subscriptions
```

`Event-Scripts` is not a separate package. Its declarative templates, sandboxed
scripts, internal triggers, and external HTTP/webhook triggers live here.

## What it owns

| Surface | Responsibility |
|---|---|
| Event registry | required `nameZh` / description, traffic limits, subscription parameter schema |
| Subscriptions | per-session kind state; source-defined params such as session/source multiselect, all, future sessions |
| Queues | durable per-session events, TTL, dedupe, per-kind backpressure |
| Injection | one merged snapshot at `agent/pre-step`; active batching and passive next-step |
| Time engine | once / after / RRULE / seconds / timezone / absence; own scheduler, no native DSH Schedule |
| Timer presets | templates; adoption creates independent per-session instances, never fan-out |
| Custom events | templates and isolated scripts over internal/external triggers |
| Manager | Channel-IM / Ayla-Channel / Session-Communication; manage switch only while mounted |
| UI | `事件 | 定时 | 日志` views; independent of the tool editing mode |
| Error log | published / queued / delivered / consumed / failed / dropped |

## Time events

- A timer belongs to the session where it was created.
- A session may own many timers.
- A timer fires into its owner only; it is not a subscribable kind.
- A timer preset is a template; other sessions adopt it into their own instances.
- Absence watches global `lastSeenByKind`; it does not require a subscription.
- Native DSH Schedule is not imported, mounted, or intercepted.

## Modes

Context Gate is a manager, not a standalone source. It has no manage switch.
Channel-IM, Ayla-Channel, and Session-Communication may run standalone when this
manager is absent; the manage switch only appears while the manager service is
available. Modes are explicit and mutually exclusive.

## Views

```text
工具 | 预设 | 事件 | 定时 | 日志
```

With the tool editing mode off:

```text
事件 | 定时 | 日志
```

## State

```text
stateDir = dshHomePath('context-gate')
file     = context-gate-state.json
```

The document holds subscriptions, queues, timer instances/presets/absence,
rule definitions/runtime, and the bounded event log. It is separate from
`villv-helix-state.json`.

## Development

```powershell
cd plugins/context-gate
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

Host and client tests must cover mount/unmount, event envelope compatibility,
multi-session subscriptions and params, queues/injection, time rules and
absence, custom rules/scripts, tabs, and failure recovery.