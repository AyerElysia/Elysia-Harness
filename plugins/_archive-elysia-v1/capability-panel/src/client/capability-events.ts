/**
 * Cross-panel capability change contract. Both the preset manager page and the
 * capability panel live in the same browser origin; a state change made in one
 * of them wakes the other immediately without polling.
 *
 * The window event covers components in one document; the BroadcastChannel
 * covers two open browser tabs/windows. The Host remains the source of truth
 * and emits `capability-core/change` for server-side consumers.
 *
 * @module @elysia/capability-panel/client/capability-events
 */

/** Browser event dispatched after a capability switch changes the shared core. */
export const CAPABILITY_CHANGED_EVENT = 'elysia:capability-changed'

/** BroadcastChannel used across open tabs/windows of the same origin. */
export const CAPABILITY_CHANGED_CHANNEL = 'elysia:capability-changed'

/**
 * Notify every open capability UI in this browser origin. Called after a panel
 * write; the originating panel also refreshes its own request counter.
 */
export function notifyCapabilityChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(CAPABILITY_CHANGED_EVENT))
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CAPABILITY_CHANGED_CHANNEL)
    channel.postMessage({ type: 'changed' })
    channel.close()
  }
}

/**
 * Subscribe one UI to both same-document and cross-tab capability changes.
 * @param listener - called after another panel writes a capability switch.
 * @returns cleanup for the window listener and BroadcastChannel.
 */
export function subscribeCapabilityChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onEvent = (): void => { listener() }
  window.addEventListener(CAPABILITY_CHANGED_EVENT, onEvent)
  let channel: BroadcastChannel | undefined
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CAPABILITY_CHANGED_CHANNEL)
    channel.onmessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data === 'object' && event.data !== null
        && (event.data as { type?: unknown }).type === 'changed') listener()
    }
  }
  return () => {
    window.removeEventListener(CAPABILITY_CHANGED_EVENT, onEvent)
    channel?.close()
  }
}