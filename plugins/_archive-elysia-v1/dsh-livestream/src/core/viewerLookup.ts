/**
 * 她说「看看 xx 的主页」「私信 xx」时，xx 是哪位观众：在这场直播最近的事件里找。
 * 找不到、找到好几个都要告诉她怎么改：给出最像的几个名字（带 UID），让她照着再填一次。
 *
 *   1. 填的是 UID：这场里出现过的那位（没出现过的 UID 也认，标成 unseen，由调用的工具决定用不用）
 *   2. 名字完全一样（原样或清洗后）
 *   3. 名字的一部分：只有一位就是他；好几位就列出来让她挑
 *   4. 都没有：按字面相像列出最像的几位
 * 被平台打码的名字（匿名连接时的「小***」）找不到 UID；控制台模拟的观众没有真账号。
 */

import type { LiveEvent, LiveUser } from './live';
import { cleanName } from './safety';

export type ViewerLookup =
  | { kind: 'found'; uid: string; user: LiveUser; how: 'uid' | 'name' | 'partial' | 'unseen-uid' }
  | { kind: 'simulated'; name: string }
  | { kind: 'ambiguous'; candidates: Array<{ uid: string; name: string }> }
  | { kind: 'masked'; name: string }
  | { kind: 'missing'; suggestions: Array<{ uid: string; name: string }> };

export interface LookupOptions {
  /** 模拟观众的 uid 前缀 */
  simulatedPrefix: string;
}

const MAX_LISTED = 5;

function usable(user: LiveUser): boolean {
  return !!user.id && user.id !== '0' && !user.masked;
}

/** 两个名字有多像：共有的字占比（不看顺序），外加包含关系 */
function likeness(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const sa = new Set([...a.toLowerCase()]);
  const sb = new Set([...b.toLowerCase()]);
  let shared = 0;
  for (const ch of sa) if (sb.has(ch)) shared += 1;
  return shared / Math.max(sa.size, sb.size);
}

export function lookupViewer(who: string, events: readonly LiveEvent[], options: LookupOptions): ViewerLookup {
  const target = who.trim().replace(/^@/, '').trim();
  // 每位观众留最近的一次（同一个人改过名，以最新的为准）
  const viewers = new Map<string, LiveUser>();
  for (const e of [...events].reverse()) {
    const key = usable(e.user) ? e.user.id : `masked:${e.user.name}`;
    if (!viewers.has(key)) viewers.set(key, e.user);
  }
  const all = [...viewers.values()];
  const listed = (users: LiveUser[]) => users.filter(usable).slice(0, MAX_LISTED).map((u) => ({ uid: u.id, name: cleanName(u.name) }));
  const result = (user: LiveUser, how: 'uid' | 'name' | 'partial'): ViewerLookup => {
    if (user.id.startsWith(options.simulatedPrefix)) return { kind: 'simulated', name: user.name };
    if (!usable(user)) return { kind: 'masked', name: user.name };
    return { kind: 'found', uid: user.id, user, how };
  };
  if (!target) return { kind: 'missing', suggestions: listed(all) };

  const byUid = all.find((u) => u.id === target);
  if (byUid) return result(byUid, 'uid');

  const exact = all.filter((u) => u.name === target || cleanName(u.name) === target);
  if (exact.length === 1) return result(exact[0], 'name');
  if (exact.length > 1) return { kind: 'ambiguous', candidates: listed(exact) };

  const partial = all.filter((u) => {
    const name = cleanName(u.name);
    return name.includes(target) || (target.length >= 2 && target.includes(name) && name.length >= 2);
  });
  if (partial.length === 1) return result(partial[0], 'partial');
  if (partial.length > 1) return { kind: 'ambiguous', candidates: listed(partial) };

  // 直接给了 UID，但这场里没见过（主人让她看某个人）
  if (/^\d{1,20}$/.test(target)) return { kind: 'found', uid: target, user: { id: target, name: target }, how: 'unseen-uid' };

  const ranked = all
    .map((u) => ({ u, score: likeness(cleanName(u.name), target) }))
    .filter((r) => r.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.u);
  return { kind: 'missing', suggestions: listed(ranked) };
}

/** 没找到人时写给她看的话：为什么，以及怎么填才对 */
export function lookupProblem(who: string, lookup: Exclude<ViewerLookup, { kind: 'found' }>): string {
  const list = (items: Array<{ uid: string; name: string }>) => items.map((c) => `${c.name}（UID ${c.uid}）`).join('、');
  switch (lookup.kind) {
    case 'simulated':
      return `${lookup.name} 是主人在控制台里模拟的观众（彩排用），没有真的 B 站账号。`;
    case 'masked':
      return `「${lookup.name}」的名字被 B 站打了码（直播间没用登录账号连接），看不到他是谁，没法查。`;
    case 'ambiguous':
      return `「${who}」对得上好几位观众：${list(lookup.candidates)}。是哪一位？用他的 UID 再填一次。`;
    case 'missing':
      return lookup.suggestions.length
        ? `这场直播里没有叫「${who}」的观众。名字最像的是：${list(lookup.suggestions)}。如果是其中一位，用他的 UID 再填一次；名字要照消息里写的原样填。`
        : `这场直播里没有叫「${who}」的观众（也没有名字相像的）。名字要照消息里写的原样填，或者填 UID。`;
  }
}
