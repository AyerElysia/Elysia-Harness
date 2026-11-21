import { describe, expect, it, vi } from 'vitest'
import { installElyhForm } from '../src/form-elyh.ts'
import type { InboundEvent } from '../src/inbound.ts'

function event(id: string): InboundEvent {
  return {
    channel: 'ayla',
    conversation: 'ayla:private:17',
    messageId: id,
    senderId: '8d9c',
    senderName: '小希',
    content: [{ type: 'text', text: '好了，我吃完了' }],
  }
}

function logger() {
  const errors: string[] = []
  return { errors, value: { error: (message: string) => { errors.push(message) } } }
}

describe('Ayla elyh form', () => {
  it('hands each event to the conscious mind queue and nothing else', async () => {
    const received: InboundEvent[] = []
    const log = logger()
    const turn = installElyhForm({ receive: message => { received.push(message) } }, log.value)
    await turn([event('90211'), event('90212')])
    expect(received.map(message => message.messageId)).toEqual(['90211', '90212'])
    expect(received[0]?.channel).toBe('ayla')
    expect(received[0]?.conversation).toBe('ayla:private:17')
  })

  it('registers no tool and opens no session', async () => {
    const receive = vi.fn()
    const turn = installElyhForm({ receive }, { error: () => {} })
    await turn([event('90211')])
    // The only collaboration surface is receive(); there is no ctx, no tools,
    // and no agents reference anywhere in the module's inputs.
    expect(receive).toHaveBeenCalledOnce()
    expect(Object.keys(turn)).toEqual([])
    expect(turn).toBeInstanceOf(Function)
  })

  it('attempts the rest of the batch but reports the failure so no ack is sent', async () => {
    const received: string[] = []
    const log = logger()
    const turn = installElyhForm({
      receive(message) {
        if (message.messageId === 'bad') throw new Error('queue rejected')
        received.push(message.messageId)
      },
    }, log.value)
    await expect(turn([event('bad'), event('90212')])).rejects.toThrow(/queue rejected/u)
    expect(received).toEqual(['90212'])
    expect(log.errors.join('\n')).toContain('queue rejected')
  })

  it('does not batch across the quiet period; the queue owns batching', async () => {
    const received: InboundEvent[] = []
    const turn = installElyhForm({ receive: message => { received.push(message) } }, { error: () => {} })
    await turn([event('1')])
    await turn([event('2')])
    expect(received.map(message => message.messageId)).toEqual(['1', '2'])
  })
})
