'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { Color, CylinderGeometry, DynamicDrawUsage, Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { collideCapsule } from './collision'
import { spawnCrater } from './craters'
import { spawnDebris } from './debris'
import * as destruct from './destruction'
import { collideVoxelTargets, damageSegment, damageTarget, useDestruction } from './destruction'
import { spawnDust, spawnHaze } from './dust'
import { raycastGlass, shatterPane } from './glass'
import { bots, damageBot } from './enemies-state'
import { perfEvent, perfSection } from './perf-monitor'
import { damagePlayer, playerRig } from './player'
import { getSession } from './session'
import type { GameWorld, GlassPane } from './world'

/**
 * THE MEGA-GRENADE — G throws it, 2.5 s later a whole corner of the house
 * is gone. An arc projectile (≈9 m/s off the look direction + a small loft,
 * gravity 16) that bounces ONCE (restitution 0.4) off anything solid — host
 * colliders and live voxels alike — then slides to rest, beeping once per
 * second of fuse, and detonates: a radius-3.2 carve through EVERY voxel
 * target, bots inside 6 m take 120 and are flung 2–4 m, the camera kicks
 * (playerRig.shake) inside 10 m, and a dust storm erupts.
 *
 * ── API (build against this) ──────────────────────────────────────────
 *   throwGrenade(world)      the one entry point (also exported as `throw`
 *                            and as `grenadeApi.throw` — viewmodel.tsx's G
 *                            handler calls the module-level `throw`).
 *                            Gated: game phase only, not while staggered,
 *                            5 s cooldown, pool of 4 in flight. Returns
 *                            true when a grenade actually left the hand.
 *   <Grenades world/>        owns integration + rendering (one
 *                            InstancedMesh, 4 spheres, zero per-frame
 *                            allocations). MOUNT IN game-root's ActiveGame
 *                            fragment — without it thrown grenades never
 *                            tick.
 *   grenadeReady()           true when the cooldown has elapsed.
 *   grenadeCooldownLeft()    seconds until ready. <Grenades/> drives the
 *   GRENADE_COOLDOWN         HUD pip per frame from these:
 *                            hud.grenadePip?.(1 - left/GRENADE_COOLDOWN).
 *   updateGrenades(world,dt) the sim step the component drives; exported
 *                            for headless tests (throw → step → boom).
 *   explodeAt(world, center) detonation effects at a point (tests/E2E).
 *   resetGrenades()          clear pool + cooldown + debris queue (session
 *                            teardown; the component does this on mount and
 *                            unmount).
 *   queueDebris(...)         spawnDebris-shaped enqueue into the blast
 *   drainDebrisQueue(max?)   debris ring; the component drains a fixed
 *   blastDebrisActive()      budget per frame. destruction.ts routes its
 *   debrisQueueSize()        segment-snap debris here while a blast window
 *                            is open (boom-trim — see the queue block).
 *
 * ── Destruction routing ───────────────────────────────────────────────
 * Detonation routes through destruction.ts's damageExplosion(world,
 * center, radius) — landed phase-4 round 2 (center carve + ragged nibbles
 * + segment breaks + sheet tears in one call; segment breaks arm the
 * 30%-support collapse check). Still feature-detected so this file stays
 * green against older checkouts: without it, a local fallback loops
 * damageTarget spheres and snaps framing segments inside the radius.
 * Glass: panes crossed in FLIGHT shatter (they're not colliders — swept
 * per step), and every pane inside the blast radius shatters on boom.
 */

// Owner call 2026-08-25: INFINITE grenades, no count — the only limit is a
// short re-arm so the throw animation reads (and the in-flight pool cap).
export const GRENADE_COOLDOWN = 0.6
export const GRENADE_FUSE = 2.5
export const BLAST_RADIUS = 3.2
/** Fuse seconds left under which wake-ahead runs — the stick is at rest by
 * then (thrown sticks bounce and skid out within ~1.5 s of a 2.5 s fuse),
 * so pre-wakes hit the real blast zone, not the flight arc. */
export const WAKE_AHEAD_FUSE = 1.0
/** Bots inside this radius take BLAST_BOT_DAMAGE and get flung. */
const BOT_RADIUS = 6
const BOT_DAMAGE = 120
const FLING_MIN = 2
const FLING_MAX = 4
/** Camera kick reach + power (playerRig.shake). */
const SHAKE_RADIUS = 10
const SHAKE_POWER = 1.4

