/**
 * Shell S0 — pure surface partition (clipper + clustering + packing).
 *
 * CPU-only module: no React, no GPU, no scene access. The caller transforms
 * the host mesh's triangles into the GRID frame (grid-local positions) and
 * hands them over; this module
 *   1. CLIPS every triangle against the axis-aligned cell lattice
 *      (Sutherland–Hodgman against successive planes x=k·cellX, y=k·cellY,
 *      z=k·cellZ spanned by the triangle's AABB) so every output triangle
 *      sits fully inside ONE cell. Normals and uvs interpolate EXACTLY
 *      linearly on the split-edge param t — no renormalization, no drift:
 *      the split-axis coordinate of a cut vertex is pinned to the plane.
 *   2. ASSIGNS each clipped triangle to the cell of its centroid nudged
 *      1 mm inward along the geometric face normal — skin faces lying on
 *      the outer lattice boundary land in the outermost cell
 *      deterministically (then clamped to the grid dims).
 *   3. CLUSTERS surface cells into fragments of 1–6 cells by greedy region
 *      growth in rng-shuffled order (target size drawn from weights
 *      {1:1, 2:2, 3:4, 4:3, 5:2, 6:1}); growth never crosses a domain
 *      boundary. Deterministic for a given rng seed.
 *   4. PACKS geometry-ready flat arrays, MATERIAL-MAJOR: all fragments of
 *      material 0 first, then material 1, … Each fragment's indices are
 *      contiguous within its material group, so a fragment can be hidden /
 *      detached with a single index-range edit. The index buffer is
 *      Uint32Array by contract — WebGPU promotes Uint16 and replaces the
 *      array, breaking in-place range edits.
 *
 * SLIVERS — documented choice: clipped pieces below SLIVER_AREA (1e-6 m²)
 * are KEPT, not merged into a neighbor cell. They already sit inside a
 * valid cell (the clipper guarantees it) and the nudged-centroid rule
 * assigns boundary-hugging pieces deterministically; merging would move
 * indices across fragment boundaries for no visual gain. Only numerically
 * degenerate fan triangles (area < 1e-12) are dropped.
 *
 * MIXED-MATERIAL CELLS — documented S0 choice: a cell's clustering domain
 * is its dominant material by clipped area, and ALL of a fragment's
 * triangles pack into the fragment's (single) material group — minority-
 * material slivers inside a cell render with the cell's dominant material.
 * This keeps fragmentForCell single-valued and every fragment inside
 * exactly one group.
 */

import type { VoxelGridData } from './voxel'

/** The lattice subset this module needs — structurally a VoxelGridData. */
export type ShellGrid = Pick<
  VoxelGridData,
  'nx' | 'ny' | 'nz' | 'cellX' | 'cellY' | 'cellZ' | 'count'
>

/** Hard cap on clipped output triangles — buildShellData returns null above it. */
export const SHELL_TRI_CAP = 12000

/** Inward centroid nudge (1 mm) that makes skin-face cell assignment deterministic. */
const NUDGE = 0.001
/** Distance-to-plane tolerance: vertices this close count as ON the plane. */
const PLANE_EPS = 1e-9
/** Fan triangles below this area are numerically degenerate and dropped. */
const DEGENERATE_AREA = 1e-12
/** Pieces below this area are slivers — KEPT by choice (see module doc). */
export const SLIVER_AREA = 1e-6

/**
 * The standard deterministic PRNG (canonical copy — dust/nature/craters
 * carry local ones; new code should import this one). Returns uniform
 * floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Clipping ────────────────────────────────────────────────────────────

/** One clipped triangle: 9 position floats, 9 normal floats, 6 uv floats. */
export type ShellTriangle = { positions: number[]; normals: number[]; uvs: number[] }

/** Input triangle (grid-frame positions) with its material slot. */
export type ShellSourceTri = ShellTriangle & { materialIndex: number }

