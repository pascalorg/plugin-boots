import type { AnyNodeDefinition, Plugin } from '@pascal-app/core'
import { BOOTS_ICON } from './art'
import { jobDefinition } from './definition'

/** Structural mirror of the host's panel registration type — the host reads
 * the manifest duck-typed via `loadPlugin`, so no private import is needed. */
type PluginHostPanel = {
  id: string
  label: string
  icon: { kind: 'url'; src: string }
  component: () => Promise<{ default: React.ComponentType }>
  pluginId: string
  description: string
  creator: {
    name: string
    url?: string
  }
  pluginUrl: string
  defaultInstalled: boolean
}

/**
 * The Boots plugin manifest — the entire public surface of this package.
 * A host loads it through the same `loadPlugin` path the built-ins use:
 * one node kind today (`boots:job`, the punch-list cone) and one left-rail
 * panel (`Boots`) that clocks you into first person.
 */
export const bootsPlugin: Plugin = {
  id: 'pascal:boots',
  apiVersion: 1,
  nodes: [jobDefinition as unknown as AnyNodeDefinition],
}

export const bootsHostPanel: PluginHostPanel = {
  id: 'pascal:boots:panel',
  label: 'Boots',
  icon: { kind: 'url', src: BOOTS_ICON },
  component: () => import('./panel'),
  pluginId: bootsPlugin.id,
  description:
    "Alpha access — new and evolving fast. It's a game: jump in and the editor becomes a first-person shooter set in the building you're editing. Break the walls, hold off the machines, keep what you build. Bring your construction boots. ⚠ Not OSHA compliant. Esc, and nothing happened.",
  creator: {
    name: 'Pascal',
    url: 'https://github.com/pascalorg',
  },
  pluginUrl: 'https://github.com/pascalorg/plugin-boots',
  defaultInstalled: false,
}

export { jobDefinition } from './definition'
export { JobKind, JobNode, JobStatus } from './schema'
