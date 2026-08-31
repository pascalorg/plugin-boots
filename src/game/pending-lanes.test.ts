import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { FULL_MASK, useBoots } from '../store'
import { type CatalogEntry, OPENING_ENTRIES } from './inventory'
import { useItems } from './item-place'
import { usePaintKeep } from './paint-keep'
import {
  collectPendingLanes,
  forgetPendingChanges,
  hydratePendingLanes,
  persistPendingChanges,
  resetPendingRestore,
  restorePendingChanges,
} from './pending-lanes'
import {
  type PendingSnapshot,
  PENDING_FORMAT,
  pendingKey,
  type PendingStorage,
  readPendingSnapshot,
} from './pending-store'
import { useDemolition } from './save-demolition'

/**
 * The pending window's two doors, against the REAL stores.
 *
 * pending-store.test.ts owns the format; this file owns what happens to a
 * player's fort when a page reloads. The failure that matters is not "the JSON
 * was wrong" — it is a second copy of the same fort appearing in the lanes, or
 * a live session being overwritten by a stale disk copy, or the offer coming
 * back with runtime ids that collide with the next thing placed.
 */

const SCOPE = 'project_TEST'

class FakeStorage implements PendingStorage {
  readonly map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
}

const globals = globalThis as {
  localStorage?: unknown
  location?: { pathname?: string }
  __pascalCollabBus?: { projectId?: unknown }
}

let storage: FakeStorage
let realStorage: unknown
let realLocation: { pathname?: string } | undefined
let realBus: { projectId?: unknown } | undefined

const snapshotOf = (over: Partial<PendingSnapshot> = {}): PendingSnapshot => ({
  destroyed: [],
  format: PENDING_FORMAT,
  items: [],
  mine: [],
  painted: [],
  placed: [],
  savedAt: 1000,
  ...over,
})

/** The bundled furniture catalog rides in the editor package, which is absent
 * under `bun test` (`placeableCatalog()` is empty here), so a placed ITEM is
 * made from a stand-in row — `encodePlacement` only ever reads its id. The
 * openings catalog is local to the plugin, so apertures use the real rows and
 * are what the hydration round trip is asserted on. */
const crate = { id: 'crate', category: 'storage', name: 'Crate' } as CatalogEntry

const hingedDoor = OPENING_ENTRIES.find((entry) => entry.id === 'opening-door-hinged')!

const storedWall = (x: number) => ({
  id: 0,
  mask: FULL_MASK,
  piece: 'wall' as const,
  position: [x, 0, 0] as [number, number, number],
  yaw: 0,
})

const write = (snapshot: PendingSnapshot) =>
  storage.map.set(pendingKey(SCOPE), JSON.stringify(snapshot))

beforeEach(() => {
  storage = new FakeStorage()
  realStorage = globals.localStorage
  realLocation = globals.location
  realBus = globals.__pascalCollabBus
  Object.defineProperty(globals, 'localStorage', { configurable: true, value: storage })
  globals.location = { pathname: `/editor/${SCOPE}` }
  globals.__pascalCollabBus = undefined
  resetPendingRestore()
  useBoots.setState({ phase: 'editor' })
  useBoots.getState().resolvePlaced()
  useDemolition.getState().clear()
  usePaintKeep.getState().clear()
  useItems.getState().resolveItems()
  useScene.getState().setScene({}, [])
})

afterEach(() => {
  Object.defineProperty(globals, 'localStorage', { configurable: true, value: realStorage })
  globals.location = realLocation
  globals.__pascalCollabBus = realBus
  useBoots.getState().resolvePlaced()
  useDemolition.getState().clear()
  usePaintKeep.getState().clear()
  useItems.getState().resolveItems()
})

// ── The round trip ──────────────────────────────────────────────────────────

