'use client'

import { useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import {
  type Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  type InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Object3D,
  Path,
  Quaternion,
  RepeatWrapping,
  Shape,
  ShapeGeometry,
  Sphere,
  Vector3,
} from 'three'
import { Craters } from './craters'
import { type GameWorld, pointInPolygonXZ, pointOnRoad, siteGroundYAt } from './world'

/**
 * The lot: a grass field with scattered flora replacing the editor's flat
 * gray void. Optimization first — one InstancedMesh per species (grass:
 * ~20k blade clusters split into GRASS_SECTORS angular chunks so frustum
 * culling can drop off-screen wedges), no shadows, static transforms,
 * all placement rejected out of the building's footprint AND off every
 * hard-surface footprint (Streetscape roads, driveway slabs, parking pads —
 * world.roadFootprints) so no blade pokes through asphalt.
 *
 * The lawn disc itself is NOT cut around roads: roads render at ground +
 * surfaceThickness (>= 0.1 m in every Streetscape preset), well above the
 * disc's y = 0.05, so the pavement fully occludes it — and the disc's hole
 * mechanism only supports a single rectangle fully inside the contour
 * (overlapping / edge-crossing holes break ShapeGeometry triangulation),
 * which arbitrary road ribbons would violate.
 *
 * HOST SITE (world.site): when the scene has a visible site node, the host
 * already renders the lot ground — sculpted terrain or the flat polygon
 * fill — plus its own horizon plate. The boots disc is then suppressed
 * (shouldMountGroundDisc) and every scatter instance clamps to the lot
 * polygon and DRAPES onto the terrain surface height (scatterGroundY).
 */

/** Deterministic RNG so re-entry looks identical. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function groundTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = '#4e7c3a'
  g.fillRect(0, 0, size, size)
  const rand = mulberry32(7)
  g.globalAlpha = 0.28
  for (let i = 0; i < 2600; i++) {
    const shade = 0.82 + rand() * 0.36
    g.fillStyle = `rgb(${Math.round(78 * shade)}, ${Math.round(124 * shade)}, ${Math.round(58 * shade)})`
    const r = 1 + rand() * 3
    g.beginPath()
    g.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(30, 30)
  return texture
}

/**
 * One clump of five tapered blades baked into a single indexed geometry.
 * Each blade is a two-segment strip (root quad + tip triangle) with a
 * baked bend and outward lean. Vertex colors run dark at the root to a
 * light, slightly warm tip and multiply with the per-instance green.
 */
function grassClusterGeometry(): BufferGeometry {
  const rand = mulberry32(5)
  const blades = 5
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI * 2 + rand() * 1.1
    const dirX = Math.cos(angle)
    const dirZ = Math.sin(angle)
    const spread = rand() * 0.05
    const rootX = dirX * spread
    const rootZ = dirZ * spread
    const height = 0.26 + rand() * 0.18
    const half = 0.024 + rand() * 0.012
    const lean = 0.06 + rand() * 0.16
    const sideX = -dirZ * half
    const sideZ = dirX * half
    const midY = height * 0.55
    const midX = rootX + dirX * lean * 0.35
    const midZ = rootZ + dirZ * lean * 0.35
    const base = positions.length / 3
    // biome-ignore format: vertex rows read better unwrapped
    positions.push(
      rootX - sideX, 0, rootZ - sideZ,
      rootX + sideX, 0, rootZ + sideZ,
      midX - sideX * 0.42, midY, midZ - sideZ * 0.42,
      midX + sideX * 0.42, midY, midZ + sideZ * 0.42,
      rootX + dirX * lean, height, rootZ + dirZ * lean,
    )
    // biome-ignore format: one rgb triple per row
    colors.push(
      0.4, 0.45, 0.34,
      0.4, 0.45, 0.34,
      0.78, 0.8, 0.62,
      0.78, 0.8, 0.62,
      1, 1, 0.82,
    )
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3, base + 2, base + 4, base + 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  // All normals point up so blades shade like the ground plane — no dark
  // backfaces, keeps the field reading flat and cartoony.
  const normals = new Float32Array(positions.length)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  return geometry
}

/**
 * Bush cluster — species 4 of the flora pass (low, trunkless). Three
 * overlapping icosahedron blobs baked into ONE geometry (same trick as
 * grassClusterGeometry: detail per instance, still a single draw call).
 * Vertex colors shade each blob a step lighter so the cluster reads as
 * separate lobes; they multiply with the per-instance green.
 */
function bushClusterGeometry(): BufferGeometry {
  const rand = mulberry32(9)
  const blobs: Array<{ x: number; y: number; z: number; r: number; shade: number }> = [
    { x: 0, y: 0.12, z: 0, r: 0.62, shade: 0.92 },
    { x: 0.42, y: 0.02, z: 0.18, r: 0.45, shade: 1.02 },
    { x: -0.3, y: 0.05, z: -0.28, r: 0.4, shade: 1.12 },
  ]
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const blob = new IcosahedronGeometry(1, 1).toNonIndexed()
  const pos = blob.getAttribute('position')
  const nor = blob.getAttribute('normal')
  for (const { x, y, z, r, shade } of blobs) {
    // A touch of per-blob squash + yaw so the lobes don't read as copies.
    const yaw = rand() * Math.PI * 2
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    const squash = 0.72 + rand() * 0.16
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) * r
      const py = pos.getY(i) * r * squash
      const pz = pos.getZ(i) * r
      positions.push(x + px * cos - pz * sin, y + py, z + px * sin + pz * cos)
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i))
      colors.push(shade, shade, shade)
    }
  }
  blob.dispose()
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  return geometry
}

