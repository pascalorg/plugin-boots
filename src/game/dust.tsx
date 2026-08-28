'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import {
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  NormalBlending,
  Quaternion,
  Vector3,
} from 'three'
import { createProbeMemo } from './probe-memo'

/**
 * Impact dust + lingering haze. Two ring buffers of camera-facing quads on
 * shared InstancedMeshes (one draw call each). Dust OBSCURES, it does not
 * emit: NormalBlending, warm gypsum gray-beige, per-instance alpha through
 * an InstancedBufferAttribute (small onBeforeCompile injection), depthWrite
 * off so puffs never z-fight. Three irregular multi-lobe blob textures live
 * side by side in one atlas; each quad picks a tile at spawn. Zero
 * allocations per frame; strict caps.
 *
 * API (callers should feature-check the named exports):
 *   spawnDust(position, intensity, opts?) — impact dust at a world point.
 *     intensity 0..1. opts.kind takes a SHAPE or a MATERIAL:
 *     shapes —
 *       'chip'  — 1 tiny short-lived fleck (non-wall bullet hits)
 *       'puff'  — 2–3 quads, ~1 s (default; also what legacy calls get)
 *       'plume' — 6–9 big quads, 2.5–4 s + one auto haze (drywall tears)
 *     materials (phase 4 — emit these from destruction's per-removal tag) —
 *       'drywall'  — full gypsum behavior: puff, upgrading to plume
 *                    (+ auto haze) at intensity ≥ 0.7 (heavy tears)
 *       'concrete' — small-but-present: half-size, shorter-lived, grayer
 *                    puffs (also the CMU/generic-voxel voice)
 *       'wood'     — NO dust at all (returns early — wood reads as
 *                    splinters from debris alone)
 *       'paint'    — aerosol mist (the sprayer, phase 9): fine short-lived
 *                    puffs wearing opts.tint PURE (no pulverized-gray
 *                    blend — mist is pigment, not debris)
 *     opts.normal/direction aim a ~35° cone around
 *     normal*0.8 + direction*0.2; with neither, the old 360° ring is used.
 *     Legacy scalar form spawnDust(x, y, z, intensity, kind?) is still
 *     accepted (5th arg optional, shape or material).
 *   spawnHaze(position, radius?) — one large, faint, slow-rising quad,
 *     ~2.4–3.4 s — call ONCE per crumble/collapse. Legacy (x, y, z)
 *     accepted. Radius is clamped to HAZE_MAX_RADIUS, and haze quads fade
 *     out entirely near the camera (hazeNearFade) — a lingering billboard
 *     centered in a carve breach must NEVER read as a solid wall plugging
 *     the hole (owner mid-surface round 2026-08-26: the "unbreakable
 *     surface" was exactly this quad).
 *   clearDust() — session teardown (also runs on <DustSystem/> unmount).
 *   <DustSystem/> — renders both pools; mount in the game-root fragment.
 */

const PUFF_CAP = 256
const HAZE_CAP = 24
/** Above this live fraction, spawns halve their counts (minigun guard). */
const PRESSURE = 0.7

export type DustKind = 'chip' | 'puff' | 'plume'

/** Material tags (phase 4; 'paint' = the sprayer's aerosol mist, phase 9) —
 * what destruction/collapse/paint emit per removal or spray tick. */
export type DustMaterial = 'drywall' | 'concrete' | 'wood' | 'paint'

/** Drywall at/above this intensity upgrades from puff to plume (+haze). */
const DRYWALL_HEAVY = 0.7

/**
 * Haze anti-"fake wall" guards (owner mid-surface round 2026-08-26): after
 * a heavy drywall carve, the auto-haze quad sat centered in the breach for
 * 4–6 s at ~0.3 alpha and 5–8 m across — through the hole it read as a
 * solid gray speckled surface, and every follow-up shot re-seeded it, so
 * the breach looked permanently plugged by an unbreakable mid-wall layer.
 * Caps below keep haze an atmosphere, never a surface.
 */
/** Hard cap on a haze quad's base radius (m) — plume auto-haze asked 3.6. */
export const HAZE_MAX_RADIUS = 2.4
/** Camera distance (m) at/below which a haze quad is fully invisible. */
export const HAZE_NEAR_DEAD = 0.9
/** Camera distance (m) at/above which a haze quad is fully opaque. */
export const HAZE_NEAR_FULL = 2.4

