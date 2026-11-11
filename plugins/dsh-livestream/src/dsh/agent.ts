/**
 * agent 子插件：挂在爱莉固定直播会话的 scope 下，接上 DSH 的服务，盯着她直播的会话。
 *
 * 只有一个说话出口：她回复的正文。会话里每出现一条带正文的 assistant 消息就念一条（写出一段念一段），
 * 每条只念一次。正文里的 [表情] 标记（角色包里有的）把话切成几段，每段带着自己的表情念：说着说着可以换表情。
 * 只发工具调用、没写正文的消息很正常（她在做事），没有要念的就跳过。
 * 没有说话工具、没有 say 参数：那种「要模型自己选择用的通道」在 HiyoriAI 和 dsh-game 里都踩过坑（她会不用）。
 *
 * 身体往会话里推一件事：DSH 的 agent 句柄 followup（追加一条消息并唤醒她）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { LIVESTREAM_SESSION_ID, readJournal } from './session';
import { randomUUID } from 'node:crypto';
import { fetchProfile, profileSummary, profileText } from '../body/biliProfile';
import { clock, infoText, searchText, subtitleText, type Subtitles, type VideoInfo, type VideoPart } from '../body/biliVideo';
import { VideoNotes } from '../body/watchAlong';
import { lookupProblem } from '../core/viewerLookup';
import { splitByMood } from '../core/moodText';
import { orderTags } from '../core/orders';
import { ttsYuan, turnYuan } from '../core/cost';
import { asr, cookie, currentMoods, dm, hooks, library, markAgentReady, settings, show, social, videos } from './runtime';
import { BiliRoom } from '../body/biliRoom';
import { screenshot } from '../body/obs';
import { whoIs } from '../body/biliLogin';
import { COMMENT_GAP_MS, FAVORITE_FOLDER, MAX_COMMENT_CHARS } from '../body/social';

export const name = 'dsh-livestream-agent';
export const inject = ['tools'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  get?(name: string): any;
  [service: string]: any;
}

/** 已经念过的消息：会话 id + 消息序号 */
const voiced = new Set<string>();

/**
 * 直播线这一轮交给游戏线了没有：从调 game_side 的那条消息起，这一轮她写的话都不念（游戏里的她会点名回观众），下一轮重新算。
 * 只看调工具的那一条的话，她先调工具、下一条才写「交过去了」时会念出来，观众就听到两边各回一遍。
 */
export class HandOffs {
  private sessions = new Set<string>();

