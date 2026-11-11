/**
 * 整屏特效：有人进场、关注、送礼、上舰时，在整个画布上放的动画（彩带、爱心、横幅……）。
 *
 * 直播间里的一件事，舞台分三层表现，三层都按 triggers.ts 的事件名配：
 * - 卡片（alerts 挂件）：每件事都有一张，告诉观众发生了什么；
 * - 特效（这里，effects 挂件）：按事件名挑着放，热闹一下；
 * - 角色反应（character.json 的 reactions）：她本人做个表情，走角色自己的动画片段（动画机）。
 *
 * 换特效：模板 template.json 写 effects，例如
 *   "effects": { "gift.huge": ["banner", { "name": "confetti", "count": 80 }], "follow": [] }
 * 不写就用下面的 DEFAULT_EFFECTS；写了就整个换掉默认的（没写的事件什么都不放）。
 *
 * 加特效，两种办法：
 * - 只写 CSS：名字不是内置的，就画成 <div class="ls-fx ls-fx-名字" data-user="观众名" data-text="礼物名、等级、留言…">
 *   里面 16 个 <i style="--i: 0…15; --n: 16">。在模板 style.css 里给 .ls-fx-名字 写动画；
 *   --ls-fx-ms 是这次放多久（spec 里的 ms，默认 3000）。
 * - 写代码：registerEffect('名字', { ms, exclusive, render })。
 *
 * 规则：一件事配的几个特效一起放、一起结束。占满画面的（exclusive，比如横幅）一次只放一件事的，
 * 其余排队，最多排 3 件，再多的直接丢掉；不占画面的（彩带、爱心）来了就放。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EffectSpec } from './protocol';
import { dropFx, type Fx } from './store';
import type { FxEvent } from './triggers';
import { pick } from './triggers';
import { ArtImg, Avatar, Sparks, scTier, useArt, useStage } from './widgets';

export interface EffectProps {
  event: FxEvent;
  /** 模板里写的参数（字符串写法就只有 name） */
  options: { name: string; [option: string]: unknown };
  ms: number;
}

export interface EffectDef {
  /** 默认放多久（毫秒），模板可以用 ms 改 */
  ms: number;
  /** 占满画面：一次只放一个，其余排队 */
  exclusive?: boolean;
  render: (props: EffectProps) => React.ReactNode;
}

const EFFECTS = new Map<string, EffectDef>();

export function registerEffect(name: string, def: EffectDef): void {
  EFFECTS.set(name, def);
}

export const DEFAULT_EFFECTS: Record<string, EffectSpec[]> = {
  enter: ['welcome'],
  'enter.guard': ['welcome', { name: 'confetti', count: 30 }],
  follow: ['hearts'],
  'gift.small': [{ name: 'hearts', count: 5 }],
  'gift.big': [{ name: 'confetti', count: 40 }],
  'gift.huge': ['banner', 'confetti'],
  superchat: ['glow'],
  'superchat.big': ['banner', 'glow'],
  membership: ['banner', { name: 'confetti', count: 90 }],
};

const CSS_ONLY_MS = 3000;
const MAX_QUEUE = 3;

/** 卡片、横幅上那句话：谁、干了什么 */
function describe(e: FxEvent): { title: string; detail: string } {
  switch (e.kind) {
    case 'gift': return { title: '感谢投喂', detail: `送出 ${e.gift} ×${e.count}` };
    case 'membership': return { title: '欢迎上船', detail: `开通了${e.level}${e.count > 1 ? ` ×${e.count}` : ''}` };
    case 'superchat': return { title: `醒目留言 ¥${e.yuan}`, detail: e.text };
    case 'follow': return { title: '感谢关注', detail: '关注了直播间' };
    case 'enter': return { title: '欢迎光临', detail: '进入直播间' };
  }
}

