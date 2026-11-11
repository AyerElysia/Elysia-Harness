import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoInfo, VideoPart } from '../src/body/biliVideo';
import { LiveShow, type VideoEnd } from '../src/body/show';
import { VideoLibrary } from '../src/body/videoLibrary';

const info: VideoInfo = {
  bvid: 'BV1xx411c7mD', aid: 1, title: '测试视频', up: { mid: '9', name: 'UP' }, pubdate: 0, durationSec: 900,
  stat: { views: 1, likes: 0, coins: 0, favorites: 0, danmaku: 0, replies: 0 }, desc: '简介', tags: ['游戏'],
  parts: [{ cid: 100, page: 1, title: 'P1', durationSec: 900 }],
};
const part: VideoPart = info.parts[0];
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'BV1xx411c7mD-p1.json'), 'utf8'));

describe('video library', () => {
  it('stitches Whisper chunks together and keeps every view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lib-'));
    const lib = new VideoLibrary(dir);
    lib.view(info, part, { how: 'watch', at: 1, fromSec: 0, chat: [{ name: '路人', uid: 'u1', text: '看看这个', at: 0 }] });
    lib.subtitles(info, part, { kind: 'asr', lang: 'zh', engine: 'large-v3-turbo', lines: [{ from: 0, to: 2, text: '第一段' }], until: 300 });
    lib.subtitles(info, part, { kind: 'asr', lang: 'zh', engine: 'large-v3-turbo', lines: [{ from: 0, to: 2, text: '第一段' }, { from: 301, to: 303, text: '第二段' }], until: 600 });
    const view = lib.view(info, part, { how: 'play', at: 2, fromSec: 0, untilSec: 180 });
    lib.finish(info, part, view, { playedSec: 120, end: 'stopped', said: ['好好笑'] });

    const saved = read(dir);
    expect(saved.subtitles.lines.map((l: { text: string }) => l.text)).toEqual(['第一段', '第二段']);
    expect(saved.views).toHaveLength(2);
    expect(saved.views[0].chat[0].text).toBe('看看这个');
    expect(saved.views[1]).toMatchObject({ how: 'play', playedSec: 120, end: 'stopped', said: ['好好笑'] });
    // 换一个实例（插件重启）接着记
    new VideoLibrary(dir).view(info, part, { how: 'watch', at: 3, fromSec: 300 });
    expect(read(dir).views).toHaveLength(3);
  });

  it('prefers Bilibili subtitles over Whisper and keeps the bigger danmaku list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lib-'));
    const lib = new VideoLibrary(dir);
    lib.subtitles(info, part, { kind: 'asr', lang: 'zh', lines: [{ from: 0, to: 2, text: '听写' }] });
    lib.subtitles(info, part, { kind: 'ai', lang: '中文', lines: [{ from: 0, to: 2, text: '官方' }] });
    lib.subtitles(info, part, { kind: 'asr', lang: 'zh', lines: [{ from: 5, to: 6, text: '又听写' }] });
    lib.danmaku(info, part, [{ at: 1, text: 'a' }, { at: 2, text: 'b' }]);
    lib.danmaku(info, part, [{ at: 1, text: 'a' }]);
    const saved = read(dir);
    expect(saved.subtitles).toMatchObject({ kind: 'ai', lines: [{ text: '官方' }] });
    expect(saved.danmaku).toHaveLength(2);
    expect(lib.hasDanmaku(info, part)).toBe(true);
  });
});

describe('show tells who played a video when it stops', () => {
  afterEach(() => vi.useRealTimers());

  it('reports stopped, replaced and off-air ends', async () => {
    vi.useFakeTimers();
    const show = new LiveShow(
      { push: async () => true, synthesize: async () => null },
      { dataDir: mkdtempSync(join(tmpdir(), 'dsh-lib-show-')), names: ['大肥鱼'] },
    );
    show.goLive('s1');
    const ends: VideoEnd[] = [];
    const req = { bvid: 'BV1', title: '一', up: 'UP', url: 'x', fromSec: 10, untilSec: 200 };
    show.playVideo(req, undefined, (end) => ends.push(end));
    await vi.advanceTimersByTimeAsync(30_000);
    show.playVideo({ ...req, title: '二' }, undefined, (end) => ends.push(end));
    show.stopVideo();
    show.playVideo({ ...req, title: '三' }, undefined, (end) => ends.push(end));
    show.endLive();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ends.map((e) => e.how)).toEqual(['replaced', 'stopped', 'off']);
    expect(ends[0].playedSec).toBe(30);
    show.dispose();
  });
});