/**
 * Proximity multiplier for haze alpha: 0 at ≤ HAZE_NEAR_DEAD, 1 at
 * ≥ HAZE_NEAR_FULL, smoothstep between — walking up to (or through) a
 * breach dissolves the veil before it can read as a solid plane.
 */
export function hazeNearFade(distance: number): number {
  if (distance <= HAZE_NEAR_DEAD) return 0
  if (distance >= HAZE_NEAR_FULL) return 1
  const t = (distance - HAZE_NEAR_DEAD) / (HAZE_NEAR_FULL - HAZE_NEAR_DEAD)
  return t * t * (3 - 2 * t)
}

export type DustOpts = {
  /** Surface normal at the impact — main axis of the ejection cone. */
  normal?: Vector3
  /** Shot/travel direction — bends the cone slightly downrange. */
  direction?: Vector3
  kind?: DustKind | DustMaterial
  /** Base color override (working space) — item carves pass the sampled palette average. */
  tint?: { r: number; g: number; b: number }
}

type QuadSlot = {
  alive: boolean
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  /** Base quad size (m); the life curve scales it up as it disperses. */
  size: number
  /** Roll around the view axis + its angular speed — cheap variety. */
  roll: number
  spin: number
  /** Peak opacity 0..1 — dust obscures, it never emits. */
  alpha: number
  /** Per-quad brightness jitter on the base color. */
  shade: number
  /** Base color (gypsum by default; concrete quads go grayer). */
  cr: number
  cg: number
  cb: number
  /** Which of the 3 atlas tiles this quad samples. */
  tile: number
  /** Air-drag coefficient (chips brake hard, plumes hang). */
  drag: number
  /** Landing plane the quad settles onto (one-shot probe at spawn) — a
   * plume upstairs sinks to the upper floor, not through the slab. */
  floor: number
  ttl: number
  ttl0: number
}

/** Warm gypsum gray-beige (#b7b0a4) — drywall core, not smoke, not glow. */
const DUST_R = 0.718
const DUST_G = 0.69
const DUST_B = 0.643

/** Concrete/CMU carve gray (#9e9e9b) — flatter and cooler than gypsum. */
const CONC_R = 0.62
const CONC_G = 0.62
const CONC_B = 0.607

function makePool(n: number): QuadSlot[] {
  return Array.from({ length: n }, () => ({
    alive: false,
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    size: 1,
    roll: 0,
    spin: 0,
    alpha: 0.5,
    shade: 1,
    cr: DUST_R,
    cg: DUST_G,
    cb: DUST_B,
    tile: 0,
    drag: 3.2,
    floor: 0,
    ttl: 0,
    ttl0: 1,
  }))
}

/**
 * Landing-plane probe ("floors for things", MULTILEVEL-PLAN Phase B) —
 * same injection contract as debris.setDebrisGroundProbe: (x, y, z) →
 * world Y of the highest live surface below. One probe per spawn BURST
 * (all quads of a burst share the floor), never per frame.
 */
export type DustFloorProbe = (x: number, y: number, z: number) => number
let floorProbe: DustFloorProbe | null = null
export function setDustFloorProbe(probe: DustFloorProbe | null): void {
  floorProbe = probe
  probeMemo.clear()
}

/** Post-blast probe dedupe (perf round 2026-08-27, finding B4): one boom
 * seeds 10+ bursts in a ~4 m footprint in the same frame, each probing the
 * same few floor cells — the 0.5 m-bucket memo (probe-memo.ts) collapses
 * those to one probeLandingY per cell per 400 ms. Spawns still probe
 * synchronously (the burst needs its floor at birth), so no cap here. */
const probeMemo = createProbeMemo()
/** Quad centers hover this far above their floor once settled. */
const FLOOR_REST = 0.06

const puffs = makePool(PUFF_CAP)
const haze = makePool(HAZE_CAP)
let puffCursor = 0
let hazeCursor = 0
let puffLive = 0
let hazeLive = 0

/**
 * Unit direction inside a cone of half-angle `spreadRad` around the unit
 * vector `axis`. u1/u2 in [0,1) (u1 → polar via sqrt for even area
 * coverage, u2 → azimuth). Pure — exported for tests.
 */
