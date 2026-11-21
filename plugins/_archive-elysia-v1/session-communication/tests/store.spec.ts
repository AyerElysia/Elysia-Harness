import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CommunicationError, CommunicationStore, type SaveMessage } from '../src/store.ts'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'elysia-communication-store-'))
  const stores: CommunicationStore[] = []
  onTestFinished(() => {
    for (const store of stores) store.close()
    rmSync(home, { recursive: true, force: true })
  })
  const open = () => {
    const store = new CommunicationStore(home)
    stores.push(store)
    return store
  }
  return { open }
}

function input(overrides: Partial<SaveMessage> = {}): SaveMessage {
  return {
    senderSessionId: 'main',
    targetSessionId: 'memory',
    content: [{ type: 'text', text: '合成内部通讯材料' }],
    ...overrides,
  }
}

describe('durable Session communication outbox', () => {
  it('preserves the same identity across two hosts and explicit or native-call retries', () => {
    const { open } = fixture()
    const first = open()
    const second = open()
    const saved = first.save(input({ idempotencyKey: 'intent-1', callIdentity: 'turn-1/call-1' }))
    expect(saved.idempotentReplay).toBe(false)
    const retried = second.save(input({ idempotencyKey: 'intent-1', callIdentity: 'turn-2/call-7' }))
    expect(retried.idempotentReplay).toBe(true)
    expect(retried.message.id).toBe(saved.message.id)
    expect(first.save(input({ callIdentity: 'turn-2/call-7' })).message.id).toBe(saved.message.id)
    expect(first.save(input()).message.id).not.toBe(first.save(input()).message.id)
    expect(() => second.save(input({
      idempotencyKey: 'intent-1', content: [{ type: 'text', text: 'different request' }],
    }))).toThrowError(CommunicationError)
    expect(first.pending().filter(message => message.id === saved.message.id)).toHaveLength(1)
  })

  it('keeps delivery, model presentation, and natural turn completion as separate evidence', () => {
    const { open } = fixture()
    const store = open()
    const saved = store.save(input()).message
    expect(saved).toMatchObject({ deliveryState: 'stored', attemptCount: 0 })
    expect(saved.acceptedAt).toBeUndefined()
    expect(saved.modelPresentedAt).toBeUndefined()
    store.recordQueued(saved.id, 2000)
    expect(store.get(saved.id)).toMatchObject({ deliveryState: 'queued', queuedAt: 2000 })
    expect(store.get(saved.id)?.acceptedAt).toBeUndefined()
    store.recordAccepted(saved.id, 123, 3000)
    expect(store.pending()).toEqual([])
    expect(store.get(saved.id)?.modelPresentedAt).toBeUndefined()
    store.recordPresented(saved.id, { requestRef: 'request-1', turn: 4, step: 1, time: 4000 })
    expect(store.get(saved.id)?.endedAt).toBeUndefined()
    store.recordTurnEnd(saved.id, { turn: 4, time: 5000, reason: 'completed' })
    const reopened = open()
    expect(reopened.get(saved.id)).toMatchObject({
      id: saved.id, contentHash: saved.contentHash, deliveryState: 'accepted',
      queuedAt: 2000, acceptedAt: 3000, targetEventSeq: 123,
      requestRef: 'request-1', turn: 4, step: 1, modelPresentedAt: 4000,
      endedAt: 5000, turnEndReason: 'completed',
    })
    expect(reopened.events(saved.id).map(event => event.kind))
      .toEqual(['stored', 'queued', 'accepted', 'model-presented', 'turn-ended'])
  })

  it('retains failed work and blocks only the same sender-target lane', () => {
    const { open } = fixture()
    const store = open()
    const head = store.save(input()).message
    const later = store.save(input()).message
    const otherTarget = store.save(input({ targetSessionId: 'router' })).message
    const otherSender = store.save(input({ senderSessionId: 'router' })).message
    const retryAt = Date.now() + 60000
    store.recordFailure(head.id, { code: 'RESTORE_FAILED', message: 'synthetic failure', retryable: true }, retryAt)
    expect(store.pending(Date.now()).map(message => message.id)).toEqual([otherTarget.id, otherSender.id])
    expect(open().get(head.id)).toMatchObject({
      deliveryState: 'unknown', attemptCount: 1, nextAttemptAt: retryAt,
      lastError: { code: 'RESTORE_FAILED', retryable: true },
    })
    store.recordAccepted(otherTarget.id, 14)
    store.recordAccepted(otherSender.id, 15)
    expect(store.nextWakeAt()).toBe(retryAt)
    expect(store.pending(retryAt).map(message => message.id)).toEqual([head.id])
    store.recordAccepted(head.id, 20)
    expect(store.pending(retryAt).map(message => message.id)).toEqual([later.id])
    store.recordFailure(head.id, { code: 'STORAGE_UNAVAILABLE', message: 'late result', retryable: true }, retryAt)
    expect(store.get(head.id)).toMatchObject({ deliveryState: 'accepted', targetEventSeq: 20 })
    expect(store.get(head.id)?.lastError).toBeUndefined()
  })

  it('inherits reply conversations and rejects references that would corrupt their relation', () => {
    const { open } = fixture()
    const store = open()
    const request = store.save(input()).message
    const reply = store.save(input({
      senderSessionId: 'memory', targetSessionId: 'main', replyTo: request.id,
    })).message
    expect(reply.conversationId).toBe(request.conversationId)
    expect(store.replies(request.id).map(message => message.id)).toEqual([reply.id])
    expect(() => store.save(input({ replyTo: request.id, conversationId: 'different' })))
      .toThrowError('回复引用与讨论身份不一致')
    expect(() => store.save(input({ replyTo: 'missing' }))).toThrowError('回复引用的消息不存在')
    expect(store.replies(request.id)).toHaveLength(1)
  })

  it('keeps original accepted evidence immutable and repeated receipts idempotent', () => {
    const store = fixture().open()
    const saved = store.save(input()).message
    store.recordAccepted(saved.id, 20, 2000)
    store.recordAccepted(saved.id, 20, 3000)
    store.recordAccepted(saved.id, 25, 4000)
    store.recordQueued(saved.id, 5000)
    expect(store.get(saved.id)).toMatchObject({ acceptedAt: 2000, targetEventSeq: 20, deliveryState: 'accepted' })
    expect(store.events(saved.id).filter(event => event.kind === 'accepted')).toHaveLength(1)
    expect(store.events(saved.id).filter(event => event.kind === 'additional-acceptance')).toHaveLength(1)
    expect(() => store.recordAccepted('missing', 1)).toThrowError(CommunicationError)
  })
})
