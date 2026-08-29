import { type Material, Matrix3, type Mesh, Vector3 } from 'three'
import { type RoofPlaneBasis, roofPlaneFrame } from './roof-framing'
import type { ShellSourceTri } from './shell'
import type { SurfaceMaterialLike } from './skin-tone'
import { isGlassLikeMesh } from './world'

/**
 * Roof PLANE enumeration from the host's merged roof mesh (MULTILEVEL-PLAN
 * Phase C2's sanctioned fallback: "cluster merged-mesh face normals").
 *
 * The host renders one merged CSG shell per roof node, so the plugin can't
 * read per-plane parametrics off the mesh — but every sloped face of the
 * shell shares its plane's outward normal. Clustering world-space triangle
 * normals recovers the planes for ANY roof type (gable, hip, shed,
 * gambrel…) with zero schema coupling:
 *
 *   1. Sloped UP-facing triangles (pitch within (MIN_PITCH, MAX_PITCH))
 *      cluster by normal proximity — one cluster per roof plane.
 *   2. Sloped DOWN-facing triangles (the shell's interior undersides)
 *      cluster the same way; a down cluster whose normal opposes an up
 *      cluster's gives the assembly THICKNESS (outer − inner surface
 *      offset along the plane normal). No partner ⇒ DEFAULT_SHELL_T.
 *   3. Each up cluster projects onto its roofPlaneFrame: eave = the
 *      down-slope edge (min upSlope), extents = across/upSlope spans, and
 *      `eaveCenter` lands on the INNER surface — exactly the
 *      RoofPlaneBasis contract buildRafters (roof-framing.ts) consumes.
 *
 * Each plane also carries its plane-space footprint triangles (`polyTris`)
 * so buildRafters clips every rafter line to the REAL polygon — hip
 * triangles shorten their jacks toward the corners and no stick top pokes
 * past the ridge (QA phase-6 round-3 fix).
 *
 * Limitation (documented, acceptable for the framing reveal): two DISJOINT
 * coplanar faces of one node merge into one plane (rafters bridge the gap)
 * — invisible until the roof is shot open, strictly better than no framing.
 */

/** Planes flatter than this never frame (mirror of roof-framing's gate). */
const MIN_PITCH = 0.03
/** Steeper than ~84° reads as a wall face (mansard bottoms stay in). */
const MAX_PITCH = 1.47
/** Normal-proximity cone for clustering (cos 4°). */
const CLUSTER_DOT = 0.99756
/** Ignore trim slivers — a real roof plane has at least this much area. */
const MIN_PLANE_AREA = 0.4
/** Assembly thickness when the shell exposes no interior underside. */
const DEFAULT_SHELL_T = 0.08
const MIN_SHELL_T = 0.02
const MAX_SHELL_T = 0.5
/** Normal-band slack around a kept plane's slab when classifying RIM faces:
 * end-caps sit exactly ON the outer/inner surfaces, but rake bargeboards
 * and ridge caps stand ~0.06-0.08 m PROUD of the shingle surface on host
 * shells (measured live) — a hair under one plane-grid cell, so the plane's
 * border cells still cover them. Metres. */
const SLAB_EPS = 0.1
/** In-plane dilation of the plane polygon for the rim test — gutter/trim
 * boards may stand slightly proud of the footprint edge. Metres. */
const RIM_PAD = 0.15

type NormalCluster = {
  /** Area-weighted normal sum (unnormalized while accumulating). */
  nx: number
  ny: number
  nz: number
  area: number
}

type Tri = {
  /** Unit face normal (world). */
  nx: number
  ny: number
  nz: number
  area: number
  /** World vertices, packed ax,ay,az,bx,by,bz,cx,cy,cz. */
  v: [number, number, number, number, number, number, number, number, number]
}

/** Sloped-face gate: |ny| inside the (MIN_PITCH, MAX_PITCH) cone. */
function slopedPitchOk(absNy: number): boolean {
  return absNy > Math.cos(MAX_PITCH) && absNy < Math.cos(MIN_PITCH)
}

