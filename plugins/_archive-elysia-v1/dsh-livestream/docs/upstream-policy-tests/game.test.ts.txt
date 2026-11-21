import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveShow } from '../src/body/show';
import { arrange, gameRect } from '../src/stage/layout';
import { topicText } from '../src/core/topicText';
import type { TemplateManifest } from '../src/stage/protocol';

const chat = (id: string, text: string) => ({ kind: 'chat' as const, id, platform: 'bilibili' as const, ts: Date.now(), user: { id: `u-${id}`, name: `观众${id}` }, text });

describe('playing a game on stream', () => {
  afterEach(() => vi.useRealTimers());

  function start() {
    vi.useFakeTimers();
    const pushed: string[] = [];
    const midTurn: boolean[] = [];
    const onGame = vi.fn();
    const show = new LiveShow(
      { push: async (_s, text, now) => { pushed.push(text); midTurn.push(!!now); return true; }, synthesize: async () => null, onGame },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-game-live-')), names: ['大肥鱼'] },
    );
    show.goLive('s1');
    return { show, pushed, midTurn, onGame };
  }

  it('hands danmaku to her mid-game and wakes game_continue', async () => {
    const { show, pushed, midTurn, onGame } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('s1');
    show.showGame({ window: 'Minecraft:GLFW30:javaw.exe', overlay: 'http://127.0.0.1:7391/' });
    expect(onGame).toHaveBeenCalledWith({ window: 'Minecraft:GLFW30:javaw.exe', overlay: 'http://127.0.0.1:7391/' });
    // 她开始玩：一轮很长，在 game_continue 里等
    show.turnStarted('s1');
    const waiting = new AbortController();
    let woke = false;
    void show.waitAttention(waiting.signal).then(() => { woke = true; });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(pushed).toHaveLength(1); // 只有开场：玩游戏的时候不找话说，也不当她卡住
    expect(woke).toBe(false);
    show.inject(chat('1', '挖到钻石了吗'));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('挖到钻石了吗');
    // 插进她这一轮的下一步（steer），不是排到下一轮
    expect(midTurn[1]).toBe(true);
    expect(woke).toBe(true);
    // 隔得太近的攒着，过了间隔再推
    show.inject(chat('2', '小心苦力怕'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pushed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toContain('小心苦力怕');
    show.endLive();
    show.dispose();
  });

  it('calls her back to the game when her turn stops, and goes back to normal when the game ends', async () => {
    const { show, pushed } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.showGame({ url: 'http://127.0.0.1:7400/' });
    show.turnEnded('s1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('game_continue');
    show.turnEnded('s1');
    show.showGame(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushed).toHaveLength(2);
    show.endLive();
    show.dispose();
  });

  it('holds danmaku while her mouth is backed up', async () => {
    const { show, pushed } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('s1');
    show.showGame({ window: 'w' });
    show.turnStarted('s1');
    const quiet = new AbortController().signal;
    void show.say('这是一句挺长的话，念起来要好几秒钟才能念完的那种，观众在等。', 'talk', quiet);
    void show.say('第二句也很长，嘴里排着两句的时候，新的弹幕先别推给她。', 'talk', quiet);
    show.inject(chat('9', '你好呀'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pushed.some((p) => p.includes('你好呀'))).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(pushed.some((p) => p.includes('你好呀'))).toBe(true);
    show.endLive();
    show.dispose();
  });

  it('lets game_continue give up waiting', async () => {
    const { show } = start();
    const waiting = new AbortController();
    let woke = false;
    void show.waitAttention(waiting.signal).then(() => { woke = true; });
    waiting.abort();
    show.showGame({ window: 'w' });
    show.turnStarted('s1');
    show.inject(chat('3', '你好'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(woke).toBe(false);
    show.endLive();
    show.dispose();
  });
});

describe('game layout', () => {
  const t = {
    format: 1, id: 't', name: 't', canvas: [1920, 1080], theme: {},
    widgets: [{ type: 'chat', x: 40, y: 100, w: 480, h: 900 }, { type: 'subtitle', x: 600, y: 800, w: 700, h: 200 }],
    layouts: { video: [{ type: 'video', x: 560, y: 112, w: 1100, h: 619 }, { type: 'subtitle', x: 560, y: 747, w: 1100, h: 295 }] },
  } as unknown as TemplateManifest;

  it('borrows the video layout and puts the game where the video goes', () => {
    const game = arrange(t, 'game');
    expect(game.find((s) => s.type === 'game')).toMatchObject({ x: 560, y: 112, w: 1100, h: 619 });
    expect(game.find((s) => s.type === 'game')?.hidden).toBeFalsy();
    expect(game.find((s) => s.type === 'video')?.hidden).toBe(true);
    expect(game.find((s) => s.type === 'subtitle')).toMatchObject({ x: 560, y: 747 });
    expect(arrange(t, 'chat').find((s) => s.type === 'game')?.hidden).toBe(true);
    expect(gameRect(t)).toEqual({ x: 560, y: 112, w: 1100, h: 619 });
  });

  it('keeps the same keys across layouts so widgets glide', () => {
    const keys = (m: 'chat' | 'video' | 'game') => arrange(t, m).map((s) => s.key).sort();
    expect(keys('chat')).toEqual(keys('game'));
    expect(keys('video')).toEqual(keys('game'));
  });
});

describe('replies while playing', () => {
  it('asks for a short line while she plays', () => {
    const topic = { kind: 'chat' as const, picks: [{ event: chat('1', '挖到钻石了吗'), text: '挖到钻石了吗', tags: [], score: 1 }], id: 'c', priority: 10, heat: 'quiet' as const, createdAt: 0 };
    expect(topicText(topic, { inGame: true })).toContain('你正在玩游戏，');
    expect(topicText(topic, { inGame: true })).toContain('不超过 30 字');
    expect(topicText(topic, {})).toContain('不超过 60 字');
  });
});

describe('game line: the game in its own session', () => {
  afterEach(() => vi.useRealTimers());

  function start() {
    vi.useFakeTimers();
    const pushed: { session: string; text: string; now: boolean }[] = [];
    const show = new LiveShow(
      { push: async (session, text, now) => { pushed.push({ session, text, now: !!now }); return true; }, synthesize: async () => null },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-game-line-')), names: ['大肥鱼'] },
    );
    show.goLive('live', 'game');
    const to = (session: string) => pushed.filter((p) => p.session === session).map((p) => p.text);
    return { show, pushed, to };
  }

  it('sends the live room to the live line only, and keeps the game line playing', async () => {
    const { show, pushed, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    // 直播线把开游戏交给游戏线
    expect(show.toGameLine('开 Minecraft 接着玩')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(to('game')).toEqual(['你在直播间定下：开 Minecraft 接着玩\n去做就行，边做边说你在做什么。']);
    show.showGame({ window: 'Minecraft:GLFW30:javaw.exe' });
    show.setGameNow('主世界 (1, 64, 2) · 白天 · 血量 20/20；身体正在：采集 oak_log');
    // 弹幕只给直播线，不插进游戏线这一轮，也不叫醒 game_continue
    let woke = false;
    void show.waitAttention(new AbortController().signal).then(() => { woke = true; });
    show.inject(chat('1', '挖到钻石了吗'));
    await vi.advanceTimersByTimeAsync(3_000);
    const live = to('live');
    expect(live[live.length - 1]).toContain('挖到钻石了吗');
    expect(live[live.length - 1]).toMatch(/你在游戏里：（\d+ 秒前）主世界 \(1, 64, 2\)/);
    expect(to('game')).toHaveLength(1);
    expect(woke).toBe(false);
    // 直播线这一轮还没完（回弹幕的话还在念）也不耽误游戏线：游戏线这一轮停了，过一会儿就叫她接着玩
    show.turnEnded('game');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(to('game')).toHaveLength(2);
    expect(to('game')[1]).toContain('game_continue');
    expect(pushed.filter((p) => p.session === 'live').every((p) => !p.now)).toBe(true);
    show.dispose();
  });

  it('lets the game line speak before live replies already waiting on the mic', async () => {
    const { show } = start();
    await vi.advanceTimersByTimeAsync(500);
    const order: string[] = [];
    show.stage.subscribe((e: any) => { if (e.type === 'say') order.push(e.text); }, false);
    void show.say('第一句直播线', 'talk', new AbortController().signal);
    void show.say('第二句直播线', 'talk', new AbortController().signal);
    void show.say('苦力怕贴脸了', 'scared', new AbortController().signal, 'game');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order.slice(-3)).toEqual(['第一句直播线', '苦力怕贴脸了', '第二句直播线']);
    show.dispose();
  });

  it('hands a viewer\'s request to the game line with the viewer\'s own words, for the game line to answer', async () => {
    const { show, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    show.toGameLine('开 Minecraft');
    await vi.advanceTimersByTimeAsync(500);
    show.turnStarted('game');
    show.setGameNow('主世界 (1, 64, 2)', true);
    show.inject(chat('1', '塔太小了，再加高'));
    await vi.advanceTimersByTimeAsync(3_000);
    // 直播线回这条弹幕时把它交给游戏线
    show.toGameLine('塔加高加大，重来一遍');
    await vi.advanceTimersByTimeAsync(1_000);
    const mail = to('game')[to('game').length - 1];
    expect(mail).toContain('观众1：塔太小了，再加高');
    expect(mail).toContain('你在直播间定下：塔加高加大，重来一遍');
    expect(mail).toContain('点名回他');
    show.dispose();
  });

  it('keeps the owner\'s long text whole, and can hand it straight to the game line', async () => {
    const { show, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    const plan = `图例：A oak_planks、B glass、G gray_wool\n${'AAAABBBBGGGG\n'.repeat(40)}最后一行`;
    show.ownerSay(plan);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(to('live').some((t) => t.includes('最后一行'))).toBe(true);
    expect(show.ownerToGame(plan)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(to('game').some((t) => t.startsWith('主人跟你说（游戏上的事）：') && t.includes('最后一行'))).toBe(true);
    show.dispose();
  });

  it('tells the live line the game is off when the owner speaks before any game', async () => {
    const { show, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    show.ownerSay('开 Minecraft 去挖煤');
    await vi.advanceTimersByTimeAsync(1_000);
    const live = to('live');
    expect(live[live.length - 1]).toContain('开 Minecraft 去挖煤');
    expect(live[live.length - 1]).toContain('游戏现在没开。');
    show.dispose();
  });

  it('answers the owner once on the live line, and wakes the game line mid-turn for a hand-off', async () => {
    const { show, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    show.toGameLine('开 Minecraft');
    await vi.advanceTimersByTimeAsync(500);
    show.turnStarted('game');
    show.showGame({ window: 'Minecraft:GLFW30:javaw.exe' });
    let woke = false;
    void show.waitAttention(new AbortController().signal).then(() => { woke = true; });
    show.ownerSay('死掉的东西别回去捡');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(to('live').some((t) => t.includes('死掉的东西别回去捡'))).toBe(true);
    expect(to('game')).toHaveLength(1);
    expect(woke).toBe(false);
    // 她在直播线上把这件事定下来，插进游戏线这一轮并叫醒 game_continue
    show.toGameLine('掉的东西不回去捡了，就地重新采集');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(to('game')[1]).toContain('你在直播间定下：掉的东西不回去捡了，就地重新采集');
    expect(woke).toBe(true);
    show.dispose();
  });

  it('brings the game back after a plugin restart and tells the live line it dropped', async () => {
    vi.useFakeTimers();
    const pushed: { session: string; text: string }[] = [];
    const saved: any[] = [];
    const show = new LiveShow(
      { push: async (session, text) => { pushed.push({ session, text }); return true; }, synthesize: async () => null, persist: (s) => { saved.push(s); } },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-game-resume-')), names: ['大肥鱼'] },
    );
    show.resumeLive({ sessionId: 'live', gameSessionId: 'game', playing: true, roomId: null, streamId: null, logFile: null, at: Date.now() - 20_000 });
    // 重启后马上存的快照仍然记着在玩（再重启一次也不会忘）
    expect(saved[saved.length - 1]).toMatchObject({ gameSessionId: 'game', playing: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushed.filter((p) => p.session === 'game').map((p) => p.text)[0]).toContain('game_start');
    // 直播线知道游戏断了，不照着记忆讲
    show.turnEnded('live');
    show.inject(chat('1', '挖到钻石了吗'));
    await vi.advanceTimersByTimeAsync(3_000);
    const live = pushed.filter((p) => p.session === 'live').map((p) => p.text);
    expect(live[live.length - 1]).toContain('游戏也跟着断了，正在重新开');
    // 游戏线回到游戏里：换回游戏里的情况
    show.setGameNow('主世界 (1, 64, 2) · 白天 · 血量 20/20', true);
    show.turnEnded('live');
    show.inject(chat('2', '现在在哪'));
    await vi.advanceTimersByTimeAsync(3_000);
    const after = pushed.filter((p) => p.session === 'live').map((p) => p.text);
    expect(after[after.length - 1]).toMatch(/你在游戏里：（\d+ 秒前）主世界 \(1, 64, 2\)/);
    show.dispose();
  });

  it('never drops the game line\'s words, and the live line does not wait for them', async () => {
    const { show, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    // 嘴里排着两句直播线的话，游戏线的这句照样排上、照样念
    void show.say('欢迎欢迎', 'talk', new AbortController().signal);
    void show.say('谢谢关注', 'talk', new AbortController().signal);
    const dying = show.say('只剩半滴血了，拼一把', 'scared', new AbortController().signal, 'game');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await dying).toBe('只剩半滴血了，拼一把');
    // 只有游戏线的话在嘴里时，直播线照样推下一件
    show.turnEnded('live');
    void show.say('先挖条台阶上去', 'talk', new AbortController().signal, 'game');
    show.inject(chat('9', '你在干嘛'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(to('live').some((t) => t.includes('你在干嘛'))).toBe(true);
    show.dispose();
  });

  it('says goodbye after the game line has finished talking, knowing what it just said', async () => {
    const { show, to } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    // 游戏线做完最后一单、自己先道了别；这时主人点了下播
    void show.say('最后几单都做完了，今天就到这儿，谢谢大家', 'happy', new AbortController().signal, 'game');
    show.endLive();
    await vi.advanceTimersByTimeAsync(300);
    expect(to('live').some((t) => t.includes('直播到这里结束'))).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    const bye = to('live').find((t) => t.includes('直播到这里结束'))!;
    expect(bye).toContain('「最后几单都做完了，今天就到这儿，谢谢大家」');
    expect(bye).toContain('上面已经说过的就不用再说一遍');
    expect(bye).toMatch(/现在是\d+月\d+日/);
    show.dispose();
  });
});

describe('order queue: viewers\' requests the game line works through', () => {
  afterEach(() => vi.useRealTimers());

  function start(saved?: Parameters<LiveShow['resumeLive']>[0]) {
    vi.useFakeTimers();
    const pushed: { session: string; text: string }[] = [];
    const snaps: Array<Parameters<LiveShow['resumeLive']>[0]> = [];
    const show = new LiveShow(
      { push: async (session, text) => { pushed.push({ session, text }); return true; }, synthesize: async () => null, persist: (s) => { snaps.push(s); } },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-orders-')), names: ['大肥鱼'] },
    );
    const shown: unknown[] = [];
    const broadcast = show.stage.broadcast.bind(show.stage);
    show.stage.broadcast = (e: any) => { if (e.type === 'orders') shown.push(e.items); broadcast(e); };
    if (saved) show.resumeLive(saved); else show.goLive('live', 'game');
    const to = (session: string) => pushed.filter((p) => p.session === session).map((p) => p.text);
    return { show, to, shown, snaps };
  }

  it('queues the one viewer a hand-off is for, numbers it for the game line, and follows its tags', async () => {
    const { show, to, shown, snaps } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    show.toGameLine('开 Minecraft');
    show.setGameNow('主世界 (1, 64, 2)', true);
    show.inject(chat('1', '画我的头像'));
    await vi.advanceTimersByTimeAsync(3_000);
    show.toGameLine('把观众1的头像画成像素墙');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(to('game').at(-1)).toContain('记进了点单队列：#1 观众1');
    expect(shown.at(-1)).toEqual([{ id: 1, who: '观众1', text: '画我的头像', state: 'queued' }]);
    // 同一件事交两次：不重复记
    show.toGameLine('头像画大一点');
    expect((shown.at(-1) as unknown[]).length).toBe(1);
    show.markOrders([{ id: 1, state: 'doing' }]);
    expect((shown.at(-1) as any[])[0].state).toBe('doing');
    show.markOrders([{ id: 1, state: 'done' }]);
    expect((shown.at(-1) as any[])[0].state).toBe('done');
    expect(snaps.at(-1)?.orders?.items[0].state).toBe('done');
    show.dispose();
  });

  it('with several viewers in one batch, queues only the ones the live line names', async () => {
    const { show, shown } = start();
    await vi.advanceTimersByTimeAsync(500);
    show.turnEnded('live');
    show.toGameLine('开 Minecraft');
    show.setGameNow('主世界 (1, 64, 2)', true);
    show.inject(chat('1', '晚上好'));
    show.inject(chat('2', '盖个光棱塔'));
    await vi.advanceTimersByTimeAsync(3_000);
    show.toGameLine('盖光棱塔', '观众2');
    expect(shown.at(-1)).toEqual([{ id: 1, who: '观众2', text: '盖个光棱塔', state: 'queued' }]);
    // 没写是谁的、这件事里又有好几位：不乱记
    show.toGameLine('大家都欢迎');
    expect((shown.at(-1) as unknown[]).length).toBe(1);
    show.dispose();
  });

  it('keeps the queue across a plugin restart', async () => {
    const first = start();
    await vi.advanceTimersByTimeAsync(500);
    first.show.turnEnded('live');
    first.show.toGameLine('开 Minecraft');
    first.show.setGameNow('主世界 (1, 64, 2)', true);
    first.show.inject(chat('1', '画我的头像'));
    await vi.advanceTimersByTimeAsync(3_000);
    first.show.toGameLine('画头像');
    const snap = first.snaps.at(-1)!;
    first.show.dispose();
    const again = start(snap);
    expect(again.shown.at(-1)).toEqual([{ id: 1, who: '观众1', text: '画我的头像', state: 'queued' }]);
    again.show.dispose();
  });
});
