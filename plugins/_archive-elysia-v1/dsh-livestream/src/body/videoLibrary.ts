/**
 * 视频库：她看过、放过的每个视频存一份，攒成数据（主人以后拿去用）。
 *
 * 一个视频的一 P 一个文件 <dir>/<bvid>-p<page>.json：视频详情、字幕（B 站的一次拿全；Whisper 听写是听到哪段存哪段，
 * 越看越全）、原视频弹幕，和每一次看 / 放的记录（什么时候、哪场、点之前直播间里在聊什么、放的时候她说了什么）。
 * 写盘失败只记一句，不影响直播。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subtitles, SubtitleLine, VideoDanmaku, VideoInfo, VideoPart } from './biliVideo';

export interface LibraryView {
  /** watch：她自己看详情、字幕；play：在舞台上放给大家 */
  how: 'watch' | 'play';
  at: number;
  fromSec: number;
  untilSec?: number;
  /** 这场直播的记录文件名（shows/ 下面） */
  show?: string;
  /** 点之前直播间里最近的弹幕（谁点的、为什么看） */
  chat?: Array<{ name: string; uid: string; text: string; at: number }>;
  /** 放的时候她说的话 */
  said?: string[];
  /** 放了多久、怎么结束的 */
  playedSec?: number;
  end?: string;
}

export interface LibraryEntry {
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  partTitle: string;
  title: string;
  up: { mid: string; name: string };
  pubdate: number;
  durationSec: number;
  stat: VideoInfo['stat'];
  tags: string[];
  desc: string;
  subtitles: { kind: Subtitles['kind']; lang: string; engine?: string; lines: SubtitleLine[] } | null;
  danmaku: VideoDanmaku[];
  views: LibraryView[];
  updatedAt: number;
}

export class VideoLibrary {
  private readonly cache = new Map<string, LibraryEntry>();

  constructor(private readonly dir: string, private readonly log?: (message: string) => void) {}

  private key(bvid: string, page: number): string {
    return `${bvid}-p${page}`;
  }

  private load(info: VideoInfo, part: VideoPart): LibraryEntry {
    const key = this.key(info.bvid, part.page);
    let entry = this.cache.get(key);
    if (!entry) {
      try {
        entry = JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8')) as LibraryEntry;
      } catch {
        entry = { bvid: info.bvid, aid: info.aid, cid: part.cid, page: part.page, partTitle: part.title, title: info.title, up: info.up, pubdate: info.pubdate,
          durationSec: part.durationSec, stat: info.stat, tags: info.tags, desc: info.desc, subtitles: null, danmaku: [], views: [], updatedAt: 0 };
      }
      this.cache.set(key, entry);
    }
    // 详情以最新一次为准（播放量会涨）
    Object.assign(entry, { title: info.title, up: info.up, stat: info.stat, tags: info.tags, desc: info.desc });
    return entry;
  }

  private save(entry: LibraryEntry): void {
    entry.updatedAt = Date.now();
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${this.key(entry.bvid, entry.page)}.json`), JSON.stringify(entry));
    } catch (err) {
      this.log?.(`视频库没存上（${entry.bvid}）：${(err as Error).message}`);
    }
  }

  /** 看了一次 / 放了一次：记下来；返回这次的记录（放完时再补上她说了什么） */
  view(info: VideoInfo, part: VideoPart, view: LibraryView): LibraryView {
    const entry = this.load(info, part);
    entry.views.push(view);
    this.save(entry);
    return view;
  }

  /** 放完了：补上这次放了多久、怎么结束的、她说了什么 */
  finish(info: VideoInfo, part: VideoPart, view: LibraryView, end: Pick<LibraryView, 'playedSec' | 'end' | 'said'>): void {
    Object.assign(view, end);
    this.save(this.load(info, part));
  }

  /** 拿到了字幕：B 站的整份换上；Whisper 听写的一段一段并进去（同一处只留一份） */
  subtitles(info: VideoInfo, part: VideoPart, sub: Subtitles | null): void {
    if (!sub?.lines.length) return;
    const entry = this.load(info, part);
    const old = entry.subtitles;
    if (sub.kind !== 'asr' || !old || old.kind !== 'asr') {
      // 有 B 站字幕就不要听写的；已经有 B 站字幕时听写的也不要
      if (old && old.kind !== 'asr' && sub.kind === 'asr') return;
      entry.subtitles = { kind: sub.kind, lang: sub.lang, ...(sub.engine ? { engine: sub.engine } : {}), lines: sub.lines };
    } else {
      const seen = new Set(old.lines.map((l) => `${l.from}|${l.text}`));
      const merged = [...old.lines, ...sub.lines.filter((l) => !seen.has(`${l.from}|${l.text}`))].sort((a, b) => a.from - b.from);
      entry.subtitles = { ...old, lines: merged };
    }
    this.save(entry);
  }

  /** 原视频弹幕：拿到了就存（换成更多的那份） */
  danmaku(info: VideoInfo, part: VideoPart, list: VideoDanmaku[]): void {
    const entry = this.load(info, part);
    if (list.length <= entry.danmaku.length) return;
    entry.danmaku = list;
    this.save(entry);
  }

  /** 这个视频这一 P 的弹幕存过没有（存过就不用再去拿） */
  hasDanmaku(info: VideoInfo, part: VideoPart): boolean {
    return this.load(info, part).danmaku.length > 0;
  }
}
