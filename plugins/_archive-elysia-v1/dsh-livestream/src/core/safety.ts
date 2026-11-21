import crypto from 'crypto';
import type { LiveChatEvent } from './live';

/** 清洗后的弹幕：只有这种形态会进入 AI 的提示词 */
export interface SanitizedChat {
  id: string;
  ts: number;
  uid: string;
  uname: string;
  text: string;
  fingerprint: string;
  riskFlags: string[];
  source: LiveChatEvent;
}

const MAX_TEXT = 240;
const MAX_OWNER_TEXT = 4000;
const MAX_NAME = 32;

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/(system|developer|assistant|tool)\s*:/i, 'role-spoofing'],
  [/(ignore|forget|override).{0,20}(previous|above|instructions|rules)/i, 'instruction-override'],
  [/你现在是|从现在开始|忽略(以上|之前)|系统提示词|开发者消息/, 'cn-instruction-override'],
  [/<\s*(script|iframe|object|embed)\b/i, 'html-script'],
  [/```|<\|.*?\|>|<\/?(system|developer|assistant|tool)>/i, 'prompt-boundary'],
];

/** 观众名进提示词前的清洗 */
export function cleanName(value: unknown): string {
  return cleanScalar(value, MAX_NAME) || '某位观众';
}

/** 观众文字进提示词前的清洗 */
export function cleanText(value: unknown): string {
  return cleanScalar(value, MAX_TEXT);
}

/** 主人和帮忙管直播的人的话：自己人，不按弹幕的长度截（图纸、清单可以很长） */
export function cleanOwnerText(value: unknown): string {
  return cleanScalar(value, MAX_OWNER_TEXT);
}

function cleanScalar(value: unknown, maxLen: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function sanitizeChat(event: LiveChatEvent): SanitizedChat {
  const text = cleanScalar(event.text, MAX_TEXT);
  const uname = cleanScalar(event.user.name || `uid-${event.user.id || 'unknown'}`, MAX_NAME);
  const riskFlags = INJECTION_PATTERNS
    .filter(([pattern]) => pattern.test(text))
    .map(([, flag]) => flag);

  const normalized = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\p{Script=Han}]+/gu, '')
    .slice(0, 160);

  const fingerprint = crypto
    .createHash('sha1')
    .update(`${event.user.id || uname}:${normalized}`)
    .digest('hex');

  return { id: event.id, ts: event.ts, uid: event.user.id || uname, uname, text, fingerprint, riskFlags, source: event };
}
