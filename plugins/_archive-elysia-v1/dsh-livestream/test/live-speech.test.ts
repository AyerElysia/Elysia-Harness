import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveShow, type ShowHooks } from '../src/body/show';
import type { StageEvent } from '../src/stage/protocol';

type Say = Extract<StageEvent, { type: 'say' }>;

const pcm = { audio: new Uint8Array([1, 2]), timeline: [], audioMime: 'audio/wav' as const, durationMs: 10 };
const fixtures: Array<() => void> = [];

function fixture(extra: Partial<ShowHooks> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'elysia-live-speech-'));
  const synthesize = vi.fn<ShowHooks['synthesize']>(async () => pcm);
  const show = new LiveShow({ push: async () => false, synthesize, ...extra }, { dataDir: directory, names: ['fixture'] });
  const lines: Say[] = [];
  const unsubscribe = show.stage.subscribePlayback('fixture-owner', 'audio', event => {
    if (event.type === 'say') lines.push(event);
  });
  fixtures.push(() => { show.dispose(); unsubscribe(); rmSync(directory, { recursive: true, force: true }); });
  return { show, lines, synthesize, unsubscribe };
}

function signal() {
  return new AbortController().signal;
}

function started(show: LiveShow, id: string) {
  expect(show.stage.reportPlayback('audio', 'fixture-owner', id, { state: 'started' })).toBe(true);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of fixtures.splice(0)) dispose();
  vi.useRealTimers();
});

