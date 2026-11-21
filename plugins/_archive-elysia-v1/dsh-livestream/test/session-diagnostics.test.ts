import { describe,expect,it } from 'vitest'
import { sessionFailureDetails } from '../src/dsh/session'
describe('content-free fixed-session failure diagnostics',()=>{
  it('retains technical type/code/origin but no message, payload, or arbitrary URL',()=>{
    const error=Object.assign(new Error('fixture credential and private prompt must not escape'),{code:'EACCES'})
    error.stack='Error: fixture credential and private prompt must not escape\n at setup (/home/ayerelysia/Elysia/Elysium/Elysia-Harness/plugins/dsh-livestream/src/dsh/agent.ts:210:5)\n at https://fixture.invalid/?token=hidden'
    const detail=sessionFailureDetails(error)
    expect(detail).toEqual({name:'Error',code:'EACCES',origin:'plugins/dsh-livestream/src/dsh/agent.ts:210:5'})
    expect(JSON.stringify(detail)).not.toContain('credential')
    expect(JSON.stringify(detail)).not.toContain('token')
  })
  it('reports nested technical cause names with bounded depth and hides thrown strings',()=>{
    const inner=new TypeError('fixture private body')
    const result=sessionFailureDetails(new AggregateError([inner,'fixture secret'],'fixture hidden aggregate'))
    expect(result.name).toBe('AggregateError')
    expect(result.causes).toMatchObject([{name:'TypeError'},{name:'UnknownThrownValue'}])
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
