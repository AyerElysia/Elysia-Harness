/**
 * 游戏画面上那一行「她在干嘛」：从 dsh-game 的时刻摘要（agent.ts 的 momentSummary）里取身体在做的事、血量、白天黑夜。
 * 观众老问「你在干嘛」「它怎么不动了」：身体在后台采集、走路时画面上看着像站着，这一行把正在做的事写出来。
 */

import type { GameStatus } from '../stage/protocol';

/** 常见物品、方块、生物的中文名（时刻里写的是英文 id）；没有的照原样 */
const NAMES: Record<string, string> = {
  diamond_ore: '钻石矿', deepslate_diamond_ore: '深层钻石矿', diamond: '钻石', iron_ore: '铁矿', deepslate_iron_ore: '深层铁矿', raw_iron: '粗铁',
  iron_ingot: '铁锭', coal_ore: '煤矿', coal: '煤', gold_ore: '金矿', copper_ore: '铜矿', redstone_ore: '红石矿', lapis_ore: '青金石矿',
  cobblestone: '圆石', stone: '石头', cobbled_deepslate: '深板岩圆石', dirt: '泥土', sand: '沙子', gravel: '沙砾',
  oak_log: '橡木', spruce_log: '云杉木', birch_log: '白桦木', jungle_log: '丛林木', acacia_log: '金合欢木', dark_oak_log: '深色橡木', cherry_log: '樱花木',
  oak_planks: '橡木木板', spruce_planks: '云杉木板', stick: '木棍', crafting_table: '工作台', furnace: '熔炉', chest: '箱子', torch: '火把',
  wooden_pickaxe: '木镐', stone_pickaxe: '石镐', iron_pickaxe: '铁镐', diamond_pickaxe: '钻石镐',
  wooden_sword: '木剑', stone_sword: '石剑', iron_sword: '铁剑', diamond_sword: '钻石剑',
  diamond_helmet: '钻石头盔', diamond_chestplate: '钻石胸甲', diamond_leggings: '钻石护腿', diamond_boots: '钻石靴子',
  iron_helmet: '铁头盔', iron_chestplate: '铁胸甲', iron_leggings: '铁护腿', iron_boots: '铁靴子',
  white_bed: '白床', bed: '床', wheat: '小麦', bread: '面包', cooked_beef: '牛排', beef: '生牛肉', porkchop: '生猪排', glow_berries: '发光浆果',
  zombie: '僵尸', skeleton: '骷髅', creeper: '苦力怕', spider: '蜘蛛', cow: '牛', sheep: '羊', pig: '猪', chicken: '鸡', enderman: '末影人',
};

export function zhName(id: string): string {
  return NAMES[id] ?? id;
}

export function gameStatusOf(summary: string): GameStatus | null {
  if (!summary.trim()) return null;
  const health = /血量\s*([\d.]+)\s*\/\s*20/.exec(summary)?.[1];
  const time = /·\s*(白天|夜晚|黄昏|清晨|傍晚|午夜|日出|日落)/.exec(summary)?.[1];
  // 「身体正在：采集 diamond_ore ×3（39 秒了，到现在背包 +1 …）」
  const body = /身体正在：([^（；]+)(?:（(\d+)\s*秒)?/.exec(summary);
  const doing = body ? body[1].trim().replace(/[a-z][a-z0-9_]*/g, (id) => zhName(id)) : '';
  return {
    doing,
    ...(body?.[2] ? { seconds: Number(body[2]) } : {}),
    ...(health ? { health: Math.round(Number(health) * 10) / 10 } : {}),
    ...(time ? { time } : {}),
  };
}
