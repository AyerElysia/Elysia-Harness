import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DmError, type DmAccount } from '../src/body/biliAccount';
import { DmManager } from '../src/body/dm';

class FakeAccount implements DmAccount {
  follows = new Map<string, boolean>();
  replies = new Set<string>();
  fail: number | null = null;
  sent: Array<{ uid: string; text: string }> = [];
  loggedIn = true;
  async me() { return this.loggedIn ? 1 : 0; }
  async followsMe(uid: string) { return this.follows.get(uid) ?? false; }
  async replied(uid: string) { return this.replies.has(uid); }
  async send(uid: string, text: string) {
    if (this.fail !== null) { const code = this.fail; this.fail = null; throw new DmError(code, 'x'); }
    this.sent.push({ uid, text });
  }
}

const setup = () => {
  const account = new FakeAccount();
  let now = 1_000_000;
  const file = join(mkdtempSync(join(tmpdir(), 'dm-')), 'dm.json');
  const make = () => new DmManager(account, file, () => now, async (ms) => { now += ms; });
  return { account, dm: make(), make, advance: (ms: number) => { now += ms; } };
};
const A = { uid: '42', name: '阿杰' };

describe('one message until they follow or reply', () => {
  it('sends one, then refuses and says why', async () => {
    const { account, dm } = setup();
    const first = await dm.send(A, '给你推荐一个视频');
    expect(first.ok).toBe(true);
    expect(first.text).toContain('不能再给他发第二条');
    const second = await dm.send(A, '还有一个');
    expect(second.ok).toBe(false);
    expect(second.text).toContain('关注你或者回一句私信');
    expect(account.sent).toHaveLength(1);
  });
  it('remembers across restarts', async () => {
    const { dm, make } = setup();
    await dm.send(A, '第一条');
    expect((await make().send(A, '第二条')).ok).toBe(false);
  });
  it('sends again once they follow, or once they reply', async () => {
    const { account, dm } = setup();
    await dm.send(A, '第一条');
    account.follows.set('42', true);
    expect((await dm.send(A, '关注后')).ok).toBe(true);
    const B = { uid: '43', name: '小王' };
    await dm.send(B, '第一条');
    account.replies.add('43');
    expect((await dm.send(B, '回复后')).ok).toBe(true);
  });
  it('records 21047 from Bilibili the same way', async () => {
    const { account, dm } = setup();
    account.fail = 21047;
    expect((await dm.send(A, '你好')).text).toContain('以前已经收过');
    expect((await dm.send(A, '再试')).text).toContain('只能发一条');
  });
});

describe('other limits', () => {
  it('stops trying viewers whose privacy settings block DMs', async () => {
    const { account, dm } = setup();
    account.fail = 25003;
    expect((await dm.send(A, '你好')).text).toContain('隐私设置');
    expect((await dm.send(A, '再试')).text).toContain('隐私设置');
    expect(account.sent).toHaveLength(0);
  });
  it('spaces messages and reports rate limits and length', async () => {
    const { account, dm } = setup();
    account.follows.set('42', true);
    account.fail = 21046;
    expect((await dm.send(A, '你好')).text).toContain('太快');
    expect((await dm.send(A, '字'.repeat(700))).text).toContain('太长');
  });
  it('keeps sending to a follower as often as she likes, and needs a login', async () => {
    const { account, dm } = setup();
    account.follows.set('42', true);
    for (let i = 0; i < 6; i++) expect((await dm.send(A, `第${i}条`)).ok).toBe(true);
    account.loggedIn = false;
    expect((await dm.send(A, '再来一条')).text).toContain('没登录');
  });
});
