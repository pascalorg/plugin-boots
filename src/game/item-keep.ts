import { type AnyNode, type AnyNodeId, nodeRegistry, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import {
  isForeignItemPlacement,
  type Placement,
  type PlacedAperture,
  type PlacedItem,
  releaseSharedItemPlacements,
  useItems,
} from './item-place'

/**
 * Save-the-furniture — the catalog lane's half of the persistence contract
 * (docs/SESSION-CHANGES.md, same shape as keep.ts / save-demolition.ts /
 * paint-keep.ts). During play placements live only in item-place.tsx's
 * `useItems` store; the sidebar Save converts every one into a REAL node
 * through the host's own registry (safeDefaults + schema parse — the
 * keep.ts attempt-and-catch idiom), in ONE pass, and ONLY ever from the
 * explicit button. Discard forgets them.
 *
 * Two placement kinds share the store:
 * - 'item' (furniture): node position = the game's bottom-center floor
 *   anchor (world == level coords, the keep.ts convention), rotation =
 *   [0, yaw, 0], scale identity, catalog asset embedded VERBATIM — every
 *   CATALOG_ITEMS row is already a complete, parse-ready asset, so the
 *   host renders the same GLB the game showed. Parent: the current level.
 * - 'aperture' (the openings tab): a real host `door`/`window` node HOSTED
 *   ON the wall the ghost snapped to — parentId = wallId (plus the
 *   schema's `wallId` mirror), position = the hosted-child wall-local
 *   convention [u along the wall, center height, 0 mid-plane], type from
 *   the entry's doorType/windowType. The host renderer cuts the actual
 *   hole; the game only ever showed the stand-in. A wall deleted by the
 *   same Save's demolition pass (panel runs deleteDestroyed FIRST) counts
 *   the aperture as skipped instead of orphaning a node.
 *
 * A missing registry kind or a schema-parse failure counts the placement
 * as skipped (it stays game-only); the pass never throws.
 */

export type ItemKeepResult = { kept: number; skipped: number; doors: number; windows: number }

type RegistryDef = {
  defaults?: () => Record<string, unknown>
  schema?: { parse: (value: unknown) => unknown }
}

/** Host `defaults()` guarded against throws — the keep.ts "HOST DEFAULTS
 * ARE UNTRUSTED" rule: the schema's own field defaults carry a broken
 * defaults(); it may weaken an attempt, never decide it. */
function safeDefaults(def: RegistryDef): Record<string, unknown> {
  try {
    return def.defaults?.() ?? {}
  } catch {
    return {}
  }
}

/**
 * One placement's schema-parse payload — pure, exported for tests. Spread
 * order matters: the real asset and pose land OVER the host defaults, so a
 * placeholder-asset defaults() can never leak into a kept node.
 */
export function buildItemPayload(
  item: PlacedItem,
  levelId: string,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...defaults,
    object: 'node',
    parentId: levelId,
    visible: true,
    metadata: {},
    name: item.asset.name,
    position: [item.position[0], item.position[1], item.position[2]],
    rotation: [0, item.yaw, 0],
    scale: [1, 1, 1],
    asset: item.asset,
  }
}

/**
 * One pending aperture's schema-parse payload — pure, exported for tests.
 * position is the host's hosted-child wall-local frame: [u from the wall
 * start, CENTER height above the wall base, 0 = the wall mid-plane].
 * Doors carry their family (doorType, leafCount 2 for doubles); windows
 * their windowType. Width/height ride the entry's nominal size.
 */
export function buildAperturePayload(
  placed: PlacedAperture,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const def = placed.def
  const base = {
    ...defaults,
    object: 'node',
    parentId: placed.wallId,
    wallId: placed.wallId,
    visible: true,
    metadata: {},
    name: def.name,
    position: [placed.u, placed.v, 0],
    rotation: [0, 0, 0],
    width: placed.width,
    height: placed.height,
  }
  return def.node === 'door'
    ? { ...base, doorType: def.doorType, leafCount: def.doorType === 'double' ? 2 : 1 }
    : { ...base, windowType: def.windowType }
}

/** Placements awaiting the panel's decision (furniture AND apertures) —
 * session.ts folds this into the pendingDecision gate on exit. */
export function placedItemCount(): number {
  return ownPlacements().length
}

/**
 * The placements THIS player is answerable for. Everything downstream reads
 * this rather than the store: a Save writes the work of whoever pressed the
 * button, and a session where the only furniture was carried in by other
 * players has nothing to decide about — so the pendingDecision gate must not
 * fire either. Identical to the store's list in single-player.
 */
function ownPlacements(): Placement[] {
  return useItems.getState().items.filter((placed) => !isForeignItemPlacement(placed.id))
}

/** The explicit save: furniture placements attempt real 'item' nodes under
 * the current level; apertures attempt 'door'/'window' nodes hosted on
 * their wall. Returns kept/skipped (+door/window tallies); the store
 * resolves either way (skipped placements are reported, not retried — the
 * keepPlaced rule). */
export function applyItems(): ItemKeepResult {
  const items = ownPlacements()
  const result: ItemKeepResult = { kept: 0, skipped: 0, doors: 0, windows: 0 }
  if (items.length === 0) return result
  const itemDef = nodeRegistry.get('item') as RegistryDef | undefined
  const levelId = useViewer.getState().selection.levelId
  const itemDefaults = itemDef ? safeDefaults(itemDef) : {}
  for (const placed of items) {
    if (placed.kind === 'aperture') {
      const kind = placed.def.node
      const apDef = nodeRegistry.get(kind) as RegistryDef | undefined
      // The wall must still exist — the same Save's demolition delete runs
      // before this pass and may have removed it.
      const wall = useScene.getState().nodes[placed.wallId as AnyNodeId]
      if (!apDef?.schema || !wall) {
        result.skipped++
        continue
      }
      try {
        const node = apDef.schema.parse(buildAperturePayload(placed, safeDefaults(apDef)))
        useScene.getState().createNode(node as AnyNode, placed.wallId as AnyNodeId)
        result.kept++
        if (kind === 'door') result.doors++
        else result.windows++
      } catch {
        result.skipped++
      }
      continue
    }
    if (!itemDef?.schema || !levelId) {
      result.skipped++
      continue
    }
    try {
      const node = itemDef.schema.parse(buildItemPayload(placed, levelId, itemDefaults))
      useScene.getState().createNode(node as AnyNode, levelId as AnyNodeId)
      result.kept++
    } catch {
      result.skipped++
    }
  }
  // Unbind ours without tombstoning: saving turns them into real nodes here,
  // while on every other screen they are still the chairs and doors they were.
  releaseSharedItemPlacements()
  useItems.getState().resolveItems()
  return result
}

export function discardItems(): void {
  releaseSharedItemPlacements()
  useItems.getState().resolveItems()
}
