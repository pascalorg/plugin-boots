import { BufferAttribute, BufferGeometry } from 'three'

/**
 * Roof 2×2 corner heights — the pyramid grammar (GRAND-PLAN phase 6 item 2).
 *
 * A placed roof carries four corner heights (0 = eave level, 1 = raised by
 * WALL_H), one per footprint corner in the piece's LOCAL frame:
 *
 *   c3 (−X,+Z) ──── c2 (+X,+Z)      +Z = the classic slope's HIGH edge
 *        │               │           (matches ROOF_TILT: row 0 at −Z is
 *   c0 (−X,−Z) ──── c1 (+X,−Z)      the LOW edge — builder.tsx cellCenter)
 *
 * The surface between corners is the bilinear patch, so the 16 patterns
 * cover the whole fort-builder roof family: slope (2 adjacent high),
 * corner slope (1 high), valley (3 high), flat cap (0 or 4), saddle
 * (diagonal). F-edit on a placed roof toggles the AIMED corner — same
 * edit idiom as the 3×3 cell masks, one level coarser.
 *
 * Everything here is pure math + plain BufferGeometry (CPU-built,
 * WebGPU-safe) so headless tests can cover it without mounting three.
 */

export type RoofCorners = [number, number, number, number]

/** The classic placed-roof shape: low at −Z, high at +Z (STAIR_TILT). */
export const SLOPE_CORNERS: RoofCorners = [0, 0, 1, 1]

/** R-cycle shape presets for the roof GHOST: slope → corner-tip (one high
 * corner — the low-cone read) → valley (three high) → flat cap (all high,
 * Keep maps it to a ridge-level slab terrace). Canonical patterns keep the
 * high side at local +Z/c2; the ghost's yaw (from the facing cardinal) aims
 * it, so every preset rises away from the player. */
export const ROOF_PRESETS: ReadonlyArray<RoofCorners> = [
  SLOPE_CORNERS,
  [0, 0, 1, 0],
  [0, 1, 1, 1],
  [1, 1, 1, 1],
]

/** Corner pattern for preset index `preset` (wraps mod 4, negatives too).
 * Returns a fresh array — placements own their corners. */
export function presetCorners(preset: number): RoofCorners {
  return [...ROOF_PRESETS[((preset % 4) + 4) % 4]!] as RoofCorners
}

/** Footprint half-extent (matches the 3 m floor/roof plan span). */
const HALF = 1.5
/** Slab thickness of the surface (matches PIECE_DIMS roof thickness). */
const THICK = 0.12
/** Corner rise when a corner is high (builder WALL_H). */
export const CORNER_RISE = 2.8

/** Local corner center positions, indexed like RoofCorners. */
export const CORNER_XZ: ReadonlyArray<readonly [number, number]> = [
  [-HALF, -HALF],
  [HALF, -HALF],
  [HALF, HALF],
  [-HALF, HALF],
]

/** Rotate a corner pattern by one +90° piece yaw step (local +Z → +X):
 * the value at ring index i comes from the corner that rotates INTO it. */
export function rotateQuarter(corners: RoofCorners): RoofCorners {
  return [corners[1], corners[2], corners[3], corners[0]]
}

export function toggleCorner(corners: RoofCorners, index: number): RoofCorners {
  const next = [...corners] as RoofCorners
  next[index & 3] = next[index & 3] ? 0 : 1
  return next
}

/** Nearest corner index to a LOCAL-frame footprint point. */
export function nearestCorner(localX: number, localZ: number): number {
  if (localZ < 0) return localX < 0 ? 0 : 1
  return localX < 0 ? 3 : 2
}

/** Bilinear corner-height interpolation at footprint fractions u,v ∈ [0,1]
 * (u along −X→+X, v along −Z→+Z), in corner-height units (0..1). */
export function bilinearHeight(corners: RoofCorners, u: number, v: number): number {
  return (
    (1 - u) * (1 - v) * corners[0] +
    u * (1 - v) * corners[1] +
    u * v * corners[2] +
    (1 - u) * v * corners[3]
  )
}

export type RoofShape =
  | { kind: 'flat'; high: boolean }
  | { kind: 'slope'; quarter: number }
  | { kind: 'corner'; quarter: number }
  | { kind: 'valley'; quarter: number }
  | { kind: 'saddle' }

/** Classify a corner pattern for Keep's node mapping and HUD copy. For the
 * rotated kinds, `quarter` counts the +90° yaw steps that carry the
 * canonical pattern (slope = SLOPE_CORNERS, corner = only c2 high, valley =
 * only c0 low) onto this one — Keep adds quarter·π/2 to the piece yaw. */
export function classifyRoofShape(corners: RoofCorners): RoofShape {
  const sum = corners[0] + corners[1] + corners[2] + corners[3]
  if (sum === 0 || sum === 4) return { kind: 'flat', high: sum === 4 }
  if (sum === 2) {
    if (corners[0] === corners[2]) return { kind: 'saddle' } // diagonal pair
    let pattern: RoofCorners = SLOPE_CORNERS
    for (let quarter = 0; quarter < 4; quarter++) {
      if (
        pattern[0] === corners[0] &&
        pattern[1] === corners[1] &&
        pattern[2] === corners[2] &&
        pattern[3] === corners[3]
      ) {
        return { kind: 'slope', quarter }
      }
      pattern = rotateQuarter(pattern)
    }
  }
  const canonical: RoofCorners = sum === 1 ? [0, 0, 1, 0] : [0, 1, 1, 1]
  let pattern = canonical
  for (let quarter = 0; quarter < 4; quarter++) {
    if (
      pattern[0] === corners[0] &&
      pattern[1] === corners[1] &&
      pattern[2] === corners[2] &&
      pattern[3] === corners[3]
    ) {
      return { kind: sum === 1 ? 'corner' : 'valley', quarter }
    }
    pattern = rotateQuarter(pattern)
  }
  return { kind: 'saddle' } // unreachable, but keeps the checker honest
}

