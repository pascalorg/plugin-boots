import {
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  type Texture,
} from 'three'
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
 * triangles, fascia caps, flat soffits) plus sloped faces no kept cluster
 * claimed (MIN_PLANE_AREA slivers). Down-facing tris opposing a kept plane
 * lie on that plane's inner surface — inside its slab — so they never count
 * as residual. The destruction residual lane voxelizes this set so gable
 * ends stop VANISHING when the merged host mesh hides on first hit.
 */
export function enumerateRoofPlanes(meshes: readonly Mesh[], residual?: number[]): RoofPlane[] {
  const up: Tri[] = []
  const down: Tri[] = []
  const rest: Tri[] | undefined = residual ? [] : undefined
  collectSlopedTris(meshes, up, down, rest)
  if (up.length === 0) {
    // No planes → nothing is covered; every collected face is residual.
    if (residual && rest) fillResidual(residual, rest, up, down, [])
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
  }
  if (residual && rest) fillResidual(residual, rest, up, down, keptNormals)
  return planes
}

/**
 * Append every face the kept planes leave uncovered to `out` (packed world
 * triangles): all pitch-gate rejects, up tris outside every kept normal's
 * CLUSTER_DOT cone (the same test that assigns polyTris — exact
 * complement), and down tris whose OPPOSITE misses every kept plane (an
 * opposing underside sits on its plane's inner surface, inside the slab
 * the plane target already voxelizes).
 */
function fillResidual(
  out: number[],
  rest: readonly Tri[],
  up: readonly Tri[],
  down: readonly Tri[],
  keptNormals: readonly number[],
): void {
  const covered = (nx: number, ny: number, nz: number): boolean => {
    for (let k = 0; k < keptNormals.length; k += 3) {
      if (nx * keptNormals[k]! + ny * keptNormals[k + 1]! + nz * keptNormals[k + 2]! > CLUSTER_DOT)
        return true
    }
    return false
  }
  for (const tri of rest) out.push(...tri.v)
  for (const tri of up) if (!covered(tri.nx, tri.ny, tri.nz)) out.push(...tri.v)
  for (const tri of down) if (!covered(-tri.nx, -tri.ny, -tri.nz)) out.push(...tri.v)
}

/** Minimal material slice roofSurfaceColor needs (Mesh['material'] items). */
type MaterialLike = { color?: Color; map?: (Texture & { image?: unknown }) | null }

/**
 * Average color of a material's texture map, sampled through a tiny 2D
 * canvas (browser only — headless test environments simply return null).
 * The host's shingle materials carry their whole look in the MAP with a
 * pure-white base color, so reading `material.color` alone yields white;
 * the 8×8 down-draw average recovers the texture's real tone. Returns null
 * for compressed/undrawable images (callers keep the base color then).
 */
function averageMapColor(material: MaterialLike): Color | null {
  const image = material.map?.image
  if (!image || typeof document === 'undefined') return null
  try {
    const size = 8
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(image as CanvasImageSource, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!
      g += data[i + 1]!
      b += data[i + 2]!
    }
    const n = (data.length / 4) * 255
    // Canvas bytes are sRGB — convert into three's working color space.
    return new Color().setRGB(r / n, g / n, b / n, 'srgb')
  } catch {
    return null
  }
}

/**
 * The material owning the most `accept`ed triangle area (by world face-
 * normal Y) across the shell's material groups (0 Wall/Trim, 1 Deck,
 * 2 Interior, 3 Shingle on host roofs). Null when no accepted face carries
 * a colored material.
 */
