/** Current additive estimates and a separate historical API report. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ContextMetrics } from '../metrics-types.ts'
import { compactTokens, consistentEstimate } from './metrics-presentation.ts'
import type { NS } from './locales.ts'
import css from './ContextMetricsMeter.module.css'
import './context-meter-compat.css'

type Locale = PropsLocale<typeof NS>

export function ContextMetricsMeter({ useProjection, t }: PropsRuntime<'conversation.composer.dock'> & Locale) {
  const metrics = useProjection('elysiaContextMetrics')
  return <ContextMetricsDisplay metrics={metrics} t={t} />
}

export function ContextMetricsDisplay({ metrics, t }: { metrics: ContextMetrics | undefined } & Locale) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const available = metrics !== undefined
  const position = useAnchoredPosition({ open: open && available, anchorRef: root, panelRef: panel, side: 'top', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(root, open && available, setOpen, panel)
  useEffect(() => {
    if (!available) { setOpen(false); return }
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, available])
  if (metrics === undefined) return null
  const valid = consistentEstimate(metrics)
  const estimate = valid ? metrics.estimate : undefined
  const capacity = metrics?.contextWindow
  const knownCapacity = capacity !== undefined && Number.isSafeInteger(capacity) && capacity > 0
  const percentage = estimate !== undefined && !estimate.incomplete && knownCapacity
    ? Math.round(estimate.totalTokens / capacity * 100)
    : undefined
  const label = estimate === undefined
    ? t(metrics === undefined ? 'metrics.pending' : 'metrics.invalid')
    : t('metrics.trigger', { tokens: '~' + compactTokens(estimate.totalTokens) })
      + (estimate.incomplete ? ' · ' + t('metrics.partial') : '')
      + (percentage === undefined ? '' : ` · ~${percentage}%`)
  const report = metrics?.latestReported

  return (
    <span ref={root} className={css.root} data-elysia-context-meter="">
      <button type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {label}
      </button>
      {open && createPortal(
        <div ref={panel} className={css.panel} role="dialog" aria-label={t('metrics.title')} style={position ?? { visibility: 'hidden', top: 0, left: 0 }}>
          <div className={css.header}>
            <h2 className={css.title}>{t('metrics.title')}</h2>
            <button type="button" className={css.close} aria-label={t('metrics.close')} onClick={() => { setOpen(false) }}>×</button>
          </div>
          <section className={css.section} aria-label={t('metrics.current')}>
            <h3 className={css.title}>{t('metrics.current')}</h3>
            {estimate === undefined
              ? <p className={css.warning}>{t(metrics === undefined ? 'metrics.pending' : 'metrics.invalid')}</p>
              : <>
                <div className={css.total}>
                  ~{estimate.totalTokens.toLocaleString()}
                  {knownCapacity ? ` / ${capacity.toLocaleString()}` : ''}
                </div>
                {!knownCapacity && <p className={css.note}>{t('metrics.capacityUnknown')}</p>}
                <dl className={css.rows}>
                  <div className={css.row}><dt>{t('system')}</dt><dd>~{estimate.systemTokens.toLocaleString()}</dd></div>
                  <div className={css.row}><dt>{t('tools')}</dt><dd>~{estimate.toolsTokens.toLocaleString()}</dd></div>
                  <div className={css.row}><dt>{t('messages')}</dt><dd>~{estimate.messageTokens.toLocaleString()}</dd></div>
                </dl>
                <p className={css.note}>{t('metrics.additive')}</p>
                <p className={css.note}>
                  {t(`metrics.method.${estimate.method}`)}
                  {estimate.tokenizerLabel === undefined ? '' : ` · ${estimate.tokenizerLabel}`}
                </p>
                <p className={css.note}>{t('metrics.estimateOnly')}</p>
                {estimate.incomplete && <p className={css.warning}>
                  {t('metrics.incomplete')}
                  {estimate.incompleteTypes.length === 0 ? '' : ` (${estimate.incompleteTypes.join(', ')})`}
                </p>}
                {metrics?.route !== undefined && <p className={css.note}>{metrics.route.provider} / {metrics.route.model}</p>}
              </>}
          </section>
          <section className={css.section} aria-label={t('metrics.latest')}>
            <h3 className={css.title}>{t('metrics.latest')}</h3>
            {report === undefined
              ? <p className={css.note}>{t('metrics.noReport')}</p>
              : <>
                <p className={css.note}>{t('metrics.purpose.label')}：{t(`metrics.purpose.${report.purpose ?? 'unknown'}`)}</p>
                <div className={css.actual}>{report.inputTokens.toLocaleString()} tokens</div>
                <p className={css.note}>{t('metrics.inputOnly')}</p>
                <dl className={css.rows}>
                  <div className={css.row}><dt>{t('metrics.uncached')}</dt><dd>{report.uncachedInputTokens.toLocaleString()}</dd></div>
                  <div className={css.row}><dt>{t('metrics.cacheRead')}</dt><dd>{report.cacheReadTokens.toLocaleString()}</dd></div>
                  <div className={css.row}><dt>{t('metrics.cacheWrite')}</dt><dd>{report.cacheWriteTokens.toLocaleString()}</dd></div>
                </dl>
                <p className={css.route}>{report.provider ?? t('metrics.unknown')} / {report.model ?? t('metrics.unknown')}</p>
                <time dateTime={report.recordedAt} title={report.recordedAt}>{report.recordedAt}</time>
                <p className={css.warning}>{t(`metrics.relationship.${report.relationship}`)}</p>
                <p className={css.note}>{t('metrics.reportNotBreakdown')}</p>
              </>}
          </section>
        </div>,
        document.body,
      )}
    </span>
  )
}
