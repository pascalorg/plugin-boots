'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { type PerspectiveCamera, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { collideCapsule, EYE_HEIGHT, PLAYER_CAPSULE } from './collision'
import { collideVoxelWalls } from './destruction'
import { MOVE, stepVelocity } from './movement'
import { getSession } from './session'
import type { GameWorld } from './world'

/**
 * DAMAGE / STAGGER API (for enemies & pacing — the "you can't die" dynamic)
 * ---------------------------------------------------------------------------
 * `damagePlayer(amount, fromDir?)` — the one entry point for hurting the
 *   player. `fromDir` is the horizontal direction FROM the attacker TO the
 *   player (i.e. the push direction), any length — it's normalized here.
 *   It: lowers health (never below 0), resets the regen clock, shoves the
 *   player away (~2.5 m/s per 12 dmg, capped), flashes the HUD vignette
 *   (passing the screen-relative attacker angle: 0 = ahead, +π/2 = right,
 *   for a future directional indicator) and plays sfx.damage().
 *   When health would hit 0 it does NOT kill: health pins to 1 and a 2.5s
 *   STAGGER starts — red pulsing screen, heartbeat, halved move speed, no
 *   jumping, woozy camera sway + head-hang slump + FOV tunnel, weapon droop
 *   + fire block (viewmodel). Damage landing during a stagger still
 *   shoves/flashes but costs no health, and the shove is dampened to 40%
 *   (mercy window — pushed around, never juggled). The stagger ends at
 *   health 40 with a get-up beat: the slump releases through `getUpPitch`
 *   (small upward lift) while the FOV settles back, then regen resumes.
 *
 * `playerRig.shove(dirX, dirZ, power)` — knockback impulse in m/s on the XZ
 *   plane; direction is normalized, impulses accumulate and are consumed
 *   into the player velocity on the next frame. Safe to call from anywhere
 *   (enemies, explosions) — it never touches the camera directly.
 *
 * REGEN: 4s after the last damage, health climbs +12/s to 100. Store writes
 * are throttled to ~4/s (fractional hp pools locally) to avoid re-render
 * storms in HUD subscribers.
 *
 * NOTE: prefer `damagePlayer` over raw `setHealth` — but as a safety net the
 * frame loop also converts any external health<=0 write into a stagger.
 */

const SENSITIVITY = 0.0021
const GAME_FOV = 92
const FOOTSTEP_STRIDE = 2.3
const MAX_PITCH = Math.PI / 2 - 0.02

const REGEN_DELAY = 4 // s after last damage before regen kicks in
const REGEN_RATE = 12 // hp/s
const REGEN_WRITE_CHUNK = 3 // hp per store write ≈ 4 writes/s at REGEN_RATE
const STAGGER_TIME = 2.5 // s
const STAGGER_RECOVER_HP = 40
const SHOVE_PER_DAMAGE = 2.5 / 12 // m/s of knockback per point of damage
const SHOVE_MAX = 6
/** Mercy-window shoves are dampened: downed hits nudge, they don't juggle.
 * (Bots hold their standoff ring while you're staggered, but the pile-on
 * hits that land in the same frame the stagger starts — plus any future
 * splash sources — still shove.) */
const STAGGER_SHOVE_SCALE = 0.4

// --- Stagger camera feel (all CPU-side rotation/fov math) -------------------
/** Head-hang while downed: a slow nose-down slump, eased in over SLUMP_EASE. */
const SLUMP_PITCH = 0.04 // rad
const SLUMP_EASE = 0.35 // s
/** Woozy sway: two detuned rolls + one slow pitch, peak amp mid-stagger. */
const SWAY_ROLL_AMP = 0.03 // rad (layered pair peaks ~0.045)
const SWAY_PITCH_AMP = 0.02 // rad
/** Tunnel vision while downed; released with a settle as you get up. */
const STAGGER_FOV_DROP = 6 // deg
/** Get-up beat at stagger end: slump releases + a small upward lift. */
const RECOVER_TIME = 0.6 // s
const GETUP_LIFT = 0.025 // rad of upward pitch overshoot mid-recovery

/**
 * Get-up pitch offset (rad) over recovery progress u∈[0,1]: starts at the
 * full slump (negative), lifts slightly past level as you straighten, and
 * settles to exactly 0. Pure — exported for headless tests.
 */
export function getUpPitch(u: number): number {
  const t = u < 0 ? 0 : u > 1 ? 1 : u
  return -SLUMP_PITCH * (1 - t) * (1 - t) + GETUP_LIFT * Math.sin(Math.PI * t) * t
}

