/**
 * B 站视频：搜、看（详情和字幕）、取播放地址。用开播账号的 Cookie（实测 2026-10，大号）：
 *   搜视频     x/web-interface/wbi/search/type?search_type=video（WBI 签名）
 *   搜 UP 主   同上，search_type=bili_user
 *   UP 主投稿  x/series/recArchivesByKeywords（keywords 在他的投稿里筛）
 *   详情       x/web-interface/view；标签 x/tag/archive/tags
 *   字幕       x/player/wbi/v2 → subtitle_url（AI 字幕要登录才给）
 *   播放地址   x/player/wbi/playurl，platform=html5、fnval=1：一个完整的 720p MP4，CDN 支持 Range
 * 请求一个接一个发（同时发几个会被限流 412）。
 * B 站的分区认不出时政（外交部的剪辑在「娱乐粉丝创作」里），这里不判断，标签照给。
 */

import { inflateRawSync } from 'node:zlib';
import { createBiliSession, signWbi, type BiliSession } from '../core/platforms/bilibili/biliApi';
import { biliImageUrl } from './biliProfile';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
const SESSION_TTL_MS = 30 * 60_000;
/** 搜索结果给她看几条 */
const HITS = 8;

export type VideoOrder = 'relevance' | 'newest' | 'views';
const ORDER: Record<VideoOrder, string> = { relevance: 'totalrank', newest: 'pubdate', views: 'click' };
const ORDER_TEXT: Record<VideoOrder, string> = { relevance: '按相关度', newest: '按发布时间', views: '按播放量' };

export interface VideoHit {
  bvid: string;
  title: string;
  up: string;
  durationSec: number;
  views?: number;
  pubdate?: number;
  desc?: string;
  tags?: string[];
  category?: string;
  /** 封面图（B 站图床）：游戏里的 picture 能拿它做像素画 */
  cover?: string;
}

export interface VideoSearch {
  hits: VideoHit[];
  /** 只搜了这位 UP 主的投稿 */
  up?: { mid: string; name: string; others: Array<{ mid: string; name: string }> };
  /** up 填了但没找到这个人 */
  upMissing?: boolean;
}

export interface VideoPart {
  cid: number;
  page: number;
  title: string;
  durationSec: number;
}

export interface VideoInfo {
  bvid: string;
  /** av 号：评论区、点赞用它 */
  aid: number;
  title: string;
  up: { mid: string; name: string };
  pubdate: number;
  durationSec: number;
  stat: { views: number; likes: number; coins: number; favorites: number; danmaku: number; replies: number };
  desc: string;
  tags: string[];
  parts: VideoPart[];
}

export interface SubtitleLine {
  from: number;
  to: number;
  text: string;
}

export interface Subtitles {
  /** human：UP 主或观众做的字幕；ai：B 站语音识别的（可能有错字）；asr：没字幕，本机听写的（可能有错字） */
  kind: 'human' | 'ai' | 'asr';
  lang: string;
  lines: SubtitleLine[];
  /** asr：只听到这一秒，后面还没听 */
  until?: number;
  /** asr：听写用的模型（Whisper 的哪一个） */
  engine?: string;
}

/** 视频里的一条弹幕：at 是视频里的秒数 */
export interface VideoDanmaku {
  at: number;
  text: string;
}

export interface VideoRef {
  bvid?: string;
  aid?: number;
  /** 链接里带的分 P（?p=2） */
  part?: number;
}

/** BV 号、av 号、视频链接（b23.tv 短链要先 resolve） */
export function parseVideoRef(text: string): VideoRef | null {
  const part = Number(/[?&]p=(\d+)/.exec(text)?.[1]) || undefined;
  const bv = /BV[0-9A-Za-z]{10}/.exec(text)?.[0];
  if (bv) return { bvid: bv, ...(part ? { part } : {}) };
  const av = /(?:^|[^a-z])av(\d{1,20})/i.exec(text)?.[1];
  if (av) return { aid: Number(av), ...(part ? { part } : {}) };
  return null;
}

function clean(value: unknown, max = 400): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e] ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (_, e: string, code?: string) => (code ? String.fromCharCode(Number(code)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? ''));
}

/** 「3:24」「1:02:03」→ 秒 */
function clockSec(text: unknown): number {
  return String(text ?? '').split(':').reduce((sum, n) => sum * 60 + (Number(n) || 0), 0);
}

