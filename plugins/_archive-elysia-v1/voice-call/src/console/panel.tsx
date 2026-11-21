import { useEffect, useState, useSyncExternalStore } from 'react'
import { VoiceController } from './controller.ts'
import { describeStartDiagnostic, START_STAGE_LABELS } from './diagnostics.ts'
let bound: VoiceController | null = null
const listeners = new Set<() => void>()
export function bindVoiceController(next: VoiceController | null): void { bound?.dispose(); bound = next; for (const listener of listeners) listener() }
export function VoicePanel() {
  const controller = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } },() => bound)
  if (!controller) return <section className="evc-panel"><h1>实时通话</h1><p>通话面板未连接。</p></section>
  return <ReadyPanel controller={controller}/>
}
const connectionLabels = {idle:'未通话',connecting:'正在连接',ready:'已连接',closing:'正在结束',ended:'已结束',failed:'连接失败'}
const microphoneLabels = {inactive:'未启用',muted:'已静音',sending:'正在发送声音'}
const generationLabels = {idle:'待命',generating:'正在生成',failed:'生成失败'}
const playbackLabels = {idle:'暂无播放',buffering:'正在缓冲',playing:'正在播放',stopped:'已停止'}
function errorLabel(code: string): string {
  if (code === 'microphone_requires_https_or_localhost') return '请通过 HTTPS 或本机地址打开，浏览器才允许使用麦克风。'
  if (code === 'microphone_disconnected') return '麦克风已断开。'
  if (code === 'voice_event_stream_timeout') return '语音下行连接长时间没有响应，已停止通话。'
  if (code === 'voice_connection_timeout') return '通话连接超时。'
  if (code === 'voice_state_unavailable') return '暂时无法读取通话状态。'
  if (code === 'privacy_confirmation_required') return '请先确认原声处理方式。'
  if (code === 'voice_start_failed') return '开始通话失败，具体原因未知。'
  return '通话出现异常，已停止麦克风与播放。'
}
function ReadyPanel({controller}: {controller:VoiceController}) {
  const view = useSyncExternalStore(controller.subscribe,controller.snapshot)
  const [privacy,setPrivacy] = useState(false)
  useEffect(() => { void controller.load(); return () => { void controller.stop(null) } },[controller])
  useEffect(() => {
    const stop = () => { void controller.stop(null) }
    window.addEventListener('pagehide',stop)
    return () => window.removeEventListener('pagehide',stop)
  },[controller])
  const active = view.starting || ['connecting','ready','closing'].includes(view.state.connection)
  const owned = view.starting || view.microphone !== 'inactive'
  return <section className="evc-panel">
    <h1>和爱莉实时通话</h1>
    <p>独立语音会话 · 只加载 SOUL · Breeze 固定音色</p>
    <p>每通最多10分钟，仅使用本通话上下文，不自动加载旧通话历史。取得的文字与活动事件会保留。</p>
    <label><input type="checkbox" checked={privacy} disabled={active} onChange={e=>setPrivacy(e.target.checked)}/> 我知悉：本程序不录音、不持久保存原声；声音会送到 OpenAI 处理，云端数据政策由其服务约定管理。</label>
    <div className="evc-actions">
      <button disabled={active || !privacy || !view.state.enabled || !view.state.credentialConfigured} onClick={()=>{void controller.start(privacy)}}>开始通话</button>
      <button disabled={!owned} onClick={()=>{void controller.setMuted(view.microphone !== 'muted')}}>{view.microphone === 'muted' ? '取消静音' : '静音'}</button>
      <button disabled={!owned} onClick={()=>{void controller.stopPlayback()}}>停止当前播放</button>
      <button disabled={!owned} onClick={()=>{void controller.stop(null)}}>挂断</button>
    </div>
    {active && view.state.callId && !owned && <p>服务器显示已有通话，但本页面没有该通话的控制权限。请回到原页面，或等待原页面的连接过期后<button onClick={()=>{void controller.load()}}>刷新状态</button>。</p>}
    {!view.state.enabled && <p>通话入口尚未启用。</p>}
    {view.state.enabled && !view.state.credentialConfigured && <p>服务器尚未配置安全模型凭据，当前不能拨号。</p>}
    <dl><dt>语音 Session</dt><dd>{view.state.sessionId}</dd>
      <dt>连接</dt><dd>{view.starting ? '准备中' : connectionLabels[view.state.connection]}</dd>
      <dt>麦克风</dt><dd>{microphoneLabels[view.microphone]}</dd><dt>生成</dt><dd>{generationLabels[view.state.generation]}</dd>
      <dt>播放</dt><dd>{playbackLabels[view.playback]}</dd></dl>
    <p>已确认用量：{view.state.usage.totalTokens} tokens{view.state.usage.complete ? '' : '（结算尚未完整）'}</p>
    {view.error && <div role="alert"><p>{view.diagnostic ? describeStartDiagnostic(view.diagnostic) : errorLabel(view.error)}不会自动重拨。</p>
      <details><summary>故障详情</summary><code>{view.error}</code>
        {view.diagnostic && <dl>
          <dt>失败阶段</dt><dd>{START_STAGE_LABELS[view.diagnostic.stage]}（{view.diagnostic.stage}）</dd>
          <dt>诊断类型</dt><dd>{view.diagnostic.kind}</dd>
          <dt>浏览器异常</dt><dd>{view.diagnostic.exceptionName ?? '未知（unknown）'}</dd>
          <dt>服务器 HTTP</dt><dd>{view.diagnostic.httpStatus ?? '—'}</dd>
          <dt>服务端代码</dt><dd>{view.diagnostic.serverCode ?? '未知（unknown）'}</dd>
          <dt>上游 HTTP</dt><dd>{view.diagnostic.upstreamStatus ?? '—'}</dd>
        </dl>}
      </details></div>}
    <h2>本轮生成文字</h2><p>生成文字不表示已经播放或听到。</p>
    <div aria-live="polite" className="evc-caption">{view.text || '开始通话后，这里显示爱莉生成的文字。'}</div>
  </section>
}
export const VOICE_PANEL_CSS = '.evc-panel{max-width:780px;padding:24px;line-height:1.6}.evc-panel h1{font-size:1.4rem}.evc-panel label{display:block}.evc-actions{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}.evc-actions button{padding:7px 12px;border:1px solid currentColor;border-radius:6px}.evc-panel dl{display:grid;grid-template-columns:100px 1fr;gap:4px}.evc-panel dd{margin:0}.evc-caption{white-space:pre-wrap;border:1px solid #8885;padding:12px;border-radius:6px}.evc-panel [role=alert]{color:#c84b4b}'
