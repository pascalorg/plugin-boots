import { Box3, Matrix4, Quaternion, Ray, Vector3 } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'

/**
 * Voxel destruction core — the "walls crumble piece by piece" feel.
 *
 * A damaged wall's meshes are sampled into a voxel grid (the three-mesh-bvh
 * `voxelize` recipe: shell cells via `intersectsBox` OBB tests, interior
 * cells via the backface-raycast trick), then rendered elsewhere as one
 * InstancedMesh. Grids are world-axis-aligned by default; a grid built with
 * a `yaw` is axis-aligned in a Y-rotated LOCAL frame instead (diagonal
 * walls), and a grid built with a full `basis` quaternion is axis-aligned
 * in an arbitrarily rotated frame (sloped roof planes). Queries rotate
 * world coordinates into that frame while `centers` stay world-space. This
 * module is renderer-free math: build, radius removal, DDA ray-walk, and
 * the flood-fill that finds disconnected islands so they can crumble.
 */

export type VoxelSource = {
  bvh: MeshBVH
  /** Mesh local → world. */
  matrixWorld: Matrix4
}

/**
 * Unit quaternion giving the grid's orthonormal basis as the WORLD → GRID
 * rotation (apply it to a world vector to land in grid coordinates; its
 * conjugate maps grid → world). The scalar-yaw compatibility case is
 * q = Qy(yaw): x = z = 0, y = sin(yaw/2), w = cos(yaw/2) — exactly the
 * world→local rotation the yaw convention already uses (local→world renders
 * as rotation [0, −yaw, 0]).
 *
 * Roof-plane plan (docs/MULTILEVEL-PLAN.md Phase C): destruction.ts will
 * later build a pitched grid by passing basis = Qy(yaw) · Qx(pitch) so the
 * roof slab is axis-aligned in the grid frame (thickness along grid Z, run
 * along grid X, slope along grid Y). Bounds are then the slab's AABB in
 * that frame, removeSphere/raycastVoxels keep taking WORLD coordinates
 * unchanged, and findUnsupportedIslands' iy === 0 base layer becomes the
 * plane's low (eave-side) row — "down" rotates with the basis for free.
 */
export type VoxelBasis = { x: number; y: number; z: number; w: number }

/** The compatibility basis: q = Qy(yaw), i.e. world→grid for a yaw grid. */
export const yawBasis = (yaw: number): VoxelBasis => ({
  x: 0,
  y: Math.sin(yaw / 2),
  z: 0,
  w: Math.cos(yaw / 2),
})

/** True when the basis is a pure Y rotation (incl. identity) — the legacy
 * scalar-yaw fast path applies and stays BIT-identical to the pre-basis
 * code (it keeps using cos/sin of `yaw` directly, never the quaternion). */
const basisIsYawOnly = (q: VoxelBasis) => q.x === 0 && q.z === 0

/** Yaw of a yaw-only basis (2·atan2 keeps the full ±π range). */
const yawOfBasis = (q: VoxelBasis) => 2 * Math.atan2(q.y, q.w)

/** out = q ⊗ v ⊗ q⁻¹ — rotate a world vector into the grid frame when q is
 * a VoxelGridData basis. Allocation-free (writes into `out`). Exported for
 * the roof-plane lane (destruction.ts skin/sheet math on pitched grids). */
export const rotateByBasis = (
  q: VoxelBasis,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
) => {
  const tx = 2 * (q.y * z - q.z * y)
  const ty = 2 * (q.z * x - q.x * z)
  const tz = 2 * (q.x * y - q.y * x)
  out.x = x + q.w * tx + (q.y * tz - q.z * ty)
  out.y = y + q.w * ty + (q.z * tx - q.x * tz)
  out.z = z + q.w * tz + (q.x * ty - q.y * tx)
}

/** Rotate by the conjugate (grid → world) — see rotateByBasis. */
export const rotateByBasisInverse = (
  q: VoxelBasis,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
) => {
  const tx = 2 * (-q.y * z + q.z * y)
  const ty = 2 * (-q.z * x + q.x * z)
  const tz = 2 * (-q.x * y + q.y * x)
  out.x = x + q.w * tx + (-q.y * tz + q.z * ty)
  out.y = y + q.w * ty + (-q.z * tx + q.x * tz)
  out.z = z + q.w * tz + (-q.x * ty + q.y * tx)
}

