import React from 'react'
import { VoiceController } from './controller.ts'
import { bindVoiceController, VoicePanel, VOICE_PANEL_CSS } from './panel.tsx'
export const PANEL_ID = '@elysia/voice-call'
export const inject = ['slots','layout','connection']
interface ClientContext {
  effect(effect: () => (() => void), label: string): unknown
  slots: { inject(name: string, callback: () => unknown): unknown
    register(spec: { name: string; key?: string; id?: string; order?: number; label?: () => string }, component: React.ComponentType): () => void }
}
function VoiceIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg> }
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.plugin=PANEL_ID; style.textContent=VOICE_PANEL_CSS; document.head.append(style)
    return () => style.remove()
  },'voice-call.styles')
  ctx.effect(() => { bindVoiceController(new VoiceController()); return () => bindVoiceController(null) },'voice-call.browser-owner')
  ctx.slots.inject('main',() => ctx.slots.register({name:'main',key:PANEL_ID},VoicePanel))
  ctx.slots.inject('sidebar.panellist',() => ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:3,label:()=> '实时通话'},VoiceIcon))
}
