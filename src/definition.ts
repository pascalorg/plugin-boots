import type { NodeDefinition } from '@pascal-app/core'
import { JobNode } from './schema'

type JobDefinition = NodeDefinition<typeof JobNode> & Record<string, unknown>

/** Cone footprint — a real site cone: ~36 cm square base, ~55 cm tall. */
const JOB_SIZE: [number, number, number] = [0.36, 0.55, 0.36]

const jobFloorPlacement = {
  footprint: (node: unknown) => ({
    dimensions: JOB_SIZE,
    rotation: (node as JobNode).rotation,
  }),
  // A marker, not furniture — it neither blocks placements nor gets blocked.
  collides: false,
}

/**
 * The job-marker node definition. A punch-list cone: place it where work is
 * needed, walk up to it in first person, do the work, flip it to done.
 * `parametrics` gives the inspector for free; the Boots panel lists every
 * marker in the scene as the working punch list.
 */
export const jobDefinition: JobDefinition = {
  kind: 'boots:job',
  schemaVersion: 1,
  schema: JobNode,
  category: 'furnish',
  snapProfile: 'item',

  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    job: 'fix',
    status: 'open',
  }),

  capabilities: {
    movable: { axes: ['x', 'z'], gridSnap: true },
    rotatable: {
      axes: ['y'],
      snapAngles: Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4),
    },
    selectable: { hitVolume: 'bbox' },
    duplicable: true,
    deletable: true,
    groupable: true,
    snappable: {},
    dragBounds: () => ({ size: JOB_SIZE }),
    floorPlaced: jobFloorPlacement,
  },

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

  renderer: { kind: 'parametric', module: () => import('./renderer') },

  presentation: {
    label: 'Job marker',
    description: 'A punch-list cone standing where work is needed.',
    icon: { kind: 'iconify', name: 'lucide:traffic-cone' },
    paletteSection: 'furnish',
    hidden: true,
  },

  mcp: {
    description:
      'A Boots punch-list job marker — a site cone placed where work is needed. `job` picks the trade (fix/paint/install/clean/inspect); `status` flips open → done when the work is finished.',
  },
}
