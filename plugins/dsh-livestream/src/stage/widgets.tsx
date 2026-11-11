/**
 * 舞台挂件：每个只管一件事，只读 store 里的状态。样式类名（ls-*）和 CSS 变量就是模板能改的全部，
 * 模板的 style.css 可以盖掉这里的任何一条（见 stage/stage.css）。
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CharacterManifest, StageLiveEvent, StageOrder, StageUser } from './protocol';
import { assetUrl, dropAlert, energy, riceOf, getState, litChars, mediaUrl, preview, reportMedia, subscribe, type Alert, type ReplyItem, type StageState } from './store';
import { giftTier } from './triggers';

export function useStage(): StageState {
  return useSyncExternalStore(subscribe, getState);
}

/** 值变成空以后再留 ms 毫秒（给退场动画）：返回 [还显示的值, 是不是在退场] */
export function useLinger<T>(value: T | null, ms: number): [T | null, boolean] {
  const [kept, setKept] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) { setKept(value); return; }
    const timer = setTimeout(() => setKept(null), ms);
    return () => clearTimeout(timer);
  }, [value]);
  return value !== null ? [value, false] : [kept, kept !== null];
}

/** 角色包里的小插画（character.json 的 art）：没有返回 null，挂件就不画 */
export function useArt(name: string): string | null {
  const { character } = useStage();
  const file = character?.art?.[name];
  return character && file ? assetUrl('characters', character.id, file) : null;
}

