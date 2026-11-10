import { describe, expect, it } from 'vitest'
import { resolveForm } from '../src/forms.ts'
import { DEFAULT_BASE_URL, assertBaseUrl, isLoopbackOrPrivateHost } from '../src/settings.ts'
import { STANDALONE_COLLECT_MS, createBatchQueue, rememberDelivered } from '../src/index.ts'
import type { InboundEvent } from '../src/inbound.ts'

/** Short quiet period so the queue behavior is asserted without a slow test. */
const COLLECT_MS = 40

function event(id: string): InboundEvent {
  return {
    channel: 'ayla',
    conversation: 'ayla:private:17',
    messageId: id,
    senderId: '8d9c',
    senderName: '小希',
    content: [{ type: 'text', text: '在吗' }],
  }
}

describe('Ayla form decision', () => {
  it('uses elyh under auto only when both conscious-mind services exist', () => {
    expect(resolveForm('auto', true, true)).toBe('elyh')
    expect(resolveForm('auto', true, false)).toBe('standalone')
    expect(resolveForm('auto', false, true)).toBe('standalone')
    expect(resolveForm('auto', false, false)).toBe('standalone')
  })

  it('keeps standalone even when both services exist', () => {
    expect(resolveForm('standalone', true, true)).toBe('standalone')
    expect(resolveForm('standalone', true, false)).toBe('standalone')
    expect(resolveForm('standalone', false, true)).toBe('standalone')
    expect(resolveForm('standalone', false, false)).toBe('standalone')
  })

  it('fails the mount when elyh was asked for and a service is missing', () => {
    expect(() => resolveForm('elyh', false, false)).toThrow(/inboundPending/u)
    expect(() => resolveForm('elyh', false, false)).toThrow(/outboundText/u)
    expect(() => resolveForm('elyh', true, false)).toThrow(/outboundText/u)
    expect(() => resolveForm('elyh', false, true)).toThrow(/inboundPending/u)
  })

  it('returns elyh when the explicit setting can be honoured', () => {
    expect(resolveForm('elyh', true, true)).toBe('elyh')
  })

  it('names the missing services instead of degrading to another destination', () => {
    expect(() => resolveForm('elyh', false, false)).toThrow(/模式|mode|elyh/u)
    expect(() => resolveForm('elyh', true, false)).not.toThrow(/inboundPending/u)
  })
})

describe('Ayla backend address', () => {
  it('accepts the default same-machine backend', () => {
    expect(DEFAULT_BASE_URL).toBe('http://127.0.0.1:8100')
    expect(assertBaseUrl(DEFAULT_BASE_URL).origin).toBe('http://127.0.0.1:8100')
  })

  it('accepts plaintext on loopback and the private ranges', () => {
    for (const url of [
      'http://127.0.0.1:8100',
      'http://127.0.0.5',
      'http://localhost:8100',
      'http://LOCALHOST:8100',
      'http://[::1]:8100',
      'http://10.0.0.9:8100',
      'http://172.16.0.1',
      'http://172.31.255.254',
      'http://192.168.1.7:8100',
      '  http://127.0.0.1:8100\n',
    ]) {
      expect(assertBaseUrl(url).protocol).toBe('http:')
    }
  })

  it('refuses plaintext anywhere else', () => {
    for (const url of [
      'http://example.com',
      'http://8.8.8.8',
      'http://172.15.0.1',
      'http://172.32.0.1',
      'http://192.169.1.1',
      'http://11.0.0.1',
    ]) {
      expect(() => assertBaseUrl(url)).toThrow(/loopback|私网/u)
    }
  })

  it('accepts https for any host', () => {
    expect(assertBaseUrl('https://ayla.example.com').protocol).toBe('https:')
    expect(assertBaseUrl('https://192.168.1.7:8443').protocol).toBe('https:')
  })

  it('refuses a scheme, an empty value, and an unparsable address', () => {
    expect(() => assertBaseUrl('')).toThrow(/为空/u)
    expect(() => assertBaseUrl('   ')).toThrow(/为空/u)
    expect(() => assertBaseUrl('ws://127.0.0.1:8100')).toThrow(/http/u)
    expect(() => assertBaseUrl('ftp://127.0.0.1')).toThrow(/http/u)
    expect(() => assertBaseUrl('127.0.0.1:8100')).toThrow(/URL/u)
    expect(() => assertBaseUrl('not a url')).toThrow(/URL/u)
  })

  it('refuses credentials embedded in the address so they cannot reach a log', () => {
    expect(() => assertBaseUrl('https://user:secret@ayla.example.com')).toThrow(/username|password/u)
    expect(() => assertBaseUrl('http://user@127.0.0.1:8100')).toThrow(/username|password/u)
  })

  it('treats only loopback and private IPv4 as local', () => {
    expect(isLoopbackOrPrivateHost('localhost')).toBe(true)
    expect(isLoopbackOrPrivateHost('[::1]')).toBe(true)
    expect(isLoopbackOrPrivateHost('::1')).toBe(true)
    expect(isLoopbackOrPrivateHost('192.168.1.1')).toBe(true)
    expect(isLoopbackOrPrivateHost('example.com')).toBe(false)
    expect(isLoopbackOrPrivateHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackOrPrivateHost('256.1.1.1')).toBe(false)
    expect(isLoopbackOrPrivateHost('')).toBe(false)
  })
})

