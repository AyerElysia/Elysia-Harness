/**
 * Client-safe re-export of the context-gate wire types. The browser half
 * imports the same declarations the Host composes, so a field rename cannot
 * drift between the two programs.
 *
 * @module @elysia/context-gate/client/types
 */

export type {
  AbsenceDraft, AbsencePatch, AbsenceTimer, ContextEntry, ContextOrigin, ContextSnapshot, EventLogEntry,
  EventOutcome, EventParameterOption, EventParameterSchema, EventParameterValues, EventRule, EventRuleDraft,
  EventRulePatch, RuleCondition, RuleScript, RuleTestResult, RuleTrigger, TimerDraft, TimerInstance, TimerPatch,
  TimerPreset, TimerSchedule, TimerSnapshot,
} from '../types.ts'