import { describe, expect, it } from 'vitest'
import { readableSystemBlocks } from '../src/client/readable-system.ts'

describe('complete system JSON readable projection', () => {
  it('unwraps every system/developer text part verbatim and keeps ordering and non-text blocks', () => {
    const blocks = readableSystemBlocks(JSON.stringify({
      system: 'first\nsecond',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system A\nline 2' }, { type: 'text', text: 'system B', cache: { scope: 'fixture' } }] },
        { role: 'developer', name: 'fixture-source', content: [
          { type: 'text', text: 'developer C' }, { type: 'image', url: 'fixture:opaque', extra: [1, 2] },
        ], provenance: { fixture: true } },
      ],
      future: { retained: true },
    }))
    const source = blocks.map(block => block.source)
    expect(blocks[0]).toEqual({ source: 'request.system', text: 'first\nsecond' })
    expect(source.indexOf('messages[0] · system · content[0].text'))
      .toBeLessThan(source.indexOf('messages[1] · developer · content[0].text'))
    expect(blocks.find(block => block.source === 'messages[0] · system · content[0].text')?.text).toBe('system A\nline 2')
    expect(blocks.find(block => block.source === 'messages[0] · system · content[1] · metadata')?.text).toContain('cache')
    expect(JSON.parse(blocks.find(block => block.source === 'messages[1] · developer · content[1]')?.text ?? '{}'))
      .toEqual({ type: 'image', url: 'fixture:opaque', extra: [1, 2] })
    expect(JSON.parse(blocks.find(block => block.source === 'messages[1] · metadata')?.text ?? '{}'))
      .toEqual({ role: 'developer', name: 'fixture-source', provenance: { fixture: true } })
    expect(blocks.at(-1)?.text).toContain('retained')
  })

  it('preserves nulls, empty content and unknown structural forms without inventing prose', () => {
    const blocks = readableSystemBlocks(JSON.stringify({ system: null, messages: [
      { role: 'system', content: [] }, { role: 'developer', content: { custom: 'value' } }, null,
    ] }))
    expect(blocks.map(block => block.text)).toContain('null')
    expect(blocks.find(block => block.source.endsWith('· content'))?.text).toBe('[]')
    expect(blocks.some(block => block.text.includes('custom'))).toBe(true)
    expect(readableSystemBlocks('[1,2]')).toEqual([{ source: 'JSON', text: '[1,2]' }])
  })

  it('falls back to exact source for malformed JSON without treating a prefix as parsed content', () => {
    expect(readableSystemBlocks('{"system":')).toEqual([{ source: 'JSON', text: '{"system":' }])
  })
})
