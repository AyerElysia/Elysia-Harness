import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock, parseVideoRef, searchText, subtitleChunk, subtitleText, type Subtitles, type VideoInfo } from '../src/body/biliVideo';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Whisper } from '../src/body/asr';
import { Player } from '../src/body/player';
import { Stage } from '../src/body/stage';
import { arrange } from '../src/stage/layout';
import type { StageEvent, TemplateManifest } from '../src/stage/protocol';

describe('video refs', () => {
  it('reads BV, av and links with a part', () => {
    expect(parseVideoRef('BV1YFQPB8Ee2')).toEqual({ bvid: 'BV1YFQPB8Ee2' });
    expect(parseVideoRef('https://www.bilibili.com/video/BV1YFQPB8Ee2/?p=3&t=10')).toEqual({ bvid: 'BV1YFQPB8Ee2', part: 3 });
    expect(parseVideoRef('av170001')).toEqual({ aid: 170001 });
    expect(parseVideoRef('那个猫猫视频')).toBeNull();
  });
  it('writes clock times', () => {
    expect(clock(65)).toBe('1:05');
    expect(clock(3723)).toBe('1:02:03');
  });
});

describe('search text', () => {
  const hit = { bvid: 'BV1YFQPB8Ee2', title: '学生抓老师！', up: '我是七奇', durationSec: 242, views: 38_181_052, pubdate: 1_775_836_758, tags: ['搞笑', '校园'] };
  it('lists candidates with BV ids and how to refine', () => {
    const text = searchText('躲猫猫', { hits: [hit] }, {});
    expect(text).toContain('搜「躲猫猫」（按相关度），第 1 页');
    expect(text).toContain('1. BV1YFQPB8Ee2「学生抓老师！」UP 我是七奇，4:02，3818万播放');
    expect(text).toContain('标签 搞笑、校园');
    expect(text).toContain('page 翻页');
  });
  it('gives each hit its cover image so she can draw it in the game', () => {
    const cover = 'https://i2.hdslb.com/bfs/archive/03ecacd5d373baf82d2b32246d17b02d0479a016.jpg';
    expect(searchText('熊本熊', { hits: [{ ...hit, cover }] }, {})).toContain(`封面 ${cover}`);
  });
  it('names the uploader it searched and the look-alikes', () => {
    const text = searchText('', { hits: [hit], up: { mid: '546195', name: '老番茄', others: [{ mid: '609013982', name: 'PPOMO老番茄' }] } }, { up: '老番茄' });
    expect(text).toContain('在 老番茄（UID 546195）的投稿里找最新的');
    expect(text).toContain('PPOMO老番茄（UID 609013982）');
    expect(text).not.toContain('UP 老番茄');
  });
  it('says the uploader was not found', () => {
    expect(searchText('猫', { hits: [], upMissing: true }, { up: '没这人' })).toContain('没找到叫「没这人」的 UP 主');
  });
});

describe('subtitles', () => {
  const sub: Subtitles = {
    kind: 'ai', lang: '中文',
    lines: Array.from({ length: 40 }, (_, i) => ({ from: i * 3, to: i * 3 + 2.5, text: `第${i}句话` })),
  };
  const info = { bvid: 'BV1YFQPB8Ee2', parts: [{ cid: 1, page: 1, title: 'p1', durationSec: 120 }] } as VideoInfo;
  it('groups lines into timed paragraphs', () => {
    const chunk = subtitleChunk(sub, 0);
    expect(chunk.text.split('\n')[0]).toBe('[0:00] 第0句话 第1句话 第2句话 第3句话 第4句话');
    expect(chunk.text.split('\n')[1].startsWith('[0:15] ')).toBe(true);
    expect(chunk.next).toBeNull();
  });
  it('pages long subtitles and says where to continue', () => {
    const chunk = subtitleChunk(sub, 30, 30);
    expect(chunk.startSec).toBe(30);
    expect(chunk.next).toBe(45);
    const text = subtitleText(info, info.parts[0], sub, 0, '');
    expect(text).toContain('B 站官方 AI 识别的中文字幕');
    expect(text).toContain('字幕到这里完了');
  });
  it('says when there are none', () => {
    expect(subtitleText(info, info.parts[0], null, 0, '')).toContain('没有字幕');
  });
  it('continues a heard chunk where listening stopped', () => {
    const long = { bvid: 'BV1YFQPB8Ee2', parts: [{ cid: 1, page: 1, title: 'p1', durationSec: 900 }] } as VideoInfo;
    const heard: Subtitles = { kind: 'asr', lang: 'zh', lines: [{ from: 2, to: 5, text: '大家好' }], until: 300 };
    const text = subtitleText(long, long.parts[0], heard, 0, '');
    expect(text).toContain('Whisper');
    expect(text).toContain('不是 B 站官方字幕');
    expect(text).toContain('from=300) 接着看');
    expect(subtitleText(long, long.parts[0], { ...heard, until: 900 }, 0, '')).toContain('字幕到这里完了');
  });
  it('says a heard chunk had no talking', () => {
    const text = subtitleText(info, info.parts[0], { kind: 'asr', lang: '', lines: [], until: 120 }, 0, '');
    expect(text).toContain('没听出有人说话');
    expect(text).toContain('字幕到这里完了');
  });
});

