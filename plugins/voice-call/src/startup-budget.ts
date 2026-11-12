/** Fixed engineering budgets; no model, credential, persona or network routing choices. */
export const LOCAL_OPERATION_TIMEOUT_MS = 10_000
export const REALTIME_OPERATION_TIMEOUT_MS = 15_000
/** Covers the complete HTTP + SDP + sideband + configuration setup, not just one hop. */
export const PROVIDER_SETUP_TIMEOUT_MS = 25_000
export const PROVIDER_CREATE_TIMEOUT_MS = PROVIDER_SETUP_TIMEOUT_MS
/** Only initialization; this timer must be removed before a call becomes ready. */
export const SERVER_START_TIMEOUT_MS = 30_000
/** One possible audit overhang, five bounded cleanup gates, and final response margin. */
export const BROWSER_START_TIMEOUT_MS = SERVER_START_TIMEOUT_MS
  + LOCAL_OPERATION_TIMEOUT_MS
  + 5 * LOCAL_OPERATION_TIMEOUT_MS
  + LOCAL_OPERATION_TIMEOUT_MS

export const STARTUP_PHASES = [
  'breeze_config', 'agent_prepare', 'credential_resolve', 'provider_create', 'call_ready',
] as const
export type StartupPhase = typeof STARTUP_PHASES[number]
export const PROVIDER_SETUP_PHASES = [
  'create_http', 'answer_sdp', 'sideband_open', 'session_configure',
] as const
export type ProviderSetupPhase = typeof PROVIDER_SETUP_PHASES[number]
