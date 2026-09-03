'use client'

import { type RootState, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { type PerspectiveCamera, Ray, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT, moveCapsule, PLAYER_CAPSULE } from './collision'
import { collideVoxelWalls } from './destruction'
import {
  addShake,
  advanceBob,
  advanceRoll,
  bobX,
  bobY,
  clampFrameDt,
  createFeelState,
  decayHurt,
  FEEL,
  type FeelState,
  hurtKick,
  landDip,
  resetFeelState,
  shakeOffsets,
  smoothEyeY,
  triggerLanding,
} from './feel'
import { guardedFrame, setFrameCrashHandler } from './frame-guard'
import { groundSurfaceY, lotFloorY } from './ground'
import { takeAction } from './input'
import { MOVE, type MoveConfig, projectOnWalkableSlope, stepVelocity } from './movement'
import { perfEvent } from './perf-monitor'
import { exitGame, getSession } from './session'
import { vehicleRig } from './vehicle-state'
import { type GameWorld, settleSpawnFeet } from './world'

/**
 * DAMAGE / STAGGER API (for enemies & pacing — the "you can't die" dynamic)
 * ---------------------------------------------------------------------------
 * `damagePlayer(amount, fromDir?)` — the one entry point for hurting the
 *   player. `fromDir` is the horizontal direction FROM the attacker TO the
 *   player (i.e. the push direction), any length — it's normalized here.
 *   It: lowers health (never below 0), resets the regen clock, shoves the
 *   player away (~2.5 m/s per 12 dmg, floored at 2.2 m/s so even light hits
 *   read as a shove, capped at 6), flashes the HUD vignette
 *   (passing the screen-relative attacker angle: 0 = ahead, +π/2 = right,
 *   for a future directional indicator) and plays sfx.damage().
 *   When health would hit 0 it does NOT kill: health pins to 1 and a 2.5s
 *   STAGGER starts — red pulsing screen, heartbeat, halved move speed, no
 *   jumping, woozy camera sway + head-hang slump + FOV tunnel, weapon droop
 *   + fire block (viewmodel). Damage landing during a stagger still
 *   shoves/flashes but costs no health, and the shove is dampened to 40% of
 *   the floored value (mercy window — pushed around, never juggled). The stagger ends at
 *   health 40 with a get-up beat: the slump releases through `getUpPitch`
 *   (small upward lift) while the FOV settles back, then regen resumes.
 *
 * `playerRig.shove(dirX, dirZ, power)` — knockback impulse in m/s on the XZ
 *   plane; direction is normalized, impulses accumulate and are consumed
 *   into the player velocity on the next frame. Safe to call from anywhere
 *   (enemies, explosions) — it never touches the camera directly.
 *
 * `playerRig.speedScale` — move-speed multiplier (default 1), consumed by the
 *   move loop every frame: it scales the run/walk TARGET speeds only, leaving
 *   gravity, jump and friction stock so acceleration keeps its snap. External
 *   systems own it (the rotary gun's spin-up drag in viewmodel.tsx lerps it
 *   1→0.55 with barrel spin); writers MUST hand back exactly 1 when done.
 *   Reset to 1 on session start. Keep values in (0, 1.5] — 0 would pin the
 *   player in place.
 *
 * `playerRig.ads` — aim-down-sights blend (0..1), WRITTEN by the viewmodel
 *   (arsenal owns the write; smooth or snap it there — this side just tracks
 *   it). Consumed here every frame: the camera FOV target lerps 92→60 with
 *   ads (the stagger tunnel drop stacks on top), the smoothed FOV only calls
 *   updateProjectionMatrix while |delta| > 0.1, and look sensitivity scales
 *   by current fov/92 so aimed flicks stay proportional on screen. Reset to
 *   0 on session start.
 *
 * `playerRig.shake(power)` — camera-shake impulse (explosions, heavy hits;
 *   arsenal/grenade call it). Impulses ACCUMULATE into a power pool (capped
 *   at 4) that drives a DAMPED 13 Hz OSCILLATOR (feel.ts: closed form in the
 *   time since the impulse, so 60 and 120 Hz displays see the same motion —
 *   not per-frame noise), ±0.012 rad × power, applied ON TOP of the camera
 *   rotation write only — playerRig.yaw/pitch state is never touched, so look
 *   input, viewmodel sway and the mouse feel stay clean. Safe to call from
 *   anywhere. damagePlayer adds a HURT KICK on top: a head-knock AWAY from
 *   the blow (roll) + a snap back (pitch) that agree with the HUD edge flash.
 *
 * TRUTH vs COSMETICS: `playerRig.position` is the TRUE eye (feet +
 *   EYE_HEIGHT, no bob/dip/lag) — the wire, builder, item-place, enemies and
 *   the aim ray all read it. Head bob, the landing dip, step-offset smoothing,
 *   strafe lean, shake and the hurt kick live on `camera.position/rotation`
 *   ONLY (feel.ts), so a remote avatar never inherits our bob and nothing
 *   placed from the eye ever sinks with a landing.
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
/** Full aim-down-sights FOV; playerRig.ads lerps GAME_FOV→ADS_FOV. */
const ADS_FOV = 60
const MAX_PITCH = Math.PI / 2 - 0.02
const _vehicleLookAt = new Vector3()
const _thirdDesired = new Vector3()
const _thirdDirection = new Vector3()
const _thirdHit = new Vector3()
const _thirdRay = new Ray()

const REGEN_DELAY = 4 // s after last damage before regen kicks in
const REGEN_RATE = 12 // hp/s
const REGEN_WRITE_CHUNK = 3 // hp per store write ≈ 4 writes/s at REGEN_RATE
const STAGGER_TIME = 2.5 // s
const STAGGER_RECOVER_HP = 40
const SHOVE_PER_DAMAGE = 2.5 / 12 // m/s of knockback per point of damage
/** Floor so every hit READS as a shove: light hits (dog nips at 9 dmg would
 * be 1.875 m/s) get lifted to 2.2 m/s. Measured slide through the real
 * stepVelocity (friction 7 + MOVE.stopSpeed crisp-stop trimming the tail,
 * dt=1/30): dog ≈ 0.24 m, droid ≈ 0.28 m, drone ≈ 0.34 m. Applied BEFORE
 * the mercy dampening, so downed nudges scale off the floored value — the
 * stagger-causing hit itself stays full power. */
const SHOVE_MIN = 2.2
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
  /** The TRUE eye = feet + EYE_HEIGHT, no bob/dip/lag — the wire, builder,
   * item-place, enemies and the aim ray all read it; cosmetics live on
   * camera.position only (see the API block). */
  position: new Vector3(),
  yaw: 0,
  pitch: 0,
  /** Horizontal speed, for bob/spread. */
  speed: 0,
  grounded: true,
  /** Head-bob phase (rad, |sin| humps, heel strike at the low point) and its
   * eased 0..1 amplitude — written by Player each frame, read by Viewmodel so
   * weapon and head bob share ONE phase. Player subscribes first (game-root
   * mount order + R3F's stable priority sort), so these are this frame's. */
  bobPhase: 0,
  bobAmp: 0,
  /** This frame's camera landing dip (m, ≥ 0) — read by Viewmodel (60 %). */
  landDip: 0,
  /** Camera recoil impulse (pitch radians), decays in the frame loop. */
  recoil: 0,
  /** Look velocity (rad/s), ~10 Hz smoothed — viewmodel sway reads these. */
  yawVelocity: 0,
  pitchVelocity: 0,
  /** Move-speed multiplier (see the API block): scales run/walk target
   * speeds in the move loop. Writers restore 1; reset on session start. */
  speedScale: 1,
  /** Aim-down-sights blend 0..1 (see the API block): viewmodel writes it,
   * the frame loop lerps FOV 92→60 and scales look sensitivity by fov/92. */
  ads: 0,
  /**
   * Rounds fired this session — monotone, incremented by the viewmodel on every
   * round that actually leaves a barrel (never on melee swings). Nothing local
   * reads it: it exists so the co-presence publisher can carry gunfire as a
   * counter on the pose frame (presence-interp's `f`), which is how peers get to
   * see and hear us shoot. A counter rather than a callback because the wire
   * wants an idempotent number, and because a pull we publish twice must not be
   * two bangs on their screen.
   */
  shots: 0,
  /** Knockback: queue an XZ impulse (m/s); consumed into velocity next frame. */
  shove(dirX: number, dirZ: number, power: number): void {
    const len = Math.hypot(dirX, dirZ)
    if (len < 1e-6 || power <= 0) return
    shoveAccum.x += (dirX / len) * power
    shoveAccum.z += (dirZ / len) * power
  },
  /** Vertical LAUNCH impulse (m/s) — explosions throw the player into the
   * air ("fly away a few meters"). Consumed into vel.y next frame; capped
   * so a point-blank grenade lofts, never orbits. */
  launch(power: number): void {
    if (!(power > 0)) return
    launchAccum = Math.max(launchAccum, Math.min(power, 9))
  },
  /** Camera-shake impulse (see the API block): accumulates power (cap 4)
   * into a damped 13 Hz oscillator (not noise), applied as a rotation
   * OFFSET only — never state. */
  shake(power: number): void {
    addShake(feel, power, 1)
  },
}

