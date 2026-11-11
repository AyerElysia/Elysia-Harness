import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player, type PlayRequest } from '../src/body/player';
import { Stage } from '../src/body/stage';

const request: PlayRequest = {
  bvid: 'fixture-bvid', title: 'Fixture clip', up: 'Fixture publisher',
  url: 'https://fixture.invalid/video.mp4', fromSec: 5, untilSec: 15,
};
const players: Player[] = [];

function fixture(speaker: boolean) {
  const stage = new Stage();
  if (speaker) stage.subscribe(() => {});
  const onEnd = vi.fn();
  const player = new Player(stage, onEnd);
  players.push(player);
  return { stage, player, onEnd };
}

afterEach(() => {
  for (const player of players.splice(0)) player.stop();
  vi.useRealTimers();
});

describe('video completion requires a real receipt', () => {
  it('fails without a speaking stage and never projects unobserved playback', async () => {
    vi.useFakeTimers();
    const { player, onEnd } = fixture(false);
    const video = player.play(request);
    const started = player.waitStart(video.id, 1000);
    expect(player.position()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(await started).toBe('error');
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: '没有可播放的舞台来源' }), 'error', 0);
    expect(player.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a missing playing receipt without counting guessed seconds as played', async () => {
    vi.useFakeTimers();
    const { player, onEnd } = fixture(true);
    player.play(request);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(player.position()).toBeNull();
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: '等待舞台开始播放的回执' }), 'error', 0);
    expect(player.current).toBeNull();
  });

  it('reports completion unknown after playing when no ended receipt arrives', async () => {
    vi.useFakeTimers();
    const { player, onEnd } = fixture(true);
    const video = player.play(request);
    player.report(video.id, 'playing', 7);
    expect(player.position()).toBe(7);
    await vi.advanceTimersByTimeAsync(15_999);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd.mock.calls[0]![0]).toMatchObject({ error: '未收到舞台播放结束回执，完成状态未知' });
    expect(onEnd.mock.calls[0]![1]).toBe('error');
    expect(player.current).toBeNull();
    player.report(video.id, 'ended');
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('succeeds only on a matching ended receipt and clears the fallback deadline', async () => {
    vi.useFakeTimers();
    const { player, onEnd } = fixture(true);
    const video = player.play(request);
    player.report(video.id, 'playing', 5);
    player.report('unrelated-id', 'ended');
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    player.report(video.id, 'ended', 15);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: video.id }), 'ended', 10);
    expect(player.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
