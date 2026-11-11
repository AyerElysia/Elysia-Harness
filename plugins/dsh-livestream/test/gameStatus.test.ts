import { describe, expect, it } from 'vitest';
import { gameStatusOf } from '../src/body/gameStatus';

describe('gameStatusOf', () => {
  it('reads what the body is doing, health and time of day from a moment summary', () => {
    const s = gameStatusOf('主世界 (-42, 11, 45) · 夜晚 · 血量 15.0/20 · 饥饿 16/20；身体正在：采集 diamond_ore ×3（39 秒了，到现在背包 +1 cobblestone）；背包：cobblestone×12；你在游戏线上刚说：「接着挖」');
    expect(s).toEqual({ doing: '采集 钻石矿 ×3', seconds: 39, health: 15, time: '夜晚' });
  });

  it('says nothing is being done when the body is idle', () => {
    expect(gameStatusOf('主世界 (1, 64, 2) · 白天 · 血量 20/20 · 饥饿 20/20')).toEqual({ doing: '', health: 20, time: '白天' });
  });

  it('keeps ids it has no name for', () => {
    expect(gameStatusOf('主世界 (0, 0, 0) · 白天；身体正在：走到 (10, 7, -25)（3 秒了）')?.doing).toBe('走到 (10, 7, -25)');
  });
});
