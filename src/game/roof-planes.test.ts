import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { clearDebris } from './debris'
import {
  damageTarget,
  ensureVoxelTarget,
  raycastSegments,
  resetDestruction,
  useDestruction,
  setShellFlag,
} from './destruction'
import { RAFTER_D, roofPlaneFrame } from './roof-framing'
import { enumerateRoofPlanes } from './roof-planes'
import { isUntexturedWhite, toneAuditReport } from './skin-tone'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

// S2 flips conforming shells DEFAULT ON. This suite pins the VOXEL-ONLY
// lane (awake voxelize, collider hand-over, replica collision/raycasts),
// so it throws the per-kind kill-switches before every test — the same
// session-latched setShell(kind, false) rollback QA uses (the latch
// re-arms via each test's resetDestruction). afterAll restores the
// defaults for whatever suite runs after this file.
beforeEach(() => {
  setShellFlag('wall', false)
  setShellFlag('roof', false)
  setShellFlag('slab', false)
})
afterAll(() => {
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
})


/**
 * Roof-plane enumeration (Phase C2 fallback: cluster merged-mesh face
 * normals) + the per-plane roof target lane it feeds: a gable SHELL mesh —
 * two sloped outer faces and their interior undersides, exactly the shape
 * the host's merged CSG roof exposes — must come back as two RoofPlane
 * records whose yaw/pitch/extents/eaveCenter/thickness match the
 * constructed geometry, and a roof-kind collider must voxelize into ONE
 * THIN PITCHED TARGET PER PLANE (kind 'roof', full-quaternion grid basis,
 * shingle sheets on the outer skin, that plane's rafters as segments) that
 * the segment raycast, the tear lane, and the eave-seeded island pass all
 * agree on. Also the home of the BULLETPROOF regression: no roof/volume
 * carve may ever remove zero voxels because adaptive cells outgrew the
 * weapon's holeRadius.
 */