// --- Module-level combat state (reset when the Player mounts) --------------
const shoveAccum = { x: 0, z: 0 }
/** Pending vertical launch impulse (playerRig.launch), consumed per frame. */
let launchAccum = 0
/** Camera feel state (bob/dip/roll/shake/hurt) — feel.ts pure core; reset on
 * mount. Module-level so damagePlayer and playerRig.shake reach it. */
const feel = createFeelState()
/** Reused shake output — written by shakeOffsets every frame, never re-made. */
const _shake = { pitch: 0, yaw: 0 }
/** Reused MoveConfig for playerRig.speedScale ≠ 1 — module temp, only the
 * two target speeds are rewritten per frame, never a fresh object. */
const scaledMove: MoveConfig = { ...MOVE }
/** Summed-dt session clock — never Date.now() in render paths. */
let clock = 0
/** Loop health counters for QA (sample.loopCalls / loopNoSession): how many
 * times the frame callback ran this session and how many of those returned
 * early because no session was live — a frozen game clock with frames still
 * flowing is one of these two, and the sample says which. */
let loopCalls = 0
let loopNoSession = 0
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
      Math.min(SHOVE_MAX, Math.max(SHOVE_MIN, amount * SHOVE_PER_DAMAGE)) *
      (s.staggered ? STAGGER_SHOVE_SCALE : 1)
    playerRig.shove(fromDir.x, fromDir.z, power)
    // Screen-relative attacker bearing: attacker sits at -fromDir from the
    // player. 0 = straight ahead, +π/2 = to the right (camera yaw only).
    const ax = -fromDir.x
    const az = -fromDir.z
    const sinY = Math.sin(playerRig.yaw)
    const cosY = Math.cos(playerRig.yaw)
    angle = Math.atan2(ax * cosY - az * sinY, -ax * sinY - az * cosY)
  }

  // FELT hit: head-knock away from the blow + a short 13 Hz kick (feel.ts).
  // The roll sign agrees with the HUD flash below — a hit from the right
  // lights the right edge and knocks the head LEFT. The mercy window dampens
  // it exactly like the shove.
  const kick = hurtKick(feel, amount, angle) * (s.staggered ? STAGGER_SHOVE_SCALE : 1)
  addShake(feel, kick, feel.shakeSign)

  // Directional edge flash: the HUD lights the screen edge(s) facing the hit.
  getSession()?.hud.damageFlash(angle)
  sfx.damage(amount) // a bigger hit is a sharper hurt (audio.ts hurtMix)

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
  /** Rounds fired this session — the local end of remote gunfire (peers read
   * this counter off the pose frame and voice the difference). */
  shots: number
  /** Feel QA: heel strikes so far, this frame's landing dip (m), shake power,
   * the COSMETIC camera height (vs y + EYE_HEIGHT, the true eye) and the
   * hurt roll (rad, + = head knocked left). */
  footsteps: number
  dip: number
  shake: number
  camY: number
  hurtRoll: number
  /** Session game-time (summed clamped dt, s) — harnesses pace themselves on
   * it: a slow headless page clamps dt to 1/30, so wall time ≠ game time. */
  clock: number
  /** Loop health: frame-callback entries this session / early returns for
   * "no live session" (see the counters' doc). */
  loopCalls: number
  loopNoSession: number
}