export type VoxelGridData = {
  /** Legacy/render size — the LARGEST per-axis cell (length/height cell on
   * anisotropic wall grids). Debris sizing and gap-free collision spheres
   * key off this. Grid math must use cellX/cellY/cellZ. */
  cell: number
  cellX: number
  cellY: number
  cellZ: number
  nx: number
  ny: number
  nz: number
  /** Grid-axes rotation about world Y (radians); 0 = world-aligned. When
   * set, `origin` and cell indexing live in the yaw-local frame (world
   * rotated by +yaw about the Y axis through the world origin) while
   * `centers` stay world-space. Same convention as the studs: local→world
   * renders as rotation [0, −yaw, 0]. Kept in sync with `q`: authoritative
   * only while `q` is yaw-only (q.x === q.z === 0) — a general basis has no
   * scalar-yaw equivalent, so such grids report yaw 0 and consumers must
   * read `q` instead. */
  yaw: number
  /** Full orthonormal basis, WORLD → GRID (see VoxelBasis). Equals
   * yawBasis(yaw) for every grid built without an explicit basis. */
  q: VoxelBasis
  /** Min corner of cell (0,0,0) — world-space, or in the grid frame when
   * the basis is non-identity (yaw ≠ 0 / rotated q). */
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
const _yawMat = new Matrix4()
const _ray = new Ray()
const _p = new Vector3()
const _quat = new Quaternion()
const _v = { x: 0, y: 0, z: 0 }

const gridKey = (ix: number, iy: number, iz: number, nx: number, ny: number) =>
  ix + nx * (iy + ny * iz)

/** Cap on voxels per wall — beyond this the cell size grows to compensate. */
const MAX_VOXELS = 1600

/** Per-axis cell override — wall anatomy pins the THICKNESS axis to a thin
 * cell (thickness/3 → 0.03–0.05 m skins) so even a 0.10 m wall gets three
 * layers. Overridden axes keep their cell fixed; the rest stay adaptive. */
export type VoxelCellOverride = { x?: number; y?: number; z?: number }

const spanOf = (extent: number, cell: number) =>
  Math.max(1, Math.ceil(extent / cell - 1e-6))

export function buildVoxelGrid(
  sources: VoxelSource[],
  /** Sources' AABB — world-space, or in the grid frame when the grid is
   * rotated (yaw ≠ 0 or an explicit basis). */
  worldBounds: Box3,
  preferredCell = 0.15,
  /** True for chunky volumes (doors, slabs, furniture): sizes the cell so
   * even a 100%-occupied grid stays ≤ MAX_VOXELS instead of relying on the
   * thin-wall occupancy discount. */
  solid = false,
  cellSizes?: VoxelCellOverride,
  /** Rotate the grid axes about world Y — diagonal walls build in their
   * own frame so the thickness axis is thin again (see VoxelGridData.yaw). */
  yaw = 0,
  /** Full orthonormal basis (WORLD → GRID, see VoxelBasis) — overrides
   * `yaw`. This is how destruction.ts will later hand in a roof-plane
   * frame (Qy(yaw)·Qx(pitch)) so a pitched slab voxelizes plane-aligned. */
  basis?: VoxelBasis,
  /** Skip the interior backface fill — SURFACE trace only. Open triangle
   * SOUPS (the roof residual lane's gable-end faces) have no watertight
   * inside: a ray cast from anywhere behind a lone face hits its backface,
   * so the voxelize.js trick would flood every cell up to it. */
  surfaceOnly = false,
): VoxelGridData {
  const size = new Vector3()
  worldBounds.getSize(size)
  // Grow the adaptive cell until the raw grid is small enough that even a
  // solid fill stays under budget (plain walls are mostly thin, so real
  // counts land far lower). Anisotropic wall grids fill their thickness
  // axis ~100%, so an override forfeits the occupancy discount.
  let cell = preferredCell
  const budget = solid || cellSizes ? MAX_VOXELS : MAX_VOXELS * 24
  for (let guard = 0; guard < 12; guard++) {
    const rawCount =
      spanOf(size.x, cellSizes?.x ?? cell) *
      spanOf(size.y, cellSizes?.y ?? cell) *
      spanOf(size.z, cellSizes?.z ?? cell)
    if (rawCount <= budget) break
    cell *= 1.35
  }
  const cellX = cellSizes?.x ?? cell
  const cellY = cellSizes?.y ?? cell
  const cellZ = cellSizes?.z ?? cell
  const nx = spanOf(size.x, cellX)
  const ny = spanOf(size.y, cellY)
  const nz = spanOf(size.z, cellZ)
  const origin = worldBounds.min

  // Resolve the grid basis. An explicit yaw-only basis routes through the
  // legacy scalar-yaw path (bit-identical trig); anything else is general.
  const q = basis ?? yawBasis(yaw)
  const pureYaw = basisIsYawOnly(q)
  if (basis) yaw = pureYaw ? yawOfBasis(basis) : 0

  // Rotated grids sample cells that are axis-aligned in the GRID frame —
  // fold the grid→world rotation into each mesh inverse so the OBB shell
  // test and the interior backface ray consume grid-frame coords directly.
  const rotated = pureYaw ? yaw !== 0 : true
  if (rotated) {
    if (pureYaw) _yawMat.makeRotationY(-yaw)
    else _yawMat.makeRotationFromQuaternion(_quat.set(-q.x, -q.y, -q.z, q.w))
  }
  const inverses = sources.map((s) => {
    const inverse = _mat.clone().copy(s.matrixWorld).invert()
    if (rotated) inverse.multiply(_yawMat)
    return inverse
  })
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)

  const coords: number[] = []
  const centers: number[] = []
  const index = new Map<number, number>()

  const halfX = cellX / 2
  const halfY = cellY / 2
  const halfZ = cellZ / 2
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cx = origin.x + ix * cellX + halfX
        const cy = origin.y + iy * cellY + halfY
        const cz = origin.z + iz * cellZ + halfZ
        let inside = false
        for (let m = 0; m < sources.length && !inside; m++) {
          const bvh = sources[m]?.bvh
          const inv = inverses[m]
          if (!bvh || !inv) continue
          // Shell test: world-aligned voxel box as an OBB in mesh space.
          _box.min.set(cx - halfX, cy - halfY, cz - halfZ)
          _box.max.set(cx + halfX, cy + halfY, cz + halfZ)
          if (bvh.intersectsBox(_box, inv)) {
            inside = true
            break
          }
          if (surfaceOnly) continue
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
        // Centers are ALWAYS world-space — rendering, debris, and distance
        // checks never need to know about the grid frame.
        if (!pureYaw) {
          rotateByBasisInverse(q, cx, cy, cz, _v)
          centers.push(_v.x, _v.y, _v.z)
        } else if (yaw === 0) centers.push(cx, cy, cz)
        else centers.push(cx * cosYaw - cz * sinYaw, cy, cx * sinYaw + cz * cosYaw)
      }
    }
  }

  const count = coords.length / 3
  return {
    cell: Math.max(cellX, cellY, cellZ),
    cellX,
    cellY,
    cellZ,
    nx,
    ny,
    nz,
    yaw,
    q,
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
 * the smallest PHYSICAL extent — anisotropic wall grids give the thinnest
 * axis as many cells as the others, so raw spans can't be trusted) — the
 * stud cavity between them becomes empty space. A cell is interior when,
 * along that axis, it is neither within one cell of the min face nor of the
 * max face. Grids ≤ 2 cells thick have no interior and are returned
 * unchanged (same object). Pass `maxThickness` to also bail (same object)
 * when even the thinnest axis is physically thicker than a plausible wall —
 * diagonal walls voxelize as deep isotropic volumes whose min extent is the
 * wall HEIGHT, and skinning those would delete the entire wall body.
 */
export function dropInteriorCells(grid: VoxelGridData, maxThickness = Infinity): VoxelGridData {
  let axis = 0
  let span = grid.nx
  let extent = grid.nx * grid.cellX
  if (grid.ny * grid.cellY < extent) {
    axis = 1
    span = grid.ny
    extent = grid.ny * grid.cellY
  }
  if (grid.nz * grid.cellZ < extent) {
    axis = 2
    span = grid.nz
    extent = grid.nz * grid.cellZ
  }
  if (span <= 2 || extent > maxThickness) return grid

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
    cellX: grid.cellX,
    cellY: grid.cellY,
    cellZ: grid.cellZ,
    nx: grid.nx,
    ny: grid.ny,
    nz: grid.nz,
    yaw: grid.yaw,
    q: grid.q,
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
  return slabEntry(lox, loy, loz, ldx, ldy, ldz, halfX, halfY, halfZ, maxDist)
}

/**
 * General-basis twin of raycastYawObb: ray vs an OBB whose orientation is
 * a full quaternion basis (WORLD → BOX-LOCAL, same convention as
 * VoxelGridData.q — raycastObb(..., yawBasis(yaw), d) matches
 * raycastYawObb(..., yaw, d) up to rounding). This is the roof-plane hook:
 * pitched stud/sheet segments will pass Qy(yaw)·Qx(pitch) here.
 */
export function raycastObb(
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
  basis: VoxelBasis,
  maxDist: number,
): number | null {
  rotateByBasis(basis, ox - cx, oy - cy, oz - cz, _v)
  const lox = _v.x
  const loy = _v.y
  const loz = _v.z
  rotateByBasis(basis, dx, dy, dz, _v)
  return slabEntry(lox, loy, loz, _v.x, _v.y, _v.z, halfX, halfY, halfZ, maxDist)
}

/** Shared slab test in the box's local frame (see raycastYawObb). */
function slabEntry(
  lox: number,
  loy: number,
  loz: number,
  ldx: number,
  ldy: number,
  ldz: number,
  halfX: number,
  halfY: number,
  halfZ: number,
  maxDist: number,
): number | null {
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

/** Restrict a removeSphere carve to ONE skin of a layered wall grid: only
 * cells on `side` of `axis` (0 = min-face layer half, 1 = max-face half —
 * same split rule as the sheet builder) are removed. The pierce-through fix:
 * a shot that enters one drywall face must not also delete the far face. */
export type SkinLimit = { axis: 0 | 1 | 2; side: 0 | 1 }

/** Kill every live voxel within `radius` of a world point. Returns their
 * indices. Pass `skin` to confine the carve to one face layer of a layered
 * wall grid (see SkinLimit). */
export function removeSphere(
  grid: VoxelGridData,
  x: number,
  y: number,
  z: number,
  radius: number,
  skin?: SkinLimit,
): number[] {
  const removed: number[] = []
  const { cellX, cellY, cellZ, origin, nx, ny, nz, yaw } = grid
  // Rotated grids index cells in their own frame — rotate the query point
  // for the cell-range bounds (the r² check below stays world vs world
  // centers, so the carve is exact in any basis).
  let lx = x
  let ly = y
  let lz = z
  if (!basisIsYawOnly(grid.q)) {
    rotateByBasis(grid.q, x, y, z, _v)
    lx = _v.x
    ly = _v.y
    lz = _v.z
  } else if (yaw !== 0) {
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    lx = x * cos + z * sin
    lz = -x * sin + z * cos
  }
  const minX = Math.max(0, Math.floor((lx - radius - origin.x) / cellX))
  const maxX = Math.min(nx - 1, Math.floor((lx + radius - origin.x) / cellX))
  const minY = Math.max(0, Math.floor((ly - radius - origin.y) / cellY))
  const maxY = Math.min(ny - 1, Math.floor((ly + radius - origin.y) / cellY))
  const minZ = Math.max(0, Math.floor((lz - radius - origin.z) / cellZ))
  const maxZ = Math.min(nz - 1, Math.floor((lz + radius - origin.z) / cellZ))
  const r2 = radius * radius
  const skinAxis = skin?.axis ?? -1
  const skinSpan = skinAxis === 0 ? nx : skinAxis === 1 ? ny : nz
  for (let iz = minZ; iz <= maxZ; iz++) {
    for (let iy = minY; iy <= maxY; iy++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const idx = grid.index.get(gridKey(ix, iy, iz, nx, ny))
        if (idx === undefined || !grid.alive[idx]) continue
        if (skin) {
          // Same min/max-half split as the sheet builder — cells on the
          // other face layer survive the carve untouched.
          const c = grid.coords[idx * 3 + skinAxis]!
          const side = c * 2 < skinSpan - 1 ? 0 : 1
          if (side !== skin.side) continue
        }
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
 * ray crosses, or null. The grid is axis-aligned in its own frame so this is
 * exact and far cheaper than any mesh raycast — rotated grids just rotate
 * the WORLD ray into the grid frame first (rotations preserve distances, so
 * the returned distance is valid in world space as-is).
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
  const { cellX, cellY, cellZ, origin, nx, ny, nz, yaw } = grid
  if (!basisIsYawOnly(grid.q)) {
    rotateByBasis(grid.q, ox, oy, oz, _v)
    ox = _v.x
    oy = _v.y
    oz = _v.z
    rotateByBasis(grid.q, dx, dy, dz, _v)
    dx = _v.x
    dy = _v.y
    dz = _v.z
  } else if (yaw !== 0) {
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const lox = ox * cos + oz * sin
    oz = -ox * sin + oz * cos
    ox = lox
    const ldx = dx * cos + dz * sin
    dz = -dx * sin + dz * cos
    dx = ldx
  }
  // Clip the ray to the grid AABB first.
  const boundsMaxX = origin.x + nx * cellX
  const boundsMaxY = origin.y + ny * cellY
  const boundsMaxZ = origin.z + nz * cellZ
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
  let ix = Math.min(nx - 1, Math.max(0, Math.floor((px - origin.x) / cellX)))
  let iy = Math.min(ny - 1, Math.max(0, Math.floor((py - origin.y) / cellY)))
  let iz = Math.min(nz - 1, Math.max(0, Math.floor((pz - origin.z) / cellZ)))

  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const nextBound = (i: number, o: number, d: number, gridO: number, c: number) => {
    const edge = gridO + (d > 0 ? (i + 1) * c : i * c)
    return Math.abs(d) < 1e-9 ? Infinity : (edge - o) / d
  }
  let tX = startT + nextBound(ix, px, dx, origin.x, cellX)
  let tY = startT + nextBound(iy, py, dy, origin.y, cellY)
  let tZ = startT + nextBound(iz, pz, dz, origin.z, cellZ)
  const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : cellX / Math.abs(dx)
  const tDeltaY = Math.abs(dy) < 1e-9 ? Infinity : cellY / Math.abs(dy)
  const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : cellZ / Math.abs(dz)

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
 * the caller can crumble them into debris. Purely grid-space, so the basis
 * never enters: on a rotated grid "supported from iy === 0" means supported
 * from whatever world direction grid −Y points at (for a roof-plane basis,
 * the eave-side row — a pitched slab sheds its uphill half when severed).
 *
 * Pass `seeded` to replace the base-row rule with your own support seeds
 * (index → true when that cell is externally held up). HORIZONTAL sandwich
 * grids (slabs — thickness axis IS grid Y) need this: their iy === 0 row is
 * the entire ceiling skin, so the default would declare every slab
 * self-supporting forever. destruction.ts seeds slab cells from a probe
 * against live walls/colliders beneath instead (MULTILEVEL-PLAN Phase B).
 */
export function findUnsupportedIslands(
  grid: VoxelGridData,
  seeded?: (index: number) => boolean,
): number[][] {
  const { count, coords, nx, ny, nz, index } = grid
  const seen = new Uint8Array(count)
  const stack: number[] = []
  for (let i = 0; i < count; i++) {
    if (grid.alive[i] && (seeded ? seeded(i) : coords[i * 3 + 1] === 0)) {
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
      const jx = ix + ax
      const jy = iy + ay
      const jz = iz + az
      // Bounds check BEFORE the key lookup: gridKey is a flat linearization,
      // so an out-of-range coordinate aliases a real cell elsewhere (e.g.
      // -y off the base row = the TOP row of the previous z-slab) and the
      // flood would teleport into floating islands and call them supported.
      if (jx < 0 || jx >= nx || jy < 0 || jy >= ny || jz < 0 || jz >= nz) continue
      const j = index.get(gridKey(jx, jy, jz, nx, ny))
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
        const jx = ix + ax
        const jy = iy + ay
        const jz = iz + az
        if (jx < 0 || jx >= nx || jy < 0 || jy >= ny || jz < 0 || jz >= nz) continue
        const j = index.get(gridKey(jx, jy, jz, nx, ny))
        if (j === undefined || grouped[j] || seen[j] || !grid.alive[j]) continue
        grouped[j] = 1
        work.push(j)
      }
    }
    islands.push(island)
  }
  return islands
}

/** True when a WORLD point lies within the grid's volume (inclusive bounds,
 * small epsilon): the coincident-layer test damageTarget's fan-out uses to
 * tell interpenetrating duplicate walls (carve point ON both surfaces)
 * from merely-touching neighbors (stacked storeys, slab/wall seams). Same
 * frame handling as removeSphere. */
export function gridContainsPoint(
  grid: VoxelGridData,
  x: number,
  y: number,
  z: number,
  eps = 1e-3,
): boolean {
  const { cellX, cellY, cellZ, origin, nx, ny, nz, yaw } = grid
  let lx = x
  let ly = y
  let lz = z
  if (!basisIsYawOnly(grid.q)) {
    rotateByBasis(grid.q, x, y, z, _v)
    lx = _v.x
    ly = _v.y
    lz = _v.z
  } else if (yaw !== 0) {
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    lx = x * cos + z * sin
    lz = -x * sin + z * cos
  }
  return (
    lx >= origin.x - eps &&
    lx <= origin.x + nx * cellX + eps &&
    ly >= origin.y - eps &&
    ly <= origin.y + ny * cellY + eps &&
    lz >= origin.z - eps &&
    lz <= origin.z + nz * cellZ + eps
  )
}
