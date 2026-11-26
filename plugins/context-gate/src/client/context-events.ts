/**
 * Cross-view change contract for the context gate. Both context views live in
 * the same browser origin; a subscription change made in one wakes the other
 * immediately without polling.
 *
 * The window event covers components in one document; the BroadcastChannel
 * covers two open browser tabs/windows. The Host remains the source of truth.
 *
 * @module @elysia/context-gate/client/context-events
 */

/** Browser event dispatched after a context subscription changes. */
export const CONTEXT_CHANGED_EVENT = 'elysia:context-gate-changed'

/** BroadcastChannel used across open tabs/windows of the same origin. */
export const CONTEXT_CHANGED_CHANNEL = 'elysia:context-gate-changed'

/**
 * Notify every open context view in this browser origin. Called after a
 * successful `setContext`; the originating view also refreshes itself.
 */
export function notifyContextChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CONTEXT_CHANGED_EVENT))
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CONTEXT_CHANGED_CHANNEL)
    channel.postMessage({ type: 'changed' })
    channel.close()
  }
}

/**
 * Subscribe one view to both same-document and cross-tab context changes.
 * @param listener - called after another view writes a subscription.
 * @returns cleanup for the window listener and BroadcastChannel.
 */
export function subscribeContextChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onEvent = (): void => { listener() }
  window.addEventListener(CONTEXT_CHANGED_EVENT, onEvent)
  let channel: BroadcastChannel | undefined
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CONTEXT_CHANGED_CHANNEL)
    channel.onmessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data === 'object' && event.data !== null
        && (event.data as { type?: unknown }).type === 'changed') listener()
    }
  }
  return () => {
    window.removeEventListener(CONTEXT_CHANGED_EVENT, onEvent)
    channel?.close()
  }
}