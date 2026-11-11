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
 * The render half of the job-marker definition: everything a read-only viewer
 * needs to load, validate and draw a `boots:job` cone — schema, defaults,
 * capabilities (selection, bounds and transforms, as the built-ins keep them),
 * the cone renderer and presentation. It imports only `@pascal-app/core`,
 * `three`, `@react-three/*` and react (through the renderer), never the editor.
 *
 * The editing half lives in `definition.edit.ts`; `definition.ts` composes the
 * two for editor hosts.
 */
export const jobRenderDefinition: JobDefinition = {
  kind: 'boots:job',
  schemaVersion: 1,
  schema: JobNode,
  category: 'furnish',

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
