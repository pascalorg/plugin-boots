/**
 * THE ENDLESS LOT — the void world's horizon.
 *
 * A scene with no host `site` node gets the boots lawn: a 95 m textured disc
 * (nature.tsx `groundGeometry`) under a sky dome. That disc's RIM was
 * visible — from standing height a hard line ~1° under the horizon, from a
 * built-up vantage 20 m up a plain green platter floating in gray. The lobby
 * map ("an empty lot with infinite grass") is the first thing every stranger
 * loads, so the void world has to read as an open field to the horizon.
 *
 * Three cheap pieces, all void-only (a site scene keeps the host's ground,
 * horizon plate and editor sky — same gate as `shouldMountGroundDisc`):
 *
 * 1. THE SKIRT — one annulus continuing the disc from 95 m to HORIZON_FAR,
 *    same material, same texture, UVs in the same meters-per-tile frame, and
 *    an inner ring built through the SAME three code path the disc's contour
 *    comes from (`discContour`: Path → EllipseCurve → getPoints, which
 *    resolves an ellipse at 2× curveSegments). The shared edge is therefore
 *    bit-identical — the seam cannot crack and the two never overlap, so
 *    there is nothing to z-fight. 192 triangles.
 * 2. THE HAZE — one transparent annulus floating HAZE_LIFT over the lawn,
 *    painted the sky's own horizon color, its alpha ramp baked into a
 *    CanvasTexture by radius (`hazeAlpha`). Distance fog without a shader,
 *    without `scene.fog` (which would recompile every material in the scene
 *    and re-tint the host's own meshes). It reaches 1.0 well inside
 *    HORIZON_FAR, so the skirt's rim dissolves into sky before it ends.
 * 3. THE FAR TUFTS — a sparse blade layer past the detailed grass field, so
 *    the scatter doesn't stop in a visible circle. Density falls as
 *    r^-FAR_GRASS_FALLOFF (`farGrassRadius` is that profile's exact inverse
 *    CDF) and each tuft's scale dissolves to zero at the outer edge
 *    (`farTuftScale`), so the field ENDS at nothing instead of at an edge.
 *    Two crossed quads per tuft — 4 triangles against the near cluster's 15.
 *
 * Everything here is pure geometry / texture / math: nature.tsx mounts it,
 * sky.tsx takes its dome radius and its horizon color from here so the
 * ground's dissolve target and the sky's horizon band can never drift apart.
 */

import { BufferAttribute, BufferGeometry, CanvasTexture, Path, Shape, ShapeGeometry, SRGBColorSpace } from 'three'

// ── Radii ──────────────────────────────────────────────────────────────────
// The host viewer's camera is `far={1000}` (drei PerspectiveCamera), so the
// whole rig has to fit inside ~750 m of the lot center with room for a player
// standing off-center.

/** The lawn's true outer edge. Fully hazed by here, so it is not visible. */
export const HORIZON_FAR = 600

/**
 * THE GREEN LAWN over a real lot's white horizon plate.
 *
 * A void lot already reads as infinite grass (nature.tsx's disc + skirt); a
 * host SITE does not — the host's own 400 m+ ground plate (`pascalExport:'strip'`
 * at y≈−0.07) surrounds the terrain and reads white/gray, so the world looks
 * like a building on a white platter. This is one big grass-green disc laid a
 * hair above that plate, out to HORIZON_FAR, with the terrain field rect punched
 * out so it never covers (or z-fights) the host terrain itself — the SAME
 * rectangular hole the host punches in its own plate. Opaque and polygon-offset,
 * so it occludes the white cleanly across the whole plate, near and far.
 *
 * Rect is in the disc's local XY frame (world x = local x, world z = −local y),
 * matching groundGeometry's convention. Pure; the mesh Y and the rect come from
 * world.lotEdge.
 */
