# @elysia/context-gate

**Display identity:** Elysia/Context-Gate · 爱莉希雅 · 门扉

Context Gate is the ElyH context-event platform. It owns provider-registered
event kinds, generic event envelopes, per-session subscriptions and queues, TTL,
dedupe, per-kind backpressure, batched pre-step injection, the injection log,
the per-session time engine, and the merged custom-event rule engine.

Per-plugin contract: [`docs/plugins/context-gate.zh.md`](../../docs/plugins/context-gate.zh.md).

## Event layers

```text
Layer 1  source plugins (Channel-IM / Ayla-Channel / Session-Communication)
         register kinds and publish trigger events; multi-session subscriptions
Layer 2  ContextGate custom rules/scripts; generated agent.script.* events; multi-session subscriptions
Layer 3  ContextGate per-session time events; timer / timer preset / absence; no subscriptions
```

`Event-Scripts` is not a separate package. Its declarative templates, isolated
scripts, internal triggers, and external HTTP/webhook triggers live here.

## What it owns

| Surface | Responsibility |
|---|---|
| Event registry | required `nameZh` / description, traffic limits, subscription parameter schema |
| Subscriptions | per-session kind state; source-defined params such as session/source multiselect, all current, future sessions |
| Queues | durable per-session events, TTL, dedupe, per-kind backpressure |
| Injection | one merged snapshot at `agent/pre-step`; active batching and passive next-step |
| Time engine | once / after / RRULE / seconds / timezone / absence; own scheduler, no native DSH Schedule |
| Timer presets | templates; adoption creates independent per-session instances, never fan-out |
| Custom events | declarative conditions over internal DSH events, time, absence, HTTP poll, webhook; isolated scripts |
| Manager | Channel-IM / Ayla-Channel / Session-Communication; manage switch only while mounted |
| UI | `事件 | 定时 | 日志` views; independent of the tool editing mode |
| Error log | published / queued / delivered / consumed / failed / dropped |

## Time events

- A timer belongs to the session where it was created.
- A session may own many timers.
- A timer fires into its owner only; it is not a subscribable kind.
- A timer preset is a template; other sessions adopt it into their own instances.
  Editing a preset never changes an already adopted timer.
- Absence watches global `lastSeenByKind`; it does not require a subscription.
- Native DSH Schedule is not imported, mounted, or intercepted.
- RRULE and time-zone arithmetic use the vendored general
  `@deepseek-ai/dsh-util-time` wrapper (rrule + Temporal), not the Schedule
  engine. A missed repeating round fires once and then resumes from the current
  time.
- Each timer persists its own schedule `anchorAt`; firing never changes it, so
  a bare RRULE without DTSTART cannot drift. Replacing the schedule or resuming
  a paused timer moves the anchor.

## Custom event rules

Rules generate exactly one subscribable kind, `agent.script.<ruleId>`. Raw
internal event payloads stay Host-side: generated events carry the rule id,
trigger name, session id, and tool name only. A rule can observe
`session/event`, `tool/call`, `tool/result`, `turn/start`, `turn/end`,
`job/registered`, `job/settled`, `subagent/start`, and `subagent/end`, plus its
own time/absence condition, an HTTP poll, or an authenticated webhook.
Composite triggers (`all`, `any`, `not`, `sequence`) combine internal, time,
absence, HTTP-poll, and webhook children; `not` accepts one internal child.

Scripts are async function bodies evaluated in a worker thread with a heap
ceiling and a wall-clock budget; Node `vm` is used as a language sandbox, not as
the security boundary. A failing script is recorded on the rule and does not
fail ContextGate or other rules. Rule updates are hot-reloaded by re-registering
the generated kind and trigger schedule.

HTTP poll rules are denied unless the hostname is in
`ruleHttpAllowedHosts`; the default is empty. Redirects are refused, responses
are size-bounded, and webhook secrets are stored only as SHA-256 hashes.

## Model tools

```text
timer_create  timer_list  timer_update  timer_pause  timer_cancel
timer_preset_create  timer_preset_list  timer_preset_adopt
absence_create  absence_list  absence_update  absence_cancel
event_rule_create  event_rule_list  event_rule_update  event_rule_test
event_rule_pause  event_rule_resume  event_rule_cancel
```

Every description states the semantic split: a pure time event uses `timer_*`;
a condition or script over events uses `event_rule_*`. Chinese display names are
supplied as tool metadata and registered with VillV-Helix when it is mounted.

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

The three views register unconditionally at orders 22 / 23 / 24. `定时` is a
separate view, not a section of `事件`. No view renders an in-page tab strip;
the native Conversation tab strip owns navigation. Timers, timer presets,
absence reminders, and non-composite rules can be edited inline; editing a
preset leaves adopted timers unchanged.

## State

```text
stateDir = dshHomePath('context-gate')
file     = context-gate-state.json
```

The document holds subscriptions and parameter values, queues, the bounded
event log, timer instances/presets/absence watchers and `lastSeenByKind`, and
rule definitions/runtime. Version 1 documents (subscriptions, queues, log) are
migrated on read. It is separate from `villv-helix-state.json`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `stateDir` | required | Document directory |
| `batchMs` / `maxWaitMs` | 1200 / 5000 | Active wake quiet window and postponement ceiling |
| `tickMs` | 250 | Time/absence/rule scheduler wake interval |
| `maxTimersPerSession` | 64 | Timer instances per session |
| `maxPresets` | 64 | Shared preset library ceiling |
| `maxAbsencesPerSession` | 32 | Absence watchers per session |
| `maxRulesPerSession` | 64 | Rules per session |
| `ruleHttpAllowedHosts` | `[]` | HTTP-poll hostname allowlist |
| `ruleHttpTimeoutMs` / `ruleHttpMaxBytes` | 10000 / 65536 | Poll timeout and response ceiling |

## Development

```powershell
cd plugins/context-gate
pnpm run typecheck
pnpm test
pnpm run build
pnpm run bundle
```

Host and client tests cover mount/unmount, envelope compatibility,
multi-session subscriptions and params, future subscriptions, queues/injection,
timers/RRULE/restart, presets, absence, custom rules/scripts/webhooks, tab order,
and tool registration.