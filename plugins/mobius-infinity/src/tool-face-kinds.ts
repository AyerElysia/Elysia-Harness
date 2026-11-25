/**
 * Closed tool-face families. The draft validator and the model-facing schema
 * enum both read this list, so adding a family cannot update one and miss the
 * other.
 *
 * @module @elysia/mobius-infinity/tool-face-kinds
 */

import type { ToolFaceKind } from './types.ts'

/** Every face family a preset may record. */
export const TOOL_FACE_KINDS = ['default', 'common', 'existing', 'custom'] as const satisfies readonly ToolFaceKind[]