function collectSlopedTris(meshes: readonly Mesh[], up: Tri[], down: Tri[], rest?: Tri[]): void {
  for (const mesh of meshes) {
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) continue
    const index = geometry.getIndex()
    const triCount = (index ? index.count : position.count) / 3
    const m = mesh.matrixWorld.elements
    const world = (vi: number, out: number[], o: number): void => {
      const x = position.getX(vi)
      const y = position.getY(vi)
      const z = position.getZ(vi)
      out[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      out[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      out[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      const v = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Tri['v']
      world(i0, v, 0)
      world(i1, v, 3)
      world(i2, v, 6)
      const ux = v[3] - v[0]
      const uy = v[4] - v[1]
      const uz = v[5] - v[2]
      const wx = v[6] - v[0]
      const wy = v[7] - v[1]
      const wz = v[8] - v[2]
      const cx = uy * wz - uz * wy
      const cy = uz * wx - ux * wz
      const cz = ux * wy - uy * wx
      const len = Math.sqrt(cx * cx + cy * cy + cz * cz)
      if (len < 1e-8) continue
      const ny = cy / len
      const tri: Tri = { nx: cx / len, ny, nz: cz / len, area: len / 2, v }
      if (!slopedPitchOk(Math.abs(ny))) rest?.push(tri)
      else if (ny > 0) up.push(tri)
      else down.push(tri)
    }
  }
}

/** Greedy normal clustering — one cluster per distinct plane orientation. */
function clusterNormals(tris: readonly Tri[]): NormalCluster[] {
  const clusters: NormalCluster[] = []
  for (const tri of tris) {
    let best: NormalCluster | null = null
    let bestDot = CLUSTER_DOT
    for (const cluster of clusters) {
      const len = Math.sqrt(
        cluster.nx * cluster.nx + cluster.ny * cluster.ny + cluster.nz * cluster.nz,
      )
      if (len < 1e-8) continue
      const dot = (tri.nx * cluster.nx + tri.ny * cluster.ny + tri.nz * cluster.nz) / len
      if (dot > bestDot) {
        bestDot = dot
        best = cluster
      }
    }
    if (best) {
      best.nx += tri.nx * tri.area
      best.ny += tri.ny * tri.area
      best.nz += tri.nz * tri.area
      best.area += tri.area
    } else {
      clusters.push({
        nx: tri.nx * tri.area,
        ny: tri.ny * tri.area,
        nz: tri.nz * tri.area,
        area: tri.area,
      })
    }
  }
  return clusters
}

/** RoofPlaneBasis + the assembly thickness the shell exposed — the roof
 * voxel lane (destruction.ts Phase C2) needs it to size the per-plane
 * pinned grid; buildRafters accepts these unchanged (structural superset). */
export type RoofPlane = RoofPlaneBasis & {
  /** Outer − inner surface offset along the plane normal (metres). */
  thickness: number
}

/** One kept plane's SLAB volume in world terms — the rim-face test's input
 * (unit normal + plane frame, the normal band, and the plane-space polygon
 * in the same re-based frame the RoofPlane carries). Internal. */
type Slab = {
  nx: number
  ny: number
  nz: number
  ax: number
  ay: number
  az: number
  ux: number
  uy: number
  uz: number
  /** Inner/outer surface offsets along the normal (absolute projections). */
  nInner: number
  nOuter: number
  /** Frame re-base offsets (across from eave center, upSlope from eave). */
  midA: number
  minU: number
  /** Plane-space footprint triangles, packed [a,u]×3 (the plane's own). */
  poly: readonly number[]
}

/**
 * Enumerate the sloped planes of a roof node's collected meshes as
 * world-space RoofPlane records (RoofPlaneBasis + thickness — the
 * buildRafters input plus what the voxel lane needs). Flat roofs and pure
 * walls yield an empty array — the caller keeps its volume grid and simply
 * frames nothing.
 *
 * `residual` (optional out-array) receives the shell faces the returned
 * planes do NOT cover, as packed world-space triangles (ax,ay,az,…cz — 9
 * floats per face): faces the pitch gate excludes (near-VERTICAL gable-end
 * triangles) plus sloped faces no kept cluster claimed (MIN_PLANE_AREA
 * slivers). Down-facing tris opposing a kept plane lie on that plane's
 * inner surface — inside its slab — so they never count as residual, and
 * neither does ANY face wholly inside a kept plane's slab volume (fascia,
 * rake caps, overhang soffits — see triInSlab: the plane grid's border
 * cells already trace the rim, and a duplicate trim-toned shell there was
 * the owner-reported WHITE-CUBES-ON-ROOF-EDGES defect). The destruction
 * residual lane voxelizes this set so gable ends stop VANISHING when the
 * merged host mesh hides on first hit.
 */
export function enumerateRoofPlanes(meshes: readonly Mesh[], residual?: number[]): RoofPlane[] {
  const up: Tri[] = []
  const down: Tri[] = []
  const rest: Tri[] | undefined = residual ? [] : undefined
  collectSlopedTris(meshes, up, down, rest)
  if (up.length === 0) {
    // No planes → nothing is covered; every collected face is residual.
    if (residual && rest) fillResidual(residual, rest, up, down, [], [])
    return []
  }

  const upClusters = clusterNormals(up).filter((c) => c.area >= MIN_PLANE_AREA)
  const downClusters = clusterNormals(down)

  // Interior undersides: area-weighted centroids, for thickness pairing.
  const downCentroids = downClusters.map((cluster) => {
    const len = Math.sqrt(
      cluster.nx * cluster.nx + cluster.ny * cluster.ny + cluster.nz * cluster.nz,
    )
    return { nx: cluster.nx / len, ny: cluster.ny / len, nz: cluster.nz / len, x: 0, y: 0, z: 0, area: 0 }
  })
  for (const tri of down) {
    let best = -1
    let bestDot = CLUSTER_DOT
    for (let i = 0; i < downCentroids.length; i++) {
      const c = downCentroids[i]!
      const dot = tri.nx * c.nx + tri.ny * c.ny + tri.nz * c.nz
      if (dot > bestDot) {
        bestDot = dot
        best = i
      }
    }
    if (best < 0) continue
    const c = downCentroids[best]!
    const mx = (tri.v[0] + tri.v[3] + tri.v[6]) / 3
    const my = (tri.v[1] + tri.v[4] + tri.v[7]) / 3
    const mz = (tri.v[2] + tri.v[5] + tri.v[8]) / 3
    c.x += mx * tri.area
    c.y += my * tri.area
    c.z += mz * tri.area
    c.area += tri.area
  }
  for (const c of downCentroids) {
    if (c.area > 0) {
      c.x /= c.area
      c.y /= c.area
      c.z /= c.area
    }
  }

  const planes: RoofPlane[] = []
  /** Unit normals of the KEPT planes, packed x,y,z — residual matching
   * runs the exact complement of the polyTris assignment test below. */
  const keptNormals: number[] = []
  /** The kept planes' slab volumes — the residual RIM-face exclusion. */
  const slabs: Slab[] = []
  for (const cluster of upClusters) {
    const len = Math.sqrt(
      cluster.nx * cluster.nx + cluster.ny * cluster.ny + cluster.nz * cluster.nz,
    )
    if (len < 1e-8) continue
    const nx = cluster.nx / len
    const ny = cluster.ny / len
    const nz = cluster.nz / len
    // Module frame (roof-framing.ts): N = (sinψ·sinθ, cosθ, −cosψ·sinθ).
    const pitch = Math.acos(Math.min(1, Math.max(-1, ny)))
    if (pitch < MIN_PITCH || pitch > MAX_PITCH) continue
    const yaw = Math.atan2(nx, -nz)
    const { across, normal, upSlope } = roofPlaneFrame(yaw, pitch)

    // Re-project every triangle of this orientation onto the plane frame.
    let minA = Number.POSITIVE_INFINITY
    let maxA = Number.NEGATIVE_INFINITY
    let minU = Number.POSITIVE_INFINITY
    let maxU = Number.NEGATIVE_INFINITY
    let nSum = 0
    let nArea = 0
    // Plane-space footprint triangles, packed [a,u]×3 per tri (absolute
    // projections here; re-based to the eave-center frame below).
    const polyTris: number[] = []
    for (const tri of up) {
      if (tri.nx * nx + tri.ny * ny + tri.nz * nz <= CLUSTER_DOT) continue
      for (let k = 0; k < 9; k += 3) {
        const x = tri.v[k]!
        const y = tri.v[k + 1]!
        const z = tri.v[k + 2]!
        const a = x * across[0] + y * across[1] + z * across[2]
        const u = x * upSlope[0] + y * upSlope[1] + z * upSlope[2]
        polyTris.push(a, u)
        if (a < minA) minA = a
        if (a > maxA) maxA = a
        if (u < minU) minU = u
        if (u > maxU) maxU = u
      }
      const mx = (tri.v[0] + tri.v[3] + tri.v[6]) / 3
      const my = (tri.v[1] + tri.v[4] + tri.v[7]) / 3
      const mz = (tri.v[2] + tri.v[5] + tri.v[8]) / 3
      nSum += (mx * normal[0] + my * normal[1] + mz * normal[2]) * tri.area
      nArea += tri.area
    }
    if (nArea <= 0) continue
    const nOuter = nSum / nArea

    // Thickness from the opposing interior cluster (smallest sane gap wins;
    // no interior partner in the shell ⇒ DEFAULT_SHELL_T).
    let thickness = Number.POSITIVE_INFINITY
    for (const c of downCentroids) {
      if (c.area <= 0) continue
      if (c.nx * -nx + c.ny * -ny + c.nz * -nz <= CLUSTER_DOT) continue
      const gap = nOuter - (c.x * normal[0] + c.y * normal[1] + c.z * normal[2])
      if (gap > MIN_SHELL_T && gap < MAX_SHELL_T && gap < thickness) thickness = gap
    }
    if (!Number.isFinite(thickness)) thickness = DEFAULT_SHELL_T

    const midA = (minA + maxA) / 2
    const nInner = nOuter - thickness
    // Re-base the footprint into the RoofPlaneBasis frame: across measured
    // from the eave CENTER, upSlope from the eave — buildRafters clips its
    // rafter lines (and the ridge run) to these triangles.
    for (let k = 0; k < polyTris.length; k += 2) {
      polyTris[k]! -= midA
      polyTris[k + 1]! -= minU
    }
    planes.push({
      yaw,
      pitch,
      eaveCenter: [
        across[0] * midA + upSlope[0] * minU + normal[0] * nInner,
        across[1] * midA + upSlope[1] * minU + normal[1] * nInner,
        across[2] * midA + upSlope[2] * minU + normal[2] * nInner,
      ],
      eaveLength: maxA - minA,
      slopeLength: maxU - minU,
      thickness,
      polyTris,
    })
    keptNormals.push(nx, ny, nz)
    slabs.push({
      nx,
      ny,
      nz,
      ax: across[0],
      ay: across[1],
      az: across[2],
      ux: upSlope[0],
      uy: upSlope[1],
      uz: upSlope[2],
      nInner,
      nOuter,
      midA,
      minU,
      poly: polyTris,
    })
  }
  if (residual && rest) fillResidual(residual, rest, up, down, keptNormals, slabs)
  return planes
}

/** Squared distance from plane-space point (a, u) to segment (x1,y1)-(x2,y2). */
function distSqToSegment(
  a: number,
  u: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq > 0 ? ((a - x1) * dx + (u - y1) * dy) / lenSq : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const px = x1 + dx * t - a
  const py = y1 + dy * t - u
  return px * px + py * py
}

/** True when plane-space point (a, u) lies inside (either winding) or
 * within `pad` of any footprint triangle (packed [a,u]×3 per tri). */
function pointNearPoly(a: number, u: number, poly: readonly number[], pad: number): boolean {
  const padSq = pad * pad
  for (let k = 0; k + 5 < poly.length; k += 6) {
    const x1 = poly[k]!
    const y1 = poly[k + 1]!
    const x2 = poly[k + 2]!
    const y2 = poly[k + 3]!
    const x3 = poly[k + 4]!
    const y3 = poly[k + 5]!
    const c1 = (x2 - x1) * (u - y1) - (y2 - y1) * (a - x1)
    const c2 = (x3 - x2) * (u - y2) - (y3 - y2) * (a - x2)
    const c3 = (x1 - x3) * (u - y3) - (y1 - y3) * (a - x3)
    if ((c1 >= 0 && c2 >= 0 && c3 >= 0) || (c1 <= 0 && c2 <= 0 && c3 <= 0)) return true
    if (
      distSqToSegment(a, u, x1, y1, x2, y2) <= padSq ||
      distSqToSegment(a, u, x2, y2, x3, y3) <= padSq ||
      distSqToSegment(a, u, x3, y3, x1, y1) <= padSq
    )
      return true
  }
  return false
}

/**
 * Index of the first kept plane whose SLAB volume wholly contains the
 * triangle (−1 = none): every vertex's normal offset within
 * [nInner − SLAB_EPS, nOuter + SLAB_EPS] and plane-space (a, u) inside the
 * plane's own footprint polygon dilated by RIM_PAD. Such faces are the
 * assembly's END-CAPS — eave fascia, rake caps, overhang soffits: the
 * roof's RIM. The plane's pinned grid already voxelizes that exact volume
 * (its border cells trace these very faces), so tracing them AGAIN as
 * residual paints a second, trim-toned cube shell OVER the plane's
 * shingle-family border cells — the owner-reported WHITE CUBES along the
 * eaves/rakes of an otherwise dark roof. Gable-end triangles always keep
 * at least one vertex well below the inner surface (they close the attic,
 * not the slab), so they stay residual and keep their siding/trim tone —
 * the vanishing-gable-end fix is untouched. Ties (a tri inside two
 * overlapping hip slabs) break toward the FIRST plane in enumeration
 * order — deterministic.
 */
function slabIndexOf(v: ArrayLike<number>, slabs: readonly Slab[]): number {
  for (let si = 0; si < slabs.length; si++) {
    const s = slabs[si]!
    let inside = true
    for (let k = 0; k < 9; k += 3) {
      const x = v[k]!
      const y = v[k + 1]!
      const z = v[k + 2]!
      const w = x * s.nx + y * s.ny + z * s.nz
      if (w < s.nInner - SLAB_EPS || w > s.nOuter + SLAB_EPS) {
        inside = false
        break
      }
      const a = x * s.ax + y * s.ay + z * s.az - s.midA
      const u = x * s.ux + y * s.uy + z * s.uz - s.minU
      if (!pointNearPoly(a, u, s.poly, RIM_PAD)) {
        inside = false
        break
      }
    }
    if (inside) return si
  }
  return -1
}

/**
 * MEMBER-ASSIGNMENT classifier — the ONE partition rule both the residual
 * enumeration (fillResidual = its complement) and the S1 shell bucketing
 * (assignRoofTrisToMembers) follow. Returns the kept-plane index a world
 * triangle belongs to, or −1 (residual):
 *
 *   - sloped faces (the pitch gate) match a kept normal's CLUSTER_DOT cone
 *     — up tris directly, down tris through their OPPOSITE (an opposing
 *     underside IS its plane's inner surface). Ridge/hip cone ties break
 *     toward the HIGHEST dot — deterministic;
 *   - everything else must lie wholly inside one kept plane's slab volume
 *     (slabIndexOf — the eave/rake/soffit rim end-caps).
 *
 * `nx,ny,nz` is the triangle's unit face normal; `v` its 9 packed world
 * positions.
 */
function planeOfTri(
  nx: number,
  ny: number,
  nz: number,
  v: ArrayLike<number>,
  keptNormals: readonly number[],
  slabs: readonly Slab[],
): number {
  if (slopedPitchOk(Math.abs(ny))) {
    const sign = ny > 0 ? 1 : -1
    let best = -1
    let bestDot = CLUSTER_DOT
    for (let k = 0; k < keptNormals.length; k += 3) {
      const dot =
        sign * (nx * keptNormals[k]! + ny * keptNormals[k + 1]! + nz * keptNormals[k + 2]!)
      if (dot > bestDot) {
        bestDot = dot
        best = k / 3
      }
    }
    if (best >= 0) return best
  }
  return slabIndexOf(v, slabs)
}

/**
 * Append every face the kept planes leave uncovered to `out` (packed world
 * triangles) — exactly the tris planeOfTri assigns to NO member: pitch-gate
 * rejects and cone misses that also sit outside every kept plane's slab
 * volume (rim end-caps are excluded for the already-voxelized reason on
 * slabIndexOf). Push order (rest, up, down) is load-bearing only for
 * bit-stable residual grids across sessions.
 */
function fillResidual(
  out: number[],
  rest: readonly Tri[],
  up: readonly Tri[],
  down: readonly Tri[],
  keptNormals: readonly number[],
  slabs: readonly Slab[],
): void {
  const residual = (tri: Tri) =>
    planeOfTri(tri.nx, tri.ny, tri.nz, tri.v, keptNormals, slabs) < 0
  for (const tri of rest) if (residual(tri)) out.push(...tri.v)
  for (const tri of up) if (residual(tri)) out.push(...tri.v)
  for (const tri of down) if (residual(tri)) out.push(...tri.v)
}

/**
 * Reconstruct a kept plane's Slab volume from its public RoofPlane record.
 * The enumeration builds these inline and discards them; the S1 member-
 * assignment lane needs them again AFTER the fact, and every field is
 * recoverable exactly — eaveCenter was constructed FROM (midA, minU,
 * nInner) in this very frame, so the projections round-trip to float
 * precision (≪ SLAB_EPS). A poly-less plane (external callers) yields a
 * slab that contains nothing — pointNearPoly over an empty polygon is
 * always false.
 */
function slabOfPlane(plane: RoofPlane): Slab {
  const { across, normal, upSlope } = roofPlaneFrame(plane.yaw, plane.pitch)
  const [ex, ey, ez] = plane.eaveCenter
  const nInner = ex * normal[0] + ey * normal[1] + ez * normal[2]
  return {
    nx: normal[0],
    ny: normal[1],
    nz: normal[2],
    ax: across[0],
    ay: across[1],
    az: across[2],
    ux: upSlope[0],
    uy: upSlope[1],
    uz: upSlope[2],
    nInner,
    nOuter: nInner + plane.thickness,
    midA: ex * across[0] + ey * across[1] + ez * across[2],
    minU: ex * upSlope[0] + ey * upSlope[1] + ez * upSlope[2],
    poly: plane.polyTris ?? [],
  }
}

/** One roof family's member surfaces (S1a shell bucketing) — see
 * assignRoofTrisToMembers. */
export type RoofMemberTris = {
  /** buckets[p] = plane p's member surface: WORLD-frame ShellSourceTris
   * (destruction transforms each bucket into its member grid's own shell
   * frame before clipping). */
  buckets: ShellSourceTri[][]
  /** Faces no plane member claims — the residual member's surface (that
   * member stays voxel-only in S1; exposed for the partition pins). */
  residual: ShellSourceTri[]
  /** Host material instances BY REFERENCE, deduped across meshes and
   * geometry groups — ONE table for the whole family (materialIndex on
   * every bucket's tris is family-global). */
  materials: Material[]
}

const _assignNormalMat = new Matrix3()
const _assignV = new Vector3()

/**
 * Bucket every non-glass host triangle of a roof node into exactly ONE
 * plane member — planeOfTri: up-cone CLUSTER_DOT test, opposing-underside
 * test, rim via the slab-volume test — or the residual. An exact, disjoint
 * partition of the collected surface (degenerate zero-area faces are the
 * only drops — the clipper discards them anyway).
 *
 * This bucketing is REQUIRED before clipping (S1a): shell.ts's
 * cellOfTriangle CLAMPS out-of-grid centroids, so a ridge/hip triangle
 * clipped against a sibling plane's grid would misfile into a border cell
 * AND render twice — once per overlapping member shell.
 *
 * Output tris are WORLD-frame (positions + shading normals via the mesh's
 * normal matrix; a normal-less geometry falls back to the geometric face
 * normal), uvs verbatim, materialIndex into the returned family table —
 * the same ShellSourceTri shape destruction's collectShellSourceTris
 * produces, one frame transform earlier.
 */
export function assignRoofTrisToMembers(
  meshes: readonly Mesh[],
  planes: readonly RoofPlane[],
): RoofMemberTris {
  const keptNormals: number[] = []
  const slabs: Slab[] = []
  for (const plane of planes) {
    const { normal } = roofPlaneFrame(plane.yaw, plane.pitch)
    keptNormals.push(normal[0], normal[1], normal[2])
    slabs.push(slabOfPlane(plane))
  }
  const buckets: ShellSourceTri[][] = planes.map(() => [])
  const residual: ShellSourceTri[] = []
  const materials: Material[] = []
  for (const mesh of meshes) {
    if (isGlassLikeMesh(mesh)) continue
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) continue
    const normal = geometry.getAttribute('normal')
    const uv = geometry.getAttribute('uv')
    const index = geometry.getIndex()
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const slotOfMaterial = meshMaterials.map((m) => {
      let slot = materials.indexOf(m)
      if (slot < 0) {
        slot = materials.length
        materials.push(m)
      }
      return slot
    })
    _assignNormalMat.getNormalMatrix(mesh.matrixWorld)
    const vertexCount = index ? index.count : position.count
    const groups =
      geometry.groups.length > 0
        ? geometry.groups
        : [{ start: 0, count: vertexCount, materialIndex: 0 }]
    for (const group of groups) {
      const materialIndex =
        slotOfMaterial[Math.min(group.materialIndex ?? 0, slotOfMaterial.length - 1)] ?? 0
      const end = Math.min(group.start + group.count, vertexCount)
      for (let i = group.start; i + 3 <= end; i += 3) {
        const positions: number[] = []
        const normals: number[] = []
        const uvs: number[] = []
        for (let k = 0; k < 3; k++) {
          const vi = index ? index.getX(i + k) : i + k
          _assignV.fromBufferAttribute(position, vi).applyMatrix4(mesh.matrixWorld)
          positions.push(_assignV.x, _assignV.y, _assignV.z)
          if (normal) {
            _assignV.fromBufferAttribute(normal, vi).applyMatrix3(_assignNormalMat).normalize()
            normals.push(_assignV.x, _assignV.y, _assignV.z)
          }
          if (uv) uvs.push(uv.getX(vi), uv.getY(vi))
          else uvs.push(0, 0)
        }
        // Geometric face normal — the classifier's input (and the shading
        // fallback when the geometry ships no normal attribute).
        const ux = positions[3]! - positions[0]!
        const uy = positions[4]! - positions[1]!
        const uz = positions[5]! - positions[2]!
        const wx = positions[6]! - positions[0]!
        const wy = positions[7]! - positions[1]!
        const wz = positions[8]! - positions[2]!
        const cx = uy * wz - uz * wy
        const cy = uz * wx - ux * wz
        const cz = ux * wy - uy * wx
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz)
        if (len < 1e-8) continue // degenerate — no area, no member
        const fnx = cx / len
        const fny = cy / len
        const fnz = cz / len
        if (normals.length === 0) {
          normals.push(fnx, fny, fnz, fnx, fny, fnz, fnx, fny, fnz)
        }
        const tri: ShellSourceTri = { positions, normals, uvs, materialIndex }
        const p = planeOfTri(fnx, fny, fnz, positions, keptNormals, slabs)
        if (p >= 0) buckets[p]!.push(tri)
        else residual.push(tri)
      }
    }
  }
  return { buckets, residual, materials }
}

