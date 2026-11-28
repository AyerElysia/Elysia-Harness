/**
 * Runtime constants shared by the Host and the browser half.
 *
 * @module @elysia/context-gate/constants
 */

/** Reserved parameter value selecting every session that exists now. */
export const PARAM_ALL_CURRENT = '*'

/** Reserved parameter value selecting sessions created after the subscription. */
export const PARAM_ALL_FUTURE = '+'

/** Kind written into the owner queue when a timer fires; it is not subscribable. */
export const TIMER_EVENT_KIND = 'agent.timer'

/** Kind written into the owner queue when an absence watcher fires; it is not subscribable. */
export const ABSENCE_EVENT_KIND = 'agent.absence'

/** Source identity of timer injections in the event log. */
export const TIMER_SOURCE = 'context-gate.timer'

/** Source identity of absence injections in the event log. */
export const ABSENCE_SOURCE = 'context-gate.absence'

/** Source identity of generated custom events. */
export const RULE_SOURCE = 'context-gate.rules'

/** Kind prefix of a generated custom event; the suffix is the sanitized rule id. */
export const RULE_KIND_PREFIX = 'agent.script.'

/** Minimum interval a `seconds` timer may declare. */
export const MIN_TIMER_SECONDS = 1

/** Maximum interval a `seconds` timer may declare. */
export const MAX_TIMER_SECONDS = 86_400

/** Every internal event a rule may trigger on. */
export const INTERNAL_EVENT_NAMES = [
  'session/event',
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
  'job/registered',
  'job/settled',
  'subagent/start',
  'subagent/end',
] as const