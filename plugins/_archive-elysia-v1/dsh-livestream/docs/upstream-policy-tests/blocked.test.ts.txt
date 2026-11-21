import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';

const viewer = (uid: string) => ({ id: uid, name: `观众${uid}` });

describe('a viewer on the owner blocklist', () => {
  afterEach(() => vi.useRealTimers());

  it('never reaches her: no welcome, no reply, no stage line; others still do', async () => {
    vi.useFakeTimers();
    const blocked = new Set(['666']);
    const pushed: string[] = [];
    const show = new LiveShow(
      { push: async (_s, text) => { pushed.push(text); return true; }, synthesize: async () => null },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-blocked-')), names: ['大肥鱼'], blocked: (uid) => blocked.has(uid) },
    );
    const staged: string[] = [];
    show.stage.subscribe((e: any) => { if (e.type === 'live') staged.push(e.event.user?.id ?? e.event.user?.name ?? ''); }, false);
    show.goLive('s1');
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('s1');

    show.inject({ kind: 'enter', id: 'e1', platform: 'bilibili', ts: Date.now(), user: viewer('666') });
    show.inject({ kind: 'chat', id: 'c1', platform: 'bilibili', ts: Date.now(), user: viewer('666'), text: '别再私信我了' });
    expect(show.status().pending.welcome + show.status().pending.chats).toBe(0);
    expect(show.isBlocked('666')).toBe(true);

    show.inject({ kind: 'chat', id: 'c2', platform: 'bilibili', ts: Date.now(), user: viewer('7'), text: '你好呀' });
    expect(show.status().pending.chats).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pushed.some((t) => t.includes('观众666') || t.includes('别再私信我了'))).toBe(false);
    expect(pushed.some((t) => t.includes('你好呀'))).toBe(true);
    expect(staged.every((id) => !id.includes('666'))).toBe(true);
    show.dispose();
  });
});