export const GROUND_RADIUS = 95

/** Terrain-less sites render their polygon ground fill at this Y (host
 * SiteRenderer). Scatter on a flat site drapes to exactly this, so the
 * per-kind lifts keep every instance a hair below/above where the y = 0
 * era put them — never sunk under the fill. */
export const SITE_FLAT_GROUND_Y = -0.05

/**
 * Mount the boots lawn disc only when NO visible host site was collected:
 * a site brings its own lot ground (sculpted terrain or the polygon fill)
 * plus an "infinite" horizon plate — the boots disc at y = 0.05 would fight
 * both (the gray-moonscape bug: green disc + y = 0 scatter slicing through
 * the sculpted hill). Pure gate; exported for tests.
 */
export function shouldMountGroundDisc(world: Pick<GameWorld, 'site'>): boolean {
  return !world.site
}

/**
 * The ground Y a scatter instance drapes to at (x, z) — the make callbacks
 * ADD their per-kind lift on top of this base:
 * - no site: 0, the legacy lot plane (behavior byte-identical to before).
 * - terrain site: the analytic surface height when the host core exports it
 *   (SiteSnapshot.surfaceHeightAt), else a downward BVH probe of the site
 *   colliders. Real heights pass through UNclamped — flora follows the bank
 *   down into an excavated yard, exactly like the rendered surface does.
 * - flat site: the polygon fill plane at −0.05 (probe result clamped up to
 *   it so numeric noise can never sink an instance under the fill).
 * Pure over its inputs; exported for the drape tests.
 */
export function scatterGroundY(
  world: Pick<GameWorld, 'site' | 'colliders'>,
  x: number,
  z: number,
): number {
  const site = world.site
  if (!site) return 0
  if (site.surfaceHeightAt) return site.surfaceHeightAt(x, z)
  if (!site.hasTerrain) {
    const probed = siteGroundYAt(world, x, z)
    return Math.max(SITE_FLAT_GROUND_Y, probed ?? SITE_FLAT_GROUND_Y)
  }
  return siteGroundYAt(world, x, z) ?? SITE_FLAT_GROUND_Y
}

/** The lawn hole may reach this far from the disc center per axis: the
 * disc's inscribed square at a 0.95 safety — a rect whose CORNERS stay
 * within 0.95 × GROUND_RADIUS can never cross the outer contour (which
 * would break ShapeGeometry triangulation). */
