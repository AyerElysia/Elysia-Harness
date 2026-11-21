import { describe, expect, it } from 'vitest'
import { outboundContent, readToolArguments, spokenReply } from '../src/reply-args.ts'

describe('send_text argument reading', () => {
  it('reads content from a JSON string', () => {
    const read = readToolArguments({
      tool_calls: [{ function: { arguments: JSON.stringify({ content: '在呢', thought: '接住' }) } }],
    })
    expect(outboundContent(read.args)).toBe('在呢')
  })

  it('reads content when the provider already decoded the arguments', () => {
    const read = readToolArguments({
      tool_calls: [{ function: { arguments: { content: '在呢' } } }],
    })
    expect(outboundContent(read.args)).toBe('在呢')
  })

  it('rejects a parameter tag and a lone letter', () => {
    expect(spokenReply('t" string="true">在呢在呢♪')).toBeUndefined()
    expect(spokenReply('t')).toBeUndefined()
    expect(spokenReply('在呢')).toBe('在呢')
  })

  it('keeps a missing or blank content empty instead of inventing one', () => {
    expect(outboundContent(readToolArguments(undefined).args)).toBe('')
    expect(outboundContent(readToolArguments({ tool_calls: [{ function: { arguments: '{}' } }] }).args)).toBe('')
    expect(outboundContent(readToolArguments({
      tool_calls: [{ function: { arguments: JSON.stringify({ content: '  \n', thought: '不说' }) } }],
    }).args).trim()).toBe('')
  })
})
