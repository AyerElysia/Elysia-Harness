/**
 * Session-header capsule for 工具编辑模式. It reads the session row's mode and
 * flips the Host state; the actual tool mask is installed by the Host.
 *
 * @module @elysia/villv-helix/client/HelixModeCapsule
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ControlPanelTranslate } from './labels.ts'
import type { VillvHelixApi } from './api.ts'
import { notifyCapabilityChanged, subscribeCapabilityChanged } from './capability-events.ts'
import css from './ControlPanelPage.module.css'

/** Registration-side face of the capsule. */
export interface HelixModeCapsuleInjected {
  readonly api: VillvHelixApi
}

/** Props assembled by the session-header slot renderer. */
export interface HelixModeCapsuleProps extends HelixModeCapsuleInjected {
  readonly t: ControlPanelTranslate
}

/** One compact mode switch in the session header. */
export function HelixModeCapsule({ api, t }: HelixModeCapsuleProps): ReactNode {
  const [mode, setMode] = useState<boolean | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.helixMode = mode === true ? 'on' : 'off'
    return () => { delete document.documentElement.dataset.helixMode }
  }, [mode])

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    const load = (): void => {
      void api.getMode(controller.signal).then(
        (enabled) => {
          if (current) setMode(enabled)
        },
        () => {
          if (current) setMode(undefined)
        },
      )
    }
    load()
    const disposeChanges = subscribeCapabilityChanged(load)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      current = false
      controller.abort()
      disposeChanges()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [api])

  const toggle = (): void => {
    if (busy || mode === undefined) return
    const next = !mode
    setBusy(true)
    void api.setMode(next, new AbortController().signal).then(
      () => {
        setMode(next)
        setBusy(false)
        notifyCapabilityChanged()
      },
      () => { setBusy(false) },
    )
  }

  const label = mode === true ? t('modeOrchestrated') : t('modeNormal')
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mode === true}
      aria-label={t('modeCapsule')}
      title={label}
      className={`${css.modeCapsule} ${mode === true ? css.modeCapsuleOn : ''}`}
      disabled={busy || mode === undefined}
      onClick={toggle}
    >
      <span className={css.modeCapsuleLabel}>{t('modeCapsule')}</span>
      <span className={css.modeSwitch} aria-hidden="true">
        <span className={css.modeSwitchThumb} />
      </span>
    </button>
  )
}