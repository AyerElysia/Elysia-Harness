import { describe, expect, it } from 'vitest'
import { formatAylaConversation, parseAylaConversation } from '../src/conversation.ts'

describe('Ayla conversation ids', () => {
  it('spells a private conversation the way the model reads it', () => {
    expect(formatAylaConversation({ kind: 'private', id: '17' })).toBe('ayla:private:17')
    expect(parseAylaConversation('ayla:private:17')).toEqual({ kind: 'private', id: '17' })
  })

  it('spells a group conversation the way the model reads it', () => {
    expect(formatAylaConversation({ kind: 'group', id: '42' })).toBe('ayla:group:42')
    expect(parseAylaConversation('ayla:group:42')).toEqual({ kind: 'group', id: '42' })
  })

  it('round-trips every conversation it can format', () => {
    const targets = [
      { kind: 'private', id: '1' },
      { kind: 'group', id: '9007199254740991' },
    ] as const
    for (const target of targets) {
      expect(parseAylaConversation(formatAylaConversation(target))).toEqual(target)
    }
  })

  it('trims the whitespace a settings field or a model reply adds', () => {
    expect(parseAylaConversation('  ayla:private:17\n')).toEqual({ kind: 'private', id: '17' })
    expect(formatAylaConversation({ kind: 'group', id: ' 42 ' })).toBe('ayla:group:42')
  })

  it('refuses an id that is not a decimal message conversation id', () => {
    for (const conversation of ['', 'ayla:private:', 'ayla:private:0', 'ayla:private:07', 'ayla:private:-1', 'ayla:private:1.5', 'ayla:group:abc']) {
      expect(() => parseAylaConversation(conversation)).toThrow()
    }
    expect(() => parseAylaConversation('ayla:friend:17')).toThrow(/无法识别的 Ayla 会话/u)
    expect(() => parseAylaConversation('kook:direct:17')).toThrow(/无法识别的 Ayla 会话/u)
    expect(() => parseAylaConversation('')).toThrow(/无法识别的 Ayla 会话/u)
  })

  it('refuses to build an id from a non-numeric id instead of defaulting to a window', () => {
    expect(() => formatAylaConversation({ kind: 'private', id: 'x' })).toThrow(/private id/u)
    expect(() => formatAylaConversation({ kind: 'group', id: '0' })).toThrow(/group id/u)
  })
})
