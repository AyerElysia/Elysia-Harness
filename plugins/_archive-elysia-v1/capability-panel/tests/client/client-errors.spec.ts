/**
 * Localized refusal copy: the Host's stable codes the panel explains itself, and
 * the verbatim fallback for a code this build does not know.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityRemoteError } from '../../src/client/api.ts'
import {
  classifyWriteFailure, describeFailure, ERROR_KEYS, STATIC_LOCKED_CODE,
} from '../../src/client/errors.ts'
import { translate } from './fixtures.ts'

describe('refusal copy', () => {
  it('maps a refused static-tool write to the preset-default explanation', () => {
    expect(STATIC_LOCKED_CODE).toBe('capabilityHost/TOOL_STATIC_LOCKED')
    expect(ERROR_KEYS[STATIC_LOCKED_CODE]).toBe('errorToolStaticLocked')
    const copy = describeFailure(new CapabilityRemoteError(STATIC_LOCKED_CODE, 'locked'), translate)
    expect(copy).toBe('预设默认工具，不能关闭。')
  })

  it('reports a static-tool refusal as a stale-view notice, not a failed gesture', () => {
    expect(classifyWriteFailure(new CapabilityRemoteError(STATIC_LOCKED_CODE, 'locked'))).toBe('static-locked')
    expect(classifyWriteFailure(new CapabilityRemoteError('capabilityHost/TOOL_UNKNOWN', 'unknown'))).toBe('failure')
    expect(classifyWriteFailure(new Error('boom'))).toBe('failure')
    expect(classifyWriteFailure('not an error')).toBe('failure')
  })

  it('keeps the host message for a code this build does not know', () => {
    const copy = describeFailure(new CapabilityRemoteError('capabilityHost/NEW_CODE', 'new host reason'), translate)
    expect(copy).toBe('new host reason')
  })

  it('falls back to the panel error copy for a non-host failure', () => {
    expect(describeFailure(new Error('boom'), translate)).toBe('boom')
    expect(describeFailure('not an error', translate)).toBe('暂时无法读取能力状态。')
  })
})