// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageEvent } from '../src/stage/protocol';

/** Real DOM media events with local fakes for playback, SSE and HTTP. */
async function fixture(options: { path?: string; preview?: boolean; reject?: boolean; render?: boolean; startAck?: Promise<Response>; warmup?: Promise<void>; rejectWarmup?: boolean } = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
  history.replaceState(null, '', `${options.path ?? '/source'}?token=fixture${options.preview ? '&preview=1' : ''}`);
  const players: HTMLAudioElement[] = [];
  const streams: FakeSource[] = [];
  const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = new URL(input, location.origin);
    return url.searchParams.get('state') === 'started' && options.startAck
      ? options.startAck : new Response(null, { status: 204 });
  });
  function FakeAudio(): HTMLAudioElement {
    const player = document.createElement('audio');
    players.push(player);
    Object.defineProperty(player, 'duration', { value: 1 });
    Object.defineProperty(player, 'play', { value: vi.fn(() => {
      const warmup = player.src.startsWith('data:audio/wav;base64,UklGR');
      if (warmup ? options.rejectWarmup : options.reject) return Promise.reject(new Error('fixture refusal'));
      return warmup && options.warmup ? options.warmup : Promise.resolve();
    }) });
    Object.defineProperty(player, 'pause', { value: vi.fn() });
    Object.defineProperty(player, 'load', { value: vi.fn(() => { player.currentTime = 0; }) });
    return player;
  }
  class FakeSource {
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(readonly url: string) { streams.push(this); }
    close = vi.fn();
  }
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('fetch', fetchMock);
  const store = await import('../src/stage/store');
  if (options.render) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => { await import('../src/stage/main'); });
  } else store.connect();
  const send = (event: StageEvent) => streams[0]!.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  const owner = (id = 'fixture-owner') => send({ v: 1, type: 'playback-owner', playbackId: id, at: Date.now() });
  const receipts = () => fetchMock.mock.calls.map(args => {
    const url = new URL(String(args[0]), location.origin);
    return { id: url.searchParams.get('id'), state: url.searchParams.get('state'), owner: url.searchParams.get('playbackId') };
  });
  return { store, players, streams, send, owner, receipts, fetchMock };
}
const say = (id = 'line-1', audio: string | null = 'RklYVFVSRQ=='): Extract<StageEvent, { type: 'say' }> => ({ v: 1, type: 'say', id, text: 'fixture', mood: 'normal', audio, audioMime: 'audio/wav', timingSource: 'estimated', estimateMs: 1000, at: Date.now() });
const subtitle = (id = 'line-1', text = '字幕测试'): Extract<StageEvent, { type: 'subtitle'; state: 'started' }> => ({ v: 1, type: 'subtitle', id, state: 'started', text, mood: 'normal', estimateMs: 1000, elapsedMs: 150, at: Date.now() });
const terminal = (id = 'line-1', state: 'ended' | 'failed' | 'cancelled' | 'timeout' = 'ended'): StageEvent => ({ v: 1, type: 'subtitle', id, state, at: Date.now() });
const receipt = (state: string, id = 'line-1', owner = 'fixture-owner') => ({ id, state, owner });
const emit = (player: HTMLAudioElement, name: string) => player.dispatchEvent(new Event(name));
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('speaker and playback acknowledgements', () => {
  it('requires a speaker ticket and reports real playing before a fast ended event', async () => {
    const startAck = Promise.withResolvers<Response>();
    const f = await fixture({ startAck: startAck.promise });
    f.send(say('before-owner'));
    expect(f.players).toHaveLength(0);
    f.owner();
    f.send(say());
    await settle();
    const player = f.players[0]!;
    expect(player.src).toBe('data:audio/wav;base64,RklYVFVSRQ==');
    expect(f.store.getState().playback.state).toBe('loading');
    expect(f.store.getState().line).toBeNull();
    emit(player, 'loadedmetadata');
    expect(f.receipts()).toEqual([]);
    player.currentTime = 0.05;
    emit(player, 'playing');
    emit(player, 'playing');
    emit(player, 'ended');
    expect(f.receipts()).toEqual([receipt('started')]);
    expect(f.fetchMock.mock.calls[0]?.[0]).toContain('positionMs=50');
    startAck.resolve(new Response(null, { status: 204 }));
    await settle();
    expect(f.receipts()).toEqual([receipt('started'), receipt('ended')]);
    expect(f.store.getState().playback.lastEndedId).toBe('line-1');
    f.send(say());
    expect(f.players).toHaveLength(1);
    expect(player.play).toHaveBeenCalledOnce();
  });

  it('reports refusal as failed and unlocks only future speech', async () => {
    const f = await fixture({ path: '/audio', reject: true });
    f.owner();
    f.send(say());
    await settle();
    expect(f.receipts()).toEqual([receipt('failed')]);
    expect(f.store.getState().needsClick).toBe(true);
    expect(f.store.getState().playback.lastEndedId).toBeNull();
    f.store.unlockAudio();
    await settle();
    expect(f.players).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.receipts()).toHaveLength(1);
  });

  it('reports a load error once and pauses the failed player', async () => {
    const f = await fixture();
    f.owner();
    f.send(say());
    emit(f.players[0]!, 'error');
    expect(f.players[0]!.pause).toHaveBeenCalledOnce();
    expect(f.receipts()).toEqual([receipt('failed')]);
    expect(f.store.getState().playback.lastEndedId).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.receipts()).toHaveLength(1);
  });

  it.each([
    [[], 'playback-load-timeout'],
    [['loadedmetadata'], 'playback-start-timeout'],
    [['loadedmetadata', 'playing'], 'playback-end-timeout'],
  ] as const)('distinguishes playback watchdog phases for events %j', async (events, detail) => {
    const f = await fixture();
    f.owner();
    f.send(say());
    for (const event of events) emit(f.players[0]!, event);
    await vi.advanceTimersByTimeAsync(6000);
    emit(f.players[0]!, 'ended');
    expect(f.receipts().at(-1)).toEqual(receipt('timeout'));
    expect(f.receipts()).toHaveLength(events.length === 2 ? 2 : 1);
    const lastRequest = new URL(f.fetchMock.mock.calls.at(-1)![0], location.origin);
    expect(lastRequest.searchParams.get('detail')).toBe(detail);
    expect(f.players[0]!.pause).toHaveBeenCalledOnce();
    expect(f.store.getState().playback.lastEndedId).toBeNull();
  });

  it('stops on the host terminal event and sends no second receipt', async () => {
    const f = await fixture({ path: '/audio' });
    f.owner();
    f.send(say());
    emit(f.players[0]!, 'playing');
    f.send(terminal('line-1', 'timeout'));
    emit(f.players[0]!, 'ended');
    await settle();
    expect(f.players[0]!.pause).toHaveBeenCalledOnce();
    expect(f.receipts()).toEqual([receipt('started')]);
    expect(f.store.getState().playback.state).toBe('timeout');
  });

  it('drops a delayed ended receipt when the host times out during start acknowledgement', async () => {
    const startAck = Promise.withResolvers<Response>();
    const f = await fixture({ startAck: startAck.promise });
    f.owner();
    f.send(say());
    emit(f.players[0]!, 'playing');
    emit(f.players[0]!, 'ended');
    f.send(terminal('line-1', 'timeout'));
    startAck.resolve(new Response(null, { status: 204 }));
    await settle();
    expect(f.receipts()).toEqual([receipt('started')]);
  });

  it('pauses and clears the old ticket on disconnect, with no stale receipt after reconnect', async () => {
    const startAck = Promise.withResolvers<Response>();
    const f = await fixture({ path: '/audio', startAck: startAck.promise });
    f.owner();
    f.send(say());
    emit(f.players[0]!, 'playing');
    f.streams[0]!.onerror?.();
    expect(f.players[0]!.pause).toHaveBeenCalledOnce();
    expect(f.fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    f.send(say('without-ticket'));
    expect(f.players).toHaveLength(1);
    emit(f.players[0]!, 'ended');
    f.owner('new-owner');
    f.send(say());
    f.send(say('line-2'));
    expect(f.players).toHaveLength(1);
    emit(f.players[0]!, 'playing');
    startAck.resolve(new Response(null, { status: 204 }));
    await settle();
    expect(f.receipts()).toEqual([receipt('started'), receipt('started', 'line-2', 'new-owner')]);
  });

  it('fails missing audio without fabricating a successful playback', async () => {
    const f = await fixture();
    f.owner();
    f.send(say('missing', null));
    expect(f.players).toHaveLength(0);
    expect(f.receipts()).toEqual([receipt('failed', 'missing')]);
    expect(f.store.getState().playback.lastEndedId).toBeNull();
  });
});

