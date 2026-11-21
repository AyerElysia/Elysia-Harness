import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';

describe('a guest speaking on stream', () => {
  afterEach(() => vi.useRealTimers());

  it('speaks in the guest voice under the guest name, then hands the line to her', async () => {
    vi.useFakeTimers();
    const pushed: string[] = [];
    const voices: Array<string | undefined> = [];
    const show = new LiveShow(
      { push: async (_s, text) => { pushed.push(text); return true; }, synthesize: async (_t, _s, voice) => { voices.push(voice); return null; } },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-guest-')), names: ['大肥鱼'] },
    );
    const says: any[] = [];
    show.stage.subscribe((e: any) => { if (e.type === 'say') says.push(e); }, false);
    show.goLive('live');
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    const speaking = show.guestSay('Claude小姐', '大肥鱼，去找羊做床！', 'zh_female_zhixingnv_uranus_bigtts', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await speaking).toBe('大肥鱼，去找羊做床！');
    const guestLine = says.find((s) => s.speaker === 'Claude小姐');
    expect(guestLine).toMatchObject({ text: '大肥鱼，去找羊做床！', mood: '' });
    expect(voices).toContain('zh_female_zhixingnv_uranus_bigtts');
    // 念完交给她：她知道是谁、说了什么
    expect(pushed.some((t) => t.includes('<Claude小姐>大肥鱼，去找羊做床！</Claude小姐>'))).toBe(true);
    show.dispose();
  });
});
