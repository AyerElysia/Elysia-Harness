// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Console, bindConsole, bindCredentials, disposeConsole } from '../src/console/console';
import { apply, PANEL_ID } from '../src/console/client';

let root: Root | null = null;
let streamSignals: AbortSignal[] = [];
const openSession = vi.fn();
const using = vi.fn();
const services = { uiWorkspace: { openSession }, sessions: { using }, layout: { selectPanel: vi.fn() } };
function host(publisher: 'livehime' | 'obs' = 'livehime') {
  return {
    ok: true, publisher, stageUrl: 'http://127.0.0.1:39999/?token=fixture',
    show: { live: { state: 'connected', loggedIn: true, stats: {}, perMinute: {} }, onAir: false, brain: 'off', brainSession: null as string | null, heat: 'quiet', audience: false, pending: {}, lines: [], stageWatchers: 1, roomId: 123 },
    broadcast: { phase: 'idle', step: '', roomId: null, faceQr: null, error: null, health: null, startedAt: null },
    settings: { roomId: 123, character: 'elysia', template: 'default', voice: 'elysia-breeze', stagePort: 39999, idleAfterSec: 45, distillModel: '', ownRooms: [123], broadcast: true, areaId: null, liveTitle: '', pushProtocol: 'rtmp', streamKbps: 4500, asrPython: '', asrModel: '', boardText: '' },
    characters: [{ id: 'elysia', name: '爱莉希雅', builtin: true }], templates: [{ id: 'default', name: '原模板', builtin: true }], asr: { available: false }, defaultBoard: '',
    voice: { available: true, provider: 'breeze', label: '本地爱莉声音' },
  };
}
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(node => node.textContent?.includes(text));
  if (!result) throw new Error('missing fixture button: ' + text);
  return result;
}
function stubHostFetch(handler: (input: string, init?: RequestInit) => Promise<Response>) {
  const carrier = vi.fn((input: string, init?: RequestInit) => {
    if (input.endsWith('/events')) {
      const signal = init?.signal;
      if (!signal) throw new Error('stream must have an owner signal');
      streamSignals.push(signal);
      let done = false;
      let stop = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) { stop = () => { if (!done) { done = true; controller.close(); } }; signal.addEventListener('abort', stop, { once: true }); },
        cancel() { done = true; signal.removeEventListener('abort', stop); },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    }
    return handler(input, init);
  });
  vi.stubGlobal('fetch', carrier);
  return carrier;
}

async function mount(): Promise<void> {
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => { root!.render(React.createElement(Console)); });
}
beforeEach(() => {
  vi.clearAllMocks(); streamSignals = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', vi.fn(() => { throw new Error('raw EventSource must not bypass the native carrier'); }));
  bindConsole(services);
  bindCredentials({ describe: async () => ({ ok: true, value: { BILIBILI_COOKIE: { configured: true } } }), set: async () => undefined });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); root = null; });
  disposeConsole(); document.body.innerHTML = ''; vi.unstubAllGlobals();
});

