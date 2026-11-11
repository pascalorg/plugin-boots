import type { NodeDefinition } from '@pascal-app/core'
import type { JobNode } from './schema'

/**
 * The editing half of the job-marker definition: the item snap profile, the
 * inspector parameters, and the Boots game engine on the system slot.
 *
 * The system is the first-person game (Jump in, the share-link drop gate, the
 * spectator layer and the pending Save/Discard preview). It is an editing
 * instrument — it writes the scene on Save and reaches into
 * `@pascal-app/editor` (view mode, item catalog) — so read-only viewers load
 * `jobRenderDefinition` without it.
 */
// `snapProfile` is newer than the pinned core's NodeDefinition type, hence the
// intersection (the original single definition widened with Record<string, unknown>).
export const jobEditContribution: Pick<NodeDefinition<typeof JobNode>, 'parametrics' | 'system'> & {
  snapProfile: 'item'
} = {
  snapProfile: 'item',

  parametrics: {
    groups: [
      {
        label: 'Job',
        fields: [
          { key: 'job', kind: 'enum', options: ['fix', 'paint', 'install', 'clean', 'inspect'] },
          { key: 'status', kind: 'enum', options: ['open', 'done'], display: 'segmented' },
        ],
      },
    ],
  },

  // The game engine rides the system slot: mounted in-canvas whenever Boots
  // is installed in the scene, inert until the panel enters game phase.
  system: { module: () => import('./game/system'), priority: 8 },
}
