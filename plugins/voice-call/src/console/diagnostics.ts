/** Only fixed engineering facts may cross into visible startup diagnostics. */
export const START_STAGE_LABELS = {
  audio_prepare:'播放器准备', microphone:'麦克风获取', webrtc_offer:'实时连接准备',
  ice_gathering:'连接地址收集', server_start:'服务器初始化', webrtc_answer:'实时连接确认',
} as const
export type VoiceStartStage = keyof typeof START_STAGE_LABELS
const serverCodes = [
  'start_failed','start_failed_breeze_config','start_failed_agent_prepare','start_failed_credential_resolve',
  'start_failed_provider_create','start_failed_call_ready','start_timeout','persistence_failed','start_aborted','cleanup_failed',
  'disabled','credential_missing','credential_not_configured','call_busy','start_history_limit','start_ended',
  'invalid_request','invalid_sdp','invalid_body','invalid_body_size','invalid_content_type','privacy_confirmation_required',
  'operation_timeout','operation_aborted','unauthorized_capability','invalid_capability','voice_operation_failed',
] as const
export type SafeServerCode = typeof serverCodes[number]
const serverCodeSet = new Set<string>(serverCodes)
const exceptionNames = new Set([
  'NotAllowedError','NotFoundError','NotReadableError','NotSupportedError','SecurityError','InvalidStateError',
  'AbortError','TimeoutError','OverconstrainedError','OperationError','InvalidAccessError','SyntaxError',
])
export function safeServerCode(value: unknown): SafeServerCode | null {
  return typeof value === 'string' && serverCodeSet.has(value) ? value as SafeServerCode : null
}
export function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : null
}
/** No response body, upstream message, cause, URL, request data or original stack is retained. */
export class SafeVoiceHttpError extends Error {
  readonly httpStatus: number | null
  readonly serverCode: SafeServerCode | null
  readonly upstreamStatus: number | null
  constructor(status: unknown, code?: unknown, upstreamStatus?: unknown) {
    super('voice_http_failed')
    this.name = 'SafeVoiceHttpError'
    this.httpStatus = safeHttpStatus(status)
    this.serverCode = safeServerCode(code)
    this.upstreamStatus = safeHttpStatus(upstreamStatus)
    Object.freeze(this)
  }
}
export interface VoiceStartDiagnostic {
  readonly stage: VoiceStartStage
  readonly kind: 'browser' | 'http' | 'unknown'
  readonly exceptionName: string | null
  readonly httpStatus: number | null
  readonly serverCode: SafeServerCode | null
  readonly upstreamStatus: number | null
}
export function diagnoseStart(stage: VoiceStartStage, error: unknown): VoiceStartDiagnostic {
  if (error instanceof SafeVoiceHttpError) return Object.freeze({
    stage,kind:'http',exceptionName:null,httpStatus:safeHttpStatus(error.httpStatus),
    serverCode:safeServerCode(error.serverCode),upstreamStatus:safeHttpStatus(error.upstreamStatus),
  })
  let exceptionName: string | null = null
  try {
    const name: unknown = error !== null && typeof error === 'object' && 'name' in error ? error.name : null
    if (typeof name === 'string' && exceptionNames.has(name)) exceptionName = name
  } catch { /* Even an exception getter is not trusted diagnostic data. */ }
  return Object.freeze({stage,kind:exceptionName ? 'browser' : 'unknown',exceptionName,httpStatus:null,serverCode:null,upstreamStatus:null})
}
export function describeStartDiagnostic(value: VoiceStartDiagnostic): string {
  if (value.stage === 'server_start') {
    switch (value.serverCode) {
      case 'start_failed_breeze_config': return '服务器加载语音配置失败。'
      case 'start_failed_agent_prepare': return '服务器准备爱莉的独立通话会话失败。'
      case 'start_failed_credential_resolve': return '服务器读取通话模型凭据失败。'
      case 'start_failed_provider_create': return '服务器建立模型实时连接失败。'
      case 'start_timeout': return '服务器建立通话超时。'
      case 'start_failed_call_ready': return '服务器确认通话就绪时失败。'
      case 'persistence_failed': return '服务器保存通话所需记录失败。'
      case 'cleanup_failed': return '服务器清理上一轮通话资源失败。'
      case 'credential_missing': case 'credential_not_configured': return '服务器尚未配置可用的通话模型凭据。'
      case 'disabled': return '服务器尚未启用实时通话。'
      case 'call_busy': return '服务器已有尚未结束的通话，请稍后刷新状态。'
      case 'start_aborted': return '服务器初始化通话的过程已中止。'
    }
    if (value.exceptionName === 'TimeoutError') return '等待服务器建立通话超时，未收到回应。'
    if (value.httpStatus === 429) return '服务器请求被限流，通话未建立。'
    if (value.kind === 'http') return '服务器返回了失败状态，具体原因未知。'
    return '请求服务器建立通话时失败，具体原因未知。'
  }
  if (value.stage === 'audio_prepare') {
    if (value.exceptionName === 'NotAllowedError') return '浏览器未允许本次声音播放，通话尚未开始。'
    if (value.exceptionName === 'SecurityError') return '浏览器安全策略阻止了播放器准备，通话尚未开始。'
    if (value.exceptionName === 'NotSupportedError') return '浏览器不支持当前播放器所需的音频能力。'
    return '播放器准备阶段失败，具体原因未知。'
  }
  if (value.stage === 'microphone') {
    if (value.exceptionName === 'NotAllowedError' || value.exceptionName === 'SecurityError') return '浏览器未允许使用麦克风，通话尚未开始。'
    if (value.exceptionName === 'NotFoundError') return '没有找到可用的麦克风。'
    if (value.exceptionName === 'NotReadableError') return '浏览器暂时无法读取麦克风。'
    return '获取麦克风阶段失败，具体原因未知。'
  }
  if (value.stage === 'ice_gathering' && value.exceptionName === 'TimeoutError') return '实时连接地址收集超时，通话未建立。'
  return START_STAGE_LABELS[value.stage] + '阶段失败，具体原因未知。'
}
