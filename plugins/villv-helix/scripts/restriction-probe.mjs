import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, {
  workingDirectory: false,
  systemPrompt: { personaPrefix: '', personaSuffix: '' },
})
ctx.tools.register(defineTool({
  name: 'alpha_tool',
  description: 'probe',
  parameters: {},
  output: { schema: { type: 'string' }, render: () => [] },
  async execute() { return 'alpha' },
}))
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('probe'), { provider: 'mock', model: 'mock' })
const has = () => ctx.tools.schemas(agent).some(tool => tool.name === 'alpha_tool')
console.log('before', has())
const release = agent.ctx.tools.restrict({ deny: ['alpha_tool'] })
console.log('denied', has())
release()
console.log('released', has())
await new Promise(resolve => setTimeout(resolve, 10))
console.log('released-later', has())
await ctx.fiber.dispose()