export const GROUND_HOLE_LIMIT = (GROUND_RADIUS * 0.95) / Math.SQRT2

/**
 * The lawn hole rect in the disc's local shape space (x = world x, y =
 * −world z, both about the building center), or null with no building.
 * CLAMPED per axis to GROUND_HOLE_LIMIT — never skipped: the pre-2026-08-29
 * code dropped the hole entirely whenever the rect overflowed the disc, so
 * a big building rendered GRASS under its whole footprint and every floor
 * breach showed lawn instead of earth. The rect always straddles the local
 * origin (it surrounds the building center), so clamping keeps a valid,
 * strictly-inside hole. Pure; exported for tests.
 */
export function groundHoleRect(
  aabb: Box3,
): { x0: number; x1: number; y0: number; y1: number } | null {
  if (aabb.isEmpty()) return null
  const center = aabb.getCenter(new Vector3())
  const pad = 1
  const clamp = (v: number) => Math.min(GROUND_HOLE_LIMIT, Math.max(-GROUND_HOLE_LIMIT, v))
  return {
    x0: clamp(aabb.min.x - pad - center.x),
    x1: clamp(aabb.max.x + pad - center.x),
    y0: clamp(center.z - (aabb.max.z + pad)),
    y1: clamp(center.z - (aabb.min.z - pad)),
  }
}

/**
 * The lawn disc with the building footprint CUT OUT of it (AABB + 1 m
 * margin): host slabs sit on the same ground plane, and any lawn surface
 * running under them z-fights their bottom faces from grazing angles. A
 * hole in the geometry kills that coplanar pair by construction — no
 * offset tuning, nothing rendered where the building stands. Oversized
 * footprints clamp to the disc (groundHoleRect) instead of forfeiting the
 * hole. Exported for tests.
 */
export function groundGeometry(world: Pick<GameWorld, 'buildingAabb'>): BufferGeometry {
  const shape = new Shape()
  shape.absarc(0, 0, GROUND_RADIUS, 0, Math.PI * 2, false)
  const rect = groundHoleRect(world.buildingAabb)
  if (rect) {
    // Shape space is the disc's local XY; the mesh rotates -PI/2 about X,
    // so local (x, y) lands at world (x, -z) around the building center.
    const hole = new Path()
    hole.moveTo(rect.x0, rect.y0)
    hole.lineTo(rect.x1, rect.y0)
    hole.lineTo(rect.x1, rect.y1)
    hole.lineTo(rect.x0, rect.y1)
    hole.closePath()
    shape.holes.push(hole)
  }
  const geometry = new ShapeGeometry(shape, 48)
  // ShapeGeometry UVs are raw meters — normalize to [0, 1] across the disc
  // so the shared grass texture keeps its CircleGeometry-era repeat grain.
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / (GROUND_RADIUS * 2) + 0.5, uv.getY(i) / (GROUND_RADIUS * 2) + 0.5)
  }
  return geometry
}

export type Scatter = { matrices: Matrix4[]; colors: Color[] }

// ── Static-field discipline (idle perf 2026-08-29) ─────────────────────────
// The flora fields never move after mount, but they used to render with
// frustumCulled OFF (the shared cluster geometry's own bounding sphere is
// one clump, not the field) and with three recomposing their matrices every
// frame. Each field now carries a correct mesh.boundingSphere over its
// actual instance spread (scatterBoundingSphere) with culling ON, freezes
// its Object3D matrices (freezeStaticObject), and GRASS — the one field big
// enough to matter on the GPU (20k clusters ≈ 300k tris) — splits into
// GRASS_SECTORS angular chunks around the building so looking away culls
// most of the blades. Craters clearing keeps working per chunk: every chunk
// registers as its own scatter field.

/** Angular grass chunks — one InstancedMesh each. 8 keeps the added object
 * count trivial while a typical FPS view culls roughly half the sectors. */
export const GRASS_SECTORS = 8