/** 角色的小插画：图片，或者带透明通道的循环动图（.webm）；文件缺了就不画（不出现破图标） */
export function ArtImg({ src, className }: { src: string; className: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  if (/\.(webm|mp4)\?/.test(src)) return <video className={`${className} ls-anim`} src={src} autoPlay loop muted playsInline onError={() => setBroken(true)} />;
  return <img className={className} src={src} alt="" onError={() => setBroken(true)} />;
}

/** 角色身后的光和脚下的光圈：说话时亮起来，颜色跟表情走（data-mood） */
function Halo() {
  return (
    <>
      <div className="ls-aura" />
      <div className="ls-pedestal"><i /><i /><i /></div>
    </>
  );
}

// ── 角色 ─────────────────────────────────────────────

export function Character() {
  const { character } = useStage();
  if (!character) return null;
  if (character.renderer === 'clips' && character.clips) return <ClipCharacter character={character} />;
  if (character.renderer === 'image' && character.image) return <ImageCharacter character={character} />;
  return null;
}

/**
 * 动画片段渲染器：待机循环；说话时换「说话」循环；带表情的话有「边带表情边说话」的循环（talkMoods）就直接播它，
 * 没有就先播 out → 表情 → in 再接说话。
 * 队列里最后一个循环播，前面的播完一个出队一个。
 */
function ClipCharacter({ character }: { character: CharacterManifest }) {
  const clips = character.clips!;
  const { line: said, reaction } = useStage();
  // 嘉宾在说话时她不动嘴
  const line = said?.speaker ? null : said;
  const [queue, setQueue] = useState<string[]>([clips.idle]);
  const lineId = line?.id ?? null;

  // 对直播间里的事做个反应（角色包 reactions）：和说话时的表情走同一条路，最后回到待机；说着话就不打断
  useEffect(() => {
    const clip = reaction && !line ? clips.moods[reaction.mood] : undefined;
    if (clip) setQueue([...(clips.out ? [clips.out] : []), clip, ...(clips.in ? [clips.in] : []), clips.idle]);
  }, [reaction?.key]);

  useEffect(() => {
    if (!line) {
      // 说完了：说话循环换回待机（表情片段还在播就让它播完再接上）
      const talking = new Set([clips.talk, ...Object.values(clips.talkMoods ?? {})]);
      setQueue((q) => q.map((n) => (talking.has(n) ? clips.idle : n)));
      return;
    }
    const talkMood = clips.talkMoods?.[line.mood];
    if (talkMood) {
      setQueue([talkMood]);
      return;
    }
    const reaction = clips.moods[line.mood];
    setQueue(reaction
      ? [...(clips.out ? [clips.out] : []), reaction, ...(clips.in ? [clips.in] : []), clips.talk]
      : [clips.talk]);
  }, [lineId]);

  const next = () => setQueue((q) => (q.length > 1 ? q.slice(1) : q));
  const [graph, setGraph] = useState<ClipGraph | null>(null);
  useEffect(() => {
    if (!clips.graph) return;
    void fetch(assetUrl('characters', character.id, clips.graph)).then((r) => (r.ok ? r.json() : null)).then(setGraph).catch(() => {});
  }, [character.id, clips.graph]);
  const [w, h] = clips.size;
  return (
    <div className={`ls-character${line ? ' ls-speaking' : ''}`} data-mood={line?.mood || undefined} style={{ aspectRatio: `${w} / ${h}` }}>
      <Halo />
      <ClipPlayer src={(name) => assetUrl('characters', character.id, name)} name={queue[0]} loop={queue.length <= 1} onEnded={next} names={allClips(character)} graph={graph} />
    </div>
  );
}

function allClips(c: CharacterManifest): string[] {
  const clips = c.clips!;
  return [clips.idle, clips.talk, clips.out, clips.in, ...Object.values(clips.moods), ...Object.values(clips.talkMoods ?? {})].filter((n): n is string => !!n);
}

/** 片段先整段下载进内存，切换表情时不再等网络 */
const blobs = new Map<string, string>();
async function preload(urls: string[]): Promise<void> {
  for (const url of urls) {
    if (blobs.has(url)) continue;
    try {
      const res = await fetch(url);
      if (res.ok) blobs.set(url, URL.createObjectURL(await res.blob()));
    } catch {
      // 用到时走网络
    }
  }
}

/** 角色包的 transitions.json（tools/clip-graph.ts）：键是「旧片段>新片段」，值按旧片段当前帧查 */
interface ClipGraph {
  fps: number;
  /** 切到循环片段：从第几帧开播 */
  best: Record<string, number[]>;
  /** 切到要从头播的片段：再等几帧 */
  wait: Record<string, number[]>;
}

/**
 * 两个 <video> 轮流当前台：下一段先在后台开播，真的画出第一帧才换上来，旧的垫在下面——
 * 不会有一帧空白（照 dsh-game 的大肥鱼）。
 * 有转场表（graph）时挑最像的帧切、直接切再轻轻回弹；没有就新的淡入 0.18 秒
 */
function ClipPlayer({ src, name, loop, onEnded, names, graph }: { src: (name: string) => string; name: string; loop: boolean; onEnded: () => void; names: string[]; graph: ClipGraph | null }) {
  const box = useRef<HTMLDivElement>(null);
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);
  const shown = useRef<string | null>(null);
  const frontRef = useRef(0);
  /** 正在后台准备下一段的那个 <video>（还没换到前台）：撤「上一段」时别把它暂停了 */
  const loading = useRef<number | null>(null);
  const url = (n: string) => blobs.get(src(n)) ?? src(n);

  useEffect(() => { void preload(names.map(src)); }, [names.join('|')]);

  useEffect(() => {
    const videos = refs.map((r) => r.current!);
    const current = videos[frontRef.current];
    if (shown.current === null || shown.current === name) {
      if (shown.current === null) {
        shown.current = name;
        current.src = url(name);
        current.play().catch(() => {});
      }
      current.loop = loop;
      return;
    }
    const nextIndex = 1 - frontRef.current;
    const back = videos[nextIndex];
    let cancelled = false;
    // 旧片段现在播到第几帧：查表决定新片段从哪一帧开播、要不要再等几帧
    const key = `${shown.current}>${name}`;
    const frameOf = () => (graph ? Math.floor(current.currentTime * graph.fps) : 0);
    const pick = (table: number[] | undefined, ahead = 0) => {
      if (!table?.length) return undefined;
      const i = frameOf() + ahead;
      return table[current.loop ? i % table.length : Math.min(table.length - 1, i)];
    };
    const waitFrames = pick(graph?.wait[key]) ?? 0;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
    if (cancelled) return;
    loading.current = nextIndex;
    back.src = url(name);
    back.loop = loop;
    // 跳到中间那一帧要解码一小会儿（片段每 8 帧一个关键帧，见 tools/clip-graph.ts），这段时间旧片段还在往前走：按两帧以后查
    const start = pick(graph?.best[key], 2);
    if (start !== undefined && graph) back.currentTime = start / graph.fps;
    // 只换一次：play() 慢过兜底时间时定时器先换上来，之后真出帧的回调再来一次的话，
    // 会把「上一个」记成自己、150 毫秒后把正在前台的这段暂停（角色定住或消失）
    let revealed = false;
    const reveal = () => {
      if (cancelled || revealed) return;
      revealed = true;
      loading.current = null;
      shown.current = name;
      setPrev(frontRef.current);
      frontRef.current = nextIndex;
      setFront(nextIndex);
      // 直接切：整个角色轻轻挤一下再弹回来，切的那一下藏进动作里
      if (graph && box.current) { box.current.classList.remove('ls-pop'); void box.current.offsetWidth; box.current.classList.add('ls-pop'); }
    };
    // 兜底：play() 迟迟不回（或浏览器不支持出帧回调）时 0.6 秒后也换上；太早换会露出还没解码出来的空帧（看着像卡了一下）
    fallback = setTimeout(reveal, 600);
    back.play().then(() => {
      if ('requestVideoFrameCallback' in back) back.requestVideoFrameCallback(() => { clearTimeout(fallback); reveal(); });
      else { clearTimeout(fallback); reveal(); }
    }).catch(() => { clearTimeout(fallback); reveal(); });
    };
    // 要从头播的片段：等旧片段转到最像的那一帧再切（表里最多等零点几秒）
    const delay = graph && waitFrames > 0 ? setTimeout(go, (waitFrames / graph.fps) * 1000) : undefined;
    if (!delay) go();
    return () => { cancelled = true; clearTimeout(fallback); clearTimeout(delay); };
  }, [name, loop]);

  useEffect(() => {
    if (prev === null) return;
    const shownVideo = refs[front].current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    // 兜底换上来的那段可能还在解码（跳帧时尤其慢）：真有画面了才撤上一段，不然角色会整个消失
    const drop = () => {
      if (shownVideo && (shownVideo.seeking || shownVideo.readyState < 2)) { raf = requestAnimationFrame(drop); return; }
      // 等新的一段淡入完（0.18 秒）再撤掉上一段，不然中间会透一下；直接切的不用等。
      // 这期间又来了一次切换、正拿这个 <video> 准备下一段（或者它已经换回前台）时不能暂停：
      // OBS 里实测会把她定在一帧上，直到下次切换
      timer = setTimeout(() => {
        if (prev !== frontRef.current && loading.current !== prev) refs[prev].current?.pause();
        setPrev(null);
      }, graph ? 60 : 250);
    };
    drop();
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [prev]);

  // 自愈：前台那段被暂停了又没播完（不管什么原因），接着播。片段卡住时不用整页刷新
  useEffect(() => {
    const timer = setInterval(() => {
      const v = refs[frontRef.current].current;
      if (v && v.paused && !v.ended && v.currentSrc && loading.current === null) void v.play().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className={`ls-clips${graph ? ' ls-cut' : ''}`} ref={box}>
      {refs.map((ref, i) => (
        <video key={i} ref={ref} muted playsInline
          data-role={i === front ? 'front' : i === prev ? 'prev' : undefined}
          onEnded={() => { if (i === frontRef.current) onEnded(); }} />
      ))}
    </div>
  );
}

/** 立绘渲染器：一张图，说话时轻轻弹跳；有表情差分就换图 */
function ImageCharacter({ character }: { character: CharacterManifest }) {
  const image = character.image!;
  const { line: said, reaction } = useStage();
  // 嘉宾在说话时她不动嘴
  const line = said?.speaker ? null : said;
  const reacting = useReaction(reaction, 1800);
  const mood = line?.mood ?? reacting;
  const file = (mood && image.moods?.[mood]) || image.idle;
  const [w, h] = image.size;
  return (
    <div className={`ls-character${line ? ' ls-speaking' : ''}`} data-mood={mood || undefined} style={{ aspectRatio: `${w} / ${h}` }}>
      <Halo />
      <img className={`ls-image${line ? ' ls-talking' : ''}`} src={assetUrl('characters', character.id, file)} alt="" />
    </div>
  );
}

/** 立绘的反应：换上那张表情差分，ms 毫秒后换回来 */
function useReaction(reaction: StageState['reaction'], ms: number): string | null {
  const [mood, setMood] = useState<string | null>(null);
  useEffect(() => {
    if (!reaction) return;
    setMood(reaction.mood);
    const timer = setTimeout(() => setMood(null), ms);
    return () => clearTimeout(timer);
  }, [reaction?.key]);
  return mood;
}

// ── 小图标 ───────────────────────────────────────────

const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export function GiftIcon() {
  return <svg {...svg}><rect x="3.5" y="9" width="17" height="11.5" rx="2" /><path d="M2.5 9h19M12 9v11.5M12 9c-1.6-3.4-5.8-4.6-6.4-2.2C5 9 9.4 9 12 9Zm0 0c1.6-3.4 5.8-4.6 6.4-2.2C19 9 14.6 9 12 9Z" /></svg>;
}

export function ShipIcon() {
  return <svg {...svg}><path d="M12 2.5v9M12 3.5l5.5 6H12" /><path d="M3 14h18l-2.6 4.6a3 3 0 0 1-2.6 1.4H8.2a3 3 0 0 1-2.6-1.4Z" /><path d="M2 22.5c1.7 0 1.7-1 3.3-1s1.7 1 3.4 1 1.7-1 3.3-1 1.7 1 3.4 1 1.6-1 3.3-1 1.6 1 3.3 1" /></svg>;
}

export function HeartIcon() {
  return <svg {...svg}><path d="M12 20.5s-8-4.7-8-10.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 2.9c0 5.9-8 10.6-8 10.6Z" /></svg>;
}

function EyeIcon() {
  return <svg {...svg}><path d="M1.8 12S5.5 5 12 5s10.2 7 10.2 7-3.7 7-10.2 7S1.8 12 1.8 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

/** 声波：说话时跳的几根竖条（字幕名牌、「她在回」、弹幕上的「正在回你」都用它） */
function Voice() {
  return <i className="ls-voice"><b /><b /><b /><b /></i>;
}

/** 爆开的小光点 */
export function Sparks({ n = 12 }: { n?: number }) {
  return <i className="ls-sparks">{Array.from({ length: n }, (_, i) => <b key={i} style={{ '--i': i, '--n': n } as React.CSSProperties} />)}</i>;
}

// ── 字幕 ─────────────────────────────────────────────

/** 她正在说的话：念到哪亮到哪（按豆包给的逐字时间和音频的真实播放位置，不按字数估）；说完留一会儿再淡出 */
/** 字幕每句换一种颜色（模板用 --ls-sub-1 … --ls-sub-5 改） */
const SUB_COLORS = 5;
/** 名牌旁边跟着表情冒的小符号 */
const MOOD_MARK: Record<string, string> = { laugh: '♪', shy: '♡', angry: '!!', sad: '…', scared: '!?', shocked: '!', think: '?' };

function hashOf(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** 要强调的字：她点到的观众名、数字 */
function emphasis(chars: string[], names: string[]): Set<number> {
  const marks = new Set<number>();
  const text = chars.join('');
  for (const name of names) {
    if ([...name].length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(name, from);
      if (at < 0) break;
      const start = [...text.slice(0, at)].length;
      for (let i = 0; i < [...name].length; i++) marks.add(start + i);
      from = at + name.length;
    }
  }
  chars.forEach((c, i) => { if (/[0-9０-９]/.test(c)) marks.add(i); });
  return marks;
}

const STRONG_BREAK = /[。！？!?～~…]/;
const SOFT_BREAK = /[，、,；;：:）)」』]/;

/**
 * 把一句话分成几页显示（每页最多 max 个字，大约两行）：优先在句号、感叹号处断，其次逗号，实在没有就硬断。
 * 只是显示上的分页，逐字时间不变：念到下一页的第一个字就翻页，字号就可以大一些
 */
function paginate(chars: string[], max: number): Array<[number, number]> {
  const pages: Array<[number, number]> = [];
  let start = 0;
  while (start < chars.length) {
    if (chars.length - start <= max) { pages.push([start, chars.length]); break; }
    let cut = -1;
    for (const mark of [STRONG_BREAK, SOFT_BREAK]) {
      for (let i = start + max - 1; i >= start + Math.floor(max * 0.35); i--) {
        if (mark.test(chars[i])) { cut = i + 1; break; }
      }
      if (cut > 0) break;
    }
    if (cut < 0) cut = start + max;
    // 标点别落到下一页开头
    while (cut < chars.length && SOFT_BREAK.test(chars[cut]) || cut < chars.length && STRONG_BREAK.test(chars[cut])) cut += 1;
    pages.push([start, cut]);
    start = cut;
  }
  return pages;
}

/** 一句说完字幕还留多久（和字幕摆在同一块的终端也等这么久再出来） */
export const SUBTITLE_LINGER_MS = 2600;

export function Subtitle({ options }: { options?: Record<string, unknown> }) {
  const { line, character, reply } = useStage();
  const [shown, ended] = useLinger(line, SUBTITLE_LINGER_MS);
  const chars = useMemo(() => [...(shown?.text ?? '')], [shown?.text]);
  const [lit, setLit] = useState({ id: '', n: 0 });
  useEffect(() => {
    if (!line) return;
    let frame = 0;
    const tick = () => {
      const n = litChars(line, chars.length);
      setLit((l) => (l.id === line.id && l.n === n ? l : { id: line.id, n }));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [line?.id, line?.durationMs]);
  if (!shown) return <div className="ls-subtitle ls-empty" />;
  const upTo = ended ? chars.length : lit.id === shown.id ? lit.n : 0;
  // 她在回谁：像聊天软件的「回复」一样引用在字幕上方（options.quote: false 关掉，改用 reply 挂件）
  const quoted = options?.quote !== false && !ended ? reply[0] : undefined;
  const marks = emphasis(chars, reply.map((r) => r.event.user.name));
  const pages = paginate(chars, Number(options?.pageChars ?? 24));
  const at = Math.max(0, Math.min(chars.length, upTo) - 1);
  const page = Math.max(0, pages.findIndex(([a, b]) => at >= a && at < b));
  const [from, to] = pages[page] ?? [0, chars.length];
  const color = `var(--ls-sub-${(hashOf(shown.id) % SUB_COLORS) + 1})`;
  const mark = MOOD_MARK[shown.mood];
  return (
    <div className={`ls-subtitle${ended ? ' ls-ended' : ''}${quoted ? ' ls-quoting' : ''}`} key={shown.id} data-mood={shown.mood || undefined} style={{ '--ls-sub': color } as React.CSSProperties}>
      <span className="ls-speaker">{!ended && <Voice />}{shown.speaker ?? character?.name ?? ''}{mark && <i className="ls-mood-mark">{mark}</i>}</span>
      {quoted && (
        <div className="ls-quote" key={quoted.key}>
          <Avatar user={quoted.event.user} />
          <b>{quoted.event.user.name}{reply.length > 1 ? ` 等 ${reply.length} 人` : ''}</b>
          <span>{eventText(quoted.event)}</span>
        </div>
      )}
      {/* 念到的字一个个弹出来（还没念到的占着位置、不显示，气泡不会跟着变大） */}
      <p key={page}>{chars.slice(from, to).map((c, j) => {
        const i = from + j;
        return <span key={i} className={`${i < upTo ? 'ls-lit' : 'ls-dim'}${marks.has(i) ? ' ls-em' : ''}`} style={{ '--r': `${((hashOf(`${shown.id}${i}`) % 7) - 3) * 0.8}deg` } as React.CSSProperties}>{c}</span>;
      })}</p>
      {pages.length > 1 && <i className="ls-pages">{pages.map((_, k) => <b key={k} className={k === page ? 'ls-on' : undefined} />)}</i>}
    </div>
  );
}

// ── 弹幕 ─────────────────────────────────────────────

const GUARD = ['', '总督', '提督', '舰长'];

/** 粉丝牌按等级换色（照 B 站：越高越暖） */
function medalTier(level: number): number {
  return Math.min(6, Math.max(1, Math.ceil(level / 4)));
}

function Badge({ user }: { user: StageUser }) {
  return (
    <>
      {user.guard ? <span className={`ls-badge ls-guard-${user.guard}`}>{GUARD[user.guard]}</span> : null}
      {user.medal ? <span className={`ls-badge ls-medal ls-medal-t${medalTier(user.medal.level)}`}><span>{user.medal.name}</span><b>{user.medal.level}</b></span> : null}
      {user.admin ? <span className="ls-badge ls-admin">房管</span> : null}
    </>
  );
}

/** 没头像时用名字的第一个字，底色按名字换（一屏同一个颜色太单调） */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ user }: { user: StageUser }) {
  const [broken, setBroken] = useState(false);
  const guard = user.guard ? { 'data-guard': user.guard } : {};
  if (!user.face || broken) return <span className="ls-avatar ls-avatar-letter" {...guard} style={{ '--ls-hue': hue(user.name) } as React.CSSProperties}>{[...user.name][0] ?? '?'}</span>;
  return <img className="ls-avatar" {...guard} src={user.face} referrerPolicy="no-referrer" alt="" onError={() => setBroken(true)} />;
}

export function Chat({ options }: { options?: Record<string, unknown> }) {
  const { chats, focus } = useStage();
  const limit = Number(options?.rows ?? 12);
  const rows = chats.slice(-limit);
  const title = options?.title === undefined ? '弹幕' : options.title;
  return (
    <div className="ls-chat">
      {title !== false && <div className="ls-chat-head"><span>{String(title)}</span></div>}
      <div className="ls-chat-list">
        {rows.map((row) => {
          const { user } = row.event;
          const focused = focus.has(user.id);
          return (
            <div key={row.id} className={`ls-chat-row${focused ? ' ls-focused' : ''}${user.guard ? ` ls-row-guard ls-row-guard-${user.guard}` : ''}`}>
              <Avatar user={user} />
              <div className="ls-chat-body">
                <div className="ls-chat-name"><Badge user={user} /><span className="ls-name">{user.name}</span>{focused && <em className="ls-replying"><Voice />正在回你</em>}</div>
                {row.event.sticker ? <img className="ls-sticker" src={row.event.sticker} referrerPolicy="no-referrer" alt={row.event.text} /> : <div className="ls-chat-text">{row.event.text}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 游戏画面 ─────────────────────────────────────────

/**
 * 她在直播里玩的游戏的画面位。网页画面直接放在这里；游戏窗口（Minecraft 的摄像机客户端）由 OBS 抓来叠在这一块上，
 * 这里只留一个底（窗口还没出来时观众看到的就是这个）
 */
export function Game() {
  const { game, gameStatus, character } = useStage();
  const name = character?.name ?? '她';
  return (
    <div className={`ls-game${game && 'window' in game ? ' ls-game-window' : ''}`}>
      {game && 'url' in game
        ? <iframe className="ls-game-frame" src={game.url} title="游戏画面" allow="autoplay" />
        : <div className="ls-game-wait">{game ? '' : '游戏画面马上就来…'}</div>}
      {/* 观众老问「你在干嘛」：身体在后台采集、走路时画面上看着像站着 */}
      {game && gameStatus && (
        <div className="ls-game-status">
          <b>{name}</b>
          <span>{gameStatus.doing ? `正在${gameStatus.doing}${gameStatus.seconds ? `（${gameStatus.seconds} 秒）` : ''}` : '在想下一步'}</span>
          {gameStatus.time && <em>{gameStatus.time}</em>}
        </div>
      )}
    </div>
  );
}

// ── 告示板 ───────────────────────────────────────────

/**
 * 主人想让观众知道的（控制台里写）：空行分页，每页第一行是标题、后面一行一条。几页轮着放。
 * options：title（面板头上的字，默认「告示板」，false 不要）、seconds（每页停几秒，默认 12）
 */
export function Board({ options }: { options?: Record<string, unknown> }) {
  const { board } = useStage();
  const pages = useMemo(() => board.split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)).filter((p) => p.length), [board]);
  const [page, setPage] = useState(0);
  const seconds = Number(options?.seconds ?? 12);
  useEffect(() => {
    setPage(0);
    if (pages.length < 2) return;
    const timer = setInterval(() => setPage((p) => (p + 1) % pages.length), seconds * 1000);
    return () => clearInterval(timer);
  }, [pages, seconds]);
  if (!pages.length) return null;
  const [heading, ...items] = pages[page % pages.length];
  const title = options?.title === undefined ? '告示板' : options.title;
  return (
    <div className="ls-board">
      {title !== false && <div className="ls-board-head"><span>{String(title)}</span></div>}
      <div className="ls-board-page" key={`${page}-${board.length}`}>
        <div className="ls-board-title">{heading}</div>
        <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
      </div>
      {pages.length > 1 && <div className="ls-board-dots">{pages.map((_, i) => <i key={i} className={i === page % pages.length ? 'ls-on' : ''} />)}</div>}
    </div>
  );
}

// ── 点单栏 ───────────────────────────────────────────

const ORDER_MARK: Record<StageOrder['state'], string> = { doing: '在做', queued: '排队', done: '做好了', dropped: '不做了' };

/** 观众点的单：在做的、排着的，加最近做好的两条；没有单时教大家怎么点 */
export function Orders({ options }: { options?: Record<string, unknown> }) {
  const { orders } = useStage();
  const title = String(options?.title ?? '点单');
  const how = String(options?.how ?? '弹幕说「盖个……」「画我的头像」就排上');
  return (
    <div className="ls-board ls-orders">
      <div className="ls-board-head"><span>{title}</span></div>
      {orders.length ? (
        <ol>
          {orders.map((o) => (
            <li key={o.id} data-state={o.state}>
              <span>{o.text}</span>
              <small><b>{o.who}</b><em>{ORDER_MARK[o.state]}</em></small>
            </li>
          ))}
        </ol>
      ) : <div className="ls-orders-empty">{how}</div>}
    </div>
  );
}

// ── 她在回 ───────────────────────────────────────────

/** 一件事用一句话说（「她在回」卡片里） */
function eventText(e: StageLiveEvent): string {
  switch (e.kind) {
    case 'chat': case 'superchat': return e.text;
    case 'gift': return `送出 ${e.gift} ×${e.count}`;
    case 'membership': return `开通了${e.level}`;
    case 'follow': return '关注了直播间';
    case 'enter': return '进入直播间';
  }
}

function ReplyCard({ item, i }: { item: ReplyItem; i: number }) {
  const e = item.event;
  const said = e.kind === 'chat' || e.kind === 'superchat';
  return (
    <div className={`ls-reply-card ls-reply-${e.kind}${e.kind === 'superchat' ? ` ls-sc-${scTier(e.yuan)}` : ''}`} style={{ '--i': i } as React.CSSProperties}>
      <Avatar user={e.user} />
      <div className="ls-reply-body">
        <div className="ls-reply-name"><Badge user={e.user} /><span className="ls-name">{e.user.name}</span>{e.kind === 'superchat' && <b className="ls-reply-price">¥{e.yuan}</b>}</div>
        {e.kind === 'chat' && e.sticker
          ? <img className="ls-sticker" src={e.sticker} referrerPolicy="no-referrer" alt={e.text} />
          : <p className={said ? undefined : 'ls-reply-act'}>{eventText(e)}</p>}
      </div>
    </div>
  );
}

/** 她正在回应的那几位观众和他们说的话：热闹的时候那条弹幕早滚出弹幕列表了 */
export function Reply({ options }: { options?: Record<string, unknown> }) {
  const { reply, replySeq, character } = useStage();
  const current = useMemo(() => (reply.length ? { items: reply, seq: replySeq } : null), [reply, replySeq]);
  const [shown, leaving] = useLinger(current, 450);
  if (!shown) return null;
  const items = shown.items.slice(-Number(options?.max ?? 3));
  return (
    <div className={`ls-reply${leaving ? ' ls-leaving' : ''}`} key={shown.seq}>
      <div className="ls-reply-tag"><Voice />{character?.name ?? '她'}在回</div>
      {items.map((item, i) => <ReplyCard key={item.key} item={item} i={i} />)}
    </div>
  );
}

// ── 礼物、醒目留言、上舰、进场 ─────────────────────────

/** 醒目留言按金额分档（B 站的配色） */
export function scTier(yuan: number): string {
  if (yuan >= 2000) return 'red';
  if (yuan >= 1000) return 'orange';
  if (yuan >= 500) return 'pink';
  if (yuan >= 100) return 'yellow';
  if (yuan >= 50) return 'cyan';
  return 'blue';
}

/** 总督 1、提督 2、舰长 3（和 StageUser.guard 一样） */
function guardLevel(level: string): number {
  return level.includes('总督') ? 1 : level.includes('提督') ? 2 : 3;
}

function alertTtl(e: Alert['event']): number {
  switch (e.kind) {
    case 'superchat': return e.yuan >= 500 ? 20_000 : 12_000;
    case 'membership': return 9_000;
    case 'gift': return e.yuan >= 100 ? 9_000 : 6_000;
    case 'enter': return 3_500;
    default: return 6_000;
  }
}

function AlertCard({ alert }: { alert: Alert }) {
  const e = alert.event;
  const giftArt = useArt('gift');
  const waveArt = useArt('wave');
  const ttl = alertTtl(e);
  const [leaving, setLeaving] = useState(false);
  // 礼物连击：数量一变就重新计时
  const combo = e.kind === 'gift' ? e.count : 0;
  useEffect(() => {
    setLeaving(false);
    const out = setTimeout(() => setLeaving(true), ttl - 400);
    const timer = setTimeout(() => dropAlert(alert.key), ttl);
    return () => { clearTimeout(out); clearTimeout(timer); };
  }, [alert.key, combo]);
  const out = leaving ? ' ls-out' : '';
  switch (e.kind) {
    case 'superchat':
      return (
        <div className={`ls-alert ls-sc ls-sc-${scTier(e.yuan)}${out}`} style={{ '--ls-ttl': `${ttl}ms` } as React.CSSProperties}>
          <div className="ls-sc-head">
            <Avatar user={e.user} />
            <div className="ls-sc-who"><span>{e.user.name}</span><small>醒目留言</small></div>
            <b className="ls-sc-price">¥{e.yuan}</b>
          </div>
          <div className="ls-sc-text">{e.text}</div>
          <i className="ls-timer" />
        </div>
      );
    case 'gift': {
      // 小（一行带过）、大（金边、光点、举着礼物的她）、超大（再加光芒）
      const size = giftTier(e.yuan);
      return (
        <div className={`ls-alert ls-gift ls-gift-${size}${size !== 'small' ? ' ls-big' : ''}${out}`}>
          {size === 'huge' && <i className="ls-rays" />}
          <Avatar user={e.user} />
          <div className="ls-gift-text"><b>{e.user.name}</b><span>送出 <strong>{e.gift}</strong></span></div>
          <span className="ls-gift-icon"><GiftIcon /></span>
          <em className="ls-combo" key={e.count}>×{e.count}</em>
          {size !== 'small' && giftArt && <ArtImg className="ls-alert-art" src={giftArt} />}
          {size !== 'small' && <Sparks key={`s${e.count}`} />}
        </div>
      );
    }
    case 'membership':
      return (
        <div className={`ls-alert ls-guard ls-big ls-guard-lv${guardLevel(e.level)}${out}`}>
          <i className="ls-rays" />
          <span className="ls-guard-ship"><ShipIcon /></span>
          <div className="ls-guard-text">
            <small>欢迎上船</small>
            <b>{e.user.name}</b>
            <span>开通了{e.level}{e.count > 1 ? ` ×${e.count}` : ''}</span>
          </div>
          <Avatar user={e.user} />
          {giftArt && <ArtImg className="ls-alert-art" src={giftArt} />}
          <Sparks n={16} />
        </div>
      );
    case 'follow':
      return <div className={`ls-alert ls-follow${out}`}><span className="ls-follow-icon"><HeartIcon /></span><span><b>{e.user.name}</b> 关注了直播间</span></div>;
    case 'enter':
      // 欢迎卡：从右边滑进来，她探出头挥挥手
      return (
        <div className={`ls-alert ls-enter${e.user.guard ? ` ls-enter-guard ls-enter-guard-${e.user.guard}` : ''}${waveArt ? ' ls-has-art' : ''}${out}`}>
          {waveArt && <ArtImg className="ls-enter-art" src={waveArt} />}
          {e.user.guard ? <Badge user={e.user} /> : null}
          <span>欢迎 <b>{e.user.name}</b> 进入直播间</span>
        </div>
      );
  }
}

export function Alerts({ options }: { options?: Record<string, unknown> }) {
  const { alerts } = useStage();
  // 进场太多：只显示最近一条
  const shown = useMemo(() => {
    const enters = alerts.filter((a) => a.event.kind === 'enter');
    const rest = alerts.filter((a) => a.event.kind !== 'enter');
    return [...rest, ...enters.slice(-1)].slice(-Number(options?.max ?? 4));
  }, [alerts]);
  return <div className="ls-alerts">{shown.map((a) => <AlertCard key={a.key} alert={a} />)}</div>;
}

// ── 状态 ─────────────────────────────────────────────

const BRAIN_TEXT = { off: '', listening: '在听弹幕', thinking: '正在想…', speaking: '在说话', away: '暂时走开了' } as const;

/** options.room：最前面加一块「××的直播间」名牌 */
export function Status({ options }: { options?: Record<string, unknown> }) {
  const { brain, brainDetail, online, onAir, character, connected, line } = useStage();
  // 嘉宾在说话：写嘉宾，不写她
  const guest = line?.speaker;
  return (
    <div className={`ls-status ls-brain-${brain}`}>
      {options?.room ? <span className="ls-room">{typeof options.room === 'string' ? options.room : `${character?.name ?? ''}的直播间`}</span> : null}
      <span className={`ls-live${onAir ? ' ls-on' : ''}`}><i />{onAir ? 'LIVE' : '准备中'}</span>
      {online !== undefined && <span className="ls-online"><EyeIcon />{online}<small>人在看</small></span>}
      {guest ? <span className="ls-brain ls-brain-guest" key="guest"><i className="ls-brain-icon"><b /><b /><b /></i>{guest}在说话</span>
        : brain !== 'off' && <span className="ls-brain" key={brain}><i className="ls-brain-icon"><b /><b /><b /></i>{character?.name ?? ''}{brain === 'thinking' && brainDetail ? brainDetail : BRAIN_TEXT[brain]}</span>}
      {!connected && <span className="ls-offline">舞台没连上</span>}
    </div>
  );
}

export function AiLabel({ options }: { options?: Record<string, unknown> }) {
  return <div className="ls-ai-label"><i />{String(options?.text ?? 'AI 主播 · 内容由人工智能生成')}</div>;
}

// ── 吃饭计数 ─────────────────────────────────────────


export function Rice({ options }: { options?: Record<string, unknown> }) {
  const { tokens } = useStage();
  const art = useArt('rice');
  const { joules, perBowl, grains, grainsOf } = riceOf(tokens, options);
  const bowls = Math.floor(grains / perBowl);
  const prev = useRef(tokens);
  const added = tokens - prev.current;
  useEffect(() => { prev.current = tokens; }, [tokens]);
  return (
    <div className="ls-rice">
      {art && <ArtImg className="ls-rice-art" src={art} />}
      <div className="ls-rice-body">
        <div className="ls-rice-label">今天吃了</div>
        <div className="ls-rice-count"><b key={grains}>{grains.toLocaleString()}</b><span>粒米</span>{added > 0 && <em key={tokens}>+{Math.max(1, grainsOf(added))}</em>}</div>
        <div className="ls-rice-bowl" title={`第 ${bowls + 1} 碗`}><i style={{ width: `${((grains % perBowl) / perBowl) * 100}%` }} /><span>第 {bowls + 1} 碗</span></div>
        <div className="ls-rice-note">{tokens.toLocaleString()} token ≈ {energy(joules)}电</div>
      </div>
    </div>
  );
}

// ── 终端 ─────────────────────────────────────────────

const TERM_TAG: Record<string, string> = { live: '直播', push: '推给她', say: '她说', guest: '嘉宾', tool: '调用', token: '饭量', gift: '礼物', sc: '留言', warn: '注意', listen: '听写' };

function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 终端：身体推了什么给她、她说了什么、用了多少 token——观众看得见 AI 在干活 */
export function Terminal({ options }: { options?: Record<string, unknown> }) {
  const { term, brain, brainDetail, character } = useStage();
  const art = useArt('laptop');
  const rows = term.slice(-Number(options?.rows ?? 9));
  const title = String(options?.title ?? `${character?.id ?? 'her'}@live`);
  return (
    <div className={`ls-term ls-term-${brain}`}>
      {art && <ArtImg className="ls-term-art" src={art} />}
      <div className="ls-term-bar"><i /><i /><i /><span>{title}</span></div>
      <div className="ls-term-lines">
        {rows.map((l) => (
          <div key={l.id} className={`ls-term-line ls-tag-${l.tag}`}>
            <time>{clock(l.at)}</time><b>{TERM_TAG[l.tag] ?? l.tag}</b><span>{l.text}</span>
          </div>
        ))}
        <div className={`ls-term-prompt ls-brain-${brain}`}>
          <b>$</b>{brain === 'thinking' ? <span className="ls-term-busy">{brainDetail || '思考中'}<i /><i /><i /></span> : brain === 'speaking' ? <span>说话中…</span> : <span className="ls-term-caret" />}
        </div>
      </div>
    </div>
  );
}

// ── 过场：开播前、开场、谢幕 ─────────────────────────

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

function useClock(): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  return clock(now).slice(0, 5);
}

function Waiting() {
  const { character, online } = useStage();
  const bg = useArt('waiting');
  const sticker = useArt('sleep');
  const time = useClock();
  const name = character?.name ?? '她';
  return (
    <div className="ls-scene ls-scene-waiting">
      {bg && <ArtImg className="ls-scene-bg" src={bg} />}
      <div className="ls-wait-card">
        {sticker && <ArtImg className="ls-wait-art" src={sticker} />}
        <div className="ls-wait-room">{name}的直播间</div>
        <div className="ls-wait-title">直播马上开始<i /><i /><i /></div>
        <div className="ls-wait-hint">弹幕里叫「{name}」，她会回你哦</div>
        <div className="ls-wait-meta"><span>{time}</span>{online ? <span>{online} 人在等</span> : null}</div>
      </div>
    </div>
  );
}

/** 直播中插件在更新：观众看到的是「更新中」，不是「马上开始」（直播没断，等一下就回来） */
function Updating() {
  const { character } = useStage();
  // 角色包里没有更新专用的画（art.updating）就借等待画面的；小人借敲电脑的那张
  const [updating, waiting, updatingSticker, laptop] = [useArt('updating'), useArt('waiting'), useArt('updating-sticker'), useArt('laptop')];
  const bg = updating ?? waiting;
  const sticker = updatingSticker ?? laptop;
  const name = character?.name ?? '她';
  return (
    <div className="ls-scene ls-scene-updating">
      {bg && <ArtImg className="ls-scene-bg" src={bg} />}
      <div className="ls-wait-card">
        {sticker && <ArtImg className="ls-wait-art ls-update-art" src={sticker} />}
        <div className="ls-wait-room">{name}的直播间</div>
        <div className="ls-wait-title">{name}在升级<i /><i /><i /></div>
        <div className="ls-wait-hint">主人在给她装新功能，直播没断，一会儿就回来</div>
      </div>
    </div>
  );
}

function Opening() {
  const { character } = useStage();
  const kv = useArt('kv');
  const name = character?.name ?? '';
  return (
    <div className="ls-scene ls-scene-opening">
      <i className="ls-wipe ls-wipe-1" /><i className="ls-wipe ls-wipe-2" /><i className="ls-wipe ls-wipe-3" />
      <div className="ls-open-stage">
        {kv && <ArtImg className="ls-open-kv" src={kv} />}
        <div className="ls-open-title">
          <b>{[...name].map((c, i) => <span key={i} style={{ '--i': i } as React.CSSProperties}>{c}</span>)}</b>
          <small>LIVE START</small>
        </div>
        <Sparks n={18} />
      </div>
    </div>
  );
}

function Ending() {
  const { character, stats, tokens } = useStage();
  const bg = useArt('ending');
  const sticker = useArt('wave');
  const name = character?.name ?? '她';
  const { grains } = riceOf(tokens);
  const names = stats.supporters.slice(0, 18);
  return (
    <div className="ls-scene ls-scene-ending">
      {bg && <ArtImg className="ls-scene-bg" src={bg} />}
      <div className="ls-end-card">
        <div className="ls-end-title">今天的直播结束啦</div>
        <div className="ls-end-sub">谢谢大家陪{name}，下次见～</div>
        <div className="ls-end-stats">
          <div><b>{duration(Date.now() - stats.startedAt)}</b><span>播了</span></div>
          <div><b>{stats.chats}</b><span>条弹幕</span></div>
          <div><b>{stats.viewers}</b><span>位观众</span></div>
          <div><b>{grains}</b><span>粒米饭</span></div>
        </div>
        {names.length ? (
          <div className="ls-end-thanks">
            <span>特别感谢</span>
            <div className="ls-end-names">{names.map((s, i) => <em key={s.name} style={{ '--i': i } as React.CSSProperties}>{s.name}</em>)}</div>
          </div>
        ) : null}
      </div>
      {sticker && <ArtImg className="ls-end-art" src={sticker} />}
    </div>
  );
}

/** 画面最底下的滚动通知：主人在控制台写，出状况时告诉观众（卡了、在修、马上回来） */
export function Notice() {
  const { notice } = useStage();
  if (!notice) return null;
  // 字越多滚得越久：每个字大约 0.28 秒，最少 12 秒一轮
  const seconds = Math.max(12, [...notice].length * 0.28 + 8);
  return (
    <div className="ls-notice">
      <b>通知</b>
      <div className="ls-notice-track"><span key={notice} style={{ animationDuration: `${seconds}s` }}>{notice}</span></div>
    </div>
  );
}

/** 整屏的过场（模板把它放在 0,0、和画布一样大，盖在最上面） */
export function Scene() {
  const { phase } = useStage();
  // 「更新中」只在插件断了的时候出现，那时候图已经取不到了：平时先把它的图取进浏览器缓存
  const updatingArt = useArt('updating');
  // 控制台里的小预览不盖等待画面：主人没开播时也要看得到这个主题开播后的样子（OBS 里照常是等待画面）
  const hidden = phase === 'live' || (preview && phase === 'waiting');
  const [shown, leaving] = useLinger(hidden ? null : phase, 700);
  return (
    <>
      {updatingArt && <img src={updatingArt} alt="" hidden />}
      {shown && (
        <div className={`ls-scenes${leaving ? ' ls-scene-out' : ''}`} key={shown}>
          {shown === 'waiting' ? <Waiting /> : shown === 'opening' ? <Opening /> : shown === 'updating' ? <Updating /> : <Ending />}
        </div>
      )}
    </>
  );
}

// ── 放视频 ─────────────────────────────────────────

/** 中途连上的舞台：身体开始放已经过去这么久以上，就跳到现在该放到的地方 */
const CATCHUP_SEC = 3;

/**
 * 她在放的视频（只出现在模板的 video 布局里）。她说话时声音调小，放到 until 秒或放完回执给身体。
 * options：duck（她说话时的音量，默认 0.25）、caption（顶上写片名，默认开）
 */
export function Video({ options }: { options?: Record<string, unknown> }) {
  const { media, line } = useStage();
  const ref = useRef<HTMLVideoElement>(null);
  const speaking = !!line;

  useEffect(() => {
    const video = ref.current;
    if (!video || !media) return;
    let done = false;
    let started = false;
    const finish = (state: 'ended' | 'error', detail?: string) => {
      if (done) return;
      done = true;
      video.pause();
      reportMedia(media.id, state, undefined, detail);
    };
    const elapsed = (Date.now() - media.at) / 1000;
    const start = media.from + (elapsed > CATCHUP_SEC ? elapsed : 0);
    if (start >= media.until) return;
    const onMeta = () => {
      video.currentTime = start;
      // 普通浏览器标签页没交互过不让出声：先静音放着（OBS 的浏览器源可以出声）
      void video.play().catch(() => {
        video.muted = true;
        void video.play().catch((err: Error) => finish('error', `play() ${err.name}: ${err.message}`));
      });
    };
    const onPlaying = () => {
      if (started) return;
      started = true;
      reportMedia(media.id, 'playing', video.currentTime);
    };
    const onTime = () => { if (video.currentTime >= media.until) finish('ended'); };
    const onEnded = () => finish('ended');
    // MediaError：1 中止、2 网络、3 解码、4 格式不支持或地址打不开
    const onError = () => finish('error', `MediaError ${video.error?.code}: ${video.error?.message ?? ''}`);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.muted = preview;
    video.src = mediaUrl(media.src);
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [media?.id]);

  // 她说话时把视频声音慢慢压下去，说完慢慢回来。用定时器不用 requestAnimationFrame：页面不在前台时那个会停，音量就卡在半路
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const target = speaking ? Number(options?.duck ?? 0.25) : 1;
    const timer = setInterval(() => {
      const next = video.volume + (target - video.volume) * 0.18;
      video.volume = Math.abs(target - next) < 0.01 ? target : next;
      if (video.volume === target) clearInterval(timer);
    }, 30);
    return () => clearInterval(timer);
  }, [speaking, media?.id]);

  return (
    <div className={`ls-video${media ? '' : ' ls-empty'}`}>
      <video ref={ref} playsInline preload="auto" />
      {media && options?.caption !== false && (
        <div className="ls-video-caption"><b>{media.title}</b><span>{media.up}</span></div>
      )}
    </div>
  );
}