export function coneDirection(
  out: Vector3,
  axis: Vector3,
  spreadRad: number,
  u1: number,
  u2: number,
): Vector3 {
  // Orthonormal basis around the axis (pick the helper least aligned).
  const ax = Math.abs(axis.x)
  const ay = Math.abs(axis.y)
  let hx = 0
  let hy = 0
  let hz = 0
  if (ax <= ay && ax <= Math.abs(axis.z)) hx = 1
  else if (ay <= Math.abs(axis.z)) hy = 1
  else hz = 1
  // u = normalize(axis × helper), w = axis × u
  let ux = axis.y * hz - axis.z * hy
  let uy = axis.z * hx - axis.x * hz
  let uz = axis.x * hy - axis.y * hx
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul
  uy /= ul
  uz /= ul
  const wx = axis.y * uz - axis.z * uy
  const wy = axis.z * ux - axis.x * uz
  const wz = axis.x * uy - axis.y * ux
  const phi = spreadRad * Math.sqrt(u1)
  const theta = u2 * Math.PI * 2
  const sp = Math.sin(phi)
  const cp = Math.cos(phi)
  const ct = Math.cos(theta)
  const st = Math.sin(theta)
  out.set(
    axis.x * cp + (ux * ct + wx * st) * sp,
    axis.y * cp + (uy * ct + wy * st) * sp,
    axis.z * cp + (uz * ct + wz * st) * sp,
  )
  return out.normalize()
}

const CONE_SPREAD = (35 * Math.PI) / 180
const _axis = new Vector3()
const _vel = new Vector3()

