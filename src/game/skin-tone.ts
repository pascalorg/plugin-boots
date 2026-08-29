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

/**
 * The skin-tone pipeline: how every voxel replica finds its color.
 *
 * Two halves live here:
 *
 *   1. primedCellColor — the per-cell PRIMED skin color (voxel-walls.tsx's
 *      primeSkin math, extracted as a shared pure helper so paint.tsx can
 *      feather coats FROM the true base tone a cell was primed with).
 *   2. resolveSurfaceTone — the ONE tone-resolution chain every target
 *      kind funnels through at voxelize time, with the audit + retry
 *      machinery that guarantees no replica ever renders the untextured
 *      default white (see the FALLBACK CHAIN section below).
 *
 * primedCellColor must stay bit-identical to what primeSkin writes:
 *
 *   - item targets (cellColors): the sampled per-voxel sub-mesh tone
 *   - slab sandwiches: bottom skin (grid Y = 0) lightens toward drywall;
 *     FLOOR-family slabs (floorCore) paint every under-layer as dirt
 *     subfloor instead (FLOOR_CORE_HEX)
 *   - roof planes: inner skin (grid Z ≠ 0) pales toward bare deck; outer
 *     skin stripes every ~3rd up-slope row darker (shingle courses) and
 *     jitters harder (per-shingle scatter)
 *   - everything wears the two-hash value/saturation jitter on top
 *
 * voxel-walls.tsx should call this from its prime loop instead of keeping
 * a private copy (manager wiring — the extraction diff ships with the
 * spray lane's report). Pure math + module scratch: zero allocations per
 * call, safe inside frame loops.
 */

/** The VoxelTarget subset the tone math reads (structural — destruction's
 * VoxelTarget satisfies it directly). The optional grid dimensions only
 * matter when `toneGrid` is present (the per-cell PATTERN lane needs cell
 * sizes to place each cell on the texture). */
export type SkinToneSource = {
  kind: 'wall' | 'slab' | 'volume' | 'roof'
  baseColor: Color
  /** FLOOR-family slab (nodeType slab/floor, never ceiling): every layer
   * under the walking surface — the bottom skin and the rim middles — reads
   * as DIRT SUBFLOOR (FLOOR_CORE_HEX) instead of lightened drywall, so a
   * carved floor shows earth, never white (owner wave 5). Needs grid.ny to
   * tell the top layer apart. */
  floorCore?: boolean
  /** Per-voxel RGB, 3 floats per index (item silhouette lane). */
  cellColors?: Float32Array
  /** The surface texture's CPU color grid (mapPatternGrid) — when present,
   * cells sample the PATTERN (brick courses, shingle rows) instead of the
   * one flat baseColor. */
  toneGrid?: ToneGrid | null
  grid: {
    coords: Int16Array
    cellX?: number
    cellY?: number
    cellZ?: number
    nx?: number
    ny?: number
    nz?: number
  }
}

const _cellTone = new Color()
const _derived = new Color()
const _pattern = new Color()

/** Dirt-subfloor core tone for FLOOR-family slabs: what a carved floor
 * reveals (bottom skin + rim middles) — warm earth brown, kind-based by
 * design (the host has no "subfloor" material to sample). Owner wave 5:
 * "should be wood floor, or dirt when broken — not white". */
export const FLOOR_CORE_HEX = '#6b4a2f'
const FLOOR_CORE = new Color(FLOOR_CORE_HEX)

/**
 * Write cell `i`'s primed skin color into `out` and return it. Mirrors
 * primeSkin exactly: tone pick (cellColors / texture-pattern sample /
 * slab ceiling / roof deck + course striping) then the deterministic
 * per-cell jitter — a value spread plus a whisper of saturation drift so
 * voxel runs never band flat.
 *
 * PATTERN lane: when the target carries a toneGrid (its surface texture's
 * CPU color grid), the cell's tone comes from the texture at the cell's
 * own (u,v) — see cellPatternTone — and the kind modifiers (ceiling
 * lighten, deck pale, course stripe) apply RELATIVE to that sample, so
 * the skins wear brick courses and shingle rows instead of one averaged
 * tone. Without a toneGrid the math is bit-identical to the original
 * flat-baseColor loop (paint.tsx feathers coats from exactly these tones).
 */