const wrap = (a: number): number => {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  else if (r <= -Math.PI) r += Math.PI * 2
  return r
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

/** One sloped plane (outer face + interior underside offset by t). */
function pushPlaneShell(
  out: number[],
  yaw: number,
  pitch: number,
  eaveOuter: Vector3, // world midpoint of the eave edge, OUTER surface
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

/** Centroid of the gable-end triangle at `sign` × half the eave length
 * along the ridge — a point on the VERTICAL end face that no thin plane
 * slab covers (the residual lane's home turf). */
function gableEndCenter(sign: 1 | -1): Vector3 {
  const A = new Vector3(...roofPlaneFrame(GABLE.yaw, GABLE.pitch).across)
  const [eave1, eave2] = gableEaves()
  return GABLE.ridge
    .clone()
    .add(eave1)
    .add(eave2)
    .divideScalar(3)
    .addScaledVector(A, (sign * GABLE.eaveLength) / 2)
}

/** Full gable shell: two opposite planes sharing the ridge at GABLE.ridge.
 * `withEnds` appends the two VERTICAL gable-end triangles (outward normals
 * ±across — the faces the plane enumeration excludes by pitch). */
function gableShellMesh(withEnds = false): Mesh {
  const out: number[] = []
  for (const yaw of [GABLE.yaw, GABLE.yaw + Math.PI]) {
    const f = roofPlaneFrame(yaw, GABLE.pitch)
    const U = new Vector3(...f.upSlope)
    const eave = GABLE.ridge.clone().addScaledVector(U, -GABLE.slopeLength)
    pushPlaneShell(out, yaw, GABLE.pitch, eave, GABLE.eaveLength, GABLE.slopeLength, GABLE.t)
  }
  if (withEnds) {
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
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(out), 3))
  const mesh = new Mesh(geometry)
  mesh.updateMatrixWorld(true)
  return mesh
}

function roofWorld(mesh: Mesh): GameWorld {
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  const collider: ColliderEntry = {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId: 'roof-1',
    nodeType: 'roof',
  }
  return {
    colliders: [collider],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: worldBox.clone(),
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
}

afterEach(() => {
  resetDestruction()
  clearDebris()
})

describe('enumerateRoofPlanes', () => {
  test('a gable shell yields two opposite planes with the constructed geometry', () => {
    const planes = enumerateRoofPlanes([gableShellMesh()])
    expect(planes.length).toBe(2)
    for (const wantYaw of [GABLE.yaw, wrap(GABLE.yaw + Math.PI)]) {
      const plane = planes.find((p) => Math.abs(wrap(p.yaw - wantYaw)) < 0.01)
      expect(plane).toBeDefined()
      expect(plane!.pitch).toBeCloseTo(GABLE.pitch, 3)
      expect(plane!.eaveLength).toBeCloseTo(GABLE.eaveLength, 2)
      expect(plane!.slopeLength).toBeCloseTo(GABLE.slopeLength, 2)
      // eaveCenter sits on the INNER surface: outer eave midpoint − t·N,
      // with t recovered from the shell's own interior faces.
      const f = roofPlaneFrame(wantYaw, GABLE.pitch)
      const U = new Vector3(...f.upSlope)
      const N = new Vector3(...f.normal)
      const expected = GABLE.ridge
        .clone()
        .addScaledVector(U, -GABLE.slopeLength)
        .addScaledVector(N, -GABLE.t)
      expect(plane!.eaveCenter[0]).toBeCloseTo(expected.x, 2)
      expect(plane!.eaveCenter[1]).toBeCloseTo(expected.y, 2)
      expect(plane!.eaveCenter[2]).toBeCloseTo(expected.z, 2)
    }
  })

  test('planes carry their plane-space footprint triangles, re-based to the eave frame', () => {
    const planes = enumerateRoofPlanes([gableShellMesh()])
    for (const plane of planes) {
      const tris = plane.polyTris!
      expect(tris.length % 6).toBe(0)
      expect(tris.length).toBeGreaterThanOrEqual(6)
      let minA = Number.POSITIVE_INFINITY
      let maxA = Number.NEGATIVE_INFINITY
      let minU = Number.POSITIVE_INFINITY
      let maxU = Number.NEGATIVE_INFINITY
      for (let k = 0; k < tris.length; k += 2) {
        minA = Math.min(minA, tris[k]!)
        maxA = Math.max(maxA, tris[k]!)
        minU = Math.min(minU, tris[k + 1]!)
        maxU = Math.max(maxU, tris[k + 1]!)
      }
      // Across measured from the eave CENTER, upSlope from the eave — the
      // exact frame buildRafters clips its lines in.
      expect(minA).toBeCloseTo(-plane.eaveLength / 2, 5)
      expect(maxA).toBeCloseTo(plane.eaveLength / 2, 5)
      expect(minU).toBeCloseTo(0, 5)
      expect(maxU).toBeCloseTo(plane.slopeLength, 5)
    }
  })

  test('recovered yaw/pitch reproduce the outward normal', () => {
    const planes = enumerateRoofPlanes([gableShellMesh()])
    for (const plane of planes) {
      const f = roofPlaneFrame(plane.yaw, plane.pitch)
      expect(f.normal[1]).toBeGreaterThan(0)
      expect(Math.hypot(...f.normal)).toBeCloseTo(1, 6)
    }
  })

  test('flat and vertical faces enumerate no planes', () => {
    const out: number[] = []
    // Horizontal deck (normal +Y) + vertical gable-end wall (normal +X).
    pushQuad(
      out,
      new Vector3(-2, 3, -2),
      new Vector3(2, 3, -2),
      new Vector3(2, 3, 2),
      new Vector3(-2, 3, 2),
      new Vector3(0, 1, 0),
    )
    pushQuad(
      out,
      new Vector3(2, 0, -2),
      new Vector3(2, 3, -2),
      new Vector3(2, 3, 2),
      new Vector3(2, 0, 2),
      new Vector3(1, 0, 0),
    )
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(out), 3))
    const mesh = new Mesh(geometry)
    mesh.updateMatrixWorld(true)
    expect(enumerateRoofPlanes([mesh])).toEqual([])
  })

  test('the residual out-set is exactly the vertical gable-end triangles', () => {
    const residual: number[] = []
    const planes = enumerateRoofPlanes([gableShellMesh(true)], residual)
    expect(planes.length).toBe(2) // the end caps never pollute the planes
    // Two end triangles, 9 packed world floats each — the sloped outer
    // faces and their covered undersides never leak in.
    expect(residual.length).toBe(18)
    const A = new Vector3(...roofPlaneFrame(GABLE.yaw, GABLE.pitch).across)
    for (let k = 0; k < residual.length; k += 9) {
      const u = new Vector3(
        residual[k + 3]! - residual[k]!,
        residual[k + 4]! - residual[k + 1]!,
        residual[k + 5]! - residual[k + 2]!,
      )
      const w = new Vector3(
        residual[k + 6]! - residual[k]!,
        residual[k + 7]! - residual[k + 1]!,
        residual[k + 8]! - residual[k + 2]!,
      )
      const n = new Vector3().crossVectors(u, w).normalize()
      // VERTICAL faces along the ridge axis — the constructed end caps.
      expect(Math.abs(n.y)).toBeLessThan(1e-6)
      expect(Math.abs(n.dot(A))).toBeCloseTo(1, 6)
    }
    // A pure shell (every face sloped) leaves the residual set EMPTY.
    const none: number[] = []
    enumerateRoofPlanes([gableShellMesh()], none)
    expect(none.length).toBe(0)
  })

  test('rim end-caps (eave fascia, rake caps) inside a plane slab never count as residual', () => {
    // The owner-reported WHITE CUBES ON ROOF EDGES: the shell's own slab
    // end-caps — vertical fascia at the eave, rake caps along the slope —
    // lie INSIDE the kept planes' slab volumes, which the plane grids
    // already voxelize (their border cells trace these very faces). Traced
    // AGAIN as residual they painted a duplicate trim-toned cube shell
    // over the shingle-family border cells. Pin: with caps appended the
    // residual set stays EXACTLY the two gable-end triangles.
    const out: number[] = []
    const mesh = gableShellMesh(true)
    const positions = Array.from(mesh.geometry.getAttribute('position')!.array as Float32Array)
    out.push(...positions)
    for (const yaw of [GABLE.yaw, GABLE.yaw + Math.PI]) {
      const f = roofPlaneFrame(yaw, GABLE.pitch)
      const A = new Vector3(...f.across)
      const N = new Vector3(...f.normal)
      const U = new Vector3(...f.upSlope)
      const eave = GABLE.ridge.clone().addScaledVector(U, -GABLE.slopeLength)
      const half = A.clone().multiplyScalar(GABLE.eaveLength / 2)
      const inN = N.clone().multiplyScalar(-GABLE.t)
      const p0 = eave.clone().sub(half)
      const p1 = eave.clone().add(half)
      // Eave fascia: the slab's down-slope end cap (outer edge → inner).
      pushQuad(out, p0, p1, p1.clone().add(inN), p0.clone().add(inN), U.clone().negate())
      // Rake caps: the slab's side end caps along both slope edges.
      for (const sign of [1, -1] as const) {
        const off = A.clone().multiplyScalar((sign * GABLE.eaveLength) / 2)
        const e = eave.clone().add(off)
        const r = GABLE.ridge.clone().add(off)
        pushQuad(out, e, r, r.clone().add(inN), e.clone().add(inN), A.clone().multiplyScalar(sign))
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(out), 3))
    const capped = new Mesh(geometry)
    capped.updateMatrixWorld(true)
    const residual: number[] = []
    const planes = enumerateRoofPlanes([capped], residual)
    expect(planes.length).toBe(2)
    // Only the two gable-end triangles survive — every cap face vanished.
    expect(residual.length).toBe(18)
    const A = new Vector3(...roofPlaneFrame(GABLE.yaw, GABLE.pitch).across)
    for (let k = 0; k < residual.length; k += 9) {
      const u = new Vector3(
        residual[k + 3]! - residual[k]!,
        residual[k + 4]! - residual[k + 1]!,
        residual[k + 5]! - residual[k + 2]!,
      )
      const w = new Vector3(
        residual[k + 6]! - residual[k]!,
        residual[k + 7]! - residual[k + 1]!,
        residual[k + 8]! - residual[k + 2]!,
      )
      const n = new Vector3().crossVectors(u, w).normalize()
      expect(Math.abs(n.dot(A))).toBeCloseTo(1, 6)
    }
  })
})

