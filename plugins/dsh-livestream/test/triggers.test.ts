import { describe, expect, it } from 'vitest';
import { giftTier, pick, triggersOf } from '../src/stage/triggers';

const user = { id: 'u1', name: '晚风' };

describe('stage triggers', () => {
  it('names an event from specific to general', () => {
    expect(triggersOf({ kind: 'enter', id: 'e', user })).toEqual(['enter']);
    expect(triggersOf({ kind: 'enter', id: 'e', user: { ...user, guard: 3 } })).toEqual(['enter.guard', 'enter']);
    expect(triggersOf({ kind: 'gift', id: 'g', user, gift: '小花花', count: 5, yuan: 0.5 })).toEqual(['gift.small', 'gift']);
    expect(triggersOf({ kind: 'gift', id: 'g', user, gift: '嘉年华', count: 1, yuan: 500 })).toEqual(['gift.huge', 'gift']);
    expect(triggersOf({ kind: 'superchat', id: 's', user, text: '好', yuan: 30 })).toEqual(['superchat']);
    expect(triggersOf({ kind: 'superchat', id: 's', user, text: '好', yuan: 100 })).toEqual(['superchat.big', 'superchat']);
  });

  it('splits gifts at 5 and 100 yuan', () => {
    expect([4.9, 5, 99.9, 100].map(giftTier)).toEqual(['small', 'big', 'big', 'huge']);
  });

  it('picks the most specific configured name, and an empty list counts as configured', () => {
    const config = { gift: ['hearts'], 'gift.huge': ['banner'], 'enter.guard': [] as string[] };
    expect(pick(config, ['gift.huge', 'gift'])).toEqual(['banner']);
    expect(pick(config, ['gift.big', 'gift'])).toEqual(['hearts']);
    expect(pick(config, ['enter.guard', 'enter'])).toEqual([]);
    expect(pick(config, ['follow'])).toBeUndefined();
    expect(pick(undefined, ['gift'])).toBeUndefined();
  });
});