export function primedCellColor(out: Color, wall: SkinToneSource, i: number): Color {
  const j1 = ((i * 2654435761) % 97) / 97
  const j2 = ((i * 1597334677) % 89) / 89
  const cellColors = wall.cellColors
  let tone: Color = wall.baseColor
  if (!cellColors && wall.toneGrid) {
    tone = cellPatternTone(_pattern, wall, i) ?? wall.baseColor
  }
  let base: Color = tone
  let jitter = 0.1
  if (cellColors) {
    // Item palette (destruction.ts sampleItemCellColors): each voxel wears
    // its sub-mesh region tone; keep the gentle wall jitter below.
    base = _cellTone.setRGB(cellColors[i * 3]!, cellColors[i * 3 + 1]!, cellColors[i * 3 + 2]!)
  } else if (
    wall.kind === 'slab' &&
    wall.floorCore === true &&
    wall.grid.coords[i * 3 + 1]! < (wall.grid.ny ?? 1) - 1
  ) {
    // FLOOR slab under-layers (bottom skin + rim middles, everything below
    // the top walking layer): dirt subfloor — carving the floor reveals
    // earth, never drywall white. Kind-based constant (owner wave 5).
    base = FLOOR_CORE
  } else if (wall.kind === 'slab' && wall.grid.coords[i * 3 + 1] === 0) {
    // Bottom skin — the ceiling face a player looks up at — renders as
    // slightly lighter, desaturated drywall.
    base = _derived.copy(tone).offsetHSL(0, -0.06, 0.14)
  } else if (wall.kind === 'roof') {
    if (wall.grid.coords[i * 3 + 2] !== 0) {
      // Inner skin: the underside seen from the attic — pale bare deck.
      base = _derived.copy(tone).offsetHSL(0, -0.08, 0.16)
    } else {
      // Outer skin: every ~3rd in-plane row (grid Y = up the slope)
      // darkens slightly — the shingle course striping.
      base =
        wall.grid.coords[i * 3 + 1]! % 3 === 2 ? _derived.copy(tone).offsetHSL(0, 0, -0.055) : tone
      jitter = 0.16
    }
  }
  return out.copy(base).offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * jitter)
}

// ── Per-cell texture patterns (stage 2: "the same texture", not one tone) ───
// A voxel replica should carry the host surface's PATTERN — brick courses,
// shingle rows — not one averaged tone. Whenever the tone chain has a
// readable albedo source (CPU-readable image or the GPU readback), the
// SAME pixels also build a small ToneGrid (TONE_GRID_SIZE² working-space
// RGB), cached per texture (bounded LRU). primeSkin then samples it per
// cell through cellPatternTone: the cell's (u,v) on its face derives from
// GRID INDICES (never per-frame math) and tiles at a plausible world scale
// (SKIN_TILE_M per texture repeat) rather than the host's exact UVs — an
// approximation, but the pattern READ is what matters at voxel size, and
// it works uniformly for walls, slabs and pitched roof planes. Sampling
// happens at voxelize/prime time only; zero per-frame work.

/** A texture's CPU color grid: size² texels, working-space RGB packed
 * 3 floats per texel, row-major with v=0 at the TOP row (image order). */
export type ToneGrid = { size: number; rgb: Float32Array }

/** Texels per side of a pattern grid (32² ≈ 12 KB as floats — tiny). */
export const TONE_GRID_SIZE = 32

/** World metres per texture repeat on voxel skins (~one brick-course
 * palette or shingle row block per 1.2 m — the plausible-scale constant;
 * host UV scales aren't recoverable from the merged meshes). */
export const SKIN_TILE_M = 1.2

/** Pattern grids kept alive (LRU, keyed by texture uuid). */
const TONE_GRID_CACHE_MAX = 24

const toneGridCache = new Map<string, ToneGrid>()

/** Entries currently cached (tests + QA introspection). */
export function patternGridCacheSize(): number {
  return toneGridCache.size
}

const _gridTexel = new Color()

/** Alpha below this marks a texel as a HOLE (thumbnail margins, webp
 * transparency) — its color bytes are garbage (white or premultiplied
 * black), never a shingle/brick tone. */