/** Bounding-sphere margin (m) over instance ORIGINS — covers the biggest
 * scaled cluster geometry any field uses (grass ≈ 1.4 m tips, bush lobes
 * ≈ 1.2 m) with room to spare. */
export const FIELD_MARGIN = 2.5

/** Split one scatter into `sectors` angular chunks about (cx, cz). Instance
 * order inside a chunk keeps the source order; every (matrix, color) pair
 * travels together. Chunks may be empty (footprint/road rejection). */
export function sectorizeScatter(data: Scatter, cx: number, cz: number, sectors: number): Scatter[] {
  const out: Scatter[] = Array.from({ length: sectors }, () => ({ matrices: [], colors: [] }))
  for (let i = 0; i < data.matrices.length; i++) {
    const e = data.matrices[i]!.elements
    const angle = Math.atan2(e[14]! - cz, e[12]! - cx) // [-PI, PI]
    let k = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * sectors)
    if (k >= sectors) k = sectors - 1 // angle === +PI lands on the seam
    if (k < 0) k = 0
    out[k]!.matrices.push(data.matrices[i]!)
    out[k]!.colors.push(data.colors[i]!)
  }
  return out
}

/** World-space bounding sphere over a scatter's instance origins plus
 * FIELD_MARGIN-style padding. Cleared (zero-scale) instances park at the
 * origin outside the sphere — they emit no fragments, so culling stays
 * correct. Empty scatters get three's empty-sphere (radius −1 = culled). */
