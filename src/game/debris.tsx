'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import { Color, DynamicDrawUsage, Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import { spawnDust } from './dust'

/**
 * One global ring buffer of tumbling debris — voxel chunks, sparks, glass
 * shards AND flat plate shards all ride the same InstancedMesh (non-uniform
 * scale turns the unit cube into a plate). Hand-rolled ballistics: cubes get
 * gravity + one damped ground bounce; flat shards fall papery — strong air
 * drag, reduced effective gravity, slow fluttery tumble with tilt-driven
 * side-slip. Shrink-out at end of life. No physics engine; a few hundred
 * live pieces cost one draw call.
 *
 * API (callers may feature-check the named exports):
 *   spawnDebris(x, y, z, size, color, speed, ttl?, dir?) — classic cube
 *     chunk. `dir` (unit-ish vector) biases the launch velocity along it —
 *     ceiling material pops DOWN through the hole, not up.
 *   spawnFlatDebris(x, y, z, w, h, color, dir?)     — drywall/paper plate,
 *     w×h meters (torn-edge xy jitter), slow flutter, ~3s life, one tiny
 *     chip puff on its first ground slap. Live plates cap at 120 — the
 *     plate closest to expiry gets reused first. `dir` as above (a torn
 *     ceiling board leaves its face along −Y).
 *   debrisCensus()                                  — headless test probe:
 *     live slot count + flat count + mean launch vy of live pieces.
 *   clearDebris()                                   — session teardown.
 */

const CAPACITY = 768

type DebrisSlot = {
  alive: boolean
  /** Flat-plate mode: flutter physics + non-uniform scale. */
  flat: boolean
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
  /** Draw scale per axis (cubes: all = size; plates: w × h × sliver). */
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
  slot.alive = true
  slot.flat = false
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
    const theta = Math.random() * Math.PI * 2
    const up = 0.5 + Math.random() * 1.6
    slot.vx = Math.cos(theta) * speed * (0.3 + Math.random() * 0.7)
    slot.vy = up * speed * 0.55
    slot.vz = Math.sin(theta) * speed * (0.3 + Math.random() * 0.7)
  }
  slot.rx = Math.random() * Math.PI
  slot.ry = Math.random() * Math.PI
  slot.rz = Math.random() * Math.PI
  slot.wx = (Math.random() - 0.5) * 9
  slot.wy = (Math.random() - 0.5) * 9
  slot.wz = (Math.random() - 0.5) * 9
  slot.sx = size
  slot.sy = size
  slot.sz = size
  slot.rest = size / 2
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
  colors[index]!.copy(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06)
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
 * position, resolved landing plane (`ground` = plane + rest half-height)
 * and settle state. QA asserts upper-storey debris rests on the upper
 * floor from this, without traversing instance matrices. */
export function debrisDump(): Array<{
  x: number
  y: number
  z: number
  flat: boolean
  ground: number
  settled: boolean
}> {
  const out: Array<{ x: number; y: number; z: number; flat: boolean; ground: number; settled: boolean }> = []
  for (const s of slots) {
    if (!s.alive) continue
    out.push({
      x: +s.px.toFixed(3),
      y: +s.py.toFixed(3),
      z: +s.pz.toFixed(3),
      flat: s.flat,
      ground: +s.ground.toFixed(3),
      settled: s.bounced,
    })
  }
  return out
}

const GRAVITY = 14
/** Flat shards: effective-gravity fraction + linear air-drag coefficient. */
const FLAT_GRAVITY = 0.4
const FLAT_DRAG = 2.4
/** Tilt-driven horizontal side-slip strength — the "flutter" drift. */
const FLUTTER = 1.1
const _matrix = new Matrix4()
const _quat = new Quaternion()
const _euler = new Euler()
const _pos = new Vector3()
const _scale = new Vector3()
const _dustPos = new Vector3()
const SLAP_CHIP = { kind: 'chip' } as const
const ZERO = new Matrix4().makeScale(0, 0, 0)

export function Debris() {
  const meshRef = useRef<InstancedMesh>(null!)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    for (let i = 0; i < CAPACITY; i++) {
      mesh.setMatrixAt(i, ZERO)
      // Prime instanceColor for EVERY slot before the first render: the
      // host WebGPURenderer compiles the pipeline on first draw, and a mesh
      // whose first setColorAt lands mid-session gets a pipeline WITHOUT
      // instanceColor — all debris then renders white (wiring, 2026-08-25).
      mesh.setColorAt(i, colors[i]!)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.frustumCulled = false
    return clearDebris
  }, [])

  useFrame((_, rawDt) => {
    const mesh = meshRef.current
    if (!mesh) return
    if (liveCount === 0) return
    const dt = Math.min(rawDt, 1 / 30)
    for (let i = 0; i < CAPACITY; i++) {
      const s = slots[i]!
      if (!s.alive) continue
      s.ttl -= dt
      if (s.ttl <= 0) {
        s.alive = false
        liveCount--
        mesh.setMatrixAt(i, ZERO)
        continue
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
      }
      s.px += s.vx * dt
      s.py += s.vy * dt
      s.pz += s.vz * dt
      s.rx += s.wx * dt
      s.ry += s.wy * dt
      s.rz += s.wz * dt
      // One-shot landing probe at apex (first descending frame): pick the
      // floor this piece rests on — an upper-storey slab, a wall top, or
      // the terrain plane. See setDebrisGroundProbe.
      if (!s.probed && s.vy <= 0) {
        s.probed = true
        if (groundProbe) s.ground = s.rest + groundProbe(s.px, s.py, s.pz)
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
        } else {
          s.vy = -s.vy * 0.3
          s.vx *= 0.75
          s.vz *= 0.75
          s.bounced = true
        }
      }
      const fade = Math.min(1, s.ttl / (s.ttl0 * 0.3))
      _euler.set(s.rx, s.ry, s.rz)
      _quat.setFromEuler(_euler)
      _pos.set(s.px, s.py, s.pz)
      _scale.set(s.sx * fade, s.sy * fade, s.sz * fade)
      _matrix.compose(_pos, _quat, _scale)
      mesh.setMatrixAt(i, _matrix)
      mesh.setColorAt(i, colors[i]!)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh
      args={[undefined, undefined, CAPACITY]}
      ref={meshRef}
      userData={{ __boots: true }}
    >
      <boxGeometry />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  )
}
