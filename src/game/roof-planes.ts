import type { Color, Mesh } from 'three'
import { type RoofPlaneBasis, roofPlaneFrame } from './roof-framing'

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
 * Limitations (documented, acceptable for the framing reveal): two
 * DISJOINT coplanar faces of one node merge into one plane (rafters bridge
 * the gap), and triangular hip faces frame with full-length rafter lines
 * (real hips shorten jacks toward the corners) — both invisible until the
 * roof is shot open, both strictly better than no framing.
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

function collectSlopedTris(meshes: readonly Mesh[], up: Tri[], down: Tri[]): void {
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
      if (!slopedPitchOk(Math.abs(ny))) continue
      const tri: Tri = { nx: cx / len, ny, nz: cz / len, area: len / 2, v }
      if (ny > 0) up.push(tri)
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

/**
 * Enumerate the sloped planes of a roof node's collected meshes as
 * world-space RoofPlane records (RoofPlaneBasis + thickness — the
 * buildRafters input plus what the voxel lane needs). Flat roofs and pure
 * walls yield an empty array — the caller keeps its volume grid and simply
 * frames nothing.
 */
export function enumerateRoofPlanes(meshes: readonly Mesh[]): RoofPlane[] {
  const up: Tri[] = []
  const down: Tri[] = []
  collectSlopedTris(meshes, up, down)
  if (up.length === 0) return []

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
    for (const tri of up) {
      if (tri.nx * nx + tri.ny * ny + tri.nz * nz <= CLUSTER_DOT) continue
      for (let k = 0; k < 9; k += 3) {
        const x = tri.v[k]!
        const y = tri.v[k + 1]!
        const z = tri.v[k + 2]!
        const a = x * across[0] + y * across[1] + z * across[2]
        const u = x * upSlope[0] + y * upSlope[1] + z * upSlope[2]
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
    })
  }
  return planes
}

/**
 * Dominant ROOF SURFACE color of the merged shell — the fix for the C2 QA
 * defect where targetBaseColor grabbed the FIRST material slot (usually the
 * white Wall/Trim tone) so voxelized roofs rendered white. The merged CSG
 * mesh carries material groups; the roof surface is whichever material owns
 * the most sloped UP-facing triangle area, so sum that per material slot
 * and return the winner's color (cloned). Returns null when no sloped face
 * carries a colored material — callers keep their existing fallback.
 */
export function roofSurfaceColor(meshes: readonly Mesh[]): Color | null {
  const areas = new Map<Color, number>()
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
      const material = materials[Math.min(group.materialIndex ?? 0, materials.length - 1)]
      const color = (material as { color?: Color } | undefined)?.color
      if (!color) continue
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
        // Sloped and UP-facing only — the shingle side, never undersides,
        // fascia, or gable-end trim.
        if (ny <= 0 || !slopedPitchOk(ny)) continue
        area += len / 2
      }
      if (area > 0) areas.set(color, (areas.get(color) ?? 0) + area)
    }
  }
  let best: Color | null = null
  let bestArea = 0
  for (const [color, area] of areas) {
    if (area > bestArea) {
      bestArea = area
      best = color
    }
  }
  return best ? best.clone() : null
}