export function scatterBoundingSphere(
  matrices: Matrix4[],
  margin: number,
  out = new Sphere(),
): Sphere {
  if (matrices.length === 0) {
    out.center.set(0, 0, 0)
    out.radius = -1
    return out
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const matrix of matrices) {
    const e = matrix.elements
    const x = e[12]!
    const y = e[13]!
    const z = e[14]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  out.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
  out.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + margin
  return out
}

/** Opt a never-moving object out of three's per-frame matrix churn. Safe to
 * re-run (re-entry re-attaches refs): flips auto-update back on for one
 * settle pass, then freezes. Frozen ancestors keep their (already frozen,
 * already correct) world matrices — updateWorldMatrix skips them. */
export function freezeStaticObject(obj: Object3D): void {
  obj.matrixAutoUpdate = true
  obj.matrixWorldAutoUpdate = true
  obj.updateWorldMatrix(true, false)
  obj.matrixAutoUpdate = false
  obj.matrixWorldAutoUpdate = false
}

/**
 * Deterministic ring scatter around the building, rejecting the footprint
 * (+ pad) and every hard-surface footprint (roads, driveways, pads) with a
 * 0.3 m clearance margin. `make` fills the matrix and returns the instance
 * color; it may also record placements into its own side arrays —
 * trees-destruct.tsx does exactly that to build combat trees on the same
 * layout (so trees stay off the road too). Exported so flora placement
 * stays one algorithm across modules.
 *
 * Host-site rules (world.site — no site means neither applies):
 * - CLAMP: samples outside the lot polygon are rejected — with the boots
 *   disc suppressed, anything past the polygon would float over the host's
 *   horizon plate.
 * - DRAPE: `position.y` arrives at the make callback PRE-SET to the terrain
 *   surface height at (x, z) (scatterGroundY); callbacks ADD their per-kind
 *   lift (`position.y += lift`) instead of assigning an absolute Y.
 */
export function scatter(
  world: GameWorld,
  seed: number,
  count: number,
  rMin: number,
  rMax: number,
  make: (rand: () => number, position: Vector3, matrix: Matrix4, t: number) => Color,
  bias = 0.5,
): Scatter {
  const rand = mulberry32(seed)
  const center = world.buildingAabb.isEmpty()
    ? new Vector3()
    : world.buildingAabb.getCenter(new Vector3())
  const pad = 1.6
  const min = world.buildingAabb.min
  const max = world.buildingAabb.max
  const matrices: Matrix4[] = []
  const colors: Color[] = []
  const position = new Vector3()
  let guard = count * 6
  while (matrices.length < count && guard-- > 0) {
    const angle = rand() * Math.PI * 2
    const radius = rMin + (rMax - rMin) * rand() ** bias
    position.set(center.x + Math.cos(angle) * radius, 0, center.z + Math.sin(angle) * radius)
    if (
      !world.buildingAabb.isEmpty() &&
      position.x > min.x - pad &&
      position.x < max.x + pad &&
      position.z > min.z - pad &&
      position.z < max.z + pad
    ) {
      continue
    }
    // No flora on pavement: roads, driveways, parking pads (default margin
    // keeps blades clear of the kerb line, not just the centerline).
    if (pointOnRoad(world.roadFootprints, position.x, position.z)) continue
    // On-lot only when a host site exists (see the doc block above). A
    // degenerate polygon (< 3 points — "inside" is meaningless) skips the
    // clamp rather than rejecting the entire field.
    if (
      world.site &&
      world.site.polygon.length >= 3 &&
      !pointInPolygonXZ(world.site.polygon, position.x, position.z)
    ) {
      continue
    }
    // Drape onto the lot surface (0 without a site — same plane as ever).
    position.y = scatterGroundY(world, position.x, position.z)
    const matrix = new Matrix4()
    const t = rMax > rMin ? (radius - rMin) / (rMax - rMin) : 0
    colors.push(make(rand, position, matrix, t))
    matrices.push(matrix)
  }
  return { matrices, colors }
}

function setInstances(mesh: InstancedMesh | null, data: Scatter, storage: boolean): void {
  if (!mesh) return
  // Version-gated instance uploads on WebGPU (voxel-walls.tsx's
  // markStorageInstanced — inlined here because importing voxel-walls would
  // cycle through destruction → craters → nature): without the flag, small
  // fields ride the uniform-buffer path the renderer re-uploads EVERY frame.
  // Sticky on the attribute, so a re-attach re-running this is a no-op.
  if (storage) {
    ;(
      mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean }
    ).isStorageInstancedBufferAttribute = true
  }
  for (let i = 0; i < data.matrices.length; i++) {
    mesh.setMatrixAt(i, data.matrices[i]!)
    mesh.setColorAt(i, data.colors[i]!)
  }
  mesh.count = data.matrices.length
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  // Static-field discipline: a real sphere over the actual spread (the
  // shared cluster geometry's own sphere is one clump), culling ON, and no
  // per-frame matrix recompose for a field that never moves.
  mesh.boundingSphere = scatterBoundingSphere(data.matrices, FIELD_MARGIN, mesh.boundingSphere ?? undefined)
  mesh.frustumCulled = true
  freezeStaticObject(mesh)
}

// --- Clearable scatter fields (craters strip blades) ---------------------------

/** A live instanced field (grass, flowers) that ground scars can clear. */
type ScatterField = { mesh: InstancedMesh; matrices: Matrix4[] }

const scatterFields = new Set<ScatterField>()

/**
 * Register an instanced field for radius clearing; returns the
 * unregister. The component refs below call this — exported so headless
 * tests can wire a field without rendering.
 */
export function registerScatterField(mesh: InstancedMesh, matrices: Matrix4[]): () => void {
  const field: ScatterField = { mesh, matrices }
  scatterFields.add(field)
  return () => {
    scatterFields.delete(field)
  }
}

/** Registered field count (tests/debug). */
export function scatterFieldCount(): number {
  return scatterFields.size
}

const _clearedMatrix = new Matrix4().makeScale(0, 0, 0)

/**
 * Zero-scale every registered instance within r of (x, z) — craters.tsx
 * calls this once per detonation (O(instances) per call, never per
 * frame). Instanced attributes are rebuilt from `matrices` whenever a
 * mesh re-attaches, so the source matrices are zeroed too: a cleared
 * blade stays cleared for the session. Returns how many were cleared.
 */