export class BiliVideos {
  private session: Promise<BiliSession> | null = null;
  private sessionAt = 0;
  private sessionCookie = '';
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly cookie: () => Promise<string>) {}

  private async auth(): Promise<BiliSession> {
    const cookie = await this.cookie();
    if (!this.session || cookie !== this.sessionCookie || Date.now() - this.sessionAt > SESSION_TTL_MS) {
      this.sessionCookie = cookie;
      this.sessionAt = Date.now();
      this.session = createBiliSession(cookie);
      this.session.catch(() => { this.session = null; });
    }
    return this.session;
  }

  /**
   * 一次一个：她同时调好几个工具时也排着队发。都带 Cookie：不要登录的接口不带 Cookie 时
   * 会随机被风控 412（实测 recArchivesByKeywords 同样的请求时好时坏，带上就一直正常）
   */
  private get<T>(url: string): Promise<{ code: number; message?: string; data?: T } | null> {
    const run = async () => {
      try {
        const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: (await this.auth()).cookie };
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return null;
        return (await res.json()) as { code: number; message?: string; data?: T };
      } catch {
        return null;
      }
    };
    const turn = this.tail.then(run, run);
    this.tail = turn;
    return turn;
  }

  private async signed(base: string, params: Record<string, string | number>): Promise<string> {
    return `${base}?${signWbi(params, (await this.auth()).mixinKey)}`;
  }

  async loggedIn(): Promise<boolean> {
    return (await this.auth().catch(() => null))?.loggedIn ?? false;
  }

  /** b23.tv 短链 → 真地址里的 BV 号 */
  async resolve(text: string): Promise<VideoRef | null> {
    const direct = parseVideoRef(text);
    if (direct) return direct;
    const short = /(?:https?:\/\/)?b23\.tv\/[\w-]+/.exec(text)?.[0];
    if (!short) return null;
    try {
      const res = await fetch(short.startsWith('http') ? short : `https://${short}`, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return parseVideoRef(res.headers.get('location') ?? '');
    } catch {
      return null;
    }
  }

  async search(query: string, options: { up?: string; order?: VideoOrder; page?: number } = {}): Promise<VideoSearch | null> {
    const page = Math.max(1, Math.floor(options.page ?? 1));
    if (options.up?.trim()) return this.searchUp(query, options.up.trim(), page);
    const body = await this.get<{ result?: any[] }>(await this.signed('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: query, page, order: ORDER[options.order ?? 'relevance'],
    }));
    if (body?.code !== 0) return null;
    const hits = (body.data?.result ?? []).filter((v) => v?.bvid).slice(0, HITS).map((v): VideoHit => ({
      bvid: v.bvid,
      title: clean(v.title, 80),
      up: clean(v.author, 30),
      durationSec: clockSec(v.duration),
      views: Number(v.play) || 0,
      ...(v.pubdate ? { pubdate: Number(v.pubdate) } : {}),
      ...(clean(v.description) && clean(v.description) !== '-' ? { desc: clean(v.description, 60) } : {}),
      tags: String(v.tag ?? '').split(',').map((t) => clean(t, 16)).filter(Boolean).slice(0, 6),
      ...(v.typename ? { category: clean(v.typename, 12) } : {}),
      ...(biliImageUrl(v.pic) ? { cover: biliImageUrl(v.pic) } : {}),
    }));
    return { hits };
  }

  /** 只在一位 UP 主的投稿里找：up 是名字（先搜这个人）或 UID */
  private async searchUp(query: string, up: string, page: number): Promise<VideoSearch | null> {
    let mid = /^\d{1,20}$/.test(up) ? up : '';
    let name = mid ? `UID ${mid}` : up;
    let others: Array<{ mid: string; name: string }> = [];
    if (!mid) {
      const users = await this.get<{ result?: any[] }>(await this.signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: up }));
      if (users?.code !== 0) return null;
      const found = (users.data?.result ?? []).map((u) => ({ mid: String(u.mid), name: clean(u.uname, 30) })).filter((u) => u.mid);
      if (!found.length) return { hits: [], upMissing: true };
      const exact = found.find((u) => u.name.toLowerCase() === up.toLowerCase()) ?? found[0];
      mid = exact.mid;
      name = exact.name;
      others = found.filter((u) => u !== exact).slice(0, 3);
    }
    const body = await this.get<{ archives?: any[] }>(
      `https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${mid}&keywords=${encodeURIComponent(query)}&ps=${HITS}&pn=${page}`);
    if (body?.code !== 0) return null;
    const hits = (body.data?.archives ?? []).filter((v) => v?.bvid).map((v): VideoHit => ({
      bvid: v.bvid,
      title: clean(v.title, 80),
      up: name,
      durationSec: Number(v.duration) || 0,
      views: Number(v.stat?.view) || 0,
      ...(v.pubdate ? { pubdate: Number(v.pubdate) } : {}),
      ...(biliImageUrl(v.pic) ? { cover: biliImageUrl(v.pic) } : {}),
    }));
    return { hits, up: { mid, name, others } };
  }

  async info(ref: VideoRef): Promise<VideoInfo | null> {
    const key = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
    const body = await this.get<any>(`https://api.bilibili.com/x/web-interface/view?${key}`);
    const d = body?.code === 0 ? body.data : null;
    if (!d?.bvid) return null;
    const tags = await this.get<Array<{ tag_name?: string }>>(`https://api.bilibili.com/x/tag/archive/tags?bvid=${d.bvid}`);
    return {
      bvid: d.bvid,
      aid: Number(d.aid) || 0,
      title: clean(d.title, 100),
      up: { mid: String(d.owner?.mid ?? ''), name: clean(d.owner?.name, 30) },
      pubdate: Number(d.pubdate) || 0,
      durationSec: Number(d.duration) || 0,
      stat: {
        views: Number(d.stat?.view) || 0, likes: Number(d.stat?.like) || 0, coins: Number(d.stat?.coin) || 0,
        favorites: Number(d.stat?.favorite) || 0, danmaku: Number(d.stat?.danmaku) || 0, replies: Number(d.stat?.reply) || 0,
      },
      desc: clean(d.desc, 300),
      tags: (tags?.code === 0 ? tags.data ?? [] : []).map((t) => clean(t.tag_name, 16)).filter(Boolean).slice(0, 10),
      parts: (d.pages ?? []).map((p: any) => ({ cid: Number(p.cid), page: Number(p.page), title: clean(p.part, 60), durationSec: Number(p.duration) || 0 })),
    };
  }

  /** 这一 P 的字幕：人做的中文 > AI 识别的原声 > 别的；没有返回 null */
  async subtitles(bvid: string, cid: number): Promise<Subtitles | null> {
    const body = await this.get<{ subtitle?: { subtitles?: Array<{ lan?: string; lan_doc?: string; ai_type?: number; subtitle_url?: string }> } }>(
      await this.signed('https://api.bilibili.com/x/player/wbi/v2', { bvid, cid }));
    const list = (body?.code === 0 ? body.data?.subtitle?.subtitles ?? [] : []).filter((s) => s.subtitle_url);
    const isAi = (s: { lan?: string }) => String(s.lan).startsWith('ai-');
    const pick = list.find((s) => !isAi(s) && /^zh/.test(String(s.lan)))
      ?? list.find((s) => !isAi(s))
      ?? list.find((s) => s.lan === 'ai-zh')
      // AI 字幕里 ai_type 0 是原声识别的，1 是翻译的
      ?? list.find((s) => s.ai_type === 0)
      ?? list[0];
    if (!pick?.subtitle_url) return null;
    try {
      const url = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url.replace(/^http:/, 'https:');
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const json = (await res.json()) as { body?: Array<{ from?: number; to?: number; content?: string }> };
      const lines = (json.body ?? []).map((l) => ({ from: Number(l.from) || 0, to: Number(l.to) || 0, text: clean(l.content, 200) })).filter((l) => l.text);
      return lines.length ? { kind: isAi(pick) ? 'ai' : 'human', lang: clean(pick.lan_doc, 12), lines } : null;
    } catch {
      return null;
    }
  }

  /** 一个完整 MP4 的地址（html5 播放器用的那种，最高 720p） */
  async playUrl(bvid: string, cid: number): Promise<string | null> {
    const body = await this.get<{ durl?: Array<{ url?: string; backup_url?: string[] | null }> }>(await this.signed('https://api.bilibili.com/x/player/wbi/playurl', {
      bvid, cid, qn: 64, fnval: 1, platform: 'html5', high_quality: 1,
    }));
    const d = body?.code === 0 ? body.data?.durl?.[0] : undefined;
    // 有的视频 B 站给了地址、CDN 上却没有网页版文件（404，2026-10 实测）：先探一下，主地址不通试备用的
    for (const url of [d?.url, ...(d?.backup_url ?? [])].filter((u): u is string => !!u)) {
      if (await this.reachable(url)) return url;
    }
    return null;
  }

  /** 这个视频地址真的能取到（取头两个字节） */
  private async reachable(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Range: 'bytes=0-1' }, signal: AbortSignal.timeout(8_000) });
      void res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 视频的弹幕（以前看过的人发的；B 站给的是抽样，热门视频几百到几千条），按视频里的时间排好 */
  async danmaku(cid: number): Promise<VideoDanmaku[]> {
    try {
      const res = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: (await this.auth()).cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const buf = Buffer.from(await res.arrayBuffer());
      let xml: string;
      try {
        xml = inflateRawSync(buf).toString('utf8');
      } catch {
        xml = buf.toString('utf8');
      }
      return [...xml.matchAll(/<d p="([\d.]+),[^"]*">([^<]*)<\/d>/g)]
        .map((m) => ({ at: Number(m[1]), text: clean(unescapeXml(m[2]), 40) }))
        // 只有标点、空格的不要
        .filter((d) => /[\p{L}\p{N}]/u.test(d.text))
        .sort((a, b) => a.at - b.at);
    } catch {
      return [];
    }
  }

  /** 只有声音的地址（DASH 里码率最低的那条，听写够用、读得快）和读它要带的请求头 */
  async audioUrl(bvid: string, cid: number): Promise<{ url: string; headers: string } | null> {
    const body = await this.get<{ dash?: { audio?: Array<{ bandwidth?: number; baseUrl?: string; base_url?: string }> } }>(await this.signed('https://api.bilibili.com/x/player/wbi/playurl', {
      bvid, cid, fnval: 16, fourk: 0,
    }));
    const audio = (body?.code === 0 ? body.data?.dash?.audio ?? [] : []).filter((a) => a.baseUrl || a.base_url);
    audio.sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0));
    const url = audio[0]?.baseUrl ?? audio[0]?.base_url ?? (await this.playUrl(bvid, cid));
    return url ? { url, headers: `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n` } : null;
  }
}

