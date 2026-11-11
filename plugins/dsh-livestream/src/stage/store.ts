/**
 * 舞台页的状态：只从事件流来（protocol.ts）。挂件都读这里，不发请求、不含逻辑。
 * 唯一往回发的是「这句念完了」（出声的页面才发；预览页静音、不回执）。
 */

import type { BrainState, CharacterManifest, GameSource, GameStatus, StageEvent, StageLiveEvent, StageOrder, StageUser, TemplateManifest } from './protocol';
import { type FxEvent, giftTier, pick, triggersOf } from './triggers';

export interface ChatRow {
  id: string;
  event: Extract<StageLiveEvent, { kind: 'chat' }>;
  at: number;
}

export interface Alert {
  key: string;
  event: Exclude<StageLiveEvent, { kind: 'chat' }>;
  at: number;
}

/** 一次要放的特效：effects 挂件拿去按模板配置放，放上了就 dropFx */
export interface Fx {
  key: string;
  /** 事件名，从具体到笼统（triggers.ts） */
  triggers: string[];
  event: FxEvent;
  at: number;
}

/** 「她在回」卡片的一条：那位观众和他说的话（focus 那一刻从最近的事件里找） */
export interface ReplyItem {
  key: string;
  event: StageLiveEvent;
}

/** 舞台上正在放的视频（media 事件）；at 是身体开始放的时刻 */
export interface Media {
  id: string;
  title: string;
  up: string;
  src: string;
  from: number;
  until: number;
  at: number;
}

export interface Line {
  id: string;
  text: string;
  mood: string;
  startedAt: number;
  durationMs: number;
  /** 逐字时间（音频毫秒 → 亮到第几个字）；没有就按 durationMs 匀速 */
  timeline?: Array<{ chars: number; atMs: number }>;
  /** 嘉宾说的（Claude 小姐这些）：字幕写她的名字，角色的立绘不动嘴 */
  speaker?: string;
}

/** 这句念到了第几毫秒：有在放的音频就读它的真实播放位置，不然按开始以来的时间 */
export function playbackMs(line: Line): number {
  if (audio && audioLine === line.id && !audio.paused) return audio.currentTime * 1000;
  return Date.now() - line.startedAt;
}

/**
 * 字幕该亮到第几个字。逐字时间里一个点常常一次跨好几个字（豆包按词给），
 * 这几个字在前后两个点之间均匀地一个个亮，字幕像流出来一样，不会几个字一起蹦出来再停住
 */
export function litChars(line: Line, length: number): number {
  const ms = playbackMs(line);
  if (line.timeline?.length) {
    let prev = { chars: 0, atMs: 0 };
    for (const p of line.timeline) {
      if (p.atMs > ms) {
        const span = p.atMs - prev.atMs;
        const f = span > 0 ? Math.min(1, Math.max(0, (ms - prev.atMs) / span)) : 1;
        return Math.max(prev.chars, Math.floor(prev.chars + (p.chars - prev.chars) * f));
      }
      prev = p;
    }
    return prev.chars;
  }
  return Math.round(length * Math.min(1, ms / Math.max(1, line.durationMs)));
}

/** 一场直播的阶段：开播前等待 → 开场动画 → 直播中 → 谢幕（之后回到等待） */
/** updating：直播中插件在更新（断线了、或者换了新版本在重载），盖一张「更新中」，接回来再揭开 */
export type ShowPhase = 'waiting' | 'opening' | 'live' | 'ending' | 'updating';

/** 这场直播到现在的数（谢幕时的感谢名单也从这里来） */
export interface ShowStats {
  startedAt: number;
  chats: number;
  viewers: number;
  peakOnline: number;
  /** 送过礼物、醒目留言、上舰的人（按花的钱从多到少） */
  supporters: Array<{ name: string; yuan: number }>;
}

/** 终端的一行 */
export interface TermLine {
  id: number;
  at: number;
  tag: string;
  text: string;
}