/** Shared with the viewmodel/shooting: where the player is looking from. */
export const playerRig = {
  position: new Vector3(),
  yaw: 0,
  pitch: 0,
  /** Horizontal speed, for bob/spread. */
  speed: 0,
  grounded: true,
  /** Camera recoil impulse (pitch radians), decays in the frame loop. */
  recoil: 0,
  /** Look velocity (rad/s), ~10 Hz smoothed — viewmodel sway reads these. */
  yawVelocity: 0,
  pitchVelocity: 0,
  /** Knockback: queue an XZ impulse (m/s); consumed into velocity next frame. */
  shove(dirX: number, dirZ: number, power: number): void {
    const len = Math.hypot(dirX, dirZ)
    if (len < 1e-6 || power <= 0) return
    shoveAccum.x += (dirX / len) * power
    shoveAccum.z += (dirZ / len) * power
  },
}

// --- Module-level combat state (reset when the Player mounts) --------------
const shoveAccum = { x: 0, z: 0 }
/** Summed-dt session clock — never Date.now() in render paths. */
let clock = 0
let lastDamageAt = -Infinity
/** Seconds left in the current stagger (only meaningful while staggered). */
let staggerT = 0
/** Seconds left in the get-up recovery beat (runs after the stagger ends). */
let recoverT = 0
/** Locally-pooled fractional regen hp, flushed to the store in chunks. */
let regenPool = 0

function enterStagger(): void {
  const s = useBoots.getState()
  s.setHealth(1)
  s.setStaggered(true)
  staggerT = STAGGER_TIME
  regenPool = 0
}

/**
 * Hurt the player (see API block above). `fromDir` = horizontal direction
 * from the attacker to the player; omit it for direction-less damage.
 */
export function damagePlayer(amount: number, fromDir?: { x: number; z: number }): void {
  const s = useBoots.getState()
  if (s.phase !== 'game' || amount <= 0) return
  lastDamageAt = clock
  regenPool = 0

  let angle: number | undefined
  if (fromDir) {
    const power =
      Math.min(SHOVE_MAX, amount * SHOVE_PER_DAMAGE) * (s.staggered ? STAGGER_SHOVE_SCALE : 1)
    playerRig.shove(fromDir.x, fromDir.z, power)
    // Screen-relative attacker bearing: attacker sits at -fromDir from the
    // player. 0 = straight ahead, +π/2 = to the right (camera yaw only).
    const ax = -fromDir.x
    const az = -fromDir.z
    const sinY = Math.sin(playerRig.yaw)
    const cosY = Math.cos(playerRig.yaw)
    angle = Math.atan2(ax * cosY - az * sinY, -ax * sinY - az * cosY)
  }

  // Directional edge flash: the HUD lights the screen edge(s) facing the hit.
  getSession()?.hud.damageFlash(angle)
  sfx.damage()

  if (s.staggered) return // mercy window: pushed around, but no hp loss
  const next = Math.max(0, s.health - amount)
  if (next <= 0) enterStagger()
  else s.setHealth(next)
}

/** Snapshot returned by `playerDebug.sample()` (live stagger-tuning traces). */
export type PlayerSample = {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  fov: number
  health: number
  staggered: boolean
  staggerT: number
  recoverT: number
  speed: number
}

/**
 * Dev-only handle (used by headless E2E): teleport the player rig, hurt the
 * player like a bot would, drain queued knockback (tests), and sample the
 * live camera/stagger state (`sample` only exists while Player is mounted;
 * it is also published as `globalThis.__bootsPlayer` for page eval).
 */
export const playerDebug: {
  teleport?: (x: number, z: number, yaw: number, pitch?: number) => void
  damage: typeof damagePlayer
  drainShove: () => { x: number; z: number }
  sample?: () => PlayerSample
} = {
  damage: damagePlayer,
  drainShove: () => {
    const out = { x: shoveAccum.x, z: shoveAccum.z }
    shoveAccum.x = 0
    shoveAccum.z = 0
    return out
  },
}

