/**
 * 她回复里的表情标记：[laugh] 这样的标记把话切成几段，每段带着自己的表情念（念到那里屏幕上的她就换表情）。
 */

/** 按 [表情] / 【表情】 标记切段：认得的标记开始新的一段并换表情，认不得的原样留给 speakable 去清 */
export function splitByMood(text: string, moods: readonly string[]): Array<{ mood: string; text: string }> {
  const parts: Array<{ mood: string; text: string }> = [];
  let mood = 'talk';
  let last = 0;
  for (const m of text.matchAll(/[[【]\s*([a-zA-Z]+)\s*[\]】]/g)) {
    const name = m[1].toLowerCase();
    if (!moods.includes(name)) continue;
    parts.push({ mood, text: text.slice(last, m.index) });
    mood = name;
    last = m.index! + m[0].length;
  }
  parts.push({ mood, text: text.slice(last) });
  return parts.filter((p) => p.text.trim());
}