export interface StageState {
  connected: boolean;
  character: CharacterManifest | null;
  template: TemplateManifest | null;
  brain: BrainState;
  brainDetail: string;
  line: Line | null;
  /** 最近一句说完的时刻（字幕淡出用） */
  lineEndedAt: number;
  chats: ChatRow[];
  alerts: Alert[];
  focus: Set<string>;
  /** 她正在回应的那几条（她回完就清空） */
  reply: ReplyItem[];
  /** 每来一次 focus 加一：卡片重新入场 */
  replySeq: number;
  online?: number;
  onAir: boolean;
  phase: ShowPhase;
  stats: ShowStats;
  /** 这场直播她用掉的 token */
  tokens: number;
  model: string;
  term: TermLine[];
  fx: Fx[];
  /** 她对刚才那件事的反应（角色包 reactions 配的表情）；key 每次不同 */
  reaction: { key: string; mood: string } | null;
  /** 浏览器拦住了自动播放：要点一下 */
  needsClick: boolean;
  /** Actual media state; only an ended event advances lastEndedId. */
  playback: { state: 'idle' | 'loading' | 'playing' | 'ended' | 'failed' | 'timeout' | 'cancelled'; lineId: string | null; lastEndedId: string | null; detail: string };
  /** 在放视频：舞台换成 video 布局 */
  media: Media | null;
  /** 告示板上写的（空串不显示） */
  board: string;
  /** 点单栏（玩游戏的布局里放在告示板的位置） */
  orders: StageOrder[];
  /** 滚动通知（画面最底下），空串不显示 */
  notice: string;
  /** 她在直播里玩的游戏的画面来源：舞台换成 game 布局 */
  game: GameSource | null;
  /** 游戏画面上那一行「她在干嘛」 */
  gameStatus: GameStatus | null;
}

const MAX_CHATS = 30;
const MAX_ALERTS = 6;
/** 「她在回」从这里找观众说过的话：比弹幕列表留得久，礼物、醒目留言、进场都在 */
const MAX_RECENT = 120;
const recent: StageLiveEvent[] = [];
const MAX_TERM = 40;
const MAX_FX = 8;
/** 进场一多（热闹的房间一分钟几十个），特效最多两秒一个；卡片照常 */
const ENTER_FX_GAP_MS = 2000;
/** 角色反应最多八秒一次：别一直做表情 */
const REACTION_GAP_MS = 8000;
/** 开场动画、谢幕各放多久 */
export const OPENING_MS = 5200;
export const ENDING_MS = 16_000;
/** 连上以后这么短的时间里收到的「在播」是补发的当前状态（中途打开舞台），不放开场动画 */
const CATCHUP_MS = 2000;

const viewers = new Set<string>();
const supporters = new Map<string, { name: string; yuan: number }>();
let helloAt = 0;
/** 这个页面加载时舞台服务器的版本 */
let pageBuild: string | undefined;
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
/** 身体发过 room（开没开播）事件：开播下播只认它 */
let roomSeen = false;
/** 上次下播的时刻：再开播时，那之前的弹幕、提醒是上一场的，清掉（舞台页在两场之间不刷新） */
let offAirAt = 0;
let termSeq = 0;

function freshStats(): ShowStats {
  viewers.clear();
  supporters.clear();
  return { startedAt: Date.now(), chats: 0, viewers: 0, peakOnline: 0, supporters: [] };
}

/** 直播中换了新版本、页面重载：重载前记一笔，重载后先盖「更新中」，别露出「马上开始」 */
const UPDATING_KEY = 'ls-updating';
function wasUpdating(): boolean {
  try {
    const at = Number(sessionStorage.getItem(UPDATING_KEY) ?? 0);
    return Date.now() - at < UPDATING_MAX_MS;
  } catch {
    return false;
  }
}
/** 断线多久算在更新（短暂的网络抖动不盖） */
const UPDATING_AFTER_MS = 3000;
/** 「更新中」最多盖这么久，还没接回来就当下播了（换回等待画面） */
const UPDATING_MAX_MS = 3 * 60_000;
let updatingTimer: ReturnType<typeof setTimeout> | null = null;

function startUpdating(): void {
  if (state.phase === 'updating') return;
  setPhase('updating', { ms: UPDATING_MAX_MS, next: 'waiting' });
}

let state: StageState = {
  connected: false, character: null, template: null, brain: 'off', brainDetail: '', line: null, lineEndedAt: 0,
  chats: [], alerts: [], focus: new Set(), reply: [], replySeq: 0, onAir: false, needsClick: false,
  playback: { state: 'idle', lineId: null, lastEndedId: null, detail: '' },
  phase: wasUpdating() ? 'updating' : 'waiting', stats: freshStats(), tokens: 0, model: '', term: [], media: null, board: '', orders: [], notice: '', game: null, gameStatus: null, fx: [], reaction: null,
};
const subscribers = new Set<() => void>();