export function Player({ world }: { world: GameWorld }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const feet = useRef(new Vector3())
  const vel = useRef(new Vector3())
  const bobPhase = useRef(0)
  const stride = useRef(0)
  const prevGrounded = useRef(true)
  const fallSpeed = useRef(0)

  useEffect(() => {
    const session = getSession()
    if (session) {
      session.camera = camera
      session.savedCamera = {
        position: camera.position.toArray() as [number, number, number],
        quaternion: [
          camera.quaternion.x,
          camera.quaternion.y,
          camera.quaternion.z,
          camera.quaternion.w,
        ],
        fov: camera.fov,
      }
    }
    feet.current.copy(world.spawn)
    vel.current.set(0, 0, 0)
    playerRig.yaw = world.spawnYaw
    playerRig.pitch = 0
    playerRig.yawVelocity = 0
    playerRig.pitchVelocity = 0
    // Fresh combat clock per session.
    shoveAccum.x = 0
    shoveAccum.z = 0
    clock = 0
    lastDamageAt = -Infinity
    staggerT = 0
    recoverT = 0
    regenPool = 0
    camera.fov = GAME_FOV
    camera.updateProjectionMatrix()
    playerDebug.teleport = (x, z, yaw, pitch = 0) => {
      feet.current.set(x, 0, z)
      vel.current.set(0, 0, 0)
      playerRig.yaw = yaw
      playerRig.pitch = pitch
    }
    playerDebug.sample = () => {
      const s = useBoots.getState()
      return {
        x: feet.current.x,
        y: feet.current.y,
        z: feet.current.z,
        yaw: playerRig.yaw,
        pitch: camera.rotation.x,
        roll: camera.rotation.z,
        fov: camera.fov,
        health: s.health,
        staggered: s.staggered,
        staggerT,
        recoverT,
        speed: playerRig.speed,
      }
    }
    // Page-eval mirror of the dev handle (headless stagger tuning) — game-
    // root's `__boots` stays the stable surface; this one is player-scoped.
    ;(globalThis as Record<string, unknown>).__bootsPlayer = playerDebug
    // Restore handled by session.exitGame (it owns savedCamera).
    return () => {
      playerDebug.teleport = undefined
      playerDebug.sample = undefined
      delete (globalThis as Record<string, unknown>).__bootsPlayer
    }
  }, [camera, world])

  useFrame((_, rawDt) => {
    const session = getSession()
    if (!session) return
    const dt = Math.min(rawDt, 1 / 30)
    clock += dt
    const input = session.input

    const boots = useBoots.getState()
    // Safety net: anything still writing health<=0 directly (instead of
    // damagePlayer) also lands in the stagger path — never a death.
    if (!boots.staggered && boots.health <= 0) {
      lastDamageAt = clock
      enterStagger()
    }
    const staggered = useBoots.getState().staggered

    // Look.
    const { dx, dy } = input.consumeLook()
    const prevPitch = playerRig.pitch
    playerRig.yaw -= dx * SENSITIVITY
    playerRig.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, playerRig.pitch - dy * SENSITIVITY),
    )
    // Look velocity from the applied deltas (mouse-driven, so teleports
    // don't spike it), smoothed at ~10 Hz for the viewmodel sway.
    const invDt = 1 / Math.max(dt, 1e-4)
    const smooth = Math.min(1, dt * 10)
    playerRig.yawVelocity += (-dx * SENSITIVITY * invDt - playerRig.yawVelocity) * smooth
    playerRig.pitchVelocity += ((playerRig.pitch - prevPitch) * invDt - playerRig.pitchVelocity) * smooth
    playerRig.recoil = Math.max(0, playerRig.recoil - dt * 6 * playerRig.recoil - dt * 0.02)

    // Wish direction (camera-relative on XZ).
    const keys = input.state.keys
    let fwd = 0
    let side = 0
    if (keys.has('KeyW')) fwd += 1
    if (keys.has('KeyS')) fwd -= 1
    if (keys.has('KeyD')) side += 1
    if (keys.has('KeyA')) side -= 1
    const sinY = Math.sin(playerRig.yaw)
    const cosY = Math.cos(playerRig.yaw)
    const wishX = -sinY * fwd + cosY * side
    const wishZ = -cosY * fwd - sinY * side

    const jumped = stepVelocity(
      vel.current,
      {
        wishX,
        wishZ,
        // Staggered legs: forced down to walk speed (~half run), no jumping.
        walk: staggered || keys.has('ShiftLeft') || keys.has('ShiftRight'),
        jump: keys.has('Space') && !staggered,
      },
      playerRig.grounded,
      dt,
      MOVE,
    )
    if (jumped) sfx.jump()

    // Consume queued knockback impulses (playerRig.shove) into velocity.
    if (shoveAccum.x !== 0 || shoveAccum.z !== 0) {
      vel.current.x += shoveAccum.x
      vel.current.z += shoveAccum.z
      shoveAccum.x = 0
      shoveAccum.z = 0
    }

    fallSpeed.current = vel.current.y
    feet.current.addScaledVector(vel.current, dt)

    let grounded = collideCapsule(feet.current, vel.current, world.colliders, PLAYER_CAPSULE)
    grounded = collideVoxelWalls(
      feet.current,
      vel.current,
      PLAYER_CAPSULE.radius,
      PLAYER_CAPSULE.height,
    ) || grounded
    playerRig.grounded = grounded

    if (grounded && !prevGrounded.current && fallSpeed.current < -4) sfx.land()
    prevGrounded.current = grounded

    // Footsteps + view bob, cadenced by actual travel.
    const speed = Math.hypot(vel.current.x, vel.current.z)
    playerRig.speed = speed
    if (grounded && speed > 0.5) {
      stride.current += speed * dt
      bobPhase.current += speed * dt * 1.9
      if (stride.current > FOOTSTEP_STRIDE) {
        stride.current = 0
        sfx.footstep()
      }
    } else {
      bobPhase.current *= 1 - Math.min(1, dt * 10)
    }
    const bobY = Math.abs(Math.sin(bobPhase.current)) * 0.028 * Math.min(1, speed / MOVE.runSpeed)
    const bobX = Math.sin(bobPhase.current) * 0.014 * Math.min(1, speed / MOVE.runSpeed)

    playerRig.position.set(
      feet.current.x + cosY * bobX,
      feet.current.y + EYE_HEIGHT + bobY,
      feet.current.z - sinY * bobX,
    )

    // --- Stagger: 2.5s of woozy "almost died" instead of dying ------------
    let swayPitch = 0
    let swayRoll = 0
    let fovTarget = GAME_FOV
    if (staggered) {
      staggerT -= dt
      const progress = 1 - Math.max(0, staggerT) / STAGGER_TIME
      // Half-sine envelope: sway eases in, peaks mid-stagger, eases back out.
      const amp = Math.sin(Math.PI * Math.min(1, progress))
      // Two detuned rolls read woozy (drunken drift) where one pure sine
      // read metronomic; frequencies kept under ~0.45 Hz to stay clear of
      // the motion-sickness band.
      swayRoll = (Math.sin(clock * 2.7) + 0.5 * Math.sin(clock * 4.3 + 1.7)) * SWAY_ROLL_AMP * amp
      // Head-hang: slump eases in fast, holds for the whole stagger, and is
      // handed off to getUpPitch() at recovery so there is no pitch pop.
      const slump = Math.min(1, (progress * STAGGER_TIME) / SLUMP_EASE)
      swayPitch = Math.sin(clock * 1.8 + 0.9) * SWAY_PITCH_AMP * amp - SLUMP_PITCH * slump
      fovTarget = GAME_FOV - STAGGER_FOV_DROP * slump
      // Visuals/audio while downed are owned elsewhere: the HUD's stagger
      // overlay pulses off store.staggered, enemies.tsx drives the muffle +
      // heartbeat (health is pinned at 1, well under its 45hp threshold).
      if (staggerT <= 0) {
        const s = useBoots.getState()
        s.setStaggered(false)
        s.setHealth(STAGGER_RECOVER_HP)
        lastDamageAt = clock // regen resumes REGEN_DELAY after recovery
        regenPool = 0
        recoverT = RECOVER_TIME // start the get-up beat
      }
    } else {
      if (recoverT > 0) {
        // Get-up: slump releases with a small upward lift, FOV settles back.
        recoverT -= dt
        const u = 1 - Math.max(0, recoverT) / RECOVER_TIME
        swayPitch = getUpPitch(u)
        fovTarget = GAME_FOV - STAGGER_FOV_DROP * (1 - u) * (1 - u)
      }
      if (boots.health < 100 && clock - lastDamageAt >= REGEN_DELAY) {
        // Passive regen — pooled locally, flushed ~4x/s to keep HUD re-renders cheap.
        regenPool += REGEN_RATE * dt
        if (regenPool >= REGEN_WRITE_CHUNK || boots.health + regenPool >= 100) {
          useBoots.getState().setHealth(Math.min(100, boots.health + regenPool))
          regenPool = 0
        }
      }
    }

    // Smoothed FOV toward the stagger/recovery target (snap when close so
    // updateProjectionMatrix stops running once settled).
    if (camera.fov !== fovTarget) {
      const d = fovTarget - camera.fov
      camera.fov = Math.abs(d) < 0.02 ? fovTarget : camera.fov + d * Math.min(1, dt * 6)
      camera.updateProjectionMatrix()
    }

    camera.position.copy(playerRig.position)
    camera.rotation.order = 'YXZ'
    camera.rotation.set(playerRig.pitch + playerRig.recoil + swayPitch, playerRig.yaw, swayRoll)

    // Fall off the world guard.
    if (feet.current.y < -30) {
      feet.current.copy(world.spawn)
      vel.current.set(0, 0, 0)
    }
  })

  return null
}
