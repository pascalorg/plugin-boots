import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Quaternion, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import {
  buildVoxelGrid,
  dropInteriorCells,
  findUnsupportedIslands,
  raycastObb,
  raycastVoxels,
  raycastYawObb,
  removeSphere,
  type VoxelBasis,
  yawBasis,
} from './voxel'

/** A 2m long × 1m tall × 0.2m thick wall segment centered at origin. */
function wallGrid(cell = 0.2) {
  const geometry = new BoxGeometry(2, 1, 0.2)
  const bvh = new MeshBVH(geometry)
  const bounds = new Box3(new Vector3(-1, -0.5, -0.1), new Vector3(1, 0.5, 0.1))
  return buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, cell)
}

describe('buildVoxelGrid', () => {
  test('fills a solid box wall', () => {
    const grid = wallGrid()
    // 10 × 5 × 1 cells at 0.2m
    expect(grid.nx).toBe(10)
    expect(grid.ny).toBe(5)
    expect(grid.count).toBe(50)
    expect(grid.aliveCount).toBe(50)
  })

  test('respects transforms', () => {
    const geometry = new BoxGeometry(2, 1, 0.2)
    const bvh = new MeshBVH(geometry)
    const matrixWorld = new Matrix4().makeTranslation(10, 0, 0)
    const bounds = new Box3(new Vector3(9, -0.5, -0.1), new Vector3(11, 0.5, 0.1))
    const grid = buildVoxelGrid([{ bvh, matrixWorld }], bounds, 0.2)
    expect(grid.count).toBe(50)
    expect(grid.centers[0]).toBeGreaterThan(8.9)
  })
})

describe('removeSphere', () => {
  test('kills voxels in radius and only those', () => {
    const grid = wallGrid()
    const removed = removeSphere(grid, 0, 0, 0, 0.25)
    expect(removed.length).toBeGreaterThan(0)
    expect(grid.aliveCount).toBe(grid.count - removed.length)
    for (const idx of removed) {
      const dx = grid.centers[idx * 3]!
      const dy = grid.centers[idx * 3 + 1]!
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.25)
    }
  })
})

describe('removeSphere skin limit', () => {
  test('confines the carve to the entered face layer', () => {
    // 10 × 5 × 3 box skinned to z-layers 0 and 2 — the wall sandwich.
    const geometry = new BoxGeometry(2, 1, 0.6)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.3), new Vector3(1, 0.5, 0.3))
    const grid = dropInteriorCells(
      buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2),
    )
    // A sphere wide enough to span both skins, limited to the min face.
    const removed = removeSphere(grid, 0, 0, -0.3, 0.7, { axis: 2, side: 0 })
    expect(removed.length).toBeGreaterThan(0)
    for (const idx of removed) expect(grid.coords[idx * 3 + 2]).toBe(0)
    // The far skin never lost a cell.
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + 2] === 2) expect(grid.alive[i]).toBe(1)
    }
    // The same sphere aimed at the far side finishes the job.
    const removed2 = removeSphere(grid, 0, 0, 0.3, 0.7, { axis: 2, side: 1 })
    expect(removed2.length).toBeGreaterThan(0)
    for (const idx of removed2) expect(grid.coords[idx * 3 + 2]).toBe(2)
  })

  test('no limit removes both skins (the old behavior stays available)', () => {
    const geometry = new BoxGeometry(2, 1, 0.6)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.3), new Vector3(1, 0.5, 0.3))
    const grid = dropInteriorCells(
      buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2),
    )
    const removed = removeSphere(grid, 0, 0, -0.3, 0.7)
    const layers = new Set(removed.map((idx) => grid.coords[idx * 3 + 2]!))
    expect(layers.has(0)).toBe(true)
    expect(layers.has(2)).toBe(true)
  })
})

