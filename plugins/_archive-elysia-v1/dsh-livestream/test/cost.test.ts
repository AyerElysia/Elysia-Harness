import { describe, expect, it } from 'vitest';
import { isPeak, ttsYuan, turnYuan } from '../src/core/cost';

describe('cost', () => {
  it('knows DeepSeek peak hours in Beijing time', () => {
    expect(isPeak(Date.parse('2026-10-23T02:30:00Z'))).toBe(true); // 周五 10:30
    expect(isPeak(Date.parse('2026-10-23T05:00:00Z'))).toBe(false); // 周五 13:00
    expect(isPeak(Date.parse('2026-10-23T14:32:00Z'))).toBe(false); // 周五 22:32
    expect(isPeak(Date.parse('2026-10-24T02:30:00Z'))).toBe(false); // 周六
  });

  it('prices last night’s first 3 hours like the bill we worked out', () => {
    const night = Date.parse('2026-10-23T16:00:00Z');
    const yuan = turnYuan('deepseek-flash', { cacheReadTokens: 30_577_664, inputTokens: 139_606, outputTokens: 34_476 }, night)!;
    expect(yuan).toBeCloseTo(0.89, 2);
    expect(turnYuan('some-other-model', { inputTokens: 1 }, night)).toBeNull();
    expect(ttsYuan(14_644)).toBeCloseTo(4.39, 2);
  });
});
