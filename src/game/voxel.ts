import { Box3, Matrix4, Ray, Vector3 } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'

/**
 * Voxel destruction core — the "walls crumble piece by piece" feel.
 *
 * A damaged wall's meshes are sampled into a world-axis-aligned voxel grid
 * (the three-mesh-bvh `voxelize` recipe: shell cells via `intersectsBox`
 * OBB tests, interior cells via the backface-raycast trick), then rendered
 * elsewhere as one InstancedMesh. This module is renderer-free math:
 * build, radius removal, DDA ray-walk, and the flood-fill that finds
 * disconnected islands so they can crumble.
 */

export type VoxelSource = {
  bvh: MeshBVH
  /** Mesh local → world. */
  matrixWorld: Matrix4
}

export type VoxelGridData = {
  cell: number
  nx: number
  ny: number
  nz: number
  /** World-space min corner of cell (0,0,0). */
  origin: { x: number; y: number; z: number }
  count: number
  /** Grid coords, 3 per voxel. */
  coords: Int16Array
  /** World-space centers, 3 per voxel. */
  centers: Float32Array
  alive: Uint8Array
  aliveCount: number
  /** gridKey(ix,iy,iz) → voxel index. */
  index: Map<number, number>
}

const _box = new Box3()
const _mat = new Matrix4()
const _ray = new Ray()
const _p = new Vector3()

const gridKey = (ix: number, iy: number, iz: number, nx: number, ny: number) =>
  ix + nx * (iy + ny * iz)

/** Cap on voxels per wall — beyond this the cell size grows to compensate. */
const MAX_VOXELS = 1600

export function buildVoxelGrid(
  sources: VoxelSource[],
  worldBounds: Box3,
  preferredCell = 0.15,
  /** True for chunky volumes (doors, slabs, furniture): sizes the cell so
   * even a 100%-occupied grid stays ≤ MAX_VOXELS instead of relying on the
   * thin-wall occupancy discount. */
  solid = false,
): VoxelGridData {
  const size = new Vector3()
  worldBounds.getSize(size)
  // Grow the cell until the raw grid is small enough that even a solid fill
  // stays under budget (walls are mostly thin, so real counts land far lower).
  let cell = preferredCell
  const budget = solid ? MAX_VOXELS : MAX_VOXELS * 24
  for (let guard = 0; guard < 12; guard++) {
    const rawCount =
      Math.max(1, Math.ceil(size.x / cell)) *
      Math.max(1, Math.ceil(size.y / cell)) *
      Math.max(1, Math.ceil(size.z / cell))
    if (rawCount <= budget) break
    cell *= 1.35
  }
  const nx = Math.max(1, Math.ceil(size.x / cell))
  const ny = Math.max(1, Math.ceil(size.y / cell))
  const nz = Math.max(1, Math.ceil(size.z / cell))
  const origin = worldBounds.min

  const inverses = sources.map((s) => _mat.clone().copy(s.matrixWorld).invert())

  const coords: number[] = []
  const centers: number[] = []
  const index = new Map<number, number>()

  const half = cell / 2
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cx = origin.x + ix * cell + half
        const cy = origin.y + iy * cell + half
        const cz = origin.z + iz * cell + half
        let inside = false
        for (let m = 0; m < sources.length && !inside; m++) {
          const bvh = sources[m]?.bvh
          const inv = inverses[m]
          if (!bvh || !inv) continue
          // Shell test: world-aligned voxel box as an OBB in mesh space.
          _box.min.set(cx - half, cy - half, cz - half)
          _box.max.set(cx + half, cy + half, cz + half)
          if (bvh.intersectsBox(_box, inv)) {
            inside = true
            break
          }
          // Interior test: a local-space ray that first hits a backface
          // started inside the mesh (voxelize.js recipe).
          _p.set(cx, cy, cz).applyMatrix4(inv)
          _ray.origin.copy(_p)
          _ray.direction.set(0, 0, 1)
          const hit = bvh.raycastFirst(_ray, 2)
          if (hit?.face && hit.face.normal.dot(_ray.direction) > 0) inside = true
        }
        if (!inside) continue
        if (coords.length / 3 >= MAX_VOXELS) continue
        index.set(gridKey(ix, iy, iz, nx, ny), coords.length / 3)
        coords.push(ix, iy, iz)
        centers.push(cx, cy, cz)
      }
    }
  }

  const count = coords.length / 3
  return {
    cell,
    nx,
    ny,
    nz,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    count,
    coords: Int16Array.from(coords),
    centers: Float32Array.from(centers),
    alive: new Uint8Array(count).fill(1),
    aliveCount: count,
    index,
  }
}

/**
 * Drywall-skin post-pass: rebuilds the grid keeping only the two one-cell
 * layers on the min and max faces of the THICKNESS axis (the grid axis with
 * the smallest cell span) — the stud cavity between them becomes empty
 * space. A cell is interior when, along that axis, it is neither within one
 * cell of the min face nor of the max face. Grids ≤ 2 cells thick have no
 * interior and are returned unchanged (same object).
 */
