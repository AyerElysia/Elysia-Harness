import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME_BYTES, MAX_TEXT_BYTES, PROTOCOL_VERSION,
  buildAck, buildPing, buildReply, buildResume, parseFrame,
} from '../src/protocol.ts'

function inboundMessage() {
  return {
    id: '90211',
    conversation_id: '17',
    conversation_type: 'private',
    sender_id: '8d9c72a75f634ff1b4980f504c375f8b',
    sender_name: '小希',
    sent_at: '2026-11-09T16:20:00+08:00',
    parts: [
      { type: 'text', text: '好了，我吃完了' },
      { type: 'image', media_id: 'a1b2c3d4', media_type: 'image/png' },
    ],
  }
}

/** A wire frame around one message object, so a test can drop or retype fields. */
function frameWithMessage(message: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, type: 'inbound', seq: 1024, message, ...overrides })
}

function messageWith(overrides: Record<string, unknown>) {
  return { ...inboundMessage(), ...overrides }
}

function frame(overrides: Record<string, unknown> = {}, messageOverrides: Record<string, unknown> = {}) {
  return frameWithMessage(messageWith(messageOverrides), overrides)
}

/** Pad a frame to exactly 'total' UTF-8 bytes with one ignored top-level field. */
function padTo(text: string, total: number): string {
  const baseBytes = Buffer.byteLength(text, 'utf8')
  const open = Buffer.byteLength(',"padding":"', 'utf8')
  const close = Buffer.byteLength('"}', 'utf8')
  const padding = total - baseBytes + 1 - open - close
  if (padding < 0) throw new Error('frame already larger than the target')
  return text.slice(0, -1) + ',"padding":"' + 'x'.repeat(padding) + '"}'
}

describe('Ayla inbound frames', () => {
  it('reads text and image parts in the order Ayla sent them', () => {
    expect(parseFrame(frame())).toEqual({
      v: 1,
      type: 'inbound',
      seq: 1024,
      message: inboundMessage(),
    })
  })

  it('keeps a text-only message when it is the whole message', () => {
    expect(parseFrame(frame({}, { parts: [{ type: 'text', text: '在吗' }] }))).toMatchObject({
      type: 'inbound',
      seq: 1024,
      message: { parts: [{ type: 'text', text: '在吗' }] },
    })
  })

  it('reads the group conversation type', () => {
    expect(parseFrame(frame({}, { conversation_id: '42', conversation_type: 'group' })))
      .toMatchObject({ message: { conversation_type: 'group', conversation_id: '42' } })
  })

  it('rejects the whole message when one part cannot be presented', () => {
    const voice = frame({}, {
      parts: [{ type: 'text', text: '听一下' }, { type: 'voice', media_id: 'v1' }],
    })
    expect(parseFrame(voice)).toBeUndefined()
  })

  it('rejects a message with no parts and an unknown conversation type', () => {
    expect(parseFrame(frame({}, { parts: [] }))).toBeUndefined()
    expect(parseFrame(frame({}, { conversation_type: 'channel' }))).toBeUndefined()
  })

  it('rejects messages missing a required field', () => {
    for (const field of ['id', 'conversation_id', 'sender_id', 'sent_at', 'conversation_type']) {
      const message: Record<string, unknown> = inboundMessage()
      delete message[field]
      expect(parseFrame(frameWithMessage(message))).toBeUndefined()
    }
    const withoutParts: Record<string, unknown> = inboundMessage()
    delete withoutParts.parts
    expect(parseFrame(frameWithMessage(withoutParts))).toBeUndefined()
    expect(parseFrame(frame({}, { sender_name: 7 }))).toBeUndefined()
    expect(parseFrame(JSON.stringify({ v: 1, type: 'inbound', seq: 1024 }))).toBeUndefined()
    expect(parseFrame(JSON.stringify({ v: 1, type: 'inbound', seq: 1024, message: 'text' }))).toBeUndefined()
  })

  it('rejects a sequence number that is not a positive integer', () => {
    for (const seq of [0, -1, 1.5, '1024', null]) {
      expect(parseFrame(frame({ seq }))).toBeUndefined()
    }
  })

  it('rejects an image part without a media id or media type', () => {
    expect(parseFrame(frame({}, { parts: [{ type: 'image', media_type: 'image/png' }] }))).toBeUndefined()
    expect(parseFrame(frame({}, { parts: [{ type: 'image', media_id: 'a1' }] }))).toBeUndefined()
  })
})

describe('Ayla frame limits', () => {
  it('accepts the largest frame the protocol allows and rejects one byte more', () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024)
    const exact = padTo(frame(), MAX_FRAME_BYTES)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_FRAME_BYTES)
    expect(parseFrame(exact)).toMatchObject({ type: 'inbound' })
    expect(parseFrame(padTo(frame(), MAX_FRAME_BYTES + 1))).toBeUndefined()
  })

  it('rejects text above 32 KiB even though the frame fits', () => {
    expect(MAX_TEXT_BYTES).toBe(32 * 1024)
    expect(parseFrame(frame({}, { parts: [{ type: 'text', text: 'a'.repeat(MAX_TEXT_BYTES) }] })))
      .toMatchObject({ type: 'inbound' })
    expect(parseFrame(frame({}, { parts: [{ type: 'text', text: 'a'.repeat(MAX_TEXT_BYTES + 1) }] })))
      .toBeUndefined()
  })

  it('measures the text limit in UTF-8 bytes, not characters', () => {
    const threeByte = '爱'.repeat(Math.floor(MAX_TEXT_BYTES / 3))
    expect(parseFrame(frame({}, { parts: [{ type: 'text', text: threeByte }] }))).toMatchObject({ type: 'inbound' })
    expect(parseFrame(frame({}, { parts: [{ type: 'text', text: threeByte + '爱爱' }] }))).toBeUndefined()
  })
})

