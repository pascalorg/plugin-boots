import { afterEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { clearDebris } from './debris'
import {
  damageTarget,
  ensureVoxelTarget,
  prevoxelizeTick,
  resetDestruction,
  SHELL_NEAR_RADIUS,
  SHELL_SYNC_BUILD_BUDGET_MS,
  setPrevoxelizeClock,
  setShellFlag,
  shellBuildTick,
  shellPendingCount,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { roofPlaneFrame } from './roof-framing'
import { countDeadFragments, shellCensus } from './shell-layer'
import { shellBoundingSphere } from './shell-render'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Shell S2 — the DEFAULT flip + the lazy shell tier (the memory lever):
 *
 *   - shells default ON for all three kinds; setShell(kind, false) stays
 *     the session-latched kill-switch (pinned in shell-s1/shell-wiring).
 *   - beyond SHELL_NEAR_RADIUS of the player, voxelize builds the grid +
 *     anatomy as always but DEFERS buildShellData: the target registers
 *     dormant (host renders — same look) with `shellPending`, and the
 *     shell arrives via the budgeted nearest-first queue (shellBuildTick,
 *     NEAR-GATED so far targets stay pending) or the wake-path sync build
 *     (per-frame budget-capped, voxel-only fallback past it).
 *   - deferred builds re-collect from the retained host meshes, so a
 *     deferred shell is bit-identical to the eager one (same nodeId seed).
 */

// ─── Fixtures (the shell-wiring wall family + the shell-s1 gable) ─────────

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
  material?: MeshStandardMaterial,
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material)
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

function makeWallWorld(): GameWorld {
  const matA = new MeshStandardMaterial({ color: '#b04030' })
  const matB = new MeshStandardMaterial({ color: '#5a7a4a' })
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0], matA)
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0], matB)
  const colliders = [wallA, wallB]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (c: ColliderEntry, start: [number, number], end: [number, number]) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0])],
      ['wall-2', wallEntry(wallB, [3.5, 0], [6.5, 0])],
    ]),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
}

/** Push quad p0..p3 as two triangles, winding flipped to face `n`. */
function pushQuad(
  out: number[],
  p0: Vector3,
  p1: Vector3,
  p2: Vector3,
  p3: Vector3,
  n: Vector3,
): void {
  const u = new Vector3().subVectors(p1, p0)
  const w = new Vector3().subVectors(p2, p0)
  const flip = new Vector3().crossVectors(u, w).dot(n) < 0
  const tri = (a: Vector3, b: Vector3, c: Vector3) => {
    if (flip) out.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z)
    else out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  tri(p0, p1, p2)
  tri(p0, p2, p3)
}

const GABLE = {
  yaw: 0.6,
  pitch: (35 * Math.PI) / 180,
  eaveLength: 6,
  slopeLength: 4,
  t: 0.12,
  ridge: new Vector3(0, 5, 0),
}

/** Two-plane gable shell (no gable-end caps — the plane members are the
 * lazy tier's subject; the residual lane is pinned in shell-s1). */
function gableShellMesh(material?: MeshStandardMaterial): Mesh {
  const out: number[] = []
  for (const yaw of [GABLE.yaw, GABLE.yaw + Math.PI]) {
    const f = roofPlaneFrame(yaw, GABLE.pitch)
    const A = new Vector3(...f.across)
    const N = new Vector3(...f.normal)
    const U = new Vector3(...f.upSlope)
    const eave = GABLE.ridge.clone().addScaledVector(U, -GABLE.slopeLength)
    const half = A.clone().multiplyScalar(GABLE.eaveLength / 2)
    const up = U.clone().multiplyScalar(GABLE.slopeLength)
    const p0 = eave.clone().sub(half)
    const p1 = eave.clone().add(half)
    const p2 = p1.clone().add(up)
    const p3 = p0.clone().add(up)
    pushQuad(out, p0, p1, p2, p3, N)
    const inN = N.clone().multiplyScalar(-GABLE.t)
    const nIn = N.clone().negate()
    pushQuad(
      out,
      p0.clone().add(inN),
      p1.clone().add(inN),
      p2.clone().add(inN),
      p3.clone().add(inN),
      nIn,
    )
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(out), 3))
  const mesh = new Mesh(geometry, material ?? new MeshStandardMaterial({ color: '#4a3f38' }))
  mesh.updateMatrixWorld(true)
  return mesh
}