/**
 * The material owning the most `accept`ed triangle area (by world face-
 * normal Y) across the shell's material groups (0 Wall/Trim, 1 Deck,
 * 2 Interior, 3 Shingle on host roofs). Null when no accepted face carries
 * a colored material. Exported: destruction.ts feeds the winner into
 * skin-tone.ts's resolveSurfaceTone chain (walls/slabs pick over ALL faces
 * with their own accept gates).
 */
export function dominantMaterialBy(
  meshes: readonly Mesh[],
  accept: (ny: number) => boolean,
): SurfaceMaterialLike | null {
  const areas = new Map<SurfaceMaterialLike, number>()
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (const mesh of meshes) {
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) continue
    const index = geometry.getIndex()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const total = index ? index.count : position.count
    const groups =
      geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: total, materialIndex: 0 }]
    const m = mesh.matrixWorld.elements
    const world = (vi: number, o: number): void => {
      const x = position.getX(vi)
      const y = position.getY(vi)
      const z = position.getZ(vi)
      v[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      v[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      v[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    }
    for (const group of groups) {
      const material = materials[Math.min(group.materialIndex ?? 0, materials.length - 1)] as
        | SurfaceMaterialLike
        | undefined
      if (!material?.color) continue
      const start = group.start
      const end = Math.min(total, group.start + group.count)
      let area = 0
      for (let i = start; i + 2 < end; i += 3) {
        world(index ? index.getX(i) : i, 0)
        world(index ? index.getX(i + 1) : i + 1, 3)
        world(index ? index.getX(i + 2) : i + 2, 6)
        const ux = v[3]! - v[0]!
        const uy = v[4]! - v[1]!
        const uz = v[5]! - v[2]!
        const wx = v[6]! - v[0]!
        const wy = v[7]! - v[1]!
        const wz = v[8]! - v[2]!
        const cx = uy * wz - uz * wy
        const cy = uz * wx - ux * wz
        const cz = ux * wy - uy * wx
        const len = Math.sqrt(cx * cx + cy * cy + cz * cz)
        if (len < 1e-8) continue
        const ny = cy / len
        if (!accept(ny)) continue
        area += len / 2
      }
      if (area > 0) areas.set(material, (areas.get(material) ?? 0) + area)
    }
  }
  let best: SurfaceMaterialLike | null = null
  let bestArea = 0
  for (const [material, area] of areas) {
    if (area > bestArea) {
      bestArea = area
      best = material
    }
  }
  return best
}

/** The roof SURFACE material: dominant over sloped UP-facing area only —
 * the shingle side, never undersides, fascia, or gable-end trim (the fix
 * for the C2 QA defect where targetBaseColor grabbed the FIRST material
 * slot — usually the white Wall/Trim tone — so voxelized roofs rendered
 * white). destruction.ts resolves its tone through skin-tone.ts's chain
 * (thumbnail → GPU readback for compressed KTX2 → non-white base → dark
 * shingle fallback). */
export function dominantSlopedMaterial(meshes: readonly Mesh[]): SurfaceMaterialLike | null {
  return dominantMaterialBy(meshes, (ny) => ny > 0 && slopedPitchOk(ny))
}

/** Dominant material of the shell's RESIDUAL faces — the ones the sloped
 * gate excludes (gable-end triangles, fascia, flat caps). The residual
 * lane tints its gable-end replica with THIS surface's tone instead of the
 * shingle skin: gable ends read as siding/trim, not roofing. */
export function dominantResidualMaterial(meshes: readonly Mesh[]): SurfaceMaterialLike | null {
  return dominantMaterialBy(meshes, (ny) => !slopedPitchOk(Math.abs(ny)))
}