const OPAQUE_ALPHA = 128

/** Backfill hole texels with their nearest OPAQUE neighbor's tone
 * (expanding Chebyshev rings, first hit wins — always an ORIGINAL opaque
 * texel, never a previously-backfilled hole). cellPatternTone tiles v=0
 * straight onto a roof's eave-row cells, so a transparent/white image
 * margin sampled as-is would dress every EDGE cell in a lie while the
 * field reads true. Voxelize-time only (grid build), size² ≤ 32². */
function backfillHoleTexels(rgb: Float32Array, size: number, holes: number[]): void {
  const hole = new Uint8Array(size * size)
  for (const h of holes) hole[h] = 1
  for (const h of holes) {
    const hx = h % size
    const hy = (h - hx) / size
    let done = false
    for (let r = 1; r < size && !done; r++) {
      for (let dy = -r; dy <= r && !done; dy++) {
        const y = hy + dy
        if (y < 0 || y >= size) continue
        // Ring cells only: full row at the top/bottom edges, ends otherwise.
        const stepX = Math.abs(dy) === r ? 1 : 2 * r
        for (let dx = -r; dx <= r; dx += stepX) {
          const x = hx + dx
          if (x < 0 || x >= size) continue
          const o = y * size + x
          if (hole[o]) continue
          rgb[h * 3] = rgb[o * 3]!
          rgb[h * 3 + 1] = rgb[o * 3 + 1]!
          rgb[h * 3 + 2] = rgb[o * 3 + 2]!
          done = true
          break
        }
      }
    }
  }
}

/** Pure: resample RGBA pixels into a ToneGrid (nearest texel, sRGB decode
 * when the source bytes are sRGB — GPU readbacks are already linear).
 * Near-transparent texels backfill from their nearest opaque neighbor
 * (backfillHoleTexels) so image margins never masquerade as pattern. */
function toneGridFromPixels(pixels: MapPixels): ToneGrid {
  const size = TONE_GRID_SIZE
  const rgb = new Float32Array(size * size * 3)
  const holes: number[] = []
  const { data, width, height, srgb } = pixels
  for (let gy = 0; gy < size; gy++) {
    const sy = Math.min(height - 1, Math.floor(((gy + 0.5) / size) * height))
    for (let gx = 0; gx < size; gx++) {
      const sx = Math.min(width - 1, Math.floor(((gx + 0.5) / size) * width))
      const s = (sy * width + sx) * 4
      const o = (gy * size + gx) * 3
      if ((data[s + 3] ?? 255) < OPAQUE_ALPHA) holes.push(gy * size + gx)
      if (srgb) {
        _gridTexel.setRGB(data[s]! / 255, data[s + 1]! / 255, data[s + 2]! / 255, 'srgb')
        rgb[o] = _gridTexel.r
        rgb[o + 1] = _gridTexel.g
        rgb[o + 2] = _gridTexel.b
      } else {
        rgb[o] = data[s]! / 255
        rgb[o + 1] = data[s + 1]! / 255
        rgb[o + 2] = data[s + 2]! / 255
      }
    }
  }
  // A fully-transparent image has no truth to copy — keep the raw read.
  if (holes.length > 0 && holes.length < size * size) backfillHoleTexels(rgb, size, holes)
  return { size, rgb }
}

/** Mean tone of a grid (working space) — the average the tone chain hands
 * out; deriving it FROM the grid keeps the two views of one texture
 * consistent by construction. */
function toneGridAverage(grid: ToneGrid): Color {
  let r = 0
  let g = 0
  let b = 0
  const texels = grid.size * grid.size
  for (let i = 0; i < texels * 3; i += 3) {
    r += grid.rgb[i]!
    g += grid.rgb[i + 1]!
    b += grid.rgb[i + 2]!
  }
  return new Color(r / texels, g / texels, b / texels)
}

function cacheToneGrid(map: object, grid: ToneGrid): void {
  const uuid = (map as { uuid?: unknown }).uuid
  if (typeof uuid !== 'string') return // uuid-less test fakes stay uncached
  toneGridCache.delete(uuid) // re-insert = most recently used
  toneGridCache.set(uuid, grid)
  if (toneGridCache.size > TONE_GRID_CACHE_MAX) {
    // Map iteration order = insertion order; the first key is the LRU.
    const oldest = toneGridCache.keys().next().value
    if (oldest !== undefined) toneGridCache.delete(oldest)
  }
}