/** How far under the lot floor counts as "fell out of the world". */
const FALL_OUT_DEPTH = 30

/**
 * Dev-only handle (used by headless E2E): teleport the player rig, hurt the
 * player like a bot would, drain queued knockback (tests), and sample the
 * live camera/stagger state (`sample` only exists while Player is mounted;
 * it is also published as `globalThis.__bootsPlayer` for page eval).
 */
export const playerDebug: {
  teleport?: (x: number, z: number, yaw: number, pitch?: number, y?: number) => void
  damage: typeof damagePlayer
  drainShove: () => { x: number; z: number }
  sample?: () => PlayerSample
  /** The live feel state (tests reset it; QA reads it) — module-level. */
  feel: () => FeelState
} = {
  damage: damagePlayer,
  feel: () => feel,
  drainShove: () => {
    const out = { x: shoveAccum.x, z: shoveAccum.z }
    shoveAccum.x = 0
    shoveAccum.z = 0
    return out
  },
}

/**
 * Pure teleport application — the session-scoped playerDebug.teleport closure
 * delegates here with its live feet/vel refs. `y` is optional (multi-storey
 * E2E lands the rig on an upper floor); omitted, the feet land on the GROUND
 * at (x, z) — a literal 0 dropped QA five metres into an excavated yard, or
 * buried the rig in a hill until the capsule shoved it out sideways. Flat
 * lots have no probe installed, so the default is still exactly 0 there.
 */