describe('raycastVoxels', () => {
  test('hits the wall face first', () => {
    const grid = wallGrid()
    const hit = raycastVoxels(grid, 0, 0, 5, 0, 0, -1, 20)
    expect(hit).not.toBeNull()
    expect(hit!.distance).toBeGreaterThan(4.5)
    expect(hit!.distance).toBeLessThan(5.5)
  })

  test('passes through a blown-out hole', () => {
    const grid = wallGrid()
    removeSphere(grid, 0, 0, 0, 0.45)
    const hit = raycastVoxels(grid, 0, 0, 5, 0, 0, -1, 20)
    expect(hit).toBeNull()
  })

  test('misses when aimed off-grid', () => {
    const grid = wallGrid()
    expect(raycastVoxels(grid, 0, 5, 5, 0, 0, -1, 20)).toBeNull()
  })
})

describe('dropInteriorCells', () => {
  test('a 10x5x3 box keeps only z-layers 0 and 2', () => {
    const geometry = new BoxGeometry(2, 1, 0.6)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.3), new Vector3(1, 0.5, 0.3))
    const grid = buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2)
    expect(grid.nx).toBe(10)
    expect(grid.ny).toBe(5)
    expect(grid.nz).toBe(3)
    expect(grid.count).toBe(150)
    const skinned = dropInteriorCells(grid)
    expect(skinned.count).toBe(100)
    expect(skinned.aliveCount).toBe(100)
    for (let i = 0; i < skinned.count; i++) {
      const iz = skinned.coords[i * 3 + 2]!
      expect(iz === 0 || iz === 2).toBe(true)
      // The rebuilt index map resolves every kept cell back to itself.
      const key =
        skinned.coords[i * 3]! +
        skinned.nx * (skinned.coords[i * 3 + 1]! + skinned.ny * iz)
      expect(skinned.index.get(key)).toBe(i)
    }
    // The dropped middle layer is gone from the lookup entirely.
    expect(skinned.index.get(5 + skinned.nx * (2 + skinned.ny * 1))).toBeUndefined()
  })

  test('thin grids (≤2 cells thick) keep everything', () => {
    const grid = wallGrid() // 10 × 5 × 1
    expect(dropInteriorCells(grid)).toBe(grid)
  })

  test('diagonal-wall volumes (no axis under maxThickness) pass through unchanged', () => {
    // A 45° wall voxelizes from its world AABB: metres deep on BOTH plan
    // axes, so the min physical extent is the wall HEIGHT — skinning that
    // would keep only the top and bottom rows and vaporize the wall body.
    const geometry = new BoxGeometry(3, 2.6, 3)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1.5, -1.3, -1.5), new Vector3(1.5, 1.3, 1.5))
    const grid = buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2)
    expect(dropInteriorCells(grid, 0.35)).toBe(grid)
    // Without the guard it would still skin (this is what ate diagonal walls).
    expect(dropInteriorCells(grid).count).toBeLessThan(grid.count)
  })

  test('picks the smallest axis when it is not z', () => {
    // 3 × 5 × 10 box: x is the thickness axis.
    const geometry = new BoxGeometry(0.6, 1, 2)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-0.3, -0.5, -1), new Vector3(0.3, 0.5, 1))
    const grid = buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.2)
    const skinned = dropInteriorCells(grid)
    expect(skinned.count).toBe(100)
    for (let i = 0; i < skinned.count; i++) {
      const ix = skinned.coords[i * 3]!
      expect(ix === 0 || ix === 2).toBe(true)
    }
  })
})

