import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inboundEventText } from '../src/inbound.ts'
import { InboundPending, takeConversationBatch } from '../src/pending.ts'

afterEach(() => { vi.useRealTimers() })

describe('pending conversation batch', () => {
  it('drains one conversation and leaves the other queued', () => {
    const taken = takeConversationBatch([
      { conversation: 'qq:private:1', text: '第一句' },
      { conversation: 'feishu:private:ou_a', text: '飞书' },
      { conversation: 'qq:private:1', text: '第二句' },
    ])
    expect(taken.batch.map(item => item.text)).toEqual(['第一句', '第二句'])
    expect(taken.rest.map(item => item.text)).toEqual(['飞书'])
  })

  it('restarts the quiet window when an admitted image event arrives', async () => {
    vi.useFakeTimers()
    const pending = new InboundPending(new Context())
    const turn = vi.fn().mockResolvedValue(undefined)
    pending.replyWith(turn)
    const message = {
      channel: 'kook', conversation: 'kook:direct:1', senderId: '1', senderName: 'Ayer',
    }
    const attachment = {
      attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 8, width: 1, height: 1,
    } as const
    pending.receive({ ...message, messageId: 'm1', content: [{ type: 'text', text: '爱莉' }] })
    await vi.advanceTimersByTimeAsync(600)
    pending.receive({ ...message, messageId: 'm2', content: [{ type: 'image', attachment }] })
    await vi.advanceTimersByTimeAsync(600)
    expect(turn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(turn).toHaveBeenCalledOnce()
    expect(turn.mock.calls[0]?.[0].map(inboundEventText)).toEqual(['爱莉', ''])
    expect(turn.mock.calls[0]?.[0][1].content).toEqual([{ type: 'image', attachment }])
    pending.stop()
  })

  it('requeues the same admitted event after a failed batch', async () => {
    vi.useFakeTimers()
    const pending = new InboundPending(new Context())
    const turn = vi.fn().mockRejectedValueOnce(new Error('resume failed')).mockResolvedValue(undefined)
    pending.replyWith(turn)
    const content = [{ type: 'text', text: '爱莉' }] as const
    pending.receive({
      channel: 'kook', conversation: 'kook:direct:1', senderId: '1', senderName: 'Ayer',
      messageId: 'm1', content,
    })
    await vi.advanceTimersByTimeAsync(1200)
    expect(turn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1200)
    expect(turn).toHaveBeenCalledTimes(2)
    expect(turn.mock.calls[1]?.[0][0].content).toBe(content)
    pending.stop()
  })
})
