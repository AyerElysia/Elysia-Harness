import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe,expect,it } from 'vitest'
import { composeLivestreamAgent,LIVESTREAM_SESSION_ID } from '../src/dsh/session'
import { READ_ACTIONS,WRITE_ACTIONS } from '../src/dsh/agent'

async function harness(allowedWriteActions:string[] = []) {
  const ctx=new Context()
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(ToolRuntime)
  for(const name of ['fixture-global-shell','send_dm'])ctx.tools.register(defineTool({name,description:'fixture global capability',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text' as const,text:value}]},async execute(){return 'fixture'}}))
  const agent={id:LIVESTREAM_SESSION_ID,session:{seq:0}} as unknown as Agent
  let scope!:Scope
  await ctx.plugin(Object.assign((inner:Context)=>{scope=createScope(inner,agent)},{inject:['tools','systemPrompt']}))
  await composeLivestreamAgent(scope.ctx,{baseDir:'/fixture-never-read',files:['SOUL.md'],allowedWriteActions})
  return {ctx,scope,agent}
}
describe('real native Tools contract during livestream scoped composition',()=>{
  it('hides inherited globals while retaining scoped read/playback/pass, with no default platform write',async()=>{
    const h=await harness()
    try{
      const visible=h.ctx.tools.schemas(h.agent).map(tool=>tool.name)
      for(const name of READ_ACTIONS)expect(visible).toContain(name)
      for(const name of WRITE_ACTIONS)expect(visible).not.toContain(name)
      expect(visible).not.toContain('fixture-global-shell')
      expect(h.ctx.tools.schemas().map(tool=>tool.name).sort()).toEqual(['fixture-global-shell','send_dm'])
      const other={id:SessionId('ordinary-fixture')} as Agent
      expect(h.ctx.tools.schemas(other).map(tool=>tool.name).sort()).toEqual(['fixture-global-shell','send_dm'])
      // Native API deliberately rejects a local name in a global restriction.
      expect(()=>h.scope.ctx.tools.restrict({allow:['view_profile']})).toThrow('unknown global tool')
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
