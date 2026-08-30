'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  type BufferAttribute,
  type BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  type InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
  Vector3,
} from 'three'
import { spawnDust } from './dust'
import { createProbeMemo } from './probe-memo'

/**
 * One global ring buffer of falling debris. Debris-feel rework (owner ask,
 * 2026-08-29): "pieces of stuff falling with gravity, not meaningless
 * rotation of cubes" — chunk debris now draws as a small family of SHARD
 * geometries (broken plate / two irregular chunks / splinter, picked per
 * spawn by a deterministic-ish hash, ±30% scale variation) and moves
 * gravity-first: launch is outward with barely any loft, tumble is slow
 * (≤ ~2 rad/s, biased about one horizontal axis like a flipping plate),
 * the first ground slap eats most of the remaining spin and a settled
 * piece stops rotating entirely (so plates rest flat-ish instead of
 * jittering). Spin also bleeds out over the last 20% of life for pieces
 * that never land. Ballistics stay hand-rolled: gravity + one damped
 * ground bounce, shrink-out at end of life, no physics engine.
 *
 * RENDER: one pooled InstancedMesh PER SHAPE (4 shard pools + the flat
 * drywall pool = 5 draw calls, capped). Live pieces are DENSE-PACKED into
 * the head of each pool every frame — matrices/colors are written for live
 * pieces only, `count` trims the draw to exactly what's alive, and both
 * attributes flip needsUpdate only when a pool actually holds pieces
 * (idle pools upload nothing — the voxel-walls storage-flag discipline;
 * instanceMatrix is flagged as a WebGPU storage attribute so uploads are
 * version-gated instead of every-frame). Each pool carries a per-frame
 * bounding sphere over its live pieces (+margin) and frustum-culls —
 * debris is local to the action. An empty pool sets the three empty-sphere
 * convention (radius −1: always culled). The first WARM_FRAMES draw one
 * zero-scaled instance per pool uncullled so the WebGPU pipelines (WITH
 * instanceColor) compile before the first real break.
 *
 * Flat drywall/roof plates (spawnFlatDebris) keep their shipped papery
 * behavior untouched: strong air drag, reduced effective gravity, slow
 * fluttery tumble with tilt-driven side-slip, slap-down settle + one dust
 * chip. They ride their own unit-cube pool (non-uniform scale makes the
 * sliver).
 *
 * API (callers may feature-check the named exports):
 *   spawnDebris(x, y, z, size, color, speed, ttl?, dir?) — shard chunk.
 *     `dir` (unit-ish vector) biases the launch velocity along it —
 *     ceiling material pops DOWN through the hole, not up. Shape, scale
 *     variation and tumble axis derive from debrisSpawnHash(x, y, z, seq)
 *     — same spawn sequence after clearDebris() ⇒ same shapes.
 *   spawnFlatDebris(x, y, z, w, h, color, dir?, tone?) — drywall/paper
 *     plate, w×h meters (torn-edge xy jitter), slow flutter, ~3s life, one
 *     tiny chip puff on its first ground slap. Live plates cap at 120 —
 *     the plate closest to expiry gets reused first. `dir` as above (a
 *     torn ceiling board leaves its face along −Y). `tone` picks the
 *     shade treatment: default 'drywall' keeps the bright symmetric
 *     jitter; 'shingle' (roof sheets, MULTILEVEL-PLAN Phase C) darkens +
 *     desaturates every shard below the base color — torn roofing reads
 *     older/dirtier than fresh gypsum.
 *   debrisCensus()                                  — headless test probe:
 *     live slot count + flat count + mean launch vy of live pieces.
 *   clearDebris()                                   — session teardown.
 */

const CAPACITY = 768

// ── Shard shapes ────────────────────────────────────────────────────────────
/** Broken flat plate, ~2:2:0.4 — a floor-tile / sheathing bite. */
export const SHAPE_PLATE = 0
/** Irregular chunk A — box with two corners bitten off. */
export const SHAPE_CHUNK_A = 1
/** Irregular chunk B — squatter box, three bitten corners. */
export const SHAPE_CHUNK_B = 2
/** Splinter, ~3:0.6:0.6 with a pinched tip. */
export const SHAPE_SPLINTER = 3
export const SHARD_SHAPE_COUNT = 4
/** Pool index of the flat drywall-plate mesh (after the shard pools). */
const FLAT_POOL = SHARD_SHAPE_COUNT
const POOL_COUNT = SHARD_SHAPE_COUNT + 1

