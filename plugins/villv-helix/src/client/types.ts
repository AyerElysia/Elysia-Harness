/**
 * Client-safe re-export of the shared wire types. The browser half imports the
 * same declarations the Host composes, so a field rename cannot drift between
 * the two programs.
 *
 * @module @elysia/villv-helix/client/types
 */

export type {
  CapabilitySnapshot, ContextEntry, ContextEvent, ContextKindRegistration, EventLogEntry, EventOutcome,
  GateHealth, HealthStatus, HostStatus, PresetPrompt, PublishReceipt, QueueRecord, ScopeKey, ScopeRef,
  SessionRowEntry, StepGate, ToolEntry, ToolGroupEntry, ToolOrigin, ToolPresetEntry, ToolScope,
  ContextHealth, ToolHealth,
} from '../types.ts'