export function spawnDust(position: Vector3, intensity: number, opts?: DustOpts): void
/** Legacy scalar form — kind optional (shape or material), default 'puff'. */
export function spawnDust(
  x: number,
  y: number,
  z: number,
  intensity: number,
  kind?: DustKind | DustMaterial,
): void
export function spawnDust(
  a: Vector3 | number,
  b?: number,
  c?: number | DustOpts,
  d?: number,
  e?: DustKind | DustMaterial,
): void {
  let x: number
  let y: number
  let z: number
  let intensity: number
  let opts: DustOpts | undefined
  let rawKind: DustKind | DustMaterial
  if (typeof a === 'number') {
    x = a
    y = b ?? 0
    z = typeof c === 'number' ? c : 0
    intensity = d ?? 0.5
    rawKind = e ?? 'puff'
  } else {
    x = a.x
    y = a.y
    z = a.z
    intensity = b ?? 0.5
    opts = typeof c === 'object' ? c : undefined
    rawKind = opts?.kind ?? 'puff'
  }
  // Wood never dusts — splinters read from debris alone (material contract).
  if (rawKind === 'wood') return
  const k = Math.min(1, Math.max(0, intensity))
  // Resolve material tags to a shape + styling. Drywall keeps the full
  // gypsum behavior (plume + auto haze once the tear is heavy); concrete
  // stays a puff but goes half-size, shorter-lived and grayer below.
  const concrete = rawKind === 'concrete'
  const paint = rawKind === 'paint'
  let kind: DustKind
  if (rawKind === 'drywall') kind = k >= DRYWALL_HEAVY ? 'plume' : 'puff'
  else if (rawKind === 'concrete' || rawKind === 'paint') kind = 'puff'
  else kind = rawKind

  // Ejection axis: cone around normal*0.8 + direction*0.2 (either alone
  // works too); with no vectors at all, fall back to the old 360° ring.
  let hasAxis = false
  if (opts?.normal) {
    _axis.copy(opts.normal).multiplyScalar(0.8)
    if (opts.direction) _axis.addScaledVector(opts.direction, 0.2)
    hasAxis = _axis.lengthSq() > 1e-8
  } else if (opts?.direction) {
    _axis.copy(opts.direction)
    hasAxis = _axis.lengthSq() > 1e-8
  }
  if (hasAxis) _axis.normalize()

  let count: number
  if (kind === 'chip') count = 1
  else if (kind === 'puff') count = 2 + (Math.random() < 0.5 ? 1 : 0)
  else count = 6 + Math.floor(Math.random() * 4)
  // Pool pressure: halve counts once the pool runs hot (minigun guard).
  if (puffLive > PUFF_CAP * PRESSURE) count = Math.max(1, count >> 1)

  const jitter = kind === 'plume' ? 0.45 : 0.2
  const floorY = floorProbe ? probeMemo.get(floorProbe, x, y, z) : 0
  for (let n = 0; n < count; n++) {
    const s = puffs[puffCursor]!
    puffCursor = (puffCursor + 1) % PUFF_CAP
    if (!s.alive) puffLive++
    s.alive = true
    s.px = x + (Math.random() - 0.5) * jitter
    s.py = y + (Math.random() - 0.5) * jitter
    s.pz = z + (Math.random() - 0.5) * jitter
    let speed: number
    if (kind === 'chip') {
      speed = 0.6 + Math.random() * 0.6
      s.size = 0.22 + k * 0.2 + Math.random() * 0.1
      s.alpha = 0.4 + k * 0.1
      s.drag = 6.5
      s.ttl = 0.4
    } else if (kind === 'puff') {
      speed = 0.8 + Math.random() * 0.8
      s.size = 0.35 + k * 0.7 + Math.random() * 0.25
      s.alpha = 0.42 + k * 0.13
      s.drag = 3.2
      s.ttl = 0.8 + Math.random() * 0.4
    } else {
      speed = 1.2 + Math.random() * 1.0
      s.size = 1.2 + Math.random() * 1.4
      s.alpha = 0.4 + k * 0.15
      s.drag = 1.5
      s.ttl = 2.5 + Math.random() * 1.5
    }
    if (concrete) {
      // Small-but-present: half-size, shorter-lived, brakes a bit harder.
      s.size *= 0.5
      s.ttl = 0.4 + Math.random() * 0.25
      s.alpha = 0.36 + k * 0.1
      s.drag = 4.2
    } else if (paint) {
      // Aerosol mist: fine, quick, braking hard — droplets, not dust.
      s.size *= 0.35
      s.ttl = 0.22 + Math.random() * 0.14
      s.alpha = 0.3 + k * 0.12
      s.drag = 5.2
    }
    // Item carves pass a sampled palette tint — blended toward the concrete
    // gray so the cloud reads as pulverized material, not confetti. Paint
    // mist wears the tint PURE: pigment, not debris.
    const tint = opts?.tint
    if (tint && paint) {
      s.cr = tint.r
      s.cg = tint.g
      s.cb = tint.b
    } else {
      s.cr = tint ? tint.r * 0.65 + CONC_R * 0.35 : concrete ? CONC_R : DUST_R
      s.cg = tint ? tint.g * 0.65 + CONC_G * 0.35 : concrete ? CONC_G : DUST_G
      s.cb = tint ? tint.b * 0.65 + CONC_B * 0.35 : concrete ? CONC_B : DUST_B
    }
    if (hasAxis) {
      coneDirection(_vel, _axis, CONE_SPREAD, Math.random(), Math.random())
      s.vx = _vel.x * speed
      s.vy = _vel.y * speed
      s.vz = _vel.z * speed
    } else {
      const theta = Math.random() * Math.PI * 2
      s.vx = Math.cos(theta) * speed * 0.7
      s.vy = 0.2 + Math.random() * 0.5
      s.vz = Math.sin(theta) * speed * 0.7
    }
    s.roll = Math.random() * Math.PI * 2
    s.spin = (Math.random() - 0.5) * (kind === 'plume' ? 0.8 : 1.6)
    s.shade = 0.9 + Math.random() * 0.16
    s.tile = Math.floor(Math.random() * 3)
    s.floor = floorY
    s.ttl0 = s.ttl
  }

  // A drywall plume owns the room: one lingering haze sheet comes free.
  if (kind === 'plume') spawnHazeAt(x, y + 0.3, z, 2.2 + k * 1.4)
}

export function spawnHaze(position: Vector3, radius?: number): void
/** Legacy scalar form. */
export function spawnHaze(x: number, y: number, z: number): void
export function spawnHaze(a: Vector3 | number, b?: number, c?: number): void {
  if (typeof a === 'number') spawnHazeAt(a, b ?? 0, c ?? 0, undefined)
  else spawnHazeAt(a.x, a.y, a.z, b)
}