/** Full clip-vertex: position + linearly carried normal and uv. */
type ClipVertex = {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  u: number
  v: number
}

const axisOf = (p: ClipVertex, axis: 0 | 1 | 2): number =>
  axis === 0 ? p.x : axis === 1 ? p.y : p.z

/** Lerp EVERY field at param t, then pin the split axis exactly to the plane. */
const lerpVertex = (a: ClipVertex, b: ClipVertex, t: number, axis: 0 | 1 | 2, plane: number): ClipVertex => {
  const out: ClipVertex = {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    nx: a.nx + (b.nx - a.nx) * t,
    ny: a.ny + (b.ny - a.ny) * t,
    nz: a.nz + (b.nz - a.nz) * t,
    u: a.u + (b.u - a.u) * t,
    v: a.v + (b.v - a.v) * t,
  }
  if (axis === 0) out.x = plane
  else if (axis === 1) out.y = plane
  else out.z = plane
  return out
}

/**
 * Split one convex polygon by an axis-aligned plane into the ≤plane and
 * ≥plane halves (Sutherland–Hodgman, both sides in one pass). On-plane
 * vertices go to BOTH sides; halves with <3 vertices are degenerate and
 * discarded by the caller.
 */
function splitPolygon(
  poly: ClipVertex[],
  axis: 0 | 1 | 2,
  plane: number,
): { below: ClipVertex[]; above: ClipVertex[] } {
  const below: ClipVertex[] = []
  const above: ClipVertex[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const da = axisOf(a, axis) - plane
    const db = axisOf(b, axis) - plane
    const sa = da > PLANE_EPS ? 1 : da < -PLANE_EPS ? -1 : 0
    const sb = db > PLANE_EPS ? 1 : db < -PLANE_EPS ? -1 : 0
    if (sa <= 0) below.push(a)
    if (sa >= 0) above.push(a)
    if (sa * sb < 0) {
      const cut = lerpVertex(a, b, da / (da - db), axis, plane)
      below.push(cut)
      above.push(cut)
    }
  }
  return { below, above }
}

/** Twice-signed-free triangle area of 9 packed floats (0.5·|e1×e2|). */
export function triangleArea(positions: ArrayLike<number>, offset = 0): number {
  const ax = positions[offset]! - 0
  const ay = positions[offset + 1]!
  const az = positions[offset + 2]!
  const ux = positions[offset + 3]! - ax
  const uy = positions[offset + 4]! - ay
  const uz = positions[offset + 5]! - az
  const vx = positions[offset + 6]! - ax
  const vy = positions[offset + 7]! - ay
  const vz = positions[offset + 8]! - az
  const cx = uy * vz - uz * vy
  const cy = uz * vx - ux * vz
  const cz = ux * vy - uy * vx
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
}

/**
 * Clip one grid-frame triangle by every interior lattice plane its AABB
 * spans. Output: fan-triangulated convex pieces, each fully inside one
 * cell slab per axis (numerically degenerate fans dropped — see module
 * doc). Positions/normals/uvs are packed 9/9/6 like the input.
 */
