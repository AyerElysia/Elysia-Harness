/**
 * Client-safe re-export of the context-gate wire types. The browser half
 * imports the same declarations the Host composes, so a field rename cannot
 * drift between the two programs.
 *
 * @module @elysia/context-gate/client/types
 */

export type {
  ContextEntry, ContextOrigin, ContextSnapshot, EventLogEntry, EventOutcome,
} from '../types.ts'