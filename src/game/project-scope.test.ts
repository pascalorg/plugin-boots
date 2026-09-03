import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useBoots } from '../store'
import { OPENING_ENTRIES } from './inventory'
import { useItems } from './item-place'
import { usePaintKeep } from './paint-keep'
import {
  laneScopeFor,
  persistPendingChanges,
  resetPendingRestore,
  restorePendingChanges,
} from './pending-lanes'
import {
  PENDING_FORMAT,
  type PendingSnapshot,
  type PendingStorage,
  pendingKey,
  readPendingSnapshot,
} from './pending-store'
import { isOccupied as slotOccupied, registerPlacement } from './piece-slots'
import { resetProjectState, syncProjectScope, watchProjectScope } from './project-scope'
import { useDemolition } from './save-demolition'

/**
 * ONE PROJECT AT A TIME (owner P0, 2026-09-02): a fort built in project A was
 * offered for saving in project B after a client-side project switch, because
 * every Boots store is a module singleton and nothing watched the project
 * identity. These tests pin the three promises the fix makes:
 *   (i)   A's pending window is invisible under B — in memory and in storage;
 *   (ii)  the identity change resets every store that outlives a session, and
 *         coming back to A restores A's own window again;
 *   (iii) a page that names no project never maps to a shared key.
 */

const A = 'project_A'
const B = 'project_B'
const EMPTY = { apertures: 0, items: 0, pieces: 0, skipped: 0, stale: 0, unknown: 0 }

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
let stopWatching: (() => void) | null = null

const hingedDoor = OPENING_ENTRIES.find((entry) => entry.id === 'opening-door-hinged')!

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

const storedWall = (x: number) => ({
  id: 0,
  mask: 511,
  piece: 'wall' as const,
  position: [x, 0, 0] as [number, number, number],
  yaw: 0,
})

const visit = (path: string) => {
  globals.location = { pathname: path }
}

const clearLanes = () => {
  useBoots.getState().resolvePlaced()
  useDemolition.getState().clear()
  usePaintKeep.getState().clear()
  useItems.getState().resolveItems()
  useItems.getState().disarm()
}

/** Every lane non-empty, plus the state around them that outlives a session. */
const buildFort = () => {
  useBoots.getState().addPlaced({ piece: 'wall', position: [1, 0, 2], yaw: 0 })
  useBoots.getState().addPlaced({ piece: 'roof', position: [4, 0, 2], yaw: 0 })
  useItems.getState().addAperture(hingedDoor, 'wall_1', 1.2, 0)
  useDemolition.getState().setDestroyed([{ kind: 'wall', nodeId: 'wall_1' }], ['wall_1'], 2)
  usePaintKeep
    .getState()
    .setPainted([{ cells: 9, color: '#3b4a63', colorName: 'NAVY', nodeId: 'wall_1' }])
}

const lanes = () => ({
  armed: useItems.getState().armed,
  destroyed: useDemolition.getState().destroyed.length,
  foreign: useDemolition.getState().foreign,
  items: useItems.getState().items.length,
  mine: useDemolition.getState().mine.length,
  painted: usePaintKeep.getState().painted.length,
  placed: useBoots.getState().placed.length,
})
const EMPTY_LANES = {
  armed: null,
  destroyed: 0,
  foreign: 0,
  items: 0,
  mine: 0,
  painted: 0,
  placed: 0,
}

const storedPlaced = (scope: string) => readPendingSnapshot(storage, scope)?.snapshot.placed.length

beforeEach(() => {
  storage = new FakeStorage()
  realStorage = globals.localStorage
  realLocation = globals.location
  realBus = globals.__pascalCollabBus
  Object.defineProperty(globals, 'localStorage', { configurable: true, value: storage })
  visit(`/editor/${A}`)
  globals.__pascalCollabBus = undefined
  resetPendingRestore()
  useBoots.setState({ phase: 'editor' })
  clearLanes()
  useScene.getState().setScene({}, [])
  // The page loaded on A: the guard's mount check adopts the lane scope
  // before anything is built (system.tsx → watchProjectScope).
  laneScopeFor()
})

afterEach(() => {
  stopWatching?.()
  stopWatching = null
  Object.defineProperty(globals, 'localStorage', { configurable: true, value: realStorage })
  globals.location = realLocation
  globals.__pascalCollabBus = realBus
  clearLanes()
  resetPendingRestore()
})

// ── (i) A's window is invisible under B ────────────────────────────────────

