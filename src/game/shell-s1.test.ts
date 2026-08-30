import { afterEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { craterSlots, resetCraters } from './craters'
import { clearDebris } from './debris'
import {
  damageTarget,
  ensureVoxelTarget,
  prevoxelizeTick,
  resetDestruction,
  setShellFlag,
  shellFlags,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { roofPlaneFrame } from './roof-framing'
import { assignRoofTrisToMembers, enumerateRoofPlanes } from './roof-planes'
import { countDeadFragments, deadLatticeKeys, shellCensus } from './shell-layer'
import { drainShellRemovals } from './shell-render'
import { coreCellColor, primedCellColor, shellCoreCellColor } from './skin-tone'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Conforming shell S1 — roof-plane shells + slab shells, each behind its
 * OWN session-latched flag (shellFlags.roof / shellFlags.slab, extending
 * the shipped S0 wall lane):
 *
 *   - roofs: assignRoofTrisToMembers buckets every non-glass host triangle
 *     into exactly ONE plane member (or the residual) BEFORE clipping —
 *     shell.ts clamps out-of-grid centroids, so unbucketed ridge tris
 *     would misfile AND duplicate across sibling shells. Each member
 *     builds its own shell (seed = member id); the residual member stays
 *     voxel-only; the family registers dormant and wakes as one.
 *   - slabs: the S0 wall builder as-is (one grid covers top+bottom+rim),
 *     including zero-extent synthesized ceiling plates; floorCore
 *     under-layers keep the dirt-subfloor tone and the floor-breach lane
 *     fires identically flag on/off (the shell is a pure VIEW).
 */

// ─── Fixtures (the roof-planes.test.ts gable family + slab worlds) ────────

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

/** One sloped plane (outer face + interior underside offset by t). */
function pushPlaneShell(
  out: number[],
  yaw: number,
  pitch: number,
  eaveOuter: Vector3,
  eaveLength: number,
  slopeLength: number,
  t: number,
): void {
  const f = roofPlaneFrame(yaw, pitch)
  const A = new Vector3(...f.across)
  const N = new Vector3(...f.normal)
  const U = new Vector3(...f.upSlope)
  const half = A.clone().multiplyScalar(eaveLength / 2)
  const up = U.clone().multiplyScalar(slopeLength)
  const p0 = eaveOuter.clone().sub(half)
  const p1 = eaveOuter.clone().add(half)
  const p2 = p1.clone().add(up)
  const p3 = p0.clone().add(up)
  pushQuad(out, p0, p1, p2, p3, N)
  const inN = N.clone().multiplyScalar(-t)
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

const GABLE = {
  yaw: 0.6,
  pitch: (35 * Math.PI) / 180,
  eaveLength: 6,
  slopeLength: 4,
  t: 0.12,
  ridge: new Vector3(0, 5, 0),
}

/** Push one triangle, winding flipped to face `n`. */
function pushTri(out: number[], a: Vector3, b: Vector3, c: Vector3, n: Vector3): void {
  const u = new Vector3().subVectors(b, a)
  const w = new Vector3().subVectors(c, a)
  if (new Vector3().crossVectors(u, w).dot(n) < 0) {
    out.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z)
  } else {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
}

/** The two OUTER eave-edge midpoints (down each slope from the ridge). */
function gableEaves(): [Vector3, Vector3] {
  const f = roofPlaneFrame(GABLE.yaw, GABLE.pitch)
  const g = roofPlaneFrame(GABLE.yaw + Math.PI, GABLE.pitch)
  return [
    GABLE.ridge.clone().addScaledVector(new Vector3(...f.upSlope), -GABLE.slopeLength),
    GABLE.ridge.clone().addScaledVector(new Vector3(...g.upSlope), -GABLE.slopeLength),
  ]
}

/** Full gable shell (two planes + the two vertical gable-end triangles),
 * wearing one HOST material instance (the by-reference pin's subject). */
function gableShellMesh(material?: MeshStandardMaterial): Mesh {
  const out: number[] = []
  for (const yaw of [GABLE.yaw, GABLE.yaw + Math.PI]) {
    const f = roofPlaneFrame(yaw, GABLE.pitch)
    const U = new Vector3(...f.upSlope)
    const eave = GABLE.ridge.clone().addScaledVector(U, -GABLE.slopeLength)
    pushPlaneShell(out, yaw, GABLE.pitch, eave, GABLE.eaveLength, GABLE.slopeLength, GABLE.t)
  }
  const A = new Vector3(...roofPlaneFrame(GABLE.yaw, GABLE.pitch).across)
  const [eave1, eave2] = gableEaves()
  for (const sign of [1, -1] as const) {
    const off = A.clone().multiplyScalar((sign * GABLE.eaveLength) / 2)
    pushTri(
      out,
      GABLE.ridge.clone().add(off),
      eave1.clone().add(off),
      eave2.clone().add(off),
      A.clone().multiplyScalar(sign),
    )
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(out), 3))
  const mesh = new Mesh(geometry, material ?? new MeshStandardMaterial({ color: '#4a3f38' }))
  mesh.updateMatrixWorld(true)
  return mesh
}

/** A point halfway down plane 0's OUTER surface (a plain slope shot). */
function slopeMidPoint(): Vector3 {
  const U = new Vector3(...roofPlaneFrame(GABLE.yaw, GABLE.pitch).upSlope)
  return GABLE.ridge.clone().addScaledVector(U, -GABLE.slopeLength / 2)
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
  return meshCollider(mesh, nodeId, nodeType)
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

function roofWorld(mesh: Mesh): GameWorld {
  return worldOf([meshCollider(mesh, 'roof-1', 'roof')])
}

/** A terrain-borne FLOOR slab (floorCore lane, breach-eligible base). */
function groundSlabCollider(nodeId = 'slab-1'): ColliderEntry {
  return boxCollider(nodeId, 'floor', [3, 0.25, 3], [0, 0.125, 0])
}

function prevoxelize(world: GameWorld): void {
  let done = false
  for (let i = 0; i < 80 && !done; i++) done = prevoxelizeTick(world, 8)
  expect(done).toBe(true)
}

const targets = () => useDestruction.getState().targets

const latticeKeyOfVoxel = (target: VoxelTarget, i: number): number => {
  const { coords, nx, ny } = target.grid
  return coords[i * 3]! + nx * (coords[i * 3 + 1]! + ny * coords[i * 3 + 2]!)
}

afterEach(() => {
  // Restore the S2 defaults (ON) for whatever suite runs next.
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
  resetDestruction()
  resetCraters()
  clearDebris()
})

// ─── Phase 1: per-kind flags + latches ────────────────────────────────────

describe('per-kind shell flags (S1 + S2 default flip)', () => {
  test('all three flags exist and default ON (S2: the game loads looking like the editor)', () => {
    expect(shellFlags).toEqual({ wall: true, roof: true, slab: true })
  })

  test('latches are per kind, taken at that kind’s first voxelize; reset re-arms all', () => {
    // Slab ON before ANY voxelize; roof explicitly OFF (kill-switch) for now.
    setShellFlag('slab', true)
    setShellFlag('roof', false)
    const make = () => {
      const g2 = gableShellMesh()
      g2.position.set(40, 0, 0)
      g2.updateMatrixWorld(true)
      return worldOf([
        meshCollider(gableShellMesh(), 'roof-1', 'roof'),
        meshCollider(g2, 'roof-2', 'roof'),
        groundSlabCollider(),
      ])
    }
    const world = make()
    // roof-1 voxelizes with the roof flag OFF — the roof lane latches OFF…
    ensureVoxelTarget(world, 'roof-1')
    expect(targets().get('roof-1#p0')!.shell).toBeUndefined()
    // …so a mid-session flip cannot shell the next roof of the session…
    setShellFlag('roof', true)
    ensureVoxelTarget(world, 'roof-2')
    expect(targets().get('roof-2#p0')!.shell).toBeUndefined()
    // …while the INDEPENDENT slab latch (ON at its own first voxelize)
    // still shells in the very same session.
    expect(ensureVoxelTarget(world, 'slab-1')!.shell).toBeDefined()
    // Next session: resetDestruction re-armed every latch — roof reads ON.
    resetDestruction()
    const world2 = make()
    ensureVoxelTarget(world2, 'roof-1')
    expect(targets().get('roof-1#p0')!.shell).toBeDefined()
  })

  test('prevoxelize lanes follow the latched flags: shelled kinds prebuild DORMANT, off-kinds awake', () => {
    const make = () => worldOf([meshCollider(gableShellMesh(), 'roof-1', 'roof'), groundSlabCollider()])
    // Flags ON: roofs + slabs stay dormant (host keeps rendering AND colliding).
    setShellFlag('roof', true)
    setShellFlag('slab', true)
    const world = make()
    prevoxelize(world)
    expect(targets().get('roof-1#p0')!.dormant).toBe(true)
    expect(targets().get('roof-1#residual')!.dormant).toBe(true)
    expect(targets().get('slab-1')!.dormant).toBe(true)
    for (const collider of world.colliders) expect(Boolean(collider.disabled)).toBe(false)
    resetDestruction()
    // Flags OFF: the voxel-first awake lane, bit-identical to today.
    setShellFlag('roof', false)
    setShellFlag('slab', false)
    const world2 = make()
    prevoxelize(world2)
    expect(targets().get('roof-1#p0')!.dormant).toBeFalsy()
    expect(targets().get('roof-1#p0')!.shell).toBeUndefined()
    expect(targets().get('slab-1')!.dormant).toBeFalsy()
    expect(targets().get('slab-1')!.shell).toBeUndefined()
    for (const collider of world2.colliders) expect(Boolean(collider.disabled)).toBe(true)
  })
})

// ─── Phase 2: roof-plane shells (S1a) ─────────────────────────────────────

describe('roof member partition (assignRoofTrisToMembers)', () => {
  test('exact + disjoint: every non-glass tri lands in exactly one bucket or the residual', () => {
    const mesh = gableShellMesh()
    const planes = enumerateRoofPlanes([mesh])
    expect(planes.length).toBe(2)
    const { buckets, residual, materials } = assignRoofTrisToMembers([mesh], planes)
    const totalTris = mesh.geometry.getAttribute('position')!.count / 3
    expect(buckets.length).toBe(2)
    // 4 tris per plane (outer quad up-cone + inner underside opposite-cone),
    // the 2 vertical gable-end tris residual — nothing dropped, nothing
    // duplicated: the partition is exact and disjoint by count.
    expect(buckets[0]!.length).toBe(4)
    expect(buckets[1]!.length).toBe(4)
    expect(residual.length).toBe(2)
    expect(buckets[0]!.length + buckets[1]!.length + residual.length).toBe(totalTris)
    // ONE family-global material table, host instance BY REFERENCE.
    expect(materials.length).toBe(1)
    expect(materials[0]).toBe(mesh.material as MeshStandardMaterial)
  })

  test('glass-like sub-meshes contribute nothing (shatter lane keeps them)', () => {
    const mesh = gableShellMesh()
    const planes = enumerateRoofPlanes([mesh])
    const glassMaterial = new MeshStandardMaterial({ transparent: true, opacity: 0.3 })
    const pane = new Mesh(new BoxGeometry(0.8, 0.8, 0.02), glassMaterial)
    pane.position.copy(GABLE.ridge)
    pane.updateMatrixWorld(true)
    const withPane = assignRoofTrisToMembers([mesh, pane], planes)
    const without = assignRoofTrisToMembers([mesh], planes)
    expect(withPane.materials).not.toContain(glassMaterial)
    expect(withPane.buckets[0]!.length).toBe(without.buckets[0]!.length)
    expect(withPane.buckets[1]!.length).toBe(without.buckets[1]!.length)
    expect(withPane.residual.length).toBe(without.residual.length)
  })
})

describe('roof plane shells (S1a wiring)', () => {
  test('flag ON: every plane member carries its own shell, residual stays voxel-only, family dormant', () => {
    setShellFlag('roof', true)
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    const p0 = targets().get('roof-1#p0')!
    const p1 = targets().get('roof-1#p1')!
    const residual = targets().get('roof-1#residual')!
    for (const member of [p0, p1]) {
      const shell = member.shell!
      expect(shell).toBeDefined()
      expect(shell.fragments.length).toBeGreaterThan(0)
      // Lattice-indexed over the member's OWN grid…
      const grid = member.grid
      expect(shell.fragmentForCell.length).toBe(grid.nx * grid.ny * grid.nz)
      // …covering every alive cell (both skins of the pitched sandwich).
      for (let i = 0; i < grid.count; i++) {
        if (grid.alive[i] === 0) continue
        expect(shell.fragmentForCell[latticeKeyOfVoxel(member, i)]!).toBeGreaterThanOrEqual(0)
      }
      // The family-global host material table rides by reference.
      expect(member.shellMaterials).toBe(p0.shellMaterials)
      expect(member.dormant).toBe(true)
    }
    // The residual member (gable ends) is voxels only — no shell, ever.
    expect(residual.shell).toBeUndefined()
    expect(residual.dormant).toBe(true)
    // Census: two shelled roof members, zero wall/slab.
    const census = shellCensus()
    expect(census.byKind.roof.targets).toBe(2)
    expect(census.byKind.wall.targets).toBe(0)
    expect(census.byKind.slab.targets).toBe(0)
    expect(census.targets).toBe(2)
    expect(census.fragments).toBe(p0.shell!.fragments.length + p1.shell!.fragments.length)
  })

  test('first damage wakes the WHOLE family (every member’s dormancy drops in one wake)', () => {
    setShellFlag('roof', true)
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    for (const id of ['roof-1#p0', 'roof-1#p1', 'roof-1#residual']) {
      expect(targets().get(id)!.dormant).toBe(true)
    }
    const removed = damageTarget(world, 'roof-1', slopeMidPoint(), 0.3)
    expect(removed).toBeGreaterThan(0)
    for (const id of ['roof-1#p0', 'roof-1#p1', 'roof-1#residual']) {
      expect(targets().get(id)!.dormant).toBeFalsy()
    }
  })

  test('a ridge-seam carve kills fragments in BOTH sibling shells', () => {
    setShellFlag('roof', true)
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    const p0 = targets().get('roof-1#p0')!
    const p1 = targets().get('roof-1#p1')!
    const removed = damageTarget(world, 'roof-1', GABLE.ridge.clone(), 0.4)
    expect(removed).toBeGreaterThan(0)
    // The plane grids overlap a hair at the ridge — the group fan-out opens
    // both, and each member's OWN shell loses fragments (no shared cells,
    // no duplicated surface: each shell only knows its own bucket).
    expect(countDeadFragments(p0.shell!, p0.grid)).toBeGreaterThan(0)
    expect(countDeadFragments(p1.shell!, p1.grid)).toBeGreaterThan(0)
  })

  test('deterministic: the same nodeId rebuilds the exact same fragment pattern', () => {
    const build = () => {
      setShellFlag('roof', true)
      ensureVoxelTarget(roofWorld(gableShellMesh()), 'roof-1')
      const shell = targets().get('roof-1#p0')!.shell!
      const snapshot = {
        fragments: shell.fragments.map((f) => ({ ...f })),
        forCell: Array.from(shell.fragmentForCell),
      }
      resetDestruction()
      return snapshot
    }
    const a = build()
    const b = build()
    expect(a.fragments).toEqual(b.fragments)
    expect(a.forCell).toEqual(b.forCell)
  })

  test('flag OFF is bit-identical: same members, same carve results, no shells', () => {
    const run = (shellOn: boolean) => {
      setShellFlag('roof', shellOn)
      const world = roofWorld(gableShellMesh())
      ensureVoxelTarget(world, 'roof-1')
      const removed = damageTarget(world, 'roof-1', slopeMidPoint(), 0.3)
      const members = ['roof-1#p0', 'roof-1#p1', 'roof-1#residual'].map((id) => {
        const t = targets().get(id)!
        return {
          id,
          aliveCount: t.grid.aliveCount,
          alive: Array.from(t.grid.alive).join(''),
          broken: t.segments.map((s) => (s.broken ? 1 : 0)).join(''),
        }
      })
      const shelled = ['roof-1#p0', 'roof-1#p1'].every((id) => targets().get(id)!.shell)
      resetDestruction()
      setShellFlag('roof', false)
      return { removed, members, shelled }
    }
    const on = run(true)
    const off = run(false)
    expect(on.shelled).toBe(true)
    expect(off.shelled).toBe(false)
    expect(on.removed).toBe(off.removed)
    expect(on.members).toEqual(off.members)
  })
})

// ─── Phase 3: slab shells (S1b) ───────────────────────────────────────────

describe('slab shells (S1b wiring)', () => {
  test('flag ON: the sandwich carries a shell; top and bottom skins are distinct fragments', () => {
    setShellFlag('slab', true)
    const world = worldOf([groundSlabCollider()])
    const target = ensureVoxelTarget(world, 'slab-1')!
    expect(target.kind).toBe('slab')
    expect(target.dormant).toBe(true)
    const shell = target.shell!
    expect(shell).toBeDefined()
    const grid = target.grid
    expect(shell.fragmentForCell.length).toBe(grid.nx * grid.ny * grid.nz)
    // Every alive cell (both Y skins) is covered.
    for (let i = 0; i < grid.count; i++) {
      if (grid.alive[i] === 0) continue
      expect(shell.fragmentForCell[latticeKeyOfVoxel(target, i)]!).toBeGreaterThanOrEqual(0)
    }
    // An INTERIOR plan column: its top-face and bottom-face cells belong to
    // different fragments (clusters can't tunnel through the surface-less
    // cavity layer away from the rim).
    const ix = Math.floor(grid.nx / 2)
    const iz = Math.floor(grid.nz / 2)
    const topKey = ix + grid.nx * (grid.ny - 1 + grid.ny * iz)
    const bottomKey = ix + grid.nx * (0 + grid.ny * iz)
    const fragTop = shell.fragmentForCell[topKey]!
    const fragBottom = shell.fragmentForCell[bottomKey]!
    expect(fragTop).toBeGreaterThanOrEqual(0)
    expect(fragBottom).toBeGreaterThanOrEqual(0)
    expect(fragTop).not.toBe(fragBottom)
  })

  test('a through-carve detaches BOTH skins’ fragments (cavity ward included)', () => {
    setShellFlag('slab', true)
    const world = worldOf([groundSlabCollider()])
    const target = ensureVoxelTarget(world, 'slab-1')!
    const shell = target.shell!
    const grid = target.grid
    const ix = Math.floor(grid.nx / 2)
    const iz = Math.floor(grid.nz / 2)
    const topKey = ix + grid.nx * (grid.ny - 1 + grid.ny * iz)
    const bottomKey = ix + grid.nx * (0 + grid.ny * iz)
    const cx = grid.origin.x + (ix + 0.5) * grid.cellX
    const cz = grid.origin.z + (iz + 0.5) * grid.cellZ
    // Radius past the pierce gate: one carve opens the column clean through.
    const removed = damageTarget(world, 'slab-1', new Vector3(cx, 0.25, cz), 0.7)
    expect(removed).toBeGreaterThan(0)
    const dead: number[] = []
    for (let i = 0; i < grid.count; i++) if (grid.alive[i] === 0) dead.push(i)
    const keys = deadLatticeKeys(grid, dead)
    const killed = new Uint8Array(shell.fragments.length)
    drainShellRemovals(shell, keys, killed)
    expect(killed[shell.fragmentForCell[topKey]!]).toBe(1)
    expect(killed[shell.fragmentForCell[bottomKey]!]).toBe(1)
  })

  test('zero-extent ceiling plates: the synthesized one-sided plate still shells', () => {
    setShellFlag('slab', true)
    const world = worldOf([boxCollider('ceil-1', 'ceiling', [6.5, 0.0002, 5], [0, 2.48, 0])])
    const target = ensureVoxelTarget(world, 'ceil-1')!
    expect(target.kind).toBe('slab')
    expect(target.contactOnlySupport).toBe(true)
    const shell = target.shell!
    expect(shell).toBeDefined()
    // Fragment count > 0 and every fragmentForCell entry in bounds.
    expect(shell.fragments.length).toBeGreaterThan(0)
    const grid = target.grid
    expect(shell.fragmentForCell.length).toBe(grid.nx * grid.ny * grid.nz)
    for (let c = 0; c < shell.fragmentForCell.length; c++) {
      const fragment = shell.fragmentForCell[c]!
      expect(fragment).toBeGreaterThanOrEqual(-1)
      expect(fragment).toBeLessThan(shell.fragments.length)
    }
    // Every alive plate cell is covered (the shell works one-sided).
    for (let i = 0; i < grid.count; i++) {
      if (grid.alive[i] === 0) continue
      expect(shell.fragmentForCell[latticeKeyOfVoxel(target, i)]!).toBeGreaterThanOrEqual(0)
    }
  })

  test('floorCore core tone: under-layers keep the dirt subfloor read, top layer takes the core tone', () => {
    setShellFlag('slab', true)
    const world = worldOf([groundSlabCollider()])
    const target = ensureVoxelTarget(world, 'slab-1')!
    expect(target.floorCore).toBe(true)
    const grid = target.grid
    let below = -1
    let top = -1
    for (let i = 0; i < grid.count && (below < 0 || top < 0); i++) {
      const iy = grid.coords[i * 3 + 1]!
      if (iy < grid.ny - 1 && below < 0) below = i
      if (iy === grid.ny - 1 && top < 0) top = i
    }
    expect(below).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
    // Below the walking layer: the EXACT primedCellColor floorCore dirt.
    const a = new Color()
    const b = new Color()
    expect(shellCoreCellColor(a, target, below).equals(primedCellColor(b, target, below))).toBe(
      true,
    )
    // Top layer: the flat slab core tone (darkened base, no dirt).
    expect(
      shellCoreCellColor(a, target, top).equals(coreCellColor(target.baseColor, 'slab', b)),
    ).toBe(true)
    expect(a.equals(primedCellColor(b, target, top))).toBe(false)
  })

  test('floor-breach census parity: the breach fires identically flag on/off', () => {
    const run = (shellOn: boolean) => {
      setShellFlag('slab', shellOn)
      resetCraters()
      const world = worldOf([groundSlabCollider()])
      const removed = damageTarget(world, 'slab-1', new Vector3(0, 0.25, 0), 0.7)
      const target = targets().get('slab-1')!
      const shelled = target.shell !== undefined
      const alive = Array.from(target.grid.alive).join('')
      const craters = craterSlots()
        .filter((s) => s.alive)
        .map((s) => ({ breach: s.breach, x: s.x, z: s.z, y: s.y, radius: s.radius }))
      resetDestruction()
      setShellFlag('slab', false)
      return { removed, shelled, alive, craters }
    }
    const on = run(true)
    const off = run(false)
    expect(on.shelled).toBe(true)
    expect(off.shelled).toBe(false)
    // The breach really fired — and identically (grid-driven, shell-blind).
    expect(on.craters.length).toBeGreaterThan(0)
    expect(on.craters[0]!.breach).toBe(true)
    expect(on.craters).toEqual(off.craters)
    expect(on.removed).toBe(off.removed)
    expect(on.alive).toBe(off.alive)
  })

  test('census: wall + slab lanes count separately and sum to the totals', () => {
    setShellFlag('wall', true)
    setShellFlag('slab', true)
    setShellFlag('roof', false) // pin the enabled-report shape below
    const matA = new MeshStandardMaterial({ color: '#b04030' })
    const wallC = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [8, 1.35, 0], matA)
    const world = worldOf([wallC, groundSlabCollider()])
    ;(world.walls as Map<string, unknown>).set('wall-1', {
      node: { id: 'wall-1', start: [7, 0], end: [9, 0], height: 2.7, thickness: 0.12 },
      root: wallC.root,
      meshes: [wallC.mesh],
    })
    prevoxelize(world)
    const census = shellCensus()
    expect(census.enabled).toEqual({ wall: true, roof: false, slab: true })
    expect(census.byKind.wall.targets).toBe(1)
    expect(census.byKind.slab.targets).toBe(1)
    expect(census.byKind.roof.targets).toBe(0)
    expect(census.targets).toBe(2)
    expect(census.byKind.wall.fragments + census.byKind.slab.fragments).toBe(census.fragments)
    expect(census.fragments).toBeGreaterThan(0)
    expect(census.killed).toBe(0)
  })
})
