import assert from 'node:assert/strict'
import { test } from 'vitest'
import { decodeEvent, encodeText, isVoiceSession, MAIN_SESSION_ID, parseOpened, parseToken, SESSION_ID, turnErrorNotice } from '../src/client/protocol.ts'
const utf8 = new TextEncoder()
const encode = value => utf8.encode(JSON.stringify(value))
const token = {
  serverUrl: 'ws://127.0.0.1:18780',
  participantToken: 'example.' + 'x'.repeat(40),
  callToken: 't'.repeat(32),
  roomName: 'gemini-cascade-test',
}
test('reject other sessions and insecure remote endpoints', () => {
  assert.deepEqual(parseOpened({ sessionId: SESSION_ID, inputMode: 'local-asr' }), { sessionId: SESSION_ID, inputMode: 'local-asr' })
  assert.deepEqual(parseOpened({ sessionId: SESSION_ID, inputMode: 'direct-audio' }), { sessionId: SESSION_ID, inputMode: 'direct-audio' })
  assert.throws(() => parseOpened({ sessionId: 'elysia-conscious-mind', inputMode: 'local-asr' }))
  assert.throws(() => parseOpened({ sessionId: SESSION_ID }))
  assert.throws(() => parseOpened({ sessionId: SESSION_ID, inputMode: 'unknown' }))
  assert.equal(parseToken(token, '127.0.0.1').roomName, token.roomName)
  assert.equal(parseToken({ ...token, serverUrl: 'wss://dsh.example/rtc' }, 'dsh.example').roomName, token.roomName)
  for (const serverUrl of ['ws://elsewhere.test', 'https://127.0.0.1', 'wss://elsewhere.test', 'ws://a:b@127.0.0.1', 'ws://127.0.0.1/?x=1']) {
    assert.throws(() => parseToken({ ...token, serverUrl }, '127.0.0.1'))
  }
  assert.throws(() => parseToken({ ...token, callToken: '' }, '127.0.0.1'))
})
test('allows only the two native voice sessions; main can only use local ASR', () => {
  const main = { sessionId: MAIN_SESSION_ID, inputMode: 'local-asr' }
  assert.ok(isVoiceSession(MAIN_SESSION_ID))
  assert.ok(isVoiceSession(SESSION_ID))
  assert.ok(!isVoiceSession(undefined))
  assert.ok(!isVoiceSession('elysia-conscious-mind-copy'))
  assert.deepEqual(parseOpened(main, MAIN_SESSION_ID), main)
  assert.throws(() => parseOpened({ ...main, inputMode: 'direct-audio' }, MAIN_SESSION_ID))
  assert.throws(() => parseOpened({ ...main, sessionId: SESSION_ID }, MAIN_SESSION_ID))
})
test('only accepts bounded, defined worker events, never passes raw errors', () => {
  assert.deepEqual(decodeEvent(encode({ type: 'state', turn: 2, state: 'speaking' })), { type: 'state', turn: 2, state: 'speaking' })
  assert.deepEqual(decodeEvent(encode({ type: 'error', turn: 4, code: 'private' })), { type: 'error', turn: 4 })
  assert.equal(decodeEvent(encode({ type: 'delta', turn: 3, text: '只走原生消息' })), undefined)
  assert.equal(decodeEvent(encode({ type: 'done', turn: 3, text: '只走原生消息' })), undefined)
  assert.equal(decodeEvent(encode({ type: 'delta', turn: 0, text: 'x'.repeat(7000) })), undefined)
  assert.equal(decodeEvent(encode({ type: 'state', turn: 0, state: 'unknown' })), undefined)
  assert.equal(decodeEvent(encode({ type: 'done', turn: -1, text: 'x' })), undefined)
  assert.equal(decodeEvent(Uint8Array.of(0xff)), undefined)
  assert.equal(decodeEvent(new Uint8Array(13001)), undefined)
})
test('voice event exposes only whether final transcription is present, never its body', () => {
  assert.deepEqual(decodeEvent(encode({ type: 'state', turn: 2, state: 'transcribing' })), { type: 'state', turn: 2, state: 'transcribing' })
  assert.deepEqual(decodeEvent(encode({ type: 'user', turn: 2, input: 'voice', text: '  你好  ' })), { type: 'user', turn: 2, input: 'voice', hasTranscript: true })
  for (const text of [undefined, '  ', '字'.repeat(2001), ['invalid']]) {
    assert.deepEqual(decodeEvent(encode({ type: 'user', turn: 2, input: 'voice', text })), { type: 'user', turn: 2, input: 'voice', hasTranscript: false })
  }
  assert.deepEqual(decodeEvent(encode({ type: 'user', turn: 2, input: 'text', text: '只在原生会话显示' })), { type: 'user', turn: 2, input: 'text' })
})
test('distinguishes slow model replies, local ASR, and Breeze failure without displaying raw details', () => {
  const event = decodeEvent(encode({ type: 'error', turn: 5, code: 'gemini_timeout' }))
  assert.equal(event.code, 'gemini_timeout')
  assert.match(turnErrorNotice(event.code), /未及时/u)
  assert.match(turnErrorNotice('breeze_failed'), /语音未能合成/u)
  assert.match(turnErrorNotice('asr_no_speech'), /没有识别到文字/u)
  assert.match(turnErrorNotice('asr_timeout'), /识别超时/u)
  assert.deepEqual(decodeEvent(encode({ type: 'error', turn: 2, code: 'asr_busy' })), { type: 'error', turn: 2, code: 'asr_busy' })
  assert.deepEqual(decodeEvent(encode({ type: 'error', turn: 2, code: 'asr_unexpected_private' })), { type: 'error', turn: 2 })
  assert.ok(!turnErrorNotice('private upstream error').includes('private'))
})
test('text payload caps bytes not JS length and ignores blank input', () => {
  assert.equal(encodeText('    '), undefined)
  assert.equal(encodeText('字'.repeat(683)), undefined)
  assert.ok(encodeText('字'.repeat(682)))
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encodeText('  你好  '))), { type: 'text', text: '你好' })
})