describe('Ayla backend address canonicalization', () => {
  it('judges the canonical host, not the spelling the operator typed', () => {
    // WHATWG URL rewrites these to 127.0.0.1, so they stay plaintext-local.
    expect(assertBaseUrl('http://0177.0.0.1:8100').hostname).toBe('127.0.0.1')
    expect(assertBaseUrl('http://0x7f.0.0.1:8100').hostname).toBe('127.0.0.1')
    expect(assertBaseUrl('http://127.1:8100').hostname).toBe('127.0.0.1')
    // 010 is octal-looking but canonicalized to 8.0.0.1, which is not local.
    expect(() => assertBaseUrl('http://010.0.0.1:8100')).toThrow(/loopback|私网/u)
  })

  it('refuses an unspecified address and an IPv4-mapped IPv6 loopback', () => {
    // '0.0.0.0' names no reachable peer; '::ffff:127.0.0.1' canonicalizes to
    // '[::ffff:7f00:1]', which this check does not treat as loopback.
    expect(() => assertBaseUrl('http://0.0.0.0:8100')).toThrow(/loopback|私网/u)
    expect(() => assertBaseUrl('http://[::ffff:127.0.0.1]:8100')).toThrow(/loopback|私网/u)
    expect(assertBaseUrl('https://[::ffff:127.0.0.1]:8100').protocol).toBe('https:')
  })
})
describe('Ayla plugin wiring', () => {
  it('delivers one batch after the quiet period and starts a new one afterwards', async () => {
    const batches: string[][] = []
    const queue = createBatchQueue(async batch => { batches.push(batch.map(message => message.messageId)) }, () => {}, COLLECT_MS)
    queue.push(event('1'))
    queue.push(event('2'))
    expect(batches).toEqual([])
    await new Promise(resolve => setTimeout(resolve, COLLECT_MS + 20))
    expect(batches).toEqual([['1', '2']])
    queue.push(event('3'))
    await new Promise(resolve => setTimeout(resolve, COLLECT_MS + 20))
    expect(batches).toEqual([['1', '2'], ['3']])
    queue.stop()
  })

  it('puts a failed batch back and retries it ahead of newer arrivals', async () => {
    const errors: unknown[] = []
    const delivered: string[][] = []
    let attempts = 0
    const queue = createBatchQueue(async batch => {
      attempts++
      if (attempts === 1) throw new Error('turn failed')
      delivered.push(batch.map(message => message.messageId))
    }, error => errors.push(error), COLLECT_MS)
    queue.push(event('1'))
    await new Promise(resolve => setTimeout(resolve, COLLECT_MS + 20))
    expect(errors).toHaveLength(1)
    expect(delivered).toEqual([])
    queue.push(event('2'))
    await new Promise(resolve => setTimeout(resolve, COLLECT_MS + 20))
    expect(attempts).toBe(2)
    expect(delivered).toEqual([['1', '2']])
    queue.stop()
  })

  it('reports a repeating failure once instead of on every retry', async () => {
    const errors: unknown[] = []
    const queue = createBatchQueue(async () => { throw new Error('same failure') }, error => errors.push(error), COLLECT_MS)
    queue.push(event('1'))
    await new Promise(resolve => setTimeout(resolve, (COLLECT_MS + 10) * 3))
    expect(errors).toHaveLength(1)
    queue.stop()
  })

  it('defaults the quiet period to the documented collect window', () => {
    expect(STANDALONE_COLLECT_MS).toBe(1200)
  })

  it('drops everything once stopped', async () => {
    const batches: string[][] = []
    const queue = createBatchQueue(async batch => { batches.push(batch.map(message => message.messageId)) }, () => {}, COLLECT_MS)
    queue.push(event('1'))
    queue.stop()
    queue.push(event('2'))
    await new Promise(resolve => setTimeout(resolve, COLLECT_MS + 20))
    expect(batches).toEqual([])
  })

  it('remembers delivered message ids only up to its capacity', () => {
    const seen = new Set<string>()
    rememberDelivered(seen, 'a')
    expect(seen.has('a')).toBe(true)
    for (let index = 0; index < 600; index++) rememberDelivered(seen, 'id-' + String(index))
    expect(seen.size).toBeLessThanOrEqual(512)
    expect(seen.has('id-599')).toBe(true)
    // The oldest entries are the ones dropped.
    expect(seen.has('a')).toBe(false)
  })
})
