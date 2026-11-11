/**
 * 同一个模板里换布局：平时是聊天布局，放视频时换成模板写的 video 布局，玩游戏时换成 game 布局（见 protocol.ts 的 layouts）。
 */

import type { LayoutPlacement, TemplateManifest, WidgetPlacement } from './protocol';

export type Mode = 'chat' | 'video' | 'game';

/** 聊天布局以外的布局 */
const SPECIAL: Array<Exclude<Mode, 'chat'>> = ['video', 'game'];

export interface Slot extends WidgetPlacement {
  key: string;
  scale?: number;
  hidden?: boolean;
}

/** 模板没写 video 布局：视频摆在画布中间偏上，别的挂件不动 */
function defaultVideoLayout(t: TemplateManifest): LayoutPlacement[] {
  const [cw, ch] = t.canvas;
  const w = Math.round(cw * 0.6);
  return [{ type: 'video', x: Math.round((cw - w) / 2), y: Math.round(ch * 0.08), w, h: Math.round((w * 9) / 16) }];
}

/** 一种布局里写的位置；game 没写就借 video 的，视频的位置给游戏画面 */
export function layoutOf(t: TemplateManifest, mode: Exclude<Mode, 'chat'>): LayoutPlacement[] {
  if (mode === 'video') return t.layouts?.video ?? defaultVideoLayout(t);
  return t.layouts?.game ?? layoutOf(t, 'video').map((l) => (l.type === 'video' ? { ...l, type: 'game' as const } : l));
}

/**
 * 这个布局下每个挂件摆哪：平时的布局，按 type 套上当前布局里写的位置。
 * 只在某个布局里有的挂件（视频画面、游戏画面）平时也摆着、藏起来：切换时挂件平滑挪动，新出现的淡入
 */
export function arrange(t: TemplateManifest, mode: Mode): Slot[] {
  const layouts = SPECIAL.map((m) => ({ mode: m, list: layoutOf(t, m), matched: new Set<number>() }));
  const slots: Slot[] = t.widgets.map((p, i) => {
    let placed: Slot = { ...p, key: `${p.type}-${i}` };
    for (const l of layouts) {
      const j = l.list.findIndex((x, k) => x.type === p.type && !l.matched.has(k));
      if (j < 0) continue;
      l.matched.add(j);
      if (l.mode === mode) placed = { ...placed, ...l.list[j] };
    }
    return placed;
  });
  for (const l of layouts) {
    l.list.forEach((x, k) => {
      if (!l.matched.has(k)) slots.push({ x: 0, y: 0, ...x, key: `${l.mode}-${x.type}-${k}`, hidden: mode !== l.mode || x.hidden });
    });
  }
  return slots;
}

/** 游戏画面在画布上的位置（OBS 把游戏窗口叠在这一块上） */
export function gameRect(t: TemplateManifest): { x: number; y: number; w: number; h: number } {
  const slot = arrange(t, 'game').find((s) => s.type === 'game');
  const [cw, ch] = t.canvas;
  return slot ? { x: slot.x, y: slot.y, w: slot.w ?? cw, h: slot.h ?? ch } : { x: 0, y: 0, w: cw, h: ch };
}
