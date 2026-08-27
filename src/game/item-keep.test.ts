import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type AnyNodeDefinition,
  ItemNode,
  nodeRegistry,
  useScene,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import type { CatalogEntry } from './inventory'
import { applyItems, buildItemPayload, discardItems, placedItemCount } from './item-keep'
import { type PlacedItem, useItems } from './item-place'

/**
 * Item save-bridge contract: every placement ATTEMPTS a real 'item' node —
 * proven against the REAL @pascal-app/core ItemNode zod schema (the
 * keep.test.ts pattern: the registry singleton is empty under bun test, so
 * this file installs exactly what it needs). Missing registry kind, no
 * selected level, or a schema-refusing asset counts skipped and never
 * throws; the store resolves either way.
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
    expect(applyItems()).toEqual({ kept: 0, skipped: 2 })
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
    expect(applyItems()).toEqual({ kept: 2, skipped: 0 })
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
    expect(applyItems()).toEqual({ kept: 1, skipped: 1 })
    expect(itemNodes()).toHaveLength(1)
    expect(placedItemCount()).toBe(0)
  })

  test('no selected level: everything skips, nothing is created', () => {
    setLevel(null)
    seed([0, 0, 0])
    expect(applyItems()).toEqual({ kept: 0, skipped: 1 })
    expect(itemNodes()).toHaveLength(0)
  })

  test('empty store is a free no-op', () => {
    expect(applyItems()).toEqual({ kept: 0, skipped: 0 })
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
