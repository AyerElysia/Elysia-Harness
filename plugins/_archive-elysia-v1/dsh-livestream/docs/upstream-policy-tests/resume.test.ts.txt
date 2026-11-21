import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow, type LiveSnapshot } from '../src/body/show';

describe('resuming a show after the plugin restarts', () => {
  afterEach(() => vi.useRealTimers());

  function make(dataDir: string, saved: Array<LiveSnapshot | null>, pushed: string[], distilled: number[] = []) {
    return new LiveShow(
      {
        push: async (_s, text) => { pushed.push(text); return true; },
        synthesize: async () => null,
        persist: (s) => saved.push(s),
        distill: async (_sys, user) => { distilled.push(user.length); return '{}'; },
      },
      { dataDir, names: ['大肥鱼'] },
    );
  }

  it('keeps the show when the plugin stops, and picks it up with a note on how long it was gone', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'dsh-resume-'));
    const saved: Array<LiveSnapshot | null> = [];
    const first = make(dir, saved, []);
    first.rememberViewers = true;
    first.goLive('s1');
    await vi.advanceTimersByTimeAsync(500);
    first.turnEnded('s1');
    first.dispose();
    const snapshot = saved.at(-1)!;
    expect(snapshot).toMatchObject({ sessionId: 's1' });
    expect(snapshot.streamId).not.toBeNull();
    expect(saved).not.toContain(null);

    // DSH 重启：新的身体接着播，同一个会话、同一场记忆
    await vi.advanceTimersByTimeAsync(25_000);
    const pushed: string[] = [];
    const second = make(dir, saved, pushed);
    second.resumeLive(snapshot);
    await vi.advanceTimersByTimeAsync(500);
    expect(pushed[0]).toContain('直播插件刚才重启了一下');
    expect(pushed[0]).toMatch(/断了大约 2\d 秒/);
    expect(second.currentSession).toBe('s1');
    second.endLive();
    second.turnEnded('s1');
    await vi.advanceTimersByTimeAsync(1000);
    second.turnEnded('s1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved.at(-1)).toBeNull();
    second.dispose();
  });

  it('closes a show that was gone too long and still distills its viewers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-resume-'));
    const saved: Array<LiveSnapshot | null> = [];
    const first = make(dir, saved, []);
    first.rememberViewers = true;
    first.goLive('s1');
    first.inject({ kind: 'chat', id: 'c1', platform: 'bilibili', ts: Date.now(), user: { id: 'u1', name: '路人' }, text: '晚上好' });
    first.dispose();
    const distilled: number[] = [];
    const later = make(dir, [], [], distilled);
    later.closeStale(saved.at(-1)!);
    await new Promise((r) => setTimeout(r, 50));
    expect(distilled.length).toBeGreaterThan(0);
    later.dispose();
  });
});