export function lawnGeometry(
  rect: { x0: number; x1: number; y0: number; y1: number } | null,
  radius = HORIZON_FAR,
  segments = 64,
): BufferGeometry {
  const shape = new Shape()
  shape.absarc(0, 0, radius, 0, Math.PI * 2, false)
  if (rect) {
    const hole = new Path()
    hole.moveTo(rect.x0, rect.y0)
    hole.lineTo(rect.x1, rect.y0)
    hole.lineTo(rect.x1, rect.y1)
    hole.lineTo(rect.x0, rect.y1)
    hole.closePath()
    shape.holes.push(hole)
  }
  const geometry = new ShapeGeometry(shape, segments)
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / (radius * 2) + 0.5, uv.getY(i) / (radius * 2) + 0.5)
  }
  return geometry
}

/** The sky dome radius — OUTSIDE HORIZON_FAR so the dome's below-equator
 * half stays covered by ground in every direction the player can look. */
export const HORIZON_SKY_RADIUS = 700

/** Where the distance haze starts lifting off the lawn (m from lot center):
 * everything nearer stays pure grass, which is the whole playable area. */
export const HAZE_INNER = 70
/** …and where it reaches full opacity: pure sky color from here outward. */
export const HAZE_FULL = 520
/** Ramp shape. > 1 keeps the near field clean and pushes the wash outward,
 * so the fade lives in the last degree or two under the horizon. */
export const HAZE_GAMMA = 1.6
/** The haze plate floats this far above the lawn (m). Any positive lift kills
 * the coplanar depth tie; the resulting radial shift is a fraction of a
 * meter over hundreds, which the ramp swallows. */
export const HAZE_LIFT = 0.25

/** The color the ground dissolves into — the SAME warm gray the sky dome
 * paints across its horizon band (sky.tsx imports it). Ground-to-sky is then
 * a color identity instead of a tuned approximation. */
export const HORIZON_COLOR = '#ddd7ca'

/** Angular resolution of every ring here. 48 is `groundGeometry`'s
 * curveSegments; three resolves an ellipse at 2×, so rings carry 96
 * segments and the skirt's inner ring lands on the disc's own vertices. */
export const HORIZON_SEGMENTS = 48

/** Haze opacity over the lawn at `r` metres from the lot center. Pure. */
export function hazeAlpha(r: number): number {
  if (r <= HAZE_INNER) return 0
  if (r >= HAZE_FULL) return 1
  return ((r - HAZE_INNER) / (HAZE_FULL - HAZE_INNER)) ** HAZE_GAMMA
}

/**
 * The vertices of a `radius` circle exactly as ShapeGeometry lays out the
 * lawn disc's outer contour: `Path.absarc` → `CurvePath.getPoints`, which
 * resolves an EllipseCurve at 2 × curveSegments. Returned in the curve's own
 * CCW order (the disc stores them reversed — ShapeGeometry flips the contour
 * clockwise — but the SET is identical, which is what a shared edge needs).
 * 2·curveSegments + 1 points: the last one closes the ring onto the first.
 */
export function discContour(radius: number, curveSegments = HORIZON_SEGMENTS): number[] {
  const path = new Path()
  path.absarc(0, 0, radius, 0, Math.PI * 2, false)
  const points = path.getPoints(curveSegments)
  const out: number[] = []
  for (const point of points) out.push(point.x, point.y)
  return out
}

/**
 * An annulus in the disc's own local XY frame (the mesh rotates −π/2 about X,
 * so local (x, y) lands at world (x, −z)), wound CCW-from-+Z to match the
 * disc's triangles, normals +Z, one radial band. `uv(x, y, t)` fills the
 * UV pair: the skirt continues the disc's meters-per-tile mapping, the haze
 * maps its radial parameter onto the baked ramp.
 */
