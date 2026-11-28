/**
 * Isolated execution of a rule script.
 *
 * A rule script is an async function body whose return value is the condition
 * and whose throw means "do not fire". Execution happens in a worker thread
 * with a heap ceiling and a hard wall-clock budget; inside the worker the
 * script sees one frozen `context` value and the language built-ins only.
 * Node's `vm` is used as a language sandbox, not as the security boundary: the
 * worker process boundary, the memory limit, and the termination timeout are
 * what contain a failing script.
 *
 * @module @elysia/context-gate/script-runner
 */

import { Worker } from 'node:worker_threads'
import type { RuleScript } from './types.ts'
import { ContextGateError, describeError } from './errors.ts'

/** Default wall-clock budget of one script. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 1_500

/** Default worker heap ceiling. */
export const DEFAULT_SCRIPT_MEMORY_MB = 16

/** Largest accepted script source. */
export const MAX_SCRIPT_BYTES = 65_536

/** Outcome of one isolated script run. */
export type ScriptResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

/**
 * Worker program. It is a string because the package emits Host code without
 * a separate worker entry; the program uses only Node built-ins.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const { source, context, timeoutMs } = workerData
const sandbox = Object.create(null)
sandbox.context = context
sandbox.console = Object.freeze({ log() {}, warn() {}, error() {}, info() {} })
try {
  const script = new vm.Script('(async (context) => {\n' + source + '\n})', { filename: 'context-gate-rule.js' })
  const vmContext = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  const fn = script.runInContext(vmContext, { timeout: timeoutMs })
  Promise.resolve(fn(context)).then(
    value => { parentPort.postMessage({ ok: true, value: value === undefined ? null : value }) },
    error => { parentPort.postMessage({ ok: false, error: String(error && error.stack ? error.stack : error) }) },
  )
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error && error.stack ? error.stack : error) })
}
`

/**
 * Run one rule script against a frozen trigger context.
 * @param script - script body and limits.
 * @param context - trigger context exposed as the function argument.
 * @returns the script result, or its failure.
 * @throws ContextGateError `RULE_INVALID` when the script exceeds the source ceiling.
 */
export async function runRuleScript(
  script: RuleScript,
  context: unknown,
): Promise<ScriptResult> {
  if (typeof script.source !== 'string' || script.source.trim() === '') {
    throw new ContextGateError('RULE_INVALID', 'a rule script needs a non-empty source')
  }
  if (Buffer.byteLength(script.source, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new ContextGateError('RULE_INVALID', `a rule script may not exceed ${String(MAX_SCRIPT_BYTES)} bytes`)
  }
  const timeoutMs = script.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
  const memoryMb = script.memoryMb ?? DEFAULT_SCRIPT_MEMORY_MB
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new ContextGateError('RULE_INVALID', 'script.timeoutMs must be an integer from 100 to 10000')
  }
  if (!Number.isInteger(memoryMb) || memoryMb < 1 || memoryMb > 64) {
    throw new ContextGateError('RULE_INVALID', 'script.memoryMb must be an integer from 1 to 64')
  }
  let worker: Worker
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: script.source, context, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(8, memoryMb) },
      stdout: true,
      stderr: true,
    })
  } catch (error: unknown) {
    return { ok: false, error: `script worker could not start: ${describeError(error)}` }
  }
  return await new Promise<ScriptResult>((resolve) => {
    let settled = false
    const finish = (result: ScriptResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().then(() => { resolve(result) }, () => { resolve(result) })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: `script exceeded its ${String(timeoutMs)} ms budget` })
    }, timeoutMs)
    worker.once('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null
        && (message as { ok?: unknown }).ok === true) {
        finish({ ok: true, value: (message as { value?: unknown }).value })
        return
      }
      const error = typeof message === 'object' && message !== null
        ? (message as { error?: unknown }).error
        : undefined
      finish({ ok: false, error: typeof error === 'string' ? error : 'script failed' })
    })
    worker.once('error', (error: Error) => { finish({ ok: false, error: describeError(error) }) })
    worker.once('exit', (code: number) => {
      finish({ ok: false, error: `script worker exited with code ${String(code)}` })
    })
  })
}