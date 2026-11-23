/**
 * Two fixture tools that prove the catalog and the gate without shipping a
 * real channel, file, or scheduling tool.
 *
 * The Host does not register either one: a provider declares them through
 * `ctx.capabilityHost.registerTool()`. Both are extensions, so they are off
 * until the panel switches them on, and the global one is exercised by the
 * gate spec while the agent-scoped one is exercised by the Capability Set spec.
 *
 * @module @elysia/capability-host/probe-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCatalogEntry } from './contracts.ts'

const GLOBAL_DESCRIPTION = 'Report that the capability panel gate resolved this tool as enabled for this step.'

const AGENT_DESCRIPTION = 'Report that a Capability Set mounted this agent-scoped tool for the current agent scope.'

/** A global-scope fixture gated by the step `when` condition. */
export const GLOBAL_PROBE_TOOL: ToolCatalogEntry = {
  id: 'elysia_probe',
  scope: 'global',
  description: GLOBAL_DESCRIPTION,
  required: [],
  failureMode: 'closed',
  factory: () => defineTool({
    name: 'elysia_probe',
    description: GLOBAL_DESCRIPTION,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => 'probe:global',
  }),
}

/** An agent-scoped fixture a Capability Set row mounts into its scope. */
export const AGENT_PROBE_TOOL: ToolCatalogEntry = {
  id: 'elysia_agent_probe',
  scope: 'agent',
  description: AGENT_DESCRIPTION,
  required: [],
  failureMode: 'closed',
  factory: () => defineTool({
    name: 'elysia_agent_probe',
    description: AGENT_DESCRIPTION,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => 'probe:agent',
  }),
}