describe('a reload gets the same offer back', () => {
  test('four lanes out, four lanes in', () => {
    useBoots.getState().addPlaced({ piece: 'wall', position: [1, 0, 2], yaw: 0 })
    useDemolition.getState().setDestroyed([{ kind: 'wall', nodeId: 'wall_1' }], ['wall_1'], 0)
    usePaintKeep
      .getState()
      .setPainted([{ cells: 9, color: '#3b4a63', colorName: 'NAVY', nodeId: 'wall_1' }])
    useItems.getState().addAperture(hingedDoor, 'wall_1', 1.2, 0)

    persistPendingChanges()
    expect(storage.map.has(pendingKey(SCOPE))).toBe(true)

    // The tab was closed: memory is empty, the key is not.
    useBoots.getState().resolvePlaced()
    useDemolition.getState().clear()
    usePaintKeep.getState().clear()
    useItems.getState().resolveItems()

    const report = restorePendingChanges()
    expect(report).toEqual({ apertures: 1, items: 0, pieces: 1, skipped: 0, stale: 0, unknown: 0 })
    expect(useBoots.getState().placed[0]?.position).toEqual([1, 0, 2])
    expect(useDemolition.getState().destroyed).toEqual([{ kind: 'wall', nodeId: 'wall_1' }])
    expect(useDemolition.getState().mine).toEqual(['wall_1'])
    expect(usePaintKeep.getState().painted[0]?.color).toBe('#3b4a63')
    const restored = useItems.getState().items[0]
    expect(restored?.kind).toBe('aperture')
    // The pose survives; the runtime id does not (see the fresh-ids test).
    expect(restored && 'u' in restored ? restored.u : null).toBe(1.2)
  })

  test('restored pieces get FRESH runtime ids, never the stored ones', () => {
    // Ids key colliders, the support graph and the shared records. A restored
    // id colliding with the next piece placed in this page load would put two
    // different walls behind one collider.
    write(snapshotOf({ placed: [storedWall(0), storedWall(1)] }))
    hydratePendingLanes(snapshotOf({ placed: [storedWall(0), storedWall(1)] }))
    const ids = useBoots.getState().placed.map((piece) => piece.id)
    expect(ids.every((id) => id > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    const next = useBoots.getState().addPlaced({ piece: 'wall', position: [9, 0, 9], yaw: 0 })
    expect(ids).not.toContain(next.id)
  })

  test('Save clearing the lanes deletes the key, so the offer is not made twice', () => {
    useBoots.getState().addPlaced({ piece: 'wall', position: [1, 0, 2], yaw: 0 })
    persistPendingChanges()
    useBoots.getState().resolvePlaced() // what Save's bridge leaves behind
    persistPendingChanges()
    expect(storage.map.size).toBe(0)
  })

  test('an aperture comes back through the catalog, and an unknown row is counted', () => {
    const report = hydratePendingLanes(
      snapshotOf({
        items: [
          {
            catalogId: 'opening-door-hinged',
            height: 2.1,
            kind: 'aperture',
            u: 0.5,
            v: 0,
            wallId: 'wall_1',
            width: 0.9,
          },
          { catalogId: 'opening-from-the-future', height: 1, kind: 'aperture', u: 0, v: 0, wallId: 'wall_1', width: 1 },
          { catalogId: 'item-from-the-future', kind: 'item', position: [0, 0, 0], yaw: 0 },
        ],
      }),
    )
    expect(report.apertures).toBe(1)
    expect(report.unknown).toBe(2)
    expect(useItems.getState().items.length).toBe(1)
  })
})

// ── The three refusals ──────────────────────────────────────────────────────

describe('restore refuses to fight a live session', () => {
  test('never during play — a second copy of every piece would land mid-game', () => {
    write(snapshotOf({ placed: [storedWall(0)] }))
    useBoots.setState({ phase: 'game' })
    expect(restorePendingChanges().pieces).toBe(0)
    expect(useBoots.getState().placed).toEqual([])
    // And the key survives the refusal: it is still an undecided window.
    expect(storage.map.has(pendingKey(SCOPE))).toBe(true)
  })

  test('never twice for the same scope, because the canvas can remount', () => {
    write(snapshotOf({ placed: [storedWall(0)] }))
    expect(restorePendingChanges().pieces).toBe(1)
    useBoots.getState().resolvePlaced() // pretend the remount cleared nothing else
    expect(restorePendingChanges().pieces).toBe(0)
    resetPendingRestore()
    expect(restorePendingChanges().pieces).toBe(1)
  })

  test('per lane, not all-or-nothing: memory wins only where memory has something', () => {
    // A session that only painted must still get its stored pieces back.
    write(
      snapshotOf({
        painted: [{ cells: 1, color: '#3b4a63', colorName: 'NAVY', nodeId: 'stored' }],
        placed: [storedWall(0)],
      }),
    )
    usePaintKeep
      .getState()
      .setPainted([{ cells: 5, color: '#a3b18a', colorName: 'SAGE', nodeId: 'live' }])

    const report = restorePendingChanges()
    expect(report.pieces).toBe(1)
    expect(usePaintKeep.getState().painted.map((p) => p.nodeId)).toEqual(['live'])
  })

  test('a project it cannot name persists nothing and restores nothing', () => {
    globals.location = { pathname: '/' }
    useBoots.getState().addPlaced({ piece: 'wall', position: [1, 0, 2], yaw: 0 })
    persistPendingChanges()
    expect(storage.map.size).toBe(0)
    useBoots.getState().resolvePlaced()
    write(snapshotOf({ placed: [storedWall(0)] })) // a key from another route
    expect(restorePendingChanges().pieces).toBe(0)
  })

  test('the collab bus names the project even when the route cannot', () => {
    globals.location = { pathname: '/' }
    globals.__pascalCollabBus = { projectId: SCOPE }
    write(snapshotOf({ placed: [storedWall(0)] }))
    expect(restorePendingChanges().pieces).toBe(1)
  })
})

// ── Pruning against the document ────────────────────────────────────────────

describe('rows whose element is gone', () => {
  test('are dropped, reported, and written back out so the next load is clean', () => {
    useScene.getState().setScene(
      { wall_kept: { id: 'wall_kept', object: 'node', parentId: null, type: 'wall' } } as never,
      ['wall_kept'] as never,
    )
    write(
      snapshotOf({
        destroyed: [
          { kind: 'wall', nodeId: 'wall_kept' },
          { kind: 'wall', nodeId: 'wall_deleted' },
        ],
        mine: ['wall_kept', 'wall_deleted'],
        placed: [storedWall(0)],
      }),
    )

    const report = restorePendingChanges()
    expect(report.stale).toBe(1)
    expect(useDemolition.getState().destroyed).toEqual([{ kind: 'wall', nodeId: 'wall_kept' }])
    expect(useDemolition.getState().mine).toEqual(['wall_kept'])
    // Re-written from the live lanes, so tomorrow does not re-check a node that
    // is already gone.
    const rewritten = readPendingSnapshot(storage, SCOPE)
    expect(rewritten?.snapshot.destroyed).toEqual([{ kind: 'wall', nodeId: 'wall_kept' }])
    expect(rewritten?.snapshot.placed.length).toBe(1)
  })

  test('an empty scene is "not loaded yet", not "everything was deleted"', () => {
    // Pruning against a document that has not arrived would throw the whole
    // window away — the one bug that costs a player their night.
    write(snapshotOf({ destroyed: [{ kind: 'wall', nodeId: 'wall_1' }], mine: ['wall_1'] }))
    const report = restorePendingChanges()
    expect(report.stale).toBe(0)
    expect(useDemolition.getState().destroyed).toEqual([{ kind: 'wall', nodeId: 'wall_1' }])
    expect(storage.map.has(pendingKey(SCOPE))).toBe(true)
  })

  test('a row the FORMAT refused is reported separately from a stale one', () => {
    write({ ...snapshotOf({ placed: [storedWall(0)] }), painted: [{ nodeId: 'x' }] } as never)
    const report = restorePendingChanges()
    expect(report.skipped).toBe(1)
    expect(report.stale).toBe(0)
    expect(report.pieces).toBe(1)
  })
})

// ── Capture ─────────────────────────────────────────────────────────────────

describe('collectPendingLanes', () => {
  test('reads all four lanes plus the demolition allow-list', () => {
    useBoots.getState().addPlaced({ piece: 'wall', position: [1, 0, 2], yaw: 0 })
    useDemolition.getState().setDestroyed([{ kind: 'volume', nodeId: 'vol_1' }], ['vol_1'], 0)
    useItems.getState().addItem(crate, [0, 0, 0], 0)

    const lanes = collectPendingLanes()
    expect(lanes.placed.length).toBe(1)
    expect(lanes.destroyed.length).toBe(1)
    expect(lanes.mine).toEqual(['vol_1'])
    // Placements are stored by catalog id, so a later catalog cannot make the
    // stored row lie about what it was.
    expect(lanes.items).toEqual([{ catalogId: crate.id, kind: 'item', position: [0, 0, 0], yaw: 0 }])
  })

  test('forgetPendingChanges drops the key and leaves the live lanes alone', () => {
    useBoots.getState().addPlaced({ piece: 'wall', position: [1, 0, 2], yaw: 0 })
    persistPendingChanges()
    forgetPendingChanges()
    expect(storage.map.size).toBe(0)
    expect(useBoots.getState().placed.length).toBe(1)
  })
})
