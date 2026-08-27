import { type AnyNode, type AnyNodeId, nodeRegistry, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { type PlacedItem, useItems } from './item-place'

/**
 * Save-the-furniture — the catalog lane's half of the persistence contract
 * (docs/SESSION-CHANGES.md, same shape as keep.ts / save-demolition.ts /
 * paint-keep.ts). During play placements live only in item-place.tsx's
 * `useItems` store; the sidebar Save converts every one into a REAL `item`
 * node through the host's own registry (safeDefaults + schema parse — the
 * keep.ts attempt-and-catch idiom), parented to the current level in ONE
 * pass, and ONLY ever from the explicit button. Discard forgets them.
 *
 * The payload is the editor's own placement shape: node position = the
 * game's bottom-center floor anchor (world == level coords, the keep.ts
 * convention), rotation = [0, yaw, 0], scale identity, and the catalog
 * asset embedded VERBATIM — every CATALOG_ITEMS row is already a complete,
 * parse-ready asset, so the host renders the same GLB the game showed.
 * A missing 'item' registry kind or a schema-parse failure counts the
 * placement as skipped (it stays game-only); the pass never throws.
 */

export type ItemKeepResult = { kept: number; skipped: number }

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

/** Placements awaiting the panel's decision — session.ts folds this into
 * the pendingDecision gate on exit (manager wiring). */
export function placedItemCount(): number {
  return useItems.getState().items.length
}

/** The explicit save: every placement attempts a real 'item' node under
 * the current level. Returns kept/skipped; the store resolves either way
 * (skipped placements are reported, not retried — the keepPlaced rule). */
export function applyItems(): ItemKeepResult {
  const items = useItems.getState().items
  const result: ItemKeepResult = { kept: 0, skipped: 0 }
  if (items.length === 0) return result
  const def = nodeRegistry.get('item') as RegistryDef | undefined
  const levelId = useViewer.getState().selection.levelId
  if (!def?.schema || !levelId) {
    useItems.getState().resolveItems()
    return { ...result, skipped: items.length }
  }
  const defaults = safeDefaults(def)
  for (const item of items) {
    try {
      const node = def.schema.parse(buildItemPayload(item, levelId, defaults))
      useScene.getState().createNode(node as AnyNode, levelId as AnyNodeId)
      result.kept++
    } catch {
      result.skipped++
    }
  }
  useItems.getState().resolveItems()
  return result
}

export function discardItems(): void {
  useItems.getState().resolveItems()
}
