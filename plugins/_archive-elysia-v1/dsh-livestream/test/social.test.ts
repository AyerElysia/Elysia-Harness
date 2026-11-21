import { describe, expect, it, vi } from 'vitest';
import { SocialError, dmText, plain } from '../src/body/biliSocial';
import { COMMENT_GAP_MS, FAVORITE_FOLDER, SocialManager, type SocialApi } from '../src/body/social';

function fakeApi(over: Partial<SocialApi> = {}): SocialApi & { posted: Array<unknown[]>; calls: string[] } {
  const posted: Array<unknown[]> = [];
  const calls: string[] = [];
  const following = new Set<string>();
  return {
    posted,
    calls,
    relation: async (uid) => ({ iFollow: following.has(uid), followsMe: true }),
    follow: async (uid, follow) => { calls.push(`${follow ? 'follow' : 'unfollow'} ${uid}`); if (follow) following.add(uid); else following.delete(uid); },
    fans: async () => ({ total: 2, list: [{ uid: '7', name: '新粉丝', at: Date.now(), mutual: false }, { uid: '8', name: '老粉丝', at: Date.now(), mutual: true }] }),
    deleteComment: async (type, oid, rpid) => { calls.push(`delete ${type} ${oid} ${rpid}`); },
    markRead: async (uid) => { calls.push(`read ${uid}`); },
    postDynamic: async (text) => { calls.push(`dynamic ${text}`); return '123'; },
    favorite: async (aid, folder) => { calls.push(`favorite ${aid} ${folder}`); return 'added'; },
    coin: async (aid, n, like) => { calls.push(`coin ${aid} ${n} ${like}`); },
    coins: async () => 2100,
    mute: async (room, uid, hours) => { calls.push(`mute ${room} ${uid} ${hours}`); },
    muted: async () => [{ id: '55', uid: '9', name: '捣乱的', at: '', until: '' }],
    unmute: async (room, id) => { calls.push(`unmute ${room} ${id}`); },
    likeVideo: async () => true,
    likeComment: async () => {},
    comments: async () => ({
      count: 2,
      items: [
        { rpid: '11', root: '11', uid: '1', name: '小明', text: '好看', likes: 3, replies: 1, at: 0, sub: [{ rpid: '12', root: '11', uid: '2', name: '小红', text: '同意', likes: 0, replies: 0, at: 0 }] },
      ],
    }),
    comment: async (...args) => { posted.push(args); return `r${posted.length}`; },
    dmSessions: async () => [],
    dmMessages: async () => [],
    mentions: async () => [],
    names: async (uids) => new Map(uids.map((u) => [u, `用户${u}`])),
    ...over,
  };
}

const thread = { type: 1, oid: '100', title: '猫猫视频' };

describe('comments', () => {
  it('lists comments with ids and replies to one into its own floor', async () => {
    let now = 1_000_000;
    const api = fakeApi();
    const social = new SocialManager(api, () => now);
    const text = await social.readComments(thread, 'hot', 1);
    expect(text).toContain('[11] 小明（3 赞，1 条回复');
    expect(text).toContain('↳ [12] 小红：同意');
    const reply = await social.postComment(null, '我也觉得', '12');
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain('回复了 小红');
    expect(api.posted[0]).toEqual([1, '100', '我也觉得', '11', '12']);
  });

  it('only follows Bilibili rules: spacing between comments and knowing where to reply', async () => {
    let now = 1_000_000;
    const social = new SocialManager(fakeApi(), () => now);
    expect((await social.postComment(null, '你好', '999')).text).toContain('不知道 999');
    expect((await social.postComment(thread, '看这个 https://b23.tv/x')).ok).toBe(true);
    expect((await social.postComment(thread, '第二条')).text).toContain(`要隔 ${COMMENT_GAP_MS / 1000} 秒`);
    for (let i = 0; i < 15; i++) {
      now += COMMENT_GAP_MS;
      expect((await social.postComment(thread, `第${i + 3}条`)).ok).toBe(true);
    }
  });

  it('deletes her own comment by the id it handed back', async () => {
    const api = fakeApi();
    const social = new SocialManager(api);
    const posted = await social.postComment(thread, '发错了');
    expect(posted.text).toContain('编号是 r1');
    expect(await social.deleteComment('r1')).toContain('删掉了「猫猫视频」下你发的那条评论');
    expect(api.calls).toContain('delete 1 100 r1');
    expect(await social.deleteComment('r1')).toContain('不知道 r1');
  });

  it('says what went wrong in words she can act on', async () => {
    const social = new SocialManager(fakeApi({ comment: async () => { throw new SocialError(12015, '需要验证码'); } }));
    expect((await social.postComment(thread, '你好')).text).toContain('验证码');
  });

  it('unescapes Bilibili text', () => {
    expect(plain('&#34;我话越多&#34; &amp; 它越满')).toBe('"我话越多" & 它越满');
  });
});

