/**
 * 她用开播账号点赞、评论、关注、收藏、投币、发动态、看收件箱、管直播间：结果写成她能照着做的话。
 * 主人把账号的权限都交给她了，这里不设额外的上限，只照 B 站的规矩来：
 *   - 两条评论之间隔 COMMENT_GAP_MS（发太快 B 站会风控、要验证码），一条不超过 MAX_COMMENT_CHARS 字（B 站的上限）
 *   - 回复、删除某一条评论要知道它在哪个评论区、哪一楼：只认她看到过的（read_comments、check_inbox 给的编号）
 *   - 收件箱提醒：开播时的私信、回复记成「看过了」，之后新来的才提醒她（newSince）
 * 评论、私信内容都是别人写的：包在标签里给她看。
 */

import { SocialError, type Comment, type DmMessage, type DmSession, type Mention } from './biliSocial';

export const COMMENT_GAP_MS = 15_000;
export const MAX_COMMENT_CHARS = 1000;
/** 她自己的收藏夹（不往主人原有的收藏夹里放） */
export const FAVORITE_FOLDER = '大肥鱼收藏';

export interface SocialApi {
  likeVideo(aid: number): Promise<boolean>;
  likeComment(type: number, oid: string, rpid: string): Promise<void>;
  comments(type: number, oid: string, sort: 'hot' | 'new', page: number): Promise<{ count: number; items: Comment[] }>;
  comment(type: number, oid: string, text: string, root?: string, parent?: string): Promise<string>;
  dmSessions(): Promise<DmSession[]>;
  dmMessages(uid: string, size?: number): Promise<DmMessage[]>;
  mentions(): Promise<Mention[]>;
  names(uids: string[]): Promise<Map<string, string>>;
  relation(uid: string): Promise<{ iFollow: boolean; followsMe: boolean }>;
  follow(uid: string, follow: boolean): Promise<void>;
  fans(page: number): Promise<{ total: number; list: Array<{ uid: string; name: string; at: number; mutual: boolean }> }>;
  deleteComment(type: number, oid: string, rpid: string): Promise<void>;
  markRead(uid: string): Promise<void>;
  postDynamic(text: string): Promise<string>;
  favorite(aid: number, folderTitle: string): Promise<'added' | 'already'>;
  coin(aid: number, multiply: 1 | 2, like: boolean): Promise<void>;
  coins(): Promise<number>;
  mute(roomId: number, uid: string, hours: number): Promise<void>;
  muted(roomId: number): Promise<Array<{ id: string; uid: string; name: string; at: string; until: string }>>;
  unmute(roomId: number, id: string): Promise<void>;
}

/** 评论区：视频（type 1）用 aid 当 oid */
export interface Thread {
  type: number;
  oid: string;
  title: string;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
}

function errorText(err: unknown, what: string): string {
  const code = err instanceof SocialError ? err.code : 0;
  const reason: Record<number, string> = {
    [-101]: '开播账号没登录（登录失效了），告诉主人在控制台扫码登录',
    12015: 'B 站要求输入验证码，这个账号暂时发不了评论（风控），过一阵再说',
    12051: '这句评论和之前发过的重复了',
    12002: '这个评论区关了', 12009: '这个评论区关了',
    12025: '字数太多了',
    12022: '这条评论已经删掉了', 12035: '没有权限删这条评论（只能删自己的、或者自己视频下的）',
    22001: '不能关注自己', 22002: '对方设置了不让人关注', 22003: '对方把这个账号拉黑了', 22009: '关注的人数到上限了', 22013: '对方账号已经注销',
    34002: '不能给自己的视频投币', 34003: '投币数量不对', 34004: '投得太快，过一会儿再投', 34005: '这个视频已经投满了（一个视频最多投 2 个）', [-104]: '硬币不够了',
    11010: '收藏夹满了',
    [-509]: '发得太快，被 B 站限制了，过几分钟再试', 12019: '发得太快，被 B 站限制了，过几分钟再试',
    65006: '已经赞过了',
  };
  return `${what}没成功：${reason[code] ?? `B 站返回 ${code || '错误'} ${(err as Error).message ?? ''}`.trim()}。`;
}

export class SocialManager {
  private lastCommentAt = 0;
  /** 她这场看过的评论：rpid → 在哪个评论区、哪一楼（回复、点赞评论用） */
  private known = new Map<string, Thread & { root: string; name: string }>();
  /** 私信过开播账号的人（她可以回私信） */
  private talkers = new Map<string, string>();
  private seen: Set<string> | null = null;

