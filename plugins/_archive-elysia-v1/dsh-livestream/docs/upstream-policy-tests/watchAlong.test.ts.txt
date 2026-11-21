import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Subtitles } from '../src/body/biliVideo';
import { LiveShow } from '../src/body/show';
import { VideoNotes, type WatchSource } from '../src/body/watchAlong';
import { topicText } from '../src/core/topicText';

const flush = () => new Promise((r) => setImmediate(r));

function source(over: Partial<WatchSource> = {}): WatchSource {
  return { subtitles: async () => null, listen: async () => null, danmaku: async () => [], ...over };
}

describe('video notes', () => {
  it('gives the lines and a spread of distinct danmaku for a span', async () => {
    const sub: Subtitles = { kind: 'ai', lang: '中文', lines: [{ from: 1, to: 3, text: '开头' }, { from: 20, to: 22, text: '中间' }, { from: 50, to: 52, text: '后面' }] };
    const danmaku = Array.from({ length: 40 }, (_, i) => ({ at: 10 + i * 0.5, text: i % 2 ? `第${i}条` : '哈哈哈' }));
    const notes = new VideoNotes(0, 60, source({ subtitles: async () => sub, danmaku: async () => danmaku }));
    await flush();
    const m = notes.between(10, 40);
    expect(m.lines.map((l) => l.text)).toEqual(['中间']);
    expect(m.kind).toBe('ai');
    expect(m.danmaku.length).toBe(12);
    expect(m.danmaku.filter((d) => d.text === '哈哈哈').length).toBe(1);
  });

  it('listens chunk after chunk from where it started, and stops when told', async () => {
    const asked: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const notes = new VideoNotes(420, 900, source({
      listen: async (at) => {
        asked.push(at);
        if (at >= 600) await gate;
        const start = Math.floor(at / 300) * 300;
        return { kind: 'asr', lang: 'zh', engine: 'large-v3-turbo', lines: [{ from: start + 5, to: start + 8, text: `第${start}段` }], until: start + 300 };
      },
    }));
    await flush();
    expect(asked).toEqual([420, 600]);
    expect(notes.between(300, 600)).toMatchObject({ kind: 'asr', engine: 'large-v3-turbo', lines: [{ text: '第300段' }] });
    notes.stop();
    release();
    await flush();
    expect(asked).toEqual([420, 600]);
  });
});

describe('watching along', () => {
  afterEach(() => vi.useRealTimers());

  function start(notes: VideoNotes) {
    vi.useFakeTimers();
    const pushed: string[] = [];
    const show = new LiveShow(
      { push: async (_s, text) => { pushed.push(text); return true; }, synthesize: async () => null },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-watch-')), names: ['大肥鱼'] },
    );
    show.goLive('s1');
    return { show, pushed };
  }

  async function turn(show: LiveShow, ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    show.turnEnded('s1');
  }

  it('tells her what the video says when the room is quiet, and danmaku come first', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ from: i * 4, to: i * 4 + 3, text: `视频第${i}句` }));
    const notes = new VideoNotes(0, 240, source({ subtitles: async () => ({ kind: 'human', lang: '中文', lines }), danmaku: async () => [{ at: 12, text: '前方高能' }] }));
    const { show, pushed } = start(notes);
    await turn(show, 500); // 开场
    expect(pushed).toHaveLength(1);
    show.playVideo({ bvid: 'BV1', title: '测试视频', up: 'UP', url: 'x', fromSec: 0, untilSec: 240 }, notes);

    await turn(show, 25_000);
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('「测试视频」正放到');
    expect(pushed[1]).toContain('<视频里说的>');
    expect(pushed[1]).toContain('视频第3句');
    expect(pushed[1]).toContain('前方高能');

    // 有人发弹幕：先回弹幕，不等视频
    show.inject({ kind: 'chat', id: 'c1', platform: 'bilibili', ts: Date.now(), user: { id: 'u1', name: '路人' }, text: '这游戏好玩吗' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toContain('这游戏好玩吗');
    show.endLive();
    show.dispose();
  });

  it('stays quiet through a span with no talking and no danmaku', async () => {
    const notes = new VideoNotes(0, 240, source({ subtitles: async () => ({ kind: 'human', lang: '中文', lines: [{ from: 200, to: 203, text: '很后面' }] }) }));
    const { show, pushed } = start(notes);
    await turn(show, 500);
    show.playVideo({ bvid: 'BV1', title: '纯音乐', up: 'UP', url: 'x', fromSec: 0, untilSec: 240 }, notes);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pushed).toHaveLength(1);
    show.endLive();
    show.dispose();
  });
});

describe('watching text', () => {
  it('names Whisper and keeps old danmaku apart', () => {
    const text = topicText({
      kind: 'watching', title: '实况', fromSec: 60, toSec: 95, lines: [{ from: 61, text: '这个能源很快就没了' }], source: 'asr', engine: 'large-v3-turbo',
      danmaku: ['老菊牛逼'], id: 'w', priority: 1, heat: 'quiet', createdAt: 0,
    }, {});
    expect(text).toContain('正放到 1:35');
    expect(text).toContain('主人给你装的 Whisper 听写的');
    expect(text).toContain('<原视频弹幕>');
    expect(text).toContain('- 老菊牛逼');
    expect(text).toContain('不超过 40 字');
  });
});

describe('board', () => {
  it('tells her at the opening what the board says', () => {
    const text = topicText({ kind: 'opening', id: 'o', priority: 200, heat: 'quiet', createdAt: 0 }, { board: '想看什么，跟大肥鱼说\n说个大概就行' });
    expect(text).toContain('<告示板>');
    expect(text).toContain('说个大概就行');
    expect(topicText({ kind: 'opening', id: 'o', priority: 200, heat: 'quiet', createdAt: 0 }, { board: '  ' })).not.toContain('告示板');
  });

  it('tells her at the opening what today is about from the live title, before the board', () => {
    const text = topicText({ kind: 'opening', id: 'o', priority: 200, heat: 'quiet', createdAt: 0 }, { title: '【测试】大肥鱼MC建筑大师、画头像回', board: '这场：MC 测试三件事' });
    expect(text).toContain('这场直播的标题是「【测试】大肥鱼MC建筑大师、画头像回」');
    expect(text.indexOf('标题')).toBeLessThan(text.indexOf('<告示板>'));
  });

  it('hands the latest board to a stage page that connects later', async () => {
    const { Stage } = await import('../src/body/stage');
    const stage = new Stage();
    stage.broadcast({ type: 'board', text: '旧的' });
    stage.broadcast({ type: 'board', text: '新的' });
    const got: string[] = [];
    stage.subscribe((e) => { if (e.type === 'board') got.push(e.text); }, false);
    expect(got).toEqual(['新的']);
  });
});