export function getState(): StageState {
  return state;
}

export function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

function update(change: (s: StageState) => StageState): void {
  state = change(state);
  for (const notify of subscribers) notify();
}

// ── 连接 ─────────────────────────────────────────────

const params = new URLSearchParams(location.search);
export const token = params.get('token') ?? '';
/** 控制台里的预览：静音、不回执 */
export const preview = params.get('preview') === '1';
/** 控制台里刚换了主题：预览页演示一遍开场动画和直播中的样子（只在预览页、没在播的时候） */
const demo = preview && params.has('demo');

export function assetUrl(kind: 'characters' | 'templates', id: string, file: string): string {
  return `/${kind}/${id}/${encodeURIComponent(file)}?token=${encodeURIComponent(token)}`;
}

let audio: HTMLAudioElement | null = null;
/** 正在放的音频是哪一句的 */
let audioLine: string | null = null;
type SpeechReceipt = 'ended' | 'failed' | 'cancelled' | 'timeout';
let activeSpeech: { finish(state: SpeechReceipt, detail?: string): void } | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
const seenSpeech = new Set<string>();

function said(id: string, receipt: SpeechReceipt, detail = ''): void {
  if (!preview) void fetch(`/said?id=${encodeURIComponent(id)}&state=${receipt}&detail=${encodeURIComponent(detail)}&token=${encodeURIComponent(token)}`, { method: 'POST', keepalive: true }).catch(() => {});
}

function clearLine(id: string): void {
  update((s) => s.line?.id === id ? { ...s, line: null, lineEndedAt: Date.now() } : s);
}

function onSay(event: Extract<StageEvent, { type: 'say' }>): void {
  // SSE reconnects or an accidental duplicate event must not play a line twice.
  if (seenSpeech.has(event.id)) return;
  seenSpeech.add(event.id);
  if (seenSpeech.size > 200) seenSpeech.delete(seenSpeech.values().next().value!);
  activeSpeech?.finish('cancelled', 'replaced-by-next-line');
  if (previewTimer) clearTimeout(previewTimer);
  const begin = (durationMs: number) => update((s) => ({ ...s, line: { id: event.id, text: event.text, mood: event.mood, startedAt: Date.now(), durationMs, timeline: event.timeline, speaker: event.speaker } }));
  begin(event.estimateMs);
  if (preview) {
    // A preview animates subtitles but never plays or acknowledges speech.
    previewTimer = setTimeout(() => clearLine(event.id), event.estimateMs);
    return;
  }
  if (!event.audio) {
    update((s) => ({ ...s, playback: { ...s.playback, state: 'failed', lineId: event.id, detail: '没有可播放的音频' } }));
    said(event.id, 'failed', 'audio-unavailable');
    return;
  }
  const player = new Audio(`data:${event.audioMime ?? 'audio/mpeg'};base64,${event.audio}`);
  audio = player;
  audioLine = event.id;
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const finish = (receipt: SpeechReceipt, detail = '') => {
    if (settled) return;
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    player.onloadedmetadata = null;
    player.onended = null;
    player.onerror = null;
    if (receipt !== 'ended') player.pause();
    if (audio === player) { audio = null; audioLine = null; }
    activeSpeech = null;
    clearLine(event.id);
    const visibleDetail = receipt === 'failed' ? '本句播放失败；检查声音设置，启用后续语音。'
      : receipt === 'timeout' ? '本句播放超时；请检查连接或刷新舞台。' : '';
    update((s) => ({ ...s, playback: { state: receipt, lineId: event.id, lastEndedId: receipt === 'ended' ? event.id : s.playback.lastEndedId, detail: visibleDetail } }));
    said(event.id, receipt, detail);
  };
  activeSpeech = { finish };
  const arm = (duration: number) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => finish('timeout', 'playback-timeout'), Math.max(0, duration) + 5000);
  };
  arm(event.estimateMs);
  update((s) => ({ ...s, playback: { ...s.playback, state: 'loading', lineId: event.id, detail: '' } }));
  player.onloadedmetadata = () => {
    const ms = Number.isFinite(player.duration) && player.duration > 0 ? player.duration * 1000 : event.estimateMs;
    begin(ms);
    arm(ms);
  };
  player.onended = () => finish('ended');
  player.onerror = () => finish('failed', 'audio-load-error');
  try {
    void player.play().then(() => {
      if (!settled) update((s) => ({ ...s, needsClick: false, playback: { ...s.playback, state: 'playing' } }));
    }, () => {
      if (settled) return;
      update((s) => ({ ...s, needsClick: true }));
      finish('failed', 'playback-rejected');
    });
  } catch {
    update((s) => ({ ...s, needsClick: true }));
    finish('failed', 'playback-rejected');
  }
}

