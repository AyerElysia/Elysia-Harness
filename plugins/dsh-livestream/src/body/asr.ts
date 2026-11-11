/**
 * 语音识别：B 站视频没有字幕时，用本机的 faster-whisper 听一段、写成带时间的字幕（assets/asr/whisper_worker.py）。
 *
 *   - 一次只听一段（CHUNK_SEC，按视频时间对齐：0–5 分、5–10 分……）：她等几秒，不用等整个视频
 *   - 听过的存在 DSH_HOME/dsh-livestream/transcripts/，同一段不再听
 *   - 识别进程第一次用时启动，模型只加载一次；闲着 IDLE_MS 就关掉，把显存还回去
 *   - Python 没填、没装好、听失败：返回 null 或抛错，调用的地方照「没有字幕」处理
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubtitleLine } from './biliVideo';

/** 一段多长（秒） */
export const CHUNK_SEC = 300;
const IDLE_MS = 15 * 60_000;
/** 启动（加载模型；第一次要下载，large-v3-turbo 约 1.6 GB） */
const START_TIMEOUT_MS = 15 * 60_000;
/** 听一段：读音频 + 识别；CPU 上会慢很多 */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface AsrOptions {
  /** 装了 faster-whisper 的 Python；空串表示没装（不识别） */
  python: () => string;
  model: () => string;
  script: string;
  dataDir: string;
  log: (level: 'info' | 'warn', message: string) => void;
}

export interface Transcript {
  lang: string;
  lines: SubtitleLine[];
  /** 这一段听到哪一秒（后面还没听） */
  until: number;
}

interface Pending {
  resolve: (value: { lang: string; lines: SubtitleLine[] }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class Whisper {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private idle: NodeJS.Timeout | null = null;
  /** 同一段同时只听一次（她连着调两次 watch_video） */
  private inflight = new Map<string, Promise<Transcript>>();

  constructor(private readonly options: AsrOptions) {}

  get available(): boolean {
    const python = this.options.python().trim();
    return !!python && existsSync(python) && existsSync(this.options.script);
  }

  /**
   * fromSec 所在那一段的字幕（从段开头起）。audio 取音频地址（要的时候才取：听过的段不用）
   */
  async chunk(
    key: { bvid: string; cid: number; durationSec: number },
    fromSec: number,
    audio: () => Promise<{ url: string; headers: string } | null>,
    /** 真的要听（没听过）时：开始和听完各说一声（舞台终端里显示） */
    notify?: (text: string) => void,
  ): Promise<Transcript | null> {
    const start = Math.floor(Math.max(0, fromSec) / CHUNK_SEC) * CHUNK_SEC;
    const end = key.durationSec ? Math.min(key.durationSec, start + CHUNK_SEC) : start + CHUNK_SEC;
    if (key.durationSec && start >= key.durationSec) return null;
    const file = join(this.options.dataDir, 'transcripts', `${key.bvid}-${key.cid}-${start}.json`);
    const id = `${key.bvid}-${key.cid}-${start}`;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Transcript;
    } catch {
      // 还没听过
    }
    if (!this.available) return null;
    const running = this.inflight.get(id);
    if (running) return running;
    const job = (async () => {
      const source = await audio();
      if (!source) throw new Error('B 站没给音频地址');
      const t0 = Date.now();
      notify?.(`${clockOf(start)}–${clockOf(end)} 开始听…`);
      const { lang, lines } = await this.request({ url: source.url, headers: source.headers, from: start, to: end });
      const transcript: Transcript = { lang, lines, until: end };
      mkdirSync(join(this.options.dataDir, 'transcripts'), { recursive: true });
      writeFileSync(file, JSON.stringify(transcript));
      this.options.log('info', `语音识别 ${key.bvid} ${start}–${end} 秒：${lines.length} 句，${lang || '没听到说话'}，用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
      notify?.(`${clockOf(start)}–${clockOf(end)} 听完 · ${lines.length} 句 · ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
      return transcript;
    })();
    this.inflight.set(id, job);
    try {
      return await job;
    } finally {
      this.inflight.delete(id);
    }
  }

  /** 先把模型加载好（她搜视频时：接下来多半要看，第一次看就不用等加载） */
  warm(): void {
    if (!this.available) return;
    this.start().then(() => this.idleLater(), () => {});
  }

  private idleLater(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  private async request(body: { url: string; headers: string; from: number; to: number }): Promise<{ lang: string; lines: SubtitleLine[] }> {
    await this.start();
    if (this.idle) clearTimeout(this.idle);
    const id = randomUUID();
    const result = new Promise<{ lang: string; lines: SubtitleLine[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('语音识别超时'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child!.stdin!.write(`${JSON.stringify({ id, ...body })}\n`);
    try {
      return await result;
    } finally {
      this.idleLater();
    }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const python = this.options.python().trim();
    const child = spawn(python, [this.options.script, '--model', this.options.model(), '--models-dir', join(this.options.dataDir, 'models')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        // 模型从 Hugging Face 下：国内连不上，默认走镜像（自己设了 HF_ENDPOINT 就用自己的）
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      },
    });
    this.child = child;
    let stderr = '';
    let buffer = '';
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('语音识别启动超时（第一次要下载模型）'));
        child.kill();
      }, START_TIMEOUT_MS);
      child.stdout!.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        const rows = buffer.split('\n');
        buffer = rows.pop() ?? '';
        for (const row of rows) {
          let msg: any;
          try {
            msg = JSON.parse(row);
          } catch {
            continue;
          }
          if (msg.ready) {
            clearTimeout(timer);
            this.options.log('info', `语音识别准备好了：${msg.model}（${msg.device === 'cuda' ? '显卡' : 'CPU'}）`);
            resolve();
            continue;
          }
          const waiting = msg.id ? this.pending.get(msg.id) : undefined;
          if (!waiting) continue;
          this.pending.delete(msg.id);
          clearTimeout(waiting.timer);
          if (msg.error) waiting.reject(new Error(String(msg.error)));
          else {
            this.options.log('info', `语音识别：读音频 ${msg.readMs} ms，识别 ${msg.asrMs} ms（${msg.audioSec} 秒音频）`);
            waiting.resolve({ lang: String(msg.lang ?? ''), lines: (msg.lines ?? []).filter((l: SubtitleLine) => l.text) });
          }
        }
      });
      child.stderr!.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-3000); });
      const fail = (err: Error) => {
        clearTimeout(timer);
        reject(err);
        for (const [id, waiting] of this.pending) {
          clearTimeout(waiting.timer);
          waiting.reject(err);
          this.pending.delete(id);
        }
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
      };
      child.on('error', fail);
      child.on('exit', (code) => {
        const last = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
        if (code) this.options.log('warn', `语音识别进程退出 ${code}：${last}`);
        fail(new Error(code ? `语音识别进程退出：${last}` : '语音识别进程关了'));
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.child?.kill();
  }
}

function clockOf(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