const THROW_SPEED = 14
/** Extra upward bias so a level throw still arcs like a lob. */
const THROW_LOFT = 1.4
const GRAVITY = 16
/** Restitution of the single allowed bounce. */
const BOUNCE_DAMPING = 0.4
/** Velocity change (m/s) that counts as a contact for the bounce check. */
const CONTACT_EPS = 0.2

const POOL = 4
/** Tiny capsule the projectile collides as (reuses the capsule resolvers —
 * cheap, and voxel push-out comes free via collideVoxelTargets). */
const GRENADE_CAPSULE = { radius: 0.09, height: 0.18 }

type Grenade = {
  alive: boolean
  pos: Vector3
  vel: Vector3
  /** Seconds of fuse left. */
  fuse: number
  /** Whole seconds of flight already beeped (throw beeps at 0). */
  beeps: number
  bounced: boolean
  /** End-over-end tumble phase (rad) — the thrown-stick read. */
  spin: number
}

const pool: Grenade[] = Array.from({ length: POOL }, () => ({
  alive: false,
  pos: new Vector3(),
  vel: new Vector3(),
  fuse: 0,
  beeps: 0,
  bounced: false,
  spin: 0,
}))

let cooldownLeft = 0
/** Latest world seen by throw/update — explosion fallbacks read it. */
let lastWorld: GameWorld | null = null

/** True when G would actually throw (HUD pip state). */
export function grenadeReady(): boolean {
  return cooldownLeft <= 0
}

/** Seconds until the next throw is allowed (0 = ready) — HUD pip fill. */
export function grenadeCooldownLeft(): number {
  return cooldownLeft > 0 ? cooldownLeft : 0
}

/** Live projectiles (tests/debug). */
export function liveGrenades(): number {
  let n = 0
  for (const g of pool) if (g.alive) n++
  return n
}

export function resetGrenades(): void {
  for (const g of pool) g.alive = false
  cooldownLeft = 0
  // Queued blast debris must never survive into the next Jump in.
  debrisHead = 0
  debrisLen = 0
  blastDebrisWindow = 0
}

// --- Blast debris queue (boom-trim) -------------------------------------------
// One blast's framing snaps shed ~600 debris chunks in the SAME frame (≤48
// segments × ~12 spawnDebris calls each from destruction's damageSegment).
// The burst still reads rich — the chunks just arrive over the next few
// frames: while blastDebrisActive(), destruction routes segment-snap debris
// through queueDebris() instead of spawnDebris(), and <Grenades/>'s useFrame
// drains DEBRIS_DRAIN_PER_FRAME chunks per frame (same spread-the-cost idiom
// as damageExplosion's staggered rings). Fixed ring, preallocated slots, zero
// per-frame allocation; overflow past DEBRIS_QUEUE_CAP drops (nobody counts
// past a couple hundred chunks inside a dust storm).

/** Hard per-blast budget — the ring size IS the cap. */
export const DEBRIS_QUEUE_CAP = 240
/** Chunks spawned per drained frame (~3 frames to empty a full ring). */
export const DEBRIS_DRAIN_PER_FRAME = 80
/** Seconds after a boom during which segment debris queues — covers the
 * 70 ms outer ring of destruction's staggered detonation with slack. */
const BLAST_DEBRIS_WINDOW = 0.25

type QueuedDebris = {
  x: number
  y: number
  z: number
  size: number
  hex: number
  speed: number
  ttl: number
}

const debrisQueue: QueuedDebris[] = Array.from({ length: DEBRIS_QUEUE_CAP }, () => ({
  x: 0,
  y: 0,
  z: 0,
  size: 0,
  hex: 0,
  speed: 0,
  ttl: 0,
}))
let debrisHead = 0
let debrisLen = 0
let blastDebrisWindow = 0
const _drainColor = new Color()

/** True just after a detonation — destruction.ts checks this to route
 * segment-snap debris through the queue instead of spawning inline. */
export function blastDebrisActive(): boolean {
  return blastDebrisWindow > 0
}