describe('roof target lane (per-plane pitched grids, Phase C2)', () => {
  test('a roof collider voxelizes into one thin pitched target per plane', () => {
    const world = roofWorld(gableShellMesh())
    const primary = ensureVoxelTarget(world, 'roof-1')!
    expect(primary).toBeTruthy()
    const targets = Array.from(useDestruction.getState().targets.values())
    expect(targets.length).toBe(2)
    for (const target of targets) {
      expect(target.nodeId.startsWith('roof-1#p')).toBe(true)
      expect(target.kind).toBe('roof')
      expect(target.roof).toBe(true)
      expect(target.grid.aliveCount).toBeGreaterThan(0)
      // FULL-quaternion plane basis, not a yaw-only/axis-aligned grid.
      expect(Math.abs(target.grid.q.x) + Math.abs(target.grid.q.z)).toBeGreaterThan(0.01)
      // Thin pinned thickness axis (grid Z): the 0.12 m shell splits into
      // 3 skin-size layers while in-plane cells stay near ROOF_PLANE_CELL —
      // nothing like the old ~0.5 m adaptive volume cubes.
      expect(target.grid.cellZ).toBeLessThan(0.06)
      expect(target.grid.cellX).toBeLessThan(0.3)
      expect(target.grid.cellX).toBeCloseTo(target.grid.cellY, 6)
      // Skinned sandwich: outer + inner skins only, cavity dropped.
      for (let i = 0; i < target.grid.count; i++) {
        const iz = target.grid.coords[i * 3 + 2]!
        expect(iz === 0 || iz === target.grid.nz - 1).toBe(true)
      }
      // Outer-skin shingle sheets tile the min-z face (side 0).
      expect(target.sheets.some((sheet) => sheet.side === 0)).toBe(true)
      // The plane's own rafters ride along, ids re-based per target.
      const rafters = target.segments.filter((s) => s.role === 'rafter')
      expect(rafters.length).toBeGreaterThan(0)
      for (const rafter of rafters) expect(rafter.pitch).toBeCloseTo(GABLE.pitch, 3)
      const ids = new Set(target.segments.map((s) => s.id))
      expect(ids.size).toBe(target.segments.length)
    }
    // Exactly one plane pair shares the ridge board.
    const ridges = targets.flatMap((t) => t.segments.filter((s) => s.role === 'ridge'))
    expect(ridges.length).toBeGreaterThan(0)
  })

  test('raycastSegments hits a pitched rafter through the quaternion OBB', () => {
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    const targets = Array.from(useDestruction.getState().targets.values())
    const owner = targets.find((t) => t.segments.some((s) => s.role === 'rafter'))!
    const rafter = owner.segments.find((s) => s.role === 'rafter' && (s.pitch ?? 0) > 0)!
    // The rafter's local Y is its plane's outward normal — a normal-
    // incidence ray from 2 m out enters at exactly half the 2×6 depth.
    const f = roofPlaneFrame(rafter.yaw - Math.PI / 2, rafter.pitch!)
    const N = new Vector3(...f.normal)
    const origin = new Vector3(...rafter.center).addScaledVector(N, 2)
    const hit = raycastSegments(origin, N.clone().negate(), 5)
    expect(hit).toBeTruthy()
    expect(hit!.nodeId).toBe(owner.nodeId)
    expect(hit!.segmentId).toBe(rafter.id)
    expect(hit!.distance).toBeCloseTo(2 - RAFTER_D / 2, 3)
  })

  test('a pistol-size carve through the real node id always bites (safety floor)', () => {
    const world = roofWorld(gableShellMesh())
    const f = roofPlaneFrame(GABLE.yaw, GABLE.pitch)
    const point = GABLE.ridge
      .clone()
      .addScaledVector(new Vector3(...f.upSlope), -GABLE.slopeLength / 2)
    // 0.11 m = pistol holeRadius — the exact radius the QA round fired 32
    // times into the old volume grid without removing a single voxel.
    const removed = damageTarget(world, 'roof-1', point, 0.11)
    expect(removed).toBeGreaterThan(0)
  })

  test('carves respect the entry skin: an outer-face shot keeps the underside', () => {
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    const f = roofPlaneFrame(GABLE.yaw, GABLE.pitch)
    const point = GABLE.ridge
      .clone()
      .addScaledVector(new Vector3(...f.upSlope), -GABLE.slopeLength / 2)
    const targets = Array.from(useDestruction.getState().targets.values())
    const before = targets.map((t) => t.grid.aliveCount)
    damageTarget(world, 'roof-1', point, 0.45) // rifle tearRadius < pierce gate
    // Some outer-skin cells died, but every removed cell sits on the OUTER
    // layer (iz 0) — the inner skin survives the first shot.
    let removedTotal = 0
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t]!
      removedTotal += before[t]! - target.grid.aliveCount
      for (let i = 0; i < target.grid.count; i++) {
        if (target.grid.alive[i]) continue
        expect(target.grid.coords[i * 3 + 2]).toBe(0)
      }
    }
    expect(removedTotal).toBeGreaterThan(0)
  })

  test('severing a plane full-depth sheds the uphill block from the eave seed', async () => {
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    const targets = Array.from(useDestruction.getState().targets.values())
    const plane = targets.find((t) => Math.abs(wrap(t.grid.yaw)) >= 0)! // any member
    const f = roofPlaneFrame(GABLE.yaw, GABLE.pitch)
    const across = new Vector3(...f.across)
    const mid = GABLE.ridge
      .clone()
      .addScaledVector(new Vector3(...f.upSlope), -GABLE.slopeLength / 2)
    const totalBefore = plane.grid.aliveCount
    // March a full-depth cut (radius > the 0.6 pierce gate) across the
    // plane at mid-slope — both skins go, the plane is severed.
    for (let s = -GABLE.eaveLength / 2; s <= GABLE.eaveLength / 2; s += 0.5) {
      damageTarget(world, 'roof-1', mid.clone().addScaledVector(across, s), 0.65)
    }
    // The island pass (140 ms debounce) finds everything uphill of the cut
    // unseeded — no eave row below it, no wall underneath in this world.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(plane.grid.aliveCount).toBeLessThan(totalBefore * 0.55)
    // …and at least one shingle sheet tore off wholesale along the way.
    const anySheetFlew = targets.some((t) => t.sheets.some((sheet) => sheet.flownOff))
    expect(anySheetFlew).toBe(true)
  })

  test('gable ends join the roof group as a #residual member a shot can carve', () => {
    const world = roofWorld(gableShellMesh(true))
    ensureVoxelTarget(world, 'roof-1')
    const targets = useDestruction.getState().targets
    // 2 planes + the residual — and the group owns all three ids.
    expect(Array.from(targets.keys()).sort()).toEqual([
      'roof-1#p0',
      'roof-1#p1',
      'roof-1#residual',
    ])
    const residual = targets.get('roof-1#residual')!
    expect(residual.kind).toBe('volume')
    expect(residual.grid.aliveCount).toBeGreaterThan(0)
    // Group membership does the work: a shot at the CENTER of a gable end
    // (a point no thin plane slab covers — the exact spot that used to
    // VANISH with nothing behind it) fans out through the real node id and
    // bites the residual grid.
    const before = residual.grid.aliveCount
    const removed = damageTarget(world, 'roof-1', gableEndCenter(1), 0.3)
    expect(removed).toBeGreaterThan(0)
    expect(residual.grid.aliveCount).toBeLessThan(before)
  })

  test('a pure shell (no residual faces) builds NO residual member', () => {
    const world = roofWorld(gableShellMesh())
    ensureVoxelTarget(world, 'roof-1')
    expect(useDestruction.getState().targets.has('roof-1#residual')).toBe(false)
  })

  test('a default-white shell resolves to the dark-shingle fallback (never white) and audits', () => {
    const world = roofWorld(gableShellMesh(true)) // three's default white material
    const target = ensureVoxelTarget(world, 'roof-1')!
    expect(isUntexturedWhite(target.baseColor)).toBe(false)
    // Every plane member shares the tone; the residual wears its own.
    const residual = useDestruction.getState().targets.get('roof-1#residual')!
    expect(isUntexturedWhite(residual.baseColor)).toBe(false)
    const report = toneAuditReport()
    expect(report).toContainEqual({ nodeId: 'roof-1', kind: 'roof', why: 'white-base' })
    expect(report).toContainEqual({
      nodeId: 'roof-1#residual',
      kind: 'volume',
      why: 'white-base',
    })
  })

  test('dormant prebuilds include the residual and the first hit wakes it with the family', () => {
    const world = roofWorld(gableShellMesh(true))
    ensureVoxelTarget(world, 'roof-1', { dormant: true })
    const residual = useDestruction.getState().targets.get('roof-1#residual')!
    expect(residual.dormant).toBe(true)
    // First blood on the OTHER end still wakes every member (family wake)…
    const removed = damageTarget(world, 'roof-1', gableEndCenter(-1), 0.3)
    expect(residual.dormant).toBe(false)
    // …and that same first shot already carves the end it hit.
    expect(removed).toBeGreaterThan(0)
    expect(residual.grid.aliveCount).toBeLessThan(residual.grid.count)
  })
})

