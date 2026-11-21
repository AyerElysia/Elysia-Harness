/**
 * 看一位 B 站用户的主页：只用不要登录、不要 WBI 签名的公开接口（实测 2026-10）。
 *   名片       x/web-interface/card          名字、等级、签名、粉丝、关注、投稿数、认证、大会员
 *   最近投稿   x/series/recArchivesByKeywords（keywords 留空 = 最新的几条，带播放量）
 *   置顶视频   x/space/top/arc
 *   代表作     x/space/masterpiece
 *   空间公告   x/space/notice
 *   直播间     room/v1/Room/getRoomInfoOld
 * 带 WBI 签名的主页接口（acc/info、arc/search）会被风控（-352），要伪造浏览器指纹才能过，不用。
 * 这些接口不登录也能用，但不带 Cookie 时会随机被风控（412，实测 recArchivesByKeywords 时好时坏）：有开播账号的 Cookie 就带上。
 */

import { cleanText } from '../core/safety';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface ProfileVideo {
  title: string;
  bvid: string;
  views?: number;
  pubdate?: number;
}

export interface BiliProfile {
  uid: string;
  name: string;
  level: number;
  sex: string;
  sign: string;
  fans: number;
  following: number;
  videos: number;
  /** 认证（UP 主认证、机构认证）的说明 */
  official: string;
  vip: boolean;
  recent: ProfileVideo[];
  pinned: ProfileVideo | null;
  masterpieces: ProfileVideo[];
  notice: string;
  /** 有直播间：房间号、在不在播、标题 */
  live: { roomId: number; onAir: boolean; title: string } | null;
  /** 头像图片的网址（B 站图床上的，没有就空） */
  face?: string;
}

async function get<T>(url: string, uid: string, cookie: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: `https://space.bilibili.com/${uid}`, Origin: 'https://space.bilibili.com', ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { code: number; data?: T };
    return body.code === 0 ? body.data ?? null : null;
  } catch {
    return null;
  }
}

interface RawVideo { title?: string; bvid?: string; stat?: { view?: number }; pubdate?: number }

function video(v: RawVideo | null | undefined): ProfileVideo | null {
  if (!v?.title) return null;
  return { title: cleanText(v.title), bvid: v.bvid ?? '', ...(v.stat?.view !== undefined ? { views: v.stat.view } : {}), ...(v.pubdate ? { pubdate: v.pubdate } : {}) };
}