export function applyTeleport(
  feet: Vector3,
  vel: Vector3,
  x: number,
  z: number,
  yaw: number,
  pitch = 0,
  y = groundSurfaceY(x, z),
): void {
  // QA teleports jump the camera across the map — the culling/BVH work the
  // next frame pays is not a gameplay spike, so let the perf log name it.
  perfEvent('teleport')
  feet.set(x, y, z)
  vel.set(0, 0, 0)
  playerRig.yaw = yaw
  playerRig.pitch = pitch
}

export function Player({ world }: { world: GameWorld }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const feet = useRef(new Vector3())
  const vel = useRef(new Vector3())
  /** Ground contact normal from the LAST move (moveCapsule writes it) —
   * the plane the next tick's grounded velocity rides at full speed. */
  const groundNormal = useRef(new Vector3(0, 1, 0))
  const prevGrounded = useRef(true)

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
    // SPAWN SETTLE (big-project jump-in): world.spawn.y was probed at
    // snapshot time, but the LIVE collider set can differ by mount time —
    // stand on the topmost walkable surface at the spawn XZ and lift free
    // if the capsule starts interpenetrated. Starting buried is the one
    // shape push-out can't fix (triangles deeper than the capsule radius
    // are invisible to it), and it read as "spawns half into the ground".
    settleSpawnFeet(world.colliders, feet.current, PLAYER_CAPSULE)
    vel.current.set(0, 0, 0)
    groundNormal.current.set(0, 1, 0)
    playerRig.yaw = world.spawnYaw
    playerRig.pitch = 0
    playerRig.yawVelocity = 0
    playerRig.pitchVelocity = 0
    playerRig.speedScale = 1
    playerRig.ads = 0
    // Not reset with the rest: the fire counter is a WIRE counter, and peers
    // track it by difference against the last value they saw. Rewinding it to 0
    // between sessions would read as a 200-round jump — harmless (the delta is
    // capped) but pointless. It wraps on its own at 256.
    // Fresh combat clock per session.
    shoveAccum.x = 0
    shoveAccum.z = 0
    resetFeelState(feel)
    clock = 0
    loopCalls = 0
    loopNoSession = 0
    lastDamageAt = -Infinity
    staggerT = 0
    recoverT = 0
    regenPool = 0
    camera.fov = GAME_FOV
    camera.updateProjectionMatrix()
    // y left undefined on purpose: applyTeleport's default probes the ground.
    playerDebug.teleport = (x, z, yaw, pitch = 0, y) =>
      applyTeleport(feet.current, vel.current, x, z, yaw, pitch, y)
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
        // Remote-gunfire QA: what the pose publisher is carrying, so a
        // two-client run can tell "A never fired" apart from "the counter
        // never crossed the wire" — two very different bugs.
        shots: playerRig.shots,
        // Climb-feel QA: the contact plane the next tick's velocity rides
        // (projectOnWalkableSlope) + whether the mover is grounded at all.
        grounded: playerRig.grounded,
        groundNy: groundNormal.current.y,
        velY: vel.current.y,
        // Feel QA (docs/qa/qa-boots-feel.mjs): heel strikes, this frame's
        // dip, shake power, the cosmetic camera height and the hurt roll.
        footsteps: feel.footsteps,
        dip: playerRig.landDip,
        shake: feel.shakeAmp,
        camY: camera.position.y,
        hurtRoll: feel.hurtRoll,
        clock,
        loopCalls,
        loopNoSession,
      }
    }
    // Page-eval mirror of the dev handle (headless stagger tuning) — game-
    // root's `__boots` stays the stable surface; this one is player-scoped.
    ;(globalThis as Record<string, unknown>).__bootsPlayer = playerDebug
    // Frame crash guard (frame-guard.ts): three consecutive throws at one
    // guarded site end the session cleanly instead of freezing fullscreen
    // with the inputs swallowed. Player is the session's first child, so the
    // handler is live for every guarded loop of the session.
    setFrameCrashHandler(exitGame)
    // Restore handled by session.exitGame (it owns savedCamera).
    return () => {
      setFrameCrashHandler(null)
      playerDebug.teleport = undefined
      playerDebug.sample = undefined
      delete (globalThis as Record<string, unknown>).__bootsPlayer
    }
  }, [camera, world])

  useFrame(guardedFrame('player', (_: RootState, rawDt: number) => {
    loopCalls++
    const session = getSession()
    if (!session) {
      loopNoSession++
      return
    }
    // 0 on a rewound/NaN clock frame (a no-op frame), capped at 1/30.
    const dt = clampFrameDt(rawDt)
    clock += dt
    const input = session.input

    // Tab is a persistent camera toggle, on foot as well as in the truck.
    // GunTable owns the same action at priority -2 while driving.
    if (!vehicleRig.driving && takeAction(input.state.actions, 'Tab')) {
      vehicleRig.view = vehicleRig.view === 'first' ? 'third' : 'first'
    }

    const boots = useBoots.getState()
    // Safety net: anything still writing health<=0 directly (instead of
    // damagePlayer) also lands in the stagger path — never a death.
    if (!boots.staggered && boots.health <= 0) {
      lastDamageAt = clock
      enterStagger()
    }
    const staggered = useBoots.getState().staggered

    // Look. Sensitivity scales with the CURRENT (smoothed) fov so ADS zoom
    // keeps flicks proportional on screen — fov/92 = 1 at hip, ~0.65 aimed.
    const { dx, dy } = input.consumeLook()
    const sens = SENSITIVITY * (camera.fov / GAME_FOV)
    const prevPitch = playerRig.pitch
    playerRig.yaw -= dx * sens
    playerRig.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, playerRig.pitch - dy * sens),
    )
    // Look velocity from the applied deltas (mouse-driven, so teleports
    // don't spike it), smoothed at ~10 Hz for the viewmodel sway.
    const invDt = dt > 1e-4 ? 1 / dt : 0
    const smooth = Math.min(1, dt * 10)
    playerRig.yawVelocity += (-dx * sens * invDt - playerRig.yawVelocity) * smooth
    playerRig.pitchVelocity += ((playerRig.pitch - prevPitch) * invDt - playerRig.pitchVelocity) * smooth
    playerRig.recoil = Math.max(0, playerRig.recoil - dt * 6 * playerRig.recoil - dt * 0.02)

    // The convoy controller runs at priority -2 and writes the live cab seat
    // before Player's default-priority frame. While driving, the vehicle owns
    // translation and WASD; mouse look remains free so the cab is genuinely
    // first-person instead of welding the camera to the windscreen.
    if (vehicleRig.driving) {
      feet.current.set(vehicleRig.seatX, vehicleRig.seatY, vehicleRig.seatZ)
      vel.current.set(0, 0, 0)
      groundNormal.current.set(0, 1, 0)
      playerRig.grounded = true
      playerRig.speed = Math.abs(vehicleRig.speed)
      playerRig.bobPhase = feel.bobPhase
      playerRig.bobAmp = 0
      playerRig.landDip = 0
      playerRig.position.set(feet.current.x, feet.current.y + EYE_HEIGHT, feet.current.z)
      prevGrounded.current = true
      if (camera.fov !== GAME_FOV) {
        camera.fov += (GAME_FOV - camera.fov) * Math.min(1, dt * 8)
        if (Math.abs(camera.fov - GAME_FOV) < 0.1) camera.fov = GAME_FOV
        camera.updateProjectionMatrix()
      }
      if (vehicleRig.view === 'third') {
        // Stable chase/orbit view: mouse yaw circles the convoy and pitch
        // lifts the boom, while the target remains the live cab. Keeping the
        // true playerRig position in the seat preserves every interaction and
        // network invariant; only the cosmetic camera moves.
        // High enough to see over the supply trailer instead of placing its
        // rear panel in the center of the chase view.
        const distance = 7.4
        const lift = 4.25 + Math.sin(playerRig.pitch) * 2.15
        camera.position.set(
          playerRig.position.x + Math.sin(playerRig.yaw) * distance,
          playerRig.position.y + lift,
          playerRig.position.z + Math.cos(playerRig.yaw) * distance,
        )
        _vehicleLookAt.set(
          playerRig.position.x,
          playerRig.position.y + 0.55,
          playerRig.position.z,
        )
        camera.lookAt(_vehicleLookAt)
      } else {
        camera.position.copy(playerRig.position)
        camera.rotation.order = 'YXZ'
        camera.rotation.set(playerRig.pitch, playerRig.yaw, 0)
      }
      return
    }

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

    // speedScale (rotary spin-up drag, etc.): scale the run/walk targets
    // only — gravity/jump/friction stay stock so the feel keeps its snap.
    let moveCfg = MOVE
    if (playerRig.speedScale !== 1) {
      scaledMove.runSpeed = MOVE.runSpeed * playerRig.speedScale
      scaledMove.walkSpeed = MOVE.walkSpeed * playerRig.speedScale
      moveCfg = scaledMove
    }

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
      moveCfg,
    )
    if (jumped) sfx.jump()

    // FULL-SPEED SLOPES (genre parity): while grounded on a walkable slope
    // (last move's contact plane), ride the plane — vel keeps its horizontal
    // speed and takes exactly the rise/drop the slope demands, so ramps climb
    // as fast as flat ground runs and nothing patters airborne downhill.
    // Jump frames keep their fresh vel.y; the projection is a no-op on flat
    // ground and leaves steeper-than-walkable contacts to the legacy clip.
    if (playerRig.grounded && !jumped) {
      projectOnWalkableSlope(
        vel.current,
        groundNormal.current.x,
        groundNormal.current.y,
        groundNormal.current.z,
      )
    }

    // Consume queued knockback impulses (playerRig.shove) into velocity.
    if (shoveAccum.x !== 0 || shoveAccum.z !== 0) {
      vel.current.x += shoveAccum.x
      vel.current.z += shoveAccum.z
      shoveAccum.x = 0
      shoveAccum.z = 0
    }
    // Vertical launch (playerRig.launch — explosions): straight into vel.y,
    // never additive past the impulse itself so stacked blasts loft, not orbit.
    if (launchAccum > 0) {
      vel.current.y = Math.max(vel.current.y, launchAccum)
      launchAccum = 0
    }

    const fallSpeed = vel.current.y
    // Integrate + slide + STEP OFFSET + ground snap (collision.moveCapsule):
    // blocked risers within STEP_OFFSET lift in-stride at full speed.
    let grounded = moveCapsule(
      feet.current,
      vel.current,
      dt,
      world.colliders,
      playerRig.grounded,
      jumped,
      PLAYER_CAPSULE,
      groundNormal.current,
    )
    grounded = collideVoxelWalls(
      feet.current,
      vel.current,
      PLAYER_CAPSULE.radius,
      PLAYER_CAPSULE.height,
    ) || grounded
    playerRig.grounded = grounded

    if (grounded && !prevGrounded.current) {
      // Touchdown: the camera dips from a curb (−3 m/s, feel.ts), the thump
      // only voices for a real drop (−4 m/s: a 0.5 m ledge, a jump).
      triggerLanding(feel, fallSpeed)
      // The thump carries the dip's depth: a heavier landing lands lower/louder.
      if (fallSpeed < -FEEL.LAND_SFX_FALL) sfx.land(feel.landDepth / FEEL.LAND_DIP_MAX)
    }
    prevGrounded.current = grounded

    // Footsteps + head bob share ONE phase, cadenced by actual travel: the
    // footstep voices at the bob low point (heel strike). The phase freezes
    // on a stop / in the air (only the amplitude eases out) — the old
    // multiplicative phase decay aliased into a 26 mm/frame eye buzz on every
    // jump at run speed.
    const speed = Math.hypot(vel.current.x, vel.current.z)
    playerRig.speed = speed
    // The step carries its pace: a walk is softer than a run.
    if (advanceBob(feel, speed, grounded, MOVE.runSpeed, dt)) sfx.footstep(speed / MOVE.runSpeed)
    const dip = landDip(feel, dt)
    const bY = bobY(feel)
    const bX = bobX(feel)
    // Step-offset lifts ride an eased eye (≤ 0.35 m over ~200 ms) instead of
    // popping the camera up a whole riser in one frame; the TRUE eye below
    // still snaps — only the render lags. The pre-move vel.y × dt is the rise
    // the velocity already explains (a slope ride, the last fall frame) and
    // passes straight through — only the collider's unexplained lift eases,
    // so a 43° stairs sprint no longer sinks the camera 24 cm into the treads.
    const camFeetY = smoothEyeY(feel, feet.current.y, grounded, dt, fallSpeed * dt)

    // TRUTH: the exact eye — no bob, no dip, no lag. Everything that is not
    // the camera reads this (and the wire carries it), so remote avatars stop
    // double-bobbing and nothing placed from the eye sinks with a landing.
    playerRig.position.set(feet.current.x, feet.current.y + EYE_HEIGHT, feet.current.z)
    playerRig.bobPhase = feel.bobPhase
    playerRig.bobAmp = feel.bobAmp
    playerRig.landDip = dip

    // Strafe lean: velocity along the camera's right vector (cosY, −sinY) —
    // the same basis as wishX/wishZ above. Thumb mode gets no lean (a phone
    // in the hands has no horizon to tilt against).
    const touch = input.touchMode
    const lateral = vel.current.x * cosY - vel.current.z * sinY
    const roll = advanceRoll(feel, touch ? 0 : lateral, MOVE.runSpeed, dt)

    // --- Stagger: 2.5s of woozy "almost died" instead of dying ------------
    // ADS zoom base: the viewmodel writes playerRig.ads (0..1); FOV lerps
    // 92→60 with it and the stagger tunnel drop stacks on top of that base.
    const ads = playerRig.ads < 0 ? 0 : playerRig.ads > 1 ? 1 : playerRig.ads
    const baseFov = GAME_FOV + (ADS_FOV - GAME_FOV) * ads
    let swayPitch = 0
    let swayRoll = 0
    let fovTarget = baseFov
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
      fovTarget = baseFov - STAGGER_FOV_DROP * slump
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
        fovTarget = baseFov - STAGGER_FOV_DROP * (1 - u) * (1 - u)
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

    // Smoothed FOV toward the ads/stagger/recovery target (snap when the
    // delta drops under 0.1 deg so updateProjectionMatrix stops running
    // once settled — the last 0.1 deg is invisible).
    if (camera.fov !== fovTarget) {
      const d = fovTarget - camera.fov
      camera.fov = Math.abs(d) < 0.1 ? fovTarget : camera.fov + d * Math.min(1, dt * 6)
      camera.updateProjectionMatrix()
    }

    // Camera shake (playerRig.shake / hurt kick impulses): a damped 13 Hz
    // oscillator OFFSET on the rotation write only — yaw/pitch state stays
    // untouched. Zero Math.random, zero allocation.
    shakeOffsets(feel, dt, _shake)
    decayHurt(feel, dt)
    const shakeK = touch ? FEEL.TOUCH_SHAKE_SCALE : 1
    const landPitch = touch ? 0 : dip * FEEL.LAND_PITCH_PER_M

    // COSMETICS — applied here and nowhere else: bob (lateral along the right
    // vector), eased step height, landing dip, strafe lean, shake, hurt kick.
    // The viewmodel copies camera.position/quaternion so it rides along;
    // aimDirection reads playerRig.yaw/pitch and never sees any of this.
    if (vehicleRig.view === 'third') {
      // Fortnite-style right-shoulder chase camera. Keep its look parallel to
      // the authoritative aim ray, then pull the boom in against walls so it
      // cannot see through a room the player is standing inside.
      _thirdDesired.set(
        playerRig.position.x + Math.sin(playerRig.yaw) * 4.15 + cosY * 0.68,
        playerRig.position.y + 0.9,
        playerRig.position.z + Math.cos(playerRig.yaw) * 4.15 - sinY * 0.68,
      )
      _thirdDirection.subVectors(_thirdDesired, playerRig.position)
      const wanted = _thirdDirection.length()
      _thirdDirection.multiplyScalar(1 / Math.max(wanted, 1e-6))
      _thirdRay.set(playerRig.position, _thirdDirection)
      let allowed = wanted
      for (const collider of world.colliders) {
        if (collider.disabled || collider.worldBox.containsPoint(playerRig.position)) continue
        if (!_thirdRay.intersectBox(collider.worldBox, _thirdHit)) continue
        const hitDistance = _thirdHit.distanceTo(playerRig.position)
        if (hitDistance < allowed) allowed = Math.max(0.45, hitDistance - 0.16)
      }
      camera.position.copy(playerRig.position).addScaledVector(_thirdDirection, allowed)
      camera.rotation.order = 'YXZ'
      camera.rotation.set(playerRig.pitch, playerRig.yaw, 0)
    } else {
      camera.position.set(
        playerRig.position.x + cosY * bX,
        camFeetY + EYE_HEIGHT + bY - dip,
        playerRig.position.z - sinY * bX,
      )
      camera.rotation.order = 'YXZ'
      camera.rotation.set(
        playerRig.pitch +
          playerRig.recoil +
          swayPitch +
          (_shake.pitch + feel.hurtPitch) * shakeK -
          landPitch,
        playerRig.yaw + _shake.yaw * shakeK,
        swayRoll + roll + feel.hurtRoll * shakeK,
      )
    }

    // Fall off the world guard. Re-settle: the ground at the spawn XZ may
    // have changed since the snapshot (voxelized away, pieces placed). The
    // trip line hangs BELOW the lot floor, not below an absolute −30: a yard
    // excavated deeper than that used to respawn the player for standing in
    // his own pit.
    if (feet.current.y < lotFloorY() - FALL_OUT_DEPTH) {
      feet.current.copy(world.spawn)
      settleSpawnFeet(world.colliders, feet.current, PLAYER_CAPSULE)
      vel.current.set(0, 0, 0)
    }
  }))

  return null
}
