/**
 * dsh-livestream 根插件（宿主端）：开舞台服务器，给控制台（网页端 client.tsx）用的路由。
 *
 *   GET  /api/dsh-livestream/state      直播状态、设置、舞台地址、能选的角色和模板
 *   POST /api/dsh-livestream/settings   改设置（房间号、角色、模板、音色……）
 *   POST /api/dsh-livestream/connect    连直播间（用 DSH 凭据里的 B 站 Cookie）    /disconnect 断开
 *   POST /api/dsh-livestream/onair      启用固定的爱莉直播会话；/offair 请求道别并结束回应
 *   POST /api/dsh-livestream/owner      主人跟她说话（排在弹幕前面）
 *   POST /api/dsh-livestream/simulate   模拟观众：不开直播间也能试（弹幕、礼物、进场……）
 *   GET  /api/dsh-livestream/events     控制台的事件流（SSE）：直播间事件、她说的话、大脑状态
 *
 * agent 子插件（./agent.ts）只挂载到已登记的爱莉直播会话，输入和播放结果沿用原生会话持久化。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionFetchMethod } from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { Config, resolveConfig } from '../config';
import { voiceStatus } from '../body/tts';
import { bindLivestreamAgentSetup, LIVESTREAM_SESSION_ID } from './session';
import { initializeRuntime, startLivestream } from './runtime';
export { Config } from '../config';
import { checkObs, connectObs } from '../body/obs';
import { pollQrLogin, startQrLogin, whoIs } from '../body/biliLogin';
import { SIMULATED_PREFIX } from '../body/show';
import type { LiveEvent, LiveUser } from '../core/live';
import type { GameSource, StageEvent } from '../stage/protocol';
import { splitByMood } from '../core/moodText';
import { speakable } from '../core/speakable';
import { GUEST_VOICE } from '../body/voices';
import { agentReady, asr, broadcast, cookie, DEFAULT_BOARD, hooks, placeGame, publishBoard, publishNotice, SECRETS, social, takeLive, currentCharacter, currentMoods, dm, packs, prepareSpeech, server, settings, show, updateSettings, type BlockedViewer, type Pace, type Settings } from './runtime';

export const name = 'elysia-dsh-livestream';
export const inject = ['connection', 'agents', 'agentDefaultModel', 'agentLoop', 'sessionPersistence', 'sessions', 'systemPrompt', 'tools', 'credentials'];

type HostContext = Context;
let localVoice: Awaited<ReturnType<typeof voiceStatus>> = { available: false, provider: 'breeze', label: '爱莉 · 本地 Breeze' };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (message: string, status = 400) => json({ ok: false, error: message }, status);

async function body<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error('请求超过 64 KiB 限制');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('请求 JSON 格式错误'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是 JSON 对象');
  return value as T;
}

function state() {
  return {
    ok: true,
    publisher: settings.publisher,
    voice: localVoice,
    show: show.status(),
    broadcast: broadcast.status(),
    settings: { ...settings, stageToken: undefined },
    stageUrl: server.url,
    characters: packs.list('characters'),
    templates: packs.list('templates'),
    asr: { available: asr.available },
    defaultBoard: DEFAULT_BOARD,
  };
}

/** dsh-game 给的画面来源：只认约定里的两种，别的当没有 */
/** 控制台填的节奏：空的项删掉（回到自动），秒数夹在 0～600，一次回几位 1～5，欢迎可以填 off */
function cleanPace(raw: Record<string, unknown>): Pace {
  const sec = (v: unknown) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Math.max(0, Math.min(600, Math.round(Number(v)))));
  const welcome = raw.welcomeSec === 'off' ? 'off' : sec(raw.welcomeSec);
  const thanks = sec(raw.thanksSec), follow = sec(raw.followSec);
  const picks = sec(raw.chatPicks);
  return {
    ...(welcome !== undefined ? { welcomeSec: welcome } : {}),
    ...(thanks !== undefined ? { thanksSec: thanks } : {}),
    ...(follow !== undefined ? { followSec: follow } : {}),
    ...(picks !== undefined ? { chatPicks: Math.max(1, Math.min(5, picks)) } : {}),
  };
}