function meshCollider(mesh: Mesh, nodeId: string, nodeType: string): ColliderEntry {
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

function worldOf(colliders: ColliderEntry[]): GameWorld {
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
}

const targets = () => useDestruction.getState().targets

/** Focus well past the near radius from both fixture walls / the gable. */
const FAR = { x: 1000, y: 0, z: 1000 }
/** Focus at the fixture origin — everything is near. */
const NEAR = { x: 0, y: 1, z: 0 }

function prevoxelize(world: GameWorld, focus?: { x: number; y: number; z: number }): void {
  let done = false
  for (let i = 0; i < 80 && !done; i++) done = prevoxelizeTick(world, 8, focus)
  expect(done).toBe(true)
}

afterEach(() => {
  setPrevoxelizeClock(null)
  // Restore the S2 defaults for whatever suite runs next.
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
  resetDestruction()
  clearDebris()
})

// ─── Deferral at voxelize ─────────────────────────────────────────────────

describe('lazy shell tier: deferral at voxelize (S2)', () => {
  test('a FAR wall defers: dormant + shellPending, no shell, host keeps colliding', () => {
    const world = makeWallWorld()
    prevoxelize(world, FAR)
    for (const nodeId of ['wall-1', 'wall-2']) {
      const target = targets().get(nodeId)!
      expect(target.shell).toBeUndefined()
      expect(target.shellPending).toEqual({ kind: 'single' })
      expect(target.dormant).toBe(true) // host renders — the editor look
    }
    for (const collider of world.colliders) expect(Boolean(collider.disabled)).toBe(false)
    expect(shellPendingCount()).toBe(2)
    expect(shellCensus().pending).toBe(2)
  })

  test('a NEAR wall builds eagerly at voxelize; no focus at all means eager (S1 behavior)', () => {
    const world = makeWallWorld()
    prevoxelize(world, NEAR)
    expect(targets().get('wall-1')!.shell).toBeDefined()
    expect(shellPendingCount()).toBe(0)
    resetDestruction()
    const world2 = makeWallWorld()
    prevoxelize(world2) // headless callers without a focus: eager, as before
    expect(targets().get('wall-1')!.shell).toBeDefined()
    expect(shellPendingCount()).toBe(0)
  })

  test('a FAR roof defers the whole family: plane members pending, bucketing skipped', () => {
    const world = worldOf([meshCollider(gableShellMesh(), 'roof-1', 'roof')])
    shellBuildTick(0, FAR) // budget ≤ 0 = the probe/focus-stamp contract
    ensureVoxelTarget(world, 'roof-1', { dormant: true })
    const p0 = targets().get('roof-1#p0')!
    const p1 = targets().get('roof-1#p1')!
    expect(p0.shell).toBeUndefined()
    expect(p0.shellPending).toEqual({ kind: 'roof', planeIndex: 0 })
    expect(p1.shellPending).toEqual({ kind: 'roof', planeIndex: 1 })
    expect(p0.dormant).toBe(true)
    expect(shellPendingCount()).toBe(2)
  })
})

// ─── The budgeted queue ───────────────────────────────────────────────────

describe('lazy shell tier: budgeted nearest-first queue', () => {
  test('approaching builds the pending shell: attach + skinRevision + store bump', () => {
    const world = makeWallWorld()
    prevoxelize(world, FAR)
    const target = targets().get('wall-1')!
    const skinBefore = target.skinRevision ?? 0
    const versionBefore = useDestruction.getState().version
    expect(shellBuildTick(50, NEAR)).toBe(true) // everything near now — drains
    expect(target.shell).toBeDefined()
    expect(target.shellMaterials![0]).toBe(
      world.walls.get('wall-1')!.meshes[0]!.material as MeshStandardMaterial,
    )
    expect(target.shellPending).toBeUndefined()
    expect(shellPendingCount()).toBe(0)
    // The core replica may have primed full-size while pending — the bump
    // re-primes it in CORE mode; the store bump mounts the ShellMesh.
    expect(target.skinRevision ?? 0).toBeGreaterThan(skinBefore)
    expect(useDestruction.getState().version).toBeGreaterThan(versionBefore)
    // Still dormant: building the shell is NOT a wake.
    expect(target.dormant).toBe(true)
  })

  test('NEAR GATE: a still-far target stays pending — the memory lever', () => {
    const world = makeWallWorld()
    prevoxelize(world, FAR)
    expect(shellBuildTick(50, FAR)).toBe(false) // funded tick, nothing near
    expect(targets().get('wall-1')!.shell).toBeUndefined()
    expect(shellPendingCount()).toBe(2)
  })

  test('deferred build is BIT-IDENTICAL to the eager one (same nodeId seed)', () => {
    // Eager reference…
    prevoxelize(makeWallWorld(), NEAR)
    const eager = targets().get('wall-1')!.shell!
    const reference = {
      fragments: eager.fragments.map((f) => ({ ...f })),
      forCell: Array.from(eager.fragmentForCell),
      positions: Array.from(eager.positions),
    }
    resetDestruction()
    // …vs defer-then-build.
    prevoxelize(makeWallWorld(), FAR)
    expect(shellBuildTick(50, NEAR)).toBe(true)
    const deferred = targets().get('wall-1')!.shell!
    expect(deferred.fragments.map((f) => ({ ...f }))).toEqual(reference.fragments)
    expect(Array.from(deferred.fragmentForCell)).toEqual(reference.forCell)
    expect(Array.from(deferred.positions)).toEqual(reference.positions)
  })

  test('a deferred roof family builds as one unit: both plane members, shared material table', () => {
    const world = worldOf([meshCollider(gableShellMesh(), 'roof-1', 'roof')])
    shellBuildTick(0, FAR)
    ensureVoxelTarget(world, 'roof-1', { dormant: true })
    expect(shellPendingCount()).toBe(2)
    expect(shellBuildTick(50, { x: GABLE.ridge.x, y: GABLE.ridge.y, z: GABLE.ridge.z })).toBe(true)
    const p0 = targets().get('roof-1#p0')!
    const p1 = targets().get('roof-1#p1')!
    expect(p0.shell).toBeDefined()
    expect(p1.shell).toBeDefined()
    expect(p0.shellMaterials).toBe(p1.shellMaterials) // family-global table
    expect(targets().get('roof-1#residual')?.shell).toBeUndefined()
    expect(shellPendingCount()).toBe(0)
    // Family still dormant — the queue build is not a wake.
    expect(p0.dormant).toBe(true)
  })
})

// ─── Wake-path sync build ─────────────────────────────────────────────────

describe('lazy shell tier: wake-path sync build (budget-capped)', () => {
  test('first damage on a pending wall builds the shell synchronously, then carves it', () => {
    const world = makeWallWorld()
    prevoxelize(world, FAR)
    expect(targets().get('wall-1')!.shell).toBeUndefined()
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.25)
    expect(removed).toBeGreaterThan(0)
    const target = targets().get('wall-1')!
    expect(target.dormant).toBeFalsy()
    expect(target.shell).toBeDefined()
    expect(target.shellPending).toBeUndefined()
    // The sync-built shell is live for THIS carve: fragments died.
    expect(countDeadFragments(target.shell!, target.grid)).toBeGreaterThan(0)
    // The untouched far wall stays pending.
    expect(targets().get('wall-2')!.shellPending).toEqual({ kind: 'single' })
    expect(shellPendingCount()).toBe(1)
  })

  test('first damage on a pending roof wakes + shells the family; the seam carve opens both', () => {
    const world = worldOf([meshCollider(gableShellMesh(), 'roof-1', 'roof')])
    shellBuildTick(0, FAR)
    ensureVoxelTarget(world, 'roof-1', { dormant: true })
    const removed = damageTarget(world, 'roof-1', GABLE.ridge.clone(), 0.4)
    expect(removed).toBeGreaterThan(0)
    const p0 = targets().get('roof-1#p0')!
    const p1 = targets().get('roof-1#p1')!
    expect(p0.dormant).toBeFalsy()
    expect(p0.shell).toBeDefined()
    expect(p1.shell).toBeDefined()
    expect(countDeadFragments(p0.shell!, p0.grid)).toBeGreaterThan(0)
    expect(countDeadFragments(p1.shell!, p1.grid)).toBeGreaterThan(0)
    expect(shellPendingCount()).toBe(0)
  })

  test('sync budget: past SHELL_SYNC_BUILD_BUDGET_MS in one frame window, wakes fall back voxel-only', () => {
    // Deterministic clock: +5 ms per read — the FIRST sync build "costs"
    // 5 ms (> the 3 ms budget), so the SECOND wake inside the same 12 ms
    // window must skip its build and clear the pending (graceful voxel-only
    // fallback; the carve itself still lands on the grid).
    expect(SHELL_SYNC_BUILD_BUDGET_MS).toBeLessThan(5)
    const world = makeWallWorld()
    prevoxelize(world, FAR)
    let clock = 0
    setPrevoxelizeClock(() => {
      clock += 5
      return clock
    })
    const removedA = damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.25)
    expect(removedA).toBeGreaterThan(0)
    expect(targets().get('wall-1')!.shell).toBeDefined() // built (budget open)
    const removedB = damageTarget(world, 'wall-2', new Vector3(5, 1.35, -0.06), 0.25)
    expect(removedB).toBeGreaterThan(0) // the carve is shell-blind — voxels died
    const fellBack = targets().get('wall-2')!
    expect(fellBack.dormant).toBeFalsy()
    expect(fellBack.shell).toBeUndefined() // voxel-only fallback
    expect(fellBack.shellPending).toBeUndefined() // and never rebuilt
    expect(shellPendingCount()).toBe(0)
  })
})