export function clipTriangleByPlanes(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  uvs: ArrayLike<number>,
  cellX: number,
  cellY: number,
  cellZ: number,
): ShellTriangle[] {
  let polys: ClipVertex[][] = [
    [0, 1, 2].map((i): ClipVertex => ({
      x: positions[i * 3]!,
      y: positions[i * 3 + 1]!,
      z: positions[i * 3 + 2]!,
      nx: normals[i * 3]!,
      ny: normals[i * 3 + 1]!,
      nz: normals[i * 3 + 2]!,
      u: uvs[i * 2]!,
      v: uvs[i * 2 + 1]!,
    })),
  ]
  const cells: [number, number, number] = [cellX, cellY, cellZ]
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis++) {
    const cell = cells[axis]!
    if (!(cell > 0)) continue
    let min = Infinity
    let max = -Infinity
    for (const poly of polys) {
      for (const p of poly) {
        const c = axisOf(p, axis)
        if (c < min) min = c
        if (c > max) max = c
      }
    }
    const kMin = Math.floor(min / cell + PLANE_EPS) + 1
    const kMax = Math.ceil(max / cell - PLANE_EPS) - 1
    for (let k = kMin; k <= kMax; k++) {
      const plane = k * cell
      const next: ClipVertex[][] = []
      for (const poly of polys) {
        const { below, above } = splitPolygon(poly, axis, plane)
        if (below.length >= 3) next.push(below)
        if (above.length >= 3) next.push(above)
      }
      polys = next
    }
  }
  const out: ShellTriangle[] = []
  for (const poly of polys) {
    const a = poly[0]!
    for (let i = 1; i + 1 < poly.length; i++) {
      const b = poly[i]!
      const c = poly[i + 1]!
      const tri: ShellTriangle = {
        positions: [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z],
        normals: [a.nx, a.ny, a.nz, b.nx, b.ny, b.nz, c.nx, c.ny, c.nz],
        uvs: [a.u, a.v, b.u, b.v, c.u, c.v],
      }
      if (triangleArea(tri.positions) >= DEGENERATE_AREA) out.push(tri)
    }
  }
  return out
}

// ─── Cell assignment ─────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Cell of a clipped triangle: floor((centroid − 1 mm·faceNormal) / cell)
 * per axis, clamped to the grid dims. The GEOMETRIC face normal (not the
 * shading normals) keeps the nudge deterministic; a degenerate cross
 * product skips the nudge.
 */
export function cellOfTriangle(positions: ArrayLike<number>, grid: ShellGrid): number {
  const ax = positions[0]!
  const ay = positions[1]!
  const az = positions[2]!
  const ux = positions[3]! - ax
  const uy = positions[4]! - ay
  const uz = positions[5]! - az
  const vx = positions[6]! - ax
  const vy = positions[7]! - ay
  const vz = positions[8]! - az
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
  if (len > 1e-20) {
    nx /= len
    ny /= len
    nz /= len
  } else {
    nx = ny = nz = 0
  }
  const cx = (ax + positions[3]! + positions[6]!) / 3 - NUDGE * nx
  const cy = (ay + positions[4]! + positions[7]!) / 3 - NUDGE * ny
  const cz = (az + positions[5]! + positions[8]!) / 3 - NUDGE * nz
  const ix = clamp(Math.floor(cx / grid.cellX), 0, grid.nx - 1)
  const iy = clamp(Math.floor(cy / grid.cellY), 0, grid.ny - 1)
  const iz = clamp(Math.floor(cz / grid.cellZ), 0, grid.nz - 1)
  return ix + grid.nx * (iy + grid.ny * iz)
}

// ─── Clustering ──────────────────────────────────────────────────────────

/** Fragment target-size weights for sizes 1..6 — {1:1, 2:2, 3:4, 4:3, 5:2, 6:1}. */
const FRAGMENT_SIZE_WEIGHTS = [1, 2, 4, 3, 2, 1]
const FRAGMENT_WEIGHT_TOTAL = 13

const drawFragmentSize = (rng: () => number): number => {
  let r = rng() * FRAGMENT_WEIGHT_TOTAL
  for (let s = 0; s < FRAGMENT_SIZE_WEIGHTS.length; s++) {
    r -= FRAGMENT_SIZE_WEIGHTS[s]!
    if (r < 0) return s + 1
  }
  return FRAGMENT_SIZE_WEIGHTS.length
}

/**
 * Greedy region growth over the surface cells: visit cells in rng-shuffled
 * order; every still-unvisited cell seeds a fragment with a target size
 * drawn from FRAGMENT_SIZE_WEIGHTS and grows it one rng-picked frontier
 * neighbor at a time — only neighbors that ARE surface cells and share the
 * seed's domain (fragments never straddle a domain boundary). Deterministic
 * for a given rng seed. Returns cell → fragmentId (dense over
 * [0, maxCell]; −1 = not a surface cell); fragment ids are sequential in
 * seeding order.
 */