/** Per-pool draw caps — matrices beyond the cap simply skip a frame's draw
 * (pieces keep simulating). 4×256 shards + 128 flats ≥ the 768-slot ring. */
const SHARD_DRAW_CAP = 256
const FLAT_DRAW_CAP = 128

/** Slow-tumble band for shard chunks (rad/s, dominant axis) — the fix for
 * "meaningless rotation": pieces FALL, they don't pinwheel. Old spin was
 * uniform ±4.5 rad/s per axis. */
export const SHARD_SPIN_MIN = 0.8
export const SHARD_SPIN_MAX = 2.0
/** Off-axis wobble (rad/s) — the tumble stays biased about ONE axis. */
export const SHARD_SPIN_OFF = 0.3
/** Per-spawn scale variation: ±30% around the caller's size. */
export const SHARD_SCALE_VAR = 0.3
/** Spin bleeds to nothing over this trailing fraction of a chunk's life. */
const SPIN_FADE = 0.2
/** Resting half-height per shape, × slot scale (plate/chunkA/chunkB/splinter). */
const SHAPE_REST = [0.18, 0.42, 0.45, 0.16] as const

type DebrisSlot = {
  alive: boolean
  /** Flat-plate mode: flutter physics + non-uniform scale. */
  flat: boolean
  /** Shard geometry pool (SHAPE_*) — ignored while `flat`. */
  shape: number
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  rx: number
  ry: number
  rz: number
  wx: number
  wy: number
  wz: number
  /** Draw scale per axis (shards: uniform; plates: w × h × sliver). */
  sx: number
  sy: number
  sz: number
  /** Landing plane + rest half-height — the y the piece settles at. */
  ground: number
  /** Rest half-height alone (ground = landing plane Y + rest). */
  rest: number
  /** One-shot landing probe done (fires at apex, see useFrame). */
  probed: boolean
  ttl: number
  ttl0: number
  bounced: boolean
}

const slots: DebrisSlot[] = Array.from({ length: CAPACITY }, () => ({
  alive: false,
  flat: false,
  shape: 0,
  px: 0,
  py: 0,
  pz: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  wx: 0,
  wy: 0,
  wz: 0,
  sx: 0.1,
  sy: 0.1,
  sz: 0.1,
  ground: 0.05,
  rest: 0.05,
  probed: false,
  ttl: 0,
  ttl0: 1,
  bounced: false,
}))
const colors: Color[] = Array.from({ length: CAPACITY }, () => new Color(1, 1, 1))
let cursor = 0
let liveCount = 0
/** Spawn ordinal mixed into the shape hash (reset by clearDebris so test
 * sequences are reproducible) — spreads shapes even when a burst spawns
 * many pieces at the same point. */
let spawnSeq = 0

/**
 * Landing-plane probe ("floors for things", MULTILEVEL-PLAN Phase B):
 * (x, y, z) → world Y of the highest live surface below. Injected per
 * session by game-root (destruction.probeLandingY over colliders + voxel
 * targets) so this module keeps zero scene knowledge. Each piece probes
 * ONCE, at its apex — by then it has drifted clear of the face it was torn
 * from, so upper-storey debris lands on the upper floor, not the terrain.
 * Off-slab horizontal drift after the probe is accepted (the plan defers
 * true debris-vs-voxel collision forever).
 */
export type DebrisGroundProbe = (x: number, y: number, z: number) => number
let groundProbe: DebrisGroundProbe | null = null
export function setDebrisGroundProbe(probe: DebrisGroundProbe | null): void {
  groundProbe = probe
  probeMemo.clear()
}