describe('anisotropic wall grids', () => {
  /** 2m long × 1m tall × 0.12m thick — a real interior wall. Thickness axis
   * pinned to thickness/3 the way ensureVoxelTarget does. */
  function thinWallGrid() {
    const geometry = new BoxGeometry(2, 1, 0.12)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.06), new Vector3(1, 0.5, 0.06))
    return buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.15, false, {
      z: 0.12 / 3,
    })
  }

  test('a 0.12m wall gets exactly 3 thickness layers', () => {
    const grid = thinWallGrid()
    expect(grid.nz).toBe(3)
    expect(grid.cellZ).toBeCloseTo(0.04, 6)
    expect(grid.cellX).toBeCloseTo(0.15, 6)
    expect(grid.cellY).toBeCloseTo(0.15, 6)
    // Scalar cell stays the length/height cell — render/debris size.
    expect(grid.cell).toBeCloseTo(0.15, 6)
    // 14 × 7 × 3, fully occupied.
    expect(grid.nx).toBe(14)
    expect(grid.ny).toBe(7)
    expect(grid.count).toBe(14 * 7 * 3)
    // Centers honor the per-axis cells: z layers at −0.04, 0, 0.04.
    for (let i = 0; i < grid.count; i++) {
      const iz = grid.coords[i * 3 + 2]!
      expect(grid.centers[i * 3 + 2]!).toBeCloseTo(-0.04 + iz * 0.04, 6)
    }
  })

  test('legacy isotropic grids expose equal per-axis cells', () => {
    const grid = wallGrid()
    expect(grid.cellX).toBe(grid.cell)
    expect(grid.cellY).toBe(grid.cell)
    expect(grid.cellZ).toBe(grid.cell)
  })

  test('dropInteriorCells keeps 2 of the 3 thin layers', () => {
    const skinned = dropInteriorCells(thinWallGrid())
    expect(skinned.count).toBe(14 * 7 * 2)
    expect(skinned.aliveCount).toBe(skinned.count)
    expect(skinned.cellZ).toBeCloseTo(0.04, 6)
    for (let i = 0; i < skinned.count; i++) {
      const iz = skinned.coords[i * 3 + 2]!
      expect(iz === 0 || iz === 2).toBe(true)
    }
  })

  test('DDA hits the outer skin, then the inner skin through a carved hole', () => {
    const skinned = dropInteriorCells(thinWallGrid())
    // Outer skin face is at z = 0.06.
    const first = raycastVoxels(skinned, 0, 0, 5, 0, 0, -1, 20)
    expect(first).not.toBeNull()
    expect(first!.distance).toBeCloseTo(4.94, 3)
    // Carve the outer-skin voxel on the ray's path; the ray now crosses the
    // cavity and stops at the inner skin (z = -0.02 → distance 5.02).
    const removed = removeSphere(skinned, 0, 0, 0.04, 0.05)
    expect(removed).toHaveLength(1)
    const second = raycastVoxels(skinned, 0, 0, 5, 0, 0, -1, 20)
    expect(second).not.toBeNull()
    expect(second!.distance).toBeCloseTo(5.02, 3)
  })

  test('occupancy respects a doorway cutout', () => {
    // Two 0.8m wall piers flanking a 0.4m opening (|x| < 0.2).
    const geometry = new BoxGeometry(0.8, 1, 0.12)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.06), new Vector3(1, 0.5, 0.06))
    const grid = buildVoxelGrid(
      [
        { bvh, matrixWorld: new Matrix4().makeTranslation(-0.6, 0, 0) },
        { bvh, matrixWorld: new Matrix4().makeTranslation(0.6, 0, 0) },
      ],
      bounds,
      0.15,
      false,
      { z: 0.12 / 3 },
    )
    // Column ix=6 spans x −0.10..0.05 — fully inside the opening.
    for (let i = 0; i < grid.count; i++) {
      expect(grid.coords[i * 3]!).not.toBe(6)
    }
    // A ray through the doorway passes clean.
    expect(raycastVoxels(grid, -0.025, 0, 5, 0, 0, -1, 20)).toBeNull()
  })
})

