import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AnyNodeDefinition,
  DoorNode,
  ItemNode,
  nodeRegistry,
  useScene,
  WindowNode,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { type CatalogEntry, OPENING_ENTRIES, type OpeningEntry } from './inventory'
import {
  applyItems,
  buildAperturePayload,
  buildItemPayload,
  discardItems,
  placedItemCount,
} from './item-keep'
import { type PlacedAperture, type PlacedItem, useItems } from './item-place'

/**
 * Item save-bridge contract: every placement ATTEMPTS a real node — 'item'
 * for furniture, wall-hosted 'door'/'window' for the openings tab — proven
 * against the REAL @pascal-app/core zod schemas (the keep.test.ts pattern:
 * the registry singleton is empty under bun test, so this file installs
 * exactly what it needs). Missing registry kind, no selected level, a
 * demolished host wall, or a schema-refusing asset counts skipped and
 * never throws; the store resolves either way.
 */

const setLevel = (levelId: `level_${string}` | null) =>
  useViewer.setState({
    selection: { buildingId: null, levelId, zoneId: null, selectedIds: [] },
  })

type SceneNode = Record<string, unknown> & { id: string; type: string; parentId: string | null }

const itemNodes = (): SceneNode[] =>
  (Object.values(useScene.getState().nodes) as SceneNode[]).filter((n) => n.type === 'item')

const asset = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'couch-test',
  category: 'furniture',
  name: 'Couch',
  thumbnail: 'https://cdn.test/items/couch/thumbnail.png',
  src: 'https://cdn.test/items/couch/model.glb',
  dimensions: [2, 0.8, 0.9],
  offset: [0, 0.1, 0],
  ...over,
})

const seed = (position: [number, number, number], yaw = 0, over: Partial<CatalogEntry> = {}) =>
  useItems.getState().addItem(asset(over), position, yaw)

beforeEach(() => {
  useItems.getState().resolveItems()
  useScene.getState().setScene({}, [])
  setLevel('level_test')
})

// Order matters: this block runs BEFORE the real ItemNode registration
// below — the registry singleton has no unregister.
describe('applyItems without an item registry kind', () => {
  test('every placement skips, the store still resolves', () => {
    expect(nodeRegistry.has('item')).toBe(false)
    seed([1, 0, 2])
    seed([3, 0, 4])
    expect(placedItemCount()).toBe(2)
    expect(applyItems()).toEqual({ kept: 0, skipped: 2, doors: 0, windows: 0 })
    expect(itemNodes()).toHaveLength(0)
    expect(placedItemCount()).toBe(0)
  })
})