const cornersKey = (corners: RoofCorners): string => corners.join('')

/** Lattice segments per side of the tessellated patch. */
const SEGS = 3

const geometryCache = new Map<string, BufferGeometry>()

/**
 * Solid bilinear-patch geometry for a corner pattern: tessellated top and
 * bottom sheets THICK apart plus the four closing side strips, centered on
 * the piece origin with y = 0 at eave level (mesh position uses the
 * piece's base y directly — no piecePose tilt/lift for corner roofs).
 * Cached per pattern (16 shapes max, shared by meshes AND colliders).
 */
export function cornerRoofGeometry(corners: RoofCorners): BufferGeometry {
  const key = cornersKey(corners)
  const cached = geometryCache.get(key)
  if (cached) return cached

  const positions: number[] = []
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  const at = (u: number, v: number, lift: number): [number, number, number] => [
    -HALF + u * 2 * HALF,
    bilinearHeight(corners, u, v) * CORNER_RISE + lift,
    -HALF + v * 2 * HALF,
  ]
  for (let i = 0; i < SEGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const u0 = i / SEGS
      const u1 = (i + 1) / SEGS
      const v0 = j / SEGS
      const v1 = (j + 1) / SEGS
      // Top sheet winds +Y-ish, bottom sheet the reverse.
      quad(at(u0, v0, THICK), at(u0, v1, THICK), at(u1, v1, THICK), at(u1, v0, THICK))
      quad(at(u0, v0, 0), at(u1, v0, 0), at(u1, v1, 0), at(u0, v1, 0))
    }
  }
  // Side strips close the slab edge (THICK tall, following the edge slope).
  for (let i = 0; i < SEGS; i++) {
    const t0 = i / SEGS
    const t1 = (i + 1) / SEGS
    quad(at(t0, 0, 0), at(t0, 0, THICK), at(t1, 0, THICK), at(t1, 0, 0)) // −Z edge
    quad(at(t0, 1, 0), at(t1, 1, 0), at(t1, 1, THICK), at(t0, 1, THICK)) // +Z edge
    quad(at(0, t0, 0), at(0, t1, 0), at(0, t1, THICK), at(0, t0, THICK)) // −X edge
    quad(at(1, t0, 0), at(1, t0, THICK), at(1, t1, THICK), at(1, t1, 0)) // +X edge
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometryCache.set(key, geometry)
  return geometry
}

export type RoofCornerHit = { t: number; corner: number }

/**
 * Ray vs the patch's TOP sheet (Möller–Trumbore over the 18 lattice
 * triangles), in WORLD space given the piece pose. Returns the nearest hit
 * with the corner index closest to the hit point — the F-edit targeting
 * for corner roofs (the 3×3 cell raycast has no meaning on a patch).
 */
export function raycastRoofCorner(
  corners: RoofCorners,
  pose: { x: number; y: number; z: number; yaw: number },
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
): RoofCornerHit | null {
  // World → local: translate, then rotate by −yaw about Y (the inverse of
  // keep.ts' local→world corner map).
  const cos = Math.cos(pose.yaw)
  const sin = Math.sin(pose.yaw)
  const toLocal = (wx: number, wy: number, wz: number): [number, number, number] => {
    const tx = wx - pose.x
    const tz = wz - pose.z
    return [tx * cos - tz * sin, wy - pose.y, tx * sin + tz * cos]
  }
  const [lox, loy, loz] = toLocal(ox, oy, oz)
  // Directions rotate without translation.
  const ldx = dx * cos - dz * sin
  const ldy = dy
  const ldz = dx * sin + dz * cos

  const at = (u: number, v: number): [number, number, number] => [
    -HALF + u * 2 * HALF,
    bilinearHeight(corners, u, v) * CORNER_RISE + THICK,
    -HALF + v * 2 * HALF,
  ]
  let best: RoofCornerHit | null = null
  const tri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ) => {
    const e1: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const px = ldy * e2[2] - ldz * e2[1]
    const py = ldz * e2[0] - ldx * e2[2]
    const pz = ldx * e2[1] - ldy * e2[0]
    const det = e1[0] * px + e1[1] * py + e1[2] * pz
    if (Math.abs(det) < 1e-9) return
    const inv = 1 / det
    const sx = lox - a[0]
    const sy = loy - a[1]
    const sz = loz - a[2]
    const u = (sx * px + sy * py + sz * pz) * inv
    if (u < -1e-6 || u > 1 + 1e-6) return
    const qx = sy * e1[2] - sz * e1[1]
    const qy = sz * e1[0] - sx * e1[2]
    const qz = sx * e1[1] - sy * e1[0]
    const v = (ldx * qx + ldy * qy + ldz * qz) * inv
    if (v < -1e-6 || u + v > 1 + 1e-6) return
    const t = (e2[0] * qx + e2[1] * qy + e2[2] * qz) * inv
    if (t < 0.01 || t > maxT) return
    if (best && t >= best.t) return
    const hx = lox + ldx * t
    const hz = loz + ldz * t
    best = { t, corner: nearestCorner(hx, hz) }
  }
  for (let i = 0; i < SEGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = at(i / SEGS, j / SEGS)
      const b = at(i / SEGS, (j + 1) / SEGS)
      const c = at((i + 1) / SEGS, (j + 1) / SEGS)
      const d = at((i + 1) / SEGS, j / SEGS)
      tri(a, b, c)
      tri(a, c, d)
    }
  }
  return best
}