  constructor(private readonly api: SocialApi, private readonly now: () => number = Date.now) {}

  /** 新的一场：收件箱重新记「看过了」 */
  newShow(): void {
    this.seen = null;
  }

  /** 私信过开播账号的人（发私信时认这个） */
  talker(uid: string): string | undefined {
    return this.talkers.get(uid);
  }

  findTalker(who: string): { uid: string; name: string } | null {
    const w = who.trim();
    for (const [uid, name] of this.talkers) if (uid === w || name === w) return { uid, name };
    return null;
  }

  async likeVideo(aid: number, title: string): Promise<string> {
    try {
      const fresh = await this.api.likeVideo(aid);
      if (!fresh) return `「${title}」之前已经赞过了。`;
      return `给「${title}」点了赞（用的是开播账号）。`;
    } catch (err) {
      return errorText(err, '点赞');
    }
  }

  async likeComment(rpid: string): Promise<string> {
    const c = this.known.get(rpid);
    if (!c) return `不知道 ${rpid} 是哪条评论：先用 read_comments 或 check_inbox 看到它，再用那里给的编号。`;
    try {
      await this.api.likeComment(c.type, c.oid, rpid);
      return `给 ${c.name} 在「${c.title}」下的评论点了赞。`;
    } catch (err) {
      return errorText(err, '点赞');
    }
  }

  async readComments(thread: Thread, sort: 'hot' | 'new', page: number): Promise<string> {
    let result: { count: number; items: Comment[] };
    try {
      result = await this.api.comments(thread.type, thread.oid, sort, page);
    } catch (err) {
      return errorText(err, '看评论');
    }
    const remember = (c: Comment) => this.known.set(c.rpid, { ...thread, root: c.root, name: c.name });
    const lines = [`「${thread.title}」的评论区（${sort === 'new' ? '最新' : '热门'}，一共 ${result.count} 条），第 ${page} 页：`];
    if (!result.items.length) lines.push(page > 1 ? '这一页没有了。' : '还没有评论。');
    else lines.push('<评论区>');
    result.items.forEach((c, i) => {
      remember(c);
      lines.push(`${i + 1}. [${c.rpid}] ${c.name}（${c.likes} 赞${c.replies ? `，${c.replies} 条回复` : ''}，${ago(this.now() - c.at)}）：${c.text}`);
      for (const s of c.sub ?? []) {
        remember(s);
        lines.push(`   ↳ [${s.rpid}] ${s.name}：${s.text}`);
      }
    });
    if (result.items.length) lines.push('</评论区>', '回复某一条：post_comment 填 reply_to（方括号里的编号）；给评论点赞：like 填 comment。翻页：page。');
    return lines.join('\n');
  }

  async postComment(thread: Thread | null, raw: string, replyTo?: string): Promise<{ ok: boolean; text: string }> {
    const text = raw.trim();
    if (!text) return { ok: false, text: '评论是空的，没发。' };
    if ([...text].length > MAX_COMMENT_CHARS) return { ok: false, text: `评论太长了（${[...text].length} 字），最多 ${MAX_COMMENT_CHARS} 字。` };
    const wait = this.lastCommentAt + COMMENT_GAP_MS - this.now();
    if (wait > 0) return { ok: false, text: `离上一条评论才过了 ${Math.round((COMMENT_GAP_MS - wait) / 1000)} 秒，评论两条之间要隔 ${COMMENT_GAP_MS / 1000} 秒（发太快 B 站会风控），${Math.ceil(wait / 1000)} 秒后再发。` };
    let target: Thread & { root?: string; parent?: string; name?: string };
    if (replyTo) {
      const c = this.known.get(replyTo);
      if (!c) return { ok: false, text: `不知道 ${replyTo} 是哪条评论：先用 read_comments 或 check_inbox 看到它，再用那里给的编号。` };
      target = { ...c, root: c.root, parent: replyTo };
    } else if (thread) {
      target = thread;
    } else {
      return { ok: false, text: '要说在哪发：填 video（发在视频下面），或者 reply_to（回复某一条评论）。' };
    }
    this.lastCommentAt = this.now();
    try {
      const rpid = await this.api.comment(target.type, target.oid, text, target.root, target.parent);
      if (rpid) this.known.set(rpid, { type: target.type, oid: target.oid, title: target.title, root: target.root ?? rpid, name: '你' });
      const where = target.name ? `回复了 ${target.name}（在「${target.title}」下）` : `在「${target.title}」下发了评论`;
      return { ok: true, text: `用开播账号${where}，大家都看得到。${rpid ? `这条评论的编号是 ${rpid}（想删掉用 delete_comment）。` : ''}` };
    } catch (err) {
      return { ok: false, text: errorText(err, '发评论') };
    }
  }