/**
 * spawnDebris-shaped enqueue (drop-in at the call site; the directional
 * `dir` launch is NOT carried — sheet fly-offs keep their own inline path).
 * Returns false when the per-blast budget is spent and the chunk dropped.
 */
export function queueDebris(
  x: number,
  y: number,
  z: number,
  size: number,
  color: Color,
  speed: number,
  ttl = 2.6,
): boolean {
  if (debrisLen >= DEBRIS_QUEUE_CAP) return false
  const slot = debrisQueue[(debrisHead + debrisLen) % DEBRIS_QUEUE_CAP]!
  slot.x = x
  slot.y = y
  slot.z = z
  slot.size = size
  slot.hex = color.getHex()
  slot.speed = speed
  slot.ttl = ttl
  debrisLen++
  return true
}

/** Spawn up to `max` queued chunks — one frame's budget. Returns spawned. */
export function drainDebrisQueue(max = DEBRIS_DRAIN_PER_FRAME): number {
  let spawned = 0
  while (debrisLen > 0 && spawned < max) {
    const slot = debrisQueue[debrisHead]!
    debrisHead = (debrisHead + 1) % DEBRIS_QUEUE_CAP
    debrisLen--
    spawnDebris(slot.x, slot.y, slot.z, slot.size, _drainColor.setHex(slot.hex), slot.speed, slot.ttl)
    spawned++
  }
  return spawned
}

/** Chunks waiting in the ring (tests/debug). */
export function debrisQueueSize(): number {
  return debrisLen
}

/** Look direction × throw speed + loft — pure, exported for headless tests.
 * Same yaw/pitch → forward math as shooting.ts's aimDirection (YXZ). */
export function throwVelocity(out: Vector3, yaw: number, pitch: number): Vector3 {
  const cp = Math.cos(pitch)
  out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
  out.multiplyScalar(THROW_SPEED)
  out.y += THROW_LOFT
  return out
}

/** Guarded arming blip — sfx.grenadeBeep with the doorLatch fallback. */
function beep(): void {
  const voiced = sfx as typeof sfx & { grenadeBeep?: () => void }
  if (voiced.grenadeBeep) voiced.grenadeBeep()
  else sfx.doorLatch()
}

const _dir = new Vector3()

/**
 * G pressed: lob a grenade from the eye line along the look direction.
 * Returns true if one actually launched (cooldown ready + free pool slot +
 * in-game and standing).
 */
export function throwGrenade(world: GameWorld): boolean {
  lastWorld = world
  const s = useBoots.getState()
  if (s.phase !== 'game' || s.staggered) return false
  if (cooldownLeft > 0) return false
  let slot: Grenade | null = null
  for (const g of pool) {
    if (!g.alive) {
      slot = g
      break
    }
  }
  if (!slot) return false
  cooldownLeft = GRENADE_COOLDOWN
  throwVelocity(slot.vel, playerRig.yaw, playerRig.pitch)
  _dir.copy(slot.vel).normalize()
  // Leave from just ahead of the camera, a hair low — never clips the view.
  slot.pos.copy(playerRig.position).addScaledVector(_dir, 0.45)
  slot.pos.y -= 0.12
  slot.fuse = GRENADE_FUSE
  slot.beeps = 0
  slot.bounced = false
  slot.spin = Math.random() * Math.PI * 2
  slot.alive = true
  beep() // arming blip; then once per second of fuse
  return true
}

/** Contract surface (see header): `grenadeApi.throw` and the module-level
 * `throw` export are the same function viewmodel.tsx routes G to. */
export const grenadeApi = { throw: throwGrenade }
export { throwGrenade as throw }

// --- Detonation --------------------------------------------------------------

/** Node types worth carving in the fallback path — mirrors shooting.ts's
 * DESTRUCTIBLE routing set (terrain/fixtures just take the dust). */
const FALLBACK_DESTRUCTIBLE = new Set([
  'wall',
  'door',
  'window',
  'slab',
  'floor',
  'ceiling',
  'roof',
  'roof-segment',
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'block',
  'column',
  'stair',
  'stair-segment',
  'counter',
  'kitchen-unit',
])

/** Fallback rim-nibble count per node (the real ragged edge lives in
 * damageExplosion; this only approximates it until that export lands). */
