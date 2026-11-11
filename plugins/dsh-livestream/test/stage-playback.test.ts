import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StageEvent } from '../src/stage/protocol';

/** Browser APIs are fakes: these tests never fetch media or produce sound. */
async function fixture(preview = false, reject = false) {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
  const players: FakeAudio[] = [];
  const streams: FakeSource[] = [];
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }));
  class FakeAudio {
    currentTime = 0;
    paused = false;
    duration = 1;
    pauses = 0;
    onloadedmetadata: (() => void) | null = null;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly src = '') { if (src) players.push(this); }
    play(): Promise<void> { return reject && this.src ? Promise.reject(new Error('fixture refusal')) : Promise.resolve(); }
    pause(): void { this.paused = true; this.pauses += 1; }
  }
  class FakeSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(readonly url: string) { streams.push(this); }
    close(): void {}
  }
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('EventSource', FakeSource);
  vi.stubGlobal('location', { search: '?token=fixture' + (preview ? '&preview=1' : ''), reload: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('fetch', fetchMock);
  const store = await import('../src/stage/store');
  store.connect();
  const send = (event: StageEvent) => streams[0]!.onmessage?.({ data: JSON.stringify(event) });
  const receipts = () => fetchMock.mock.calls.map(args => {
    const url = new URL(String(args[0]), 'http://fixture.invalid');
    return { id: url.searchParams.get('id'), state: url.searchParams.get('state') };
  });
  return { store, players, streams, send, receipts };
}
const say = (id = 'line-1', audio: string | null = 'RklYVFVSRQ=='): Extract<StageEvent, { type: 'say' }> => ({ v: 1, type: 'say', id, text: 'fixture', mood: 'normal', audio, audioMime: 'audio/wav', timingSource: 'estimated', estimateMs: 1000, at: Date.now() });
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await Promise.resolve(); }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('original stage real playback receipts', () => {
  it('plays WAV and acknowledges ended only after the actual media event', async () => {
    const f = await fixture();
    f.send(say());
    await settle();
    expect(f.players[0]!.src).toBe('data:audio/wav;base64,RklYVFVSRQ==');
    expect(f.store.getState().playback.state).toBe('playing');
    expect(f.store.getState().playback.lastEndedId).toBeNull();
    expect(f.receipts()).toEqual([]);
    f.players[0]!.onended?.();
    expect(f.receipts()).toEqual([{ id: 'line-1', state: 'ended' }]);
    expect(f.store.getState().playback.lastEndedId).toBe('line-1');
    f.send(say());
    expect(f.players).toHaveLength(1);
  });
  it('reports refusal as failed and unlocks only future speech', async () => {
    const f = await fixture(false, true);
    f.send(say());
    await settle();
    expect(f.receipts()).toEqual([{ id: 'line-1', state: 'failed' }]);
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
    f.send(say());
    await settle();
    f.players[0]!.onerror?.();
    expect(f.players[0]!.paused).toBe(true);
    expect(f.receipts()).toEqual([{ id: 'line-1', state: 'failed' }]);
    expect(f.store.getState().playback.lastEndedId).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.receipts()).toHaveLength(1);
  });
  it('times out and ignores late ended callbacks after the owner was released', async () => {
    const f = await fixture();
    f.send(say());
    await settle();
    const lateEnded = f.players[0]!.onended;
    await vi.advanceTimersByTimeAsync(6000);
    lateEnded?.();
    expect(f.receipts()).toEqual([{ id: 'line-1', state: 'timeout' }]);
    expect(f.players[0]!.paused).toBe(true);
    expect(f.store.getState().playback.lastEndedId).toBeNull();
  });
  it('cancels an interrupted line before a new player starts and never overlaps it', async () => {
    const f = await fixture();
    f.send(say());
    await settle();
    f.send(say('line-2'));
    await settle();
    expect(f.players[0]!.paused).toBe(true);
    expect(f.receipts()).toEqual([{ id: 'line-1', state: 'cancelled' }]);
    f.players[1]!.onended?.();
    expect(f.receipts()[1]).toEqual({ id: 'line-2', state: 'ended' });
  });
  it('fails missing audio without fabricating a successful playback', async () => {
    const f = await fixture();
    f.send(say('missing', null));
    expect(f.players).toHaveLength(0);
    expect(f.receipts()).toEqual([{ id: 'missing', state: 'failed' }]);
    expect(f.store.getState().playback.lastEndedId).toBeNull();
  });
  it('keeps the original preview silent and sends no receipt', async () => {
    const f = await fixture(true);
    f.send(say());
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.players).toHaveLength(0);
    expect(f.receipts()).toEqual([]);
    expect(f.streams[0]!.url).toContain('preview=1');
    expect(f.store.getState().playback.lastEndedId).toBeNull();
  });
});