function annulus(
  inner: number,
  outer: number,
  segments: number,
  uv: (x: number, y: number, t: number) => [number, number],
): BufferGeometry {
  const innerRing = discContour(inner, segments)
  const outerRing = discContour(outer, segments)
  const rings = innerRing.length / 2
  const positions = new Float32Array(rings * 2 * 3)
  const normals = new Float32Array(rings * 2 * 3)
  const uvs = new Float32Array(rings * 2 * 2)
  const write = (slot: number, x: number, y: number, t: number) => {
    positions[slot * 3] = x
    positions[slot * 3 + 1] = y
    normals[slot * 3 + 2] = 1
    const [u, v] = uv(x, y, t)
    uvs[slot * 2] = u
    uvs[slot * 2 + 1] = v
  }
  for (let i = 0; i < rings; i++) {
    write(i, innerRing[i * 2]!, innerRing[i * 2 + 1]!, 0)
    write(rings + i, outerRing[i * 2]!, outerRing[i * 2 + 1]!, 1)
  }
  // Winding: discContour runs CCW (increasing angle), so the quad's triangles
  // go inner → outer → inner to come out CCW-from-+Z — front-facing after the
  // −π/2 X rotation, exactly like the disc's own earcut triangles. Pinned by
  // a test: get this backwards and the whole lawn skirt culls away.
  const indices: number[] = []
  for (let i = 0; i + 1 < rings; i++) {
    const a = i
    const b = i + 1
    const c = rings + i + 1
    const d = rings + i
    indices.push(a, c, b, a, d, c)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

/**
 * The lawn skirt: the disc's grass carried from `inner` (its own rim) out to
 * HORIZON_FAR. `uvSpan` is the disc's UV normalization span (it divides raw
 * shape meters by 2 × its radius), so the shared texture keeps one grain
 * across the seam.
 */
export function skirtGeometry(
  inner: number,
  uvSpan: number,
  outer = HORIZON_FAR,
  segments = HORIZON_SEGMENTS,
): BufferGeometry {
  return annulus(inner, outer, segments, (x, y) => [x / uvSpan + 0.5, y / uvSpan + 0.5])
}

/** The haze plate: HAZE_INNER → HORIZON_FAR, v = the radial parameter the
 * baked ramp is indexed by (u is constant — the texture is a 1-D gradient). */
export function hazeGeometry(segments = HORIZON_SEGMENTS): BufferGeometry {
  return annulus(HAZE_INNER, HORIZON_FAR, segments, (_x, _y, t) => [0.5, t])
}

/** Ramp resolution — one texel per ~2 m of the haze band. */
const HAZE_TEXELS = 256

/**
 * The baked haze ramp: HORIZON_COLOR at `hazeAlpha`'s opacity, indexed by the
 * plate's v. Written through ImageData so the alpha is stored exactly as
 * asked (canvas compositing would round it through premultiplication).
 * Texture v = 0 is the canvas BOTTOM (three flips Y), which is the plate's
 * inner edge — so row 0 of the canvas is the outer, opaque end.
 */
export function hazeTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = HAZE_TEXELS
  const g = canvas.getContext('2d')
  if (!g) return null
  const r = Number.parseInt(HORIZON_COLOR.slice(1, 3), 16)
  const gr = Number.parseInt(HORIZON_COLOR.slice(3, 5), 16)
  const b = Number.parseInt(HORIZON_COLOR.slice(5, 7), 16)
  const image = g.createImageData(canvas.width, canvas.height)
  for (let row = 0; row < canvas.height; row++) {
    // Canvas row 0 → v = 1 → the plate's OUTER edge.
    const v = 1 - (row + 0.5) / canvas.height
    const alpha = hazeAlpha(HAZE_INNER + v * (HORIZON_FAR - HAZE_INNER))
    const a = Math.round(alpha * 255)
    for (let col = 0; col < canvas.width; col++) {
      const i = (row * canvas.width + col) * 4
      image.data[i] = r
      image.data[i + 1] = gr
      image.data[i + 2] = b
      image.data[i + 3] = a
    }
  }
  g.putImageData(image, 0, 0)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

// ── The far blade layer ────────────────────────────────────────────────────

/** Where the far tufts start: the detailed field's own outer radius, so the
 * two layers meet without a gap. */
export const FAR_GRASS_INNER = 55
/** …and where they dissolve to nothing. */
export const FAR_GRASS_OUTER = 170
/** Instances. Chosen so the density at FAR_GRASS_INNER lands near the
 * detailed field's (~1/m²) under the falloff below — the whole layer is
 * 4-triangle tufts, so it costs about a ninth of the same count of clusters. */
export const FAR_GRASS_COUNT = 8500
/** Per-area density falls as r^-FAR_GRASS_FALLOFF. Steep on purpose: the
 * layer has to be gone, not thin, by the time it ends. */
export const FAR_GRASS_FALLOFF = 4

/**
 * Radius for a uniform sample `u` ∈ [0, 1) under a per-area density
 * ∝ r^-falloff between rMin and rMax — the exact inverse CDF (the count in
 * [rMin, r] integrates density over the annulus, ∝ r^(2-falloff)). Pure and
 * monotone; `falloff === 2` (constant count per ring) degenerates to the log
 * form. Exported for the density test.
 */
export function farGrassRadius(
  u: number,
  rMin = FAR_GRASS_INNER,
  rMax = FAR_GRASS_OUTER,
  falloff = FAR_GRASS_FALLOFF,
): number {
  const m = 2 - falloff
  if (m === 0) return rMin * (rMax / rMin) ** u
  return (rMin ** m + u * (rMax ** m - rMin ** m)) ** (1 / m)
}

/**
 * Scale multiplier for a far tuft at radial parameter t ∈ [0, 1]: tufts grow
 * with distance (so they keep covering ground as density drops) and then
 * DISSOLVE — exactly 0 at t = 1. Zero size at the rim is what makes the
 * layer's end invisible: there is no last row of blades, they shrink out.
 * Pure; exported for tests.
 */
export function farTuftScale(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  // Growth is DELIBERATELY mild (0.9, matching the detailed field's own
  // `1 + t * 0.9` distance term). A steeper term ballooned mid-field tufts
  // into dark blobs that read as rubble, not grass — the first QA pass on
  // the 20 m vantage showed it as a ring of chunky specks.
  return (1 + 0.9 * clamped) * (1 - clamped * clamped) ** 0.6
}

/**
 * One far tuft: two crossed quads (4 triangles) with the blade field's own
 * vertex-color ramp and all-up normals, so it shades exactly like the near
 * clusters and rides the SAME material. Crossed rather than single so a tuft
 * never turns edge-on from a rooftop vantage.
 *
 * PROPORTIONS matter more than anything here, and the first QA pass proved
 * it. The detailed field's clusters are already scaled ~1.9× where it ends
 * (its own `1 + t * 0.9` term), so a cluster at the seam stands ~0.7 m tall
 * on hair-thin blades. A wide, short tuft next to that reads as a dark cube:
 * the 20 m vantage showed a ring of rubble-like specks at exactly 55 m. So a
 * tuft is TALL AND NARROW — 0.75 m on a 0.2 m span — which is that seam
 * cluster's silhouette. The ramp starts at the near cluster's MID green
 * rather than its dark root (a two-row quad has no mid stop, and a dark root
 * over half the area darkened the whole far band); running a shade light also
 * matches how an overcast distance actually reads.
 */
export function farTuftGeometry(): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const half = 0.1
  const height = 0.75
  for (const yaw of [0, Math.PI / 2]) {
    const dx = Math.cos(yaw) * half
    const dz = Math.sin(yaw) * half
    const base = positions.length / 3
    // biome-ignore format: vertex rows read better unwrapped
    positions.push(
      -dx, 0, -dz,
      dx, 0, dz,
      dx * 0.72, height, dz * 0.72,
      -dx * 0.72, height, -dz * 0.72,
    )
    // biome-ignore format: one rgb triple per row
    colors.push(
      0.7, 0.74, 0.56,
      0.7, 0.74, 0.56,
      1, 1, 0.82,
      1, 1, 0.82,
    )
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  const normals = new Float32Array(positions.length)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  return geometry
}