const FALLBACK_NIBBLES = 5
/** Fallback cap on framing segments snapped per blast. */
const FALLBACK_SEGMENT_CAP = 48

const _carvePoint = new Vector3()
const _segPoint = new Vector3()

/**
 * Pre-damageExplosion fallback: one big damageTarget carve + rim nibbles
 * per destructible node whose bounds touch the blast, then snap framing
 * segments caught inside the radius. Sheet fly-offs come free — the big
 * carve's removed cells run through destruction's own sheet accounting.
 */
function fallbackCarve(world: GameWorld, center: Vector3): void {
  const seen = new Set<string>()
  for (const collider of world.colliders) {
    if (seen.has(collider.nodeId)) continue
    if (!FALLBACK_DESTRUCTIBLE.has(collider.nodeType)) continue
    if (collider.worldBox.distanceToPoint(center) > BLAST_RADIUS) continue
    seen.add(collider.nodeId)
    damageTarget(world, collider.nodeId, center, BLAST_RADIUS)
    for (let i = 0; i < FALLBACK_NIBBLES; i++) {
      _carvePoint
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(BLAST_RADIUS * (0.75 + Math.random() * 0.3))
        .add(center)
      damageTarget(world, collider.nodeId, _carvePoint, 0.3 + Math.random() * 0.2)
    }
  }
  // Framing inside the blast snaps too — a leveled bay shouldn't keep its
  // sticks standing while the skins are gone.
  let snapped = 0
  for (const target of useDestruction.getState().targets.values()) {
    for (const segment of target.segments) {
      if (segment.broken) continue
      _segPoint.set(segment.center[0], segment.center[1], segment.center[2])
      if (_segPoint.distanceTo(center) > BLAST_RADIUS) continue
      damageSegment(world, target.nodeId, segment.id, 99, _segPoint)
      if (++snapped >= FALLBACK_SEGMENT_CAP) return
    }
  }
}

const _fling = new Vector3()
const _dustPoint = new Vector3()
const _paneCenter = new Vector3()
const SCRAP = new Color('#5d5a52')

/**
 * Detonation at a world point: radius-3.2 carve (damageExplosion when the
 * collapse agent's export exists, fallback spheres otherwise), 120 damage +
 * a 2–4 m fling to bots inside 6 m, camera shake inside 10 m, explosion
 * voice, dust storm. Exported for tests/E2E.
 */