describe('a fort never follows you into another project', () => {
  test('switching A → B empties the lanes, keeps A under A, writes nothing under B', () => {
    buildFort()
    persistPendingChanges()
    expect(storedPlaced(A)).toBe(2)

    visit(`/editor/${B}`)
    expect(syncProjectScope()).toEqual({ from: A, result: 'changed', to: B })

    // In memory: nothing of A's is left to offer, preview, or Save.
    expect(lanes()).toEqual(EMPTY_LANES)
    // B has no stored window of its own, so the restore brings back nothing.
    expect(restorePendingChanges()).toEqual(EMPTY)
    expect(lanes()).toEqual(EMPTY_LANES)
    // In storage: A's window is intact under A's key, and B has no key at all.
    expect(storedPlaced(A)).toBe(2)
    expect(readPendingSnapshot(storage, B)).toBeNull()
    // The next Esc in B (an empty session) must not write A's fort under B.
    persistPendingChanges()
    expect([...storage.map.keys()]).toEqual([pendingKey(A)])
  })

  test('a window never written down is written under the OLD key on the way out', () => {
    // Esc writes the window; Save/Discard write it; nothing else does. But the
    // lanes are still A's fort when the URL already says B, so the switch is
    // the last moment they can be told apart — and they go under A.
    buildFort()
    expect(storage.map.size).toBe(0)
    visit(`/editor/${B}`)
    syncProjectScope()
    expect(storedPlaced(A)).toBe(2)
    expect(readPendingSnapshot(storage, B)).toBeNull()
    expect(lanes()).toEqual(EMPTY_LANES)
  })

  test('a stale collab bus cannot re-key the lanes to the project you left', () => {
    // The bus is a page global installed after realtime auth; after a
    // client-side switch it may still name the old project for a while, or
    // forever. The route is the identity.
    globals.__pascalCollabBus = { projectId: A }
    buildFort()
    persistPendingChanges()
    visit(`/editor/${B}`)
    expect(syncProjectScope()).toEqual({ from: A, result: 'changed', to: B })
    expect(lanes()).toEqual(EMPTY_LANES)
    expect(laneScopeFor()).toBe(B)
    expect(storedPlaced(A)).toBe(2)
    expect(readPendingSnapshot(storage, B)).toBeNull()
  })

  test('the same project is left alone', () => {
    buildFort()
    expect(syncProjectScope()).toEqual({ from: A, result: 'same', to: A })
    expect(lanes().placed).toBe(2)
    expect(lanes().items).toBe(1)
    expect(storage.map.size).toBe(0)
  })
})

// ── (ii) the reset covers everything, and coming back restores ─────────────

describe('the identity change resets every store that outlives a session', () => {
  test('lanes, catalog ghost, loadout, demolition gate, slot registry', () => {
    buildFort()
    useItems.getState().arm(hingedDoor)
    useBoots.getState().giveWeapon('rifle')
    useBoots.getState().setHealth(40)
    const piece = useBoots.getState().placed[0]!
    expect(registerPlacement('Wx:1,0,0', piece.id)).toBe(true)
    expect(slotOccupied('Wx:1,0,0')).toBe(true)

    resetProjectState()

    expect(lanes()).toEqual(EMPTY_LANES)
    expect(useBoots.getState().owned).toEqual(['knife', 'builder', 'paint'])
    expect(useBoots.getState().health).toBe(100)
    expect(slotOccupied('Wx:1,0,0')).toBe(false)
  })

  test('coming back to A restores A — the restore latch is per lane scope', () => {
    buildFort()
    persistPendingChanges()

    visit(`/editor/${B}`)
    syncProjectScope()
    expect(restorePendingChanges()).toEqual(EMPTY) // B: nothing stored, latch untouched

    visit(`/editor/${A}`)
    expect(syncProjectScope()).toEqual({ from: B, result: 'changed', to: A })
    expect(lanes()).toEqual(EMPTY_LANES)
    const report = restorePendingChanges()
    expect(report).toEqual({ ...EMPTY, apertures: 1, pieces: 2 })
    expect(lanes()).toEqual({ ...EMPTY_LANES, destroyed: 1, items: 1, mine: 1, painted: 1, placed: 2 })
    expect(useBoots.getState().placed.map((p) => p.piece)).toEqual(['wall', 'roof'])
  })

  test('a live session is ended first, and it writes under the OLD key', () => {
    buildFort()
    const seen: Array<string | null> = []
    const deps = {
      endSession: () => {
        // exitGame's persist runs while the lanes still belong to A.
        seen.push(laneScopeFor())
        persistPendingChanges()
      },
      sessionLive: () => true,
    }
    visit(`/editor/${B}`)
    expect(syncProjectScope(deps).result).toBe('changed')
    expect(seen).toEqual([A])
    expect(storedPlaced(A)).toBe(2)
    expect(readPendingSnapshot(storage, B)).toBeNull()
    expect(lanes()).toEqual(EMPTY_LANES)
  })

  test("a 'game' phase left behind by the switch is put back to 'editor'", () => {
    // The phase is the sidebar's write gate; a project with no game running
    // must not sit in 'game' (no Save possible) nor keep a dead session's flag.
    useBoots.getState().setPhase('game')
    visit(`/editor/${B}`)
    expect(syncProjectScope().result).toBe('changed')
    expect(useBoots.getState().phase).toBe('editor')
  })
})

