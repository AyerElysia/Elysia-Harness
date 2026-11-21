import { describe, expect, it } from 'vitest'
import { formatQqConversation, parseQqConversation } from '../src/conversation.ts'

describe('QQ conversation ids', () => {
  it('round-trips a private window and a group window', () => {
    expect(formatQqConversation({ kind: 'private', userId: '10001' })).toBe('qq:private:10001')
    expect(parseQqConversation('qq:private:10001')).toEqual({ kind: 'private', userId: '10001' })
    expect(formatQqConversation({ kind: 'group', groupId: '20002' })).toBe('qq:group:20002')
    expect(parseQqConversation(' qq:group:20002 ')).toEqual({ kind: 'group', groupId: '20002' })
  })

  it('rejects a missing window, a non-numeric id, and another channel', () => {
    expect(() => parseQqConversation('qq')).toThrow(/无法识别/)
    expect(() => parseQqConversation('qq:private:0')).toThrow(/正整数/)
    expect(() => parseQqConversation('feishu:chat:1')).toThrow(/无法识别/)
    expect(() => formatQqConversation({ kind: 'group', groupId: '12a' })).toThrow(/正整数/)
  })
})