describe('yaw-aligned wall grids', () => {
  const YAW = Math.PI / 4

  /** The 2m × 1m × 0.12m wall again, but yawed 45° in the world (the mesh
   * renders with rotation [0, −yaw, 0], per the stud convention) and its
   * grid built in the wall's local frame — bounds/cell override are the
   * exact values the axis-aligned twin in 'anisotropic wall grids' uses. */
  function yawWallGrid() {
    const geometry = new BoxGeometry(2, 1, 0.12)
    const bvh = new MeshBVH(geometry)
    const matrixWorld = new Matrix4().makeRotationY(-YAW)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.06), new Vector3(1, 0.5, 0.06))
    return buildVoxelGrid([{ bvh, matrixWorld }], bounds, 0.15, false, { z: 0.12 / 3 }, YAW)
  }

  test('occupancy matches the axis-aligned twin; centers are world-space', () => {
    const grid = yawWallGrid()
    expect(grid.yaw).toBe(YAW)
    expect(grid.nx).toBe(14)
    expect(grid.ny).toBe(7)
    expect(grid.nz).toBe(3)
    expect(grid.count).toBe(14 * 7 * 3)
    // Centers hug the DIAGONAL wall plane (normal (−sin, 0, cos) through the
    // origin): never farther than half the wall thickness.
    const nxp = -Math.sin(YAW)
    const nzp = Math.cos(YAW)
    let maxAbsZ = 0
    for (let i = 0; i < grid.count; i++) {
      const wx = grid.centers[i * 3]!
      const wz = grid.centers[i * 3 + 2]!
      expect(Math.abs(wx * nxp + wz * nzp)).toBeLessThan(0.061)
      maxAbsZ = Math.max(maxAbsZ, Math.abs(wz))
    }
    // …and they really are rotated into the world: the wall run reaches far
    // outside the |z| ≤ 0.06 slab its axis-aligned twin lives in.
    expect(maxAbsZ).toBeGreaterThan(0.5)
  })

  test('dropInteriorCells keeps the two skins and carries yaw', () => {
    const skinned = dropInteriorCells(yawWallGrid())
    expect(skinned.yaw).toBe(YAW)
    expect(skinned.count).toBe(14 * 7 * 2)
    expect(skinned.aliveCount).toBe(skinned.count)
    for (let i = 0; i < skinned.count; i++) {
      const iz = skinned.coords[i * 3 + 2]!
      expect(iz === 0 || iz === 2).toBe(true)
    }
  })

  test('world-space DDA: outer skin, then inner skin through a carved hole', () => {
    const skinned = dropInteriorCells(yawWallGrid())
    // Fire along the wall's outward normal from 5m out — same geometry as
    // the axis-aligned twin test, rotated 45°.
    const nx = -Math.sin(YAW)
    const nz = Math.cos(YAW)
    const first = raycastVoxels(skinned, nx * 5, 0, nz * 5, -nx, 0, -nz, 20)
    expect(first).not.toBeNull()
    expect(first!.distance).toBeCloseTo(4.94, 3)
    // Carve the outer-skin voxel on the ray's path — removeSphere takes the
    // WORLD point (local (0, 0, 0.04) rotated out). Exactly one voxel dies,
    // and the ray now crosses the cavity to the inner skin.
    const removed = removeSphere(skinned, nx * 0.04, 0, nz * 0.04, 0.05)
    expect(removed).toHaveLength(1)
    const second = raycastVoxels(skinned, nx * 5, 0, nz * 5, -nx, 0, -nz, 20)
    expect(second).not.toBeNull()
    expect(second!.distance).toBeCloseTo(5.02, 3)
  })

  test('a ray passing beside the diagonal wall misses', () => {
    const skinned = dropInteriorCells(yawWallGrid())
    // Straight down world −Z from beyond the wall's end: it crosses the
    // wall PLANE well past the run — a clean miss.
    expect(raycastVoxels(skinned, -2, 0, 5, 0, 0, -1, 20)).toBeNull()
  })

  test('world-aligned grids report yaw 0', () => {
    expect(wallGrid().yaw).toBe(0)
  })
})