export function clearScatterInRadius(x: number, z: number, r: number): number {
  const rSq = r * r
  let cleared = 0
  for (const field of scatterFields) {
    const { mesh, matrices } = field
    let touched = false
    for (let i = 0; i < matrices.length; i++) {
      const e = matrices[i]!.elements
      // Already cleared — a zero-scale matrix parks at the origin; skip it
      // so a crater near (0, 0) never double-counts dead blades.
      if (e[0] === 0 && e[5] === 0 && e[10] === 0) continue
      const dx = e[12]! - x
      const dz = e[14]! - z
      if (dx * dx + dz * dz > rSq) continue
      matrices[i]!.copy(_clearedMatrix)
      mesh.setMatrixAt(i, _clearedMatrix)
      touched = true
      cleared++
    }
    if (touched) mesh.instanceMatrix.needsUpdate = true
  }
  return cleared
}

/**
 * Ref factory: attach = upload instances + register the field for
 * clearing; detach = unregister. Memoized per Scatter in the component so
 * React doesn't churn the registration on unrelated renders.
 */
function fieldRef(data: Scatter, storage: boolean): (mesh: InstancedMesh | null) => void {
  let unregister: (() => void) | null = null
  return (mesh) => {
    unregister?.()
    unregister = null
    if (mesh) {
      setInstances(mesh, data, storage)
      unregister = registerScatterField(mesh, data.matrices)
    }
  }
}

const GRASS_A = new Color('#79b054')
const GRASS_B = new Color('#55853c')
/** One shared material for every grass chunk (module-lifetime, passed via
 * `args` like the voxel-wall layer materials — R3F never auto-disposes it,
 * and all chunks keep hitting the same warm pipeline). */
const GRASS_MATERIAL = new MeshStandardMaterial({ roughness: 1, side: DoubleSide, vertexColors: true })
const FLOWER_WHITE = new Color('#f6f3e7')
const FLOWER_YELLOW = new Color('#f2c14e')
const _quat = new Quaternion()
const _scale = new Vector3()
const _yAxis = new Vector3(0, 1, 0)

