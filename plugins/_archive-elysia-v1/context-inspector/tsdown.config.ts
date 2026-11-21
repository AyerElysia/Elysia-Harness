import { clientBundle } from '../../dsh/packages/client/tsdown.client.ts'

// Host code runs from source. Reuse the official browser factory/CSS preset
// with source inputs, building only this plugin rather than emitting DSH types.
export default clientBundle(import.meta.dirname, [])({})
  .filter(config => config.name === '@elysia/context-inspector/client')