describe('pitched-basis grids (full quaternion)', () => {
  const YAW = Math.PI / 6
  const PITCH = Math.PI / 5

  /** WORLD → GRID basis q = Qy(yaw) · Qx(pitch) — a roof-plane frame. */
  function pitchedBasis(): VoxelBasis {
    const q = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), YAW)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), PITCH))
    return { x: q.x, y: q.y, z: q.z, w: q.w }
  }

  /** GRID → WORLD (the conjugate) as a three Quaternion, for expectations. */
  const gridToWorld = (b: VoxelBasis) => new Quaternion(b.x, b.y, b.z, b.w).invert()

  /** The 2m × 1m × 0.12m slab once more, tilted like a roof plane: the mesh
   * renders at rotation q⁻¹ so it is axis-aligned in the GRID frame
   * (thickness along grid z), pitched AND yawed in the world. Bounds/cell
   * override are the exact values the twins in 'anisotropic wall grids' and
   * 'yaw-aligned wall grids' use. */
  function pitchedSlabGrid() {
    const geometry = new BoxGeometry(2, 1, 0.12)
    const bvh = new MeshBVH(geometry)
    const basis = pitchedBasis()
    const matrixWorld = new Matrix4().makeRotationFromQuaternion(gridToWorld(basis))
    const bounds = new Box3(new Vector3(-1, -0.5, -0.06), new Vector3(1, 0.5, 0.06))
    return buildVoxelGrid(
      [{ bvh, matrixWorld }],
      bounds,
      0.15,
      false,
      { z: 0.12 / 3 },
      0,
      basis,
    )
  }

  test('occupancy matches the axis-aligned twin; centers rotate out by q⁻¹', () => {
    const grid = pitchedSlabGrid()
    const basis = pitchedBasis()
    expect(grid.q).toEqual(basis)
    // A general basis has no scalar-yaw equivalent — legacy field parks at 0.
    expect(grid.yaw).toBe(0)
    expect(grid.nx).toBe(14)
    expect(grid.ny).toBe(7)
    expect(grid.nz).toBe(3)
    expect(grid.count).toBe(14 * 7 * 3)
    // Every center is the grid-frame cell center pushed through q⁻¹.
    const inv = gridToWorld(basis)
    const v = new Vector3()
    for (let i = 0; i < grid.count; i++) {
      v.set(
        grid.origin.x + grid.coords[i * 3]! * grid.cellX + grid.cellX / 2,
        grid.origin.y + grid.coords[i * 3 + 1]! * grid.cellY + grid.cellY / 2,
        grid.origin.z + grid.coords[i * 3 + 2]! * grid.cellZ + grid.cellZ / 2,
      ).applyQuaternion(inv)
      expect(grid.centers[i * 3]!).toBeCloseTo(v.x, 6)
      expect(grid.centers[i * 3 + 1]!).toBeCloseTo(v.y, 6)
      expect(grid.centers[i * 3 + 2]!).toBeCloseTo(v.z, 6)
    }
    // …and the plane really is pitched: the slab normal gained a world-Y lean.
    const n = new Vector3(0, 0, 1).applyQuaternion(inv)
    expect(Math.abs(n.y)).toBeGreaterThan(0.5)
  })

  test('an explicit yaw-only basis is the same grid as the yaw scalar', () => {
    const geometry = new BoxGeometry(2, 1, 0.12)
    const bvh = new MeshBVH(geometry)
    const matrixWorld = new Matrix4().makeRotationY(-Math.PI / 4)
    const bounds = new Box3(new Vector3(-1, -0.5, -0.06), new Vector3(1, 0.5, 0.06))
    const cells = { z: 0.12 / 3 }
    const viaYaw = buildVoxelGrid([{ bvh, matrixWorld }], bounds, 0.15, false, cells, Math.PI / 4)
    const viaBasis = buildVoxelGrid(
      [{ bvh, matrixWorld }],
      bounds,
      0.15,
      false,
      cells,
      0,
      yawBasis(Math.PI / 4),
    )
    expect(viaBasis.yaw).toBeCloseTo(viaYaw.yaw, 12)
    expect(viaBasis.count).toBe(viaYaw.count)
    expect([...viaBasis.coords]).toEqual([...viaYaw.coords])
    for (let i = 0; i < viaBasis.count * 3; i++) {
      expect(viaBasis.centers[i]!).toBeCloseTo(viaYaw.centers[i]!, 9)
    }
    // Grids built without any basis carry the compatibility quaternion.
    expect(wallGrid().q).toEqual({ x: 0, y: 0, z: 0, w: 1 })
  })

  test('world-space DDA + carve on the pitched slab, in plane coordinates', () => {
    const skinned = dropInteriorCells(pitchedSlabGrid())
    expect(skinned.q).toEqual(pitchedBasis()) // skinning carries the basis
    expect(skinned.count).toBe(14 * 7 * 2)
    // Fire along the slab's world normal from 5m out — the same geometry as
    // both twins, now pitched: outer skin face sits 0.06 up the normal.
    const n = new Vector3(0, 0, 1).applyQuaternion(gridToWorld(skinned.q))
    const first = raycastVoxels(skinned, n.x * 5, n.y * 5, n.z * 5, -n.x, -n.y, -n.z, 20)
    expect(first).not.toBeNull()
    expect(first!.distance).toBeCloseTo(4.94, 3)
    // Carve at the WORLD image of plane point (0, 0, 0.04): exactly the one
    // outer-skin voxel whose PLANE coords are (6, 3, 2) dies.
    const p = new Vector3(0, 0, 0.04).applyQuaternion(gridToWorld(skinned.q))
    const removed = removeSphere(skinned, p.x, p.y, p.z, 0.05)
    expect(removed).toHaveLength(1)
    expect([...skinned.coords.slice(removed[0]! * 3, removed[0]! * 3 + 3)]).toEqual([6, 3, 2])
    // The ray now crosses the cavity and stops at the inner skin.
    const second = raycastVoxels(skinned, n.x * 5, n.y * 5, n.z * 5, -n.x, -n.y, -n.z, 20)
    expect(second).not.toBeNull()
    expect(second!.distance).toBeCloseTo(5.02, 3)
    // A ray past the slab's end still misses (world x well outside the run).
    expect(raycastVoxels(skinned, 3, 0, 5, 0, 0, -1, 20)).toBeNull()
  })

  test("islands flood with the rotated 'down': severing a plane row sheds the uphill block", () => {
    const grid = pitchedSlabGrid()
    expect(findUnsupportedIslands(grid)).toHaveLength(0)
    // Kill the full plane row iy = 2 — support flows from iy = 0 (the
    // eave-side row in the world), so plane rows 3..6 detach as ONE island.
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + 1] === 2 && grid.alive[i]) {
        grid.alive[i] = 0
        grid.aliveCount--
      }
    }
    const islands = findUnsupportedIslands(grid)
    expect(islands).toHaveLength(1)
    expect(islands[0]!.length).toBe(14 * 4 * 3)
    for (const idx of islands[0]!) {
      expect(grid.coords[idx * 3 + 1]!).toBeGreaterThan(2)
    }
  })
})

