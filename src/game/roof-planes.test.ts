import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BufferAttribute, BufferGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { clearDebris } from './debris'
import {
  damageTarget,
  ensureVoxelTarget,
  raycastSegments,
  resetDestruction,
} from './destruction'
import { RAFTER_D, roofPlaneFrame } from './roof-framing'
import { enumerateRoofPlanes } from './roof-planes'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Roof-plane enumeration (Phase C2 fallback: cluster merged-mesh face
 * normals) + the roof target lane it feeds: a gable SHELL mesh — two
 * sloped outer faces and their interior undersides, exactly the shape the
 * host's merged CSG roof exposes — must come back as two RoofPlaneBasis
 * records whose yaw/pitch/extents/eaveCenter match the constructed
 * geometry, and a roof-kind collider must voxelize into a target that
 * frames pitched rafters the segment raycast can hit.
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

/** Full gable shell: two opposite planes sharing the ridge at GABLE.ridge. */
function gableShellMesh(): Mesh {
  const out: number[] = []
  for (const yaw of [GABLE.yaw, GABLE.yaw + Math.PI]) {
    const f = roofPlaneFrame(yaw, GABLE.pitch)
    const U = new Vector3(...f.upSlope)
    const eave = GABLE.ridge.clone().addScaledVector(U, -GABLE.slopeLength)
    pushPlaneShell(out, yaw, GABLE.pitch, eave, GABLE.eaveLength, GABLE.slopeLength, GABLE.t)
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
})

describe('roof target lane', () => {
  test('a roof collider voxelizes with pitched rafters + a ridge board', () => {
    const world = roofWorld(gableShellMesh())
    const target = ensureVoxelTarget(world, 'roof-1')!
    expect(target).toBeTruthy()
    expect(target.roof).toBe(true)
    expect(target.kind).toBe('volume')
    expect(target.grid.aliveCount).toBeGreaterThan(0)
    const rafters = target.segments.filter((s) => s.role === 'rafter')
    expect(rafters.length).toBeGreaterThan(0)
    for (const rafter of rafters) expect(rafter.pitch).toBeCloseTo(GABLE.pitch, 3)
    expect(target.segments.some((s) => s.role === 'ridge')).toBe(true)
    // Ids are target-unique (the flat buildRafters array IS segments).
    const ids = new Set(target.segments.map((s) => s.id))
    expect(ids.size).toBe(target.segments.length)
  })

  test('raycastSegments hits a pitched rafter through the quaternion OBB', () => {
    const world = roofWorld(gableShellMesh())
    const target = ensureVoxelTarget(world, 'roof-1')!
    const rafter = target.segments.find((s) => s.role === 'rafter' && (s.pitch ?? 0) > 0)!
    // The rafter's local Y is its plane's outward normal — a normal-
    // incidence ray from 2 m out enters at exactly half the 2×6 depth.
    const f = roofPlaneFrame(rafter.yaw - Math.PI / 2, rafter.pitch!)
    const N = new Vector3(...f.normal)
    const origin = new Vector3(...rafter.center).addScaledVector(N, 2)
    const hit = raycastSegments(origin, N.clone().negate(), 5)
    expect(hit).toBeTruthy()
    expect(hit!.nodeId).toBe('roof-1')
    expect(hit!.segmentId).toBe(rafter.id)
    expect(hit!.distance).toBeCloseTo(2 - RAFTER_D / 2, 3)
  })

  test('carving a roof volume tears cells and stays on the roof debris lane', () => {
    const world = roofWorld(gableShellMesh())
    const f = roofPlaneFrame(GABLE.yaw, GABLE.pitch)
    const point = GABLE.ridge
      .clone()
      .addScaledVector(new Vector3(...f.upSlope), -GABLE.slopeLength / 2)
    const removed = damageTarget(world, 'roof-1', point, 0.5)
    expect(removed).toBeGreaterThan(0)
  })
})
