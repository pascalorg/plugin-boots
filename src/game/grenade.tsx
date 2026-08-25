'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { Color, DynamicDrawUsage, type InstancedMesh, Matrix4, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { collideCapsule } from './collision'
import { spawnDebris } from './debris'
import * as destruct from './destruction'
import { collideVoxelTargets, damageSegment, damageTarget, useDestruction } from './destruction'
import { spawnDust, spawnHaze } from './dust'
import { bots, damageBot } from './enemies-state'
import { playerRig } from './player'
import { getSession } from './session'
import type { GameWorld } from './world'

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
 *   resetGrenades()          clear pool + cooldown (session teardown; the
 *                            component does this on mount and unmount).
 *
 * ── Destruction routing ───────────────────────────────────────────────
 * Detonation prefers destruction.ts's damageExplosion(world, center,
 * radius) — the collapse agent's phase-4 export (entry spheres + ragged
 * nibbles + segment breaks + sheet tears in one call). Feature-detected:
 * until it lands, a local fallback loops damageTarget spheres (one big
 * carve + rim nibbles per destructible node in range) and snaps framing
 * segments inside the radius, so the grenade levels walls either way.
 */

export const GRENADE_COOLDOWN = 5
export const GRENADE_FUSE = 2.5
export const BLAST_RADIUS = 3.2
/** Bots inside this radius take BLAST_BOT_DAMAGE and get flung. */
const BOT_RADIUS = 6
const BOT_DAMAGE = 120
const FLING_MIN = 2
const FLING_MAX = 4
/** Camera kick reach + power (playerRig.shake). */
const SHAKE_RADIUS = 10
const SHAKE_POWER = 1.4

const THROW_SPEED = 9
/** Extra upward bias so a level throw still arcs like a lob. */
const THROW_LOFT = 2.0
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
}

const pool: Grenade[] = Array.from({ length: POOL }, () => ({
  alive: false,
  pos: new Vector3(),
  vel: new Vector3(),
  fuse: 0,
  beeps: 0,
  bounced: false,
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
const SCRAP = new Color('#5d5a52')

/**
 * Detonation at a world point: radius-3.2 carve (damageExplosion when the
 * collapse agent's export exists, fallback spheres otherwise), 120 damage +
 * a 2–4 m fling to bots inside 6 m, camera shake inside 10 m, explosion
 * voice, dust storm. Exported for tests/E2E.
 */
export function explodeAt(world: GameWorld, center: Vector3): void {
  // Carve — feature-detect the phase-4 collapse export.
  const boom = (
    destruct as { damageExplosion?: (w: GameWorld, c: Vector3, r: number) => number }
  ).damageExplosion
  if (typeof boom === 'function') boom(world, center, BLAST_RADIUS)
  else fallbackCarve(world, center)

  // Bots: damage + fling (positions shoved — the pathing push-out resolves
  // any wall the fling lands them against next frame).
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
  if (playerRig.position.distanceTo(center) <= SHAKE_RADIUS) {
    ;(playerRig as typeof playerRig & { shake?: (power: number) => void }).shake?.(SHAKE_POWER)
  }

  sfx.explosion()

  // Dust storm — a handful of plumes (each auto-spawns haze) ringed by
  // puffs, plus one wide lingering haze. All feature-checked (contract).
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
}

// --- Integration -------------------------------------------------------------

const _velBefore = new Vector3()
const _clip = new Vector3()

/**
 * One sim step: cooldown decay, fuse beeps, arc physics with the single
 * bounce, detonation on fuse end. Driven by <Grenades/>; exported so
 * headless tests can run the whole throw → bounce → boom arc.
 */
export function updateGrenades(world: GameWorld, dt: number): void {
  lastWorld = world
  if (cooldownLeft > 0) cooldownLeft = Math.max(0, cooldownLeft - dt)
  for (const g of pool) {
    if (!g.alive) continue
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
    g.pos.addScaledVector(g.vel, dt)
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
const ZERO_MAT = new Matrix4().makeScale(0, 0, 0)

/**
 * Projectile pool renderer + integrator: one InstancedMesh (4 spheres),
 * matrices rewritten in place every frame, dead slots collapsed to scale 0.
 * Mount once in game-root's ActiveGame fragment.
 */
export function Grenades({ world }: { world: GameWorld }) {
  const meshRef = useRef<InstancedMesh>(null!)

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
    if (!mesh) return
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    for (let i = 0; i < POOL; i++) mesh.setMatrixAt(i, ZERO_MAT)
    mesh.instanceMatrix.needsUpdate = true
  }, [])

  useFrame((_, rawDt) => {
    updateGrenades(world, Math.min(rawDt, 1 / 30))
    // HUD grenade-ready pip (change-gated on the HUD side, so per-frame is
    // free while the value holds). This component owns the drive — hud.ts
    // only renders.
    getSession()?.hud.grenadePip?.(1 - grenadeCooldownLeft() / GRENADE_COOLDOWN)
    const mesh = meshRef.current
    if (!mesh) return
    for (let i = 0; i < POOL; i++) {
      const g = pool[i]!
      if (g.alive) {
        _mat.identity().setPosition(g.pos)
        mesh.setMatrixAt(i, _mat)
      } else {
        mesh.setMatrixAt(i, ZERO_MAT)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, POOL]}
      frustumCulled={false}
      userData={{ __boots: true }}
    >
      <sphereGeometry args={[0.085, 12, 10]} />
      <meshStandardMaterial color="#39412f" roughness={0.6} metalness={0.3} />
    </instancedMesh>
  )
}

/** The module keeps the latest world for dev/E2E detonations. */
export function grenadeWorld(): GameWorld | null {
  return lastWorld
}