export function dropInteriorCells(grid: VoxelGridData): VoxelGridData {
  let axis = 0
  let span = grid.nx
  if (grid.ny < span) {
    axis = 1
    span = grid.ny
  }
  if (grid.nz < span) {
    axis = 2
    span = grid.nz
  }
  if (span <= 2) return grid

  const coords: number[] = []
  const centers: number[] = []
  const alive: number[] = []
  const index = new Map<number, number>()
  let aliveCount = 0
  for (let i = 0; i < grid.count; i++) {
    const c = grid.coords[i * 3 + axis]!
    if (c !== 0 && c !== span - 1) continue
    const ix = grid.coords[i * 3]!
    const iy = grid.coords[i * 3 + 1]!
    const iz = grid.coords[i * 3 + 2]!
    index.set(gridKey(ix, iy, iz, grid.nx, grid.ny), coords.length / 3)
    coords.push(ix, iy, iz)
    centers.push(grid.centers[i * 3]!, grid.centers[i * 3 + 1]!, grid.centers[i * 3 + 2]!)
    alive.push(grid.alive[i]!)
    if (grid.alive[i]) aliveCount++
  }
  return {
    cell: grid.cell,
    nx: grid.nx,
    ny: grid.ny,
    nz: grid.nz,
    origin: grid.origin,
    count: coords.length / 3,
    coords: Int16Array.from(coords),
    centers: Float32Array.from(centers),
    alive: Uint8Array.from(alive),
    aliveCount,
    index,
  }
}

/**
 * Analytic ray vs yaw-rotated OBB (slab test in the box's local frame).
 * `yaw` follows the stud convention — the box renders with rotation
 * [0, -yaw, 0], so world→local is a +yaw rotation about Y. Half-extents,
 * not full sizes. Returns the entry distance along the (unit) ray within
 * [0, maxDist], or null on a miss. Allocation-free.
 */
export function raycastYawObb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  halfX: number,
  halfY: number,
  halfZ: number,
  yaw: number,
  maxDist: number,
): number | null {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const wx = ox - cx
  const wy = oy - cy
  const wz = oz - cz
  const lox = wx * cos + wz * sin
  const loy = wy
  const loz = -wx * sin + wz * cos
  const ldx = dx * cos + dz * sin
  const ldy = dy
  const ldz = -dx * sin + dz * cos

  let tMin = 0
  let tMax = maxDist
  // X slab
  if (Math.abs(ldx) < 1e-9) {
    if (lox < -halfX || lox > halfX) return null
  } else {
    let t0 = (-halfX - lox) / ldx
    let t1 = (halfX - lox) / ldx
    if (t0 > t1) {
      const swap = t0
      t0 = t1
      t1 = swap
    }
    if (t0 > tMin) tMin = t0
    if (t1 < tMax) tMax = t1
    if (tMin > tMax) return null
  }
  // Y slab
  if (Math.abs(ldy) < 1e-9) {
    if (loy < -halfY || loy > halfY) return null
  } else {
    let t0 = (-halfY - loy) / ldy
    let t1 = (halfY - loy) / ldy
    if (t0 > t1) {
      const swap = t0
      t0 = t1
      t1 = swap
    }
    if (t0 > tMin) tMin = t0
    if (t1 < tMax) tMax = t1
    if (tMin > tMax) return null
  }
  // Z slab
  if (Math.abs(ldz) < 1e-9) {
    if (loz < -halfZ || loz > halfZ) return null
  } else {
    let t0 = (-halfZ - loz) / ldz
    let t1 = (halfZ - loz) / ldz
    if (t0 > t1) {
      const swap = t0
      t0 = t1
      t1 = swap
    }
    if (t0 > tMin) tMin = t0
    if (t1 < tMax) tMax = t1
    if (tMin > tMax) return null
  }
  return tMin
}

/** Kill every live voxel within `radius` of a world point. Returns their indices. */
export function removeSphere(
  grid: VoxelGridData,
  x: number,
  y: number,
  z: number,
  radius: number,
): number[] {
  const removed: number[] = []
  const { cell, origin, nx, ny, nz } = grid
  const minX = Math.max(0, Math.floor((x - radius - origin.x) / cell))
  const maxX = Math.min(nx - 1, Math.floor((x + radius - origin.x) / cell))
  const minY = Math.max(0, Math.floor((y - radius - origin.y) / cell))
  const maxY = Math.min(ny - 1, Math.floor((y + radius - origin.y) / cell))
  const minZ = Math.max(0, Math.floor((z - radius - origin.z) / cell))
  const maxZ = Math.min(nz - 1, Math.floor((z + radius - origin.z) / cell))
  const r2 = radius * radius
  for (let iz = minZ; iz <= maxZ; iz++) {
    for (let iy = minY; iy <= maxY; iy++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const idx = grid.index.get(gridKey(ix, iy, iz, nx, ny))
        if (idx === undefined || !grid.alive[idx]) continue
        const dx = grid.centers[idx * 3]! - x
        const dy = grid.centers[idx * 3 + 1]! - y
        const dz = grid.centers[idx * 3 + 2]! - z
        if (dx * dx + dy * dy + dz * dz > r2) continue
        grid.alive[idx] = 0
        grid.aliveCount--
        removed.push(idx)
      }
    }
  }
  return removed
}