describe('raycastObb (general basis)', () => {
  test('matches raycastYawObb on a yaw-only basis', () => {
    const yaw = Math.PI / 2
    const cases: Array<[number, number, number, number, number, number]> = [
      [0, 0, 5, 0, 0, -1],
      [5, 0, 0, -1, 0, 0],
      [0, 0.8, 5, 0, 0, -1],
    ]
    for (const [ox, oy, oz, dx, dy, dz] of cases) {
      const viaYaw = raycastYawObb(ox, oy, oz, dx, dy, dz, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)
      const viaBasis = raycastObb(
        ox, oy, oz, dx, dy, dz, 0, 0, 0, 1, 0.5, 0.05, yawBasis(yaw), 20,
      )
      if (viaYaw === null) expect(viaBasis).toBeNull()
      else expect(viaBasis!).toBeCloseTo(viaYaw, 9)
    }
  })

  test('hits a pitched box along its rotated normal', () => {
    // World→local basis Qy(30°)·Qx(36°); the box's local +z face sits 0.05
    // up the world image of the local z axis.
    const q = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 5))
    const basis: VoxelBasis = { x: q.x, y: q.y, z: q.z, w: q.w }
    const n = new Vector3(0, 0, 1).applyQuaternion(q.clone().invert())
    const t = raycastObb(
      n.x * 5, n.y * 5, n.z * 5, -n.x, -n.y, -n.z, 0, 0, 0, 1, 0.5, 0.05, basis, 20,
    )
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4.95, 4)
    // Straight world-down would clip the tilted box off-axis — and from a
    // point beyond the run it misses entirely.
    expect(raycastObb(3, 5, 0, 0, -1, 0, 0, 0, 0, 1, 0.5, 0.05, basis, 20)).toBeNull()
  })
})

