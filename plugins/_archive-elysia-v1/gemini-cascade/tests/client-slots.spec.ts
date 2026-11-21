import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { MAIN_SESSION_ID, SESSION_ID } from '../src/client/protocol.ts'

it('adds main controls to the native composer without taking over the editor', () => {
  type Slot = {
    name: string
    inject?: (sessionId: string) => unknown
    select?: (props: { sessionId: string; pendingInteraction: unknown }) => unknown
  }
  const rows = new Map<string, Slot>()
  const openSession = vi.fn()
  const publish = vi.fn()
  apply({
    effect: vi.fn(), on: vi.fn(), uiWorkspace: { openSession },
    uiSession: { registerPendingInteraction: () => publish },
    slots: {
      inject: (_name, register) => register(),
      register: (options) => { rows.set(options.name, options); return () => {} },
    },
  })
  const button = rows.get('conversation.input.right')!.inject!
  expect(button(MAIN_SESSION_ID)).toEqual({ sessionId: MAIN_SESSION_ID })
  expect(button(SESSION_ID)).toEqual({ sessionId: SESSION_ID })
  expect(button('ordinary-session')).toEqual({})
  const mainControls = rows.get('conversation.input.dock')!.inject!
  expect(mainControls(MAIN_SESSION_ID)).toEqual({ current: true })
  expect(mainControls(SESSION_ID)).toEqual({ current: false })
  const mainHangup = rows.get('conversation.session.header.utilities')!.inject!
  expect(mainHangup(MAIN_SESSION_ID)).toEqual({ current: true })
  expect(mainHangup('ordinary-session')).toEqual({ current: false })
  const selectTakeover = rows.get('conversation.composer')!.select!
  expect(selectTakeover({ sessionId: MAIN_SESSION_ID, pendingInteraction: { kind: 'approval' } })).toBeNull()
  expect(openSession).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})
