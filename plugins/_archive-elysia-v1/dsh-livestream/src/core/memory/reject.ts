/**
 * 记忆条目的安全过滤：提炼出来的要点以后会进提示词，先挡掉注入和不可见字符（照 hiyoriai electron/memory/globalMemory.ts）。
 */

/** 单条上限（字符数） */
export const MAX_ENTRY_CHARS = 200;

/** 记忆会被写进 system prompt，所以内容过滤比普通用户输入更严 */
const THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  { pattern: /you\s+are\s+now\s+/i, id: 'role_hijack' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /(curl|wget)\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: 'read_secrets' },
  { pattern: /authorized_keys|\$HOME\/\.ssh|~\/\.ssh/i, id: 'ssh_backdoor' },
];
/** 零宽字符和 BiDi 覆写字符常用于藏注入指令 */
const INVISIBLE_CHARS = /[​-‏‪-‮⁠﻿]/;

/** 返回拒绝原因，null 表示可以写入 */
export function rejectEntry(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return '条目为空';
  if (trimmed.length > MAX_ENTRY_CHARS) return `条目超过 ${MAX_ENTRY_CHARS} 字`;
  if (trimmed.includes('§')) return '条目不能包含分隔符 §';
  if (INVISIBLE_CHARS.test(trimmed)) return '条目包含不可见字符（可能是注入攻击）';
  const threat = THREAT_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  return threat ? `条目匹配威胁模式 ${threat.id}（记忆会进入 system prompt）` : null;
}
