// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContextMetrics } from '../src/metrics-types.ts'
import { ContextMetricsDisplay } from '../src/client/ContextMetricsMeter.tsx'
import { consistentEstimate } from '../src/client/metrics-presentation.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)
function fixture(): ContextMetrics {
  return {
    observedSeq: 42, route: { provider: 'fixture-provider', model: 'fixture-model' }, contextWindow: 1_000_000,
    estimate: { systemTokens: 4000, toolsTokens: 1000, messageTokens: 8000, totalTokens: 13000,
      method: 'tokenizer', tokenizerLabel: 'DeepSeek V4.1 reference', incomplete: false, incompleteTypes: [] },
    latestReported: { inputTokens: 277000, uncachedInputTokens: 1000, cacheReadTokens: 275000,
      cacheWriteTokens: 1000, outputTokens: 900000, provider: 'older-provider', model: 'older-model',
      recordedAt: '2026-11-09T09:03:44.000Z', seq: 40, relationship: 'content-changed' },
  }
}
afterEach(cleanup)
function open(metrics: ContextMetrics | undefined) {
  render(createElement(ContextMetricsDisplay, { metrics, t }))
  fireEvent.click(screen.getByRole('button'))
  return screen.getByRole('dialog', { name: '上下文统计' })
}

describe('consistent context metrics display', () => {
  it('sums the current estimate and keeps a much larger historical API report separate', () => {
    const metrics = fixture()
    const dialog = open(metrics)
    const current = within(dialog).getByRole('region', { name: '当前文本 / 结构估算' })
    const past = within(dialog).getByRole('region', { name: '最近请求 API 实报输入' })
    expect(current.textContent).toContain('~' + (13000).toLocaleString())
    expect(current.textContent).not.toContain((277000).toLocaleString())
    expect(current.textContent).toContain('系统 + 工具 + 消息 = 上方估算总量。')
    expect(past.textContent).toContain((277000).toLocaleString() + ' tokens')
    expect(past.textContent).toContain('实报来源：未知调用')
    expect(past.textContent).toContain('缓存读取')
    expect(past.textContent).not.toContain((900000).toLocaleString())
    expect(past.textContent).toContain('历史实报：输入已变化，不代表当前用量。')
    expect(past.querySelector('time')?.textContent).toBe(metrics.latestReported?.recordedAt)
    expect(past.querySelector('time')?.getAttribute('title')).toBe(metrics.latestReported?.recordedAt)
  })

  it.each(['same-context', 'content-changed', 'route-changed', 'unknown'] as const)('labels report relationship %s without changing the estimate', relationship => {
    const metrics = fixture()
    metrics.latestReported!.relationship = relationship
    open(metrics)
    expect(screen.getByText(t('metrics.relationship.' + relationship))).toBeTruthy()
    expect(screen.getByRole('button', { name: /上下文估算/ }).textContent).toContain('~13K')
  })

  it('identifies compaction usage explicitly without treating its separate input as current context', () => {
    const metrics = fixture()
    metrics.latestReported!.purpose = 'compaction'
    metrics.latestReported!.relationship = 'unknown'
    const dialog = open(metrics)
    const past = within(dialog).getByRole('region', { name: '最近请求 API 实报输入' })
    expect(past.textContent).toContain('实报来源：压缩调用')
    expect(past.textContent).toContain('实报与当前输入的对应关系尚未确认。')
    expect(screen.getByRole('button', { name: /上下文估算/ }).textContent).toContain('~13K')
    expect(screen.getByRole('button', { name: /上下文估算/ }).textContent).not.toContain('277')
  })

  it('labels incomplete attachment estimates and does not invent a complete occupancy percentage', () => {
    const metrics = fixture()
    metrics.estimate.incomplete = true
    metrics.estimate.incompleteTypes = ['image', 'fixture-extension']
    open(metrics)
    expect(screen.getByRole('button', { name: /上下文估算/ }).textContent).not.toContain('%')
    expect(screen.getByText(/附件或扩展块未完整计价/).textContent).toContain('image')
    expect(screen.getByText(/附件或扩展块未完整计价/).textContent).toContain('fixture-extension')
  })

  it('shows missing capacity and missing API reports explicitly', () => {
    const metrics = fixture()
    delete metrics.contextWindow
    delete metrics.latestReported
    metrics.estimate.method = 'heuristic'
    delete metrics.estimate.tokenizerLabel
    open(metrics)
    expect(screen.getByText('模型容量未知，暂不显示占用百分比。')).toBeTruthy()
    expect(screen.getByText('暂无 API 用量回报。')).toBeTruthy()
    expect(screen.getByText('加权字符估算')).toBeTruthy()
    expect(screen.getByRole('button', { name: /上下文估算/ }).textContent).not.toContain('%')
  })

  it('keeps unknown report route unknown instead of copying the current model', () => {
    const metrics = fixture()
    delete metrics.latestReported!.provider
    delete metrics.latestReported!.model
    const dialog = open(metrics)
    const past = within(dialog).getByRole('region', { name: '最近请求 API 实报输入' })
    expect(past.textContent).toContain('未知 / 未知')
    expect(past.textContent).not.toContain('fixture-model')
  })

  it('does not display a contradictory estimate as a valid total', () => {
    const metrics = fixture()
    metrics.estimate.totalTokens++
    expect(consistentEstimate(metrics)).toBe(false)
    open(metrics)
    expect(screen.getAllByText('上下文估算数据不一致').length).toBeGreaterThan(0)
    expect(screen.queryByText(/~13,001/)).toBeNull()
  })

  it('leaves no ownership marker while unavailable and closes the portal on loss, Escape and unmount', () => {
    const rendered = render(createElement(ContextMetricsDisplay, { metrics: undefined, t }))
    expect(document.querySelector('[data-elysia-context-meter]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    rendered.rerender(createElement(ContextMetricsDisplay, { metrics: fixture(), t }))
    fireEvent.click(screen.getByRole('button', { name: /上下文估算/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /上下文估算/ }))
    rendered.rerender(createElement(ContextMetricsDisplay, { metrics: undefined, t }))
    expect(document.querySelector('[data-elysia-context-meter]')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    rendered.rerender(createElement(ContextMetricsDisplay, { metrics: fixture(), t }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /上下文估算/ }))
    rendered.unmount()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
