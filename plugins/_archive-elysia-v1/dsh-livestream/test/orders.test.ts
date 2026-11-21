import { describe, expect, it } from 'vitest';
import { OrderBook, orderTags } from '../src/core/orders';

describe('order book', () => {
  it('keeps orders in arrival order with the one being made first', () => {
    const book = new OrderBook();
    const a = book.add('卢哥love', '画我的头像', 1, '1');
    const b = book.add('屠勇士', '盖个光棱塔', 2);
    book.add('凑鸽子', '画我的头像', 3);
    book.mark(b.id, 'doing', 4);
    expect(book.open().map((o) => o.who)).toEqual(['屠勇士', '卢哥love', '凑鸽子']);
    book.mark(a.id, 'done', 5);
    expect(book.open().map((o) => o.id)).toEqual([2, 3]);
    expect(book.shown().map((o) => [o.id, o.state])).toEqual([[2, 'doing'], [3, 'queued'], [1, 'done']]);
  });

  it('tells the live line who is waiting, in order', () => {
    const book = new OrderBook();
    book.add('卢哥love', '画我的头像', 1);
    book.mark(book.add('屠勇士', '盖个光棱塔', 2).id, 'doing', 3);
    expect(book.summary()).toBe('点单队列（2 单没做完，按顺序）：#2 屠勇士「盖个光棱塔」（在做），#1 卢哥love「画我的头像」');
    expect(new OrderBook().summary()).toBe('');
  });

  it('comes back the same after a restart and keeps numbering', () => {
    const book = new OrderBook();
    book.add('a', 'x', 1);
    book.add('b', 'y', 2);
    const again = new OrderBook(JSON.parse(JSON.stringify(book)));
    expect(again.open().map((o) => o.who)).toEqual(['a', 'b']);
    expect(again.add('c', 'z', 3).id).toBe(3);
  });

  it('marks an order nobody has as a miss', () => {
    expect(new OrderBook().mark(9, 'done', 1)).toBe(false);
  });

  it('keeps only the last thirty closed orders', () => {
    const book = new OrderBook();
    for (let i = 0; i < 40; i++) book.mark(book.add(`u${i}`, 'x', i).id, 'done', 100 + i);
    expect(book.toJSON().items).toHaveLength(30);
    expect(book.toJSON().items[0].who).toBe('u10');
  });
});

describe('order tags in what she says', () => {
  it('reads and removes the tags, leaving the words to speak', () => {
    expect(orderTags('[完成#3] 卢哥love，你的头像墙立好了！')).toEqual({ text: '卢哥love，你的头像墙立好了！', marks: [{ id: 3, state: 'done' }] });
    expect(orderTags('[开工# 4][不做#5] 光棱塔开盖，核弹就不画了')).toEqual({ text: '光棱塔开盖，核弹就不画了', marks: [{ id: 4, state: 'doing' }, { id: 5, state: 'dropped' }] });
  });
  it('leaves words without tags alone, mood tags included', () => {
    expect(orderTags('[laugh] 开盖！')).toEqual({ text: '[laugh] 开盖！', marks: [] });
  });
});
