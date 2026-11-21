import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';

const viewer = (uid: string, name: string) => ({ id: uid, name });

describe('the show record', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps each viewer\'s own words and gifts by uid, and who each turn answered', async () => {
    vi.useFakeTimers();
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-record-'));
    const show = new LiveShow(
      { push: async () => true, synthesize: async () => null },
      { dataDir, names: ['大肥鱼'] },
    );
    show.goLive('s1');
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('s1');

    const ts = Date.now();
    show.inject({ kind: 'chat', id: 'c1', platform: 'bilibili', ts, user: viewer('18133139', 'Criker_six'), text: '画我的头像' });
    show.inject({ kind: 'gift', id: 'g1', platform: 'bilibili', ts, user: viewer('90611767', '疲丶倦'), giftName: '人气票', count: 1, valueYuan: 0.1 });
    show.inject({ kind: 'gift', id: 'g1', platform: 'bilibili', ts, user: viewer('90611767', '疲丶倦'), giftName: '人气票', count: 1, valueYuan: 0.1 });
    show.inject({ kind: 'gift', id: 'g0', platform: 'bilibili', ts, user: viewer('5', '白嫖'), giftName: '辣条', count: 1, valueYuan: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    show.dispose();

    const dir = join(dataDir, 'shows');
    const log = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toContainEqual(expect.objectContaining({ type: 'event', kind: 'chat', uid: '18133139', user: 'Criker_six', text: '画我的头像' }));
    const gifts = log.filter((e) => e.kind === 'gift');
    expect(gifts.every((e) => e.uid === '90611767' && e.id === 'g1' && e.gift === '人气票')).toBe(true); // 免费礼物不记
    expect(gifts.at(-1)).toMatchObject({ count: 2, yuan: 0.2 }); // 连击：最后一条是累计
    expect(log.some((e) => e.type === 'topic' && e.to?.includes('18133139'))).toBe(true);
  });
});