describe('raycastYawObb', () => {
  test('hits an axis-aligned box straight on', () => {
    const t = raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0, 20)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4.5, 5)
  })

  test('respects the stud yaw convention', () => {
    // A plank 2 long (local x) × 1 tall × 0.1 thick (local z), yawed so its
    // length lies along world z (yaw = atan2(dz, dx) = π/2).
    const yaw = Math.PI / 2
    // Down the length: enter at world z = 1 → distance 4.
    let t = raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4, 4)
    // From the side it is only 0.1 thick: enter at world x = 0.05.
    t = raycastYawObb(5, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(4.95, 4)
    // Down the length of the UNROTATED plank the same ray misses.
    expect(raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 1, 0.5, 0.05, 0, 20)).not.toBeNull()
    expect(raycastYawObb(0, 0.8, 5, 0, 0, -1, 0, 0, 0, 1, 0.5, 0.05, yaw, 20)).toBeNull()
  })

  test('misses when out of range or off to the side', () => {
    expect(raycastYawObb(0, 0, 5, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0, 4)).toBeNull()
    expect(raycastYawObb(3, 0, 5, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0, 20)).toBeNull()
  })

  test('starts inside → distance 0', () => {
    const t = raycastYawObb(0, 0, 0, 0, 0, -1, 0, 0, 0, 0.5, 0.5, 0.5, 0.7, 20)
    expect(t).toBe(0)
  })
})

describe('findUnsupportedIslands', () => {
  test('solid wall has no islands', () => {
    const grid = wallGrid()
    expect(findUnsupportedIslands(grid)).toHaveLength(0)
  })

  test('a horizontal cut drops the top as one island', () => {
    const grid = wallGrid()
    // Kill the full row at iy=2 → everything above (iy 3,4) detaches.
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + 1] === 2) {
        grid.alive[i] = 0
        grid.aliveCount--
      }
    }
    const islands = findUnsupportedIslands(grid)
    expect(islands).toHaveLength(1)
    expect(islands[0]!.length).toBe(20) // two full rows of 10×1
    for (const idx of islands[0]!) {
      expect(grid.coords[idx * 3 + 1]!).toBeGreaterThan(2)
    }
  })

  test('multi-slab SOLID volumes detach too (index-wraparound regression)', () => {
    // gridKey is a flat linearization, so an unchecked -y neighbor from a
    // base seed used to alias the TOP row of the previous z-slab — the
    // flood teleported into the floating half of any nz ≥ 2 solid volume
    // (the severed-shower bug) and reported zero islands.
    const geometry = new BoxGeometry(0.9, 2.4, 0.9)
    const bvh = new MeshBVH(geometry)
    const bounds = new Box3(new Vector3(-0.45, -1.2, -0.45), new Vector3(0.45, 1.2, 0.45))
    const grid = buildVoxelGrid([{ bvh, matrixWorld: new Matrix4() }], bounds, 0.15, true)
    expect(grid.nz).toBeGreaterThan(1)
    expect(findUnsupportedIslands(grid)).toHaveLength(0)
    // Sever at mid-height: kill every cell in rows 7 and 8.
    let killed = 0
    for (let i = 0; i < grid.count; i++) {
      const iy = grid.coords[i * 3 + 1]!
      if (iy === 7 || iy === 8) {
        grid.alive[i] = 0
        grid.aliveCount--
        killed++
      }
    }
    expect(killed).toBeGreaterThan(0)
    const islands = findUnsupportedIslands(grid)
    expect(islands).toHaveLength(1)
    // The whole top block (rows 9..15) is the island.
    expect(islands[0]!.length).toBe(grid.nx * grid.nz * (grid.ny - 9))
    for (const idx of islands[0]!) {
      expect(grid.coords[idx * 3 + 1]!).toBeGreaterThan(8)
    }
  })
})