describe('applyItems against the real ItemNode schema', () => {
  beforeAll(() => {
    if (!nodeRegistry.has('item')) {
      // defaults() THROWS on purpose — the live host's registry has form
      // (keep.ts "HOST DEFAULTS ARE UNTRUSTED"): every kept node in this
      // block therefore also proves safeDefaults degrades it to the zod
      // schema's own field defaults instead of losing the save.
      nodeRegistry._register({
        kind: 'item',
        schemaVersion: 2,
        schema: ItemNode,
        defaults: () => {
          throw new Error('host defaults broke')
        },
      } as unknown as AnyNodeDefinition)
    }
  })

  test('placements become level-parented item nodes, asset verbatim', () => {
    seed([1.5, 0, -2], Math.PI / 2)
    seed([4, 2.8, 1], 0, { id: 'lamp-test', name: 'Lamp' })
    expect(applyItems()).toEqual({ kept: 2, skipped: 0, doors: 0, windows: 0 })
    const nodes = itemNodes()
    expect(nodes).toHaveLength(2)
    const couch = nodes.find((n) => n.name === 'Couch')!
    expect(couch.parentId).toBe('level_test')
    expect(couch.position).toEqual([1.5, 0, -2])
    expect(couch.rotation).toEqual([0, Math.PI / 2, 0])
    expect(couch.scale).toEqual([1, 1, 1])
    const kept = couch.asset as CatalogEntry
    expect(kept.src).toBe('https://cdn.test/items/couch/model.glb')
    expect(kept.dimensions).toEqual([2, 0.8, 0.9])
    const lamp = nodes.find((n) => n.name === 'Lamp')!
    expect(lamp.position).toEqual([4, 2.8, 1]) // upper-storey y preserved
    expect(placedItemCount()).toBe(0)
  })

  test('ids come from the schema template (item_…), unique per node', () => {
    seed([0, 0, 0])
    seed([1, 0, 0])
    applyItems()
    const ids = itemNodes().map((n) => n.id)
    expect(ids.every((id) => id.startsWith('item_'))).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  test('a schema-refusing asset skips that placement, keeps the rest', () => {
    seed([0, 0, 0])
    seed([2, 0, 0], 0, { src: undefined as unknown as string }) // required field gone
    expect(applyItems()).toEqual({ kept: 1, skipped: 1, doors: 0, windows: 0 })
    expect(itemNodes()).toHaveLength(1)
    expect(placedItemCount()).toBe(0)
  })

  test('no selected level: everything skips, nothing is created', () => {
    setLevel(null)
    seed([0, 0, 0])
    expect(applyItems()).toEqual({ kept: 0, skipped: 1, doors: 0, windows: 0 })
    expect(itemNodes()).toHaveLength(0)
  })

  test('empty store is a free no-op', () => {
    expect(applyItems()).toEqual({ kept: 0, skipped: 0, doors: 0, windows: 0 })
  })

  test('discardItems forgets placements without touching the scene', () => {
    seed([0, 0, 0])
    discardItems()
    expect(placedItemCount()).toBe(0)
    expect(itemNodes()).toHaveLength(0)
  })
})

describe('buildItemPayload', () => {
  const placed: PlacedItem = {
    kind: 'item',
    id: 7,
    asset: asset(),
    position: [1, 0.5, 2],
    yaw: Math.PI,
  }

  test('pose + asset land over the host defaults', () => {
    const payload = buildItemPayload(placed, 'level_test', {
      position: [99, 99, 99],
      asset: { id: 'placeholder' },
      visible: false,
    })
    expect(payload.parentId).toBe('level_test')
    expect(payload.position).toEqual([1, 0.5, 2])
    expect(payload.rotation).toEqual([0, Math.PI, 0])
    expect(payload.scale).toEqual([1, 1, 1])
    expect(payload.visible).toBe(true)
    expect(payload.name).toBe('Couch')
    expect((payload.asset as CatalogEntry).id).toBe('couch-test')
  })
})

// --- Apertures (the openings tab's save lane) --------------------------------

const openingDef = (id: string): OpeningEntry => {
  const def = OPENING_ENTRIES.find((entry) => entry.id === id)
  if (!def) throw new Error(`no opening entry ${id}`)
  return def
}

const nodesOf = (type: string): SceneNode[] =>
  (Object.values(useScene.getState().nodes) as SceneNode[]).filter((n) => n.type === type)

/** A minimal host wall in the scene store — enough for the wall-exists
 * guard (applyItems never parses the wall itself). */
const seedWall = (id = 'wall_host') => {
  useScene.getState().setScene(
    {
      [id]: {
        id,
        type: 'wall',
        object: 'node',
        parentId: null,
        start: [0, 0],
        end: [6, 0],
      },
    } as never,
    [id] as never,
  )
  return id
}

const seedAperture = (defId: string, wallId: string, u: number, v: number) =>
  useItems.getState().addAperture(openingDef(defId), wallId, u, v)

// Order matters again: proves the missing-kind skip BEFORE door/window
// registration (bun runs describes in file order).
describe('applyItems apertures without door/window registry kinds', () => {
  test('apertures skip, furniture in the same pass still keeps', () => {
    expect(nodeRegistry.has('door')).toBe(false)
    const wallId = seedWall()
    seed([1, 0, 2])
    seedAperture('opening-door-hinged', wallId, 1.2, 1.05)
    expect(placedItemCount()).toBe(2)
    expect(applyItems()).toEqual({ kept: 1, skipped: 1, doors: 0, windows: 0 })
    expect(itemNodes()).toHaveLength(1)
    expect(nodesOf('door')).toHaveLength(0)
    expect(placedItemCount()).toBe(0)
  })
})

describe('applyItems apertures against the real Door/Window schemas', () => {
  beforeAll(() => {
    // Broken defaults() again — the aperture lane must also survive the
    // "HOST DEFAULTS ARE UNTRUSTED" rule.
    const broken = () => {
      throw new Error('host defaults broke')
    }
    if (!nodeRegistry.has('door')) {
      nodeRegistry._register({
        kind: 'door',
        schemaVersion: 1,
        schema: DoorNode,
        defaults: broken,
      } as unknown as AnyNodeDefinition)
    }
    if (!nodeRegistry.has('window')) {
      nodeRegistry._register({
        kind: 'window',
        schemaVersion: 1,
        schema: WindowNode,
        defaults: broken,
      } as unknown as AnyNodeDefinition)
    }
  })

  test('a pending hinged door becomes a wall-hosted door node', () => {
    const wallId = seedWall()
    seedAperture('opening-door-hinged', wallId, 1.2, 1.05)
    expect(applyItems()).toEqual({ kept: 1, skipped: 0, doors: 1, windows: 0 })
    const [door] = nodesOf('door')
    expect(door).toBeDefined()
    expect(door!.id.startsWith('door_')).toBe(true)
    expect(door!.parentId).toBe(wallId)
    expect(door!.wallId).toBe(wallId)
    expect(door!.position).toEqual([1.2, 1.05, 0])
    expect(door!.width).toBe(0.9)
    expect(door!.height).toBe(2.1)
    expect(door!.doorType).toBe('hinged')
    expect(door!.leafCount).toBe(1)
    expect(placedItemCount()).toBe(0)
  })

  test('a double door carries leafCount 2', () => {
    const wallId = seedWall()
    seedAperture('opening-door-double', wallId, 3, 1.05)
    expect(applyItems().doors).toBe(1)
    const [door] = nodesOf('door')
    expect(door!.doorType).toBe('double')
    expect(door!.leafCount).toBe(2)
    expect(door!.width).toBe(1.6)
  })

  test('a pending window becomes a wall-hosted window node (sill center)', () => {
    const wallId = seedWall()
    // Fixed window: sill 0.9, height 1.5 → center v = 1.65.
    seedAperture('opening-window-fixed', wallId, 2, 1.65)
    expect(applyItems()).toEqual({ kept: 1, skipped: 0, doors: 0, windows: 1 })
    const [window_] = nodesOf('window')
    expect(window_).toBeDefined()
    expect(window_!.id.startsWith('window_')).toBe(true)
    expect(window_!.parentId).toBe(wallId)
    expect(window_!.wallId).toBe(wallId)
    expect(window_!.position).toEqual([2, 1.65, 0])
    expect(window_!.width).toBe(1.5)
    expect(window_!.height).toBe(1.5)
    expect(window_!.windowType).toBe('fixed')
  })

  test('wall demolished before the pass: the aperture skips, no orphan', () => {
    // No wall seeded — the same Save's deleteDestroyed removed it.
    seedAperture('opening-window-casement', 'wall_gone', 1, 1.5)
    expect(applyItems()).toEqual({ kept: 0, skipped: 1, doors: 0, windows: 0 })
    expect(nodesOf('window')).toHaveLength(0)
    expect(placedItemCount()).toBe(0)
  })

  test('mixed save: furniture and apertures tally in one pass', () => {
    const wallId = seedWall()
    seed([1, 0, 2])
    seedAperture('opening-door-sliding', wallId, 2, 1.05)
    seedAperture('opening-window-sliding', wallId, 4.5, 1.5)
    expect(applyItems()).toEqual({ kept: 3, skipped: 0, doors: 1, windows: 1 })
    expect(itemNodes()).toHaveLength(1)
    expect(nodesOf('door')[0]!.doorType).toBe('sliding')
    expect(nodesOf('window')[0]!.windowType).toBe('sliding')
  })
})

describe('buildAperturePayload', () => {
  const placed: PlacedAperture = {
    kind: 'aperture',
    id: 9,
    def: openingDef('opening-door-double'),
    wallId: 'wall_abc',
    u: 2.4,
    v: 1.05,
    width: 1.6,
    height: 2.1,
  }

  test('wall-local pose + family land over the host defaults', () => {
    const payload = buildAperturePayload(placed, {
      position: [99, 99, 99],
      width: 99,
      visible: false,
    })
    expect(payload.parentId).toBe('wall_abc')
    expect(payload.wallId).toBe('wall_abc')
    expect(payload.position).toEqual([2.4, 1.05, 0])
    expect(payload.rotation).toEqual([0, 0, 0])
    expect(payload.width).toBe(1.6)
    expect(payload.height).toBe(2.1)
    expect(payload.doorType).toBe('double')
    expect(payload.leafCount).toBe(2)
    expect(payload.visible).toBe(true)
    expect(payload.name).toBe('Double door')
  })

  test('windows carry windowType, never door fields', () => {
    const payload = buildAperturePayload(
      {
        kind: 'aperture',
        id: 10,
        def: openingDef('opening-window-casement'),
        wallId: 'wall_abc',
        u: 1,
        v: 1.5,
        width: 0.6,
        height: 1.2,
      },
      {},
    )
    expect(payload.windowType).toBe('casement')
    expect(payload.doorType).toBeUndefined()
    expect(payload.leafCount).toBeUndefined()
  })
})
