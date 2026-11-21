/**
 * 这场直播大概花了多少钱：模型按 DeepSeek 官方价（api-docs.deepseek.com 定价页，2026-10 查的），语音按豆包的价。
 * 只认得 deepseek-flash；别的模型只报 token，不报钱。
 */

/** 元 / 百万 token，高峰时段；空闲时段五折 */
const FLASH = { cacheHit: 0.04, miss: 2, output: 8 };
/** 豆包语音合成 2.0、声音复刻 2.0：元 / 万字 */
const TTS_YUAN_PER_10K_CHARS = 3;

/** 高峰时段：北京时间周一到周五 9–12 点、14–18 点（法定节假日也算空闲，这里不管） */
export function isPeak(ms: number): boolean {
  const beijing = new Date(ms + 8 * 3600_000);
  const day = beijing.getUTCDay();
  const h = beijing.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** 一次请求花了多少元；不认得的模型返回 null */
export function turnYuan(model: string | undefined, usage: TurnUsage, at: number): number | null {
  if (!model || !/flash/i.test(model)) return null;
  const k = isPeak(at) ? 1 : 0.5;
  return k * ((usage.cacheReadTokens ?? 0) * FLASH.cacheHit + (usage.inputTokens ?? 0) * FLASH.miss + (usage.outputTokens ?? 0) * FLASH.output) / 1e6;
}

export function ttsYuan(chars: number): number {
  return (chars / 10_000) * TTS_YUAN_PER_10K_CHARS;
}
