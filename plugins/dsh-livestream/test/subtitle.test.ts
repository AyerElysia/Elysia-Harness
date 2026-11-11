import { describe, expect, it } from 'vitest';
import { subtitleTimeline } from '../src/body/tts';

// 豆包 HTTP V3 enable_subtitle 实际返回的形状：逐字，标点粘在前一个字上，秒是整段音频里的绝对时间
const words = [
  { word: '大', start: 0, end: 0.165 }, { word: '家', start: 0.165, end: 0.465 }, { word: '晚', start: 0.465, end: 0.645 },
  { word: '上', start: 0.645, end: 0.855 }, { word: '好', start: 0.855, end: 1.125 }, { word: '呀，', start: 1.125, end: 1.515 },
  { word: '我', start: 1.735, end: 1.935 }, { word: '是', start: 1.935, end: 2.1 },
];

describe('subtitle timeline', () => {
  it('lights each character when it is spoken, punctuation with it', () => {
    const t = subtitleTimeline('大家晚上好呀，我是大肥鱼', words);
    expect(t[0]).toEqual({ chars: 0, atMs: 0 });
    expect(t).toContainEqual({ chars: 7, atMs: 1515 }); // 「呀，」念完：亮到逗号
    expect(t).toContainEqual({ chars: 7, atMs: 1735 }); // 停顿后「我」开口时还停在逗号
    expect(t[t.length - 1]).toEqual({ chars: 9, atMs: 2100 });
  });
  it('skips characters the service rewrote', () => {
    const t = subtitleTimeline('大家晚上好', [{ word: '打', start: 0, end: 0.1 }, { word: '家', start: 0.1, end: 0.3 }]);
    expect(t).toEqual([{ chars: 1, atMs: 100 }, { chars: 2, atMs: 300 }]);
  });
});

describe('clone voice language', () => {
  it('reads a Japanese segment as Japanese and keeps Chinese with a few Japanese words as Chinese', async () => {
    const { languageOf } = await import('../src/body/tts');
    expect(languageOf('日本語は分かりますよ、ただ言わないだけです。')).toBe('ja');
    expect(languageOf('こんばんは！')).toBe('ja');
    expect(languageOf('Qビット，又见面啦，こんばんは！三天前你还跟我用日语聊过呢。')).toBe('zh-cn');
    expect(languageOf('今天吃了三碗饭。')).toBe('zh-cn');
    expect(languageOf('JSON 我闭着眼都能写')).toBe('zh-cn');
    expect(languageOf('Guten Abend, ich bin der große Fisch.')).toBe('crosslingual');
    expect(languageOf('Good evening, I am the big fish.')).toBe('crosslingual');
    expect(languageOf('안녕하세요, 저는 큰 물고기예요.')).toBe('ko');
    expect(languageOf('Добрый вечер, я большая рыба.')).toBe('ru');
    expect(languageOf('谢谢你，Danke 也会说一句')).toBe('zh-cn');
  });
});