export function clusterCells(
  surfaceCells: Iterable<number>,
  adjacency: (cell: number) => number[],
  domainOf: (cell: number) => number,
  rng: () => number,
): Int32Array {
  const cells = [...surfaceCells]
  let maxCell = -1
  for (const cell of cells) if (cell > maxCell) maxCell = cell
  const out = new Int32Array(maxCell + 1).fill(-1)
  const surface = new Set(cells)
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = cells[i]!
    cells[i] = cells[j]!
    cells[j] = tmp
  }
  const frontier: number[] = []
  const queued = new Set<number>()
  const pushFrontier = (cell: number, domain: number) => {
    for (const n of adjacency(cell)) {
      if (!surface.has(n) || out[n] !== -1 || queued.has(n)) continue
      if (domainOf(n) !== domain) continue
      frontier.push(n)
      queued.add(n)
    }
  }
  let nextFragment = 0
  for (const seed of cells) {
    if (out[seed] !== -1) continue
    const fragment = nextFragment++
    const domain = domainOf(seed)
    const target = drawFragmentSize(rng)
    out[seed] = fragment
    let size = 1
    frontier.length = 0
    queued.clear()
    pushFrontier(seed, domain)
    while (size < target && frontier.length > 0) {
      const pick = Math.floor(rng() * frontier.length)
      const cell = frontier[pick]!
      frontier[pick] = frontier[frontier.length - 1]!
      frontier.pop()
      queued.delete(cell)
      if (out[cell] !== -1) continue
      out[cell] = fragment
      size++
      pushFrontier(cell, domain)
    }
  }
  return out
}

// ─── Packing ─────────────────────────────────────────────────────────────

export type ShellGroup = { start: number; count: number; materialIndex: number }
export type ShellFragmentRange = { indexStart: number; indexCount: number }

/**
 * Geometry-ready shell: flat vertex arrays (vertices unshared, so
 * index[i] === i), a MANDATORY Uint32 index (WebGPU promotes Uint16 and
 * replaces the array — in-place fragment edits would silently detach),
 * material-major draw groups, and per-fragment contiguous index ranges
 * that each sit inside exactly one group.
 */
export type ShellData = {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  index: Uint32Array
  /** Material-major: all fragments of material 0, then material 1, … */
  groups: ShellGroup[]
  /** fragmentId → its contiguous index range (within one group). */
  fragments: ShellFragmentRange[]
  /** cell → fragmentId, length grid.count; −1 = cell carries no surface. */
  fragmentForCell: Int32Array
  /** fragmentId → its cells, sorted ascending. */
  cellsOfFragment: number[][]
}

/**
 * Full S0 pipeline: clip → assign → cluster → pack. Returns null when the
 * clipped output exceeds SHELL_TRI_CAP triangles (the caller falls back to
 * the unpartitioned host mesh). Deterministic for a given (tris, grid,
 * seed) — the rng drives shuffle, fragment sizes and frontier picks only.
 */