describe('original livestream console integration', () => {
  it('uses the fixed Host session and leaves publication to Livehime', async () => {
    const state = host();
    const requests: Array<{ path: string; body: unknown }> = [];
    stubHostFetch(vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('/').pop()!;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === 'onair') { state.show.onAir = true; state.show.brainSession = 'elysia-livestream'; }
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await mount();
    expect(document.body.textContent).toContain('爱莉直播');
    expect(document.body.textContent).toContain('直播姬推流');
    expect(document.body.textContent).not.toContain('豆包语音 Key');
    await act(async () => { button('开始直播回应').click(); });
    expect(requests.find(request => request.path === 'onair')?.body).toEqual({});
    expect(requests.some(request => request.path === 'start')).toBe(false);
    expect(using).not.toHaveBeenCalled();
    await act(async () => { button('打开她直播的会话').click(); });
    expect(openSession).toHaveBeenCalledWith('elysia-livestream');
  });
  it('reads state and events through the public authenticated shell carrier', async () => {
    const state = host();
    const authenticated = stubHostFetch(async () => new Response(JSON.stringify(state), { status: 200 }));
    vi.stubGlobal('__DSH_TRANSPORT__', { fetch: authenticated });
    const anonymous = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', anonymous);
    bindConsole(services);
    await mount();
    await act(async () => { button('设置').click(); });
    expect(document.body.textContent).toContain('本地爱莉声音');
    expect(authenticated.mock.calls.some(([url]) => url === 'api/dsh-livestream/state')).toBe(true);
    expect(authenticated.mock.calls.some(([url]) => url === 'api/dsh-livestream/events')).toBe(true);
    expect(anonymous).not.toHaveBeenCalled();
    expect(EventSource).not.toHaveBeenCalled();
  });
  it('accepts backend login readiness even when the native credential store is empty', async () => {
    const state = host(); state.show.stageWatchers = 0;
    bindCredentials({ describe: async () => ({ ok: true, value: { BILIBILI_COOKIE: { configured: false } } }), set: async () => undefined });
    stubHostFetch(async () => new Response(JSON.stringify(state), { status: 200 }));
    await mount();
    expect(document.body.textContent).toContain('3/4');
  });
  it('never auto-starts OBS if an older state response omits the publisher field', async () => {
    const state: Partial<ReturnType<typeof host>> = host();
    delete state.publisher;
    const paths: string[] = [];
    stubHostFetch(vi.fn(async (url: string) => { paths.push(url); return new Response(JSON.stringify(state), { status: 200 }); }));
    await mount();
    await act(async () => { button('开始直播回应').click(); });
    expect(paths.some(path => path.endsWith('/broadcast/start'))).toBe(false);
  });
  it.each([0, 2])('guides Livehime browser sources without OBS setup (%i connected)', async watchers => {
    const state = host(); state.show.stageWatchers = watchers;
    stubHostFetch(vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })));
    await mount();
    expect(document.body.textContent).toContain(watchers ? `舞台浏览器源已连接 ${watchers} 个` : '直播姬还未接入舞台');
    expect(document.body.textContent).toContain('直播姬浏览器源');
    await act(async () => { button('设置').click(); });
    expect(document.body.textContent).toContain('开播与下播请在直播姬中操作');
    expect(document.body.textContent).not.toContain('OBS');
    expect(document.body.textContent).toContain('用于明确直播间归属');
    expect(document.body.textContent).toContain('可以选择回应或略过');
  });
  it('retains the upstream OBS publication path when that publisher is explicitly selected', async () => {
    const state = host('obs');
    stubHostFetch(vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })));
    await mount();
    expect(document.body.textContent).toContain('推流到 B 站');
    expect(button('开播')).toBeDefined();
    expect(document.body.textContent).not.toContain('直播姬推流');
    expect(document.body.textContent).toContain('OBS 已连上 1 个');
    expect(document.body.textContent).toContain('OBS 浏览器源');
    await act(async () => { button('设置').click(); });
    expect(button('检查 OBS')).toBeDefined();
  });
  it('registers the original full panel and releases slots, style and SSE on plugin removal', async () => {
    const state = host();
    stubHostFetch(vi.fn(async () => new Response(JSON.stringify(state), { status: 200 })));
    const disposers: Array<() => void> = [];
    const slots: Array<{ name: string; key?: string; id?: string }> = [];
    const removed = vi.fn();
    const ctx = {
      ...services, remote: {},
      effect: (effect: () => unknown) => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose as () => void); },
      inject: () => undefined,
      slots: {
        inject: (_name: string, register: () => unknown) => { const dispose = register(); if (typeof dispose === 'function') disposers.push(dispose as () => void); },
        register: (spec: { name: string; key?: string; id?: string }) => { slots.push(spec); return removed; },
      },
    };
    apply(ctx as never);
    await mount();
    expect(slots).toEqual(expect.arrayContaining([{ name: 'main', key: PANEL_ID }, expect.objectContaining({ name: 'sidebar.panellist', id: '@elysia/dsh-livestream' })]));
    expect(document.querySelector('style[data-plugin="@elysia/dsh-livestream"]')).not.toBeNull();
    await act(async () => { for (const dispose of disposers.reverse()) dispose(); });
    expect(removed).toHaveBeenCalledTimes(2);
    expect(streamSignals[0]?.aborted).toBe(true);
    expect(EventSource).not.toHaveBeenCalled();
    expect(document.querySelector('style[data-plugin="@elysia/dsh-livestream"]')).toBeNull();
  });
});
