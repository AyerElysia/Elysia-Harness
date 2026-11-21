import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe,expect,it } from 'vitest'
import { composeLivestreamAgent,LIVESTREAM_SESSION_ID } from '../src/dsh/session'
import { DEFAULT_ACTIONS,WRITE_ACTIONS } from '../src/dsh/agent'

async function harness(allowedWriteActions:string[] = []) {
  const ctx=new Context()
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  for(const name of ['fixture-global-shell','send_dm'])ctx.tools.register(defineTool({name,description:'fixture global capability',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text' as const,text:value}]},async execute(){return 'fixture'}}))
  const agent={id:LIVESTREAM_SESSION_ID,session:{seq:0}} as unknown as Agent
  let scope!:Scope
  await ctx.plugin(Object.assign((inner:Context)=>{scope=createScope(inner,agent)},{inject:['tools','systemPrompt','sessions']}))
  await composeLivestreamAgent(scope.ctx,{baseDir:'/fixture-never-read',files:['SOUL.md'],allowedWriteActions})
  return {ctx,scope,agent}
}
describe('real native Tools contract during livestream scoped composition',()=>{
  it('limits the fixed scope to its exact capability list, including live_say and excluding private tools',async()=>{
    const h=await harness()
    try{
      const visible=h.ctx.tools.schemas(h.agent).map(tool=>tool.name)
      expect([...visible].sort()).toEqual([...DEFAULT_ACTIONS].sort())
      expect(visible).toContain('live_say')
      expect(visible).not.toContain('check_inbox')
      expect(visible).not.toContain('read_dm')
      const speech = h.ctx.tools.get('live_say', h.agent)
      expect(speech?.parameters).toMatchObject({
        required: ['text'],
        properties: {
          text: { type: 'string' },
          reply_to: { type: 'array', items: { type: 'string' } },
          expression_instruction: { type: 'string' },
          stage_mood: { type: 'string' },
        },
      })
      for(const name of WRITE_ACTIONS)expect(visible).not.toContain(name)
      expect(visible).not.toContain('fixture-global-shell')
      expect(h.ctx.tools.schemas().map(tool=>tool.name).sort()).toEqual(['fixture-global-shell','send_dm'])
      const other={id:SessionId('ordinary-fixture')} as Agent
      expect(h.ctx.tools.schemas(other).map(tool=>tool.name).sort()).toEqual(['fixture-global-shell','send_dm'])
      // Native API deliberately rejects a local name in a global restriction.
      expect(()=>h.scope.ctx.tools.restrict({allow:['view_profile']})).toThrow('unknown global tool')
    }finally{await h.ctx.fiber.dispose()}
  })
  it('records pass and concludes the native turn without sending',async()=>{
    const h=await harness()
    try{
      const result = await h.ctx.tools.execute({
        name: 'pass', callId: ToolCallId('fixture-pass'), agent: h.agent,
        arguments: { reason: 'fixture silence' }, signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: 'fixture silence', concludesTurn: true })
    }finally{await h.ctx.fiber.dispose()}
  })
  it('shows only explicitly granted local writes and removes scoped tools/restrictions on unload',async()=>{
    const h=await harness(['send_dm'])
    try{
      const visible=h.ctx.tools.schemas(h.agent).map(tool=>tool.name)
      expect(visible).toContain('send_dm')
      for(const name of WRITE_ACTIONS.filter(name=>name!=='send_dm'))expect(visible).not.toContain(name)
      expect(visible).not.toContain('game_side')
      expect(visible).not.toContain('fixture-global-shell')
      await h.scope.dispose()
      expect(h.ctx.tools.schemas(h.agent).map(tool=>tool.name).sort()).toEqual(['fixture-global-shell','send_dm'])
      expect(h.ctx.tools.get('view_profile',h.agent)).toBeUndefined()
    }finally{await h.ctx.fiber.dispose()}
  })
})