/**
 * The texture's pattern grid via the CPU lanes (LRU cache → data/canvas
 * pixel read). Null when only the GPU could read it — the pending retry
 * lane builds and delivers the grid alongside the tone then.
 */
export function mapPatternGrid(map: SurfaceMaterialLike['map']): ToneGrid | null {
  if (!map) return null
  const uuid = (map as { uuid?: unknown }).uuid
  if (typeof uuid === 'string') {
    const cached = toneGridCache.get(uuid)
    if (cached) {
      cacheToneGrid(map, cached) // LRU touch
      return cached
    }
  }
  const pixels = readMapPixels(map)
  if (!pixels) return null
  const grid = toneGridFromPixels(pixels)
  cacheToneGrid(map, grid)
  return grid
}

/** Sample a ToneGrid at (u, v), wrapping both axes (tiling). Pure. */
export function cellToneAt(out: Color, grid: ToneGrid, u: number, v: number): Color {
  let fu = u - Math.floor(u)
  let fv = v - Math.floor(v)
  if (fu < 0) fu += 1 // guard -0/-1e-17 edge
  if (fv < 0) fv += 1
  const x = Math.min(grid.size - 1, Math.floor(fu * grid.size))
  const y = Math.min(grid.size - 1, Math.floor(fv * grid.size))
  const o = (y * grid.size + x) * 3
  return out.setRGB(grid.rgb[o]!, grid.rgb[o + 1]!, grid.rgb[o + 2]!)
}

/**
 * The PATTERN tone of cell `i` on a layered target, or null when the grid
 * dimensions are missing. The cell's face (u,v) derives from grid indices
 * in METRES, then tiles at SKIN_TILE_M per repeat:
 *
 *   wall — u along the SPAN (the in-plane horizontal axis: whichever of
 *          grid X/Z has more cells; the other is the thickness), v up the
 *          height (grid Y);
 *   slab — plan projection: u = grid X, v = grid Z;
 *   roof — u across the eave (grid X), v up the slope (grid Y) — the
 *          plane-frame convention of buildRoofPlaneTargets;
 *   volume — u = grid X, v = grid Y (generic vertical projection).
 *
 * Both skins of a sandwich share the same (u,v) — the thickness axis is
 * deliberately ignored, so the inner face wears the same courses.
 */
export function cellPatternTone(out: Color, wall: SkinToneSource, i: number): Color | null {
  const toneGrid = wall.toneGrid
  const { coords, cellX, cellY, cellZ } = wall.grid
  if (!toneGrid || cellX === undefined || cellY === undefined || cellZ === undefined) return null
  const ix = coords[i * 3]!
  const iy = coords[i * 3 + 1]!
  const iz = coords[i * 3 + 2]!
  let u: number
  let v: number
  if (wall.kind === 'slab') {
    u = ix * cellX
    v = iz * cellZ
  } else if (wall.kind === 'wall') {
    // Span axis = the in-plane horizontal (more cells than the ≤3-layer
    // thickness axis); anisotropic wall grids guarantee the asymmetry.
    const spanIsX = (wall.grid.nx ?? 1) >= (wall.grid.nz ?? 1)
    u = spanIsX ? ix * cellX : iz * cellZ
    v = iy * cellY
  } else {
    // roof (across/upSlope) and generic volumes (x/y projection).
    u = ix * cellX
    v = iy * cellY
  }
  return cellToneAt(out, toneGrid, u / SKIN_TILE_M, v / SKIN_TILE_M)
}

