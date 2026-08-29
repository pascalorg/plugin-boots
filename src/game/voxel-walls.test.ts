import { afterEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  StaticDrawUsage,
  Vector3,
} from 'three'
import { ensureVoxelTarget, resetDestruction, useDestruction, wakeTarget } from './destruction'
import { CEILING_FACE_TINT } from './skin-tone'
import {
  CEILING_GEOMETRY,
  CORE_INSET_FRAC,
  coreThicknessAxis,
  DORMANT_PRIME_PER_FRAME,
  type DormantPrimeEntry,
  dormantPrimeQueueSize,
  drainDormantPrimes,
  floorUnderlayLayout,
  freezeStaticSubtree,
  gridBoundingSphere,
  markStorageInstanced,
  membersBoundingSphere,
  primeDormantNow,
  queueDormantPrime,
  shiftFrozenSubtreeY,
  syncDormantWallFrame,
  UNDERLAY_DROP,
  UNDERLAY_MAX_BASE_Y,
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

  test('a prime that arms a warm draw ends the drain for the frame', () => {
    // Warm-draw serialization: the armed prime's GPU upload lands next
    // frame, so the drain stops there — one first-upload per frame instead
    // of the whole budget's worth stacking on a single entry frame.
    const uploader = spyEntry()
    uploader.prime = () => {
      uploader.calls++
      return true // armed a warm draw
    }
    const waiting = spyEntry()
    queueDormantPrime(uploader)
    queueDormantPrime(waiting)

    expect(drainDormantPrimes(2)).toBe(1) // budget 2, but the upload gates
    expect(uploader.calls).toBe(1)
    expect(waiting.calls).toBe(0)
    expect(drainDormantPrimes(2)).toBe(1) // next frame drains the rest
    expect(waiting.calls).toBe(1)
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

describe('dirt underlay layout (owner wave 5: broken floor shows earth)', () => {
  const grid = (originY: number) => ({
    origin: { x: -4, y: originY, z: 1 },
    nx: 10,
    nz: 20,
    cellX: 0.3,
    cellZ: 0.3,
  })

  test('a terrain-borne floor slab gets a full-footprint plane just under the sandwich', () => {
    const layout = floorUnderlayLayout({ floorCore: true, kind: 'slab', grid: grid(-0.04) })!
    expect(layout).not.toBeNull()
    expect(layout.width).toBeCloseTo(3, 10)
    expect(layout.depth).toBeCloseTo(6, 10)
    expect(layout.x).toBeCloseTo(-4 + 1.5, 10)
    expect(layout.z).toBeCloseTo(1 + 3, 10)
    expect(layout.y).toBeCloseTo(-0.04 - UNDERLAY_DROP, 10)
  })

  test('upper-storey floors, ceilings and non-slabs never get one', () => {
    // Upper storey: a hole must show the room below, never a dirt plane.
    expect(
      floorUnderlayLayout({ floorCore: true, kind: 'slab', grid: grid(UNDERLAY_MAX_BASE_Y + 0.01) }),
    ).toBeNull()
    // Ceiling-family slab (no floorCore) and non-slab kinds.
    expect(floorUnderlayLayout({ kind: 'slab', grid: grid(0) })).toBeNull()
    expect(floorUnderlayLayout({ floorCore: true, kind: 'volume', grid: grid(0) })).toBeNull()
  })

  test('a real ground slab target carries floorCore and yields a layout', () => {
    const slab = boxCollider('slab-u', 'slab', [3, 0.2, 3], [0, 0.1, 5])
    const world = makeWorld([slab])
    const target = ensureVoxelTarget(world, 'slab-u')!
    expect(target.kind).toBe('slab')
    expect(target.floorCore).toBe(true)
    const layout = floorUnderlayLayout(target)
    expect(layout).not.toBeNull()
    expect(layout!.y).toBeLessThan(0.01) // under the slab's grid base
  })
})

describe('ceiling face tint (round-5 QA eave teeth: attic side mutes per FACE)', () => {
  test('CEILING_GEOMETRY: bottom-face vertices stay 1, every other face wears CEILING_FACE_TINT', () => {
    // The one-cell-layer ceiling contract: vertexColor × instanceColor —
    // the bottom face (the room ceiling, seen from below) must render the
    // instance tone BIT-EXACT (vertex color 1), while the attic TOP and
    // the four rim faces carry the structural mute that kills the light
    // sawtooth through the eave slit.
    const normal = CEILING_GEOMETRY.getAttribute('normal')
    const color = CEILING_GEOMETRY.getAttribute('color')
    expect(color).toBeDefined()
    expect(color.count).toBe(normal.count)
    let down = 0
    let other = 0
    for (let v = 0; v < normal.count; v++) {
      if (normal.getY(v) < -0.5) {
        expect(color.getX(v)).toBe(1)
        expect(color.getY(v)).toBe(1)
        expect(color.getZ(v)).toBe(1)
        down++
      } else {
        expect(color.getX(v)).toBeCloseTo(CEILING_FACE_TINT[0], 6) // float32 attribute
        expect(color.getY(v)).toBeCloseTo(CEILING_FACE_TINT[1], 6)
        expect(color.getZ(v)).toBeCloseTo(CEILING_FACE_TINT[2], 6)
        other++
      }
    }
    expect(down).toBe(4) // one box face
    expect(other).toBe(20) // the five structural faces
  })

  test('a real ceiling target carries ceilingTop (the geometry pick key); floors and walls never do', () => {
    const ceil = boxCollider('ceil-g', 'ceiling', [3, 0.1, 3], [0, 2.6, 5])
    const world = makeWorld([ceil])
    const target = ensureVoxelTarget(world, 'ceil-g')!
    expect(target.kind).toBe('slab')
    expect(target.ceilingTop).toBe(true)
    expect(target.floorCore).toBeFalsy()
  })
})

describe('static-scene discipline (idle perf 2026-08-29)', () => {
  test('markStorageInstanced: WebGPU flags the matrix attribute, usage stays STATIC', () => {
    const mesh = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 4)
    const attr = mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean }

    // Non-WebGPU renderers (or none): untouched — the WebGL fallback has no
    // storage-buffer vertex path.
    expect(markStorageInstanced(mesh, null)).toBe(false)
    expect(markStorageInstanced(mesh, {})).toBe(false)
    expect(markStorageInstanced(mesh, { backend: {} })).toBe(false)
    expect(attr.isStorageInstancedBufferAttribute).toBeUndefined()

    expect(markStorageInstanced(mesh, { backend: { isWebGPUBackend: true } })).toBe(true)
    expect(attr.isStorageInstancedBufferAttribute).toBe(true)
    // The whole point: no DynamicDrawUsage anywhere — uploads ride version
    // bumps (needsUpdate on actual mutation), never the every-frame path.
    expect(mesh.instanceMatrix.usage).toBe(StaticDrawUsage)
  })

  test('gridBoundingSphere covers every cell center of a real target with cell margin', () => {
    const crate = boxCollider('crate-bs', 'item', [1.4, 0.9, 1.1], [4, 0.45, -2])
    const world = makeWorld([crate])
    const target = ensureVoxelTarget(world, 'crate-bs')!
    const sphere = gridBoundingSphere(target.grid)

    const { grid } = target
    let maxDist = 0
    for (let i = 0; i < grid.count; i++) {
      const dx = grid.centers[i * 3]! - sphere.center.x
      const dy = grid.centers[i * 3 + 1]! - sphere.center.y
      const dz = grid.centers[i * 3 + 2]! - sphere.center.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist > maxDist) maxDist = dist
    }
    const halfCell = Math.hypot(grid.cellX, grid.cellY, grid.cellZ) / 2
    // Every center inside, with at least the half-cell diagonal to spare —
    // the cell's own extent can never poke out of the sphere.
    expect(maxDist + halfCell).toBeLessThanOrEqual(sphere.radius + 1e-9)
    // …and the sphere is TIGHT (no bigger than the AABB guarantee).
    expect(sphere.radius).toBeLessThanOrEqual(Math.hypot(1.4, 0.9, 1.1) / 2 + 2 * halfCell + 1e-9)
  })

  test('gridBoundingSphere / membersBoundingSphere: empty input culls (radius −1)', () => {
    expect(
      gridBoundingSphere({ count: 0, centers: new Float32Array(), cellX: 1, cellY: 1, cellZ: 1 })
        .radius,
    ).toBe(-1)
    expect(membersBoundingSphere([]).radius).toBe(-1)
  })

  test('membersBoundingSphere covers member centers plus the largest half-diagonal', () => {
    const sphere = membersBoundingSphere([
      { center: [0, 0, 0], size: [1, 2, 1] },
      { center: [4, 0, 0], size: [2, 0.1, 0.1] },
    ])
    expect(sphere.center.x).toBeCloseTo(2, 10)
    expect(sphere.center.y).toBeCloseTo(0, 10)
    // half AABB diagonal (2) + biggest member half-diagonal (hypot(1,2,1)/2)
    expect(sphere.radius).toBeCloseTo(2 + Math.hypot(1, 2, 1) / 2, 10)
    // A yawed member never leaves its center's half-diagonal ball, so both
    // members stay inside no matter their rotation.
    expect(sphere.radius).toBeGreaterThan(2 + Math.hypot(2, 0.1, 0.1) / 2 - 1e-9)
  })

  test('freezeStaticSubtree settles world matrices once, then the force-cascade skips it', () => {
    const parent = new Group()
    parent.position.set(1, 2, 3)
    const replica = new Group()
    parent.add(replica)
    const skin = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 2)
    const underlay = new Mesh(new BoxGeometry())
    underlay.position.set(0.5, -0.1, 0)
    replica.add(skin)
    replica.add(underlay)

    freezeStaticSubtree(replica)
    for (const obj of [replica, skin, underlay]) {
      expect(obj.matrixAutoUpdate).toBe(false)
      expect(obj.matrixWorldAutoUpdate).toBe(false)
    }
    expect(parent.matrixAutoUpdate).toBe(true) // ancestors stay live
    expect(new Vector3().setFromMatrixPosition(underlay.matrixWorld).y).toBeCloseTo(1.9, 10)

    // The renderer's per-frame walk (root recompose → force=true cascade)
    // must not rewrite the frozen matrices — that's the 15% idle cost.
    parent.position.set(100, 100, 100)
    parent.updateMatrixWorld(true)
    expect(new Vector3().setFromMatrixPosition(skin.matrixWorld).x).toBeCloseTo(1, 10)
    expect(new Vector3().setFromMatrixPosition(underlay.matrixWorld).y).toBeCloseTo(1.9, 10)
  })

  test('shiftFrozenSubtreeY: the warm draw moves a frozen replica and restores it exactly', () => {
    const parent = new Group()
    parent.position.set(0, 1, 0)
    const replica = new Group()
    parent.add(replica)
    const skin = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 2)
    replica.add(skin)
    freezeStaticSubtree(replica)

    shiftFrozenSubtreeY(replica, -600)
    expect(replica.position.y).toBeCloseTo(-600, 10)
    expect(new Vector3().setFromMatrixPosition(replica.matrixWorld).y).toBeCloseTo(-599, 8)
    expect(new Vector3().setFromMatrixPosition(skin.matrixWorld).y).toBeCloseTo(-599, 8)

    shiftFrozenSubtreeY(replica, 600)
    expect(new Vector3().setFromMatrixPosition(skin.matrixWorld).y).toBeCloseTo(1, 8)
    // Still frozen — the walk that follows must keep skipping it.
    expect(replica.matrixAutoUpdate).toBe(false)
    expect(replica.matrixWorldAutoUpdate).toBe(false)
    expect(replica.matrixWorldNeedsUpdate).toBe(false)
  })
})