/** 控制台填的黑名单：UID 是数字串；同一个 UID 只留一条 */
function cleanBlocked(raw: unknown): BlockedViewer[] {
  const out = new Map<string, BlockedViewer>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const b = item as Partial<BlockedViewer>;
    const uid = String(b.uid ?? '').trim();
    if (!/^\d{1,20}$/.test(uid)) continue;
    out.set(uid, { uid, name: String(b.name ?? '').trim().slice(0, 40), why: String(b.why ?? '').trim().slice(0, 200), at: Number(b.at) || Date.now() });
  }
  return [...out.values()];
}

function gameSource(value: unknown): GameSource | null {
  const v = value as { url?: unknown; window?: unknown; overlay?: unknown } | null;
  const web = (x: unknown): x is string => typeof x === 'string' && /^https?:\/\//.test(x);
  if (v && web(v.url)) return { url: v.url };
  if (v && typeof v.window === 'string' && v.window) return { window: v.window, ...(web(v.overlay) ? { overlay: v.overlay } : {}) };
  return null;
}

let simSeq = 0;
/** 模拟观众：控制台里填的名字和文字 → 一条直播事件 */
function simulated(input: { kind?: string; name?: string; text?: string; gift?: string; count?: number; yuan?: number; guard?: number }): LiveEvent | null {
  const name = (input.name ?? '').trim() || '模拟观众';
  const user: LiveUser = { id: `${SIMULATED_PREFIX}${name}`, name, ...(input.guard ? { guardLevel: input.guard } : {}) };
  const base = { id: `sim-${Date.now()}-${++simSeq}`, platform: 'bilibili' as const, ts: Date.now(), user };
  switch (input.kind) {
    case 'chat': return input.text?.trim() ? { ...base, kind: 'chat', text: input.text.trim() } : null;
    case 'gift': return { ...base, kind: 'gift', giftName: input.gift || '小花花', count: input.count ?? 1, valueYuan: input.yuan ?? 0.1 };
    case 'superchat': return input.text?.trim() ? { ...base, kind: 'superchat', text: input.text.trim(), valueYuan: input.yuan ?? 30 } : null;
    case 'membership': return { ...base, kind: 'membership', levelName: '舰长', level: 3, count: 1, valueYuan: 138 };
    case 'enter': return { ...base, kind: 'enter' };
    case 'follow': return { ...base, kind: 'follow' };
    default: return null;
  }
}

/** 下播后等她道别说完再停推 */
let waitingOffair: NodeJS.Timeout | null = null;
let endingTimer: NodeJS.Timeout | null = null;
/** 舞台的谢幕画面放多久（stage/store.ts 的 ENDING_MS 是 16 秒）：放完再停推流 */
const ENDING_SCENE_MS = 17_000;