// ─── Renderer hardening (S2) ──────────────────────────────────────────────

describe('shellBoundingSphere (frustum-culling contract)', () => {
  test('wraps the packed verts exactly: AABB midpoint center, half-diagonal radius', () => {
    prevoxelize(makeWallWorld(), NEAR)
    const shell = targets().get('wall-1')!.shell!
    const sphere = shellBoundingSphere(shell)
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    for (let i = 0; i < shell.positions.length; i += 3) {
      const x = shell.positions[i]!
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
    expect(sphere.center.x).toBeCloseTo((minX + maxX) / 2, 5)
    // Every vertex inside the sphere (the culling correctness condition).
    for (let i = 0; i < shell.positions.length; i += 3) {
      const dx = shell.positions[i]! - sphere.center.x
      const dy = shell.positions[i + 1]! - sphere.center.y
      const dz = shell.positions[i + 2]! - sphere.center.z
      expect(Math.hypot(dx, dy, dz)).toBeLessThanOrEqual(sphere.radius + 1e-6)
    }
    // A wall shell spans metres — the sphere must too (not a unit default).
    expect(sphere.radius).toBeGreaterThan(0.5)
  })

  test('empty positions take three’s empty-sphere convention (radius −1)', () => {
    const sphere = shellBoundingSphere({ positions: new Float32Array(0) })
    expect(sphere.radius).toBe(-1)
  })
})

// ─── Constants sanity ─────────────────────────────────────────────────────

describe('S2 policy constants', () => {
  test('near radius clears the grenade lane: BLAST_RADIUS (3.2) + wake-ahead fan-out', () => {
    // wakeAheadTick and every blast ring reach at most BLAST_RADIUS from
    // the detonation point; a grenade landing NEAR the player therefore
    // only wakes shells that built eagerly. (Far grenades ride the sync
    // budget + fallback — pinned above.)
    expect(SHELL_NEAR_RADIUS).toBeGreaterThanOrEqual(3.2 * 2)
  })
})

// Type-level guard: VoxelTarget carries the S2 pending stamp.
const _pendingShape: VoxelTarget['shellPending'] = { kind: 'roof', planeIndex: 0 }
void _pendingShape