// ── (iii) no project, no key ───────────────────────────────────────────────

describe('a page that names no project', () => {
  test('keys nothing, and empties the lanes on the way out of a project', () => {
    buildFort()
    persistPendingChanges()
    visit('/')
    expect(syncProjectScope()).toEqual({ from: A, result: 'changed', to: null })
    expect(lanes()).toEqual(EMPTY_LANES)
    expect(laneScopeFor()).toBeNull()
    // Whatever happens here is in-page only: no shared fallback key, ever.
    useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    persistPendingChanges()
    expect([...storage.map.keys()]).toEqual([pendingKey(A)])
    expect(restorePendingChanges()).toEqual(EMPTY)
    // …and a later project is a clean start that does not inherit the orphan.
    visit(`/editor/${B}`)
    expect(syncProjectScope()).toEqual({ from: null, result: 'changed', to: B })
    expect(lanes()).toEqual(EMPTY_LANES)
    expect([...storage.map.keys()]).toEqual([pendingKey(A)])
  })

  test('two id-less pages never share a window through a default', () => {
    visit('/lab/portable-editor')
    resetPendingRestore()
    useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    persistPendingChanges()
    expect(storage.map.size).toBe(0)
    expect(laneScopeFor()).toBeNull()
  })
})

// ── the watcher ────────────────────────────────────────────────────────────

describe('watchProjectScope', () => {
  const nodeMap = (id: string) =>
    ({ [id]: { id, object: 'node', parentId: null, type: 'wall' } }) as never

  test('restores on mount, re-keys on a host change, holds the restore for the new document', () => {
    storage.map.set(pendingKey(A), JSON.stringify(snapshotOf({ placed: [storedWall(0)] })))
    storage.map.set(
      pendingKey(B),
      JSON.stringify(
        snapshotOf({
          painted: [{ cells: 4, color: '#aa0000', colorName: 'RED', nodeId: 'wall_B' }],
          placed: [storedWall(7)],
        }),
      ),
    )
    // The page shows A's document.
    useScene.getState().setScene(nodeMap('wall_A'), ['wall_A'] as never)

    stopWatching = watchProjectScope()
    expect(useBoots.getState().placed.map((p) => p.position[0])).toEqual([0])

    // The host navigates to B; its viewer store changes before the document does.
    visit(`/editor/${B}`)
    useViewer.setState({})
    // Re-keyed and emptied at once…
    expect(lanes()).toEqual(EMPTY_LANES)
    expect(laneScopeFor()).toBe(B)
    // …but B's window is NOT restored yet: pruning its painted row against A's
    // nodes would have thrown it away as "gone".
    expect(usePaintKeep.getState().painted.length).toBe(0)
    expect(readPendingSnapshot(storage, B)?.snapshot.painted.length).toBe(1)

    // The host replaces the document — now the restore runs, and nothing is pruned.
    useScene.getState().setScene(nodeMap('wall_B'), ['wall_B'] as never)
    expect(useBoots.getState().placed.map((p) => p.position[0])).toEqual([7])
    expect(usePaintKeep.getState().painted.map((p) => p.nodeId)).toEqual(['wall_B'])
    expect(readPendingSnapshot(storage, B)?.snapshot.painted.length).toBe(1)
    // A's window is untouched by the round trip.
    expect(storedPlaced(A)).toBe(1)
  })

  test('a scene edit in the same project is not a project change', () => {
    storage.map.set(pendingKey(A), JSON.stringify(snapshotOf({ placed: [storedWall(0)] })))
    stopWatching = watchProjectScope()
    expect(useBoots.getState().placed.length).toBe(1)
    useBoots.getState().addPlaced({ piece: 'wall', position: [3, 0, 0], yaw: 0 })
    useScene.getState().setScene(nodeMap('wall_A'), ['wall_A'] as never)
    useViewer.setState({})
    expect(useBoots.getState().placed.length).toBe(2)
    expect(laneScopeFor()).toBe(A)
  })
})
