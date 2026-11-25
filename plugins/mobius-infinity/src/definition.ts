/**
 * The one preset definition this manager builds: a `prompt-files` child that
 * owns the prompt text, the normal time context, the tool group the operator
 * configured, and the fixed compaction group.
 *
 * The tool group is built from the record's tool ids through the code-owned
 * catalog, so a stored id always resolves to the same module and configuration
 * the create page showed.
 *
 * @module @elysia/mobius-infinity/definition
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetRecord } from './document.ts'
import { toolRowsFor } from './tool-catalog.ts'

/** Subpath of this package the preset child row mounts. */
export const PROMPT_FILES_PLUGIN = '@elysia/mobius-infinity/prompt-files'

/** Loader row id of the optional workspace-instructions child. */
export const AGENT_INSTRUCTIONS_ROW_ID = 'agent-instructions'

/** Loader row id of the prompt-files child. */
export const PROMPT_FILES_ROW_ID = 'prompt-files'

/** Loader row id of the normal time context. */
export const TIME_CONTEXT_ROW_ID = 'time-context'

/** Loader row id of the configured tool group. */
export const TOOLS_ROW_ID = 'tools'

/** Loader row id of the fixed compaction group. */
export const COMPACTION_ROW_ID = 'compaction'

/**
 * Build the definition registered for one persisted record.
 * @param record - validated manager-owned preset.
 * @returns the definition handed to `ctx.agentPresets.register()`.
 */
export function buildPresetDefinition(record: PresetRecord): PresetDefinition {
  const toolRows = toolRowsFor(record.tools)
  return {
    id: record.id,
    name: record.name,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.order === undefined ? {} : { order: record.order }),
    plugins: [
      ...(record.agentInstructions
        ? [{ id: AGENT_INSTRUCTIONS_ROW_ID, name: '@deepseek-ai/dsh-agent-instructions' }]
        : []),
      {
        id: PROMPT_FILES_ROW_ID,
        name: PROMPT_FILES_PLUGIN,
        config: {
          identity: record.identity,
          root: record.promptRoot,
          files: [...record.promptFiles],
        },
      },
      {
        id: TIME_CONTEXT_ROW_ID,
        name: '@deepseek-ai/dsh-time-context',
      },
      // A chat-only face composes no tool group at all: an empty group would
      // mount nothing and only obscure that the preset has no tools.
      ...(toolRows.length === 0
        ? []
        : [{
          id: TOOLS_ROW_ID,
          name: 'cordis:group',
          group: true,
          config: toolRows,
        }]),
      {
        id: COMPACTION_ROW_ID,
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          {
            id: 'compaction-basic',
            name: '@deepseek-ai/dsh-compaction-basic',
            config: { auto: true },
          },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          {
            id: 'tool-result-pruner',
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          },
        ],
      },
    ],
  }
}