function spawnHazeAt(x: number, y: number, z: number, radius?: number): void {
  const s = haze[hazeCursor]!
  hazeCursor = (hazeCursor + 1) % HAZE_CAP
  if (!s.alive) hazeLive++
  s.alive = true
  s.px = x + (Math.random() - 0.5) * 0.6
  s.py = y + 0.2
  s.pz = z + (Math.random() - 0.5) * 0.6
  s.vx = (Math.random() - 0.5) * 0.1
  s.vy = 0.1 + Math.random() * 0.08
  s.vz = (Math.random() - 0.5) * 0.1
  // Clamp + soften (see HAZE_MAX_RADIUS block): atmosphere, never a surface.
  s.size = Math.min(radius ?? 2.4 + Math.random() * 1.2, HAZE_MAX_RADIUS) * (0.9 + Math.random() * 0.2)
  s.roll = Math.random() * Math.PI * 2
  s.spin = (Math.random() - 0.5) * 0.24
  s.alpha = 0.17 + Math.random() * 0.05
  s.shade = 0.95 + Math.random() * 0.1
  s.cr = DUST_R
  s.cg = DUST_G
  s.cb = DUST_B
  s.tile = Math.floor(Math.random() * 3)
  s.drag = 0
  s.floor = 0 // haze only drifts UP — the clamp never applies
  s.ttl = 2.4 + Math.random()
  s.ttl0 = s.ttl
}

export function clearDust(): void {
  for (const s of puffs) s.alive = false
  for (const s of haze) s.alive = false
  puffLive = 0
  hazeLive = 0
}

/** Live-quad counts — pool-pressure introspection for tests/debug. */
export function dustCounts(): { puffs: number; haze: number } {
  return { puffs: puffLive, haze: hazeLive }
}

/**
 * Plain-data dump for the `__boots.dust()` debug handle (game-root
 * feature-detects this export). Counts + caps + per-live-haze metadata
 * (the anti-"fake wall" caps are QA-visible) — never live refs.
 */
export function dustDebug(): Record<string, unknown> {
  return {
    puffs: puffLive,
    haze: hazeLive,
    puffCap: PUFF_CAP,
    hazeCap: HAZE_CAP,
    hazeMeta: haze
      .filter((s) => s.alive)
      .map((s) => ({ size: s.size, ttl: s.ttl, alpha: s.alpha })),
    // Floors-for-things QA: per-live-puff height vs its probed floor —
    // no live puff should ever sit below floor (it settles ON the slab).
    puffMeta: puffs
      .filter((s) => s.alive)
      .map((s) => ({ y: +s.py.toFixed(3), floor: +s.floor.toFixed(3) })),
  }
}

// --- Rendering ---------------------------------------------------------

const TILE = 128
const TILES = 3
let dustTexture: CanvasTexture | null = null

/** Tiny deterministic PRNG so the atlas draws the same every session. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 3-tile atlas of irregular multi-lobe dust blobs — off-center lobes, noisy
 * rims, a few punched-out holes — drawn once, no assets. Each quad picks a
 * tile at spawn via the instanceTile attribute.
 */
