/**
 * 舞台广播：身体往舞台页推事件（SSE 订阅者），舞台念完一句回执 said。
 * 只有一张嘴：说话一句一句排队（withMic），前一句念完下一句才开始。
 */

import type { SpeechPlaybackState, StageEvent } from '../stage/protocol';

export type { SpeechPlaybackState } from '../stage/protocol';

type Listener = (event: StageEvent) => void;

type Say = Extract<StageEvent, { type: 'say' }>;
type Subtitle = Extract<StageEvent, { type: 'subtitle' }>;
type SubtitleStarted = Extract<Subtitle, { state: 'started' }>;

export type SpeakingSource = 'full' | 'audio' | 'listen';

const LISTEN_POLICY_CHECK_MS = 100;

export type PlaybackReport =
  | { state: 'started'; positionMs?: number; durationMs?: number }
  | { state: SpeechPlaybackState; detail?: string };

export interface SpeechReceipt {
  id: string;
  state: SpeechPlaybackState;
  /** Engineering reason only; no spoken text or credentials. */
  detail?: string;
  at: number;
}

interface PendingSpeech {
  finish(state: SpeechPlaybackState, detail?: string): void;
  owner?: Speaker;
  listenGuard?: ReturnType<typeof setInterval>;
  line?: Omit<SubtitleStarted, 'elapsedMs' | 'at'>;
  started?: SubtitleStarted;
}

interface Speaker {
  id: string;
  mode: SpeakingSource;
  listener: Listener;
}

/** 不带 v/at 的事件，broadcast 时补上 */
type StageEventInput = StageEvent extends infer E ? E extends StageEvent ? Omit<E, 'v' | 'at'> : never : never;

export class Stage {
  private listeners = new Set<Listener>();
  /** 出声的舞台页（OBS 的浏览器源）；预览页静音、不回执 */
  private speakers = new Set<Listener>();
  private readonly managedSpeakers = new Map<string, Speaker>();
  private canListen: () => boolean = () => false;
  private readonly subtitles = new Set<Listener>();
  private readonly pending = new Map<string, PendingSpeech>();
  /** 状态类事件的最新一条：舞台页中途连上（OBS 刷新）时先补给它，不用等下一次变化 */
  private latest = new Map<string, StageEvent>();

  /** 已接入的发布舞台，不把本机试听算进直播画面就绪数。 */
  get watchers(): number {
    return this.speakers.size + [...this.managedSpeakers.values()].filter(source => source.mode !== 'listen').length;
  }

  /** 能接收下一句的本机试听连接。 */
  get listenWatchers(): number {
    return this.listenAllowed()
      ? [...this.managedSpeakers.values()].filter(source => source.mode === 'listen').length
      : 0;
  }

  allowListeningWhen(check: () => boolean): void {
    this.canListen = check;
  }

  private listenAllowed(): boolean {
    try {
      return this.canListen();
    } catch {
      return false;
    }
  }

  private hasSpeaker(): boolean {
    return this.watchers > 0 || this.listenWatchers > 0;
  }

  /** speaker：这个页面出声、念完回执（OBS 的浏览器源）；控制台里的预览传 false */
  subscribe(listener: Listener, speaker = true): () => void {
    this.listeners.add(listener);
    if (speaker) this.speakers.add(listener);
    for (const event of this.latest.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
      this.speakers.delete(listener);
      if (!this.hasSpeaker()) {
        for (const speech of this.pending.values()) speech.finish('failed', 'speaking-stage-disconnected');
      }
    };
  }

  /** Register the playback identity for one HTTP event stream. */
  subscribePlayback(id: string, mode: SpeakingSource, listener: Listener): () => void {
    if (this.managedSpeakers.has(id)) throw new Error('Duplicate playback source');
    const speaker = { id, mode, listener };
    this.managedSpeakers.set(id, speaker);
    if (mode === 'full') {
      for (const event of this.latest.values()) this.deliver(listener, event);
      this.replaySubtitles(listener);
    }
    return () => {
      if (this.managedSpeakers.get(id) !== speaker) return;
      this.managedSpeakers.delete(id);
      for (const speech of this.pending.values()) {
        if (speech.owner === speaker || !this.hasSpeaker()) speech.finish('failed', 'speaking-stage-disconnected');
      }
    };
  }

  /** Subscribe to actual playback timing without receiving a speech payload. */
  subscribeSubtitles(listener: Listener): () => void {
    this.subtitles.add(listener);
    this.replaySubtitles(listener);
    return () => { this.subtitles.delete(listener); };
  }

  private replaySubtitles(listener: Listener): void {
    const at = Date.now();
    for (const { started, owner } of this.pending.values()) {
      if (!started || owner?.mode === 'listen') continue;
      const elapsedMs = Math.min(started.estimateMs, started.elapsedMs + Math.max(0, at - started.at));
      this.deliver(listener, { ...started, at, elapsedMs });
    }
  }

  private deliver(listener: Listener, event: StageEvent): void {
    try {
      listener(event);
    } catch {
      // One disconnected stage does not interrupt the other subscribers.
    }
  }

  private publishSubtitle(event: Subtitle): void {
    for (const { mode, listener } of this.managedSpeakers.values()) {
      if (mode === 'full' || (mode === 'audio' && event.state !== 'started')) this.deliver(listener, event);
    }
    for (const listener of this.subtitles) this.deliver(listener, event);
  }

