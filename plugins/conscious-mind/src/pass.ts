/**
 * pass: the conscious mind chooses not to speak this turn. No channel is
 * touched; the reason stays in the session log as her own record.
 * @module @elysia/conscious-mind/pass
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Arguments the model supplies when choosing silence. */
export interface PassArgs {
  reason: string
}

/** Canonical tool result. Passing is always a completed choice, never a failure. */
export interface PassResult {
  passed: true
  reason: string
}

/** Model-facing pass tool. It only records; it never sends anything. */
export function definePassTool() {
  return defineTool({
    name: 'pass',
    description: '这一轮选择不说话。不调用任何渠道发送，session 里留下这次为什么不说。运行时不会强迫你调用 send_text。',
    parameters: {
      reason: { type: 'string', required: true, description: '这次选择不说话的原因，一句自然语言。' },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text' as const, text: JSON.stringify(value) }]
      },
    },
    execute(args): Promise<PassResult> {
      return Promise.resolve({ passed: true, reason: String(args.reason ?? '').trim() })
    },
  })
}