export function explodeAt(world: GameWorld, center: Vector3): void {
  perfEvent('grenade-boom')
  const explodeT0 = performance.now()
  // Open the debris window FIRST — the segment snaps it governs land both
  // on this frame (immediate carves) and 70 ms out (the outer ring).
  blastDebrisWindow = BLAST_DEBRIS_WINDOW
  // Carve — feature-detect the phase-4 collapse export.
  const boom = (
    destruct as { damageExplosion?: (w: GameWorld, c: Vector3, r: number) => number }
  ).damageExplosion
  const carveT0 = performance.now()
  if (typeof boom === 'function') boom(world, center, BLAST_RADIUS)
  else fallbackCarve(world, center)
  perfSection('boom-carve-sync', performance.now() - carveT0)

  // Glass inside the blast shatters (shatterPane is idempotent) — but each
  // pane pays 26 shards + a store bump, so only a couple break on the boom
  // frame; the rest ride 40/80 ms behind, the same staggered-ring idiom as
  // damageExplosion (per-BLAST allocations only, never per frame).
  const GLASS_NOW = 2
  const GLASS_MID = 3
  let glassHits = 0
  let deferredPanes: GlassPane[] | null = null
  let glassT0 = performance.now()
  for (const pane of world.glass) {
    if (pane.mesh.getWorldPosition(_paneCenter).distanceTo(center) > BLAST_RADIUS) continue
    if (glassHits < GLASS_NOW) {
      shatterPane(pane)
    } else {
      if (!deferredPanes) deferredPanes = []
      deferredPanes.push(pane)
    }
    glassHits++
  }
  perfSection('boom-glass', performance.now() - glassT0)
  if (deferredPanes) {
    // Self-rescheduling batches of GLASS_MID every 40 ms — the tail used to
    // be ONE unbounded flush at 80 ms, so a glass-heavy blast (sunroom /
    // curtain wall) paid every remaining pane's 26 shards + store bump in a
    // single macrotask. Same total shatters, bounded per flush; only one
    // timeout is ever pending, so a long frame coalesces at most one batch.
    const wave = deferredPanes
    let cursor = 0
    const step = () => {
      glassT0 = performance.now()
      const end = Math.min(cursor + GLASS_MID, wave.length)
      for (; cursor < end; cursor++) shatterPane(wave[cursor]!)
      perfSection('boom-glass', performance.now() - glassT0)
      if (cursor < wave.length) setTimeout(step, 40)
    }
    setTimeout(step, 40)
  }

  // Bots: damage + fling (positions shoved — the pathing push-out resolves
  // any wall the fling lands them against next frame).
  const botsT0 = performance.now()
  for (const bot of bots) {
    if (bot.state !== 'alive') continue
    const d = bot.position.distanceTo(center)
    if (d > BOT_RADIUS) continue
    damageBot(bot, BOT_DAMAGE)
    _fling.subVectors(bot.position, center)
    _fling.y = 0
    if (_fling.lengthSq() < 1e-6) _fling.set(Math.random() - 0.5, 0, Math.random() - 0.5)
    _fling.normalize()
    bot.position.addScaledVector(_fling, FLING_MIN + Math.random() * (FLING_MAX - FLING_MIN))
  }

  // Player feel: camera kick inside 10 m (shake is a phase-4 rig method —
  // optional-call so this file is green before AND after it lands).
  const playerDist = playerRig.position.distanceTo(center)
  if (playerDist <= SHAKE_RADIUS) {
    ;(playerRig as typeof playerRig & { shake?: (power: number) => void }).shake?.(SHAKE_POWER)
  }
  // SELF-HARM (owner rule): blow yourself up and it hurts — and it LOFTS
  // you a few metres. Damage + XZ shove route through damagePlayer (hurt
  // read, vignette, stagger at 0); the vertical ride is rig.launch.
  const HARM_RADIUS = BLAST_RADIUS * 2
  if (playerDist <= HARM_RADIUS) {
    const closeness = 1 - playerDist / HARM_RADIUS
    const away = {
      x: playerRig.position.x - center.x,
      z: playerRig.position.z - center.z,
    }
    if (Math.hypot(away.x, away.z) < 1e-4) {
      away.x = Math.random() - 0.5
      away.z = Math.random() - 0.5
    }
    damagePlayer(Math.round(12 + 38 * closeness), away)
    ;(playerRig as typeof playerRig & { launch?: (power: number) => void }).launch?.(
      3.5 + 4.5 * closeness,
    )
  }

  perfSection('boom-bots', performance.now() - botsT0)

  const sfxT0 = performance.now()
  sfx.explosion()
  perfSection('boom-sfx', performance.now() - sfxT0)

  // Ground scar — craters.tsx owns the green-vs-road/building call and the
  // 16-slot ring buffer; a blast on pavement or indoors is a no-op here.
  const craterT0 = performance.now()
  spawnCrater(world, center, BLAST_RADIUS)
  perfSection('boom-crater', performance.now() - craterT0)

  // Dust storm — a handful of plumes (each auto-spawns haze) ringed by
  // puffs, plus one wide lingering haze. All feature-checked (contract).
  const dustT0 = performance.now()
  if (typeof spawnDust === 'function') {
    for (let i = 0; i < 4; i++) {
      _dustPoint.set(
        center.x + (Math.random() - 0.5) * 2.4,
        center.y + Math.random() * 1.2,
        center.z + (Math.random() - 0.5) * 2.4,
      )
      spawnDust(_dustPoint, 1, { kind: 'plume' })
    }
    for (let i = 0; i < 6; i++) {
      _dustPoint.set(
        center.x + (Math.random() - 0.5) * 4.5,
        center.y + Math.random() * 0.8,
        center.z + (Math.random() - 0.5) * 4.5,
      )
      spawnDust(_dustPoint, 0.8, { kind: 'puff' })
    }
  }
  if (typeof spawnHaze === 'function') spawnHaze(center, 4.5)
  for (let i = 0; i < 8; i++) {
    spawnDebris(center.x, center.y + 0.3, center.z, 0.05 + Math.random() * 0.05, SCRAP, 4, 1.6)
  }
  perfSection('boom-dust', performance.now() - dustT0)
  perfSection('boom-explode', performance.now() - explodeT0)
}

