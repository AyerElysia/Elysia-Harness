/**
 * 舞台上放视频：同一时间只放一个。身体告诉舞台放什么、从哪到哪（media 事件），舞台放完回执；
 * 无播放端或回执丢失时明确失败；估算时长不能冒充真实播放完成。
 *
 * 视频地址是 B 站 CDN 的：舞台页不直接连，走舞台服务器转一道（/video?id=…，带上 B 站要的 Referer）。
 */

import { randomUUID } from 'node:crypto';
import type { Stage } from './stage';

export interface PlayRequest {
  bvid: string;
  title: string;
  up: string;
  /** B 站 CDN 上的 MP4 */
  url: string;
  fromSec: number;
  untilSec: number;
}

export interface Playing extends PlayRequest {
  id: string;
  startedAt: number;
  /** 舞台回执开始放时：那时放到第几秒、是什么时候（算现在放到哪） */
  anchor?: { sec: number; at: number };
  /** play_video 在等它开始放 */
  waiter?: (outcome: 'playing' | 'error') => void;
  /** 放不出来的原因（舞台报的） */
  error?: string;
  /** 放不出来已经在 play_video 的结果里告诉她了：不再另外推一次 */
  answered?: boolean;
}

export type PlayEnd = 'ended' | 'error';

/** 舞台开始放了以后多等这么久还没回执「放完」才算它放完 */
const GRACE_MS = 8_000;
/** 舞台一直没回执开始放（加载不出来）最多等多久 */
const LOAD_MS = 25_000;

export class Player {
  private playing: Playing | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly stage: Stage, private readonly onEnd: (video: Playing, how: PlayEnd, playedSec: number) => void) {}

  get current(): Playing | null {
    return this.playing;
  }

  /** 换成这个视频（正在放的直接换掉，不算放完） */
  play(request: PlayRequest): Playing {
    this.clear();
    const video: Playing = { ...request, id: randomUUID(), startedAt: Date.now() };
    this.playing = video;
    this.stage.broadcast({ type: 'media', action: 'play', id: video.id, title: video.title, up: video.up, src: `/video?id=${video.id}`, from: video.fromSec, until: video.untilSec });
    if (this.stage.watchers) {
      video.error = '等待舞台开始播放的回执';
      this.arm(LOAD_MS, 'error');
    } else {
      video.error = '没有可播放的舞台来源';
      this.arm(0, 'error');
    }
    return video;
  }

  /** 她让停的：停下、舞台换回聊天布局，不再告诉她放完 */
  stop(): { video: Playing; playedSec: number } | null {
    const video = this.playing;
    if (!video) return null;
    this.clear();
    return { video, playedSec: this.played(video) };
  }

  /** 舞台的回执：开始放了（按实际位置重新算兜底）、放完了、放不出来（detail：舞台报的原因） */
  report(id: string, state: 'playing' | PlayEnd, positionSec?: number, detail?: string): void {
    const video = this.playing;
    if (!video || video.id !== id) return;
    if (state === 'playing') {
      const at = Number.isFinite(positionSec) ? positionSec! : video.fromSec;
      video.anchor = { sec: at, at: Date.now() };
      video.error = '未收到舞台播放结束回执，完成状态未知';
      this.arm(Math.max(0, video.untilSec - at) * 1000 + GRACE_MS, 'error');
      video.waiter?.('playing');
      return;
    }
    if (state === 'error' && detail) video.error = detail;
    this.finish(state);
  }

  /**
   * 等舞台真的开始放（或者放不出来），最多 ms：play_video 用，她说「放上了」时就是真放上了。
   * pending：还在加载，之后放不出来会另外告诉她
   */
  waitStart(id: string, ms: number): Promise<'playing' | 'error' | 'pending'> {
    const video = this.playing;
    if (!video || video.id !== id) return Promise.resolve('error');
    if (video.anchor) return Promise.resolve('playing');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { video.waiter = undefined; resolve('pending'); }, ms);
      video.waiter = (outcome) => {
        clearTimeout(timer);
        video.waiter = undefined;
        if (outcome === 'error') video.answered = true;
        resolve(outcome);
      };
    });
  }

  /** 舞台服务器转发视频时问：这个 id 现在对应哪个地址 */
  source(id: string): string | null {
    return this.playing?.id === id ? this.playing.url : null;
  }

  private finish(how: PlayEnd): void {
    const video = this.playing;
    if (!video) return;
    const playedSec = how === 'ended' ? video.untilSec - video.fromSec : this.played(video);
    if (how === 'error') video.waiter?.('error');
    this.clear();
    this.onEnd(video, how, playedSec);
  }

  /** 正在放的视频现在放到第几秒（舞台还没回执开始放就按开始放的时间算） */
  position(now = Date.now()): number | null {
    const video = this.playing;
    if (!video) return null;
    if (!video.anchor) return null;
    const { sec, at } = video.anchor;
    return Math.min(video.untilSec, sec + Math.max(0, now - at) / 1000);
  }

  private played(video: Playing): number {
    if (!video.anchor) return 0;
    return Math.min(video.untilSec - video.fromSec, Math.max(0, video.anchor.sec - video.fromSec + (Date.now() - video.anchor.at) / 1000));
  }

  private arm(ms: number, how: PlayEnd): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(how), ms);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.playing) this.stage.broadcast({ type: 'media', action: 'stop', id: this.playing.id });
    this.playing = null;
  }
}
