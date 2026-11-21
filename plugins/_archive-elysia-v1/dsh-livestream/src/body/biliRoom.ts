/**
 * B 站直播间的开播、下播、拿推流码（主播自己的账号，用 Cookie）。
 *
 *   开通直播间  POST xlive/app-blink/v1/preLive/CreateRoom          （账号还没有直播间时）
 *   改标题分区  POST room/v1/Room/update
 *   换封面      POST x/upload/web/image（bucket=live）→ preLive/UpdatePreLiveInfo（封面要过 B 站审核）
 *   开播        POST room/v1/Room/startLive → data.rtmp.addr / code（推流地址和推流码）
 *   下播        POST room/v1/Room/stopLive
 *
 * 粉丝少的账号网页上不能开播：按直播姬（pc_link）的身份签名开播，和社区工具 StartLive 的做法一样
 * （github.com/Radekyspec/StartLive；接口说明见 bilibili-API-collect docs/live/manage.md）。
 * 开播返回 60024 时要人脸认证：data.qr 是给主播用 B 站 App 扫的二维码链接；主播扫完、认证过了（IsUserIdentifiedByFaceAuth）再开播一次。
 * 60043 是另一种风控验证（要伪造浏览器行为指纹才能走通），这里不做：请主播用官方直播姬或 B 站 App 开播一次过掉它。
 */

import { createHash } from 'node:crypto';

/** 直播姬（PC）的 appkey / appsec 和版本号（StartLive 2026-10 用的值） */
const LIVEHIME = { appkey: 'aae92bc66f3edfab', appsec: 'af125a0d5279fd576c1b4418a3e8276d', version: '8.7.0.11081', build: '11081' };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface Stream {
  /** 推流地址（OBS 的「服务器」）：rtmp:// 或 srt:// */
  addr: string;
  /** 推流码（OBS 的「推流码」） */
  code: string;
  protocol: 'rtmp' | 'srt';
}

export type StartResult =
  /** srt：B 站给了 SRT 推流地址就有（跨境、丢包的网络上比 RTMP 稳） */
  | { kind: 'live'; stream: Stream; srt: Stream | null }
  /** 要人脸认证：qr 是给 B 站 App 扫的链接 */
  | { kind: 'face'; qr: string; message: string }
  /** 风控验证（60043）：要用官方直播姬或 B 站 App 过一次 */
  | { kind: 'verify'; message: string };

/** B 站直播封面的最大宽度（像素） */
export const COVER_MAX_WIDTH = 1024;

/** 读 PNG / JPEG 的宽高（不解码）；认不出返回 null */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    const marker = data[i + 1];
    const length = view.getUint16(i + 2);
    // SOF0–SOF15（除了 DHT、JPG、DAC）：帧头里有高和宽
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * 直播间现在的封面是不是这张图：B 站图床的文件名就是图片内容的 SHA1（实测 2026-10），
 * 同一张图不用再传——再传一次会重新审核，审核期间直播间没有封面
 */
export function sameCover(currentUrl: string, data: Uint8Array): boolean {
  if (!currentUrl) return false;
  return currentUrl.includes(createHash('sha1').update(data).digest('hex'));
}

export class BiliRoomError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function cookieValue(cookie: string, name: string): string {
  return new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie)?.[1] ?? '';
}

/** 直播姬的签名：加上公共参数，按 key 排序，拼上 appsec 取 md5 */
function livehimeSign(params: Record<string, string | number>): Record<string, string> {
  const all: Record<string, string> = {
    access_key: '', appkey: LIVEHIME.appkey, build: LIVEHIME.build, platform: 'pc_link',
    ts: String(Math.floor(Date.now() / 1000)), version: LIVEHIME.version,
  };
  for (const [k, v] of Object.entries(params)) all[k] = String(v);
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const sign = createHash('md5').update(new URLSearchParams(sorted).toString() + LIVEHIME.appsec).digest('hex');
  return { ...sorted, sign };
}

