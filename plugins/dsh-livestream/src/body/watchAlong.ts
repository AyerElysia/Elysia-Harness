/**
 * 边看边聊：她在舞台上放视频时，身体手里的「这段视频里有什么」——说的话（字幕或 Whisper 听写）和原视频的弹幕。
 *
 * 开始放就在后台加载：B 站字幕一次拿全；没有字幕就从开始的地方一段一段听写（每段 5 分钟，按顺序），
 * 原视频弹幕一次拿全。导演（show.ts）问「from–to 这段有什么」，拿到多少给多少，没加载完的那部分就是空的。
 */

import type { Subtitles, SubtitleLine, VideoDanmaku } from './biliVideo';

export interface WatchSource {
  /** B 站的字幕（UP 主做的或官方 AI 的）；没有返回 null */
  subtitles(): Promise<Subtitles | null>;
  /** 听写 fromSec 所在的那一段（没配语音识别、听失败返回 null） */
  listen(fromSec: number): Promise<Subtitles | null>;
  danmaku(): Promise<VideoDanmaku[]>;
}

export interface WatchMoment {
  lines: SubtitleLine[];
  /** 字幕从哪来；还没拿到任何字幕为 null */
  kind: Subtitles['kind'] | null;
  /** asr：哪个 Whisper 模型 */
  engine?: string;
  danmaku: VideoDanmaku[];
}

/** 一段里最多给她几条原视频弹幕 */
const DANMAKU_MAX = 12;

export class VideoNotes {
  private lines: SubtitleLine[] = [];
  private kind: Subtitles['kind'] | null = null;
  private engine: string | undefined;
  private comments: VideoDanmaku[] = [];
  private stopped = false;

  constructor(private readonly fromSec: number, private readonly untilSec: number, source: WatchSource, log?: (message: string) => void) {
    void source.danmaku().then((list) => { this.comments = list; }, () => {});
    void this.load(source).catch((err) => log?.(`边看边聊：字幕没拿到（${(err as Error).message}）`));
  }

  private async load(source: WatchSource): Promise<void> {
    const sub = await source.subtitles();
    if (sub) return this.take(sub);
    // 没字幕：从开始放的地方往后一段一段听，听到放完的地方为止
    let at = this.fromSec;
    while (!this.stopped && at < this.untilSec) {
      const heard = await source.listen(at);
      if (!heard || this.stopped) return;
      this.take(heard);
      if (heard.until === undefined || heard.until <= at) return;
      at = heard.until;
    }
  }

  private take(sub: Subtitles): void {
    this.kind = sub.kind;
    this.engine = sub.engine;
    this.lines = [...this.lines, ...sub.lines].sort((a, b) => a.from - b.from);
  }

  /** from–to 秒这段：说的话和原视频弹幕（弹幕太多时均匀挑几条，重复的只留一条） */
  between(fromSec: number, toSec: number): WatchMoment {
    const lines = this.lines.filter((l) => l.to > fromSec && l.from < toSec);
    const seen = new Set<string>();
    const inRange = this.comments.filter((d) => d.at >= fromSec && d.at < toSec && !seen.has(d.text) && seen.add(d.text));
    const step = inRange.length / DANMAKU_MAX;
    const danmaku = step > 1 ? Array.from({ length: DANMAKU_MAX }, (_, i) => inRange[Math.floor(i * step)]) : inRange;
    return { lines, kind: this.kind, ...(this.engine ? { engine: this.engine } : {}), danmaku };
  }

  /** 不放了：后面的不再听 */
  stop(): void {
    this.stopped = true;
  }
}