  /** 收件箱：最近的私信会话、别人回复 / @ 她的 */
  async inbox(): Promise<string> {
    let sessions: DmSession[];
    let mentions: Mention[];
    try {
      [sessions, mentions] = await Promise.all([this.api.dmSessions(), this.api.mentions()]);
    } catch (err) {
      return errorText(err, '看收件箱');
    }
    sessions = sessions.slice(0, 10);
    mentions = mentions.slice(0, 10);
    const names = await this.api.names(sessions.map((s) => s.uid));
    const lines = ['开播账号的私信（最近的会话，只有你看得到）：'];
    if (!sessions.length) lines.push('（没有）');
    for (const s of sessions) {
      const name = names.get(s.uid) ?? `UID ${s.uid}`;
      this.talkers.set(s.uid, name);
      const last = s.last ? `最后一条是${s.last.fromMe ? '你' : '他'}${ago(this.now() - s.last.at)}发的：<私信>${s.last.text.slice(0, 80)}</私信>` : '';
      lines.push(`- ${name}（UID ${s.uid}）${s.unread ? `，${s.unread} 条未读` : ''}${last ? `，${last}` : ''}`);
    }
    lines.push('', '回复你的、@ 你的（评论区里，大家都看得到）：');
    if (!mentions.length) lines.push('（没有）');
    for (const m of mentions) {
      if (m.rpid && m.oid) this.known.set(m.rpid, { type: m.type, oid: m.oid, title: m.title, root: m.root, name: m.name });
      const did = m.kind === 'reply' ? `回复了你${m.yours ? `「${m.yours.slice(0, 30)}」` : ''}` : '@ 了你';
      lines.push(`- [${m.rpid}] ${m.name} ${ago(this.now() - m.at)}在「${m.title}」下${did}：<评论>${m.text}</评论>`);
    }
    lines.push('', '看和某个人的私信往来：read_dm；回私信：send_dm；回评论：post_comment 填 reply_to（方括号里的编号）。');
    return lines.join('\n');
  }

  async conversation(uid: string, name: string): Promise<string> {
    let messages: DmMessage[];
    try {
      messages = await this.api.dmMessages(uid);
    } catch (err) {
      return errorText(err, '看私信');
    }
    if (!messages.length) return `和 ${name} 还没有私信往来。`;
    this.talkers.set(uid, name);
    // 她看过了：标成已读（主人那边就不会一直显示未读）
    await this.api.markRead(uid).catch(() => {});
    return [`和 ${name}（UID ${uid}）最近的私信（只有你看得到，已标成已读）：`, '<私信>', ...messages.map((m) => `${m.fromMe ? '你' : name}（${ago(this.now() - m.at)}）：${m.text}`), '</私信>'].join('\n');
  }

  // ── 关注 ──

  async follow(uid: string, name: string, follow: boolean): Promise<string> {
    try {
      const before = await this.api.relation(uid).catch(() => null);
      if (before && before.iFollow === follow) return follow ? `已经关注着 ${name} 了。` : `本来就没关注 ${name}。`;
      await this.api.follow(uid, follow);
      if (!follow) return `取关了 ${name}。`;
      return `关注了 ${name}${before?.followsMe ? '，你们现在是互相关注' : ''}。`;
    } catch (err) {
      return errorText(err, follow ? '关注' : '取关');
    }
  }

  async fans(page: number): Promise<string> {
    try {
      const { total, list } = await this.api.fans(page);
      if (!list.length) return page > 1 ? '这一页没有了。' : '还没有粉丝。';
      return [
        `开播账号一共 ${total} 个粉丝，最新关注的（第 ${page} 页）：`,
        ...list.map((f) => `- ${f.name}（UID ${f.uid}），${ago(this.now() - f.at)}关注${f.mutual ? '，已互相关注' : '，你还没关注他'}`),
        '回关用 follow；翻页填 page。',
      ].join('\n');
    } catch (err) {
      return errorText(err, '看粉丝');
    }
  }

  // ── 评论区管理 ──