describe('inbox', () => {
  it('only tells her about what came in after the show started', async () => {
    const sessions = [{ uid: '7', unread: 1, last: { fromMe: false, text: '在吗', at: 1 } }];
    const mentions = [{ id: 'reply-1', kind: 'reply' as const, uid: '8', name: '路人', text: '哈哈', yours: '我的评论', title: '宣传片', type: 1, oid: '100', rpid: '55', root: '50', at: 1 }];
    const api = fakeApi({ dmSessions: vi.fn(async () => sessions), mentions: vi.fn(async () => mentions) });
    const social = new SocialManager(api);
    expect(await social.newSince()).toEqual([]);
    sessions[0] = { uid: '7', unread: 2, last: { fromMe: false, text: '在吗在吗', at: 2 } };
    mentions.push({ ...mentions[0], id: 'at-2', kind: 'at', rpid: '60', text: '@你 来看' });
    const fresh = await social.newSince();
    expect(fresh).toHaveLength(2);
    expect(fresh[0]).toContain('用户7 私信了你');
    expect(fresh[1]).toContain('@ 了你');
    expect(await social.newSince()).toEqual([]);
    // 新来的回复也能直接回
    expect((await social.postComment(null, '谢谢', '60')).ok).toBe(true);
    expect(social.findTalker('用户7')).toEqual({ uid: '7', name: '用户7' });
  });

  it('lists conversations and mentions with their ids', async () => {
    const social = new SocialManager(fakeApi({
      dmSessions: async () => [{ uid: '7', unread: 1, last: { fromMe: false, text: '主播好', at: Date.now() } }],
      mentions: async () => [{ id: 'reply-1', kind: 'reply', uid: '8', name: '路人', text: '笑死', yours: '本鱼来了', title: '宣传片', type: 1, oid: '100', rpid: '55', root: '50', at: Date.now() }],
    }));
    const text = await social.inbox();
    expect(text).toContain('用户7（UID 7），1 条未读');
    expect(text).toContain('<私信>主播好</私信>');
    expect(text).toContain('[55] 路人');
    expect(text).toContain('回复了你「本鱼来了」');
  });
});

describe('account', () => {
  it('follows back, unfollows, and lists new fans', async () => {
    const api = fakeApi();
    const social = new SocialManager(api);
    expect(await social.follow('7', '新粉丝', true)).toContain('互相关注');
    expect(await social.follow('7', '新粉丝', false)).toContain('取关了');
    expect(api.calls).toEqual(['follow 7', 'unfollow 7']);
    const fans = await social.fans(1);
    expect(fans).toContain('新粉丝（UID 7）');
    expect(fans).toContain('你还没关注他');
    expect(fans).toContain('已互相关注');
  });

  it('posts dynamics, favorites into her own folder, coins, and marks DMs read', async () => {
    const api = fakeApi({ dmMessages: async () => [{ fromMe: false, text: '在吗', at: Date.now() }] });
    const social = new SocialManager(api);
    expect((await social.postDynamic('今晚播了六小时')).ok).toBe(true);
    expect(await social.favorite(42, '猫猫')).toContain(FAVORITE_FOLDER);
    expect(await social.coin(42, '猫猫', 2, true)).toContain('还剩 2100 个硬币');
    expect(await social.conversation('7', '新粉丝')).toContain('已标成已读');
    expect(api.calls).toEqual(['dynamic 今晚播了六小时', `favorite 42 ${FAVORITE_FOLDER}`, 'coin 42 2 true', 'read 7']);
  });

  it('mutes in the room and unmutes by name', async () => {
    const api = fakeApi();
    const social = new SocialManager(api);
    expect(await social.mute(26835777, '9', '捣乱的', 2)).toContain('禁言了 捣乱的 2 小时');
    expect(await social.unmute(26835777, '捣乱的')).toContain('解开了 捣乱的');
    expect(await social.unmute(26835777, '没这人')).toContain('现在被禁言的：捣乱的（UID 9）');
    expect(api.calls).toEqual(['mute 26835777 9 2', 'unmute 26835777 55']);
  });

  it('tells her plainly when Bilibili says no', async () => {
    const social = new SocialManager(fakeApi({ coin: async () => { throw new SocialError(34005, '超过投币上限'); } }));
    expect(await social.coin(42, '猫猫', 1, false)).toContain('投满了');
  });
});

describe('dm text', () => {
  it('gives an image dm its bilibili image url so the game can draw it', () => {
    const url = 'https://i0.hdslb.com/bfs/im/4f1c2d.png';
    expect(dmText(2, JSON.stringify({ url, width: 640, height: 640 }))).toBe(`[图片] ${url}`);
    expect(dmText(2, JSON.stringify({ url: 'https://evil.example.com/x.png' }))).toBe('[图片]');
    expect(dmText(1, JSON.stringify({ content: '你好' }))).toBe('你好');
  });
});