// --- Integration -------------------------------------------------------------

const _velBefore = new Vector3()
const _clip = new Vector3()
const _flightFrom = new Vector3()
const _flightDir = new Vector3()

/**
 * One sim step: cooldown decay, fuse beeps, arc physics with the single
 * bounce, detonation on fuse end. Driven by <Grenades/>; exported so
 * headless tests can run the whole throw → bounce → boom arc.
 */
export function updateGrenades(world: GameWorld, dt: number): void {
  lastWorld = world
  if (cooldownLeft > 0) cooldownLeft = Math.max(0, cooldownLeft - dt)
  if (blastDebrisWindow > 0) blastDebrisWindow = Math.max(0, blastDebrisWindow - dt)
  // WAKE-AHEAD: while a stick cooks, wake ONE dormant target near it per
  // frame, so detonation lands on already-awake targets and the boom frame
  // pays repeat-blast prices (feature-detected like damageExplosion). Only
  // in the fuse's FINAL second — the stick has come to rest by then, so the
  // wakes trace the actual blast zone. Waking from the throw used the
  // MOVING stick as center and popped every intact wall/roof/stair along
  // the whole flight arc to voxel replicas with zero damage dealt (the
  // dormant invariant: no visual change until the first hit). ~60 frames
  // at one wake each still covers a mid-house blast (~15 nodes) several
  // times over; anything left dormant rides the blast rings' own wakes.
  let wakeBudget = 1
  const wakeAhead = (destruct as { wakeAheadTick?: (w: GameWorld, c: Vector3, r: number) => boolean })
    .wakeAheadTick
  for (const g of pool) {
    if (!g.alive) continue
    if (
      g.fuse <= WAKE_AHEAD_FUSE &&
      wakeBudget > 0 &&
      typeof wakeAhead === 'function' &&
      wakeAhead(world, g.pos, BLAST_RADIUS)
    ) {
      wakeBudget--
    }
    g.fuse -= dt
    if (g.fuse <= 0) {
      g.alive = false
      explodeAt(world, g.pos)
      continue
    }
    // Soft beep once per second of burn (throw already beeped at 0 s).
    const elapsed = GRENADE_FUSE - g.fuse
    if (elapsed >= g.beeps + 1) {
      g.beeps++
      beep()
    }
    // Arc + collision. The capsule resolvers push the position out and clip
    // velocity into the surface; the clipped-off component IS the contact
    // normal impulse, so one reflected fraction of it makes the bounce:
    // v' = v_clipped − e·(v_before − v_clipped).
    g.vel.y -= GRAVITY * dt
    _flightFrom.copy(g.pos)
    g.pos.addScaledVector(g.vel, dt)
    // Glazing is not armor: panes aren't colliders (world.glass rides its
    // own lane), so sweep the flight step and SMASH any pane crossed —
    // the grenade keeps flying, the glass doesn't (QA p4r1 finding).
    _flightDir.subVectors(g.pos, _flightFrom)
    const flightLen = _flightDir.length()
    if (flightLen > 1e-6) {
      _flightDir.multiplyScalar(1 / flightLen)
      const pane = raycastGlass(world, _flightFrom, _flightDir, flightLen + GRENADE_CAPSULE.radius)
      if (pane) shatterPane(pane.pane)
    }
    _velBefore.copy(g.vel)
    collideCapsule(g.pos, g.vel, world.colliders, GRENADE_CAPSULE)
    collideVoxelTargets(g.pos, g.vel, GRENADE_CAPSULE.radius, GRENADE_CAPSULE.height)
    _clip.subVectors(_velBefore, g.vel)
    if (_clip.lengthSq() > CONTACT_EPS * CONTACT_EPS) {
      if (!g.bounced) {
        g.bounced = true
        g.vel.addScaledVector(_clip, -BOUNCE_DAMPING)
        sfx.voxelCrunch(0.12) // quiet casing tap on the bounce
      }
    }
    // After the bounce it skids to rest instead of rolling forever.
    if (g.bounced) g.vel.multiplyScalar(1 - Math.min(1, dt * 2.5))
  }
}