  turnStarted(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 这条消息不念（这一轮已经交出去了）返回 true */
  unsaid(sessionId: string, event: any): boolean {
    if ((event?.data?.message?.content ?? []).some((p: any) => p?.type === 'tool-call' && p.name === 'game_side')) this.sessions.add(sessionId);
    return this.sessions.has(sessionId);
  }
}

const wordsOf = (event: any): string => (event?.data?.message?.content ?? [])
  .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
  .map((p: any) => p.text.trim()).filter(Boolean).join('\n');

/**
 * 盯着直播的会话：新的正文就念，一轮开始、结束告诉身体。
 * 有游戏线时两个会话一起盯：游戏线的话也念（嘴里排满了就少念一句），它的时刻里摘出游戏现在怎样，写给直播线
 */
const cursors = new Map<string, number>();
const handOffs = new HandOffs();
let watching = false;
/** 这场直播（她的会话，有游戏线时两个加起来）累计用掉的 token 和钱：舞台上换算成她吃了多少饭，show_stats 告诉她 */
const freshUsage = (sessionId: string) => ({ sessionId, tokens: 0, input: 0, cacheRead: 0, output: 0, yuan: 0, priced: true, model: '' });
let usage = freshUsage('');
/** 游戏线最近一个时刻里的进度、身体、背包，和她在游戏线上最近说的一句 */
let gameMoment = '';
let gameWords = '';

function countUsage(sessionId: string, event: any, broadcast = true): void {
  const u = event?.data?.usage;
  const turn = Number(u?.totalTokens);
  if (!Number.isFinite(turn) || turn <= 0) return;
  if (usage.sessionId !== sessionId) usage = freshUsage(sessionId);
  usage.tokens += turn;
  usage.input += Number(u.inputTokens) || 0;
  usage.cacheRead += Number(u.cacheReadTokens) || 0;
  usage.output += Number(u.outputTokens) || 0;
  const model = event?.data?.message?.source?.model;
  if (typeof model === 'string') usage.model = model;
  const yuan = turnYuan(model, u, Number(event?.time) || Date.now());
  if (yuan === null) usage.priced = false; else usage.yuan += yuan;
  if (broadcast) show.stage.broadcast({ type: 'usage', tokens: usage.tokens, turn, ...(typeof model === 'string' ? { model } : {}) });
}

/** dsh-game 的时刻里摘出直播线要知道的：进度（位置、白天黑夜、血量饥饿）、身体在干什么、背包 */
export function momentSummary(text: string): string {
  const pick = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? '';
  const progress = pick(/【进度】([^\n]+)/);
  if (!progress) return '';
  const body = pick(/【说明】(身体[^\n]+)/);
  const bag = pick(/【说明】背包：([^\n]+)/).replace(/\s*等\s*(\d+)\s*种\s*$/, '……（一共 $1 种，这里只列了一部分：没列出的不等于没有）');
  // 背包整行给（以前截到 120 字，背包一满，钻石剑这些排在后面的就被截掉，她当着观众说「没有钻石剑」）
  return [progress, body, bag && `背包：${bag}`].filter(Boolean).join('；');
}

function publishGameNow(moment = false): void {
  show.setGameNow([gameMoment, gameWords && `你刚在游戏里说：「${gameWords}」`].filter(Boolean).join('；'), moment);
}

/**
 * 往她的会话里推一条消息并唤醒她；会话不在线返回 false。
 * 平时用 followup（排到下一轮：她这一轮做完再看）；now 用 steer（插进这一轮的下一步：
 * 她在玩游戏时一轮可以很长，用 followup 的话直播间的事要等她这一轮停下才看得到）
 */
async function push(ctx: AgentContext, sessionId: string, text: string, now = false): Promise<boolean> {
  const agents = ctx.get?.('agents');
  const found = agents?.get?.(sessionId);
  const agent = found?.followup ? found : found?.agent;
  if (!agent?.followup) return false;
  // 和 DSH 自己的 createUserMessage 一样：带 id、role，冻结（消息进会话后不能再改）
  const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-livestream' } });
  if (now && agent.steer) await agent.steer(message);
  else await agent.followup(message);
  return true;
}

/** 钱数写给她看：不到一分钱就说不到一分钱 */
function money(yuan: number): string {
  return yuan < 0.01 ? '不到 1 分钱' : `${yuan.toFixed(2)} 元`;
}

/** B 站没给时长时，不指定就放这么久（秒） */
const PLAY_UNKNOWN_SEC = 600;
/** play_video 最多等舞台多久确认开始放 */
const PLAY_CONFIRM_MS = 15_000;

/** 「1:30」「90」→ 秒 */
function seconds(value: unknown): number {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (!text) return 0;
  return Math.max(0, text.split(':').reduce((sum, n) => sum * 60 + (Number(n) || 0), 0));
}

/** 她说的一个人：私信过她的人、直播间里的观众（名字或 UID），或者任何 UID；认不出时返回告诉她怎么改的话 */
function person(who: string): { uid: string; name: string } | string {
  const w = who.trim();
  const talker = social.findTalker(w);
  if (talker) return talker;
  const viewer = show.lookupViewer(w);
  if (viewer.kind === 'found') return { uid: viewer.uid, name: viewer.user.name };
  if (/^\d{1,20}$/.test(w)) return { uid: w, name: `UID ${w}` };
  return lookupProblem(w, viewer);
}

/** 她给的视频（BV 号、av 号、链接）和第几 P → 视频详情；认不出、找不到时返回告诉她怎么改的话 */
async function findVideo(video: unknown, part: unknown): Promise<{ info: VideoInfo; part: VideoPart } | string> {
  const text = String(video ?? '').trim();
  const ref = await videos.resolve(text);
  if (!ref) return `没认出「${text.slice(0, 40)}」是哪个视频：video 填 BV 号（BV 开头的 12 位，search_videos 的结果和 view_profile 的投稿里都有）、av 号或者视频链接。`;
  const info = await videos.info(ref);
  if (!info) return `${ref.bvid ?? `av${ref.aid}`} 打不开：可能没有这个视频、被删了，或者 B 站没返回（网络问题）。检查一下号码。`;
  const page = Math.floor(Number(part) || ref.part || 1);
  const found = info.parts.find((p) => p.page === page);
  if (!found) return `「${info.title}」只有 ${info.parts.length} P，没有 P${page}。`;
  return { info, part: found };
}

/** 视频没字幕：听 from 所在的那一段（没配语音识别、听失败返回 null，照「没有字幕」说） */
async function listen(info: VideoInfo, part: VideoPart, from: number): Promise<Subtitles | null> {
  try {
    const heard = await asr.chunk({ bvid: info.bvid, cid: part.cid, durationSec: part.durationSec }, from, () => videos.audioUrl(info.bvid, part.cid),
      (text) => show.note('listen', `Whisper「${info.title.slice(0, 12)}」${text}`));
    const sub: Subtitles | null = heard ? { kind: 'asr', lang: heard.lang, lines: heard.lines, until: heard.until, engine: settings.asrModel } : null;
    library.subtitles(info, part, sub);
    return sub;
  } catch (err) {
    hooks.log('warn', `语音识别失败（${info.bvid}）：${(err as Error).message}`);
    return null;
  }
}

/** 视频库：B 站字幕拿到就存一份 */
async function officialSubtitles(info: VideoInfo, part: VideoPart): Promise<Subtitles | null> {
  const sub = await videos.subtitles(info.bvid, part.cid);
  library.subtitles(info, part, sub);
  return sub;
}

/** 原视频弹幕：拿到就进视频库 */
async function videoDanmaku(info: VideoInfo, part: VideoPart) {
  const list = await videos.danmaku(part.cid);
  library.danmaku(info, part, list);
  return list;
}

/** 视频库记一次看 / 放：哪场、点之前直播间在聊什么 */
function libraryView(how: 'watch' | 'play', fromSec: number, untilSec?: number) {
  const logName = show.logName;
  const chat = show.recentChat();
  return { how, at: Date.now(), fromSec, ...(untilSec !== undefined ? { untilSec } : {}), ...(logName ? { show: logName } : {}), ...(chat.length ? { chat } : {}) };
}

export const READ_ACTIONS = ['view_profile', 'read_comments', 'check_inbox', 'read_dm', 'look', 'show_stats', 'my_fans', 'search_videos', 'watch_video', 'play_video', 'stop_video', 'read_livestream_event', 'pass'] as const;
export const WRITE_ACTIONS = ['send_dm', 'like', 'post_comment', 'follow', 'delete_comment', 'post_dynamic', 'favorite', 'coin', 'mute', 'unmute', 'set_live_title'] as const;
export interface Config { allowedWriteActions?: string[] }

export function apply(ctx: Context, config: Config = {}): void {
  const agent = scopeOf(ctx) as Agent | undefined;
  if (agent?.id !== LIVESTREAM_SESSION_ID) throw new Error('Livestream capabilities require the exact fixed agent scope');
  const reads = new Set<string>(READ_ACTIONS);
  const writes = new Set<string>(WRITE_ACTIONS);
  const allowed = new Set(config.allowedWriteActions ?? []);
  for (const name of allowed) if (!writes.has(name)) throw new Error(`Unknown livestream write capability: ${name}`);
  const registerTool = (tool: Parameters<typeof ctx.tools.register>[0]) => {
    if (!reads.has(tool.name) && !allowed.has(tool.name)) return () => {};
    return ctx.tools.register(tool);
  };
  markAgentReady();
  let lastSeq = Number(agent.session.seq) - 1;
  ctx.on('session/event', (session, event) => {
    if (session.id !== LIVESTREAM_SESSION_ID || !show.isOnAir || Number(event.seq) <= lastSeq) return;
    lastSeq = Number(event.seq);
    if (event.type === 'turn/start') { handOffs.turnStarted(session.id); show.turnStarted(session.id); }
    else if (event.type === 'turn/end') show.turnEnded(session.id);
    else if (event.type === 'assistant/message') {
      countUsage(session.id, event);
      const words = wordsOf(event);
      if (!words) return;
      for (const part of splitByMood(words, currentMoods())) {
        void show.say(part.text, part.mood, AbortSignal.timeout(300_000), 'live', { sessionId: session.id, seq: Number(event.seq) })
          .catch(() => hooks.log('warn', 'Livestream playback failed; see stage delivery state'));
      }
    }
  });
  ctx.effect(() => registerTool(defineTool({
    name: 'read_livestream_event', description: '按本次直播输入的 ref 继续读取完整原始协议事件；UTF-8 字节分页，不读取其他会话。',
    parameters: { ref: { type: 'string', required: true }, offset: { type: 'number', required: true }, maxBytes: { type: 'number' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) { return JSON.stringify(readJournal(agent.session, String(args.ref), Number(args.offset), args.maxBytes === undefined ? 8192 : Number(args.maxBytes))); },
  })), 'read_livestream_event tool');
  ctx.effect(() => registerTool(defineTool({
    name: 'pass', description: '这一轮选择不作公开回应。', parameters: { reason: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) { return String(args.reason); },
  })), 'pass tool');

  // 看观众的 B 站主页（公开信息）
  ctx.effect(() => registerTool(defineTool({
    name: 'view_profile',
    description: '看一个 B 站个人主页：等级、签名、粉丝和关注数、最近投稿、置顶视频、代表作、空间公告、有没有直播间、头像图片的网址。'
      + '可以看观众的，也可以看你自己开播账号的。只看得到主页上公开的东西。要几秒钟。',
    parameters: {
      who: { type: 'string', required: true, description: '观众的名字（照消息里写的）或 UID；看你自己开播账号的主页填「自己」' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '');
      if (who.trim() === '自己') {
        const me = await whoIs(await cookie());
        if (!me) return '开播账号现在没登录，看不了自己的主页。';
        show.toolCall('view_profile', me.name, '在看自己的主页');
        const profile = await fetchProfile(String(me.uid), await cookie());
        return profile ? `你自己的开播账号（${me.name}，UID ${me.uid}）：
${profileText(profile)}` : '没打开自己的主页（B 站没返回，可能是网络问题）。';
      }
      const viewer = show.lookupViewer(who);
      if (viewer.kind !== 'found') return lookupProblem(who, viewer);
      if (show.isBlocked(viewer.uid)) return `${viewer.user.name} 在主人的黑名单上，不和他来往，主页也不看。`;
      if (show.optedOut(viewer.uid)) return `${viewer.user.name} 说过不想被记住，他的主页就不看了。`;
      show.toolCall('view_profile', viewer.how === 'unseen-uid' ? `UID ${viewer.uid}` : viewer.user.name, viewer.how === 'unseen-uid' ? `在看 UID ${viewer.uid} 的主页` : `在看${viewer.user.name}的主页`);
      const profile = await fetchProfile(viewer.uid, await cookie());
      if (!profile) return viewer.how === 'unseen-uid' ? `UID ${viewer.uid} 打不开：可能没有这个用户，检查一下数字。` : `没打开 ${viewer.user.name} 的主页（B 站没返回，可能是网络问题）。`;
      const marks = [
        viewer.user.guardLevel ? ['', '总督', '提督', '舰长'][viewer.user.guardLevel] : '',
        viewer.user.medal?.ofThisRoom ? `粉丝牌${viewer.user.medal.level}级` : '',
        viewer.user.isAdmin ? '房管' : '',
      ].filter(Boolean).join('，');
      show.rememberProfile(viewer.uid, profileSummary(profile));
      // 按名字的一部分找到的：告诉她是谁，对不上可以换 UID 再查
      const note = viewer.how === 'partial' ? `（按「${who}」找到的是 ${profile.name}；不是他的话，用 UID 再查）\n` : '';
      return note + profileText(profile, marks || undefined);
    },
  })), 'view_profile tool');

  // 私信观众（开播账号发）
  ctx.effect(() => registerTool(defineTool({
    name: 'send_dm',
    description: '用开播账号给一个人发一条 B 站私信（文字）：直播间里的观众、私信过你的人，或者任何 B 站用户（填 UID）。'
      + 'B 站规定：对方没关注开播账号、也没回过私信时，只能发一条，要等他关注或回复才能再发；结果里会告诉你他关注了没有。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（照消息里写的）或 UID' },
      text: { type: 'string', required: true, description: '私信内容（2000 字节以内）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      if (show.isBlocked(who.uid)) return `${who.name} 在主人的黑名单上，不给他发私信。`;
      if (show.optedOut(who.uid)) return `${who.name} 说过不想被记住，就不私信他了。`;
      show.toolCall('send_dm', `→ ${who.name}`, `在给${who.name}发私信`);
      const result = await dm.send(who, String(args.text ?? ''));
      if (result.ok) show.noteDm(who.name, String(args.text ?? ''));
      return result.text;
    },
  })), 'send_dm tool');

  // 点赞：视频或者一条评论
  ctx.effect(() => registerTool(defineTool({
    name: 'like',
    description: '用开播账号点赞：给一个 B 站视频（video），或者给一条评论（comment，read_comments / check_inbox 里方括号的编号）。',
    parameters: {
      video: { type: 'string', description: 'BV 号、av 号或视频链接' },
      comment: { type: 'string', description: '评论编号' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const comment = String(args.comment ?? '').trim();
      if (comment) {
        show.toolCall('like', `评论 ${comment}`, '在给评论点赞');
        return social.likeComment(comment);
      }
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      show.toolCall('like', `「${found.info.title.slice(0, 16)}」`, '在点赞');
      return social.likeVideo(found.info.aid, found.info.title);
    },
  })), 'like tool');

  // 看评论区
  ctx.effect(() => registerTool(defineTool({
    name: 'read_comments',
    description: '看一个 B 站视频的评论区：每条带编号（回复、点赞用）、名字、点赞数、楼里的几条回复。可以按热门或最新，可以翻页。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      sort: { type: 'string', enum: ['hot', 'new'], description: 'hot 热门（默认）、new 最新' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      const { info } = found;
      show.toolCall('read_comments', `「${info.title.slice(0, 16)}」`, `在看「${info.title.slice(0, 16)}」的评论区`);
      return social.readComments({ type: 1, oid: String(info.aid), title: info.title }, args.sort === 'new' ? 'new' : 'hot', Math.max(1, Math.floor(Number(args.page) || 1)));
    },
  })), 'read_comments tool');

  // 发评论
  ctx.effect(() => registerTool(defineTool({
    name: 'post_comment',
    description: '用开播账号发一条 B 站评论：发在视频下面（video），或者回复某一条评论（reply_to，read_comments / check_inbox 里方括号的编号）。'
      + `评论公开挂在那里，大家都看得到是这个账号发的。两条之间隔 ${COMMENT_GAP_MS / 1000} 秒（发太快 B 站会风控）。`,
    parameters: {
      text: { type: 'string', required: true, description: `评论内容（${MAX_COMMENT_CHARS} 字以内）` },
      video: { type: 'string', description: '发在哪个视频下面：BV 号、av 号或视频链接' },
      reply_to: { type: 'string', description: '回复哪一条评论：评论编号' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const replyTo = String(args.reply_to ?? '').trim() || undefined;
      let thread = null;
      if (!replyTo) {
        const found = await findVideo(args.video, undefined);
        if (typeof found === 'string') return found;
        thread = { type: 1, oid: String(found.info.aid), title: found.info.title };
      }
      show.toolCall('post_comment', replyTo ? `回复 ${replyTo}` : `「${thread!.title.slice(0, 16)}」`, '在发评论');
      const result = await social.postComment(thread, String(args.text ?? ''), replyTo);
      if (result.ok) show.noteComment(String(args.text ?? ''), thread?.title ?? replyTo ?? '');
      return result.text;
    },
  })), 'post_comment tool');

  // 收件箱
  ctx.effect(() => registerTool(defineTool({
    name: 'check_inbox',
    description: '看开播账号的收件箱：最近的私信会话（谁、未读几条、最后一句），和别人在评论区回复你、@ 你的。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('check_inbox', '', '在看私信和评论回复');
      return social.inbox();
    },
  })), 'check_inbox tool');

  ctx.effect(() => registerTool(defineTool({
    name: 'read_dm',
    description: '看你和一个人最近的私信往来（他说了什么、你回了什么）。他发来的图片会带着图片网址，游戏里的 picture 能用。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（check_inbox 里的）或 UID' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const who = String(args.who ?? '').trim();
      const talker = social.findTalker(who) ?? (/^\d{1,20}$/.test(who) ? { uid: who, name: `UID ${who}` } : null);
      if (!talker) {
        const viewer = show.lookupViewer(who);
        if (viewer.kind !== 'found') return `不知道「${who}」是谁：先 check_inbox 看看私信列表，用那里的名字或 UID。`;
        show.toolCall('read_dm', viewer.user.name, `在看和${viewer.user.name}的私信`);
        return social.conversation(viewer.uid, viewer.user.name);
      }
      show.toolCall('read_dm', talker.name, `在看和${talker.name}的私信`);
      return social.conversation(talker.uid, talker.name);
    },
  })), 'read_dm tool');

