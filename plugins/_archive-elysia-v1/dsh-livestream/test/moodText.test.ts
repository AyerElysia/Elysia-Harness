import { describe, expect, it } from 'vitest';
import { splitByMood } from '../src/core/moodText';

const MOODS = ['talk', 'laugh', 'think', 'shy'];

describe('mood tags', () => {
  it('starts with the tagged mood', () => {
    expect(splitByMood('[laugh] 大家好呀', MOODS)).toEqual([{ mood: 'laugh', text: ' 大家好呀' }]);
  });
  it('changes mood mid-reply', () => {
    expect(splitByMood('【think】让我想想……[laugh]想到了！', MOODS)).toEqual([
      { mood: 'think', text: '让我想想……' },
      { mood: 'laugh', text: '想到了！' },
    ]);
  });
  it('keeps unknown tags in the text and talks without a tag', () => {
    expect(splitByMood('[dance] 跳一个', MOODS)).toEqual([{ mood: 'talk', text: '[dance] 跳一个' }]);
  });
});