/** 拉一位用户的主页；用户不存在（或接口全都失败）返回 null。cookie：开播账号的（可以不给） */
export async function fetchProfile(uid: string, cookie = ''): Promise<BiliProfile | null> {
  if (!/^\d{1,20}$/.test(uid)) return null;
  // 一个一个请求：同时发六个会被 B 站限流（412），总共也就一两秒
  const card = await get<{ card?: { name?: string; face?: string; sex?: string; sign?: string; fans?: number; attention?: number; level_info?: { current_level?: number }; Official?: { title?: string }; vip?: { status?: number } }; archive_count?: number; follower?: number }>(
    `https://api.bilibili.com/x/web-interface/card?mid=${uid}&photo=false`, uid, cookie);
  const c = card?.card;
  if (!c?.name) return null;
  const recent = card?.archive_count ? await get<{ archives?: RawVideo[] }>(`https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${uid}&keywords=&ps=5`, uid, cookie) : null;
  const pinned = card?.archive_count ? await get<RawVideo>(`https://api.bilibili.com/x/space/top/arc?vmid=${uid}`, uid, cookie) : null;
  const master = card?.archive_count ? await get<RawVideo[]>(`https://api.bilibili.com/x/space/masterpiece?vmid=${uid}`, uid, cookie) : null;
  const notice = await get<string>(`https://api.bilibili.com/x/space/notice?mid=${uid}`, uid, cookie);
  const room = await get<{ roomid?: number; liveStatus?: number; title?: string }>(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${uid}`, uid, cookie);
  return {
    uid,
    name: cleanText(c.name),
    level: c.level_info?.current_level ?? 0,
    sex: c.sex && c.sex !== '保密' ? c.sex : '',
    sign: cleanText(c.sign ?? ''),
    fans: card?.follower ?? c.fans ?? 0,
    following: c.attention ?? 0,
    videos: card?.archive_count ?? 0,
    official: cleanText(c.Official?.title ?? ''),
    vip: (c.vip?.status ?? 0) === 1,
    recent: (recent?.archives ?? []).map(video).filter((v): v is ProfileVideo => !!v),
    pinned: video(pinned),
    masterpieces: (master ?? []).map(video).filter((v): v is ProfileVideo => !!v).slice(0, 3),
    notice: cleanText(typeof notice === 'string' ? notice : ''),
    live: room?.roomid ? { roomId: room.roomid, onAir: room.liveStatus === 1, title: cleanText(room.title ?? '') } : null,
    face: biliImageUrl(c.face),
  };
}

/** 只认 B 站图床上的图（头像、私信里的图、视频封面：https://i0.hdslb.com/bfs/…）：别的网址不往下传 */
export function biliImageUrl(raw?: string): string {
  const url = (raw ?? '').trim().replace(/^(?:http:)?\/\//, 'https://');
  return /^https:\/\/i\d\.hdslb\.com\/bfs\/[\w/.-]+\.(?:jpe?g|png|webp|gif)$/i.test(url) ? url : '';
}

function count(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}万` : String(n);
}

function date(sec?: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function line(v: ProfileVideo): string {
  // 带上 BV 号：她看完主页可以接着用 watch_video、play_video 看这个视频
  const meta = [v.bvid, v.views !== undefined ? `${count(v.views)}播放` : '', date(v.pubdate)].filter(Boolean).join('，');
  return `「${v.title}」${meta ? `（${meta}）` : ''}`;
}

/** 写给她看的一段：主页上的事实，观众自己写的部分包在标签里 */
export function profileText(p: BiliProfile, inRoom?: string): string {
  const lines = [
    `${p.name} 的 B 站主页（UID ${p.uid}）：`,
    `- ${p.level} 级${p.sex ? `，${p.sex}` : ''}${p.vip ? '，大会员' : ''}；粉丝 ${count(p.fans)}，关注 ${count(p.following)}，投稿 ${p.videos} 个`,
  ];
  if (p.official) lines.push(`- 认证：${p.official}`);
  if (inRoom) lines.push(`- 在这个直播间：${inRoom}`);
  if (p.sign) lines.push(`- 个性签名：<签名>${p.sign}</签名>`);
  if (p.pinned) lines.push(`- 置顶视频：${line(p.pinned)}`);
  if (p.recent.length) lines.push('- 最近投稿：', ...p.recent.map((v) => `  - ${line(v)}`));
  if (p.masterpieces.length) lines.push(`- 代表作：${p.masterpieces.map(line).join('、')}`);
  if (p.notice) lines.push(`- 空间公告：<公告>${p.notice.slice(0, 200)}</公告>`);
  if (p.live) lines.push(`- 有直播间（${p.live.roomId}）${p.live.onAir ? `，正在直播：${p.live.title}` : '，现在没在播'}`);
  // 游戏里的 picture 吃图片网址：观众让你画他的头像时，这个网址原样交给游戏里的你
  if (p.face) lines.push(`- 头像图片：${p.face}（游戏里的 picture 能把这张图做成像素画）`);
  if (!p.videos && !p.sign && !p.pinned) lines.push('- 主页很空：没投稿、没写签名，是个安静看直播的人');
  return lines.join('\n');
}

/** 记进观众记忆的一句话（下次见到他，卡片里写「看过他的主页：…」） */
export function profileSummary(p: BiliProfile): string {
  const parts = [`${p.level}级`];
  if (p.videos) parts.push(`投稿${p.videos}个${p.recent[0] ? `，最近一个是「${p.recent[0].title.slice(0, 30)}」` : ''}`);
  else parts.push('不投稿');
  if (p.fans >= 1000) parts.push(`粉丝${count(p.fans)}`);
  if (p.sign) parts.push(`签名「${p.sign.slice(0, 30)}」`);
  if (p.official) parts.push(`认证：${p.official.slice(0, 20)}`);
  return parts.join('，');
}