/**
 * Post-blast probe burst guard (perf round 2026-08-27, finding B4): a
 * grenade's carves + crumbles put 100–200 pieces in the air within a
 * second, each due one apex probe — and probeLandingY walks ALL colliders
 * plus a DDA per call. Two layers keep that off the detonation frames:
 * a 0.5 m-bucket memo (blast debris shares a footprint — see probe-memo.ts)
 * and a per-frame cap on MISSES; a piece past the cap simply keeps falling
 * un-probed and retries next frame (holding the default plane one extra
 * frame is invisible). Steady-state single shots are untouched — a lone
 * piece probes the frame it crests, exactly as before.
 */
const probeMemo = createProbeMemo()
const MAX_PROBE_MISSES_PER_FRAME = 8

/** Deterministic spawn hash — integer avalanche over the 1 cm-quantized
 * spawn point and the spawn ordinal. Drives shape pick, scale variation
 * and tumble axis, so an identical spawn sequence (after clearDebris)
 * sheds identical shards while a burst at one point still gets variety. */
export function debrisSpawnHash(x: number, y: number, z: number, seq: number): number {
  let h = Math.imul(Math.round(x * 100), 0x9e3779b1)
  h ^= Math.imul(Math.round(y * 100), 0x85ebca6b)
  h ^= Math.imul(Math.round(z * 100), 0xc2b2ae35)
  h ^= Math.imul(seq | 0, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

export function spawnDebris(
  x: number,
  y: number,
  z: number,
  size: number,
  color: Color,
  speed: number,
  ttl = 2.6,
  dir?: { x: number; y: number; z: number },
): void {
  const slot = slots[cursor]!
  colors[cursor]!.copy(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08)
  cursor = (cursor + 1) % CAPACITY
  if (!slot.alive) liveCount++
  const h = debrisSpawnHash(x, y, z, spawnSeq++)
  slot.alive = true
  slot.flat = false
  slot.shape = h & 3
  slot.px = x
  slot.py = y
  slot.pz = z
  if (dir) {
    // Directional launch (sheet fly-offs): mostly along the face normal
    // with a light random spray — a torn ceiling drops its chunks DOWN.
    slot.vx = dir.x * speed + (Math.random() - 0.5) * speed * 0.5
    slot.vy = dir.y * speed + (Math.random() - 0.5) * speed * 0.3
    slot.vz = dir.z * speed + (Math.random() - 0.5) * speed * 0.5
  } else {
    // Gravity-dominant launch: outward from the break with barely any
    // loft — the piece FALLS instead of fountaining (debris-feel rework).
    const theta = Math.random() * Math.PI * 2
    const out = speed * (0.55 + Math.random() * 0.45)
    slot.vx = Math.cos(theta) * out
    slot.vy = speed * (Math.random() * 0.4 - 0.08)
    slot.vz = Math.sin(theta) * out
  }
  slot.rx = Math.random() * Math.PI
  slot.ry = Math.random() * Math.PI
  slot.rz = Math.random() * Math.PI
  // Slow tumble about ONE horizontal axis (a plate flips end over end);
  // the other axes only wobble. Axis/sign/rate ride the hash.
  const dom =
    ((h >>> 12) & 1 ? 1 : -1) *
    (SHARD_SPIN_MIN + (((h >>> 13) & 0xff) / 255) * (SHARD_SPIN_MAX - SHARD_SPIN_MIN))
  const wobbleA = (Math.random() - 0.5) * 2 * SHARD_SPIN_OFF
  if ((h >>> 21) & 1) {
    slot.wx = dom
    slot.wz = wobbleA
  } else {
    slot.wx = wobbleA
    slot.wz = dom
  }
  slot.wy = (Math.random() - 0.5) * 2 * SHARD_SPIN_OFF
  const scale = size * (1 - SHARD_SCALE_VAR + (((h >>> 2) & 0x3ff) / 0x3ff) * 2 * SHARD_SCALE_VAR)
  slot.sx = scale
  slot.sy = scale
  slot.sz = scale
  slot.rest = scale * SHAPE_REST[slot.shape]!
  slot.ground = slot.rest
  slot.probed = false
  slot.ttl = ttl * (0.7 + Math.random() * 0.6)
  slot.ttl0 = slot.ttl
  slot.bounced = false
}

/** How thin a plate shard draws (meters) — a drywall sliver, not a voxel. */
const PLATE_THICKNESS = 0.016
/** Max plate shards alive at once — beyond this the oldest gets recycled. */
const FLAT_CAP = 120

/** Shade treatment for flat shards — 'drywall' is the classic bright look,
 * 'shingle' reads darker/older (roof sheets tearing off the deck). */
export type FlatDebrisTone = 'drywall' | 'shingle'

/**
 * Flat plate shard — torn drywall paper/board. Gentle outward pop, then a
 * slow fluttery fall (air drag + tilt side-slip in the frame loop). Edges
 * read torn via independent non-uniform xy scale jitter.
 */
export function spawnFlatDebris(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  color: Color,
  dir?: { x: number; y: number; z: number },
  tone: FlatDebrisTone = 'drywall',
): void {
  // Count live plates; under cap pressure, recycle the one closest to
  // expiry instead of burning a fresh ring slot.
  let flats = 0
  let oldest = -1
  let oldestTtl = Number.POSITIVE_INFINITY
  for (let i = 0; i < CAPACITY; i++) {
    const s = slots[i]!
    if (!s.alive || !s.flat) continue
    flats++
    if (s.ttl < oldestTtl) {
      oldestTtl = s.ttl
      oldest = i
    }
  }
  let index: number
  if (flats >= FLAT_CAP && oldest >= 0) {
    index = oldest // still alive — liveCount unchanged
  } else {
    index = cursor
    cursor = (cursor + 1) % CAPACITY
    if (!slots[index]!.alive) liveCount++
  }
  const slot = slots[index]!
  if (tone === 'shingle') {
    // Weathered roofing: every shard lands BELOW the base color (one-sided
    // lightness jitter) with a touch of desaturation — darker/older than
    // the symmetric bright drywall treatment.
    colors[index]!
      .copy(color)
      .offsetHSL(0, -Math.random() * 0.08, -(0.03 + Math.random() * 0.1))
  } else {
    colors[index]!.copy(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06)
  }
  slot.alive = true
  slot.flat = true
  slot.px = x
  slot.py = y
  slot.pz = z
  const theta = Math.random() * Math.PI * 2
  const speed = 0.5 + Math.random() * 0.9
  if (dir) {
    // Face-normal launch: a board torn off a ceiling flutters DOWNWARD
    // through the hole, a wall board pops outward (spec: gravity direction
    // on shards follows the sheet's outward normal).
    slot.vx = dir.x * speed + (Math.random() - 0.5) * 0.4
    slot.vy = dir.y * speed + (Math.random() - 0.5) * 0.25
    slot.vz = dir.z * speed + (Math.random() - 0.5) * 0.4
  } else {
    slot.vx = Math.cos(theta) * speed
    slot.vy = 0.3 + Math.random() * 0.9
    slot.vz = Math.sin(theta) * speed
  }
  slot.rx = Math.random() * Math.PI
  slot.ry = Math.random() * Math.PI
  slot.rz = Math.random() * Math.PI
  // Slow flutter — plates see-saw, they don't spin like chunks.
  slot.wx = (Math.random() - 0.5) * 4.4
  slot.wy = (Math.random() - 0.5) * 1.8
  slot.wz = (Math.random() - 0.5) * 4.4
  // Torn edges: each axis shrinks independently (1.0 vs 0.7 style), so no
  // two plates keep the pristine rectangle proportions.
  slot.sx = Math.max(0.05, w) * (0.7 + Math.random() * 0.3)
  slot.sy = Math.max(0.05, h) * (0.7 + Math.random() * 0.3)
  slot.sz = PLATE_THICKNESS
  slot.rest = 0.045
  slot.ground = slot.rest
  slot.probed = false
  slot.ttl = 2.6 + Math.random() * 1.5
  slot.ttl0 = slot.ttl
  slot.bounced = false
}

export function clearDebris(): void {
  for (const slot of slots) slot.alive = false
  liveCount = 0
  spawnSeq = 0
}

/** Headless test probe — live piece count, flat-plate count, and the mean
 * CURRENT vertical velocity across live pieces / live plates (fresh spawns:
 * their launch vy). Destruction tests assert the crumble sampling cap and
 * that ceiling sheet shards leave downward, without reaching into slots. */
export function debrisCensus(): {
  live: number
  flats: number
  meanVy: number
  meanVyFlat: number
} {
  let live = 0
  let flats = 0
  let vy = 0
  let vyFlat = 0
  for (const slot of slots) {
    if (!slot.alive) continue
    live++
    vy += slot.vy
    if (slot.flat) {
      flats++
      vyFlat += slot.vy
    }
  }
  return {
    live,
    flats,
    meanVy: live > 0 ? vy / live : 0,
    meanVyFlat: flats > 0 ? vyFlat / flats : 0,
  }
}

/** Per-live-piece plain-data dump for the `__boots.debris()` handle —
 * position, resolved landing plane (`ground` = plane + rest half-height),
 * settle state, plus the debris-feel fields (shard shape, max |angular
 * velocity| component, draw scale). QA asserts upper-storey debris rests
 * on the upper floor from this; debris tests assert shape determinism and
 * the slow-tumble caps — all without traversing instance matrices. */
export function debrisDump(): Array<{
  x: number
  y: number
  z: number
  flat: boolean
  ground: number
  settled: boolean
  shape: number
  spin: number
  scale: number
}> {
  const out: Array<{
    x: number
    y: number
    z: number
    flat: boolean
    ground: number
    settled: boolean
    shape: number
    spin: number
    scale: number
  }> = []
  for (const s of slots) {
    if (!s.alive) continue
    out.push({
      x: +s.px.toFixed(3),
      y: +s.py.toFixed(3),
      z: +s.pz.toFixed(3),
      flat: s.flat,
      ground: +s.ground.toFixed(3),
      settled: s.bounced,
      shape: s.shape,
      spin: +Math.max(Math.abs(s.wx), Math.abs(s.wy), Math.abs(s.wz)).toFixed(4),
      scale: +s.sx.toFixed(4),
    })
  }
  return out
}

// ── Shard geometries ────────────────────────────────────────────────────────

/** Tiny deterministic PRNG (mulberry32) — shard geometry displacement must
 * be identical across sessions/hosts, so no Math.random in builders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Pull box corners toward the center (each corner's own crush factor) —
 * the beveled "bitten" read. BoxGeometry keeps face-major vertices at
 * ±half extents, so the sign octant identifies a vertex's corner. */
function crushCorners(geometry: BufferGeometry, rand: () => number, heavy: number): void {
  const crush = [0, 0, 0, 0, 0, 0, 0, 0]
  for (let c = 0; c < 8; c++) crush[c] = rand() * 0.1
  let c1 = Math.floor(rand() * 8)
  for (let n = 0; n < heavy; n++) {
    crush[c1] = 0.28 + rand() * 0.17
    c1 = (c1 + 2 + Math.floor(rand() * 5)) % 8
  }
  const pos = geometry.getAttribute('position') as BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const corner = (x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0)
    const k = 1 - crush[corner]!
    pos.setXYZ(i, x * k, y * k, z * k)
  }
  geometry.computeVertexNormals()
}

/**
 * Build one shard geometry (pure — a FRESH geometry per call; the pool
 * caches per mount). Unit-ish extents so the spawn `size` keeps meaning:
 *   PLATE     1 × 1 × 0.2 box, one bitten corner (a broken tile)
 *   CHUNK_A/B irregular boxes, 2–3 corners crushed (deterministic seeds)
 *   SPLINTER  1.5 × 0.28 × 0.28 with a pinched tip
 */
export function makeShardGeometry(shape: number): BufferGeometry {
  if (shape === SHAPE_PLATE) {
    const geometry = new BoxGeometry(1, 1, 0.2)
    crushCorners(geometry, mulberry32(0xb0070), 1)
    return geometry
  }
  if (shape === SHAPE_SPLINTER) {
    const geometry = new BoxGeometry(1.5, 0.28, 0.28)
    const pos = geometry.getAttribute('position') as BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      if (pos.getX(i) > 0) pos.setXYZ(i, pos.getX(i), pos.getY(i) * 0.5, pos.getZ(i) * 0.5)
    }
    geometry.computeVertexNormals()
    return geometry
  }
  if (shape === SHAPE_CHUNK_B) {
    const geometry = new BoxGeometry(0.8, 0.95, 0.85)
    crushCorners(geometry, mulberry32(0xb0072), 3)
    return geometry
  }
  const geometry = new BoxGeometry(0.95, 0.8, 0.9)
  crushCorners(geometry, mulberry32(0xb0071), 2)
  return geometry
}