export type VoxelRayHit = { index: number; distance: number }

/**
 * Amanatides–Woo DDA walk through the grid; returns the first LIVE voxel the
 * ray crosses, or null. The grid is world-axis-aligned so this is exact and
 * far cheaper than any mesh raycast.
 */
export function raycastVoxels(
  grid: VoxelGridData,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): VoxelRayHit | null {
  const { cell, origin, nx, ny, nz } = grid
  // Clip the ray to the grid AABB first.
  const boundsMaxX = origin.x + nx * cell
  const boundsMaxY = origin.y + ny * cell
  const boundsMaxZ = origin.z + nz * cell
  let tMin = 0
  let tMax = maxDist
  const axes: Array<[number, number, number, number]> = [
    [ox, dx, origin.x, boundsMaxX],
    [oy, dy, origin.y, boundsMaxY],
    [oz, dz, origin.z, boundsMaxZ],
  ]
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null
      continue
    }
    let t0 = (lo - o) / d
    let t1 = (hi - o) / d
    if (t0 > t1) [t0, t1] = [t1, t0]
    tMin = Math.max(tMin, t0)
    tMax = Math.min(tMax, t1)
    if (tMin > tMax) return null
  }

  const startT = tMin + 1e-6
  let px = ox + dx * startT
  let py = oy + dy * startT
  let pz = oz + dz * startT
  let ix = Math.min(nx - 1, Math.max(0, Math.floor((px - origin.x) / cell)))
  let iy = Math.min(ny - 1, Math.max(0, Math.floor((py - origin.y) / cell)))
  let iz = Math.min(nz - 1, Math.max(0, Math.floor((pz - origin.z) / cell)))

  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const nextBound = (i: number, o: number, d: number, gridO: number) => {
    const edge = gridO + (d > 0 ? (i + 1) * cell : i * cell)
    return Math.abs(d) < 1e-9 ? Infinity : (edge - o) / d
  }
  let tX = startT + nextBound(ix, px, dx, origin.x)
  let tY = startT + nextBound(iy, py, dy, origin.y)
  let tZ = startT + nextBound(iz, pz, dz, origin.z)
  const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : cell / Math.abs(dx)
  const tDeltaY = Math.abs(dy) < 1e-9 ? Infinity : cell / Math.abs(dy)
  const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : cell / Math.abs(dz)

  let t = startT
  for (let guard = 0; guard < nx + ny + nz + 3; guard++) {
    const idx = grid.index.get(gridKey(ix, iy, iz, nx, ny))
    if (idx !== undefined && grid.alive[idx]) return { index: idx, distance: t }
    if (tX <= tY && tX <= tZ) {
      t = tX
      tX += tDeltaX
      ix += stepX
      if (ix < 0 || ix >= nx) return null
    } else if (tY <= tZ) {
      t = tY
      tY += tDeltaY
      iy += stepY
      if (iy < 0 || iy >= ny) return null
    } else {
      t = tZ
      tZ += tDeltaZ
      iz += stepZ
      if (iz < 0 || iz >= nz) return null
    }
    if (t > tMax) return null
  }
  return null
}

/**
 * 6-connected flood fill from the wall's base layer (iy === 0). Every live
 * voxel NOT reached is part of an unsupported island — returned grouped so
 * the caller can crumble them into debris.
 */
export function findUnsupportedIslands(grid: VoxelGridData): number[][] {
  const { count, coords, nx, ny, index } = grid
  const seen = new Uint8Array(count)
  const stack: number[] = []
  for (let i = 0; i < count; i++) {
    if (grid.alive[i] && coords[i * 3 + 1] === 0) {
      seen[i] = 1
      stack.push(i)
    }
  }
  const neighbors = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const
  while (stack.length > 0) {
    const i = stack.pop()!
    const ix = coords[i * 3]!
    const iy = coords[i * 3 + 1]!
    const iz = coords[i * 3 + 2]!
    for (const [ax, ay, az] of neighbors) {
      const j = index.get(gridKey(ix + ax, iy + ay, iz + az, nx, ny))
      if (j === undefined || seen[j] || !grid.alive[j]) continue
      seen[j] = 1
      stack.push(j)
    }
  }
  // Group unreached live voxels into their own connected islands.
  const islands: number[][] = []
  const grouped = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    if (!grid.alive[i] || seen[i] || grouped[i]) continue
    const island: number[] = []
    const work = [i]
    grouped[i] = 1
    while (work.length > 0) {
      const k = work.pop()!
      island.push(k)
      const ix = coords[k * 3]!
      const iy = coords[k * 3 + 1]!
      const iz = coords[k * 3 + 2]!
      for (const [ax, ay, az] of neighbors) {
        const j = index.get(gridKey(ix + ax, iy + ay, iz + az, nx, ny))
        if (j === undefined || grouped[j] || seen[j] || !grid.alive[j]) continue
        grouped[j] = 1
        work.push(j)
      }
    }
    islands.push(island)
  }
  return islands
}