function dataText(e: FxEvent): string {
  return e.kind === 'gift' ? e.gift : e.kind === 'membership' ? e.level : e.kind === 'superchat' ? e.text : '';
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 每次放都不一样的随机数（同一次放的过程中不变） */
function useRandoms(n: number): number[][] {
  return useMemo(() => Array.from({ length: n }, () => Array.from({ length: 5 }, Math.random)), [n]);
}

type Vars = React.CSSProperties & Record<`--${string}`, string | number>;

// ── 内置特效 ─────────────────────────────────────────

/** 彩带从上面撒下来。count：多少片（默认 60） */
function Confetti({ options }: EffectProps) {
  const pieces = useRandoms(Math.min(200, num(options.count, 60)));
  return (
    <div className="ls-confetti">
      {pieces.map(([x, delay, speed, spin, color], i) => (
        <i key={i} style={{ '--x': `${x * 100}%`, '--d': `${delay * 0.7}s`, '--t': `${2.2 + speed * 1.4}s`, '--spin': `${(spin - 0.5) * 1440}deg`, '--c': `var(--ls-fx-c${Math.floor(color * 5)})` } as Vars} />
      ))}
    </div>
  );
}

/** 爱心从下面飘上去。count：几颗（默认 12）；x：从画布哪儿飘（百分比，默认 50） */
function Hearts({ options }: EffectProps) {
  const hearts = useRandoms(Math.min(60, num(options.count, 12)));
  const x = num(options.x, 50);
  return (
    <div className="ls-hearts">
      {hearts.map(([dx, delay, size, sway, color], i) => (
        <i key={i} style={{ '--x': `${x + (dx - 0.5) * 16}%`, '--d': `${delay * 1.2}s`, '--s': 0.6 + size * 0.9, '--sway': `${(sway - 0.5) * 120}px`, '--c': `var(--ls-fx-c${Math.floor(color * 5)})` } as Vars}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 21s-8.5-5-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 16 12 21 12 21Z" /></svg>
        </i>
      ))}
    </div>
  );
}

/** 画面中间的大横幅：她举着礼物、观众名、送了什么，后面转着光芒。art：用角色包哪张插画（默认 gift） */
function Banner({ event, options }: EffectProps) {
  const art = useArt(String(options.art ?? 'gift'));
  const { title, detail } = describe(event);
  return (
    <div className={`ls-banner ls-banner-${event.kind}`}>
      <i className="ls-banner-rays" />
      <div className="ls-banner-card">
        {art && <ArtImg className="ls-banner-art" src={art} />}
        <small>{title}</small>
        <div className="ls-banner-who"><Avatar user={event.user} /><b>{event.user.name}</b></div>
        <span>{detail}</span>
        <Sparks n={18} />
      </div>
    </div>
  );
}

/** 欢迎横条：从上面弹下来、停一下、往上收走，她在旁边蹦着挥手，光扫两遍。art 默认 wave；y：离画布顶多少像素（默认读主题变量 --ls-welcome-y，再没有是 130） */
function Welcome({ event, options }: EffectProps) {
  const art = useArt(String(options.art ?? 'wave'));
  const guard = event.user.guard ?? 0;
  const level = guard === 1 ? '总督' : guard === 2 ? '提督' : guard === 3 ? '舰长' : '';
  return (
    <div className="ls-welcome-wrap" style={options.y !== undefined ? ({ '--y': `${num(options.y, 130)}px` } as Vars) : undefined}>
      <div className={`ls-welcome${guard ? ` ls-welcome-guard ls-welcome-g${guard}` : ''}`}>
        <i className="ls-welcome-shine" />
        {art && <ArtImg className="ls-welcome-art" src={art} />}
        <span>欢迎{level && <em>{level}</em>}<b>{event.user.name}</b>进入直播间～</span>
        <Sparks n={14} />
      </div>
    </div>
  );
}

/** 画面四周亮一圈。color：颜色（默认醒目留言的档位色，别的事件用主题色） */
function Glow({ options }: EffectProps) {
  return <div className="ls-glow" style={options.color ? ({ '--ls-glow-c': String(options.color) } as Vars) : undefined} />;
}

registerEffect('confetti', { ms: 4200, render: (p) => <Confetti {...p} /> });
registerEffect('hearts', { ms: 3600, render: (p) => <Hearts {...p} /> });
registerEffect('banner', { ms: 4800, exclusive: true, render: (p) => <Banner {...p} /> });
registerEffect('welcome', { ms: 4000, render: (p) => <Welcome {...p} /> });
registerEffect('glow', { ms: 2800, render: (p) => <Glow {...p} /> });

// ── 挂件 ─────────────────────────────────────────────

interface Part {
  options: EffectProps['options'];
  def: EffectDef | undefined;
  ms: number;
}

/** 一件事要放的一组特效 */
interface Play {
  key: string;
  event: FxEvent;
  parts: Part[];
  ms: number;
  exclusive: boolean;
}

function toPlay(fx: Fx, specs: EffectSpec[]): Play | null {
  const parts = specs.map((spec): Part => {
    const options = typeof spec === 'string' ? { name: spec } : spec;
    const def = EFFECTS.get(options.name);
    return { options, def, ms: num(options.ms, def?.ms ?? CSS_ONLY_MS) };
  });
  if (parts.length === 0) return null;
  return { key: fx.key, event: fx.event, parts, ms: Math.max(...parts.map((p) => p.ms)), exclusive: parts.some((p) => p.def?.exclusive) };
}

export function Effects() {
  const { fx, template } = useStage();
  const [playing, setPlaying] = useState<Play[]>([]);
  const queue = useRef<Play[]>([]);
  const busy = useRef(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  const start = (play: Play) => {
    setPlaying((ps) => [...ps, play]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setPlaying((ps) => ps.filter((p) => p.key !== play.key));
      if (play.exclusive) {
        busy.current = false;
        const next = queue.current.shift();
        if (next) { busy.current = true; start(next); }
      }
    }, play.ms);
    timers.current.add(timer);
  };

  useEffect(() => {
    if (fx.length === 0) return;
    const config = template?.effects ?? DEFAULT_EFFECTS;
    for (const item of fx) {
      dropFx(item.key);
      const play = toPlay(item, pick(config, item.triggers) ?? []);
      if (!play) continue;
      if (!play.exclusive) start(play);
      else if (!busy.current) { busy.current = true; start(play); }
      else if (queue.current.length < MAX_QUEUE) queue.current.push(play);
    }
  }, [fx]);

  return (
    <div className="ls-effects">
      {playing.flatMap((play) => play.parts.map((part, i) => (
        <div
          key={`${play.key}-${i}`}
          className={`ls-fx ls-fx-${part.options.name} ls-fx-${play.event.kind}${play.event.kind === 'superchat' ? ` ls-sc-${scTier(play.event.yuan)}` : ''}`}
          style={{ '--ls-fx-ms': `${part.ms}ms` } as Vars}
          data-user={play.event.user.name}
          data-text={dataText(play.event)}
          data-yuan={'yuan' in play.event ? play.event.yuan : undefined}
        >
          {part.def ? part.def.render({ event: play.event, options: part.options, ms: part.ms }) : Array.from({ length: 16 }, (_, n) => <i key={n} style={{ '--i': n, '--n': 16 } as Vars} />)}
        </div>
      )))}
    </div>
  );
}