describe('independent browser sources', () => {
  it('renders only a transparent caption after actual start, clears the matching line, and never requests media or posts receipts', async () => {
    const f = await fixture({ path: '/subtitles', render: true });
    const long = '这是一行用于验证中文自动换行的较长字幕。'.repeat(6) + '\n第二行';
    await act(async () => {
      f.owner();
      f.send(say());
      f.store.unlockAudio();
      f.store.reportMedia('video', 'playing');
    });
    expect(document.querySelector('.ls-subtitle-source')?.textContent).toBe('');
    await act(async () => { f.send({ ...subtitle('line-1', long), estimateMs: 12_000 }); });
    const caption = () => document.querySelector('[data-subtitle-id]')?.textContent;
    expect(caption()).toBe('这是一行用于验证中文自动换行的较长字幕。');
    expect(f.store.getState().line?.startedAt).toBe(Date.now() - 150);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(caption()).toContain('第二行');
    expect(caption()!.length).toBeLessThanOrEqual(32);
    await act(async () => { f.send(terminal('old', 'failed')); });
    expect(document.querySelector('[data-subtitle-id]')).not.toBeNull();
    await act(async () => { f.send(terminal('line-1', 'cancelled')); });
    expect(document.querySelector('[data-subtitle-id]')).toBeNull();
    await act(async () => { f.send(subtitle('next')); f.streams[0]!.onerror?.(); });
    expect(document.querySelector('[data-subtitle-id]')).toBeNull();
    expect(document.querySelector('img, video, audio, .ls-canvas')).toBeNull();
    expect(f.players).toHaveLength(0);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.streams[0]!.url).toBe('/events?token=fixture');
  });

  it('renders an otherwise empty audio-only page and offers unlock after refusal', async () => {
    const f = await fixture({ path: '/audio', render: true, reject: true });
    expect(document.querySelector('.ls-audio-source')?.textContent).toBe('');
    await act(async () => {
      f.owner();
      f.send(subtitle());
      f.store.reportMedia('video', 'playing');
    });
    expect(f.players).toHaveLength(0);
    expect(f.fetchMock).not.toHaveBeenCalled();
    await act(async () => { f.send({ ...say(), speaker: '嘉宾' }); await settle(); });
    expect(f.players).toHaveLength(1);
    expect(document.querySelector('.ls-unlock')?.textContent).toContain('启用后续语音');
    expect(document.querySelector('img, video, .ls-canvas, [data-subtitle-id]')).toBeNull();
    await act(async () => { document.querySelector<HTMLButtonElement>('.ls-unlock')?.click(); });
    expect(document.querySelector('.ls-unlock')).toBeNull();
    expect(f.players).toHaveLength(1);
  });

  it('shows real captions in a standby combined source without replaying audio or reporting receipts', async () => {
    const f = await fixture();
    f.owner();
    f.send(subtitle());
    expect(f.store.getState().line?.id).toBe('line-1');
    f.send(terminal());
    expect(f.store.getState().line).toBeNull();
    expect(f.players).toHaveLength(0);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the original preview silent with estimate-only captions and no receipts', async () => {
    const f = await fixture({ path: '/stage' });
    f.owner();
    f.send(say());
    expect(f.store.getState().line?.id).toBe('line-1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.store.getState().line).toBeNull();
    expect(f.players).toHaveLength(0);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(f.streams[0]!.url).toContain('preview=1');
  });
});


