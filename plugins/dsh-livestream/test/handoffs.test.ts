import { describe, expect, it } from 'vitest';
import { HandOffs } from '../src/dsh/agent';

const message = (...content: Array<{ type: string; text?: string; name?: string }>) => ({ type: 'assistant/message', data: { message: { content } } });
const text = (t: string) => ({ type: 'text', text: t });
const handOff = { type: 'tool-call', name: 'game_side' };

describe('live line handing a request to the game line', () => {
  it('keeps the words written with the hand-off unsaid', () => {
    const h = new HandOffs();
    expect(h.unsaid('live', message(text('彩排观众乙，交给游戏里的我'), handOff))).toBe(true);
  });

  it('keeps the rest of that turn unsaid when she calls the tool first and talks after', () => {
    // 10-28：163 次交接里，每次她都在调完 game_side 之后又写了一句「交过去了……」，念了出来
    const h = new HandOffs();
    h.turnStarted('live');
    expect(h.unsaid('live', message(handOff))).toBe(true);
    expect(h.unsaid('live', message(text('交过去了，游戏里的我已经动工')))).toBe(true);
  });

  it('speaks what she wrote before the hand-off, and every turn starts fresh', () => {
    const h = new HandOffs();
    h.turnStarted('live');
    expect(h.unsaid('live', message(text('小灯塔？好主意')))).toBe(false);
    expect(h.unsaid('live', message(handOff))).toBe(true);
    h.turnStarted('live');
    expect(h.unsaid('live', message(text('欢迎新来的')))).toBe(false);
  });

  it('keeps sessions apart', () => {
    const h = new HandOffs();
    h.unsaid('live-a', message(handOff));
    expect(h.unsaid('live-b', message(text('你好')))).toBe(false);
  });
});
