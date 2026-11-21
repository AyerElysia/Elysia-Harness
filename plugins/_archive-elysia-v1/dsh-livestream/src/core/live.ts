/**
 * 直播事件的统一格式：各平台适配器把自己的协议翻译成这里的类型，
 * 下游（注意力、记忆、舞台、控制台）只认这一套，不关心来自哪个平台。
 */

export type LivePlatform = 'bilibili';

export interface LiveUser {
  /** 平台内的用户 id；平台隐藏身份时为空串 */
  id: string;
  name: string;
  face?: string;
  /** 平台把名字打了码（如 B 站未登录时的「小***」） */
  masked?: boolean;
  /** 粉丝牌：ofThisRoom 表示是本直播间主播的牌子 */
  medal?: { name: string; level: number; ofThisRoom: boolean };
  /** 大航海等级：1 总督、2 提督、3 舰长；0/缺省为无 */
  guardLevel?: number;
  /** 本房间房管 */
  isAdmin?: boolean;
}

interface LiveEventBase {
  /** 同一条事件的稳定 id：礼物连击合并后仍沿用第一条的 id */
  id: string;
  platform: LivePlatform;
  /** 毫秒时间戳 */
  ts: number;
  user: LiveUser;
}

export interface LiveChatEvent extends LiveEventBase {
  kind: 'chat';
  text: string;
  /** 整条都是表情（表情包弹幕或纯 [表情] 文字） */
  emoteOnly?: boolean;
  /** 表情包弹幕的图片 */
  stickerUrl?: string;
  /** 文字里的小表情：「[大笑]」→ 图片地址 */
  emotes?: Record<string, string>;
}

export interface LiveGiftEvent extends LiveEventBase {
  kind: 'gift';
  giftName: string;
  count: number;
  /** 折合人民币（元）；免费礼物为 0 */
  valueYuan: number;
}

export interface LiveSuperChatEvent extends LiveEventBase {
  kind: 'superchat';
  text: string;
  valueYuan: number;
}

export interface LiveMembershipEvent extends LiveEventBase {
  kind: 'membership';
  /** 平台的会员等级名（舰长 / 提督 / 总督） */
  levelName: string;
  level: number;
  count: number;
  valueYuan: number;
}

/** 进场、关注、分享、点赞：量大、单条价值低，弹幕姬里按计数展示 */
export interface LiveActionEvent extends LiveEventBase {
  kind: 'enter' | 'follow' | 'share' | 'like';
}

export type LiveEvent =
  | LiveChatEvent
  | LiveGiftEvent
  | LiveSuperChatEvent
  | LiveMembershipEvent
  | LiveActionEvent;

export type LiveEventKind = LiveEvent['kind'];

/** 直播间的整体状态，平台推送时更新 */
export interface LiveRoomStats {
  /** 当前在线（B 站为高能榜在线人数） */
  online?: number;
  /** 本场累计看过 */
  watched?: number;
  /** 本场累计点赞 */
  likes?: number;
  /** 正在开播 */
  live?: boolean;
}

export type LiveConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface LiveRoomInfo {
  platform: LivePlatform;
  /** 用户填写的房间号（可能是短号） */
  roomId: number;
  /** 平台的真实房间号 */
  realRoomId?: number;
  title?: string;
  anchorId?: string;
  anchorName?: string;
}

export interface LiveStatus {
  state: LiveConnectionState;
  room?: LiveRoomInfo;
  /** 以登录身份连接；未登录时平台会给部分观众名字打码 */
  loggedIn: boolean;
  stats: LiveRoomStats;
  /** 最近一分钟各类事件的数量 */
  perMinute: Partial<Record<LiveEventKind, number>>;
  connectedAt?: number;
  lastError?: string;
}

/** 推给弹幕姬窗口的增量：同 id 的事件再次出现表示更新（礼物连击累加） */
export interface LiveUpdate {
  events: LiveEvent[];
  status: LiveStatus;
}

/** 连一个直播间要的参数 */
export interface LiveConnection {
  platform: LivePlatform;
  roomId: number;
  /** 平台登录 Cookie；不填则匿名连接（B 站匿名时部分观众名字会打码） */
  cookie: string;
}
