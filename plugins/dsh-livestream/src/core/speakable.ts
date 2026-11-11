/**
 * 念出来、打成字幕之前清一遍：Markdown 记号、链接、代码念出来全是噪音。
 * 【标签】和 [标签] 是 LLM 偶尔带出来的动作描写，也去掉。
 */
export function speakable(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
    .replace(/【.*?】/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s?|\d+[.)]\s+)/gm, '')
    // 下划线不动：观众名字里常有（「天籁音_」）
    .replace(/\*+|~~|`/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
