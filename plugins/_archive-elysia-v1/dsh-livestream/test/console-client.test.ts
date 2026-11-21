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
    show: { live: { state: 'connected', loggedIn: true, stats: {}, perMinute: {} }, onAir: false, brain: 'off', brainSession: null as string | null, heat: 'quiet', audience: false, pending: {}, lines: [], stageWatchers: 1, roomId: 123 as number | null },
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
  disposeConsole(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals();
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
  it('offers opt-in local listening alongside the silent preview during rehearsal', async () => {
    const state = host();
    state.show.roomId = null;
    stubHostFetch(async () => new Response(JSON.stringify(state)));
    await mount();
    const player = document.querySelector('iframe[title="本机试听"]');
    expect(player?.getAttribute('src')).toBe('http://127.0.0.1:39999/listen');
    expect(player?.getAttribute('allow')).toBe('autoplay');
    expect(document.querySelector('iframe[title="舞台预览"]')?.getAttribute('src')).toContain('preview=1');
  });
  it('keeps the local listening player out of a connected platform room', async () => {
    stubHostFetch(async () => new Response(JSON.stringify(host())));
    await mount();
    expect(document.querySelector('iframe[title="本机试听"]')).toBeNull();
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
  it('recovers the preview when state fails twice while the event stream stays connected', async () => {
    vi.useFakeTimers();
    const readState = vi.fn(async () => new Response(JSON.stringify(host())))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const carrier = stubHostFetch(readState);
    await mount();
    expect(readState).toHaveBeenCalledTimes(2);
    expect(streamSignals).toHaveLength(1);
    expect(document.querySelector('iframe[title="舞台预览"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('正在重试读取直播状态');
    expect(document.body.textContent).not.toContain('Failed to fetch');

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(readState).toHaveBeenCalledTimes(3);
    expect(streamSignals).toHaveLength(1);
    expect(document.querySelector('iframe[title="舞台预览"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('正在重试读取直播状态');
    expect(carrier.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('aborts an in-flight state refresh and cancels subsequent retries on unmount', async () => {
    vi.useFakeTimers();
    let pending: AbortSignal | undefined;
    const readState = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      pending = init?.signal ?? undefined;
      pending?.addEventListener('abort', () => reject(pending?.reason), { once: true });
    })).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    stubHostFetch(readState);
    await mount();
    expect(readState).toHaveBeenCalledTimes(2);
    expect(pending?.aborted).toBe(false);

    await act(async () => { root?.unmount(); root = null; await vi.advanceTimersByTimeAsync(10_000); });

    expect(pending?.aborted).toBe(true);
    expect(readState).toHaveBeenCalledTimes(2);
  });
  it('reports HTTP refusal without scheduling repeated state requests', async () => {
    vi.useFakeTimers();
    const readState = vi.fn(async () => new Response('{}', { status: 401 }));
    stubHostFetch(readState);
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 401');
    expect(document.body.textContent).not.toContain('正在重试读取直播状态');
    const calls = readState.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(readState).toHaveBeenCalledTimes(calls);
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
    expect(document.querySelector('[aria-label="直播姬浏览器源"]')).not.toBeNull();
    await act(async () => { button('设置').click(); });
    expect(document.body.textContent).toContain('开播与下播请在直播姬中操作');
    expect(document.body.textContent).not.toContain('OBS');
    expect(document.body.textContent).toContain('用于明确直播间归属');
    expect(document.body.textContent).toContain('可以选择回应或略过');
  });
  it('copies separate loopback sources without the full-stage token', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stubHostFetch(async () => new Response(JSON.stringify(host()), { status: 200 }));
    await mount();
    for (const [label, path] of [['声音源', '/audio'], ['字幕源', '/subtitles']]) {
      const copy = document.querySelector<HTMLButtonElement>(`[aria-label="复制${label}地址"]`);
      await act(async () => { copy?.click(); });
      expect(writeText).toHaveBeenLastCalledWith(`http://127.0.0.1:39999${path}`);
    }
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
