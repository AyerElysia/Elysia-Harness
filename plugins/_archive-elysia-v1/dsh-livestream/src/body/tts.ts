/**
 * Elysia's deployment-owned local Breeze voice. No cloud TTS fallback.
 * Audio is measured WAV; subtitle timing is an explicitly estimated projection.
 */
import { ELYSIUM_BREEZE_CONFIG } from '@elysia/conscious-mind/src/breeze-tts.ts';
import { BreezeVoice } from './breeze';
import { DEFAULT_VOICE } from './voices';
import { speechCaption } from '../core/speakable';

export { DEFAULT_VOICE };

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface Speech {
  audio: Uint8Array;
  /** Retained upstream shape; Breeze does not provide measured word alignment. */
  words: TimedWord[];
  audioMime: 'audio/wav';
  durationMs: number;
  timingSource: 'estimated';
  timeline: Array<{ chars: number; atMs: number }>;
}

export type SpeechAdapter = (text: string, signal: AbortSignal, voice?: string, expressionInstruction?: string) => Promise<Speech>;

/** This checks speaker selection, not network health or configuration readiness. */
export function canSpeak(voice = DEFAULT_VOICE): boolean {
  return voice === '' || voice === DEFAULT_VOICE;
}

async function speechFor(
  client: BreezeVoice,
  text: string,
  signal: AbortSignal,
  voice?: string,
  expressionInstruction?: string,
): Promise<Speech> {
  if (!canSpeak(voice)) throw new Error('此直播仅配置爱莉的本地 Breeze 音色，其他说话者的音色尚未配置');
  signal.throwIfAborted();
  const line = await client.speak(text, { signal, ...(expressionInstruction ? { expression: expressionInstruction } : {}) });
  const timeline: Speech['timeline'] = [];
  let offset = 0;
  for (const clause of line.timing) {
    const found = text.indexOf(clause.text, offset);
    if (found < 0) continue;
    const start = [...speechCaption(text.slice(0, found))].length;
    timeline.push({ chars: start, atMs: clause.start });
    offset = found + clause.text.length;
    timeline.push({ chars: [...speechCaption(text.slice(0, offset))].length, atMs: clause.end });
  }
  const chars = [...speechCaption(text)].length;
  if (timeline.at(-1)?.chars !== chars) timeline.push({ chars, atMs: line.ms });
  return { audio: line.wav, words: [], audioMime: 'audio/wav', durationMs: line.ms, timingSource: 'estimated', timeline };
}

/** A separate injectable client for isolated tests or an explicitly owned host. */
export function createSpeechAdapter(
  configPath = ELYSIUM_BREEZE_CONFIG,
  fetchImpl: typeof fetch = fetch,
  options: { requestTimeoutMs?: number } = {},
): SpeechAdapter {
  const client = new BreezeVoice(configPath, fetchImpl, options);
  return (text, signal, voice, expressionInstruction) => speechFor(client, text, signal, voice, expressionInstruction);
}

const localVoice = new BreezeVoice(ELYSIUM_BREEZE_CONFIG);

/** Default runtime adapter; constructing it performs no I/O or network calls. */
export const synthesize: SpeechAdapter = (text, signal, voice, expressionInstruction) => speechFor(localVoice, text, signal, voice, expressionInstruction);

export interface VoiceStatus {
  available: boolean;
  provider: 'breeze';
  label: string;
  error?: string;
}

/** Local configuration/readability check only; it never performs synthesis. */
export async function voiceStatus(): Promise<VoiceStatus> {
  try {
    await localVoice.ready();
    return { available: true, provider: 'breeze', label: '爱莉 · 本地 Breeze' };
  } catch {
    return { available: false, provider: 'breeze', label: '爱莉 · 本地 Breeze', error: '本地 Breeze 配置或参考音频不可用' };
  }
}

/** Upstream pure compatibility utility; local Breeze does not route by language. */
export function languageOf(text: string): 'ja' | 'ko' | 'ru' | 'crosslingual' | 'zh-cn' {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const kana = count(/[\u3040-\u30ff]/g);
  const hangul = count(/[\uac00-\ud7af]/g);
  const cyrillic = count(/[\u0400-\u04ff]/g);
  const latin = count(/[A-Za-z\u00c0-\u024f]/g);
  const letters = kana + hangul + cyrillic + latin + count(/[\u4e00-\u9fff]/g);
  const most = (n: number) => n >= 2 && n * 2 >= letters;
  if (most(kana)) return 'ja';
  if (most(hangul)) return 'ko';
  if (most(cyrillic)) return 'ru';
  if (most(latin)) return 'crosslingual';
  return 'zh-cn';
}

/**
 * Upstream alignment utility retained for protocol/tests. Breeze returns no
 * measured words and supplies its separately labelled estimated timeline.
 */
export function subtitleTimeline(text: string, words: TimedWord[]): Array<{ chars: number; atMs: number }> {
  const chars = [...text];
  const points: Array<{ chars: number; atMs: number }> = [];
  let cursor = 0;
  for (const w of words) {
    const piece = [...w.word];
    // 只用第一个字定位（后面可能粘着标点），在接下来几个字里找
    let found = -1;
    for (let i = cursor; i < Math.min(chars.length, cursor + 8); i++) {
      if (chars[i] === piece[0]) { found = i; break; }
    }
    if (found < 0) continue;
    points.push({ chars: found, atMs: Math.round(w.start * 1000) });
    cursor = Math.min(chars.length, found + piece.length);
    points.push({ chars: cursor, atMs: Math.round(w.end * 1000) });
  }
  return points;
}

/** UI estimate only: it is never evidence that speech actually played. */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, text.length * 230);
}
