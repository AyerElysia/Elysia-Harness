// @vitest-environment jsdom
/** Actual native InputBar DOM, synthetic hooks only: no live Session or network. */
import '../../../dsh/packages/client/ui-conversation/tests/control-row-dom.ts'
import { createElement, Fragment } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { InputBar, type InputBarProps } from '../../../dsh/packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'
import { zh as nativeZh } from '../../../dsh/packages/client/ui-conversation/src/client/locales.ts'
import { ContextMetricsDisplay } from '../src/client/ContextMetricsMeter.tsx'
import { zh } from '../src/client/locales.ts'

const style = readFileSync(resolve(import.meta.dirname, '../src/client/context-meter-compat.css'), 'utf8')
const t = makeTranslate(zh)
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); document.querySelectorAll('[data-metrics-test-style]').forEach(node => node.remove()) })

function nativeProps(enabled: boolean, ready = true): InputBarProps {
  const hook = (value: unknown) => (selector: (snapshot: unknown) => unknown) => selector(value)
  return {
    sessionId: 'fixture-session',
    variant: 'composer',
    useSession: hook({ promptError: null, running: false, subagent: null, removed: false }),
    useInput: hook({ draft: '', attachmentIds: [], phase: 'editing' }),
    useNotices: hook(null), useBusyEnter: hook('queue'), useStopShortcut: hook([]),
    useLexicon: hook(new Map()), useMenuLauncher: hook(null), useFileUploads: hook({}),
    useProjection: (key: string, selector = (value: unknown) => value) => selector(
      key === 'contextPressure' ? { projectedTokens: 277000, contextWindow: 1000000 } : undefined),
    t: makeTranslate(nativeZh),
    renderSlot: (key: string) => {
      if (key === 'conversation.input.model') return createElement('button', { 'data-fixture-model': '' }, 'fixture-model')
      if (key === 'conversation.input.left') return createElement('button', { 'data-fixture-tool': '' }, 'fixture-tool')
      if (key === 'conversation.composer.dock') return createElement(Fragment, null,
        createElement('span', { 'data-fixture-cumulative': '' }, 'fixture cumulative usage'),
        enabled ? createElement(ContextMetricsDisplay, { metrics: ready ? {
          observedSeq: 2, contextWindow: 1000000,
          estimate: { systemTokens: 4000, toolsTokens: 1000, messageTokens: 8000, totalTokens: 13000,
            method: 'heuristic', incomplete: false, incompleteTypes: [] },
        } : undefined, t }) : null)
      return null
    },
  } as unknown as InputBarProps
}

describe('pinned native InputBar meter compatibility', () => {
  it('hides only the old circular meter, keeps model/tool/cumulative controls, and restores on contribution unload', () => {
    const tag = document.createElement('style')
    tag.dataset.metricsTestStyle = ''
    tag.textContent = style
    document.head.appendChild(tag)
    const first = render(createElement(InputBar, nativeProps(true)))
    const old = first.container.querySelector('[data-composer-dock] > span:last-child')
    expect(old?.querySelector('svg[viewBox="0 0 14 14"] > circle')).toBeTruthy()
    expect(getComputedStyle(old as Element).display).toBe('none')
    for (const selector of ['[data-fixture-model]', '[data-fixture-tool]', '[data-fixture-cumulative]', '[data-elysia-context-meter]']) {
      const node = first.container.querySelector(selector)
      expect(node).toBeTruthy()
      expect(getComputedStyle(node as Element).display).not.toBe('none')
      expect((node as HTMLElement).closest('[hidden]')).toBeNull()
    }
    // Removing the official dock contribution leaves the native bar mounted.
    first.rerender(createElement(InputBar, nativeProps(false)))
    expect(first.container.querySelector('[data-elysia-context-meter]')).toBeNull()
    const restored = first.container.querySelector('[data-composer-dock] > span:last-child')
    expect(getComputedStyle(restored as Element).display).not.toBe('none')
    expect(first.container.querySelector('[data-fixture-model]')).toBeTruthy()
  })

  it('does not hide the native dock while our projection is unavailable', () => {
    const tag = document.createElement('style')
    tag.dataset.metricsTestStyle = ''
    tag.textContent = style
    document.head.appendChild(tag)
    const rendered = render(createElement(InputBar, nativeProps(true, false)))
    const nativeMeter = rendered.container.querySelector('[data-composer-dock] > span:last-child')
    expect(nativeMeter?.querySelector('svg')).toBeTruthy()
    expect(getComputedStyle(nativeMeter as Element).display).not.toBe('none')
  })
})