  const text = (value: string) => [{ type: 'text' as const, text: value }];
  const stringOut = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => text(value) };

  // 看一眼直播画面：OBS 截一张观众看到的画面，作为图片给她（DSH 存进附件，下一步她就能看）
  ctx.effect(() => registerTool(defineTool({
    name: 'look',
    description: '看一眼直播画面：截一张观众现在看到的直播画面给你。',
    parameters: {},
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          text: { type: 'string' as const, required: true },
          image: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' as const, required: true },
              mediaType: { type: 'string' as const, required: true },
              bytes: { type: 'integer' as const, required: true },
              width: { type: 'integer' as const, required: true },
              height: { type: 'integer' as const, required: true },
              name: { type: 'string' as const },
            },
          },
        },
      },
      render: (_args: unknown, value: { text: string; image?: Record<string, unknown> }) => [
        { type: 'text' as const, text: value.text },
        ...(value.image ? [{ type: 'image' as const, attachment: value.image as never }] : []),
      ],
    },
    async execute(_args, exec: any) {
      show.toolCall('look', '', '在看直播画面');
      const attachments = ctx.get?.('attachments');
      const llm = ctx.get?.('llm');
      const routed = exec?.agent?.session?.requestHeader?.()?.config;
      const provider = routed?.provider ?? exec?.agent?.options?.provider;
      const model = routed?.model ?? exec?.agent?.options?.model;
      const info = llm && provider && model ? await llm.resolveModelInfo(provider, model, exec?.signal).catch(() => null) : null;
      if (!attachments || !info?.inputModalities?.includes('image')) return { text: '现在用的模型不能看图，这次看不了画面。' };
      let data: Uint8Array;
      try {
        data = await screenshot();
      } catch (err) {
        hooks.log('warn', `look 截图失败：${(err as Error).message}`);
        return { text: '画面没截到（直播电脑上的 OBS 没连上），过一会儿再看。' };
      }
      const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name: 'look.jpg' });
      const at = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19);
      return {
        text: `直播画面，${at}：`,
        image: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}) },
      };
    },
  })), 'look tool');

  // 这场的数据：播了多久、用了多少 token、大概花了多少钱
  ctx.effect(() => registerTool(defineTool({
    name: 'show_stats',
    description: '看这场直播的数据：播了多久、你用了多少 token、大概花了多少钱（模型和配音）、念了多少字。',
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall('show_stats', '', '在看这场的账');
      const s = show.stats();
      const tts = ttsYuan(s.spokenChars);
      const minutes = Math.round(s.liveMs / 60_000);
      const lines = [
        `这场播了 ${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`}。`,
        `你用了 ${usage.tokens.toLocaleString('en-US')} token（缓存命中 ${usage.cacheRead.toLocaleString('en-US')}，没命中的输入 ${usage.input.toLocaleString('en-US')}，输出 ${usage.output.toLocaleString('en-US')}）。`,
        usage.priced
          ? `模型大概花了 ${money(usage.yuan)}（缓存命中很便宜；工作日白天高峰价，其余时间半价）。`
          : '这个模型的价钱这里不知道，只能报 token。',
        `念了大约 ${s.spokenChars} 个字，配音大概 ${money(tts)}（3 元一万字）。`,
      ];
      return lines.join('\n');
    },
  })), 'show_stats tool');

  // 关注、取关
  ctx.effect(() => registerTool(defineTool({
    name: 'follow',
    description: '用开播账号关注一个人（比如回关新粉丝），或者取关。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（直播间里、私信里的）或 UID' },
      unfollow: { type: 'boolean', description: 'true 是取关，默认关注' },
    },
    output: stringOut,
    async execute(args) {
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      const follow = args.unfollow !== true;
      show.toolCall('follow', `${follow ? '' : '取关 '}${who.name}`, follow ? `在关注${who.name}` : `在取关${who.name}`);
      return social.follow(who.uid, who.name, follow);
    },
  })), 'follow tool');

  ctx.effect(() => registerTool(defineTool({
    name: 'my_fans',
    description: '看开播账号最新的粉丝：谁、什么时候关注的、你回关了没有。',
    parameters: { page: { type: 'number', description: '第几页，默认 1' } },
    output: stringOut,
    async execute(args) {
      show.toolCall('my_fans', '', '在看新粉丝');
      return social.fans(Math.max(1, Math.floor(Number(args.page) || 1)));
    },
  })), 'my_fans tool');

  // 删评论（自己发的，或者自己视频下面别人的）
  ctx.effect(() => registerTool(defineTool({
    name: 'delete_comment',
    description: '删掉一条评论：你自己发的（post_comment 给的编号），或者开播账号自己视频下面别人的（read_comments / check_inbox 里的编号）。',
    parameters: { comment: { type: 'string', required: true, description: '评论编号' } },
    output: stringOut,
    async execute(args) {
      const rpid = String(args.comment ?? '').trim();
      show.toolCall('delete_comment', rpid, '在删评论');
      return social.deleteComment(rpid);
    },
  })), 'delete_comment tool');

  // 发动态
  ctx.effect(() => registerTool(defineTool({
    name: 'post_dynamic',
    description: '用开播账号发一条 B 站文字动态（标注为 AI 生成），关注这个账号的人首页都看得到。',
    parameters: { text: { type: 'string', required: true, description: '动态内容' } },
    output: stringOut,
    async execute(args) {
      show.toolCall('post_dynamic', String(args.text ?? '').slice(0, 16), '在发动态');
      const result = await social.postDynamic(String(args.text ?? ''));
      if (result.ok) show.noteDynamic(String(args.text ?? ''));
      return result.text;
    },
  })), 'post_dynamic tool');

  // 收藏、投币
  ctx.effect(() => registerTool(defineTool({
    name: 'favorite',
    description: `把一个 B 站视频收进你自己的收藏夹「${FAVORITE_FOLDER}」（开播账号上，主人原有的收藏夹不动）。`,
    parameters: { video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' } },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      show.toolCall('favorite', `「${found.info.title.slice(0, 16)}」`, '在收藏');
      return social.favorite(found.info.aid, found.info.title);
    },
  })), 'favorite tool');

  ctx.effect(() => registerTool(defineTool({
    name: 'coin',
    description: '用开播账号给一个 B 站视频投币（1 个或 2 个，一个视频最多投 2 个），可以顺便点赞。硬币是账号自己的。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      count: { type: 'number', description: '投几个：1 或 2，默认 1' },
      like: { type: 'boolean', description: '顺便点赞，默认 true' },
    },
    output: stringOut,
    async execute(args) {
      const found = await findVideo(args.video, undefined);
      if (typeof found === 'string') return found;
      const count = Number(args.count) === 2 ? 2 : 1;
      show.toolCall('coin', `「${found.info.title.slice(0, 16)}」×${count}`, '在投币');
      return social.coin(found.info.aid, found.info.title, count, args.like !== false);
    },
  })), 'coin tool');

  // 直播间：禁言、解禁、改标题
  ctx.effect(() => registerTool(defineTool({
    name: 'mute',
    description: '在你的直播间禁言一个人（这段时间他发不了弹幕）。',
    parameters: {
      who: { type: 'string', required: true, description: '名字（弹幕里的）或 UID' },
      hours: { type: 'number', description: '禁言多少小时，默认 1' },
    },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      const who = person(String(args.who ?? ''));
      if (typeof who === 'string') return who;
      const hours = Math.max(1, Math.min(720, Math.floor(Number(args.hours) || 1)));
      show.toolCall('mute', `${who.name} ${hours}h`, `在禁言${who.name}`);
      return social.mute(roomId, who.uid, who.name, hours);
    },
  })), 'mute tool');

  ctx.effect(() => registerTool(defineTool({
    name: 'unmute',
    description: '解开直播间里一个人的禁言（名字或 UID）；名字对不上时会列出现在被禁言的人。',
    parameters: { who: { type: 'string', required: true, description: '名字或 UID' } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      show.toolCall('unmute', String(args.who ?? ''), '在解禁言');
      return social.unmute(roomId, String(args.who ?? ''));
    },
  })), 'unmute tool');

  ctx.effect(() => registerTool(defineTool({
    name: 'set_live_title',
    description: '改你直播间的标题（40 字以内），推荐页和搜索里显示的就是它。',
    parameters: { title: { type: 'string', required: true, description: '新标题' } },
    output: stringOut,
    async execute(args) {
      const roomId = settings.roomId;
      const title = String(args.title ?? '').trim().slice(0, 40);
      if (!roomId) return '还不知道你的直播间是哪个（没开过播）。';
      if (!title) return '标题是空的。';
      show.toolCall('set_live_title', title.slice(0, 16), '在改直播间标题');
      try {
        await new BiliRoom(await cookie()).update(roomId, { title });
        return `直播间标题改成了「${title}」。`;
      } catch (err) {
        return `改标题没成功：${(err as Error).message}`;
      }
    },
  })), 'set_live_title tool');

  // 搜 B 站视频
  ctx.effect(() => registerTool(defineTool({
    name: 'search_videos',
    description: '搜 B 站视频，返回一页候选（BV 号、标题、UP 主、时长、播放量、发布日期、标签、简介、封面图网址）。封面图网址游戏里的 picture 也能用：观众要画某个角色、某样东西时，可以搜它的视频、挑一张封面就是它的。'
      + '可以只搜某位 UP 主的投稿（up），可以按最新或播放最多排（order），可以翻页（page）。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词（观众说的大概意思就行）；只看某位 UP 主最新的投稿时可以留空' },
      up: { type: 'string', description: 'UP 主的名字或 UID：只在他的投稿里找' },
      order: { type: 'string', enum: ['relevance', 'newest', 'views'], description: 'relevance 相关度（默认）、newest 最新、views 播放最多（填了 up 时按发布时间）' },
      page: { type: 'number', description: '第几页，默认 1' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const query = String(args.query ?? '').trim();
      const up = String(args.up ?? '').trim() || undefined;
      if (!query && !up) return 'query 和 up 至少填一个。';
      const order = (['relevance', 'newest', 'views'] as const).find((o) => o === args.order);
      const options = { up, order, page: Number(args.page) || 1 };
      show.toolCall('search_videos', query ? `「${query}」` : `UP ${up}`, `在搜视频：${query || up}`);
      asr.warm();
      const result = await videos.search(query, options);
      if (!result) return 'B 站搜索没返回（可能是网络问题或者被限流了），过一会儿再搜。';
      return searchText(query, result, options);
    },
  })), 'search_videos tool');

  // 看一个视频：详情和字幕
  ctx.effect(() => registerTool(defineTool({
    name: 'watch_video',
    description: '看一个 B 站视频：详情（标题、UP 主、时长、播放点赞投币收藏、标签、简介、分 P）和带时间的字幕。'
      + '字幕一次给一段，长的用 from 接着往后看；视频没有字幕时会听一遍、把说的话写下来（要几秒到十几秒）。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      part: { type: 'number', description: '多 P 视频的第几 P，默认 1' },
      from: { type: 'number', description: '从第几秒的字幕开始看（接着看时填上次给的数）；填了就只给字幕' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, args.part);
      if (typeof found === 'string') return found;
      const { info, part } = found;
      const from = seconds(args.from);
      show.toolCall('watch_video', `「${info.title.slice(0, 16)}」`, `在看「${info.title.slice(0, 20)}」`);
      library.view(info, part, libraryView('watch', from));
      if (!library.hasDanmaku(info, part)) void videoDanmaku(info, part).catch(() => {});
      const sub = (await officialSubtitles(info, part)) ?? (await listen(info, part, from));
      const partArg = part.page > 1 ? `, part=${part.page}` : '';
      const subtitle = subtitleText(info, part, sub, from, partArg);
      const noLogin = !sub && !(await videos.loggedIn()) ? '（开播账号没登录：B 站的 AI 字幕要登录才给）' : '';
      if (from > 0) return `「${info.title}」${part.page > 1 ? `P${part.page} ` : ''}从 ${clock(from)} 起：\n${subtitle}${noLogin}`;
      return `${infoText(info, part)}\n\n${subtitle}${noLogin}`;
    },
  })), 'watch_video tool');

  // 在舞台上放视频
  ctx.effect(() => registerTool(defineTool({
    name: 'play_video',
    description: '在直播间的舞台上放一个 B 站视频给大家看：舞台换成看视频的布局，放完换回来，放完了会告诉你。'
      + '默认从头放到结尾，可以指定从哪里开始、放多久。'
      + '放的时候你照常说话、回弹幕，你说话时视频声音会自动调小。正在放的会被换掉。'
      + '舞台只在这个工具被调用时开始放：你说「我放一下」只是念给大家听，视频要靠这次调用才出现在舞台上。',
    parameters: {
      video: { type: 'string', required: true, description: 'BV 号、av 号或视频链接' },
      part: { type: 'number', description: '多 P 视频的第几 P，默认 1' },
      from: { type: 'string', description: '从哪里开始放：秒数或「分:秒」，默认 0' },
      seconds: { type: 'number', description: '放多少秒，不填就放到结尾' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute(args) {
      const found = await findVideo(args.video, args.part);
      if (typeof found === 'string') return found;
      const { info, part } = found;
      const from = Math.floor(seconds(args.from));
      if (part.durationSec && from >= part.durationSec) return `「${info.title}」一共只有 ${clock(part.durationSec)}，从 ${clock(from)} 开始就没有了。`;
      const asked = Number(args.seconds) > 0 ? Math.max(5, Number(args.seconds)) : null;
      const end = part.durationSec || from + (asked ?? PLAY_UNKNOWN_SEC);
      const until = asked ? Math.min(end, from + asked) : end;
      const url = await videos.playUrl(info.bvid, part.cid);
      if (!url) return `「${info.title}」在网页上放不了（B 站没给能用的播放地址：可能没有网页版、付费、番剧、充电专属或者有地区限制），换一个吧。`;
      show.toolCall('play_video', `「${info.title.slice(0, 16)}」`);
      // 边看边聊：后台拿这段的字幕（没有就边放边听写）和原视频弹幕
      const notes = new VideoNotes(from, until, {
        subtitles: () => officialSubtitles(info, part),
        listen: (at) => listen(info, part, at),
        danmaku: () => videoDanmaku(info, part),
      }, (message) => hooks.log('warn', message));
      const view = library.view(info, part, libraryView('play', from, until));
      const { video, replaced } = show.playVideo({ bvid: info.bvid, title: info.title, up: info.up.name, url, fromSec: from, untilSec: until }, notes,
        (end) => library.finish(info, part, view, { playedSec: end.playedSec, end: end.how, said: end.said }));
      // 等舞台真的开始放：她说「放上了」时就是放上了
      const outcome = show.stage.watchers ? await show.player.waitStart(video.id, PLAY_CONFIRM_MS) : 'playing';
      if (outcome === 'error') return `「${info.title}」没放出来（舞台加载不了这个视频${video.error ? `：${video.error}` : ''}），舞台换回了聊天的布局。可以换一个。`;
      const lines = [
        outcome === 'pending'
          ? `舞台还在加载「${info.title}」（UP ${info.up.name}，${clock(from)}–${clock(until)}）：开始放了就照常进行，放不出来会告诉你。`
          : `舞台上已经在放「${info.title}」（UP ${info.up.name}），${clock(from)}–${clock(until)}，共 ${clock(until - from)}。舞台换成了看视频的布局。`,
        '放的时候弹幕照常发给你；没弹幕的时候，隔一会儿会告诉你视频这段在说什么、原视频的弹幕在刷什么。',
        '放完了会告诉你；想停用 stop_video，想换直接 play_video 别的。',
      ];
      if (replaced) lines.push(`（换掉了正在放的「${replaced.title}」）`);
      if (!show.stage.watchers) lines.push('（现在没有出声的舞台页开着：观众看不到画面，按时长算放完）');
      return lines.join('\n');
    },
  })), 'play_video tool');

  ctx.effect(() => registerTool(defineTool({
    name: 'stop_video',
    description: '停下舞台上正在放的视频，舞台换回聊天的布局。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
    async execute() {
      show.toolCall('stop_video', '');
      const stopped = show.stopVideo();
      if (!stopped) return '现在没在放视频。';
      return `停了「${stopped.video.title}」（放了 ${clock(stopped.playedSec)}），舞台换回了聊天的布局。`;
    },
  })), 'stop_video tool');

  // 游戏线：另一个会话里的她专门玩游戏，这条线把话交给她
  ctx.effect(() => registerTool(defineTool({
    name: 'game_side',
    description: '观众或主人想让你在游戏里做什么、或者你要答应游戏里的事：写下怎么做，交给游戏里的你。他们的原话会一起交过去，由游戏里的你点名回他、再去做；从调这个工具的那条消息起，这一轮你写的话都不会念出来（调之前写的会念）。',
    parameters: {
      message: { type: 'string', required: true, description: '游戏里接下来怎么做，比如「开 Minecraft 接着玩，目标一身钻石装备」「天黑了，先挖洞躲起来」' },
      who: { type: 'string', description: '这是哪位观众点的单（名字，几位用顿号隔开）：记进点单队列、观众在点单栏里看得到；这件事里只有一位观众时可以不填' },
    },
    output: stringOut,
    async execute(args) {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) return '没写接下来怎么玩。';
      show.toolCall('game_side', message.slice(0, 40));
      if (!show.toGameLine(message, typeof args.who === 'string' ? args.who : '')) return '这场直播没开游戏（开播时没准备游戏），玩不了。';
      return '交过去了：游戏里的你会回他、去做。这一轮接下来写的话不会念出来。';
    },
  })), 'game_side tool');

  // 查游戏里现在的完整情况（游戏线最近一个时刻的全文）
  ctx.effect(() => registerTool(defineTool({
    name: 'game_state',
    description: '查你在游戏里现在的完整情况：位置、血量、饥饿、完整背包、身体在做什么、刚发生了什么。观众问游戏里的细节时先查一下再回。',
    parameters: {},
    output: stringOut,
    async execute() {
      show.toolCall('game_state', '', '在看游戏里的情况');
      const state = show.gameState();
      return state ? `（${state.ageSec} 秒前，游戏里最近一个时刻）\n${state.text}` : '游戏现在没开。';
    },
  })), 'game_state tool');
}
