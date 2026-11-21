import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stage, type SpeechPlaybackState } from '../src/body/stage';

afterEach(() => vi.useRealTimers());

describe('speech playback receipts', () => {
  it('accepts a real ended receipt exactly once and clears its deadline', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {});
    const result = stage.waitSaid('line', 20, new AbortController().signal);
    expect(stage.said('other', 'ended')).toBe(false);
    expect(stage.said('line', 'ended')).toBe(true);
    expect(await result).toMatchObject({ id: 'line', state: 'ended' });
    expect(stage.said('line', 'failed')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['failed', 'cancelled', 'timeout'] as const)('preserves an explicit %s outcome', async (state: SpeechPlaybackState) => {
    const stage = new Stage();
    stage.subscribe(() => {});
    const result = stage.waitSaid('line', 20, new AbortController().signal);
    stage.said('line', state, 'engineering-reason');
    expect(await result).toMatchObject({ id: 'line', state, detail: 'engineering-reason' });
  });

  it('reports a lost receipt as timeout, never ended', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {});
    const result = stage.waitSaid('line', 20, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_020);
    expect(await result).toMatchObject({ state: 'timeout', detail: 'playback-receipt-timeout' });
    expect(stage.said('line', 'ended')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not treat a silent preview as a playing output', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {}, false);
    expect(await stage.waitSaid('line', 20, new AbortController().signal)).toMatchObject({
      state: 'failed', detail: 'no-speaking-stage',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels promptly and removes the waiter and deadline', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {});
    const controller = new AbortController();
    const result = stage.waitSaid('line', 20, controller.signal);
    controller.abort();
    expect(await result).toMatchObject({ state: 'cancelled' });
    expect(stage.said('line', 'ended')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(await stage.waitSaid('aborted', 20, controller.signal)).toMatchObject({ state: 'cancelled' });
  });

  it('reports loss of the last speaking stage as failure', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    const stop = stage.subscribe(() => {});
    const result = stage.waitSaid('line', 20, new AbortController().signal);
    stop();
    expect(await result).toMatchObject({ state: 'failed', detail: 'speaking-stage-disconnected' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a duplicate waiter without losing the original receipt', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {});
    const controller = new AbortController();
    const first = stage.waitSaid('line', 20, controller.signal);
    await expect(stage.waitSaid('line', 20, controller.signal)).rejects.toThrow(/Duplicate/);
    expect(stage.said('line', 'ended')).toBe(true);
    expect(await first).toMatchObject({ state: 'ended' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps microphone work serial and continues after a failure', async () => {
    const stage = new Stage();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const first = stage.withMic(async () => { started.push('first'); await hold; throw new Error('failed'); }).catch(error => error);
    const second = stage.withMic(async () => { started.push('second'); return 2; });
    await Promise.resolve();
    expect(started).toEqual(['first']);
    release();
    expect(await first).toMatchObject({ message: 'failed' });
    expect(await second).toBe(2);
    expect(started).toEqual(['first', 'second']);
  });
});