export function Nature({ world }: { world: GameWorld }) {
  const gl = useThree((s) => s.gl)
  // Storage-flagged instance buffers are WebGPU-only (see setInstances).
  const storage =
    (gl as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend === true

  const texture = useMemo(groundTexture, [])

  // Host ground wins: with a visible site collected, the lot already has its
  // ground (terrain or polygon fill) + horizon — the disc is not even built.
  const groundGeo = useMemo(
    () => (shouldMountGroundDisc(world) ? groundGeometry(world) : null),
    [world],
  )

  const grassGeometry = useMemo(grassClusterGeometry, [])

  const flowerGeometry = useMemo(() => new CircleGeometry(1, 7).rotateX(-Math.PI / 2), [])

  const bushGeometry = useMemo(bushClusterGeometry, [])

  const grass = useMemo(
    () =>
      // Bias 0.72 packs clumps denser near the building; the distance term
      // scales far clumps up so the field stays covered where it thins out.
      scatter(
        world,
        11,
        20000,
        2,
        55,
        (rand, position, matrix, t) => {
          _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
          const s = (0.75 + rand() * 0.5) * (1 + t * 0.9)
          _scale.set(s, s * (0.8 + rand() * 0.5), s)
          matrix.compose(position, _quat, _scale)
          return GRASS_A.clone().lerp(GRASS_B, rand())
        },
        0.72,
      ),
    [world],
  )

  const flowers = useMemo(
    () =>
      scatter(world, 67, 260, 3, 42, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        const s = 0.05 + rand() * 0.045
        _scale.set(s, 1, s)
        position.y += 0.07 + rand() * 0.1 // lift ON TOP of the draped ground
        matrix.compose(position, _quat, _scale)
        return (rand() < 0.42 ? FLOWER_YELLOW : FLOWER_WHITE).clone()
      }),
    [world],
  )

  // Trees moved to trees-destruct.tsx: they are combat targets now (voxel
  // fell / burn / char / stump), so the module that damages them owns their
  // instances. Same scatter algorithm + seed, so the grove looks identical.

  const bushes = useMemo(
    () =>
      scatter(world, 37, 70, 4, 45, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        _scale.set(0.5 + rand() * 0.6, 0.35 + rand() * 0.3, 0.5 + rand() * 0.6)
        position.y += 0.15 // lift ON TOP of the draped ground
        matrix.compose(position, _quat, _scale)
        return new Color('#54804a').offsetHSL(0, 0, (rand() - 0.5) * 0.1)
      }),
    [world],
  )

  const rocks = useMemo(
    () =>
      scatter(world, 51, 24, 6, 50, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        _scale.set(0.25 + rand() * 0.5, 0.18 + rand() * 0.3, 0.25 + rand() * 0.5)
        position.y += 0.08 // lift ON TOP of the draped ground
        matrix.compose(position, _quat, _scale)
        return new Color('#8d8d86').offsetHSL(0, 0, (rand() - 0.5) * 0.08)
      }),
    [world],
  )

  const center = world.buildingAabb.isEmpty()
    ? new Vector3()
    : world.buildingAabb.getCenter(new Vector3())

  // Grass splits into angular sectors so its bounding spheres can actually
  // cull (one 55 m-radius field never leaves the frustum; a 45° wedge does).
  const grassChunks = useMemo(
    () => sectorizeScatter(grass, center.x, center.z, GRASS_SECTORS),
    // center derives from world (the grass memo key) — no drift possible.
    [grass, center.x, center.z],
  )

  // Grass + flowers are clearable fields (craters strip the blades they
  // cover); bushes/rocks survive a blast, so they bind the plain way.
  const grassChunkRefs = useMemo(
    () => grassChunks.map((chunk) => fieldRef(chunk, storage)),
    [grassChunks, storage],
  )
  const flowersRef = useMemo(() => fieldRef(flowers, storage), [flowers, storage])

  return (
    <group userData={{ __boots: true }}>
      {/* y 0.05 clears host slab tops; the footprint hole (groundGeometry)
          keeps the lawn from ever running under the building. Suppressed
          entirely when a host site owns the ground (shouldMountGroundDisc). */}
      {groundGeo && (
        <mesh geometry={groundGeo} position={[center.x, 0.05, center.z]} rotation={[-Math.PI / 2, 0, 0]}>
          {texture ? (
            <meshStandardMaterial map={texture} roughness={1} />
          ) : (
            <meshStandardMaterial color="#4e7c3a" roughness={1} />
          )}
        </mesh>
      )}

      {/* Grass sectors: shared geometry + module material, one chunk per
          45° wedge — each culls against its own scatterBoundingSphere. */}
      {grassChunks.map(
        (chunk, sector) =>
          chunk.matrices.length > 0 && (
            <instancedMesh
              args={[grassGeometry, GRASS_MATERIAL, chunk.matrices.length]}
              // biome-ignore lint/suspicious/noArrayIndexKey: sectors are positional by construction
              key={sector}
              ref={grassChunkRefs[sector]}
            />
          ),
      )}

      {/* Flower dots: flat discs floating in the blade layer for charm. */}
      <instancedMesh args={[flowerGeometry, undefined, flowers.matrices.length]} ref={flowersRef}>
        <meshStandardMaterial roughness={1} />
      </instancedMesh>

      {/* Bushes: baked three-lobe clusters (species 4 — low, trunkless). */}
      <instancedMesh
        args={[bushGeometry, undefined, bushes.matrices.length]}
        ref={(mesh) => setInstances(mesh, bushes, storage)}
      >
        <meshStandardMaterial roughness={1} vertexColors />
      </instancedMesh>

      <instancedMesh
        args={[undefined, undefined, rocks.matrices.length]}
        ref={(mesh) => setInstances(mesh, rocks, storage)}
      >
        <icosahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>

      {/* Blast scars live with the lawn — same mount, same teardown. */}
      <Craters />
    </group>
  )
}