function getDustTexture(): CanvasTexture | null {
  if (dustTexture) return dustTexture
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = TILE * TILES
  canvas.height = TILE
  const g = canvas.getContext('2d')!
  for (let t = 0; t < TILES; t++) {
    const rand = mulberry32(1013 + t * 977)
    const ox = t * TILE
    const c = TILE / 2
    g.save()
    g.beginPath()
    g.rect(ox, 0, TILE, TILE)
    g.clip()
    // Soft off-center core.
    const cx = ox + c + (rand() - 0.5) * TILE * 0.12
    const cy = c + (rand() - 0.5) * TILE * 0.12
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, TILE * 0.42)
    core.addColorStop(0, 'rgba(255,255,255,0.7)')
    core.addColorStop(0.45, 'rgba(255,255,255,0.34)')
    core.addColorStop(0.75, 'rgba(255,255,255,0.1)')
    core.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = core
    g.fillRect(ox, 0, TILE, TILE)
    // Off-center lobes — overlapping puffs must not read as one round ball.
    const lobes = 6 + Math.floor(rand() * 3)
    for (let i = 0; i < lobes; i++) {
      const angle = rand() * Math.PI * 2
      const dist = TILE * (0.08 + rand() * 0.22)
      const bx = cx + Math.cos(angle) * dist
      const by = cy + Math.sin(angle) * dist
      const r = TILE * (0.1 + rand() * 0.14)
      const blob = g.createRadialGradient(bx, by, 0, bx, by, r)
      blob.addColorStop(0, `rgba(255,255,255,${0.16 + rand() * 0.18})`)
      blob.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = blob
      g.beginPath()
      g.arc(bx, by, r, 0, Math.PI * 2)
      g.fill()
    }
    // Rim noise — many faint specks so the silhouette turns ragged.
    for (let i = 0; i < 13; i++) {
      const angle = rand() * Math.PI * 2
      const dist = TILE * (0.26 + rand() * 0.16)
      const bx = cx + Math.cos(angle) * dist
      const by = cy + Math.sin(angle) * dist
      const r = TILE * (0.03 + rand() * 0.05)
      const speck = g.createRadialGradient(bx, by, 0, bx, by, r)
      speck.addColorStop(0, `rgba(255,255,255,${0.08 + rand() * 0.08})`)
      speck.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = speck
      g.beginPath()
      g.arc(bx, by, r, 0, Math.PI * 2)
      g.fill()
    }
    // Punched holes — real dust clouds have gaps, not solid cores.
    g.globalCompositeOperation = 'destination-out'
    const holes = 2 + Math.floor(rand() * 3)
    for (let i = 0; i < holes; i++) {
      const angle = rand() * Math.PI * 2
      const dist = TILE * (0.06 + rand() * 0.2)
      const bx = cx + Math.cos(angle) * dist
      const by = cy + Math.sin(angle) * dist
      const r = TILE * (0.05 + rand() * 0.08)
      const hole = g.createRadialGradient(bx, by, 0, bx, by, r)
      hole.addColorStop(0, `rgba(0,0,0,${0.35 + rand() * 0.3})`)
      hole.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = hole
      g.beginPath()
      g.arc(bx, by, r, 0, Math.PI * 2)
      g.fill()
    }
    g.globalCompositeOperation = 'source-over'
    g.restore()
  }
  dustTexture = new CanvasTexture(canvas)
  return dustTexture
}

/**
 * Minimal meshBasicMaterial patch: per-instance alpha + atlas-tile pick.
 * Kept to three verified anchor strings (r185).
 */
function injectDustShader(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float instanceAlpha;\nattribute float instanceTile;\nvarying float vDustAlpha;',
    )
    .replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv.x = ( vMapUv.x + instanceTile ) / 3.0;\n#endif\nvDustAlpha = instanceAlpha;',
    )
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vDustAlpha;')
    .replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      'vec4 diffuseColor = vec4( diffuse, opacity * vDustAlpha );',
    )
}

const _matrix = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
const _quat = new Quaternion()
const _roll = new Quaternion()
const _viewAxis = new Vector3(0, 0, 1)
const _color = new Color()
const ZERO = new Matrix4().makeScale(0, 0, 0)

/** After this age (s), quads pick up a light settle — bloom, then sink. */
const SETTLE_AGE = 0.3
const SETTLE_GRAVITY = 0.4

/**
 * Advance one pool + upload matrices/colors/alphas. Growth: quads start
 * small and disperse to ~2.2× base size; fade-in is a snap (~10% of life),
 * fade-out eases across the rest — dust blooms then hangs. Fade rides the
 * per-instance alpha attribute (NormalBlending), never the color. Haze
 * quads (isPuff false) additionally multiply in hazeNearFade(camera
 * distance) so a close-up billboard can never read as a solid wall.
 */