function dominantMaterialBy(
  meshes: readonly Mesh[],
  accept: (ny: number) => boolean,
): MaterialLike | null {
  const areas = new Map<MaterialLike, number>()
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
        | MaterialLike
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
  let best: MaterialLike | null = null
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
 * the shingle side, never undersides, fascia, or gable-end trim. */
function dominantSlopedMaterial(meshes: readonly Mesh[]): MaterialLike | null {
  return dominantMaterialBy(meshes, (ny) => ny > 0 && slopedPitchOk(ny))
}

/**
 * Dominant ROOF SURFACE color of the merged shell, resolved SYNCHRONOUSLY —
 * the fix for the C2 QA defect where targetBaseColor grabbed the FIRST
 * material slot (usually the white Wall/Trim tone) so voxelized roofs
 * rendered white. Textured winners (the host shingle slots are white-color
 * + texture) resolve through the map's average tone × base color when the
 * image is canvas-drawable; compressed KTX2 maps can't resolve here — use
 * resolveRoofSkinTone for the async GPU readback that covers them. Returns
 * null when no sloped face carries a colored material — callers keep their
 * existing fallback.
 */
export function roofSurfaceColor(meshes: readonly Mesh[]): Color | null {
  const best = dominantSlopedMaterial(meshes)
  if (!best?.color) return null
  const mapTone = averageMapColor(best)
  return mapTone ? mapTone.multiply(best.color) : best.color.clone()
}

/**
 * Dominant color of the shell's RESIDUAL faces — the ones the sloped gate
 * excludes (gable-end triangles, fascia, flat caps) — resolved the
 * roofSurfaceColor way (base color × canvas map average). The residual
 * lane (destruction.ts) tints its gable-end replica with this instead of
 * the shingle tone: gable ends read as siding/trim, not roofing. Null when
 * no residual face carries a colored material.
 */
export function residualSurfaceColor(meshes: readonly Mesh[]): Color | null {
  const best = dominantMaterialBy(meshes, (ny) => !slopedPitchOk(Math.abs(ny)))
  if (!best?.color) return null
  const mapTone = averageMapColor(best)
  return mapTone ? mapTone.multiply(best.color) : best.color.clone()
}

// ── Async skin tone (compressed shingle textures) ───────────────────────────
// The host's shingle materials ship as KTX2/compressed textures with a pure
// white base color: material.color says nothing and the image is not
// canvas-drawable, so the only truthful source of the roof tone is the GPU.
// voxel-walls.tsx registers the live renderer here (it sits inside the R3F
// canvas); resolveRoofSkinTone then draws the winning map onto a 4×4 render
// target through the renderer's own sampler chain and averages the readback
// — asynchronously, because WebGPU readbacks are promises. destruction.ts
// retints the freshly built plane targets when the tone lands (a frame or
// two after first blood — imperceptible).

/** The renderer surface this module needs (WebGLRenderer AND WebGPURenderer
 * both satisfy it — readback prefers the async API when present). */
export type RoofToneRenderer = {
  getRenderTarget: () => unknown
  setRenderTarget: (target: unknown) => void
  render: (scene: Scene, camera: OrthographicCamera) => unknown
  readRenderTargetPixels?: (
    target: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
    buffer: Uint8Array,
  ) => void
  readRenderTargetPixelsAsync?: (
    target: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => Promise<ArrayBufferView>
}

let roofToneRenderer: RoofToneRenderer | null = null

/** voxel-walls.tsx wires the live renderer in on mount (null on unmount). */
export function setRoofTextureRenderer(renderer: RoofToneRenderer | null): void {
  roofToneRenderer = renderer
}

/** Lazy 4×4 readback rig — one tiny scene reused for every roof texture. */
let toneRig: {
  target: RenderTarget
  scene: Scene
  camera: OrthographicCamera
  material: MeshBasicMaterial
} | null = null

const TONE_RT_SIZE = 4

/** GPU average of a texture through the live renderer. Resolves null when
 * no renderer is registered or the readback fails (headless tests, exotic
 * targets) — callers keep the synchronous color then. */
async function gpuAverageMapColor(map: Texture): Promise<Color | null> {
  const renderer = roofToneRenderer
  if (!renderer) return null
  try {
    if (!toneRig) {
      const scene = new Scene()
      const material = new MeshBasicMaterial()
      scene.add(new Mesh(new PlaneGeometry(2, 2), material))
      toneRig = {
        target: new RenderTarget(TONE_RT_SIZE, TONE_RT_SIZE),
        scene,
        camera: new OrthographicCamera(-1, 1, 1, -1, 0, 1),
        material,
      }
    }
    toneRig.material.map = map
    toneRig.material.needsUpdate = true
    const prior = renderer.getRenderTarget()
    renderer.setRenderTarget(toneRig.target)
    renderer.render(toneRig.scene, toneRig.camera)
    let pixels: ArrayBufferView
    if (renderer.readRenderTargetPixelsAsync) {
      const read = renderer.readRenderTargetPixelsAsync(
        toneRig.target,
        0,
        0,
        TONE_RT_SIZE,
        TONE_RT_SIZE,
      )
      renderer.setRenderTarget(prior)
      pixels = await read
    } else if (renderer.readRenderTargetPixels) {
      const buffer = new Uint8Array(TONE_RT_SIZE * TONE_RT_SIZE * 4)
      renderer.readRenderTargetPixels(toneRig.target, 0, 0, TONE_RT_SIZE, TONE_RT_SIZE, buffer)
      renderer.setRenderTarget(prior)
      pixels = buffer
    } else {
      renderer.setRenderTarget(prior)
      return null
    }
    toneRig.material.map = null
    const data = pixels as unknown as { length: number; [i: number]: number }
    if (!data.length) return null
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i + 2 < data.length; i += 4) {
      r += data[i]!
      g += data[i + 1]!
      b += data[i + 2]!
    }
    // Render targets hold WORKING-SPACE (linear) values — the sRGB map was
    // already decoded by the sampler, so no further conversion here.
    const n = (data.length / 4) * 255
    return new Color(r / n, g / n, b / n)
  } catch {
    return null
  }
}

/** map → resolved average tone (before the base-color multiply). WeakMap:
 * a strong Map would pin every session's shingle Textures (and their CPU
 * image data) for the module lifetime across project jump-ins. */
const toneCache = new WeakMap<Texture, Color>()

/**
 * Resolve the roof surface tone including compressed textures: the
 * synchronous canvas path first, then the cached / freshly-read GPU
 * average. `onTone` fires AT MOST once — synchronously when the tone is
 * already known, or as soon as the GPU readback lands; never when nothing
 * better than roofSurfaceColor's answer exists.
 */
export function resolveRoofSkinTone(meshes: readonly Mesh[], onTone: (tone: Color) => void): void {
  const best = dominantSlopedMaterial(meshes)
  const baseColor = best?.color
  if (!best || !baseColor) return
  const canvasTone = averageMapColor(best)
  if (canvasTone) {
    onTone(canvasTone.multiply(baseColor))
    return
  }
  const map = best.map
  if (!map) return
  const cached = toneCache.get(map)
  if (cached) {
    onTone(cached.clone().multiply(baseColor))
    return
  }
  void gpuAverageMapColor(map).then((tone) => {
    if (!tone) return
    toneCache.set(map, tone.clone())
    onTone(tone.multiply(baseColor))
  })
}