  private sendSpeech(event: Say): void {
    const speech = this.pending.get(event.id);
    if (!speech || speech.line) return;
    const sources = [...this.managedSpeakers.values()];
    const listening = sources.find(source => source.mode === 'listen');
    const owner = (listening && this.listenAllowed() ? listening : undefined)
      ?? sources.find(source => source.mode === 'audio')
      ?? sources.find(source => source.mode === 'full');
    if (!owner) {
      if (!this.speakers.size) speech.finish('failed', 'no-compatible-speaking-stage');
      return;
    }
    speech.owner = owner;
    if (owner.mode === 'listen') {
      speech.listenGuard = setInterval(() => {
        if (!this.listenAllowed()) speech.finish('cancelled', 'local-listening-disabled');
      }, LISTEN_POLICY_CHECK_MS);
      speech.listenGuard.unref?.();
    }
    speech.line = {
      v: 1, type: 'subtitle', state: 'started', id: event.id,
      text: event.text, mood: event.mood, estimateMs: event.estimateMs,
      ...(event.timeline ? { timeline: event.timeline } : {}),
      ...(event.speaker !== undefined ? { speaker: event.speaker } : {}),
    };
    this.deliver(owner.listener, event);
  }

  broadcast(event: StageEventInput): void {
    const full = { v: 1, at: Date.now(), ...event } as StageEvent;
    if (full.type === 'room' || full.type === 'brain' || full.type === 'usage' || full.type === 'media' || full.type === 'board' || full.type === 'orders' || full.type === 'game' || full.type === 'gameStatus' || full.type === 'notice') this.latest.set(full.type, full);
    if (full.type === 'say') this.sendSpeech(full);
    else {
      for (const { mode, listener } of this.managedSpeakers.values()) {
        if (mode === 'full' || full.type === 'reload') this.deliver(listener, full);
      }
      if (full.type === 'reload') {
        for (const listener of this.subtitles) this.deliver(listener, full);
      }
    }
    for (const listener of this.listeners) this.deliver(listener, full);
  }

  /**
   * Register before broadcasting a say event. Only a real ended receipt is
   * success; missing output, cancellation and deadlines are explicit outcomes.
   */
  waitSaid(id: string, estimateMs: number, signal: AbortSignal): Promise<SpeechReceipt> {
    if (!id || !Number.isFinite(estimateMs) || estimateMs < 0) {
      return Promise.reject(new Error('Invalid speech receipt request'));
    }
    if (this.pending.has(id)) return Promise.reject(new Error('Duplicate speech receipt id'));
    if (signal.aborted) return Promise.resolve({ id, state: 'cancelled', detail: 'speech-aborted', at: Date.now() });
    if (!this.hasSpeaker()) return Promise.resolve({ id, state: 'failed', detail: 'no-speaking-stage', at: Date.now() });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const abort = () => finish('cancelled', 'speech-aborted');
      const finish: PendingSpeech['finish'] = (state, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        const speech = this.pending.get(id);
        this.pending.delete(id);
        const at = Date.now();
        clearInterval(speech?.listenGuard);
        const terminal: Subtitle = { v: 1, type: 'subtitle', id, state, at };
        if (speech?.owner?.mode === 'listen') this.deliver(speech.owner.listener, terminal);
        else if (speech?.owner) this.publishSubtitle(terminal);
        resolve({ id, state, ...(detail ? { detail } : {}), at });
      };
      this.pending.set(id, { finish });
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish('timeout', 'playback-receipt-timeout'), estimateMs + 15_000);
      timer.unref?.();
      if (signal.aborted) abort();
    });
  }

  /** Settle an existing speech once; stale/duplicate receipts cannot alter it. */
  said(id: string, state: SpeechPlaybackState, detail?: string): boolean {
    if (state !== 'ended' && state !== 'failed' && state !== 'cancelled' && state !== 'timeout') return false;
    const speech = this.pending.get(id);
    if (!speech || speech.owner !== undefined) return false;
    speech.finish(state, detail?.slice(0, 200));
    return true;
  }

  /** Apply a report only to a sentence sent to this exact live speaker. */
  reportPlayback(mode: SpeakingSource, playbackId: string, id: string, report: PlaybackReport): boolean {
    const speech = this.pending.get(id);
    const owner = this.managedSpeakers.get(playbackId);
    if (!speech?.line || !owner || speech.owner !== owner || owner.mode !== mode) return false;
    if (mode === 'listen' && !this.listenAllowed()) {
      speech.finish('cancelled', 'local-listening-disabled');
      return false;
    }
    if (report.state === 'started') {
      if (speech.started) return false;
      const estimateMs = report.durationMs ?? speech.line.estimateMs;
      const elapsedMs = Math.min(estimateMs, report.positionMs ?? 0);
      const started: SubtitleStarted = { ...speech.line, estimateMs, elapsedMs, at: Date.now() };
      speech.started = started;
      if (mode !== 'listen') this.publishSubtitle(started);
    } else {
      if (report.state === 'ended' && !speech.started) return false;
      speech.finish(report.state, report.detail?.slice(0, 200));
    }
    return true;
  }

  /** 一句一句说：谁先要谁先说 */
  /** priority 大的先念（同样大的按先后）：游戏线说的是游戏里此刻的事，排在直播线回观众的话前面 */
  withMic<T>(play: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.micQueue.push({ priority, run: () => Promise.resolve().then(play).then(resolve, reject) });
      this.nextOnMic();
    });
  }

  private micQueue: Array<{ priority: number; run: () => Promise<void> }> = [];
  private micBusy = false;

  private nextOnMic(): void {
    if (this.micBusy || !this.micQueue.length) return;
    let k = 0;
    for (let i = 1; i < this.micQueue.length; i++) if (this.micQueue[i].priority > this.micQueue[k].priority) k = i;
    const [turn] = this.micQueue.splice(k, 1);
    this.micBusy = true;
    void turn.run().finally(() => {
      this.micBusy = false;
      this.nextOnMic();
    });
  }
}
