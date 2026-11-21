import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** Read-only view of one pinned archived request with explicitly bounded section loading. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createInspectorApi, SECTIONS } from "./api.js";
import { readableSystemBlocks } from "./readable-system.js";
import { PagedTextReader } from "./paged-text.js";
import css from './ContextInspectorView.module.css';
/** Session key prevents an earlier session's retained prompt flashing during navigation. */
export function ContextInspectorView({ inspectorSessionId, inspectorRpc, t, }) {
    const api = useMemo(() => createInspectorApi(inspectorRpc, inspectorSessionId), [inspectorRpc, inspectorSessionId]);
    return _jsx(SessionInspector, { api: api, t: t }, inspectorSessionId);
}
function SessionInspector({ api, t }) {
    const [latest, setLatest] = useState({ phase: 'loading' });
    const [section, setSection] = useState('system');
    const pending = useRef();
    const revision = useRef(0);
    const refresh = useCallback(async () => {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        setLatest({ phase: 'loading' });
        try {
            const value = await api.latest(controller.signal);
            if (!controller.signal.aborted && pending.current === controller) {
                setLatest({ phase: 'ready', value, revision: ++revision.current });
            }
        }
        catch {
            if (!controller.signal.aborted && pending.current === controller)
                setLatest({ phase: 'error' });
        }
    }, [api]);
    useEffect(() => {
        void refresh();
        return () => { pending.current?.abort(); };
    }, [refresh]);
    const request = latest.phase === 'ready' ? latest.value.request : null;
    return (_jsxs("section", { className: css.root, "aria-label": t('title'), children: [_jsxs("div", { className: css.header, children: [_jsxs("div", { children: [_jsx("h2", { className: css.title, children: t('title') }), _jsx("p", { className: css.description, children: t('description') })] }), _jsx("button", { className: css.button, type: "button", onClick: () => { void refresh(); }, disabled: latest.phase === 'loading', children: t('refresh') })] }), latest.phase === 'loading' && _jsx("p", { className: css.notice, role: "status", children: t('loading') }), latest.phase === 'error' && _jsx("p", { className: css.error, role: "alert", children: t('latestError') }), latest.phase === 'ready' && request === null && (_jsx("p", { className: css.notice, role: "status", children: t(latest.value.reason === 'index-unavailable' ? 'indexUnavailable' : 'empty') })), request !== null && latest.phase === 'ready' && (_jsxs(_Fragment, { children: [_jsx(RequestMetadata, { request: request, t: t }), _jsx("div", { className: css.tabs, role: "tablist", "aria-label": t('sections'), children: SECTIONS.map(item => (_jsx("button", { className: item === section ? `${css.tab} ${css.tabActive}` : css.tab, id: `elysia-context-tab-${item}`, "aria-controls": "elysia-context-panel", type: "button", role: "tab", "aria-selected": item === section, onClick: () => { setSection(item); }, children: t(item) }, item))) }), _jsx(SectionContent, { api: api, request: request, section: section, t: t }, `${request.requestId}:${latest.revision}:${section}`)] }))] }));
}
function RequestMetadata({ request, t }) {
    const recordedAt = request.recordedAt;
    return (_jsxs("dl", { className: css.metadata, children: [_jsxs("div", { children: [_jsx("dt", { children: t('capturedAt') }), _jsx("dd", { children: _jsx("time", { dateTime: request.recordedAt, title: request.recordedAt, children: recordedAt }) })] }), _jsxs("div", { children: [_jsx("dt", { children: t('model') }), _jsx("dd", { children: request.model })] }), _jsxs("div", { children: [_jsx("dt", { children: t('provider') }), _jsx("dd", { children: request.provider })] }), _jsxs("div", { children: [_jsx("dt", { children: t('callKind') }), _jsx("dd", { children: t(request.loop ? 'agentLoop' : 'otherCall') })] }), _jsxs("div", { children: [_jsx("dt", { children: t('messagesCount') }), _jsx("dd", { children: request.messageCount })] }), _jsxs("div", { children: [_jsx("dt", { children: t('toolsCount') }), _jsx("dd", { children: request.toolCount })] }), _jsxs("div", { children: [_jsx("dt", { children: t('requestId') }), _jsx("dd", { children: request.requestId })] })] }));
}
function SectionContent({ api, request, section, t }) {
    const reader = useMemo(() => new PagedTextReader((offset, signal) => api.read(request, section, offset, signal), request.sections[section].bytes), [api, request, section]);
    const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
    const [readable, setReadable] = useState(true);
    const blocks = useMemo(() => section === 'system' && state.complete
        ? readableSystemBlocks(state.text) : [], [section, state.complete, state.text]);
    useEffect(() => {
        void reader.load();
        // Cancel rather than permanently dispose: React StrictMode replays this effect.
        return () => { reader.cancel(); };
    }, [reader]);
    return (_jsxs("div", { className: css.panel, role: "tabpanel", id: "elysia-context-panel", "aria-labelledby": `elysia-context-tab-${section}`, children: [section === 'system' && _jsx("p", { className: css.notice, children: t('systemDescription') }), _jsxs("div", { className: css.progress, children: [_jsxs("span", { role: "status", "aria-live": "polite", children: [t('loaded', { loaded: state.loadedBytes.toLocaleString(), total: state.totalBytes.toLocaleString() }), state.loading ? ` · ${t('reading')}` : state.complete ? ` · ${t('complete')}` : ''] }), _jsx("span", { className: css.actions, children: state.loading
                            ? _jsx("button", { className: css.button, type: "button", onClick: () => { reader.cancel(); }, children: t('cancel') })
                            : !state.complete && (_jsxs(_Fragment, { children: [_jsx("button", { className: css.button, type: "button", onClick: () => { void reader.load(); }, children: t('loadMore') }), _jsx("button", { className: css.button, type: "button", onClick: () => { void reader.load(true); }, children: t('loadAll') })] })) })] }), section === 'system' && state.complete && (_jsxs("div", { className: css.displayModes, role: "group", "aria-label": t('displayMode'), children: [_jsx("button", { className: css.button, type: "button", "aria-pressed": readable, onClick: () => { setReadable(true); }, children: t('readableText') }), _jsx("button", { className: css.button, type: "button", "aria-pressed": !readable, onClick: () => { setReadable(false); }, children: t('jsonStructure') })] })), !state.complete && _jsx("p", { className: css.notice, children: t('partial') }), state.error !== null && _jsx("p", { className: css.error, role: "alert", children: t('readError') }), state.complete && state.text === ''
                ? _jsx("p", { className: css.notice, children: t('emptySection') })
                : section === 'system' && state.complete && readable
                    ? _jsx("div", { "aria-label": t('content', { section: t(section) }), children: blocks.map((block, index) => (_jsxs("section", { className: css.readableBlock, children: [_jsx("h3", { className: css.sourceLabel, children: block.source }), _jsx("pre", { className: css.content, children: block.text })] }, index))) })
                    : _jsx("pre", { className: css.content, "aria-label": t('content', { section: t(section) }), children: state.text })] }));
}
//# sourceMappingURL=ContextInspectorView.js.map