describe('Ayla frame version and type', () => {
  it('only speaks version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    for (const v of [0, 2, '1', null, undefined]) {
      expect(parseFrame(frame({ v }))).toBeUndefined()
    }
  })

  it('returns undefined for a frame type it does not know', () => {
    expect(parseFrame(JSON.stringify({ v: 1, type: 'typing', conversation_id: '17' }))).toBeUndefined()
    expect(parseFrame(JSON.stringify({ v: 1 }))).toBeUndefined()
  })

  it('returns undefined for text that is not JSON or not an object', () => {
    expect(parseFrame('not json')).toBeUndefined()
    expect(parseFrame('[]')).toBeUndefined()
    expect(parseFrame('null')).toBeUndefined()
    expect(parseFrame('')).toBeUndefined()
  })
})

describe('Ayla control frames', () => {
  it('reads ping and pong', () => {
    expect(parseFrame(JSON.stringify({ v: 1, type: 'ping' }))).toEqual({ v: 1, type: 'ping' })
    expect(parseFrame(JSON.stringify({ v: 1, type: 'pong' }))).toEqual({ v: 1, type: 'pong' })
  })

  it('reads an ack and a resume', () => {
    expect(parseFrame(JSON.stringify({ v: 1, type: 'ack', seq: 7 }))).toEqual({ v: 1, type: 'ack', seq: 7 })
    expect(parseFrame(JSON.stringify({ v: 1, type: 'resume', seq: 7 }))).toEqual({ v: 1, type: 'resume', seq: 7 })
    expect(parseFrame(JSON.stringify({ v: 1, type: 'ack', seq: 0 }))).toBeUndefined()
  })

  it('reads an error frame and keeps the send it names', () => {
    expect(parseFrame(JSON.stringify({
      v: 1, type: 'error', client_message_id: 'ayla-channel:875:1:0',
      code: 'conversation_not_found', detail: '会话不存在',
    }))).toEqual({
      v: 1, type: 'error', client_message_id: 'ayla-channel:875:1:0',
      code: 'conversation_not_found', detail: '会话不存在',
    })
    expect(parseFrame(JSON.stringify({ v: 1, type: 'error', code: 'bad_frame' })))
      .toEqual({ v: 1, type: 'error', code: 'bad_frame', detail: '' })
    expect(parseFrame(JSON.stringify({ v: 1, type: 'error', detail: '没有 code' }))).toBeUndefined()
  })
})

describe('Ayla outbound frames', () => {
  it('builds a reply whose conversation type comes from the conversation id', () => {
    expect(buildReply({
      clientMessageId: 'ayla-channel:875:1:0',
      conversation: { kind: 'private', id: '17' },
      content: '这个决定对呀',
      replyTo: '90211',
    })).toEqual({
      v: 1,
      type: 'reply',
      client_message_id: 'ayla-channel:875:1:0',
      conversation_id: '17',
      conversation_type: 'private',
      content: '这个决定对呀',
      reply_to: '90211',
    })
    expect(buildReply({
      clientMessageId: 'ayla-channel:1:2:0',
      conversation: { kind: 'group', id: '42' },
      content: '收到',
    })).toMatchObject({ conversation_type: 'group', conversation_id: '42', reply_to: null })
  })

  it('refuses to build a reply that would be rejected on the wire', () => {
    const base = {
      clientMessageId: 'ayla-channel:1:1:0',
      conversation: { kind: 'private', id: '17' },
      content: '在',
    } as const
    expect(() => buildReply({ ...base, clientMessageId: '  ' })).toThrow(/client_message_id/u)
    expect(() => buildReply({ ...base, content: '  ' })).toThrow(/正文/u)
    expect(() => buildReply({ ...base, content: 'a'.repeat(MAX_TEXT_BYTES + 1) })).toThrow(/32768/u)
  })

  it('builds ack, resume, and ping', () => {
    expect(buildAck(1024)).toEqual({ v: 1, type: 'ack', seq: 1024 })
    expect(buildResume(0)).toEqual({ v: 1, type: 'resume', seq: 0 })
    expect(buildResume(1024)).toEqual({ v: 1, type: 'resume', seq: 1024 })
    expect(buildPing()).toEqual({ v: 1, type: 'ping' })
    expect(() => buildAck(0)).toThrow(/seq/u)
    expect(() => buildResume(-1)).toThrow(/seq/u)
  })

  it('serializes every outbound frame as one JSON object with its wire fields', () => {
    expect(Object.keys(buildReply({
      clientMessageId: 'c1',
      conversation: { kind: 'group', id: '42' },
      content: '好',
    }))).toEqual(['v', 'type', 'client_message_id', 'conversation_id', 'conversation_type', 'content', 'reply_to'])
    expect(JSON.parse(JSON.stringify(buildAck(3)))).toEqual({ v: 1, type: 'ack', seq: 3 })
  })
})
