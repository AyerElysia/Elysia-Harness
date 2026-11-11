/**
 * 她给观众发私信：B 站的规矩在这里管好，每个结果都写成她能照着做的一句话。
 *
 *   - 对方没关注开播账号、也没回过私信：只能发一条（21047）。发出去以后记下「等他关注或回复」，
 *     存在磁盘上（重启也记得）；再发之前先看他关注了没、回了没，都没有就不发，告诉她为什么、该怎么办。
 *     B 站还是返回 21047（以前别的时候发过）也照样记下。
 *   - 对方隐私设置不收（25003）：记下，以后不再试。
 *   - 发太快（21020 / 21046）：两条之间至少隔 SEND_GAP_MS；被限了就告诉她过一会儿再说。
 *   - 一条最多 2000 字节（留点余量 MAX_BYTES）。条数不设上限：主人把账号交给她了。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DmError, type DmAccount } from './biliAccount';

const MAX_BYTES = 1900;
const SEND_GAP_MS = 15_000;

interface DmState {
  /** 发了一条、在等对方关注或回复 */
  waiting: Record<string, { name: string; sentAt: number }>;
  /** 隐私设置不收私信 */
  closed: Record<string, { name: string; at: number }>;
}

export interface DmViewer {
  uid: string;
  name: string;
}

export interface DmResult {
  ok: boolean;
  /** 写给她看的结果 */
  text: string;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return '刚才';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
}

export class DmManager {
  private state: DmState = { waiting: {}, closed: {} };
  private lastSentAt = 0;

  constructor(
    private readonly account: DmAccount,
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<DmState>;
        this.state = { waiting: saved.waiting ?? {}, closed: saved.closed ?? {} };
      } catch {
        // 文件坏了就当没有
      }
    }
  }

  private persist(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.state, null, 1));
  }

  /** 新的一场直播（「等他关注」的记录留着） */
  newShow(): void {}

  async send(viewer: DmViewer, raw: string): Promise<DmResult> {
    const text = raw.trim();
    const name = viewer.name;
    if (!text) return { ok: false, text: '私信内容是空的，没发。' };
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_BYTES) return { ok: false, text: `私信太长了（${bytes} 字节），B 站一条最多 2000 字节：缩到 ${MAX_BYTES} 字节以内（大约 600 个汉字）再发。` };

    const closed = this.state.closed[viewer.uid];
    if (closed) return { ok: false, text: `${name} 的隐私设置不收陌生人私信（${ago(this.now() - closed.at)}试过），发不了：可以在直播里请他打开「允许接收私信」。` };

    if (!(await this.account.me())) return { ok: false, text: '开播账号没登录（Cookie 失效了），私信发不出去：告诉主人重新登录 B 站。' };

    let follows = await this.account.followsMe(viewer.uid).catch(() => null);
    const waiting = this.state.waiting[viewer.uid];
    if (waiting) {
      const replied = follows ? false : await this.account.replied(viewer.uid, waiting.sentAt).catch(() => null);
      if (follows || replied) {
        delete this.state.waiting[viewer.uid];
        this.persist();
      } else {
        return {
          ok: false,
          text: `没发：你${ago(this.now() - waiting.sentAt)}已经给 ${name} 发过一条私信了，他还没关注你、也没回私信。`
            + 'B 站规定这种情况下只能发一条，要等他关注你或者回一句私信才能再发。可以在直播里请他去看私信、回你一句。',
        };
      }
    }

    const wait = this.lastSentAt + SEND_GAP_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastSentAt = this.now();
    try {
      await this.account.send(viewer.uid, text);
    } catch (err) {
      const code = err instanceof DmError ? err.code : 0;
      if (code === 21047) {
        this.state.waiting[viewer.uid] = { name, sentAt: this.now() };
        this.persist();
        return { ok: false, text: `没发出去：${name} 以前已经收过这个账号一条私信，还没关注也没回复，B 站规定只能发一条。请他关注你或者回一句私信，之后才能再发。` };
      }
      if (code === 25003) {
        this.state.closed[viewer.uid] = { name, at: this.now() };
        this.persist();
        return { ok: false, text: `没发出去：${name} 的隐私设置不收陌生人私信。可以在直播里请他打开「允许接收私信」。` };
      }
      if (code === 21020 || code === 21046) return { ok: false, text: '没发出去：私信发得太快，被 B 站限制了。过一两分钟再发这一条。' };
      if (code === -101) return { ok: false, text: '没发出去：开播账号没登录（Cookie 失效了），告诉主人重新登录 B 站。' };
      return { ok: false, text: `没发出去：B 站返回 ${code || '错误'} ${(err as Error).message}`.trim() };
    }

    if (follows === null) follows = await this.account.followsMe(viewer.uid).catch(() => null);
    if (follows) return { ok: true, text: `已经私信给 ${name} 了。他关注了你，之后还可以继续私信他。` };
    this.state.waiting[viewer.uid] = { name, sentAt: this.now() };
    this.persist();
    return {
      ok: true,
      text: `已经私信给 ${name} 了。他还没关注你：在他关注你或者回一句私信之前，B 站只允许这一条，不能再给他发第二条。`,
    };
  }
}