describe('listening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-asr-'));
  const whisper = (python = '') => new Whisper({ python: () => python, model: () => 'small', script: join(dir, 'none.py'), dataDir: dir, log: () => {} });
  it('reuses a heard chunk without starting whisper', async () => {
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
    const saved = { lang: 'zh', lines: [{ from: 310, to: 312, text: '第二段' }], until: 600 };
    writeFileSync(join(dir, 'transcripts', 'BV1-7-300.json'), JSON.stringify(saved));
    const audio = vi.fn(async () => null);
    // 437 秒在 300–600 那一段里
    expect(await whisper().chunk({ bvid: 'BV1', cid: 7, durationSec: 900 }, 437, audio)).toEqual(saved);
    expect(audio).not.toHaveBeenCalled();
  });
  it('gives nothing when whisper is not set up or the video is over', async () => {
    expect(whisper().available).toBe(false);
    expect(await whisper().chunk({ bvid: 'BV1', cid: 7, durationSec: 900 }, 0, async () => null)).toBeNull();
    expect(await whisper().chunk({ bvid: 'BV1', cid: 7, durationSec: 900 }, 900, async () => null)).toBeNull();
  });
});

describe('player', () => {
  afterEach(() => vi.useRealTimers());
  const request = { bvid: 'BV1', title: '猫猫', up: 'UP', url: 'https://cdn/x.mp4', fromSec: 10, untilSec: 70 };

  it('tells the stage to play and stop, and reports the end once', () => {
    const stage = new Stage();
    const events: StageEvent[] = [];
    stage.subscribe((e) => events.push(e));
    const ends: string[] = [];
    const player = new Player(stage, (v, how) => ends.push(`${v.title}:${how}`));
    const video = player.play(request);
    expect(events.at(-1)).toMatchObject({ type: 'media', action: 'play', src: `/video?id=${video.id}`, from: 10, until: 70 });
    expect(player.source(video.id)).toBe('https://cdn/x.mp4');
    player.report(video.id, 'ended');
    player.report(video.id, 'ended');
    expect(ends).toEqual(['猫猫:ended']);
    expect(events.at(-1)).toMatchObject({ type: 'media', action: 'stop', id: video.id });
    expect(player.source(video.id)).toBeNull();
  });

  it('waits for the stage before saying a video is playing', async () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {});
    const ends: Array<{ how: string; answered?: boolean }> = [];
    const player = new Player(stage, (v, how) => ends.push({ how, answered: v.answered }));
    const ok = player.play(request);
    const started = player.waitStart(ok.id, 15_000);
    player.report(ok.id, 'playing', 10);
    expect(await started).toBe('playing');

    const bad = player.play({ ...request, title: '坏的' });
    const failed = player.waitStart(bad.id, 15_000);
    player.report(bad.id, 'error', undefined, 'MediaError 4');
    expect(await failed).toBe('error');
    expect(bad.error).toBe('MediaError 4');
    // 已经在 play_video 的结果里说了，身体不再另外推「没放出来」
    expect(ends.at(-1)).toEqual({ how: 'error', answered: true });

    const slow = player.play({ ...request, title: '慢的' });
    const pending = player.waitStart(slow.id, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBe('pending');
  });

  it('a replaced or stopped video is not reported as finished', () => {
    const player = new Player(new Stage(), () => { throw new Error('should not end'); });
    const first = player.play(request);
    player.play({ ...request, title: '狗狗' });
    player.report(first.id, 'ended');
    expect(player.stop()?.video.title).toBe('狗狗');
    expect(player.stop()).toBeNull();
  });

  it('without a stage page it ends by the clock', () => {
    vi.useFakeTimers();
    const ends: number[] = [];
    const player = new Player(new Stage(), (_v, _how, played) => ends.push(played));
    player.play(request);
    vi.advanceTimersByTime(59_000);
    expect(ends).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(ends).toEqual([60]);
  });

  it('a stage page that never starts playing is an error', () => {
    vi.useFakeTimers();
    const stage = new Stage();
    stage.subscribe(() => {});
    const ends: string[] = [];
    const player = new Player(stage, (_v, how) => ends.push(how));
    player.play(request);
    vi.advanceTimersByTime(30_000);
    expect(ends).toEqual(['error']);
  });
});

describe('layouts', () => {
  const template: TemplateManifest = {
    format: 1, id: 't', name: 't', canvas: [1920, 1080], theme: {},
    widgets: [{ type: 'chat', x: 40, y: 100, w: 480 }, { type: 'character', x: 700, y: 40, w: 520 }, { type: 'rice', x: 1400, y: 100 }],
    layouts: { video: [{ type: 'video', x: 560, y: 100, w: 1320, h: 742 }, { type: 'character', x: 1650, y: 690, scale: 0.42 }, { type: 'rice', hidden: true }] },
  };
  it('keeps the same slots in both layouts and moves the ones the layout names', () => {
    const chat = arrange(template, 'chat');
    const video = arrange(template, 'video');
    expect(chat.map((s) => s.key)).toEqual(video.map((s) => s.key));
    expect(chat.find((s) => s.type === 'video')?.hidden).toBe(true);
    expect(video.find((s) => s.type === 'video')).toMatchObject({ hidden: undefined, x: 560, w: 1320 });
    expect(video.find((s) => s.type === 'character')).toMatchObject({ x: 1650, y: 690, w: 520, scale: 0.42 });
    expect(video.find((s) => s.type === 'chat')).toMatchObject({ x: 40, y: 100 });
    expect(video.find((s) => s.type === 'rice')?.hidden).toBe(true);
    expect(chat.find((s) => s.type === 'character')).toMatchObject({ x: 700, y: 40 });
  });
  it('gives a template without a video layout a player in the middle', () => {
    const slot = arrange({ ...template, layouts: undefined }, 'video').find((s) => s.type === 'video');
    expect(slot).toMatchObject({ x: 384, w: 1152, h: 648 });
  });
});
