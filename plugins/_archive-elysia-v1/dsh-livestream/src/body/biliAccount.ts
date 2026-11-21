/**
 * 开播账号的私信（照 hiyoriai electron/bilibili/accountActions.ts，那边在真实直播里用过）：
 *   followsMe   对方有没有关注开播账号（x/web-interface/relation 的 be_relation）
 *   replied     对方有没有回过私信（svr_sync/fetch_session_msgs：最近的消息里有没有他发的）
 *   send        发一条文字私信（web_im send_msg，要 WBI 签名）
 *
 * B 站私信返回码（hiyoriai 实测）：21047 对方回复或关注之前只能发 1 条；25003 对方隐私设置不收；
 * 21020 / 21046 发太快；-101 没登录。一条最多 2000 字节。
 */

import { randomUUID } from 'node:crypto';
import { createBiliSession, signWbi, type BiliSession } from '../core/platforms/bilibili/biliApi';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
/** 登录会话（WBI 密钥）用多久重新取一次 */
const SESSION_TTL_MS = 30 * 60_000;

export class DmError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function cookieValue(cookie: string, name: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
}

export interface DmAccount {
  /** 开播账号的 uid；没登录返回 0 */
  me(): Promise<number>;
  followsMe(uid: string): Promise<boolean | null>;
  replied(uid: string, since: number): Promise<boolean | null>;
  send(uid: string, text: string): Promise<void>;
}

export class BiliAccount implements DmAccount {
  private session: Promise<BiliSession> | null = null;
  private sessionAt = 0;
  private sessionCookie = '';

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

  async me(): Promise<number> {
    const s = await this.auth();
    return s.loggedIn ? s.uid : 0;
  }

  private async getJson<T>(url: string, cookie: string): Promise<{ code: number; message?: string; data?: T }> {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com', Cookie: cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
    return (await res.json()) as { code: number; message?: string; data?: T };
  }

  /** 对方关注了开播账号没有；查不到返回 null */
  async followsMe(uid: string): Promise<boolean | null> {
    if (!/^\d+$/.test(uid)) return null;
    const s = await this.auth();
    if (!s.loggedIn) return null;
    const body = await this.getJson<{ be_relation?: { attribute?: number } }>(`https://api.bilibili.com/x/web-interface/relation?mid=${uid}`, s.cookie);
    if (body.code !== 0) return null;
    const attribute = body.data?.be_relation?.attribute;
    // 2 关注，6 互关
    return typeof attribute === 'number' ? attribute === 2 || attribute === 6 : null;
  }

  /** since（毫秒）之后对方有没有在私信里说过话；查不到返回 null */
  async replied(uid: string, since: number): Promise<boolean | null> {
    const s = await this.auth();
    if (!s.loggedIn) return null;
    const body = await this.getJson<{ messages?: Array<{ sender_uid?: number; timestamp?: number }> }>(
      `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${uid}&session_type=1&size=20`, s.cookie);
    if (body.code !== 0) return null;
    return (body.data?.messages ?? []).some((m) => String(m.sender_uid) === uid && (m.timestamp ?? 0) * 1000 > since);
  }

  async send(uid: string, text: string): Promise<void> {
    const s = await this.auth();
    const csrf = cookieValue(s.cookie, 'bili_jct');
    if (!s.loggedIn || !csrf || !s.uid) throw new DmError(-101, '开播账号没登录（Cookie 失效了）');
    const devId = randomUUID().toUpperCase();
    const url = `https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${signWbi({ w_sender_uid: s.uid, w_receiver_id: uid, w_dev_id: devId }, s.mixinKey)}`;
    const form: Record<string, string | number> = {
      'msg[sender_uid]': s.uid,
      'msg[receiver_id]': uid,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[dev_id]': devId,
      'msg[timestamp]': Math.floor(Date.now() / 1000),
      'msg[new_face_version]': 1,
      'msg[content]': JSON.stringify({ content: text }),
      csrf,
      csrf_token: csrf,
      build: 0,
      mobi_app: 'web',
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com', Cookie: s.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as { code: number; message?: string };
    if (json.code !== 0) throw new DmError(json.code, json.message ?? '');
  }
}
