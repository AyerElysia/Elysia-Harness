/** Lossless display projection: unwrap JSON strings only, retaining every message and non-text value. */
export interface ReadableSystemBlock {
  readonly source: string
  readonly text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function remaining(value: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)))
}

/**
 * Decode a complete system-section JSON without summarising, dropping messages
 * or interpreting their meaning. Unknown shapes keep their entire JSON value.
 */
export function readableSystemBlocks(text: string): readonly ReadableSystemBlock[] {
  let value: unknown
  try { value = JSON.parse(text) } catch { return [{ source: 'JSON', text }] }
  if (!isRecord(value)) return [{ source: 'JSON', text }]
  const blocks: ReadableSystemBlock[] = []
  if (Object.hasOwn(value, 'system')) {
    blocks.push({ source: 'request.system', text: typeof value.system === 'string' ? value.system : json(value.system) })
  }
  if (Array.isArray(value.messages)) {
    value.messages.forEach((message: unknown, index: number) => {
      const source = `messages[${index}]`
      if (!isRecord(message)) { blocks.push({ source, text: json(message) }); return }
      const role = typeof message.role === 'string' ? ` · ${message.role}` : ''
      if (typeof message.content === 'string') {
        blocks.push({ source: source + role, text: message.content })
      } else if (Array.isArray(message.content)) {
        message.content.forEach((part: unknown, partIndex: number) => {
          const partSource = `${source}${role} · content[${partIndex}]`
          if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
            blocks.push({ source: partSource + '.text', text: part.text })
            const extra = remaining(part, ['type', 'text'])
            if (Object.keys(extra).length > 0) blocks.push({ source: partSource + ' · metadata', text: json(extra) })
          } else {
            blocks.push({ source: partSource, text: json(part) })
          }
        })
        if (message.content.length === 0) blocks.push({ source: source + role + ' · content', text: '[]' })
      } else if (Object.hasOwn(message, 'content')) {
        blocks.push({ source: source + role + ' · content', text: json(message.content) })
      }
      const extra = remaining(message, ['content'])
      // Keep role, name and every other original message field available with its source.
      if (Object.keys(extra).length > 0) blocks.push({ source: source + ' · metadata', text: json(extra) })
    })
    if (value.messages.length === 0) blocks.push({ source: 'messages', text: '[]' })
  } else if (Object.hasOwn(value, 'messages')) {
    blocks.push({ source: 'messages', text: json(value.messages) })
  }
  const extra = remaining(value, ['system', 'messages'])
  if (Object.keys(extra).length > 0 || blocks.length === 0) blocks.push({ source: 'JSON', text: json(extra) })
  return blocks
}