  async deleteComment(rpid: string): Promise<string> {
    const c = this.known.get(rpid);
    if (!c) return `不知道 ${rpid} 是哪条评论：先用 read_comments 或 check_inbox 看到它，或者用你发评论时给的编号。`;
    try {
      await this.api.deleteComment(c.type, c.oid, rpid);
      this.known.delete(rpid);
      return `删掉了「${c.title}」下${c.name === '你' ? '你发的' : ` ${c.name} 的`}那条评论。`;
    } catch (err) {
      return errorText(err, '删评论');
    }
  }

  // ── 动态 ──

  async postDynamic(raw: string): Promise<{ ok: boolean; text: string }> {
    const text = raw.trim();
    if (!text) return { ok: false, text: '动态是空的，没发。' };
    try {
      const id = await this.api.postDynamic(text);
      return { ok: true, text: `用开播账号发了一条动态（标注为 AI 生成），关注的人首页都看得到。${id ? `动态 id ${id}。` : ''}` };
    } catch (err) {
      return { ok: false, text: errorText(err, '发动态') };
    }
  }

  // ── 收藏、投币 ──

  async favorite(aid: number, title: string): Promise<string> {
    try {
      const r = await this.api.favorite(aid, FAVORITE_FOLDER);
      return r === 'already' ? `「${title}」已经在「${FAVORITE_FOLDER}」里了。` : `把「${title}」收进了收藏夹「${FAVORITE_FOLDER}」。`;
    } catch (err) {
      return errorText(err, '收藏');
    }
  }

  async coin(aid: number, title: string, count: 1 | 2, like: boolean): Promise<string> {
    try {
      await this.api.coin(aid, count, like);
      const left = await this.api.coins().catch(() => null);
      return `给「${title}」投了 ${count} 个硬币${like ? '，顺便点了赞' : ''}。${left !== null ? `账号还剩 ${Math.floor(left)} 个硬币。` : ''}`;
    } catch (err) {
      return errorText(err, '投币');
    }
  }

  // ── 直播间禁言 ──

  async mute(roomId: number, uid: string, name: string, hours: number): Promise<string> {
    try {
      await this.api.mute(roomId, uid, hours);
      return `在直播间禁言了 ${name} ${hours} 小时（这段时间他发不了弹幕）。想提前解开用 unmute。`;
    } catch (err) {
      return errorText(err, '禁言');
    }
  }

  async unmute(roomId: number, who: string): Promise<string> {
    try {
      const list = await this.api.muted(roomId);
      const w = who.trim();
      const row = list.find((r) => r.uid === w || r.name === w) ?? list.find((r) => r.name.includes(w));
      if (!row) return list.length ? `禁言名单里没有「${who}」。现在被禁言的：${list.map((r) => `${r.name}（UID ${r.uid}）`).join('、')}。` : '禁言名单是空的。';
      await this.api.unmute(roomId, row.id);
      return `解开了 ${row.name} 的禁言。`;
    } catch (err) {
      return errorText(err, '解禁言');
    }
  }

  /** 这场开播以后新来的私信、回复、@（第一次调用只记下现有的，返回空） */
  async newSince(): Promise<string[]> {
    const [sessions, mentions] = await Promise.all([this.api.dmSessions(), this.api.mentions()]);
    const keys = [
      ...sessions.filter((s) => s.last && !s.last.fromMe).map((s) => ({ key: `dm-${s.uid}-${s.last!.at}`, dm: s })),
      ...mentions.map((m) => ({ key: m.id, m })),
    ];
    if (!this.seen) {
      this.seen = new Set(keys.map((k) => k.key));
      return [];
    }
    const fresh = keys.filter((k) => !this.seen!.has(k.key));
    for (const k of fresh) this.seen.add(k.key);
    if (!fresh.length) return [];
    const names = await this.api.names(fresh.flatMap((k) => ('dm' in k && k.dm ? [k.dm.uid] : [])));
    return fresh.map((k) => {
      if ('dm' in k && k.dm) {
        const name = names.get(k.dm.uid) ?? `UID ${k.dm.uid}`;
        this.talkers.set(k.dm.uid, name);
        return `${name} 私信了你：<私信>${k.dm.last!.text.slice(0, 60)}</私信>`;
      }
      const m = (k as { m: Mention }).m;
      if (m.rpid && m.oid) this.known.set(m.rpid, { type: m.type, oid: m.oid, title: m.title, root: m.root, name: m.name });
      return `${m.name} 在「${m.title}」下${m.kind === 'reply' ? '回复了你' : '@ 了你'}：<评论>${m.text.slice(0, 60)}</评论>（编号 ${m.rpid}）`;
    });
  }
}