// ── Frame loop ──────────────────────────────────────────────────────────────

const GRAVITY = 14
/** Flat shards: effective-gravity fraction + linear air-drag coefficient. */
const FLAT_GRAVITY = 0.4
const FLAT_DRAG = 2.4
/** Tilt-driven horizontal side-slip strength — the "flutter" drift. */
const FLUTTER = 1.1
/** Frames each pool draws one zero-scaled instance so the (WebGPU)
 * pipelines — WITH instanceColor — compile before the first real break. */
const WARM_FRAMES = 3
/** Bounding-sphere pad past the live min/max: covers a piece's own extent. */
const CULL_MARGIN = 0.6
const _matrix = new Matrix4()
const _quat = new Quaternion()
const _euler = new Euler()
const _pos = new Vector3()
const _scale = new Vector3()
const _dustPos = new Vector3()
const SLAP_CHIP = { kind: 'chip' } as const
const ZERO = new Matrix4().makeScale(0, 0, 0)
const _prime = new Color(1, 1, 1)
/** Per-frame dense-pack cursors + live bounds per pool (module-scoped —
 * zero per-frame allocation). */
const denseN = new Int32Array(POOL_COUNT)
const boundsMin = new Float32Array(POOL_COUNT * 3)
const boundsMax = new Float32Array(POOL_COUNT * 3)

