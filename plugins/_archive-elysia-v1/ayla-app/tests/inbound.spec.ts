import { describe, expect, it } from 'vitest'
import { AylaInboundRejected, inboundEventText, prepareInboundEvent } from '../src/inbound.ts'
import type { AylaAttachmentAdmission, AylaInboundDeps } from '../src/inbound.ts'
import type { InboundMessagePayload } from '../src/protocol.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

interface Recorded {
  signed: string[]
  downloaded: string[]
  admitted: unknown[]
}

function admission(options: {
  fail?: Error
  imageLimits?: { maxImageBytes: number; maxImagesPerMessage: number }
} = {}): AylaAttachmentAdmission & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    imageLimits: options.imageLimits ?? { maxImageBytes: 8 * 1024 * 1024, maxImagesPerMessage: 4 },
    async admitPromptContent(content) {
      calls.push(content)
      if (options.fail !== undefined) throw options.fail
      return content.map(part => {
        if (part.type === 'text') return part
        if (part.type === 'file') return part
        return {
          type: 'image' as const,
          attachment: {
            attachmentId: 'image-' + String(part.name ?? 'x'),
            mediaType: part.mediaType,
            bytes: 4,
            width: 1,
            height: 1,
          },
        }
      })
    },
  }
}

function deps(overrides: Partial<AylaInboundDeps> = {}): { deps: AylaInboundDeps; recorded: Recorded } {
  const recorded: Recorded = { signed: [], downloaded: [], admitted: [] }
  const attachments = admission()
  const value: AylaInboundDeps = {
    signMedia: async mediaId => {
      recorded.signed.push(mediaId)
      return 'https://cdn.example/media/' + mediaId
    },
    fetchMedia: async url => {
      recorded.downloaded.push(url)
      return { ok: true, status: 200, arrayBuffer: async () => PNG_BYTES.buffer as ArrayBuffer }
    },
    attachments,
    ...overrides,
  }
  return { deps: value, recorded }
}

function message(parts: InboundMessagePayload['parts'], overrides: Partial<InboundMessagePayload> = {}): InboundMessagePayload {
  return {
    id: '90211',
    conversation_id: '17',
    conversation_type: 'private',
    sender_id: '8d9c',
    sender_name: '小希',
    sent_at: '2026-11-09T16:20:00+08:00',
    parts,
    ...overrides,
  }
}

describe('Ayla inbound text', () => {
  it('maps one text frame onto the channel event the pending queue expects', async () => {
    const { deps: value } = deps()
    const event = await prepareInboundEvent(message([{ type: 'text', text: '好了，我吃完了' }]), value)
    expect(event).toEqual({
      channel: 'ayla',
      conversation: 'ayla:private:17',
      messageId: '90211',
      senderId: '8d9c',
      senderName: '小希',
      content: [{ type: 'text', text: '好了，我吃完了' }],
    })
  })

  it('spells a group conversation as ayla:group', async () => {
    const { deps: value } = deps()
    const event = await prepareInboundEvent(
      message([{ type: 'text', text: '在吗' }], { conversation_id: '42', conversation_type: 'group' }),
      value,
    )
    expect(event.conversation).toBe('ayla:group:42')
  })

  it('admits text without any network round trip', async () => {
    const { deps: value, recorded } = deps()
    await prepareInboundEvent(message([{ type: 'text', text: '嗯' }]), value)
    expect(recorded.signed).toEqual([])
    expect(recorded.downloaded).toEqual([])
  })
})

describe('Ayla inbound images', () => {
  it('signs the media id, downloads the URL, and admits the bytes', async () => {
    const { deps: value, recorded } = deps()
    const event = await prepareInboundEvent(message([
      { type: 'text', text: '先看' },
      { type: 'image', media_id: 'a1b2c3d4', media_type: 'image/png' },
    ]), value)
    expect(recorded.signed).toEqual(['a1b2c3d4'])
    expect(recorded.downloaded).toEqual(['https://cdn.example/media/a1b2c3d4'])
    expect(event.content).toHaveLength(2)
    expect(event.content[0]).toEqual({ type: 'text', text: '先看' })
    expect(event.content[1]).toMatchObject({ type: 'image', attachment: { mediaType: 'image/png' } })
  })

  it('keeps the original part order when text follows an image', async () => {
    const { deps: value } = deps()
    const event = await prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/jpeg' },
      { type: 'text', text: '再说' },
    ]), value)
    expect(event.content.map(part => part.type)).toEqual(['image', 'text'])
  })

  it('sends the bytes to admission as base64, never as a bare path', async () => {
    const attachments = admission()
    const { deps: value } = deps({ attachments })
    await prepareInboundEvent(message([{ type: 'image', media_id: 'a1', media_type: 'image/png' }]), value)
    const admitted = attachments.calls[0] as { type: string; data: string }[]
    expect(admitted[0]?.type).toBe('image')
    expect(admitted[0]?.data).toBe(Buffer.from(PNG_BYTES).toString('base64'))
  })
})

describe('Ayla inbound rejection', () => {
  it('refuses the whole message when admission fails, so nothing is queued', async () => {
    const attachments = admission({ fail: new Error('image too large') })
    const { deps: value } = deps({ attachments })
    await expect(prepareInboundEvent(message([
      { type: 'text', text: '看图' },
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
    ]), value)).rejects.toThrow('image too large')
  })

  it('refuses a download that is not 200 instead of admitting nothing', async () => {
    const { deps: value } = deps({
      fetchMedia: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
    })
    await expect(prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
    ]), value)).rejects.toBeInstanceOf(AylaInboundRejected)
  })

  it('refuses an image type the attachment path cannot accept', async () => {
    const { deps: value } = deps()
    await expect(prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/tiff' },
    ]), value)).rejects.toThrow(/不支持的图片类型/u)
  })

  it('refuses more images than the deployment allows', async () => {
    const attachments = admission({ imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1 } })
    const { deps: value } = deps({ attachments })
    await expect(prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
      { type: 'image', media_id: 'a2', media_type: 'image/png' },
    ]), value)).rejects.toThrow(/图片数/u)
  })

  it('refuses an image above the per-image byte limit before admitting it', async () => {
    const attachments = admission({ imageLimits: { maxImageBytes: 2, maxImagesPerMessage: 4 } })
    const { deps: value } = deps({ attachments })
    await expect(prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
    ]), value)).rejects.toThrow(/字节上限/u)
    expect(attachments.calls).toEqual([])
  })

  it('refuses an empty download', async () => {
    const { deps: value } = deps({
      fetchMedia: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
    })
    await expect(prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
    ]), value)).rejects.toThrow(/空文件/u)
  })

  it('refuses a signature response without a URL', async () => {
    const { deps: value } = deps({ signMedia: async () => '' })
    await expect(prepareInboundEvent(message([
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
    ]), value)).rejects.toThrow(/下载地址/u)
  })
})

describe('Ayla inbound logging', () => {
  it('keeps image bytes out of the text used for logs', async () => {
    const { deps: value } = deps()
    const event = await prepareInboundEvent(message([
      { type: 'text', text: '看图' },
      { type: 'image', media_id: 'a1', media_type: 'image/png' },
    ]), value)
    expect(inboundEventText(event)).toBe('看图')
    expect(inboundEventText(event)).not.toContain('iVBOR')
  })
})