// ── Surface tone resolution (the "no voxel stays white" chain) ──────────────
// The host's textured materials (brick walls, shingle roofs, tiled floors)
// carry their whole look in the texture MAP over a PURE WHITE base color —
// reading material.color alone yields white, which is exactly the "a lot of
// voxels are still the default untextured white" live complaint. Every
// voxelize lane resolves its baseColor through resolveSurfaceTone, which
// walks the FALLBACK CHAIN:
//
//   1. map thumbnail — the map's CPU-readable image (canvas draw, or a
//      DataTexture-style { data, width, height } read directly — the
//      headless path) averaged to one tone × material.color;
//   2. GPU readback — compressed images (KTX2) render onto a tiny target
//      through the live renderer's own sampler chain (async — WebGPU
//      readbacks are promises) and average the same way;
//   3. material.color, IF it isn't the untextured white default;
//   4. the kind palette — drywall greige for walls, warm gray for slabs,
//      dark shingle for roofs. NEVER pure white.
//
// Steps 1/3/4 are synchronous (the immediate baseColor); step 2 — and a
// map whose image simply hasn't LOADED yet — enters the PENDING RETRY lane:
// ~1 attempt per second for ≤ TONE_RETRY_MAX seconds, delivering through
// the caller's onTone (destruction.ts copies it into baseColor and bumps
// skinRevision; voxel-walls re-primes; paint coats re-apply from the
// ledger). Every node still wearing a fallback shows up in
// toneAuditReport() — the QA counter for "which voxels are lying about
// their color and why".

/** Minimal material slice the tone chain reads (Mesh['material'] items). */
export type SurfaceMaterialLike = {
  color?: Color
  map?: (Texture & { image?: unknown }) | null
}

/** The target kinds the tone chain distinguishes ('item' = the silhouette
 * lane's per-region palette — VoxelTarget.kind stays 'volume' there;
 * 'floor' = FLOOR-family slabs — nodeType slab/floor, never ceiling —
 * whose fallback must read as a wood floor, not screed gray: the owner
 * wave-5 "floor inside the house is white" complaint). */
export type SkinToneKind = 'wall' | 'slab' | 'volume' | 'roof' | 'item' | 'floor'

/** Kind palette — the LAST link of the chain. Deliberately un-white: a
 * surface that lost every better source should read as a plausible
 * MATERIAL (drywall, screed, weathered shingle), never as the untextured
 * default. */
const KIND_FALLBACK_HEX: Record<SkinToneKind, string> = {
  wall: '#d8d2c7', // drywall greige (the classic inner-skin tone)
  slab: '#b8afa2', // warm screed gray (ceiling-family slabs)
  floor: '#a0784e', // mid oak — a floor that lost its finish still reads wood
  volume: '#c8c1b6', // warm neutral
  roof: '#5a524a', // dark weathered shingle
  item: '#d8d2c7', // porcelain-adjacent greige (matches the old item default)
}

/** A fresh copy of the kind's fallback tone (never pure white). */
export function kindFallbackTone(kind: SkinToneKind): Color {
  return new Color(KIND_FALLBACK_HEX[kind])
}

/** The "untextured white" detector: the host's textured materials ship
 * pure-white base colors, and three's default material color is white too
 * — any near-white base with no readable map is a lie, not a paint job.
 * Threshold in the WORKING color space (linear ~0.9 ≈ sRGB #f3f3f3). */
export function isUntexturedWhite(color: Color): boolean {
  return color.r > 0.9 && color.g > 0.9 && color.b > 0.9
}

// ── Tone audit (QA: which nodes still wear a fallback, and why) ─────────────

export type ToneAuditWhy =
  /** The dominant material carried neither color nor map. */
  | 'no-material'
  /** A map exists but no attempt has managed to read it yet — the retry
   * lane is still working on it (image loading, renderer not registered). */
  | 'pending'
  /** Every attempt failed — the retry budget is exhausted (or no retint
   * callback was provided, so retrying could never deliver). */
  | 'map-unreadable'
  /** No map, and material.color is the untextured white default. */
  | 'white-base'

export type ToneAuditEntry = { nodeId: string; kind: SkinToneKind; why: ToneAuditWhy }

const toneAudit = new Map<string, { kind: SkinToneKind; why: ToneAuditWhy }>()

/** Every node whose baseColor is still a FALLBACK (not its surface's real
 * albedo) and why — plain copies. Empty array = every replica wears a
 * truthful tone. QA: `__boots.toneAudit()`. */
export function toneAuditReport(): ToneAuditEntry[] {
  const out: ToneAuditEntry[] = []
  for (const [nodeId, entry] of toneAudit) out.push({ nodeId, ...entry })
  return out
}