function stepPool(
  pool: QuadSlot[],
  mesh: InstancedMesh,
  dt: number,
  camQuat: Quaternion,
  isPuff: boolean,
  camPos?: Vector3,
): number {
  const alphaAttr = mesh.geometry.getAttribute('instanceAlpha') as InstancedBufferAttribute
  const tileAttr = mesh.geometry.getAttribute('instanceTile') as InstancedBufferAttribute
  let live = 0
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i]!
    if (!s.alive) continue
    s.ttl -= dt
    if (s.ttl <= 0) {
      s.alive = false
      mesh.setMatrixAt(i, ZERO)
      alphaAttr.array[i] = 0
      continue
    }
    live++
    if (isPuff) {
      const drag = 1 / (1 + s.drag * dt)
      s.vx *= drag
      s.vy *= drag
      s.vz *= drag
      // Light gravity after the bloom so plumes rise, hang, then sink.
      if (s.ttl0 - s.ttl > SETTLE_AGE) s.vy -= SETTLE_GRAVITY * dt
    }
    s.px += s.vx * dt
    s.py += s.vy * dt
    s.pz += s.vz * dt
    // Settle ON the spawn-probed floor — a plume never sinks through the
    // slab it was kicked up from (setDustFloorProbe).
    if (isPuff && s.py < s.floor + FLOOR_REST) {
      s.py = s.floor + FLOOR_REST
      if (s.vy < 0) s.vy = 0
    }
    s.roll += s.spin * dt
    const k = 1 - s.ttl / s.ttl0 // 0 → 1 over life
    const grow = s.size * (0.55 + 1.65 * k)
    let fade = Math.min(1, k / 0.1) * (1 - k) * (1 - k)
    if (!isPuff && camPos) {
      const ddx = s.px - camPos.x
      const ddy = s.py - camPos.y
      const ddz = s.pz - camPos.z
      fade *= hazeNearFade(Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz))
    }
    _roll.setFromAxisAngle(_viewAxis, s.roll)
    _quat.copy(camQuat).multiply(_roll)
    _pos.set(s.px, s.py, s.pz)
    _scale.set(grow, grow, 1)
    _matrix.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _matrix)
    _color.setRGB(s.cr * s.shade, s.cg * s.shade, s.cb * s.shade)
    mesh.setColorAt(i, _color)
    alphaAttr.array[i] = s.alpha * fade
    tileAttr.array[i] = s.tile
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  alphaAttr.needsUpdate = true
  tileAttr.needsUpdate = true
  return live
}

function initMesh(mesh: InstancedMesh, cap: number): void {
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  _color.setRGB(DUST_R, DUST_G, DUST_B)
  for (let i = 0; i < mesh.count; i++) {
    mesh.setMatrixAt(i, ZERO)
    // Prime instanceColor before the first draw — a WebGPU pipeline compiled
    // without it ignores every later setColorAt, leaving dust pure white
    // instead of the warm gypsum tint (wiring finding, 2026-08-25).
    mesh.setColorAt(i, _color)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.frustumCulled = false
  const alpha = new InstancedBufferAttribute(new Float32Array(cap), 1)
  alpha.setUsage(DynamicDrawUsage)
  mesh.geometry.setAttribute('instanceAlpha', alpha)
  const tile = new InstancedBufferAttribute(new Float32Array(cap), 1)
  tile.setUsage(DynamicDrawUsage)
  mesh.geometry.setAttribute('instanceTile', tile)
}

export function DustSystem() {
  const puffRef = useRef<InstancedMesh>(null!)
  const hazeRef = useRef<InstancedMesh>(null!)
  const texture = getDustTexture()

  useLayoutEffect(() => {
    if (!texture) return
    initMesh(puffRef.current, PUFF_CAP)
    initMesh(hazeRef.current, HAZE_CAP)
    return clearDust
  }, [texture])

  useFrame((state, rawDt) => {
    const puffMesh = puffRef.current
    const hazeMesh = hazeRef.current
    if (!puffMesh || !hazeMesh) return
    if (puffLive === 0 && hazeLive === 0) return
    const dt = Math.min(rawDt, 1 / 30)
    const camQuat = state.camera.quaternion
    puffLive = stepPool(puffs, puffMesh, dt, camQuat, true)
    hazeLive = stepPool(haze, hazeMesh, dt, camQuat, false, state.camera.position)
  })

  if (!texture) return null
  return (
    <group userData={{ __boots: true }}>
      <instancedMesh args={[undefined, undefined, PUFF_CAP]} ref={puffRef} userData={{ __boots: true }}>
        <planeGeometry />
        <meshBasicMaterial
          blending={NormalBlending}
          depthWrite={false}
          map={texture}
          onBeforeCompile={injectDustShader}
          toneMapped={false}
          transparent
        />
      </instancedMesh>
      <instancedMesh args={[undefined, undefined, HAZE_CAP]} ref={hazeRef} userData={{ __boots: true }}>
        <planeGeometry />
        <meshBasicMaterial
          blending={NormalBlending}
          depthWrite={false}
          map={texture}
          onBeforeCompile={injectDustShader}
          toneMapped={false}
          transparent
        />
      </instancedMesh>
    </group>
  )
}
