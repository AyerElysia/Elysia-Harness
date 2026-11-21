import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** Current additive estimates and a separate historical API report. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives';
import { compactTokens, consistentEstimate } from "./metrics-presentation.js";
import css from './ContextMetricsMeter.module.css';
import './context-meter-compat.css';
export function ContextMetricsMeter({ useProjection, t }) {
    const metrics = useProjection('elysiaContextMetrics');
    return _jsx(ContextMetricsDisplay, { metrics: metrics, t: t });
}
export function ContextMetricsDisplay({ metrics, t }) {
    const [open, setOpen] = useState(false);
    const root = useRef(null);
    const panel = useRef(null);
    const available = metrics !== undefined;
    const position = useAnchoredPosition({ open: open && available, anchorRef: root, panelRef: panel, side: 'top', gap: 8, margin: 12 });
    useDismissOnOutsidePointer(root, open && available, setOpen, panel);
    useEffect(() => {
        if (!available) {
            setOpen(false);
            return;
        }
        if (!open)
            return;
        const onKey = (event) => { if (event.key === 'Escape')
            setOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('keydown', onKey); };
    }, [open, available]);
    if (metrics === undefined)
        return null;
    const valid = consistentEstimate(metrics);
    const estimate = valid ? metrics.estimate : undefined;
    const capacity = metrics?.contextWindow;
    const knownCapacity = capacity !== undefined && Number.isSafeInteger(capacity) && capacity > 0;
    const percentage = estimate !== undefined && !estimate.incomplete && knownCapacity
        ? Math.round(estimate.totalTokens / capacity * 100)
        : undefined;
    const label = estimate === undefined
        ? t(metrics === undefined ? 'metrics.pending' : 'metrics.invalid')
        : t('metrics.trigger', { tokens: '~' + compactTokens(estimate.totalTokens) })
            + (estimate.incomplete ? ' · ' + t('metrics.partial') : '')
            + (percentage === undefined ? '' : ` · ~${percentage}%`);
    const report = metrics?.latestReported;
    return (_jsxs("span", { ref: root, className: css.root, "data-elysia-context-meter": "", children: [_jsx("button", { type: "button", className: css.trigger, "aria-haspopup": "dialog", "aria-expanded": open, onClick: () => { setOpen(value => !value); }, children: label }), open && createPortal(_jsxs("div", { ref: panel, className: css.panel, role: "dialog", "aria-label": t('metrics.title'), style: position ?? { visibility: 'hidden', top: 0, left: 0 }, children: [_jsxs("div", { className: css.header, children: [_jsx("h2", { className: css.title, children: t('metrics.title') }), _jsx("button", { type: "button", className: css.close, "aria-label": t('metrics.close'), onClick: () => { setOpen(false); }, children: "\u00D7" })] }), _jsxs("section", { className: css.section, "aria-label": t('metrics.current'), children: [_jsx("h3", { className: css.title, children: t('metrics.current') }), estimate === undefined
                                ? _jsx("p", { className: css.warning, children: t(metrics === undefined ? 'metrics.pending' : 'metrics.invalid') })
                                : _jsxs(_Fragment, { children: [_jsxs("div", { className: css.total, children: ["~", estimate.totalTokens.toLocaleString(), knownCapacity ? ` / ${capacity.toLocaleString()}` : ''] }), !knownCapacity && _jsx("p", { className: css.note, children: t('metrics.capacityUnknown') }), _jsxs("dl", { className: css.rows, children: [_jsxs("div", { className: css.row, children: [_jsx("dt", { children: t('system') }), _jsxs("dd", { children: ["~", estimate.systemTokens.toLocaleString()] })] }), _jsxs("div", { className: css.row, children: [_jsx("dt", { children: t('tools') }), _jsxs("dd", { children: ["~", estimate.toolsTokens.toLocaleString()] })] }), _jsxs("div", { className: css.row, children: [_jsx("dt", { children: t('messages') }), _jsxs("dd", { children: ["~", estimate.messageTokens.toLocaleString()] })] })] }), _jsx("p", { className: css.note, children: t('metrics.additive') }), _jsxs("p", { className: css.note, children: [t(`metrics.method.${estimate.method}`), estimate.tokenizerLabel === undefined ? '' : ` · ${estimate.tokenizerLabel}`] }), _jsx("p", { className: css.note, children: t('metrics.estimateOnly') }), estimate.incomplete && _jsxs("p", { className: css.warning, children: [t('metrics.incomplete'), estimate.incompleteTypes.length === 0 ? '' : ` (${estimate.incompleteTypes.join(', ')})`] }), metrics?.route !== undefined && _jsxs("p", { className: css.note, children: [metrics.route.provider, " / ", metrics.route.model] })] })] }), _jsxs("section", { className: css.section, "aria-label": t('metrics.latest'), children: [_jsx("h3", { className: css.title, children: t('metrics.latest') }), report === undefined
                                ? _jsx("p", { className: css.note, children: t('metrics.noReport') })
                                : _jsxs(_Fragment, { children: [_jsxs("p", { className: css.note, children: [t('metrics.purpose.label'), "\uFF1A", t(`metrics.purpose.${report.purpose ?? 'unknown'}`)] }), _jsxs("div", { className: css.actual, children: [report.inputTokens.toLocaleString(), " tokens"] }), _jsx("p", { className: css.note, children: t('metrics.inputOnly') }), _jsxs("dl", { className: css.rows, children: [_jsxs("div", { className: css.row, children: [_jsx("dt", { children: t('metrics.uncached') }), _jsx("dd", { children: report.uncachedInputTokens.toLocaleString() })] }), _jsxs("div", { className: css.row, children: [_jsx("dt", { children: t('metrics.cacheRead') }), _jsx("dd", { children: report.cacheReadTokens.toLocaleString() })] }), _jsxs("div", { className: css.row, children: [_jsx("dt", { children: t('metrics.cacheWrite') }), _jsx("dd", { children: report.cacheWriteTokens.toLocaleString() })] })] }), _jsxs("p", { className: css.route, children: [report.provider ?? t('metrics.unknown'), " / ", report.model ?? t('metrics.unknown')] }), _jsx("time", { dateTime: report.recordedAt, title: report.recordedAt, children: report.recordedAt }), _jsx("p", { className: css.warning, children: t(`metrics.relationship.${report.relationship}`) }), _jsx("p", { className: css.note, children: t('metrics.reportNotBreakdown') })] })] })] }), document.body)] }));
}
//# sourceMappingURL=ContextMetricsMeter.js.map