export async function apply(ctx: HostContext, config: Config = {} as Config): Promise<void> {
  const selected = resolveConfig(config);
  const runtime = await initializeRuntime(ctx, selected);
  const release = ctx.effect(() => () => runtime.dispose(), 'elysia upstream runtime');
  try {
    bindLivestreamAgentSetup(ctx, selected);
    await server.start();
    localVoice = await voiceStatus();
  } catch (error) {
    await release();
    throw error;
  }
  // 直播身体：给 dsh-game 用（约定见 docs/game-live-contract.md）。在播时她的话由这里念、游戏画面由这里放上舞台
  ctx.provide('liveBody', {
    get onAir() { return show.isOnAir; },
    attention: (signal: AbortSignal) => show.waitAttention(signal),
    showGame: (source: unknown) => show.showGame(gameSource(source)),
  });
  ctx.effect(() => () => show.showGame(null), 'dsh-livestream game screen');

  const streams = new Set<() => void>();
  ctx.effect(() => () => {
    if (waitingOffair) clearInterval(waitingOffair);
    waitingOffair = null;
    if (endingTimer) clearTimeout(endingTimer);
    endingTimer = null;
    for (const close of streams) close();
    streams.clear();
  }, 'elysia livestream HTTP streams');

  const route = (path: string, methods: ConnectionFetchMethod[], handler: (request: Request) => Response | Promise<Response>, label: string) =>
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods, requestBody: 'buffered',
      fetch: async request => {
        try { return await handler(request); }
        catch (error) { return fail(publicError(error), 400); }
      },
    }), label);

  route('/api/dsh-livestream/state', ['GET'], () => json(state()), 'state');

  route('/api/dsh-livestream/settings', ['POST'], async (request) => {
    const patch = await body<Partial<Settings>>(request);
    const next: Partial<Settings> = {};
    if (patch.roomId !== undefined) {
      const room = Number(patch.roomId);
      if (!Number.isInteger(room) || room <= 0) return fail('房间号要是正整数');
      next.roomId = room;
    }
    if (patch.character !== undefined) {
      if (!packs.character(String(patch.character))) return fail('没有这个角色包');
      next.character = String(patch.character);
    }
    if (patch.template !== undefined) {
      if (!packs.template(String(patch.template))) return fail('没有这个模板');
      next.template = String(patch.template);
    }
    if (patch.voice !== undefined) {
      const voice = String(patch.voice).trim();
      if (voice && voice !== 'elysia-breeze') return fail('声音由本地 Breeze 配置持有，不能切换到未配置的音色');
      next.voice = voice;
    }
    if (patch.idleAfterSec !== undefined) next.idleAfterSec = Math.max(10, Math.min(600, Number(patch.idleAfterSec) || 45));
    if (patch.gameChatGapSec !== undefined) next.gameChatGapSec = Math.max(5, Math.min(120, Number(patch.gameChatGapSec) || 15));
    if (patch.pace !== undefined) next.pace = cleanPace({ ...settings.pace, ...patch.pace });
    if (patch.distillModel !== undefined) return fail('本部署不使用独立的自动记忆蒸馏模型');
    if (patch.broadcast !== undefined) next.broadcast = !!patch.broadcast;
    if (patch.areaId !== undefined) next.areaId = patch.areaId ? Number(patch.areaId) : null;
    if (patch.liveTitle !== undefined) next.liveTitle = String(patch.liveTitle).slice(0, 40);
    if (patch.liveCover !== undefined) next.liveCover = String(patch.liveCover).trim().replace(/^"|"$/g, '');
    if (patch.pushProtocol !== undefined) next.pushProtocol = patch.pushProtocol === 'rtmp' ? 'rtmp' : 'srt';
    if (patch.streamKbps !== undefined) next.streamKbps = Math.max(1000, Math.min(12000, Number(patch.streamKbps) || 4500));
    if (patch.asrPython !== undefined) next.asrPython = String(patch.asrPython).trim().replace(/^"|"$/g, '');
    if (patch.asrModel !== undefined) next.asrModel = String(patch.asrModel).trim() || 'large-v3-turbo';
    if (patch.boardText !== undefined) next.boardText = String(patch.boardText).replace(/\r/g, '').slice(0, 1000);
    if (patch.noticeText !== undefined) next.noticeText = String(patch.noticeText).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (patch.blocked !== undefined) next.blocked = cleanBlocked(patch.blocked);
    const own = (patch as { ownRoom?: boolean }).ownRoom;
    if (own !== undefined && settings.roomId) {
      const rooms = new Set(settings.ownRooms);
      if (own) rooms.add(settings.roomId); else rooms.delete(settings.roomId);
      next.ownRooms = [...rooms];
      show.rememberViewers = own && show.status().roomId === settings.roomId;
    }
    const repaint = (next.character && next.character !== settings.character) || (next.template && next.template !== settings.template);
    // 换了 Python 或模型：关掉正在跑的识别进程，下次用新的
    if ((next.asrPython !== undefined && next.asrPython !== settings.asrPython) || (next.asrModel !== undefined && next.asrModel !== settings.asrModel)) asr.close();
    updateSettings(next);
    if (next.boardText !== undefined) publishBoard();
    if (next.noticeText !== undefined) publishNotice();
    if (next.character) show.setNames(currentCharacter()?.names ?? []);
    if (repaint) show.stage.broadcast({ type: 'reload' });
    // 换了主题，游戏位可能挪了：OBS 里的游戏画面跟着挪
    if (next.template && show.gameSource) placeGame(show.gameSource);
    return json(state());
  }, 'settings');

  route('/api/dsh-livestream/connect', ['POST'], async () => {
    if (!settings.roomId) return fail('先填直播间房间号');
    show.connect(settings.roomId, await cookie(), settings.ownRooms.includes(settings.roomId));
    return json(state());
  }, 'connect');

  route('/api/dsh-livestream/disconnect', ['POST'], () => {
    show.disconnect();
    return json(state());
  }, 'disconnect');

  route('/api/dsh-livestream/onair', ['POST'], async (request) => {
    const { sessionId, gameSessionId } = await body<{ sessionId?: string; gameSessionId?: string }>(request);
    if (sessionId !== undefined && sessionId !== LIVESTREAM_SESSION_ID) return fail('只能使用已登记的爱莉直播会话', 409);
    if (gameSessionId) return fail('游戏意识实例尚未显式绑定，不能借用其他会话', 409);
    await startLivestream(ctx, selected);
    // 先推上流、后开播的：这一场一开始就不是彩排
    if (broadcast.streaming) show.markBroadcast();
    dm.newShow();
    social.newShow();
    return json(state());
  }, 'onair');

  route('/api/dsh-livestream/offair', ['POST'], () => {
    show.endLive();
    // 在推流：等她道别说完（这场结束），舞台放完谢幕，再停推、下播（以前一说完就断，观众看不到谢幕）
    if (broadcast.streaming && !waitingOffair) {
      waitingOffair = setInterval(() => {
        if (show.isOnAir) return;
        if (waitingOffair) clearInterval(waitingOffair);
        waitingOffair = null;
        endingTimer = setTimeout(() => {
          endingTimer = null;
          void broadcast.stop().catch(error => hooks.log('warn', publicError(error)));
        }, ENDING_SCENE_MS);
      }, 1000);
    }
    return json(state());
  }, 'offair');

  // 推流到 B 站：开播拿推流码、OBS 推流（在后台跑，进度看 state().broadcast）
  route('/api/dsh-livestream/broadcast/start', ['POST'], () => {
    if (settings.publisher !== 'obs') return fail('当前由本机直播姬推流；请使用舞台浏览器源，控制台只管理主播回应', 409);
    broadcast.start();
    return json(state());
  }, 'broadcast start');

  route('/api/dsh-livestream/broadcast/stop', ['POST'], async () => {
    if (settings.publisher !== 'obs') return fail('当前推流由直播姬持有，请在直播姬操作下播', 409);
    await broadcast.stop();
    return json(state());
  }, 'broadcast stop');

  // 检查 OBS：没开就打开（在 DSH 所在的桌面会话里），设好专用配置和场景，回一帧节目画面；不推流
  route('/api/dsh-livestream/obs/check', ['POST'], async () => {
    if (settings.publisher !== 'obs') return fail('当前选择直播姬发布，未授权控制 OBS', 409);
    try {
      const obs = await connectObs(true);
      try {
        return json({ ok: true, ...(await checkObs(obs, server.url, settings.streamKbps)) });
      } finally {
        obs.close();
      }
    } catch (err) {
      return fail((err as Error).message, 500);
    }
  }, 'obs check');

  // 开播账号：现在登的是谁；扫码登录（拿到的 Cookie 直接存进 DSH 凭据，不经过网页）
  route('/api/dsh-livestream/account', ['GET'], async () => json({ ok: true, account: await whoIs(await cookie()) }), 'account');
  route('/api/dsh-livestream/login/start', ['POST'], async () => {
    try {
      return json({ ok: true, ...(await startQrLogin()) });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }, 'login start');
  route('/api/dsh-livestream/login/poll', ['POST'], async (request) => {
    const { key } = await body<{ key?: string }>(request);
    if (!key) return fail('缺 key');
    try {
      const result = await pollQrLogin(String(key));
      if (result.state !== 'ok') return json({ ok: true, state: result.state, ...(result.state === 'error' ? { message: result.message } : {}) });
      const account = await whoIs(result.cookie);
      if (!account) return json({ ok: true, state: 'error', message: '登录成功了，但用这个 Cookie 查不到账号' });
      await hooks.setSecret(SECRETS.cookie, result.cookie);
      return json({ ok: true, state: 'ok', account });
    } catch (err) {
      return fail((err as Error).message, 502);
    }
  }, 'login poll');

  // 点单队列：主人改一单的状态（{ id, state: queued|doing|done|dropped }），或者清空（{ clear: true }）
  route('/api/dsh-livestream/orders', ['POST'], async (request) => {
    const { id, state: to, clear } = await body<{ id?: number; state?: string; clear?: boolean }>(request);
    const ok = (['queued', 'doing', 'done', 'dropped'] as const).find((s) => s === to);
    return show.ownerOrders({ id: Number(id) || undefined, state: ok, clear: !!clear }) ? json(state()) : fail('没有这一单，或者状态不对');
  }, 'orders');

  route('/api/dsh-livestream/owner', ['POST'], async (request) => {
    const { text, who, line } = await body<{ text?: string; who?: string; line?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    // line: 'game'：只交给游戏线（长图纸、坐标清单这类只关游戏的事），直播线不经手
    if (line === 'game') return show.ownerToGame(text) ? json({ ok: true }) : fail('这场没开游戏线');
    show.ownerSay(text, who ? String(who).slice(0, 20) : undefined);
    return json({ ok: true });
  }, 'owner');

  // 嘉宾上直播间说话（Claude 小姐这些在电脑前帮忙管直播的人）：用嘉宾的音色念给观众听，字幕写嘉宾的名字；念完交给她回。念完才返回
  route('/api/dsh-livestream/guest', ['POST'], async (request) => {
    const { who, text, voice } = await body<{ who?: string; text?: string; voice?: string }>(request);
    if (!text?.trim()) return fail('说点什么');
    if (!show.isOnAir) return fail('没在播');
    const name = String(who ?? '').trim().slice(0, 20) || 'Claude小姐';
    const said = await show.guestSay(name, text.slice(0, 300), String(voice ?? '').trim() || GUEST_VOICE, AbortSignal.timeout(120_000));
    return json({ ok: true, said });
  }, 'guest');

  // 操作人口播请求交给主体决定是否采用；prepare 仅预合成，不播放，也不记录为主体发言。
  // prepare: true 只提前合成好语音（一串台词先全部 prepare，念的时候句和句之间不用等合成）
  route('/api/dsh-livestream/say', ['POST'], async (request) => {
    const { text, prepare } = await body<{ text?: string; prepare?: boolean }>(request);
    if (!text?.trim()) return fail('念什么');
    if (prepare) {
      for (const part of splitByMood(text.slice(0, 500), currentMoods())) prepareSpeech(speakable(part.text));
      return json({ ok: true });
    }
    if (!show.isOnAir) return fail('请先启用主播回应，再提交口播请求');
    // Operator scripts remain another actor's request until the subject chooses
    // to adopt or re-express them through its own durable conversation.
    show.ownerSay('以下是操作者的口播请求，不代表你已经说过。是否采用、如何表达由你决定。\n\n' + text, '操作者·口播请求');
    return json({ ok: true, queued: true, said: [] });
  }, 'say');

  route('/api/dsh-livestream/simulate', ['POST'], async (request) => {
    const event = simulated(await body(request));
    if (!event) return fail('模拟的事件不完整');
    show.inject(event);
    return json({ ok: true });
  }, 'simulate');

  // 控制台的事件流：舞台事件（不带语音）+ 每秒一次状态
  route('/api/dsh-livestream/events', ['GET'], () => {
    let unsubscribe: (() => void) | null = null;
    let tick: NodeJS.Timeout | null = null;
    let closeStream: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStream = () => {
          unsubscribe?.(); unsubscribe = null;
          if (tick) clearInterval(tick);
          tick = null;
          try { controller.close(); } catch {}
          if (closeStream) streams.delete(closeStream);
        };
        streams.add(closeStream);
        const enc = new TextEncoder();
        const send = (text: string) => { try { controller.enqueue(enc.encode(text)); } catch { /* 已关闭 */ } };
        unsubscribe = show.stage.subscribe((event: StageEvent) => {
          if (event.type === 'hello') return;
          send(`data: ${JSON.stringify(event.type === 'say' ? { ...event, audio: null } : event)}\n\n`);
        }, false);
        const status = () => {
          send(`event: status\ndata: ${JSON.stringify(show.status())}\n\n`);
          send(`event: broadcast\ndata: ${JSON.stringify(broadcast.status())}\n\n`);
        };
        tick = setInterval(status, 1000);
        status();
      },
      cancel() { closeStream?.(); },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }, 'events');
}


/** Return a technical reason without publishing URLs containing capabilities. */
function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : '直播操作失败';
  return message.replace(/https?:\/\/\S+/g, '[地址已隐藏]')
    .replace(/(cookie|authorization|token|password|api[_ -]?key)\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .slice(0, 300);
}
