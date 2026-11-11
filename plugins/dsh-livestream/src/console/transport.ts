/** Uses the same documented page carrier as native client-hmr, with owned cancellation. */
import { createParser } from 'eventsource-parser';

export type PageFetch = (input: string, init: RequestInit) => Promise<Response>;
interface PageTransportGlobal { __DSH_TRANSPORT__?: { fetch?: PageFetch } }
export interface ConsoleEvent { event: string; data: string }

/** The shell owns authentication; this plugin never reads credentials or builds auth headers. */
export function nativePageFetch(): PageFetch {
  const carrier = (globalThis as PageTransportGlobal).__DSH_TRANSPORT__?.fetch;
  return carrier ?? ((path, init) => globalThis.fetch(path, { ...init, credentials: 'same-origin' }));
}

export class ConsoleTransport {
  private readonly lifetime = new AbortController();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private following = false;
  constructor(private readonly fetchHost: PageFetch = nativePageFetch()) {}

  async request<T>(path: string, body?: unknown): Promise<T> {
    const signal = this.lifetime.signal;
    signal.throwIfAborted();
    const response = await this.fetchHost('api/dsh-livestream/' + path, body === undefined
      ? { method: 'GET', cache: 'no-store', signal }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    const data = await response.json().catch(() => ({ ok: false, error: '直播接口返回了无法读取的数据' }));
    signal.throwIfAborted();
    if (!response.ok) throw new Error('直播请求失败（HTTP ' + response.status + '）' + (typeof data.error === 'string' ? '：' + data.error : ''));
    if (data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : '直播接口拒绝了请求');
    return data as T;
  }

  follow(receive: (event: ConsoleEvent) => void, status: (error: string | null) => void): void {
    if (this.following || this.lifetime.signal.aborted) return;
    this.following = true;
    void this.pump(receive, status);
  }

  private async pump(receive: (event: ConsoleEvent) => void, status: (error: string | null) => void): Promise<void> {
    const signal = this.lifetime.signal;
    while (!signal.aborted) {
      try {
        const response = await this.fetchHost('api/dsh-livestream/events', { method: 'GET', headers: { accept: 'text/event-stream' }, cache: 'no-store', signal });
        if (signal.aborted) { void response.body?.cancel().catch(() => {}); return; }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
          void response.body?.cancel().catch(() => {});
          throw new Error('直播事件连接失败（HTTP ' + response.status + '）');
        }
        const reader = response.body.getReader(); this.reader = reader;
        const decoder = new TextDecoder();
        const parser = createParser({ onEvent: event => { if (!signal.aborted) receive({ event: event.event ?? 'message', data: event.data }); } });
        status(null);
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
          }
          if (!signal.aborted) throw new Error('直播事件连接已断开，正在重连');
        } finally {
          if (this.reader === reader) this.reader = null;
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (signal.aborted) return;
        status(error instanceof Error ? error.message : '直播事件连接失败，正在重连');
      }
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1000);
        if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
      });
    }
  }

  dispose(): void {
    this.lifetime.abort();
    void this.reader?.cancel().catch(() => {});
  }
}