describe('local listening', () => {
  const control = () => document.querySelector<HTMLButtonElement>('.ls-listen button')!;

  it('opens the listener only after the iframe click and uses the same player for real speech', async () => {
    const f = await fixture({ path: '/listen', render: true });
    f.store.connect();
    expect(control().textContent).toBe('启用试听');
    expect(f.streams).toHaveLength(0);
    expect(f.players).toHaveLength(0);

    await act(async () => { control().click(); });
    expect(control().textContent).toBe('停止试听');
    expect(f.streams).toHaveLength(1);
    expect(f.streams[0]!.url).toBe('/events?token=fixture');
    expect(f.receipts()).toEqual([]);
    const player = f.players[0]!;
    expect(player.isConnected).toBe(true);
    expect(player.play).toHaveBeenCalledOnce();
    await act(async () => {
      f.streams[0]!.onopen?.();
      f.owner();
      f.send(subtitle());
      f.send(say());
    });
    expect(f.players).toEqual([player]);
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(f.receipts()).toEqual([]);
    expect(document.querySelector('video, [data-subtitle-id]')).toBeNull();
    await act(async () => {
      emit(player, 'playing');
      emit(player, 'ended');
      await settle();
    });
    expect(f.receipts()).toEqual([receipt('started'), receipt('ended')]);

    await act(async () => {
      f.send(say('stopped-line'));
      emit(player, 'playing');
      control().click();
      emit(player, 'ended');
    });
    expect(f.streams[0]!.close).toHaveBeenCalledOnce();
    expect(player.getAttribute('src')).toBeNull();
    expect(f.receipts()).toEqual([receipt('started'), receipt('ended'), receipt('started', 'stopped-line')]);
  });

  it('cancels pending activation and closes an active stream when the user stops', async () => {
    const warmup = Promise.withResolvers<void>();
    const f = await fixture({ path: '/listen', render: true, warmup: warmup.promise });
    await act(async () => { control().click(); });
    expect(f.streams).toHaveLength(0);
    await act(async () => { control().click(); warmup.resolve(); });
    expect(control().textContent).toBe('启用试听');
    expect(f.streams).toHaveLength(0);
    expect(f.receipts()).toEqual([]);

    await act(async () => { control().click(); });
    await act(async () => {
      f.owner();
      f.send(say());
      emit(f.players[0]!, 'playing');
      f.streams[0]!.onerror?.();
    });
    expect(f.players[0]!.getAttribute('src')).toBeNull();
    expect(f.store.getState().connected).toBe(false);
    expect(control().textContent).toBe('停止试听');
    await act(async () => {
      control().click();
      f.streams[0]!.onopen?.();
      f.owner('old-ticket');
      f.send(say('late'));
      emit(f.players[0]!, 'ended');
    });
    expect(f.streams[0]!.close).toHaveBeenCalledOnce();
    expect(f.players[0]!.play).toHaveBeenCalledTimes(3);
    expect(f.receipts()).toEqual([receipt('started')]);
    expect(control().textContent).toBe('启用试听');
  });

  it('keeps the speech slot free if the browser refuses the activation playback', async () => {
    const f = await fixture({ path: '/listen', render: true, rejectWarmup: true });
    await act(async () => { control().click(); });
    expect(control().textContent).toBe('启用试听');
    expect(document.querySelector('.ls-listen [role=status]')?.textContent).toBe('播放受阻，请重试');
    expect(f.streams).toHaveLength(0);
    expect(f.receipts()).toEqual([]);
  });
});
