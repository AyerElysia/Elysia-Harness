/**
 * 注意力层的输出：一个「现在可以开口说的话题」。说话本身由 LLM 生成，这里只决定说什么、对谁说。
 */

import type {
  LiveChatEvent,
  LiveGiftEvent,
  LiveMembershipEvent,
  LiveSuperChatEvent,
  LiveUser,
} from '../live';

/** 房间热度：决定她能顾得上多少，以及值不值得点名 */
export type RoomHeat = 'unknown' | 'quiet' | 'normal' | 'busy';

export interface ChatPick {
  event: LiveChatEvent;
  /** 同一个人连发的几条合在一起 */
  text: string;
  /** 给 LLM 看的标签：问题 / 点名 / 舰长 / 新观众 / 接她的话 … */
  tags: string[];
  score: number;
}

export type TopicBody =
  /** Budgeted pages of original protocol events; refs resolve the complete raw input. */
  | { kind: 'events'; records: import('./attention').InputProjection[]; pendingIds: number[]; events: import('../live').LiveEvent[] }
  /** 醒目留言：单独念、单独回 */
  | { kind: 'superchat'; event: LiveSuperChatEvent }
  /** 上舰与大额礼物：逐个点名感谢 */
  | { kind: 'thanks'; events: Array<LiveGiftEvent | LiveMembershipEvent> }
  /** 小礼物：攒一批一起谢；more 是没点名的人数 */
  | { kind: 'gifts'; events: LiveGiftEvent[]; more: number }
  | { kind: 'chat'; picks: ChatPick[] }
  /** 很多人在刷同一句 */
  | { kind: 'trend'; key: string; samples: string[]; users: number }
  | { kind: 'welcome'; users: LiveUser[]; more: number }
  | { kind: 'follow'; users: LiveUser[]; more: number }
  /** 一段时间没人说话：她自己找话说 */
  | { kind: 'idle'; silentMs: number }
  /** 开播：跟大家打招呼 */
  | { kind: 'opening' }
  /** 谢幕：道别，可以提一下本场 */
  | { kind: 'ending'; summary: string }
  /** 主人（搭档）开口跟她说话：interrupted 是她被打断时正在说的那句 */
  | { kind: 'owner'; text: string; interrupted?: string; who?: string }
  /** 她在舞台上放的视频放完了（error：没放出来）；playedSec 是放了多久 */
  | { kind: 'video'; title: string; how: 'ended' | 'error'; playedSec: number }
  /** 直播插件重启了（主人在更新），断了 gapSec 秒，这场接着播 */
  | { kind: 'resumed'; gapSec: number; playing?: boolean }
  /** 她在直播里开着的游戏：这一轮她停下了、直播间也没事，叫她接着玩 */
  | { kind: 'game' }
  /** 开播账号收到了新私信、评论回复、@（只有她看得到；lines 已经写好、内容包在标签里） */
  | { kind: 'inbox'; lines: string[] }
  /**
   * 边看边聊：她放的视频 from–to 秒这段里说了什么、原视频的弹幕在刷什么（没别的事要回时才有）。
   * source：字幕从哪来（human UP 主做的、ai B 站官方 AI、asr Whisper 听写；null 没有）
   */
  | {
    kind: 'watching';
    title: string;
    fromSec: number;
    toSec: number;
    lines: Array<{ from: number; text: string }>;
    source: 'human' | 'ai' | 'asr' | null;
    engine?: string;
    danmaku: string[];
  };

export type Topic = TopicBody & {
  id: string;
  priority: number;
  heat: RoomHeat;
  createdAt: number;
  deliveryKey?: string;
  replayText?: string;
};

export type TopicKind = Topic['kind'];
