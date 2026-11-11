/**
 * 舞台服务器：插件自己开一个端口（DSH 网页版和桌面版都能用），OBS 的浏览器源直接打开它。
 *
 *   GET  /?token=…                 舞台页（按当前模板摆好挂件）
 *   GET  /stage.js /stage.css       舞台页的代码（插件包 lib/）
 *   GET  /characters/<id>/<file>   角色包、/templates/<id>/<file> 模板（见 packs.ts）
 *   GET  /events?token=…           舞台事件流（SSE）
 *   POST /said?id=…&token=…        舞台念完一句
 *   GET  /video?id=…&token=…       正在放的视频（转发 B 站 CDN，带它要的 Referer，支持 Range）
 *   POST /media?id=…&state=…&token=…  视频开始放、放完、放不出来
 *
 * 所有请求都要带 token（OBS 里填的地址自带），只监听本机。
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { StageEvent } from '../stage/protocol';
import type { Packs } from './packs';
import type { Stage } from './stage';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

export interface StageServerOptions {
  port: number;
  token: string;
  /** 插件包目录（有 lib/、stage/） */
  packageDir: string;
  packs: Packs;
  stage: Stage;
  /** 现在用哪个角色、哪个模板 */
  current(): { character: string; template: string };
  /** 舞台上放的视频：id → CDN 地址；舞台的回执 */
  media?: {
    source(id: string): string | null;
    report(id: string, state: 'playing' | 'ended' | 'error', positionSec?: number, detail?: string): void;
  };
  log?(level: 'info' | 'warn', message: string): void;
}

export class StageServer {
  private server: Server | null = null;

  /** 舞台页代码的版本：lib/stage.js 的修改时间。插件更新、DSH 重启后变，开着的舞台页（OBS）看到就自己刷新 */
  private readonly build: string;

  constructor(private readonly options: StageServerOptions) {
    const script = join(options.packageDir, 'lib', 'stage.js');
    this.build = existsSync(script) ? String(Math.round(statSync(script).mtimeMs)) : '';
  }

  get url(): string {
    const bound = this.server?.address();
    const port = typeof bound === 'object' && bound !== null ? bound.port : this.options.port;
    return 'http://127.0.0.1:' + port + '/?token=' + encodeURIComponent(this.options.token);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.options.log?.('warn', `舞台请求出错：${(err as Error).message}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.requestTimeout = 0;
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  // ── 请求 ────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Preserve the already configured direct local source, without giving a
    // public tunnel an unauthenticated stage capability.
    if (req.method === 'GET' && (url.pathname === '/source' || url.pathname === '/stage')
      && url.searchParams.get('token') === null && directLoopback(req, this.server)) {
      const target = new URL(this.url);
      if (url.pathname === '/stage') target.searchParams.set('preview', '1');
      res.writeHead(302, { location: target.pathname + target.search, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (!sameToken(url.searchParams.get('token'), this.options.token)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('舞台地址不对：请从 DSH 的直播控制台复制完整地址（带 token）。');
      return;
    }
    const path = url.pathname;
    if (req.method === 'POST' && (path === '/said' || path === '/media')) {
      const origin = req.headers.origin;
      if (url.searchParams.get('preview') === '1' || (origin !== undefined && origin !== 'http://' + req.headers.host)) {
        res.writeHead(403); res.end(); return;
      }
    }
    if (req.method === 'POST' && path === '/said') {
      const id = url.searchParams.get('id') ?? '';
      const state = url.searchParams.get('state');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !['ended', 'failed', 'cancelled', 'timeout'].includes(state ?? '')) {
        res.writeHead(400); res.end(); return;
      }
      const accepted = this.options.stage.said(id, state as 'ended' | 'failed' | 'cancelled' | 'timeout',
        (url.searchParams.get('detail') ?? '').slice(0, 200));
      res.writeHead(accepted ? 204 : 409);
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/media') {
      const state = url.searchParams.get('state');
      if (state === 'playing' || state === 'ended' || state === 'error') {
        if (state === 'error') this.options.log?.('warn', `舞台放视频出错：${(url.searchParams.get('detail') ?? '').slice(0, 200)}`);
        this.options.media?.report(url.searchParams.get('id') ?? '', state, Number(url.searchParams.get('at') ?? NaN), url.searchParams.get('detail') ?? undefined);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (path === '/events') return this.events(req, res, url);
    if (path === '/video') return this.video(req, res, url.searchParams.get('id') ?? '');
    if (path === '/' || path === '/index.html' || path === '/source' || path === '/stage') return this.file(res, join(this.options.packageDir, 'stage', 'index.html'));
    if (path === '/stage.js') return this.file(res, join(this.options.packageDir, 'lib', 'stage.js'));
    if (path === '/stage.css') return this.file(res, join(this.options.packageDir, 'stage', 'stage.css'));
    const pack = /^\/(characters|templates)\/([\w-]{1,64})\/(.+)$/.exec(path);
    if (pack) {
      const dir = this.options.packs.dir(pack[1] as 'characters' | 'templates', pack[2]);
      if (dir) return this.file(res, join(dir, decodeURIComponent(pack[3])), dir);
    }
    res.writeHead(404);
    res.end();
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (event: StageEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const { character, template } = this.options.current();
    const c = this.options.packs.character(character);
    const t = this.options.packs.template(template);
    if (c && t) send({ v: 1, type: 'hello', character: c, template: t, build: this.build, at: Date.now() });
    // ?preview=1：控制台里的预览，静音、不回执
    const unsubscribe = this.options.stage.subscribe(send, url.searchParams.get('preview') !== '1');
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  /** 转发视频：B 站 CDN 要 Referer；浏览器拖进度、OBS 边下边放都靠 Range */
  private async video(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const source = this.options.media?.source(id);
    if (!source) {
      res.writeHead(404);
      res.end();
      return;
    }
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    let upstream: Response;
    try {
      upstream = await fetch(source, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        signal: abort.signal,
      });
    } catch (err) {
      if (!abort.signal.aborted) this.options.log?.('warn', `视频取不到：${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
      return;
    }
    const headers: Record<string, string> = { 'content-type': upstream.headers.get('content-type') ?? 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  }

  private file(res: ServerResponse, file: string, within?: string): void {
    const resolved = normalize(file);
    // 只给包里或用户目录里的文件（防 ../ 跳出去）
    if (within && !resolved.startsWith(normalize(within) + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (within && !realpathSync(resolved).startsWith(realpathSync(within) + sep)) {
      res.writeHead(403); res.end(); return;
    }
    if (statSync(resolved).size > 64 * 1024 * 1024) {
      res.writeHead(413); res.end(); return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': extname(resolved) === '.html' || extname(resolved) === '.js' ? 'no-store' : 'max-age=3600',
    });
    res.end(readFileSync(resolved));
  }
}


/** Compare a stage capability without exposing prefix timing. */
function sameToken(candidate: string | null, expected: string): boolean {
  if (candidate === null || candidate.length > 512) return false;
  const actual = Buffer.from(candidate), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Compatibility bootstrap is private to the direct local browser source. */
function directLoopback(req: IncomingMessage, server: Server | null): boolean {
  const peer = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) return false;
  if (Object.keys(req.headers).some(name => name === 'forwarded' || name === 'cf-connecting-ip' || name.startsWith('x-forwarded-'))) return false;
  const bound = server?.address();
  if (typeof bound !== 'object' || bound === null) return false;
  const names = ['127.0.0.1', 'localhost', '[::1]'].map(name => name + ':' + bound.port);
  return names.includes(req.headers.host?.toLowerCase() ?? '');
}
