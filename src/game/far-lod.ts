import { DoubleSide, MeshBasicMaterial, RingGeometry } from 'three'

/**
 * FAR LOD — how a player stays READABLE from an editor camera 30–100 m out.
 *
 * The problem, measured: the name tag is a 0.72 × 0.18 m plane at y = 2.05,
 * depth-TESTED, hidden past 40 m (remote-players.tsx). From the editor's orbit
 * camera (fov 50, ~900 px tall) it is ≈22 px at 8 m, ≈7 px at 30 m and gone at
 * 40 m; in plan view (drei orthographic camera, zoom 20 → 1 world unit = 20 px)
 * it is 3.6 px. The 1.85 m mascot itself is a 40 px speck at 50 m, and a player
 * inside the building is hidden from a camera outside it. "People looking at
 * the project see the players live" is not true from where they look.
 *
 * The answer is SPECTATOR-ONLY and lives in three pure decisions:
 *   1. a constant-PIXEL tag: scale the tag so it reads ~36 px tall from any
 *      distance (perspective AND orthographic), capped at 12×, never below 1×;
 *   2. lift the tag WITH the scale so its bottom edge stays at 1.96 m — a
 *      naively scaled tag centred at 2.05 m would cover the avatar it labels;
 *   3. X-ray: the tag (and a floor ring that grounds the feet in oblique
 *      views) ignore depth and draw last, so a player behind a wall is still a
 *      name over a ring.
 * The IN-GAME path is deliberately untouched — a depth-tested, unscaled tag
 * fading at 24–40 m is PvP fairness (no reading names through walls).
 *
 * This module is PURE plus two shared GPU objects (a lazily built ring
 * geometry and a per-tint material cache), imports nothing from
 * remote-players.tsx (the tint hex is passed in, so no cycle), and uses plain
 * three materials only — WebGPU-safe by construction (no shaders, no
 * onBeforeCompile). remote-players.tsx wires it in round 2; the hook points are
 * listed at the bottom.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** The tag plane as remote-players.tsx builds it (m). */
export const TAG_WIDTH_M = 0.72
export const TAG_HEIGHT_M = 0.18
/** Tag group centre height over the feet (m) at scale 1. */
export const TAG_BASE_Y = 2.05
/** What the scaled tag should read as, on screen (px, tag HEIGHT). */
export const TAG_TARGET_PX = 36
/** Hard cap on the tag scale (8.6 × 2.2 m at 12× — a billboard, not a wall). */
export const TAG_SCALE_MAX = 12
/** Spectator tags stay on to here (m); the in-game cutoff stays at 40 m. */
export const SPECTATOR_TAG_MAX_DIST = 200
/** The floor ring appears once the tag needs at least this much scaling —
 * i.e. once the avatar itself has stopped reading as a person. */
export const RING_MIN_SCALE = 2
/** Ring annulus (m) at scale 1: 0.4 m Ø ≈ 48 px wherever the tag is 36 px. */
export const RING_INNER = 0.16
export const RING_OUTER = 0.2
export const RING_SEGMENTS = 24
/** Draw order: ring under tag, both after everything depth-tested. */
export const SPECTATOR_RING_RENDER_ORDER = 998
export const SPECTATOR_TAG_RENDER_ORDER = 999
/** The editor's orbit camera fov (viewer-camera.tsx) — fallback when a camera
 * object carries none. */
export const DEFAULT_FOV_DEG = 50

/** Distance bands (m) — coarse detail decisions for a spectator camera. */
export const BAND_NEAR_M = 12
export const BAND_MID_M = 60

// ── Pure decisions ───────────────────────────────────────────────────────────

/** The camera fields the maths needs — structural, so a test needs no three. */
export type LodCamera = {
  isPerspectiveCamera?: boolean
  isOrthographicCamera?: boolean
  fov?: number
  zoom?: number
}

/**
 * World metres covered by ONE screen pixel at `dist` metres from `camera`.
 *
 * Perspective: `2 · dist · tan(fov/2) / zoom / viewportHeightPx` (three applies
 * zoom inside the projection, so a zoomed camera sees less world per pixel).
 * Orthographic (drei convention: frustum in pixels, so 1 world unit = zoom px):
 * `1 / zoom`, independent of distance — which is exactly why the in-game
 * distance fade is the wrong tool in plan view.
 */
export function worldPerPixel(camera: LodCamera, dist: number, viewportHeightPx: number): number {
  const zoom = camera.zoom !== undefined && camera.zoom > 0 ? camera.zoom : 1
  if (camera.isOrthographicCamera) return 1 / zoom
  const h = viewportHeightPx > 0 ? viewportHeightPx : 1
  const d = dist > 0 ? dist : 0
  const fov = camera.fov !== undefined && camera.fov > 0 ? camera.fov : DEFAULT_FOV_DEG
  return (2 * d * Math.tan((fov * Math.PI) / 360)) / zoom / h
}

/** Scale that makes the tag read TAG_TARGET_PX tall — clamped to [1, max]. */
export function tagScale(worldPerPx: number): number {
  const s = (TAG_TARGET_PX * worldPerPx) / TAG_HEIGHT_M
  if (!(s > 1)) return 1
  return s > TAG_SCALE_MAX ? TAG_SCALE_MAX : s
}

/**
 * Tag group height for a given scale: the BOTTOM edge stays where the 1× tag's
 * bottom edge is (2.05 − 0.09 = 1.96 m), so the scaled tag grows UPWARD and
 * never covers the 1.85 m avatar under it.
 */
export function tagLiftY(scale: number): number {
  return TAG_BASE_Y + (TAG_HEIGHT_M / 2) * (scale - 1)
}

/** Bottom edge of the scaled tag (m) — the invariant tagLiftY keeps. */
export function tagBottomY(scale: number): number {
  return tagLiftY(scale) - (TAG_HEIGHT_M / 2) * scale
}

