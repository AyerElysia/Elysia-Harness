/**
 * Copy dictionary for the context views. Simplified Chinese is the key source
 * of truth; English is checked against it.
 *
 * @module @elysia/context-gate/client/locales
 */

/** Dictionary namespace this plugin owns. */
export const NS = 'contextGate'

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  loading: '正在读取上下文状态…',
  error: '暂时无法读取上下文状态。',
  retry: '重试',
  panelTabs: '上下文板块',
  tabEvents: '事件',
  tabLog: '日志',
  subscriptionsHint: '按本会话订阅；主动事件会唤醒一轮，被动事件在下一次输入时注入。',
  emptyContexts: '没有可订阅的上下文事件。',
  contextSubscribed: '已订阅',
  contextUnsubscribed: '未订阅',
  ttlSeconds: 'TTL {count} 秒',
  ttlMinutes: 'TTL {count} 分钟',
  contextBacklog: '积压 {count}',
  contextToggleLabel: '订阅 {kind}',
  pending: '正在写入…',
  eventLogHint: '本会话最近一次发布、投递、消费、失败与丢弃。',
  emptyEvents: '还没有事件记录。',
  eventOutcomePublished: '发布',
  eventOutcomeDelivered: '投递',
  eventOutcomeConsumed: '消费',
  eventOutcomeFailed: '失败',
  eventOutcomeDropped: '丢弃',
  errorContextUnknown: '该上下文事件未注册。',
  errorScopeNotFound: '当前会话不在线，无法写入。',
  errorState: 'Host 状态存储读写失败。',
} satisfies Record<string, string>

/** Context view locale key union. */
export type ContextGateLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  loading: 'Reading context state…',
  error: 'Context state is temporarily unavailable.',
  retry: 'Retry',
  panelTabs: 'Context sections',
  tabEvents: 'Events',
  tabLog: 'Log',
  subscriptionsHint: 'Subscribed per session; an active event wakes a turn, a passive one is injected at the next input.',
  emptyContexts: 'No context event can be subscribed.',
  contextSubscribed: 'Subscribed',
  contextUnsubscribed: 'Not subscribed',
  ttlSeconds: 'TTL {count}s',
  ttlMinutes: 'TTL {count} min',
  contextBacklog: 'Backlog {count}',
  contextToggleLabel: 'Subscribe {kind}',
  pending: 'Writing…',
  eventLogHint: 'This session\u2019s most recent publish, delivery, consumption, failure, and drop.',
  emptyEvents: 'No event recorded yet.',
  eventOutcomePublished: 'Published',
  eventOutcomeDelivered: 'Delivered',
  eventOutcomeConsumed: 'Consumed',
  eventOutcomeFailed: 'Failed',
  eventOutcomeDropped: 'Dropped',
  errorContextUnknown: 'That context event kind is not registered.',
  errorScopeNotFound: 'The current session is not live, so it cannot be written.',
  errorState: 'The Host state store could not be read or written.',
} satisfies Record<ContextGateLocaleKey, string>

/** Localized label of each event-log outcome. */
export const OUTCOME_LABEL_KEYS: Readonly<Record<string, ContextGateLocaleKey>> = {
  published: 'eventOutcomePublished',
  delivered: 'eventOutcomeDelivered',
  consumed: 'eventOutcomeConsumed',
  failed: 'eventOutcomeFailed',
  dropped: 'eventOutcomeDropped',
}