describe('bulletproof safety floor (volume targets)', () => {
  test('adaptive volume cells can never outgrow the carve radius', () => {
    // A chunky 6 m cube ('block') voxelizes as a plain volume whose
    // adaptive cell grows far past every weapon's holeRadius…
    const mesh = new Mesh(new BoxGeometry(6, 6, 6))
    mesh.position.set(0, 3, 0)
    mesh.updateMatrixWorld(true)
    mesh.geometry.computeBoundingBox()
    const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    const collider: ColliderEntry = {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox,
      root: mesh,
      nodeId: 'block-1',
      nodeType: 'block',
    }
    const world = {
      colliders: [collider],
      walls: new Map(),
      glass: [],
      doors: [],
      overlayRoots: [],
      buildingAabb: worldBox.clone(),
      spawn: new Vector3(6, 0, 6),
      spawnYaw: 0,
      levelId: null,
    } as unknown as GameWorld
    const target = ensureVoxelTarget(world, 'block-1')!
    expect(target.kind).toBe('volume')
    const cellMax = Math.max(target.grid.cellX, target.grid.cellY, target.grid.cellZ)
    expect(cellMax).toBeGreaterThan(0.3)
    // …but a pistol-size carve at the surface still bites: the safety floor
    // clamps the radius to 0.75 × the largest cell.
    const removed = damageTarget(world, 'block-1', new Vector3(0, 3, -3), 0.11)
    expect(removed).toBeGreaterThan(0)
  })
})
