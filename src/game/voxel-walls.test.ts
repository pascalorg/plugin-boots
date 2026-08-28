import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { ensureVoxelTarget, resetDestruction, useDestruction, wakeTarget } from './destruction'
import {
  DORMANT_PRIME_PER_FRAME,
  type DormantPrimeEntry,
  dormantPrimeQueueSize,
  drainDormantPrimes,
  primeDormantNow,
  queueDormantPrime,
  syncDormantWallFrame,
} from './voxel-walls'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Dormant pre-mount lane (perf night 3 — the 391 ms mass-wake fix), pure
 * side: the budgeted prime queue VoxelWalls drains a couple per frame, and
 * the WAKE-IS-A-VISIBILITY-FLIP contract of syncDormantWallFrame (the exact
 * function VoxelWallMesh runs per frame). The React mount itself is pinned
 * live by QA; everything observable — budget, tombstones, idempotence, the
 * flip + at-most-one-prime rule — asserts here without a renderer.
 */

/** A live entry whose prime() counts its calls. */
function spyEntry(): DormantPrimeEntry & { calls: number } {
  const entry = {
    primed: false,
    calls: 0,
    prime: () => {
      entry.calls++
    },
  }
  return entry
}

afterEach(() => {
  // The module queue survives between tests — sweep it empty (tombstoned
  // entries drop for free, live ones prime into their spies).
  drainDormantPrimes(Number.POSITIVE_INFINITY)
  resetDestruction()
})

describe('dormant prime queue — budgeted drain', () => {
  test('drains at most the budget per call, FIFO, until empty', () => {
    const entries = Array.from({ length: 5 }, spyEntry)
    for (const entry of entries) queueDormantPrime(entry)
    expect(dormantPrimeQueueSize()).toBe(5)

    expect(drainDormantPrimes()).toBe(DORMANT_PRIME_PER_FRAME)
    expect(entries[0]!.calls).toBe(1)
    expect(entries[1]!.calls).toBe(1)
    expect(entries[2]!.calls).toBe(0) // over budget — waits its turn
    expect(dormantPrimeQueueSize()).toBe(3)

    expect(drainDormantPrimes()).toBe(2)
    expect(drainDormantPrimes()).toBe(1)
    expect(drainDormantPrimes()).toBe(0) // empty queue idles for free
    for (const entry of entries) expect(entry.calls).toBe(1)
  })

  test('tombstoned / pre-woken entries drop without consuming budget', () => {
    const gone = spyEntry()
    gone.primed = true // unmount tombstone (or an already-woken target)
    const live = [spyEntry(), spyEntry()]
    queueDormantPrime(gone)
    for (const entry of live) queueDormantPrime(entry)

    // One drain call still primes BOTH live entries — the tombstone is free.
    expect(drainDormantPrimes(2)).toBe(2)
    expect(gone.calls).toBe(0)
    for (const entry of live) expect(entry.calls).toBe(1)
  })

  test('primeDormantNow (the wake path) is idempotent against the queue', () => {
    const entry = spyEntry()
    queueDormantPrime(entry)
    primeDormantNow(entry) // wake reached the target before the queue did
    primeDormantNow(entry)
    expect(entry.calls).toBe(1)
    // The queued copy is now a tombstone — the drain never double-primes.
    expect(drainDormantPrimes(8)).toBe(0)
    expect(entry.calls).toBe(1)
  })
})

describe('syncDormantWallFrame — wake is a visibility flip', () => {
  test('dormant keeps the replica hidden and unprimed; wake flips + primes once', () => {
    const group = { visible: true } // JSX default before the first frame
    const wall: { dormant?: boolean } = { dormant: true }
    const entry = spyEntry()

    expect(syncDormantWallFrame(group, wall, entry)).toBe(false)
    expect(group.visible).toBe(false)
    expect(entry.calls).toBe(0)
    syncDormantWallFrame(group, wall, entry) // steady dormant frames: no-ops
    expect(entry.calls).toBe(0)

    wall.dormant = false // the wake — no mount, no store round-trip needed
    expect(syncDormantWallFrame(group, wall, entry)).toBe(true)
    expect(group.visible).toBe(true)
    expect(entry.calls).toBe(1)
    syncDormantWallFrame(group, wall, entry) // later frames never re-prime
    expect(entry.calls).toBe(1)
  })

  test('a queue-primed hidden replica stays hidden, then wakes without re-priming', () => {
    const group = { visible: false }
    const wall: { dormant?: boolean } = { dormant: true }
    const entry = spyEntry()
    queueDormantPrime(entry)

    drainDormantPrimes() // the budget reaches it while still dormant
    expect(entry.calls).toBe(1)
    syncDormantWallFrame(group, wall, entry)
    expect(group.visible).toBe(false) // primed ≠ visible — the host still renders

    wall.dormant = false
    syncDormantWallFrame(group, wall, entry)
    expect(group.visible).toBe(true)
    expect(entry.calls).toBe(1) // pure flip — the prime already happened
  })
})

// ── Integration: the real dormant target drives the same contract ──────────

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

function makeWorld(colliders: ColliderEntry[]): GameWorld {
  const buildingAabb = new Box3()
  for (const collider of colliders) buildingAabb.union(collider.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(0, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('dormant target ↔ replica contract (real destruction store)', () => {
  test('dormant prebuilds are IN the render list; wakeTarget flips them through the pure sync', () => {
    const crate = boxCollider('crate-d', 'item', [1.2, 0.9, 1.2], [4, 0.45, 0])
    const world = makeWorld([crate])
    const target = ensureVoxelTarget(world, 'crate-d', { dormant: true })!
    expect(target.dormant).toBe(true)
    // VoxelWalls' memo maps over the WHOLE target map now (no dormant
    // filter) — a dormant prebuild gets its hidden replica mounted.
    expect([...useDestruction.getState().targets.values()]).toContain(target)
    // …and the host keeps COLLIDING (and rendering) while the replica hides.
    expect(crate.disabled).toBeFalsy()

    const group = { visible: true }
    const entry = spyEntry()
    syncDormantWallFrame(group, target, entry)
    expect(group.visible).toBe(false)

    wakeTarget(world, target)
    expect(target.dormant).toBeFalsy()
    syncDormantWallFrame(group, target, entry)
    expect(group.visible).toBe(true) // the wake was a visibility flip…
    expect(entry.calls).toBe(1) // …plus at most one prime, never a remount
    expect(crate.disabled).toBe(true) // colliders handed over on wake
    // (the host MESH hide rides the session ledger — live-QA territory,
    // hideForGame is a no-op without an active session)
  })
})