/** Spectator tag opacity: solid to SPECTATOR_TAG_MAX_DIST, then off. No fade —
 * a constant-pixel tag is either useful or not. */
export function spectatorTagOpacity(distSq: number): number {
  return distSq <= SPECTATOR_TAG_MAX_DIST * SPECTATOR_TAG_MAX_DIST ? 1 : 0
}

/** Floor ring on once the tag needed ≥ RING_MIN_SCALE — the avatar is a speck. */
export function ringVisible(scale: number): boolean {
  return scale >= RING_MIN_SCALE
}

/** Spectator tags ignore depth (X-ray); in-game tags are depth-tested. */
export function tagDepthTest(spectator: boolean): boolean {
  return !spectator
}

/** Render order for the tag plane — last for a spectator, default in game. */
export function tagRenderOrder(spectator: boolean): number {
  return spectator ? SPECTATOR_TAG_RENDER_ORDER : 0
}

export type DistanceBand = 'near' | 'mid' | 'far' | 'beyond'

/**
 * Coarse distance band for a spectator camera:
 *   near   < 12 m   full body detail, tag at/near 1×, no ring
 *   mid    < 60 m   body detail on, tag scaled, ring on once scale ≥ 2
 *   far    ≤ 200 m  tag + ring carry the read; body detail can drop
 *   beyond > 200 m  tag off, ring off — the avatar is a dot at best
 */
export function distanceBand(distSq: number): DistanceBand {
  if (distSq < BAND_NEAR_M * BAND_NEAR_M) return 'near'
  if (distSq < BAND_MID_M * BAND_MID_M) return 'mid'
  if (distSq <= SPECTATOR_TAG_MAX_DIST * SPECTATOR_TAG_MAX_DIST) return 'far'
  return 'beyond'
}

/** Should the body's detail groups (face plate, vest seams…) draw in this band. */
export function bodyDetailVisible(band: DistanceBand): boolean {
  return band === 'near' || band === 'mid'
}

/**
 * Name-tag font fitting (texture-build time only): start at `startPx`, shrink
 * by `stepPx` while the measured label is wider than `maxWidthPx`, never below
 * `minPx`. `measure(px)` returns the label's width at that font size — the
 * canvas' measureText behind a closure, so this stays testable headless.
 */
export function tagFontPx(
  measure: (px: number) => number,
  maxWidthPx: number,
  startPx = 52,
  stepPx = 4,
  minPx = 24,
): number {
  let px = startPx
  while (px - stepPx >= minPx && measure(px) > maxWidthPx) px -= stepPx
  return px
}

// ── Shared GPU objects (plain three, WebGPU-safe) ────────────────────────────

/** Raycast no-op: depth-ignoring planes must never become hover/selection
 * targets for the editor's raycaster (and avatars are never colliders). */
export const noopRaycast = (): void => {}

let ringGeo: RingGeometry | null = null

/** The one ring geometry every spectator avatar shares (lazy: a page that
 * never spectates allocates nothing). */
export function ringGeometry(): RingGeometry {
  if (!ringGeo) ringGeo = new RingGeometry(RING_INNER, RING_OUTER, RING_SEGMENTS)
  return ringGeo
}

const ringMaterials = new Map<string, MeshBasicMaterial>()

/** One cached material per vest tint — depth-ignoring, double-sided (the ring
 * lies flat and is seen from above AND from a low orbit). */
export function ringMaterialFor(tintHex: string): MeshBasicMaterial {
  let material = ringMaterials.get(tintHex)
  if (!material) {
    material = new MeshBasicMaterial({
      color: tintHex,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    })
    ringMaterials.set(tintHex, material)
  }
  return material
}

/** Test/QA: how many tint materials have been built. */
export function ringMaterialCount(): number {
  return ringMaterials.size
}

/*
 * ROUND-2 HOOK POINTS in remote-players.tsx (not touched tonight — that file
 * belongs to the motion lane in round 1):
 *   - RemotePlayers({ spectator = false }) → <RemoteAvatar spectator …/>;
 *     spectator.tsx mounts <RemotePlayers spectator/>.
 *   - RemoteAvatar: `ringRef = useRef<Mesh>(null)`, `lastTagScale = useRef(1)`.
 *   - useFrame tag block: `opacity = spectator ? spectatorTagOpacity(distSq)
 *     : tagOpacity(distSq)`; when visible && spectator:
 *       s = tagScale(worldPerPixel(camera, Math.sqrt(distSq), rootState.size.height))
 *       if |s − lastTagScale| > 0.02: tag.scale.setScalar(s); tag.position.y =
 *       tagLiftY(s); ring.scale.set(s, s, 1)
 *       ring.visible = ringVisible(s)     (one sqrt per avatar per frame, no allocs)
 *   - tag JSX: <mesh raycast={noopRaycast} renderOrder={tagRenderOrder(spectator)}>
 *     with <meshBasicMaterial … depthTest={tagDepthTest(spectator)}/>; the speak
 *     dot gets the same renderOrder + raycast.
 *   - under the root, spectator only: <mesh ref={ringRef} geometry={ringGeometry()}
 *     material={ringMaterialFor(tint)} rotation={[-Math.PI/2,0,0]}
 *     position={[0,0.02,0]} renderOrder={SPECTATOR_RING_RENDER_ORDER}
 *     visible={false} raycast={noopRaycast}/>  (`spectator` is constant for the
 *     component's life; it is not a light, so the conditional mount is fine).
 *   - makeNameTexture: 512×128 canvas, roundRect(8,16,496,96,24), lineWidth 8,
 *     font `bold ${tagFontPx((px) => measure(px), 470)}px`, fillText at (256,66).
 */