const _mat = new Matrix4()
const _spinEuler = new Euler()
const _spinQuat = new Quaternion()
const _one = new Vector3(1, 1, 1)
const ZERO_MAT = new Matrix4().makeScale(0, 0, 0)

/**
 * Projectile pool renderer + integrator: one InstancedMesh (4 spheres),
 * matrices rewritten in place every frame, dead slots collapsed to scale 0.
 * Mount once in game-root's ActiveGame fragment.
 */
export function Grenades({ world }: { world: GameWorld }) {
  const meshRef = useRef<InstancedMesh>(null!)
  const stickRef = useRef<InstancedMesh>(null!)

  // Fresh pool per session/world; teardown clears it (a grenade must never
  // survive into the next Jump in).
  useEffect(() => {
    lastWorld = world
    resetGrenades()
    return resetGrenades
  }, [world])

  // Prime every instance matrix (zero scale) BEFORE first render — same
  // WebGPU first-upload rule as instanceColor priming elsewhere.
  useLayoutEffect(() => {
    const mesh = meshRef.current
    const stick = stickRef.current
    if (!mesh || !stick) return
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    stick.instanceMatrix.setUsage(DynamicDrawUsage)
    for (let i = 0; i < POOL; i++) {
      mesh.setMatrixAt(i, ZERO_MAT)
      stick.setMatrixAt(i, ZERO_MAT)
    }
    mesh.instanceMatrix.needsUpdate = true
    stick.instanceMatrix.needsUpdate = true
  }, [])

  useFrame((_, rawDt) => {
    const dtRender = Math.min(rawDt, 1 / 30)
    updateGrenades(world, dtRender)
    // Blast debris arrives over frames, not all at once — no-op when empty.
    if (debrisLen > 0) {
      const t0 = performance.now()
      drainDebrisQueue()
      perfSection('boom-debris-drain', performance.now() - t0)
    }
    // HUD grenade-ready pip (change-gated on the HUD side, so per-frame is
    // free while the value holds). This component owns the drive — hud.ts
    // only renders.
    getSession()?.hud.grenadePip?.(1 - grenadeCooldownLeft() / GRENADE_COOLDOWN)
    const mesh = meshRef.current
    const stick = stickRef.current
    if (!mesh || !stick) return
    for (let i = 0; i < POOL; i++) {
      const g = pool[i]!
      if (g.alive) {
        g.spin += (g.bounced ? 3.2 : 10) * dtRender
        _spinEuler.set(g.spin, g.spin * 0.23, 0)
        _spinQuat.setFromEuler(_spinEuler)
        _mat.compose(g.pos, _spinQuat, _one)
        mesh.setMatrixAt(i, _mat)
        stick.setMatrixAt(i, _mat)
      } else {
        mesh.setMatrixAt(i, ZERO_MAT)
        stick.setMatrixAt(i, ZERO_MAT)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    stick.instanceMatrix.needsUpdate = true
  })

  // Stick grenade: cylinder HEAD (dark steel) + wooden HANDLE below it, two
  // instanced meshes sharing every matrix so the whole thing tumbles
  // end-over-end in flight.
  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[HEAD_GEOMETRY, undefined, POOL]}
        frustumCulled={false}
        userData={{ __boots: true }}
      >
        <meshStandardMaterial color="#3b4148" roughness={0.5} metalness={0.45} />
      </instancedMesh>
      <instancedMesh
        ref={stickRef}
        args={[STICK_GEOMETRY, undefined, POOL]}
        frustumCulled={false}
        userData={{ __boots: true }}
      >
        <meshStandardMaterial color="#8a6a43" roughness={0.85} />
      </instancedMesh>
    </>
  )
}

/** Head sits above the origin, handle hangs below — tumbling around the
 * origin reads exactly like a thrown stick grenade. */
const HEAD_GEOMETRY = new CylinderGeometry(0.037, 0.037, 0.1, 10).translate(0, 0.1, 0)
const STICK_GEOMETRY = new CylinderGeometry(0.0125, 0.0135, 0.23, 8).translate(0, -0.065, 0)

/** The module keeps the latest world for dev/E2E detonations. */
export function grenadeWorld(): GameWorld | null {
  return lastWorld
}