/** Version-gated instance uploads on WebGPU (voxel-walls.tsx's
 * markStorageInstanced — inlined here because importing voxel-walls would
 * cycle through destruction → debris): without the flag, ≤1024-instance
 * meshes ride the uniform-buffer path the renderer re-uploads EVERY frame,
 * idle or not. Returns false off WebGPU (caller falls back to
 * DynamicDrawUsage for the WebGL hint). */
function markStorageInstanced(mesh: InstancedMesh, renderer: unknown): boolean {
  const backend = (renderer as { backend?: { isWebGPUBackend?: boolean } } | null)?.backend
  if (backend?.isWebGPUBackend !== true) return false
  ;(
    mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean }
  ).isStorageInstancedBufferAttribute = true
  return true
}

export function Debris() {
  const meshesRef = useRef<(InstancedMesh | null)[]>([null, null, null, null, null])
  const warm = useRef(0)
  const drawn = useRef(false)
  const gl = useThree((s) => s.gl)

  // Pool assets are mount-owned and explicitly disposed on unmount (shared
  // material + one geometry per pool; the flat pool keeps the classic unit
  // cube — non-uniform scale makes the drywall sliver).
  const assets = useMemo(
    () => ({
      geometries: [
        makeShardGeometry(SHAPE_PLATE),
        makeShardGeometry(SHAPE_CHUNK_A),
        makeShardGeometry(SHAPE_CHUNK_B),
        makeShardGeometry(SHAPE_SPLINTER),
        new BoxGeometry(1, 1, 1),
      ],
      material: new MeshStandardMaterial({ roughness: 0.9 }),
    }),
    [],
  )

  useLayoutEffect(() => {
    const meshes = meshesRef.current
    for (let m = 0; m < POOL_COUNT; m++) {
      const mesh = meshes[m]
      if (!mesh) continue
      if (!markStorageInstanced(mesh, gl)) mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      const cap = m === FLAT_POOL ? FLAT_DRAW_CAP : SHARD_DRAW_CAP
      for (let i = 0; i < cap; i++) {
        mesh.setMatrixAt(i, ZERO)
        // Prime instanceColor for EVERY slot before the first render: the
        // host WebGPURenderer compiles the pipeline on first draw, and a
        // mesh whose first setColorAt lands mid-session gets a pipeline
        // WITHOUT instanceColor — all debris then renders white (2026-08-25).
        mesh.setColorAt(i, _prime)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      // Warm draw: one zero-scaled instance, uncullled (a culled warm draw
      // would never compile — voxel-walls discipline). useFrame flips to
      // count 0 + frustumCulled once the warm frames pass.
      mesh.count = 1
      mesh.frustumCulled = false
      mesh.boundingSphere = new Sphere() // radius −1: empty until pieces fly
    }
    warm.current = WARM_FRAMES
    drawn.current = true
    return () => {
      clearDebris()
      for (const geometry of assets.geometries) geometry.dispose()
      assets.material.dispose()
    }
  }, [gl, assets])

  useFrame((_, rawDt) => {
    const meshes = meshesRef.current
    for (let m = 0; m < POOL_COUNT; m++) if (!meshes[m]) return
    if (warm.current > 0 && --warm.current === 0) {
      for (let m = 0; m < POOL_COUNT; m++) meshes[m]!.frustumCulled = true
    }
    const warming = warm.current > 0
    if (liveCount === 0) {
      // Idle = one compare; `drawn` sweeps counts once after the last piece
      // dies, an external clearDebris, or the warm frames.
      if (!warming && drawn.current) {
        for (let m = 0; m < POOL_COUNT; m++) {
          meshes[m]!.count = 0
          meshes[m]!.boundingSphere!.radius = -1
        }
        drawn.current = false
      }
      return
    }
    drawn.current = true
    const dt = Math.min(rawDt, 1 / 30)
    let probeMisses = 0
    for (let m = 0; m < POOL_COUNT; m++) {
      denseN[m] = 0
      boundsMin[m * 3] = Number.POSITIVE_INFINITY
      boundsMin[m * 3 + 1] = Number.POSITIVE_INFINITY
      boundsMin[m * 3 + 2] = Number.POSITIVE_INFINITY
      boundsMax[m * 3] = Number.NEGATIVE_INFINITY
      boundsMax[m * 3 + 1] = Number.NEGATIVE_INFINITY
      boundsMax[m * 3 + 2] = Number.NEGATIVE_INFINITY
    }
    for (let i = 0; i < CAPACITY; i++) {
      const s = slots[i]!
      if (!s.alive) continue
      s.ttl -= dt
      if (s.ttl <= 0) {
        s.alive = false
        liveCount--
        continue // dense pack — dead pieces simply aren't written
      }
      if (s.flat) {
        // Papery fall: weak gravity, strong drag, tilt pushes it sideways.
        s.vy -= GRAVITY * FLAT_GRAVITY * dt
        const drag = 1 / (1 + FLAT_DRAG * dt)
        s.vx = s.vx * drag + Math.sin(s.rz) * FLUTTER * dt
        s.vy *= drag
        s.vz = s.vz * drag + Math.sin(s.rx) * FLUTTER * dt
      } else {
        s.vy -= GRAVITY * dt
        // A dying chunk stops tumbling over its last 20% of life — pieces
        // that never land still end resting, not pinwheeling.
        if (s.ttl < s.ttl0 * SPIN_FADE) {
          const spinFade = 1 / (1 + 10 * dt)
          s.wx *= spinFade
          s.wy *= spinFade
          s.wz *= spinFade
        }
      }
      s.px += s.vx * dt
      s.py += s.vy * dt
      s.pz += s.vz * dt
      s.rx += s.wx * dt
      s.ry += s.wy * dt
      s.rz += s.wz * dt
      // One-shot landing probe at apex (first descending frame): pick the
      // floor this piece rests on — an upper-storey slab, a wall top, or
      // the terrain plane. See setDebrisGroundProbe. Memo-first with a
      // per-frame miss budget (post-blast burst guard above): over budget,
      // the piece stays un-probed and retries next frame.
      if (!s.probed && s.vy <= 0) {
        if (!groundProbe) {
          s.probed = true
        } else {
          let floor = probeMemo.peek(s.px, s.py, s.pz)
          if (floor === undefined && probeMisses < MAX_PROBE_MISSES_PER_FRAME) {
            probeMisses++
            floor = probeMemo.probe(groundProbe, s.px, s.py, s.pz)
          }
          if (floor !== undefined) {
            s.probed = true
            s.ground = s.rest + floor
          }
        }
      }
      const half = s.ground
      if (s.py < half && s.vy < 0) {
        s.py = half
        if (s.flat) {
          // Plates don't bounce — they slap down and settle; the first
          // slap kicks up one tiny dust chip right where they land.
          if (!s.bounced) {
            _dustPos.set(s.px, half + 0.02, s.pz)
            spawnDust(_dustPos, 0.18, SLAP_CHIP)
          }
          s.vy = 0
          const settle = 1 / (1 + 9 * dt)
          s.vx *= settle
          s.vz *= settle
          s.wx *= settle
          s.wy *= settle
          s.wz *= settle
          s.bounced = true
        } else if (s.bounced) {
          s.vx *= 0.7
          s.vy = 0
          s.vz *= 0.7
          // Settled — a resting shard does not rotate (plates end flat-ish
          // instead of grinding on a corner).
          s.wx = 0
          s.wy = 0
          s.wz = 0
        } else {
          s.vy = -s.vy * 0.3
          s.vx *= 0.75
          s.vz *= 0.75
          // The slap eats most of the remaining tumble.
          s.wx *= 0.25
          s.wy *= 0.25
          s.wz *= 0.25
          s.bounced = true
        }
      }
      // Dense pack into this piece's shape pool: matrices/colors written
      // for LIVE pieces only, draw count = live count per pool.
      const m = s.flat ? FLAT_POOL : s.shape
      const n = denseN[m]!
      if (n < (m === FLAT_POOL ? FLAT_DRAW_CAP : SHARD_DRAW_CAP)) {
        const mesh = meshes[m]!
        const fade = Math.min(1, s.ttl / (s.ttl0 * 0.3))
        _euler.set(s.rx, s.ry, s.rz)
        _quat.setFromEuler(_euler)
        _pos.set(s.px, s.py, s.pz)
        _scale.set(s.sx * fade, s.sy * fade, s.sz * fade)
        _matrix.compose(_pos, _quat, _scale)
        mesh.setMatrixAt(n, _matrix)
        mesh.setColorAt(n, colors[i]!)
        denseN[m] = n + 1
        if (s.px < boundsMin[m * 3]!) boundsMin[m * 3] = s.px
        if (s.py < boundsMin[m * 3 + 1]!) boundsMin[m * 3 + 1] = s.py
        if (s.pz < boundsMin[m * 3 + 2]!) boundsMin[m * 3 + 2] = s.pz
        if (s.px > boundsMax[m * 3]!) boundsMax[m * 3] = s.px
        if (s.py > boundsMax[m * 3 + 1]!) boundsMax[m * 3 + 1] = s.py
        if (s.pz > boundsMax[m * 3 + 2]!) boundsMax[m * 3 + 2] = s.pz
      }
    }
    for (let m = 0; m < POOL_COUNT; m++) {
      const mesh = meshes[m]!
      const n = denseN[m]!
      if (n > 0) {
        mesh.count = n
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        // Frustum-cull each pool on a sphere over its live pieces — debris
        // is local to the action, so off-screen breaks skip the draw.
        const sphere = mesh.boundingSphere!
        const cx = (boundsMin[m * 3]! + boundsMax[m * 3]!) / 2
        const cy = (boundsMin[m * 3 + 1]! + boundsMax[m * 3 + 1]!) / 2
        const cz = (boundsMin[m * 3 + 2]! + boundsMax[m * 3 + 2]!) / 2
        const dx = boundsMax[m * 3]! - cx
        const dy = boundsMax[m * 3 + 1]! - cy
        const dz = boundsMax[m * 3 + 2]! - cz
        sphere.center.set(cx, cy, cz)
        sphere.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) + CULL_MARGIN
      } else if (!warming && mesh.count > 0) {
        mesh.count = 0
        mesh.boundingSphere!.radius = -1 // empty-sphere convention: culled
      }
    }
  })

  return (
    <>
      {assets.geometries.map((geometry, m) => (
        <instancedMesh
          args={[undefined, undefined, m === FLAT_POOL ? FLAT_DRAW_CAP : SHARD_DRAW_CAP]}
          geometry={geometry}
          key={m === FLAT_POOL ? 'flat' : `shard-${m}`}
          material={assets.material}
          ref={(mesh) => {
            meshesRef.current[m] = mesh
          }}
          userData={{ __boots: true }}
        />
      ))}
    </>
  )
}