/** Forget one node's audit entry + any pending retry (dropTarget — the
 * replica left; nothing renders the fallback anymore). */
export function clearToneAudit(nodeId: string): void {
  toneAudit.delete(nodeId)
  pendingTones.delete(nodeId)
  syncRetryTimer()
}

function auditFallback(nodeId: string, kind: SkinToneKind, why: ToneAuditWhy): void {
  toneAudit.set(nodeId, { kind, why })
}

/** Register a fallback OUTSIDE resolveSurfaceTone (the item lane resolves
 * per REGION and reports its node's worst case here). */
export function reportToneFallback(nodeId: string, kind: SkinToneKind, why: ToneAuditWhy): void {
  auditFallback(nodeId, kind, why)
}

// ── Renderer registry + GPU readback (compressed maps) ──────────────────────

/** The renderer surface the GPU lane needs (WebGLRenderer AND WebGPURenderer
 * both satisfy it — readback prefers the async API when present). */
export type SkinToneRenderer = {
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

let skinToneRenderer: SkinToneRenderer | null = null

/** voxel-walls.tsx wires the live renderer in on mount (null on unmount). */
export function setSkinToneRenderer(renderer: SkinToneRenderer | null): void {
  skinToneRenderer = renderer
}

/** Lazy readback rig — one tiny scene reused for every texture. */
let toneRig: {
  target: RenderTarget
  scene: Scene
  camera: OrthographicCamera
  material: MeshBasicMaterial
} | null = null

/** GPU readback edge: 64 px × 4 B = 256 B rows — exactly WebGPU's
 * copy-row alignment, so the readback never carries padding ambiguity. */
const GPU_READ_SIZE = 64

/** GPU render + readback of a texture through the live renderer — RGBA
 * bytes in the WORKING (linear) space, GPU_READ_SIZE². Null when no
 * renderer is registered or the readback fails (headless tests, exotic
 * targets) — callers stay on the retry lane then. */
async function gpuReadMapPixels(map: Texture): Promise<ArrayLike<number> | null> {
  const renderer = skinToneRenderer
  if (!renderer) return null
  try {
    if (!toneRig) {
      const scene = new Scene()
      const material = new MeshBasicMaterial()
      scene.add(new Mesh(new PlaneGeometry(2, 2), material))
      toneRig = {
        target: new RenderTarget(GPU_READ_SIZE, GPU_READ_SIZE),
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
        GPU_READ_SIZE,
        GPU_READ_SIZE,
      )
      renderer.setRenderTarget(prior)
      pixels = await read
    } else if (renderer.readRenderTargetPixels) {
      const buffer = new Uint8Array(GPU_READ_SIZE * GPU_READ_SIZE * 4)
      renderer.readRenderTargetPixels(toneRig.target, 0, 0, GPU_READ_SIZE, GPU_READ_SIZE, buffer)
      renderer.setRenderTarget(prior)
      pixels = buffer
    } else {
      renderer.setRenderTarget(prior)
      return null
    }
    toneRig.material.map = null
    const data = pixels as unknown as { length: number; [i: number]: number }
    return data.length > 0 ? data : null
  } catch {
    return null
  }
}

// ── CPU pixel reads (the "thumbnail" lane) ──────────────────────────────────

/** Down-draw size for canvas thumbnail reads. */
const TONE_SAMPLE_SIZE = 32

type MapPixels = {
  data: ArrayLike<number>
  width: number
  height: number
  /** True when `data` holds sRGB bytes (canvas / image data); false for
   * GPU readbacks (the sampler already decoded into the working space). */
  srgb: boolean
}

/**
 * CPU-readable RGBA pixels of a texture's image, or null. Two paths:
 * DataTexture-style images ({ data, width, height } — also the headless
 * test shape) read directly; anything canvas-drawable (HTMLImageElement,
 * ImageBitmap) down-draws through a tiny 2D canvas. Bytes are treated as
 * sRGB either way — the host's albedo maps all are. Compressed images
 * (KTX2 mipmap blobs) fail both and stay on the GPU lane.
 */
function readMapPixels(map: SurfaceMaterialLike['map']): MapPixels | null {
  const image = map?.image as
    | { data?: ArrayLike<number>; width?: number; height?: number }
    | undefined
  if (!image) return null
  const { data, width, height } = image
  if (data && typeof width === 'number' && typeof height === 'number' && width * height > 0) {
    if (data.length >= width * height * 4) return { data, width, height, srgb: true }
    return null
  }
  if (typeof document === 'undefined') return null
  try {
    const size = TONE_SAMPLE_SIZE
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(image as CanvasImageSource, 0, 0, size, size)
    return { data: ctx.getImageData(0, 0, size, size).data, width: size, height: size, srgb: true }
  } catch {
    return null
  }
}

/** Pure: average RGB of packed RGBA pixels → a working-space Color. */
export function averagePixelTone(data: ArrayLike<number>, srgb: boolean): Color | null {
  if (data.length < 4) return null
  let r = 0
  let g = 0
  let b = 0
  const texels = Math.floor(data.length / 4)
  for (let i = 0; i < texels * 4; i += 4) {
    r += data[i]!
    g += data[i + 1]!
    b += data[i + 2]!
  }
  const n = texels * 255
  return srgb ? new Color().setRGB(r / n, g / n, b / n, 'srgb') : new Color(r / n, g / n, b / n)
}

/** map → resolved average tone (before the base-color multiply). WeakMap:
 * a strong Map would pin every session's Textures (and their CPU image
 * data) for the module lifetime across project jump-ins. */
const toneCache = new WeakMap<object, Color>()

/** The map's average tone via the CPU lanes (cache → data/canvas read).
 * Null when only the GPU could read it (or nothing can). Derived FROM the
 * pattern grid the same read builds (mapPatternGrid), so the flat tone and
 * the per-cell pattern always agree per texture. */
export function mapAverageTone(map: SurfaceMaterialLike['map']): Color | null {
  if (!map) return null
  const cached = toneCache.get(map)
  if (cached) return cached.clone()
  const grid = mapPatternGrid(map)
  if (!grid) return null
  const tone = toneGridAverage(grid)
  toneCache.set(map, tone.clone())
  return tone
}

// ── Pending retry lane (~1 attempt/s, ≤ TONE_RETRY_MAX) ─────────────────────

/** Seconds between retry attempts (the interval drives retryPendingTones). */
export const TONE_RETRY_INTERVAL_MS = 1000
/** Attempts before a pending tone gives up ('map-unreadable'). */
export const TONE_RETRY_MAX = 15

type PendingTone = {
  nodeId: string
  kind: SkinToneKind
  material: SurfaceMaterialLike
  onTone: (tone: Color, grid: ToneGrid | null) => void
  attempts: number
  /** A GPU readback is in flight — don't stack another. */
  busy: boolean
  /** Budget exhausted while a readback was in flight — deliver it anyway
   * if it lands (the target still renders the fallback). */
  gaveUp: boolean
}

const pendingTones = new Map<string, PendingTone>()
let retryTimer: ReturnType<typeof setInterval> | null = null

/** Unresolved tones still retrying (tests + QA introspection). */
export function pendingToneCount(): number {
  return pendingTones.size
}

function syncRetryTimer(): void {
  if (pendingTones.size > 0 && retryTimer === null && typeof setInterval !== 'undefined') {
    retryTimer = setInterval(retryPendingTones, TONE_RETRY_INTERVAL_MS)
  } else if (pendingTones.size === 0 && retryTimer !== null) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

function deliverTone(p: PendingTone, mapTone: Color, grid: ToneGrid | null): void {
  if (pendingTones.get(p.nodeId) === p) pendingTones.delete(p.nodeId)
  toneAudit.delete(p.nodeId) // resolved — even a late (post-give-up) landing counts
  syncRetryTimer()
  const tone = mapTone.clone()
  if (p.material.color) tone.multiply(p.material.color)
  p.onTone(tone, grid)
}

/** One attempt for one pending entry: CPU lanes first, then (with a live
 * renderer and a loaded image) the async GPU readback. */
function attemptPendingTone(p: PendingTone): void {
  const map = p.material.map
  if (!map) {
    // The map vanished (material swapped) — nothing left to read.
    p.attempts = TONE_RETRY_MAX
    return
  }
  const cpuTone = mapAverageTone(map)
  if (cpuTone) {
    deliverTone(p, cpuTone, mapPatternGrid(map))
    return
  }
  // GPU lane: only once the image EXISTS — rendering a still-loading map
  // reads back the material's plain white, not the texture.
  if (!map.image || !skinToneRenderer || p.busy) return
  p.busy = true
  void gpuReadMapPixels(map).then((pixels) => {
    p.busy = false
    if (!pixels) return
    // One readback feeds BOTH views of the texture: the pattern grid and
    // the flat average derived from it (readbacks are linear already).
    const grid = toneGridFromPixels({
      data: pixels,
      width: GPU_READ_SIZE,
      height: GPU_READ_SIZE,
      srgb: false,
    })
    cacheToneGrid(map, grid)
    const tone = toneGridAverage(grid)
    toneCache.set(map, tone.clone())
    // Deliver unless a NEWER resolve replaced this entry for the node.
    const current = pendingTones.get(p.nodeId)
    if (current === p || (current === undefined && p.gaveUp)) deliverTone(p, tone, grid)
  })
}

/**
 * Run one retry pass over every pending tone (the 1 Hz interval drives
 * this; tests call it directly). Entries that exhaust TONE_RETRY_MAX
 * attempts drop with a final 'map-unreadable' audit — unless a readback
 * is still in flight, in which case its landing still delivers.
 */
export function retryPendingTones(): void {
  for (const p of pendingTones.values()) {
    p.attempts++
    attemptPendingTone(p)
    if (p.attempts >= TONE_RETRY_MAX && pendingTones.get(p.nodeId) === p) {
      p.gaveUp = true
      pendingTones.delete(p.nodeId)
      auditFallback(p.nodeId, p.kind, 'map-unreadable')
    }
  }
  syncRetryTimer()
}

/**
 * Resolve a surface's tone through the fallback chain, SYNCHRONOUSLY
 * returning the best immediately-known color (never pure white) and — when
 * the map needs loading/GPU time — retrying in the background, delivering
 * the better tone AND its pattern grid through `onTone` (ASYNC ONLY, at
 * most once; destruction copies them into baseColor/toneGrid + bumps
 * skinRevision). Registers/clears the node's tone-audit entry as a side
 * effect. Synchronously-readable maps: call mapPatternGrid for the grid —
 * it rides the same cached pixel read.
 */
export function resolveSurfaceTone(
  nodeId: string,
  kind: SkinToneKind,
  material: SurfaceMaterialLike | null,
  onTone?: (tone: Color, grid: ToneGrid | null) => void,
): Color {
  pendingTones.delete(nodeId) // a re-resolve replaces any older retry
  toneAudit.delete(nodeId)
  syncRetryTimer()
  if (!material || (!material.color && !material.map)) {
    auditFallback(nodeId, kind, 'no-material')
    return kindFallbackTone(kind)
  }
  const base = material.color
  if (material.map) {
    const tone = mapAverageTone(material.map)
    if (tone) return base ? tone.multiply(base) : tone
    // Unreadable RIGHT NOW (image still loading, compressed → GPU, or the
    // renderer isn't registered yet): fall back, retry in the background.
    if (onTone) {
      auditFallback(nodeId, kind, 'pending')
      const entry: PendingTone = {
        nodeId,
        kind,
        material,
        onTone,
        attempts: 0,
        busy: false,
        gaveUp: false,
      }
      pendingTones.set(nodeId, entry)
      syncRetryTimer()
      // Kick attempt 0 immediately (doesn't consume retry budget): the
      // roof lane used to resolve compressed shingles within a frame or
      // two via the GPU — keep that latency instead of waiting 1 s.
      attemptPendingTone(entry)
    } else {
      auditFallback(nodeId, kind, 'map-unreadable')
    }
    return base && !isUntexturedWhite(base) ? base.clone() : kindFallbackTone(kind)
  }
  if (base && !isUntexturedWhite(base)) return base.clone()
  auditFallback(nodeId, kind, 'white-base')
  return kindFallbackTone(kind)
}

/** Session teardown: clear the audit + every pending retry (timers die
 * with the map). resetDestruction calls this. */
export function resetSkinTones(): void {
  toneAudit.clear()
  pendingTones.clear()
  syncRetryTimer()
}