/** 视频地址（舞台服务器转发的） */
export function mediaUrl(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** 视频开始放、放完、放不出来：告诉身体（出声的页面才发） */
export function reportMedia(id: string, state: 'playing' | 'ended' | 'error', atSec?: number, detail?: string): void {
  if (preview) return;
  const at = atSec !== undefined && Number.isFinite(atSec) ? `&at=${atSec.toFixed(1)}` : '';
  const why = detail ? `&detail=${encodeURIComponent(detail.slice(0, 200))}` : '';
  void fetch(`/media?id=${encodeURIComponent(id)}&state=${state}${at}${why}&token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

export function unlockAudio(): void {
  void new Audio().play().catch(() => {});
  // Failed lines have already reported a terminal result to their owner.
  // Do not replay them after that owner released the microphone.
  update((s) => ({ ...s, needsClick: false }));
}

let alertSeq = 0;

function remember(event: StageLiveEvent): void {
  const i = recent.findIndex((e) => e.id === event.id);
  if (i >= 0) recent[i] = event;
  else recent.push(event);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

/** 每位被回应的观众最近的一件事（一人一条，按事件先后） */
function replyItems(userIds: string[]): ReplyItem[] {
  const items: ReplyItem[] = [];
  // 同一位观众一轮里可能出现两次（先送礼又上舰）：只列一次
  for (const id of new Set(userIds)) {
    const event = recent.findLast((e) => e.user.id === id);
    if (event) items.push({ key: `${event.id}`, event });
  }
  return items.sort((a, b) => recent.indexOf(a.event) - recent.indexOf(b.event));
}

// ── 终端 ─────────────────────────────────────────────

function term(s: StageState, tag: string, text: string): StageState {
  return { ...s, term: [...s.term, { id: ++termSeq, at: Date.now(), tag, text }].slice(-MAX_TERM) };
}

/**
 * 她吃了多少饭：这场用掉的 token 按「每个 token 耗多少焦耳电」换成电，再按一碗饭的热量换成米粒。
 * options：jPerToken（默认 1 焦耳）、bowlKcal（一碗饭的热量，默认 230 千卡）、grainsPerBowl（一碗多少粒，默认 3000）
 */
export function riceOf(tokens: number, options?: Record<string, unknown>) {
  const jPerToken = Number(options?.jPerToken ?? 1);
  const bowlJ = Number(options?.bowlKcal ?? 230) * 4184;
  const perBowl = Number(options?.grainsPerBowl ?? 3000);
  const joules = tokens * jPerToken;
  return { joules, perBowl, grains: Math.floor((joules / bowlJ) * perBowl), grainsOf: (t: number) => Math.round(((t * jPerToken) / bowlJ) * perBowl) };
}

/** 电能：焦、千焦、兆焦 */
export function energy(joules: number): string {
  if (joules >= 1e6) return `${(joules / 1e6).toFixed(1)} 兆焦`;
  if (joules >= 1000) return `${(joules / 1000).toFixed(1)} 千焦`;
  return `${Math.round(joules)} 焦`;
}

/** token 数按中文习惯读：2.1 万、6158.2 万、1.23 亿 */
export function tokenCount(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString();
}

function short(text: string, max = 22): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

const MOOD_TEXT: Record<string, string> = { laugh: '笑', shy: '害羞', angry: '生气', sad: '难过', scared: '害怕', shocked: '吃惊', think: '想' };

// ── 开播、下播 ─────────────────────────────────────────

function setPhase(phase: ShowPhase, after?: { ms: number; next: ShowPhase }): void {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = after ? setTimeout(() => setPhase(after.next), after.ms) : null;
  update((s) => ({ ...s, phase }));
}

/** 开没开播变了：刚连上时补发来的状态直接到位，真的开播放开场、真的下播放谢幕 */
function onAirChanged(onAir: boolean): void {
  const s = state;
  if (onAir === s.onAir && !(onAir && (s.phase === 'waiting' || s.phase === 'updating'))) return;
  const catchingUp = Date.now() - helloAt < CATCHUP_MS;
  if (onAir) {
    const fresh = <T extends { at: number }>(list: T[]) => list.filter((item) => item.at > offAirAt);
    update((x) => term({ ...x, onAir: true, stats: freshStats(), tokens: 0, chats: fresh(x.chats), alerts: fresh(x.alerts) }, 'live', catchingUp ? '舞台连上，正在直播' : '开播'));
    try { sessionStorage.removeItem(UPDATING_KEY); } catch { /* 没存过 */ }
    // 更新完接回来：直接揭开，不再放一遍开场
    if (catchingUp || s.phase === 'updating') setPhase('live');
    else setPhase('opening', { ms: OPENING_MS, next: 'live' });
  } else {
    offAirAt = Date.now();
    update((x) => term({ ...x, onAir: false }, 'live', '下播'));
    if (s.phase === 'updating') return; // 更新完刚接上、直播还没续上：接着盖「更新中」，等开播的消息（盖太久会自己换回等待画面）
    if (catchingUp || s.phase === 'waiting') setPhase('waiting');
    else setPhase('ending', { ms: ENDING_MS, next: 'waiting' });
  }
}

/** 上舰按舰长的价钱算（谢幕名单排序用） */
const GUARD_YUAN = 138;

function countLive(s: StageState, event: StageLiveEvent, isUpdate: boolean): StageState {
  viewers.add(event.user.id);
  const stats = { ...s.stats, viewers: viewers.size };
  if (event.kind === 'chat' && !isUpdate) stats.chats += 1;
  const value = event.kind === 'gift' || event.kind === 'superchat' ? event.yuan : event.kind === 'membership' ? GUARD_YUAN * Math.max(1, event.count) : 0;
  if (value > 0) {
    // 礼物连击：同一个 id 再来时是更新后的总数，按 id 记一份
    supporters.set(event.id, { name: event.user.name, yuan: value });
    const byName = new Map<string, number>();
    for (const { name, yuan } of supporters.values()) byName.set(name, (byName.get(name) ?? 0) + yuan);
    stats.supporters = [...byName].map(([name, yuan]) => ({ name, yuan: Math.round(yuan * 10) / 10 })).sort((x, y) => y.yuan - x.yuan);
  }
  return { ...s, stats };
}

let fxSeq = 0;
let lastEnterFx = 0;
let lastReaction = 0;

/**
 * 有事发生：排一个特效，她没在说话就让她先做个反应。
 * 礼物连击（同 id 更新）只在跨档时再来一次：小礼物连到 100 元以上，按大礼物再热闹一次。
 */
function fire(event: FxEvent): void {
  const now = Date.now();
  if (event.kind === 'enter') {
    if (now - lastEnterFx < ENTER_FX_GAP_MS) return;
    lastEnterFx = now;
  }
  const triggers = triggersOf(event);
  const mood = pick(state.character?.reactions, triggers);
  update((s) => {
    const next = { ...s, fx: [...s.fx, { key: `f${++fxSeq}`, triggers, event, at: now }].slice(-MAX_FX) };
    if (mood && !s.line && now - lastReaction >= REACTION_GAP_MS) {
      lastReaction = now;
      next.reaction = { key: `r${fxSeq}`, mood };
    }
    return next;
  });
}

export function dropFx(key: string): void {
  update((s) => ({ ...s, fx: s.fx.filter((f) => f.key !== key) }));
}

function onLive(event: StageLiveEvent, isUpdate: boolean): void {
  remember(event);
  if (event.kind !== 'chat') {
    const before = state.alerts.find((a) => a.event.id === event.id)?.event;
    const tierUp = event.kind === 'gift' && before?.kind === 'gift' && giftTier(event.yuan) !== giftTier(before.yuan);
    if (!isUpdate || tierUp) fire(event);
  }
  update((s) => {
    let next = countLive(s, event, isUpdate);
    if (!isUpdate) {
      if (event.kind === 'gift') next = term(next, 'gift', `${event.user.name} 送出 ${event.gift} ×${event.count}`);
      else if (event.kind === 'superchat') next = term(next, 'sc', `${event.user.name} ¥${event.yuan}：${short(event.text, 18)}`);
      else if (event.kind === 'membership') next = term(next, 'gift', `${event.user.name} 开通了${event.level}`);
    }
    return next;
  });
  if (event.kind === 'chat') {
    if (isUpdate) return;
    update((s) => ({ ...s, chats: [...s.chats, { id: event.id, event, at: Date.now() }].slice(-MAX_CHATS) }));
    return;
  }
  // 礼物连击：同 id 更新数量，不再弹一次
  update((s) => {
    const existing = s.alerts.findIndex((a) => a.event.id === event.id);
    if (existing >= 0) {
      const alerts = s.alerts.slice();
      alerts[existing] = { ...alerts[existing], event };
      return { ...s, alerts };
    }
    if (isUpdate) return s;
    return { ...s, alerts: [...s.alerts, { key: `a${++alertSeq}`, event, at: Date.now() }].slice(-MAX_ALERTS) };
  });
}

export function dropAlert(key: string): void {
  update((s) => ({ ...s, alerts: s.alerts.filter((a) => a.key !== key) }));
}

function onBrain(event: Extract<StageEvent, { type: 'brain' }>): void {
  update((s) => {
    let next: StageState = {
      ...s, brain: event.state, brainDetail: event.detail ?? (event.state === s.brain ? s.brainDetail : ''),
      // 这一轮回完了：不再标「正在回你」
      ...(event.state === 'thinking' || event.state === 'speaking' ? {} : { focus: new Set<string>(), reply: [] }),
    };
    if (event.state === 'thinking' && event.detail) next = term(next, 'push', event.detail);
    if (event.state === 'away') next = term(next, 'warn', event.detail || '她的会话不在线');
    return next;
  });
  // 她在动就是在播（旧版身体连上时不补发 room 事件）。收到过 room 就只认 room：
  // 下播以后游戏线还会说一句收尾的话，不能因此又当成开播（会重放开场、一直停在直播画面）
  if (event.state !== 'off' && !state.onAir && !roomSeen) onAirChanged(true);
}

function handle(event: StageEvent): void {
  switch (event.type) {
    case 'hello':
      // 插件更新过（DSH 重启后重连上来，版本变了）：重新加载页面拿新代码。OBS 的浏览器源不会自己刷新
      if (event.build && pageBuild && event.build !== pageBuild) {
        if (state.onAir || state.phase === 'updating') {
          try { sessionStorage.setItem(UPDATING_KEY, String(Date.now())); } catch { /* 存不了就算了 */ }
        }
        location.reload();
        return;
      }
      pageBuild ??= event.build;
      helloAt = Date.now();
      update((s) => ({ ...s, connected: true, character: event.character, template: event.template }));
      if (demo && !demoStarted) startDemo(event.character.name);
      return;
    case 'say':
      update((s) => term(s, event.speaker ? 'guest' : 'say', `${event.speaker ? `${event.speaker}：` : ''}${MOOD_TEXT[event.mood] ? `（${MOOD_TEXT[event.mood]}）` : ''}${short(event.text, 26)}`));
      return onSay(event);
    case 'brain': return onBrain(event);
    case 'tool': return update((s) => term({ ...s, brain: 'thinking', brainDetail: event.doing ?? s.brainDetail }, 'tool', `${event.name}${event.detail ? ` ${event.detail}` : ''}`));
    case 'live': return onLive(event.event, event.isUpdate);
    case 'focus': return update((s) => ({ ...s, focus: new Set(event.userIds), reply: replyItems(event.userIds), replySeq: s.replySeq + 1 }));
    case 'room':
      roomSeen = true;
      update((s) => ({ ...s, online: event.online, stats: { ...s.stats, peakOnline: Math.max(s.stats.peakOnline, event.online ?? 0) } }));
      return onAirChanged(event.onAir);
    case 'usage':
      return update((s) => {
        const next = { ...s, tokens: event.tokens, model: event.model ?? s.model };
        // 观众看不懂「+20,863」（以为是加了 token），也老问「吃了多少钱」：写成这一步吃掉多少、折成米粒和电，再加今晚一共吃了多少米（不算钱）
        if (!event.turn) return next;
        const step = riceOf(event.turn);
        return term(next, 'token', `这一步吃掉 ${tokenCount(event.turn)} token ≈ ${Math.max(1, step.grainsOf(event.turn))} 粒米、${energy(step.joules)}电 · 这场共 ${riceOf(event.tokens).grains.toLocaleString()} 粒米`);
      });
    case 'media':
      if (event.action === 'play') {
        const { id, title, up, src, from, until, at } = event;
        return update((s) => term({ ...s, media: { id, title, up, src, from, until, at } }, 'video', `放视频：${short(title, 24)}`));
      }
      return update((s) => (s.media?.id === event.id ? { ...s, media: null } : s));
    case 'reload': location.reload(); return;
    case 'board': return update((s) => ({ ...s, board: event.text }));
    case 'orders': return update((s) => ({ ...s, orders: event.items }));
    case 'notice': return update((s) => ({ ...s, notice: event.text }));
    case 'game': return update((s) => ({ ...s, game: event.source, ...(event.source ? {} : { gameStatus: null }) }));
    case 'gameStatus': return update((s) => ({ ...s, gameStatus: event.status }));
    case 'note': return update((s) => term(s, event.tag, event.text));
  }
}

// ── 换主题时的演示（只在控制台预览里）────────────────

let demoStarted = false;

/** 先放开场动画，再来几条示例弹幕、进场、关注、礼物，她说一句：看得出这个主题直播时是什么样 */
function startDemo(name: string): void {
  demoStarted = true;
  setTimeout(() => {
    // 补发过来的状态说明真的在播：不演示
    if (state.onAir) return;
    setPhase('opening', { ms: OPENING_MS, next: 'live' });
    const at = Date.now();
    const user = (id: string, n: string, guard?: number): StageUser => ({ id: `demo:${id}`, name: n, ...(guard ? { guard } : {}) });
    const chats: Array<[string, string, number?]> = [['晚风', '晚上好呀！'], ['橘子汽水', '这个主题好可爱', 3], ['放学路上', `${name}今天吃了几碗饭？`], ['云朵收集者', '来啦来啦']];
    const v = 1 as const;
    const script: Array<[number, StageEvent]> = [
      ...chats.map(([n, text, guard], i) => [OPENING_MS + 300 + i * 450, { v, type: 'live', isUpdate: false, at, event: { kind: 'chat', id: `demo-${i}`, user: user(n, n, guard), text } }] as [number, StageEvent]),
      [OPENING_MS + 900, { v, type: 'live', isUpdate: false, at, event: { kind: 'enter', id: 'demo-enter', user: user('橘子汽水', '橘子汽水', 3) } }],
      [OPENING_MS + 1500, { v, type: 'live', isUpdate: false, at, event: { kind: 'follow', id: 'demo-follow', user: user('云朵收集者', '云朵收集者') } }],
      [OPENING_MS + 2200, { v, type: 'live', isUpdate: false, at, event: { kind: 'gift', id: 'demo-gift', user: user('晚风', '晚风'), gift: '小花花', count: 5, yuan: 0.5 } }],
      [OPENING_MS + 2400, { v, type: 'usage', tokens: 12_800, turn: 640, at }],
      [OPENING_MS + 2600, { v, type: 'focus', userIds: ['demo:放学路上'], at }],
      [OPENING_MS + 2700, { v, type: 'say', id: 'demo-say', text: `放学路上，今天吃了三碗！${name}的小屋装修好啦，大家随便坐～`, mood: 'laugh', audio: null, estimateMs: 5200, at }],
      // 说完以后来个大礼物：横幅、彩带、她自己的反应都看得到
      [OPENING_MS + 8600, { v, type: 'live', isUpdate: false, at, event: { kind: 'gift', id: 'demo-big', user: user('橘子汽水', '橘子汽水', 3), gift: '嘉年华', count: 1, yuan: 500 } }],
    ];
    for (const [ms, event] of script) setTimeout(() => handle(event), ms);
  }, CATCHUP_MS);
}

export function connect(): void {
  if (state.phase === 'updating') setPhase('updating', { ms: UPDATING_MAX_MS, next: 'waiting' });
  const source = new EventSource(`/events?token=${encodeURIComponent(token)}${preview ? '&preview=1' : ''}`);
  source.onmessage = (message) => {
    try {
      handle(JSON.parse(message.data) as StageEvent);
    } catch {
      // 认不出的事件跳过（新版本的事件旧舞台不认识）
    }
  };
  source.onerror = () => {
    update((s) => ({ ...s, connected: false }));
    // 直播中断线（插件在重启、在更新）：过一会儿还没接上就盖「更新中」
    if (!state.onAir || preview || updatingTimer) return;
    updatingTimer = setTimeout(() => {
      updatingTimer = null;
      if (!state.connected && state.onAir) startUpdating();
    }, UPDATING_AFTER_MS);
  };
  source.onopen = () => update((s) => ({ ...s, connected: true }));
}