describe('core mode (conforming-shell targets) — pure helpers', () => {
  test('coreThicknessAxis picks the smallest PHYSICAL extent, like dropInteriorCells', () => {
    // Anisotropic wall grid: thin z cells but as many layers as x/y spans —
    // raw spans lie, metres do not.
    expect(coreThicknessAxis({ nx: 14, ny: 18, nz: 3, cellX: 0.15, cellY: 0.15, cellZ: 0.04 })).toBe(2)
    // Wall thin along x.
    expect(coreThicknessAxis({ nx: 3, ny: 18, nz: 14, cellX: 0.04, cellY: 0.15, cellZ: 0.15 })).toBe(0)
    // Slab sandwich: thickness axis is Y.
    expect(coreThicknessAxis({ nx: 10, ny: 3, nz: 12, cellX: 0.3, cellY: 0.05, cellZ: 0.3 })).toBe(1)
  })

  test('CORE_INSET_FRAC leaves a strictly-inside core (both directions, > 0 remains)', () => {
    // ~20% off each side: the remaining scale must be positive and strictly
    // under the shell surface (1 − 2·frac of the cell).
    expect(CORE_INSET_FRAC).toBeCloseTo(0.2, 10)
    const remaining = 1 - 2 * CORE_INSET_FRAC
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(1)
  })
})