// ── 写给她看 ────────────────────────────────────────

export function count(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}万` : String(n);
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hms = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, '0')}:${String(hms[2]).padStart(2, '0')}` : `${hms[1]}:${String(hms[2]).padStart(2, '0')}`;
}

function date(sec?: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function searchText(query: string, result: VideoSearch, options: { up?: string; order?: VideoOrder; page?: number }): string {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  if (result.upMissing) return `没找到叫「${options.up}」的 UP 主。名字可能不对：去掉 up 直接搜「${[options.up, query].filter(Boolean).join(' ')}」试试。`;
  const where = result.up ? `在 ${result.up.name}（UID ${result.up.mid}）的投稿里找${query ? `「${query}」` : '最新的'}` : `搜「${query}」（${ORDER_TEXT[options.order ?? 'relevance']}）`;
  const lines = [`${where}，第 ${page} 页：`];
  if (result.up?.others.length) lines.push(`（同名或名字像的 UP 主还有：${result.up.others.map((u) => `${u.name}（UID ${u.mid}）`).join('、')}；不是这位的话 up 填 UID）`);
  if (!result.hits.length) {
    lines.push(page > 1 ? '这一页没有了。' : '一个也没搜到。');
  }
  result.hits.forEach((v, i) => {
    const meta = [result.up ? '' : `UP ${v.up}`, clock(v.durationSec), v.views !== undefined ? `${count(v.views)}播放` : '', date(v.pubdate)].filter(Boolean).join('，');
    lines.push(`${i + 1}. ${v.bvid}「${v.title}」${meta}`);
    const more = [v.category ? `分区 ${v.category}` : '', v.tags?.length ? `标签 ${v.tags.join('、')}` : '', v.desc ? `简介 ${v.desc}` : ''].filter(Boolean).join('；');
    if (more) lines.push(`   ${more}`);
    if (v.cover) lines.push(`   封面 ${v.cover}`);
  });
  lines.push('', '没有想要的：换个说法再搜；up 填 UP 主名字只搜他的投稿；order 换 newest（最新）或 views（播放最多）；page 翻页。');
  return lines.join('\n');
}

export function infoText(v: VideoInfo, part: VideoPart): string {
  const s = v.stat;
  const lines = [
    `「${v.title}」（${v.bvid}${v.parts.length > 1 ? `，P${part.page}/${v.parts.length}「${part.title}」` : ''}）`,
    `- UP 主：${v.up.name}（UID ${v.up.mid}）`,
    `- ${date(v.pubdate)}发布，时长 ${clock(part.durationSec)}`,
    `- 播放 ${count(s.views)}，点赞 ${count(s.likes)}，投币 ${count(s.coins)}，收藏 ${count(s.favorites)}，弹幕 ${count(s.danmaku)}，评论 ${count(s.replies)}`,
  ];
  if (v.tags.length) lines.push(`- 标签：${v.tags.join('、')}`);
  if (v.desc && v.desc !== '-') lines.push(`- 简介：<简介>${v.desc}</简介>`);
  if (v.parts.length > 1) {
    const shown = v.parts.slice(0, 12).map((p) => `P${p.page}「${p.title}」${clock(p.durationSec)}`).join('、');
    lines.push(`- 分 P：${shown}${v.parts.length > 12 ? ` 等 ${v.parts.length} 个` : ''}（part 填第几 P）`);
  }
  return lines.join('\n');
}

/** 每段字幕的开头标一次时间：大约这么多秒一段 */
const PARAGRAPH_SEC = 15;

/**
 * 从 fromSec 开始的一段字幕（不超过 maxChars 字）。next 是下一段从哪一秒开始（没有了为 null）
 */
export function subtitleChunk(sub: Subtitles, fromSec: number, maxChars = 3000): { text: string; startSec: number; endSec: number; next: number | null } {
  const lines = sub.lines.filter((l) => l.to > fromSec);
  const out: string[] = [];
  let used = 0;
  let paragraph: { at: number; words: string[] } | null = null;
  let endSec = fromSec;
  let next: number | null = null;
  const flush = () => {
    if (paragraph) out.push(`[${clock(paragraph.at)}] ${paragraph.words.join(' ')}`);
    paragraph = null;
  };
  for (const l of lines) {
    if (used + l.text.length > maxChars && used > 0) {
      next = Math.floor(l.from);
      break;
    }
    if (!paragraph || l.from - paragraph.at >= PARAGRAPH_SEC) {
      flush();
      paragraph = { at: l.from, words: [] };
    }
    paragraph.words.push(l.text);
    used += l.text.length + 1;
    endSec = l.to;
  }
  flush();
  return { text: out.join('\n'), startSec: lines[0]?.from ?? fromSec, endSec, next };
}

/** whisper 认出来的语言 */
const LANGS: Record<string, string> = { zh: '中文', yue: '粤语', en: '英文', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语' };

export function langName(code: string): string {
  return LANGS[code] ?? code;
}

export function subtitleText(v: VideoInfo, part: VideoPart, sub: Subtitles | null, fromSec: number, partArg: string): string {
  if (!sub) return '这个视频没有字幕：只知道标题、简介和标签，里面具体说了什么看不到。';
  const chunk = subtitleChunk(sub, fromSec);
  // 听写的只听了一段：这段完了、视频还没完，就接着听下一段
  const heardUntil = sub.kind === 'asr' && sub.until !== undefined && sub.until < part.durationSec ? sub.until : null;
  const next = chunk.next ?? heardUntil;
  const more = next !== null ? `后面还有：watch_video(video="${v.bvid}"${partArg}, from=${next}) 接着看。` : '字幕到这里完了。';
  if (!chunk.text && sub.kind === 'asr') {
    return `${clock(fromSec)}–${clock(sub.until ?? fromSec)} 这段视频没有字幕，Whisper 听了一遍也没听出有人说话（可能是音乐、游戏声或者没人说话，也可能是它没听出来）。\n${more}`;
  }
  if (!chunk.text) return `${clock(fromSec)} 以后没有字幕了（视频一共 ${clock(part.durationSec)}）。`;
  const kind = sub.kind === 'ai' ? `B 站官方 AI 识别的${sub.lang}字幕（B 站自己听写的，可能有错字）`
    : sub.kind === 'asr' ? `这个视频 B 站没有字幕（官方 AI 字幕也没有）。下面是主人给你装的语音识别 Whisper 听了一遍写下来的${langName(sub.lang)}，不是 B 站官方字幕：听错、写错的地方不少，人名和专有名词尤其容易错`
    : `${sub.lang}字幕`;
  return [
    `${kind}，${clock(chunk.startSec)}–${clock(chunk.endSec)}：`,
    '<字幕>',
    chunk.text,
    '</字幕>',
    more,
  ].join('\n');
}
