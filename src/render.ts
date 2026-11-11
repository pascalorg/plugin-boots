import type { AnyNodeDefinition, Plugin } from '@pascal-app/core'
import { jobRenderDefinition } from './definition.render'

/**
 * Render-only Boots manifest for read-only viewers: the same plugin id and
 * kinds as `bootsPlugin`, without parameters, the first-person game or the
 * host panel. Nothing reachable from this entry imports `@pascal-app/editor`
 * (`bun run check:render` holds that).
 */
export const bootsRenderPlugin = {
  id: 'pascal:boots',
  apiVersion: 1,
  nodes: [jobRenderDefinition as unknown as AnyNodeDefinition],
} satisfies Plugin

export { jobRenderDefinition } from './definition.render'
export { JobKind, JobNode, JobStatus } from './schema'