export class BiliRoom {
  constructor(private readonly cookie: string) {}

  get uid(): string {
    return cookieValue(this.cookie, 'DedeUserID');
  }

  private get csrf(): string {
    return cookieValue(this.cookie, 'bili_jct');
  }

  private async call<T>(url: string, form?: Record<string, string | number>): Promise<{ code: number; message: string; data: T }> {
    const res = await fetch(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Referer: 'https://link.bilibili.com/',
        Origin: 'https://link.bilibili.com',
        Cookie: this.cookie,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new BiliRoomError(res.status, `B 站接口 HTTP ${res.status}`);
    return (await res.json()) as { code: number; message: string; data: T };
  }

  /** 登录了没有、是谁 */
  async whoami(): Promise<{ loggedIn: boolean; uid: string; name: string }> {
    const r = await this.call<{ isLogin?: boolean; mid?: number; uname?: string }>('https://api.bilibili.com/x/web-interface/nav');
    return { loggedIn: !!r.data?.isLogin, uid: String(r.data?.mid ?? ''), name: r.data?.uname ?? '' };
  }

  /** 自己的直播间号；还没开通是 0 */
  async roomId(): Promise<number> {
    const r = await this.call<{ room_id?: number }>('https://api.live.bilibili.com/xlive/app-blink/v1/room/GetInfo?platform=pc');
    if (r.code !== 0) throw new BiliRoomError(r.code, `查直播间失败：${r.message}`);
    return Number(r.data?.room_id ?? 0);
  }

  /** 开通直播间（已经有了就返回现有的） */
  async ensureRoom(): Promise<number> {
    const existing = await this.roomId();
    if (existing) return existing;
    const r = await this.call<{ roomID?: string | number }>('https://api.live.bilibili.com/xlive/app-blink/v1/preLive/CreateRoom', {
      platform: 'web', visit_id: '', csrf: this.csrf, csrf_token: this.csrf,
    });
    if (r.code === 0 && r.data?.roomID) return Number(r.data.roomID);
    if (r.code === 1531193016) return this.roomId();
    throw new BiliRoomError(r.code, `开通直播间失败：${r.message}`);
  }

  /** 开播前的标题和分区（PreLive：B 站给这个账号准备好的默认值） */
  async preLive(): Promise<{ title: string; areaId: number; areaName: string; coverUrl: string }> {
    const r = await this.call<{ title?: string; area?: Record<string, { subAreaID: number; subAreaName: string }>; cover?: { url?: string } }>(
      `https://api.live.bilibili.com/xlive/app-blink/v1/preLive/PreLive?platform=pc&mobi_app=pc&build=${LIVEHIME.build}`,
    );
    const area = Object.values(r.data?.area ?? {})[0];
    return { title: r.data?.title ?? '', areaId: area?.subAreaID ?? 0, areaName: area?.subAreaName ?? '', coverUrl: r.data?.cover?.url ?? '' };
  }

  /** 改标题、分区（area 是子分区 id） */
  async update(roomId: number, patch: { title?: string; areaId?: number }): Promise<void> {
    const form: Record<string, string | number> = { room_id: roomId, platform: 'pc_link', csrf: this.csrf, csrf_token: this.csrf };
    if (patch.title !== undefined) form.title = patch.title.slice(0, 40);
    if (patch.areaId !== undefined) form.area_id = patch.areaId;
    const r = await this.call('https://api.live.bilibili.com/room/v1/Room/update', form);
    if (r.code !== 0) throw new BiliRoomError(r.code, `改直播间信息失败：${r.message}`);
  }

  /**
   * 换直播间封面：传图到 B 站图床，再设成直播间封面；返回图片地址。
   * 封面每换一次都要重新审核（审核中直播间不显示封面），所以调用前先用 sameCover 看是不是同一张。
   */
  async setCover(data: Uint8Array, mime: string): Promise<string> {
    const size = imageSize(data);
    // 实测（2026-10）：宽 1024 能传，1280 被拒「宽像素不合法」
    if (size && size.width > COVER_MAX_WIDTH) throw new BiliRoomError(-1, `封面太宽了（${size.width}×${size.height}）：B 站直播封面宽度不能超过 ${COVER_MAX_WIDTH}，缩小一点再用，比如 1024×768（4:3）`);
    const form = new FormData();
    form.append('bucket', 'live');
    form.append('dir', 'new_room_cover');
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), 'blob');
    const res = await fetch(`https://api.bilibili.com/x/upload/web/image?csrf=${this.csrf}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Referer: 'https://link.bilibili.com/', Origin: 'https://link.bilibili.com', Cookie: this.cookie },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const up = (await res.json()) as { code: number; message: string; data?: { location?: string } };
    if (up.code !== 0 || !up.data?.location) throw new BiliRoomError(up.code, `上传封面失败：${up.message}`);
    const r = await this.call('https://api.live.bilibili.com/xlive/app-blink/v1/preLive/UpdatePreLiveInfo', {
      platform: 'pc_link', mobi_app: 'pc_link', build: '1', cover: up.data.location, coverVertical: '', liveDirectionType: '1',
      csrf: this.csrf, csrf_token: this.csrf, visit_id: '',
    });
    if (r.code !== 0) throw new BiliRoomError(r.code, `设置封面失败：${r.message}`);
    return up.data.location;
  }

  /** 开播：拿推流地址和推流码；要人脸认证时返回扫码链接 */
  async start(roomId: number, areaId: number): Promise<StartResult> {
    const form = livehimeSign({ area_v2: areaId, csrf: this.csrf, csrf_token: this.csrf, room_id: roomId, type: 2 });
    const r = await this.call<{ rtmp?: { addr?: string; code?: string }; protocols?: Array<{ protocol?: string; addr?: string; code?: string }>; qr?: string }>('https://api.live.bilibili.com/room/v1/Room/startLive', form);
    if (r.code === 0 && r.data?.rtmp?.addr && r.data.rtmp.code) {
      const srt = (r.data.protocols ?? []).find((p) => p.protocol?.toLowerCase() === 'srt' && p.addr && p.code);
      return {
        kind: 'live',
        stream: { addr: r.data.rtmp.addr, code: r.data.rtmp.code, protocol: 'rtmp' },
        srt: srt ? { addr: srt.addr!, code: srt.code!, protocol: 'srt' } : null,
      };
    }
    if (r.code === 60024 && r.data?.qr) return { kind: 'face', qr: r.data.qr, message: r.message };
    if (r.code === 60043) return { kind: 'verify', message: r.message };
    throw new BiliRoomError(r.code, `开播失败（${r.code}）：${r.message}`);
  }

  /** 主播扫完人脸认证的二维码了没有（60024 那种） */
  async faceVerified(roomId: number): Promise<boolean> {
    const r = await this.call<{ is_identified?: boolean }>('https://api.live.bilibili.com/xlive/app-blink/v1/preLive/IsUserIdentifiedByFaceAuth', {
      room_id: roomId, face_auth_code: '60024', csrf: this.csrf, csrf_token: this.csrf, visit_id: '',
    });
    return !!r.data?.is_identified;
  }

  /** 直播间现在是不是在播（1 直播中，0 没播，2 轮播） */
  async liveStatus(roomId: number): Promise<number> {
    const r = await this.call<{ live_status?: number }>(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`);
    return Number(r.data?.live_status ?? 0);
  }

  /** 下播 */
  async stop(roomId: number): Promise<void> {
    // 直播姬下播：签名里不带 csrf，签完再加上（和开播不一样，照 StartLive）
    const signed = livehimeSign({ room_id: roomId });
    const form = Object.fromEntries(Object.entries({ ...signed, csrf: this.csrf, csrf_token: this.csrf }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const r = await this.call('https://api.live.bilibili.com/room/v1/Room/stopLive', form);
    if (r.code !== 0) throw new BiliRoomError(r.code, `下播失败（${r.code}）：${r.message}`);
  }
}
