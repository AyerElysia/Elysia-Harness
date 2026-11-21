/**
 * 事件名：直播间里发生的事（进场、礼物……）叫什么。模板的特效（template.json 的 effects）和
 * 角色的反应（character.json 的 reactions）都按这套名字配，一个事件给出从具体到笼统的几个名字，
 * 配置里取第一个配了的：没配 'gift.huge' 就用 'gift'。
 *
 *   enter          有人进直播间          enter.guard     舰长、提督、总督进直播间
 *   follow         关注了直播间
 *   gift.small     礼物，不到 5 元       gift.big        5 到 100 元        gift.huge   100 元以上
 *   superchat      醒目留言              superchat.big   100 元以上的醒目留言
 *   membership     上舰（开通舰长、提督、总督）
 */

import type { StageLiveEvent } from './protocol';

/** 能触发特效的事件（弹幕不算：太多了） */
export type FxEvent = Exclude<StageLiveEvent, { kind: 'chat' }>;

export type GiftTier = 'small' | 'big' | 'huge';

/** 礼物按价钱分三档；卡片的样子和事件名都按这个分 */
export function giftTier(yuan: number): GiftTier {
  return yuan >= 100 ? 'huge' : yuan >= 5 ? 'big' : 'small';
}

/** 这个事件的名字，从具体到笼统 */
export function triggersOf(e: FxEvent): string[] {
  switch (e.kind) {
    case 'enter': return e.user.guard ? ['enter.guard', 'enter'] : ['enter'];
    case 'follow': return ['follow'];
    case 'gift': return [`gift.${giftTier(e.yuan)}`, 'gift'];
    case 'superchat': return e.yuan >= 100 ? ['superchat.big', 'superchat'] : ['superchat'];
    case 'membership': return ['membership'];
  }
}

/** 按名字从具体到笼统找，返回第一个配了的值（配成空数组也算配了：表示这个事件什么都不放） */
export function pick<T>(map: Record<string, T> | undefined, triggers: string[]): T | undefined {
  if (!map) return undefined;
  for (const t of triggers) if (Object.hasOwn(map, t)) return map[t];
  return undefined;
}