describe('explicit livestream speech', () => {
  it('routes tagged audio once, keeps caption clean, and waits for a real ended receipt', async () => {
    const { show, lines, synthesize } = fixture();
    show.goLive('fixture-session');
    const result = show.liveSay({
      id: 'stable-line', text: '[笑] 早呀！ [咳嗽] [清嗓子] [叹气] [开心]【动作】',
      expressionInstruction: '  轻声说  ', stageMood: 'smile',
    }, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(synthesize).toHaveBeenCalledExactlyOnceWith('[笑] 早呀！ [咳嗽] [清嗓子] [叹气]', expect.any(AbortSignal), undefined, '轻声说');
    expect(lines).toEqual([expect.objectContaining({ id: 'stable-line', text: '早呀！', mood: 'smile', audioMime: 'audio/wav' })]);
    expect(show.stats().spokenChars).toBe(0);
    expect(show.stage.reportPlayback('audio', 'fixture-owner', 'stable-line', { state: 'ended' })).toBe(false);
    started(show, 'stable-line');
    expect(show.stats().spokenChars).toBe(0);
    expect(show.stage.reportPlayback('audio', 'fixture-owner', 'stable-line', { state: 'ended' })).toBe(true);
    expect(await result).toEqual({ id: 'stable-line', state: 'ended' });
    expect(show.stats().spokenChars).toBe(3);
    expect(await show.liveSay({ id: 'stable-line', text: '重试' }, signal())).toMatchObject({ state: 'failed', detail: 'duplicate-speech-id' });
    expect(lines).toHaveLength(1);
  });

  it('returns the real timeout after the speech receipt expires', async () => {
    const { show, lines } = fixture();
    show.goLive('fixture-session');
    const result = show.liveSay({ id: 'no-ended', text: '测试。' }, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.map(line => line.id)).toEqual(['no-ended']);
    started(show, 'no-ended');
    await vi.advanceTimersByTimeAsync(15_011);
    expect(await result).toEqual({ id: 'no-ended', state: 'timeout', detail: 'playback-receipt-timeout' });
    expect(show.stats().spokenChars).toBe(0);
  });

  it('keeps an audible event with no words and reports a lost playback owner', async () => {
    const { show, lines, synthesize, unsubscribe } = fixture();
    show.goLive('fixture-session');
    const result = show.liveSay({ id: 'sound-only', text: '[笑]' }, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(synthesize).toHaveBeenCalledExactlyOnceWith('[笑]', expect.any(AbortSignal));
    expect(lines).toEqual([expect.objectContaining({ id: 'sound-only', text: '' })]);
    started(show, 'sound-only');
    unsubscribe();
    expect(await result).toMatchObject({ state: 'failed', detail: 'speaking-stage-disconnected' });
    expect(show.stats().spokenChars).toBe(0);
  });

  it('cancels a queued old route and does not move its speech to the new output', async () => {
    let output = 'rehearsal';
    const completion = Promise.withResolvers<typeof pcm>();
    const synthesize = vi.fn<ShowHooks['synthesize']>()
      .mockImplementationOnce(() => completion.promise)
      .mockResolvedValue(pcm);
    const { show, lines } = fixture({ synthesize, speechOutput: () => output });
    show.goLive('fixture-session');
    const old = show.liveSay({ id: 'old-synth', text: '旧路线在合成。' }, signal());
    const queued = show.liveSay({ id: 'old-queued', text: '旧路线在排队。' }, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(synthesize).toHaveBeenCalledTimes(1);

    output = 'public';
    await vi.advanceTimersByTimeAsync(100);
    completion.resolve(pcm);
    expect(await old).toMatchObject({ state: 'cancelled', detail: 'live-output-changed' });
    expect(await queued).toMatchObject({ state: 'cancelled', detail: 'live-output-changed' });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(0);

    const fresh = show.liveSay({ id: 'new-line', text: '新路线。' }, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.map(line => line.id)).toEqual(['new-line']);
    started(show, 'new-line');
    expect(show.stage.reportPlayback('audio', 'fixture-owner', 'new-line', { state: 'ended' })).toBe(true);
    expect(await fresh).toEqual({ id: 'new-line', state: 'ended' });
  });

  it('cancels the active line on the real publication transition without replay', async () => {
    const { show, lines } = fixture();
    show.goLive('fixture-session');
    const originalOutput = show.currentSpeechOutputKey;
    const result = show.liveSay({ id: 'old-route', text: '旧句。' }, signal());
    await vi.advanceTimersByTimeAsync(0);
    started(show, 'old-route');
    show.markBroadcast();
    expect(show.currentSpeechOutputKey).not.toBe(originalOutput);
    expect(await result).toEqual({ id: 'old-route', state: 'cancelled', detail: 'live-output-changed' });
    expect(show.stage.reportPlayback('audio', 'fixture-owner', 'old-route', { state: 'ended' })).toBe(false);
    expect(lines.map(line => line.id)).toEqual(['old-route']);
  });

  it('keeps queued input attributed to the show that received it', async () => {
    const release = Promise.withResolvers<Awaited<ReturnType<NonNullable<ShowHooks['journalInput']>>>>();
    const fixtureJournal = { ref: 'fixture', seq: 1, bytes: 10, hash: 'fixture' };
    const journalInput = vi.fn<NonNullable<ShowHooks['journalInput']>>()
      .mockImplementationOnce(() => release.promise)
      .mockResolvedValue(fixtureJournal);
    const { show } = fixture({ journalInput });
    expect(show.currentShowId).toBeUndefined();
    show.goLive('fixture-session');
    const old = show.currentShowId;
    expect(old).toEqual(expect.any(String));
    for (const id of ['raw-first', 'raw-second']) {
      show.inject({ kind: 'chat', platform: 'bilibili', id, ts: Date.now(), text: 'fixture', user: { id: 'user', name: 'viewer' } });
    }
    show.endLive();
    expect(show.currentShowId).toBe(old);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(show.currentShowId).toBeUndefined();
    expect(show.currentSpeechOutputKey).toBeUndefined();
    show.goLive('fixture-session');
    expect(show.currentShowId).not.toBe(old);
    release.resolve(fixtureJournal);
    await show.whenInputSettled();
    expect(journalInput.mock.calls.map(args => [args[0].id, args[3]])).toEqual([['raw-first', old], ['raw-second', old]]);
  });
});