export function buildShellData(
  tris: ShellSourceTri[],
  grid: ShellGrid,
  seed: number,
): ShellData | null {
  const rng = mulberry32(seed)

  // Clip against the lattice and bucket every piece into its cell.
  type Piece = ShellTriangle & { materialIndex: number }
  const cellTris = new Map<number, Piece[]>()
  let triCount = 0
  for (const tri of tris) {
    const pieces = clipTriangleByPlanes(
      tri.positions,
      tri.normals,
      tri.uvs,
      grid.cellX,
      grid.cellY,
      grid.cellZ,
    )
    for (const piece of pieces) {
      triCount++
      if (triCount > SHELL_TRI_CAP) return null
      const cell = cellOfTriangle(piece.positions, grid)
      let list = cellTris.get(cell)
      if (!list) cellTris.set(cell, (list = []))
      list.push({ ...piece, materialIndex: tri.materialIndex })
    }
  }

  // Per-cell clustering domain: dominant material by clipped area
  // (ties break toward the lower material index — deterministic).
  const cellMaterial = new Map<number, number>()
  for (const [cell, list] of cellTris) {
    const areaByMaterial = new Map<number, number>()
    for (const piece of list) {
      const prev = areaByMaterial.get(piece.materialIndex) ?? 0
      areaByMaterial.set(piece.materialIndex, prev + triangleArea(piece.positions))
    }
    let best = -1
    let bestArea = -Infinity
    for (const [material, area] of areaByMaterial) {
      if (area > bestArea || (area === bestArea && material < best)) {
        best = material
        bestArea = area
      }
    }
    cellMaterial.set(cell, best)
  }

  // Cluster over the 6-neighborhood (in-bounds only).
  const { nx, ny, nz } = grid
  const adjacency = (cell: number): number[] => {
    const ix = cell % nx
    const iy = Math.floor(cell / nx) % ny
    const iz = Math.floor(cell / (nx * ny))
    const neighbors: number[] = []
    if (ix > 0) neighbors.push(cell - 1)
    if (ix < nx - 1) neighbors.push(cell + 1)
    if (iy > 0) neighbors.push(cell - nx)
    if (iy < ny - 1) neighbors.push(cell + nx)
    if (iz > 0) neighbors.push(cell - nx * ny)
    if (iz < nz - 1) neighbors.push(cell + nx * ny)
    return neighbors
  }
  const clustered = clusterCells(
    cellTris.keys(),
    adjacency,
    (cell) => cellMaterial.get(cell) ?? -1,
    rng,
  )

  const fragmentForCell = new Int32Array(grid.count).fill(-1)
  const cellsOfFragment: number[][] = []
  for (const cell of cellTris.keys()) {
    const fragment = clustered[cell]!
    fragmentForCell[cell] = fragment
    while (cellsOfFragment.length <= fragment) cellsOfFragment.push([])
    cellsOfFragment[fragment]!.push(cell)
  }
  for (const cells of cellsOfFragment) cells.sort((a, b) => a - b)

  // Pack material-major: fragments sorted by (material, fragmentId); every
  // piece of a fragment's cells lands in the fragment's group (see the
  // mixed-material note in the module doc).
  const fragmentMaterial = cellsOfFragment.map(
    (cells) => cellMaterial.get(cells[0]!) ?? 0,
  )
  const order = cellsOfFragment
    .map((_, fragment) => fragment)
    .sort((a, b) => fragmentMaterial[a]! - fragmentMaterial[b]! || a - b)

  const positions = new Float32Array(triCount * 9)
  const normals = new Float32Array(triCount * 9)
  const uvs = new Float32Array(triCount * 6)
  const index = new Uint32Array(triCount * 3)
  const fragments: ShellFragmentRange[] = new Array(cellsOfFragment.length)
  const groups: ShellGroup[] = []
  let group: ShellGroup | null = null
  let cursor = 0
  for (const fragment of order) {
    const material = fragmentMaterial[fragment]!
    if (!group || group.materialIndex !== material) {
      group = { start: cursor, count: 0, materialIndex: material }
      groups.push(group)
    }
    const indexStart = cursor
    for (const cell of cellsOfFragment[fragment]!) {
      for (const piece of cellTris.get(cell)!) {
        positions.set(piece.positions, cursor * 3)
        normals.set(piece.normals, cursor * 3)
        uvs.set(piece.uvs, cursor * 2)
        index[cursor] = cursor
        index[cursor + 1] = cursor + 1
        index[cursor + 2] = cursor + 2
        cursor += 3
      }
    }
    fragments[fragment] = { indexStart, indexCount: cursor - indexStart }
    group.count += cursor - indexStart
  }

  return { positions, normals, uvs, index, groups, fragments, fragmentForCell, cellsOfFragment }
}
