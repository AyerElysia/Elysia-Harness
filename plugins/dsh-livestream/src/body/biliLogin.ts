/**
 * 扫码登录开播账号（B 站网页端的二维码登录）：控制台显示二维码，主人用 B 站 App 扫一下、点确认，
 * 插件拿到这次登录的 Cookie，存进 DSH 的凭据。不用从浏览器里复制 Cookie，浏览器那边退出登录也不影响。
 *
 *   生成  passport.bilibili.com/x/passport-login/web/qrcode/generate → url（二维码内容）、qrcode_key
 *   轮询  …/qrcode/poll?qrcode_key= → code 86101 没扫、86090 扫了没确认、86038 过期、0 成功（Set-Cookie 里是登录态）
 *   设备  api.bilibili.com/x/frontend/finger/spi → buvid3 / buvid4（弹幕连接、部分接口要）
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };

export type LoginPoll =
  | { state: 'waiting' | 'scanned' | 'expired' }
  | { state: 'ok'; cookie: string }
  | { state: 'error'; message: string };

export async function startQrLogin(): Promise<{ url: string; key: string }> {
  const res = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json()) as { code: number; message?: string; data?: { url?: string; qrcode_key?: string } };
  if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) throw new Error(`B 站没给二维码（${body.code} ${body.message ?? ''}）`);
  return { url: body.data.url, key: body.data.qrcode_key };
}

export async function pollQrLogin(key: string): Promise<LoginPoll> {
  const res = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json()) as { code: number; data?: { code?: number; message?: string } };
  const code = body.data?.code;
  if (body.code !== 0) return { state: 'error', message: `B 站返回 ${body.code}` };
  if (code === 86101) return { state: 'waiting' };
  if (code === 86090) return { state: 'scanned' };
  if (code === 86038) return { state: 'expired' };
  if (code !== 0) return { state: 'error', message: body.data?.message ?? `B 站返回 ${code}` };
  const jar = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  if (!jar.get('SESSDATA') || !jar.get('bili_jct')) return { state: 'error', message: '登录成功了，但 B 站没给 SESSDATA / bili_jct' };
  // 设备号：直播弹幕连接和一些接口会看
  try {
    const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const d = ((await spi.json()) as { data?: { b_3?: string; b_4?: string } }).data;
    if (d?.b_3) jar.set('buvid3', d.b_3);
    if (d?.b_4) jar.set('buvid4', d.b_4);
  } catch {
    // 没有也能登录
  }
  return { state: 'ok', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
}

/** 这个 Cookie 登的是谁（没登录返回 null） */
export async function whoIs(cookie: string): Promise<{ uid: number; name: string } | null> {
  if (!cookie) return null;
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { ...HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const d = ((await res.json()) as { data?: { isLogin?: boolean; mid?: number; uname?: string } }).data;
    return d?.isLogin && d.mid ? { uid: d.mid, name: d.uname ?? '' } : null;
  } catch {
    return null;
  }
}
