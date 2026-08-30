'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import {
  BoxGeometry,
  CylinderGeometry,
  type Group,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three'
import { useBoots } from '../store'
import { HEARTBEAT_HP, type HeartbeatHandle, heartbeatBpm, lowHpSeverity, sfx } from './audio'
import { collideCapsule } from './collision'
import { collideVoxelTargets, raycastVoxelTargets } from './destruction'
import { doorsDebug } from './doors'
import {
  ACCENT_PALETTE,
  accrueDoorStuck,
  ALERT_SECONDS,
  BOT_STATS,
  type Bot,
  bots,
  debugFlags,
  DOOR_FUMBLE_RANGE,
  DOOR_FUMBLE_SECONDS,
  DOOR_MISSION_TTL,
  DOOR_SCAN_RANGE,
  doorIsClosed,
  doorScanDue,
  DRONE_CAPSULE,
  DRONE_DESCENT_PROBE,
  droneDescentBlocked,
  dronePathBlocked,
  GROUND_BOT_CAPSULE,
  pickDoorCandidate,
  segmentHitsBox,
  resetBotProbeBudget,
  resetBots,
  setDoorApproach,
  settleGroundBot,
  spawnBot,
  tickWaveDirector,
  waveState,
} from './enemies-state'
import { perfEvent } from './perf-monitor'
import { damagePlayer, playerRig } from './player'
import { getSession } from './session'
import { type GameWorld, spawnGroundY } from './world'

/**
 * Wave-based horde: humanoid droids, robot dogs, FPV drones — they beeline
 * for you and you mow them down.
 *
 * BOT WALL RULE (owned here): ground bots never phase through solid walls,
 * live voxels or placed builder pieces. Each droid/dog gets ONE capsule pass
 * per frame (GROUND_BOT_CAPSULE, r 0.35 h 1.2) — collideCapsule vs
 * world.colliders then collideVoxelTargets vs live voxel grids, exactly the
 * player's resolution path. Steering is intent: the capsule is truth.
 * - WALL-FOLLOW: intended vs actual displacement is tracked per bot; when
 *   the blocked ratio exceeds 0.7 for 0.4s the bot strafes along the
 *   obstacle tangent (side seeded from whichever way the wall already let
 *   it slide) for up to 1.2s, then re-seeks — so they round corners and
 *   pour through door openings and breaches instead of grinding on drywall.
 * - DOOR FUMBLE (bots learn doorways): a droid/dog hindered (blocked or
 *   wall-following) past DOOR_STUCK_TIME scans for the nearest still-closed
 *   door within DOOR_SCAN_RANGE — at most once per DOOR_SCAN_PERIOD, and
 *   ONLY while stuck (budget). On a hit it walks to the approach point,
 *   pauses DOOR_FUMBLE_SECONDS at the leaf (legs freeze + sfx.doorLatch —
 *   the tell), then flips the door through the doors module's public
 *   doorsDebug.toggle — the same interact path E uses, so the creak, the
 *   swing and the collider drop all come from there — and paths through.
 *   Missions abort after DOOR_MISSION_TTL; a door the player opened
 *   mid-fumble is left alone (doorIsClosed re-check). Drones ignore all of
 *   this — they climb. Pure clocks + candidate pick live in enemies-state.
 * - MELEE LOS (ALL bots, drones included): an attack only lands if
 *   raycastVoxelTargets + an exact segment-vs-collider-box sweep show clear
 *   air to the player — no punching through a sheet of drywall, a closed
 *   door leaf, or an elevated wall under a drone; a blocked attack triggers
 *   wall-follow (ground bots) or a retry pause (drones).
 * - GROUND SETTLE (bots on floors): droids/dogs settle toward the live
 *   landing plane under their feet (enemies-state.settleGroundBot →
 *   destruction.probeLandingY, cached ~0.2 s per bot, never per frame) —
 *   they stand on slabs/upper floors, and a carved hole underfoot drops
 *   them to the storey below. No stair pathing yet.
 * - DRONE WALL RULE: drones get the SAME truth as ground bots — one
 *   drone-sized capsule pass per frame (DRONE_CAPSULE around the body
 *   center) through collideCapsule + collideVoxelTargets, run AFTER the
 *   altitude lerp and the horizontal step, so neither axis can phase
 *   through walls, roofs or placed pieces. Steering stays probe-based
 *   (enemies-state pure math, vs collider worldBoxes — voxelized walls
 *   keep their box, so drones climb over buildings rather than thread
 *   breaches): a path-aware probe samples the intended DISPLACEMENT
 *   (~1.2 m ahead, vertical intent included, plus a wall-top skim point)
 *   and feeds `bot.climb` — rise while blocked, barely advance mid-climb —
 *   and before any altitude comes back the DESCENT CORRIDOR under the
 *   rotors is probed: blocked → hold, so an elevated floor or roof is
 *   cover you can hide under, exactly like ground walls. Drone reach is
 *   3D — a drone parked high over your roof is NOT in range.
 *
 * Pacing (see enemies-state.ts for the state shape + tickWaveDirector):
 * - Peaceful until the industrial breaker switch is thrown (guntable.tsx →
 *   armWaves() — gun pickups never wake the horde), then a 5s "⚠ AI robot
 *   zombies incoming — N" countdown on the wave line (waveState.
 *   countdownActive is true for exactly that window — the switch-wall siren
 *   spins off it), then WAVE 1 and the normal director.
 * - Countdown audio: sfx.machineSpinup() — a dedicated gear-up voice whose
 *   setProgress(0..1) sweeps pitch/filter/tremolo/level across the 5s; each
 *   tick lands a relay clack (doorLatch), the final second an arming rack
 *   (reload). At zero the spin-up stops and the wave line flashes HERE THEY
 *   COME (first wave only; later waves keep the plain WAVE N label).
 * - Melee routes through player.tsx `damagePlayer` (knockback + directional
 *   flash + stagger come for free — no local sfx/flash here).
 * - Stagger mercy: bots never attack a staggered player; ground bots hold a
 *   4–6 m ring, drones climb +1 m and hover in place.
 * - Concussion audio: sfx.setMuffle(1) while staggered, and a heartbeat
 *   whose rate climbs 70→150 bpm as health falls below 45.
 */

const KIND_CYCLE = ['droid', 'dog', 'droid', 'drone', 'dog', 'drone'] as const

/** Stagger-mercy standoff ring for ground bots (m). */
const MERCY_MIN = 4
const MERCY_MAX = 6

// --- BOT WALL RULE tuning (see header) --------------------------------------
/** Blocked when actual displacement falls under 30% of intent... */
const BLOCKED_RATIO = 0.7
/** ...sustained this long before wall-follow kicks in (s). */
const BLOCKED_TIME = 0.4
/** How long a bot strafes the obstacle tangent before re-seeking (s). */
const FOLLOW_TIME = 1.2
/** Drone forward probe distance (m) + climb/settle rates (m/s). */
const DRONE_PROBE = 1.2
const DRONE_CLIMB_RATE = 3
const DRONE_SETTLE_RATE = 0.8
const DRONE_CLIMB_MAX = 14
/** Retry pause after a melee attempt is blocked by a wall (s). */
const MELEE_BLOCKED_RETRY = 0.4

const _toPlayer = new Vector3()
const _center = new Vector3()
const _botVel = new Vector3()
const _droneFeet = new Vector3()
const _chest = new Vector3()
const _meleeDir = new Vector3()
const _doorCenter = new Vector3()

/** Spawn the next wave in a ring around the building. */
function spawnWave(world: GameWorld): void {
  perfEvent('wave-spawn')
  waveState.wave++
  waveState.intermission = 5
  const count = 3 + waveState.wave * 2
  const center = world.buildingAabb.isEmpty()
    ? _center.set(0, 0, 0)
    : world.buildingAabb.getCenter(_center)
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 22 + Math.random() * 12
    const x = center.x + Math.cos(angle) * radius
    const z = center.z + Math.sin(angle) * radius
    // Ring points spawn ON the ground, hill or excavation — spawnGroundY
    // probes the (solid) terrain and falls back to the heightfield off-lot.
    // It no longer clamps to ≥ 0: that clamp put a whole wave five metres in
    // the air over the owner's dug-out yards.
    spawnBot(KIND_CYCLE[i % KIND_CYCLE.length]!, x, z, spawnGroundY(world.colliders, x, z))
  }
}

/** True when a solid sits between the bot's chest and the player's head —
 * melee never lands through drywall, a closed door, or an elevated wall.
 * Voxel grids get a real ray (their thin skins would slip between point
 * samples); non-voxelized solids (closed doors, props, pristine walls) an
 * exact segment-vs-worldBox sweep (enemies-state.segmentHitsBox — a single
 * midpoint probe used to miss a door leaf near either end of the swing).
 * Gates ALL bot kinds, drones included. Attack-frames only, never per-frame. */
export function meleeBlocked(world: GameWorld, bot: Bot): boolean {
  _chest.set(bot.position.x, bot.position.y + BOT_STATS[bot.kind].bodyY, bot.position.z)
  _meleeDir.copy(playerRig.position).sub(_chest)
  const len = _meleeDir.length()
  if (len < 1e-4) return false
  _meleeDir.divideScalar(len)
  if (raycastVoxelTargets(_chest, _meleeDir, len)) return true
  for (const collider of world.colliders) {
    // walkOnly planks are capsule-only — their voxel grid answered above.
    if (collider.disabled || collider.walkOnly) continue
    if (
      segmentHitsBox(
        collider.worldBox,
        _chest.x,
        _chest.y,
        _chest.z,
        _meleeDir.x,
        _meleeDir.y,
        _meleeDir.z,
        len,
      )
    ) {
      return true
    }
  }
  return false
}

export function Enemies({ world }: { world: GameWorld }) {
  const [tick, setTick] = useState(0)
  /** Rolling hash of (id, state) per bot — the remount change gate below
   * stays allocation-free (no per-frame signature strings). */
  const signature = useRef(0)
  const buzz = useRef<ReturnType<typeof sfx.droneBuzz>>(null)
  /** Gear-up voice under the countdown (null without WebAudio). */
  const spinup = useRef<ReturnType<typeof sfx.machineSpinup>>(null)
  /** Last countdown second a tell played for (0 = none pending). */
  const countdownTick = useRef(0)
  /** Label shown while waveLabelT runs; null → plain `WAVE n`. */
  const spawnLabel = useRef<string | null>(null)
  const waveLabelT = useRef(0)
  const waveText = useRef<string | null>(null)
  const staggerWas = useRef(false)
  const heart = useRef<HeartbeatHandle | null>(null)
  /** Alive count last frame — the alive>0 → 0 edge fires the banner. */
  const aliveWas = useRef(0)

  useEffect(() => {
    resetBots()
    buzz.current = sfx.droneBuzz()
    return () => {
      buzz.current?.stop()
      spinup.current?.stop()
      spinup.current = null
      heart.current?.stop()
      heart.current = null
      sfx.setMuffle?.(0)
      resetBots()
    }
  }, [])

  useFrame((_, rawDt) => {
    const session = getSession()
    if (!session) return
    const dt = Math.min(rawDt, 1 / 30)
    const boots = useBoots.getState()
    const staggered = boots.staggered

    // Concussion audio — guarded so integration order can't crash.
    if (staggered !== staggerWas.current) {
      staggerWas.current = staggered
      sfx.setMuffle?.(staggered ? 1 : 0)
    }
    if (boots.health < HEARTBEAT_HP) {
      if (!heart.current && typeof sfx.heartbeat === 'function') {
        heart.current = sfx.heartbeat()
      }
      // Shared severity→bpm mapping (audio.ts) — the HUD's red pulse uses
      // the same curve, so sound and vignette never drift.
      heart.current?.setRate(heartbeatBpm(boots.health))
      heart.current?.setLevel(0.35 + 0.4 * lowHpSeverity(boots.health))
    } else if (heart.current) {
      heart.current.stop()
      heart.current = null
    }

    // Wave director: peaceful grace → (breaker switch) → one-shot alert
    // countdown → waves. State transitions live in enemies-state's
    // tickWaveDirector (armed is the ONLY wake input — never gun pickups);
    // this layer turns the step into sfx, labels and spawns.
    const step = tickWaveDirector(dt, bots.length)
    if (step.alertStarted) {
      // Distant machine spin-up under the ticking line (stop any stale
      // voice first — resetBots() mid-session re-arms the alert).
      spinup.current?.stop()
      spinup.current = sfx.machineSpinup?.() ?? null
      countdownTick.current = ALERT_SECONDS + 1
    } else if (waveState.countdownActive) {
      // Per-second tell: a relay clack each tick, the arming rack on the
      // last one — the lot's machinery waking up, somewhere out there.
      const tick = Math.max(1, Math.ceil(waveState.countdown))
      if (tick !== countdownTick.current) {
        countdownTick.current = tick
        if (tick === 1) sfx.reload()
        else sfx.doorLatch()
      }
      // Rising cue: pitch/filter/tremolo/level all ride progress 0→1 across
      // the whole countdown (the voice caps its own level — no scaling here).
      spinup.current?.setProgress(1 - waveState.countdown / ALERT_SECONDS)
    }
    // The breaker is a toggle: a shutdown (disarmWaves) drops `armed` from
    // OUTSIDE the director, with no step event — reclaim the spin-up voice
    // here or a mid-countdown shutdown leaves it rising forever.
    if (!waveState.armed && spinup.current) {
      spinup.current.stop()
      spinup.current = null
    }
    if (step.assaultStarted) {
      // siren winds down with the spin-up (countdownActive already false)
      spinup.current?.stop()
      spinup.current = null
      spawnLabel.current = 'HERE THEY COME' // first wave only
      spawnWave(world) // WAVE 1
      waveLabelT.current = 3
    } else if (step.waveDue) {
      spawnLabel.current = null
      spawnWave(world)
      waveLabelT.current = 3
    } else if (waveState.alerted && waveState.countdown <= 0 && bots.length > 0 && waveLabelT.current > 0) {
      waveLabelT.current -= dt
    }

    // Wave line — write only on change.
    let label: string | null = null
    if (waveState.alerted) {
      if (waveState.countdown > 0) {
        label = `⚠ AI robot zombies incoming — ${Math.ceil(waveState.countdown)}`
      } else if (bots.length === 0) {
        label = `next wave — ${Math.max(1, Math.ceil(waveState.intermission))}`
      } else if (waveLabelT.current > 0) {
        label = spawnLabel.current ?? `WAVE ${waveState.wave}`
      }
    }
    if (label !== waveText.current) {
      waveText.current = label
      session.hud.wave(label)
    }

    // Integrate bots.
    const frozen = debugFlags.botsFrozen // dev/E2E: hold poses, no attacks
    // Refill the horde-wide budget for terrain re-probes triggered by a bot
    // having WALKED off its cached landing plane (see BOT_PROBE_BUDGET). The
    // per-bot cadence probe is never budgeted.
    resetBotProbeBudget()
    let nearestDrone = Infinity
    for (let i = bots.length - 1; i >= 0; i--) {
      const bot = bots[i]!
      const stats = BOT_STATS[bot.kind]
      if (bot.state === 'dying') {
        bot.deadT += dt
        if (bot.deadT > 2.4) bots.splice(i, 1)
        continue
      }
      bot.attackCooldown -= dt
      // Legs freeze while a hand fumbles at a door handle — part of the tell.
      const fumbling = bot.doorId !== null && bot.doorFumbleT > 0
      if (!fumbling) bot.phase += dt * (bot.kind === 'dog' ? 11 : 6)

      _toPlayer.set(
        playerRig.position.x - bot.position.x,
        0,
        playerRig.position.z - bot.position.z,
      )
      const dist = _toPlayer.length()
      bot.yaw = Math.atan2(_toPlayer.x, _toPlayer.z)
      // Unit XZ direction to the player — tangent math + probes key off it.
      const dirX = dist > 0.001 ? _toPlayer.x / dist : 0
      const dirZ = dist > 0.001 ? _toPlayer.z / dist : 1

      // Drone reach is 3D (ground bots stay XZ): a drone parked high over
      // the roof you're under is NOT in range — it has to actually get to you.
      const reachDist =
        bot.kind === 'drone' ? Math.hypot(dist, playerRig.position.y - bot.position.y) : dist

      // Drone altitude: hover over the player's head, plus whatever climb
      // the path probe has banked to clear walls/roofs under the path.
      let droneBlocked = false
      if (bot.kind === 'drone') {
        if (!frozen) {
          // Mercy: drones climb an extra meter and hold while you're staggered.
          const hoverY =
            playerRig.position.y +
            0.9 +
            (staggered ? 1 : 0) +
            Math.sin(bot.phase * 0.7 + bot.seed) * 0.5
          if (!staggered && reachDist > stats.reach) {
            // Path-aware probe (enemies-state.dronePathBlocked): an exact
            // sweep along the intended displacement ~1.2 m ahead — vertical
            // intent included, so a dive toward the player reads the roof
            // it would cut through — plus a wall-top skim point just under
            // the far end. Climb while blocked, settle slowly when clear.
            let wantDy = hoverY + bot.climb - bot.position.y
            if (wantDy > DRONE_PROBE) wantDy = DRONE_PROBE
            else if (wantDy < -DRONE_PROBE) wantDy = -DRONE_PROBE
            droneBlocked = dronePathBlocked(
              world.colliders,
              bot.position.x,
              bot.position.y,
              bot.position.z,
              dirX * DRONE_PROBE,
              wantDy,
              dirZ * DRONE_PROBE,
            )
          }
          let descentHeld = false
          if (droneBlocked) {
            bot.climb = Math.min(DRONE_CLIMB_MAX, bot.climb + DRONE_CLIMB_RATE * dt)
          } else {
            // DESCENT CORRIDOR: before giving altitude back (settling banked
            // climb, or following the player down a storey), probe the band
            // under the rotors — blocked → hold, the piece below is cover.
            const wantY = hoverY + Math.max(0, bot.climb - DRONE_SETTLE_RATE * dt)
            const drop = bot.position.y - wantY
            descentHeld =
              drop > 0 &&
              droneDescentBlocked(
                world.colliders,
                bot.position.x,
                bot.position.y,
                bot.position.z,
                Math.min(drop, DRONE_DESCENT_PROBE),
              )
            if (!descentHeld) bot.climb = Math.max(0, bot.climb - DRONE_SETTLE_RATE * dt)
          }
          const targetY = hoverY + bot.climb
          // A held descent freezes the lerp too — never sink toward a
          // blocked corridor (the capsule pass below is the backstop).
          if (!descentHeld || targetY > bot.position.y) {
            bot.position.y += (targetY - bot.position.y) * Math.min(1, dt * 2.2)
          }
        }
        nearestDrone = Math.min(nearestDrone, bot.position.distanceTo(playerRig.position))
      }

      // Steering intent (m/s). Positions only move through this + the
      // capsule pass below — the WALL RULE owns final placement.
      let moveX = 0
      let moveZ = 0
      const grounded = bot.kind !== 'drone'
      if (frozen) {
        // Dev freeze (debugFlags.botsFrozen): no steering, no attacks — the
        // walk cycle keeps idling so frozen bots still read as alive.
      } else if (staggered) {
        // Mercy window: nobody attacks a downed player. Ground bots steer to
        // hold a 4–6 m standoff ring; drones freeze in place (climb above).
        if (grounded && dist > 0.001 && (dist < MERCY_MIN || dist > MERCY_MAX)) {
          const sign = dist < MERCY_MIN ? -1 : 1
          moveX = dirX * stats.speed * sign
          moveZ = dirZ * stats.speed * sign
        }
      } else if (grounded && bot.doorId !== null) {
        // DOOR FUMBLE mission (see header): walk to the approach point,
        // pause at the leaf, toggle through the interact system, path
        // through. Overrides wall-follow and pursuit until it resolves.
        bot.doorT += dt
        const dx = bot.doorX - bot.position.x
        const dz = bot.doorZ - bot.position.z
        const dDoor = Math.hypot(dx, dz)
        if (bot.doorFumbleT > 0) {
          // The pause: hand on the handle. No steering, no attacks.
          bot.doorFumbleT -= dt
          if (bot.doorFumbleT <= 0) {
            // Re-check the leaf still blocks (the player may have opened it
            // mid-fumble), then flip it through the doors module's public
            // path — guarded existence; it no-ops on voxelized doors itself.
            // The creak + collider drop come from the toggle, not from here.
            if (doorIsClosed(world, bot.doorId)) doorsDebug?.toggle?.(bot.doorId)
            bot.doorId = null
            bot.stuckT = 0
            bot.followT = 0 // path straight through the fresh opening
          }
        } else if (dDoor < DOOR_FUMBLE_RANGE) {
          bot.doorFumbleT = DOOR_FUMBLE_SECONDS
          sfx.doorLatch?.() // the tell: a hand rattling the latch
        } else if (bot.doorT > DOOR_MISSION_TTL) {
          bot.doorId = null // can't reach it — back to the wall rules
        } else {
          moveX = (dx / dDoor) * stats.speed
          moveZ = (dz / dDoor) * stats.speed
        }
      } else if (grounded && bot.followT > 0) {
        // WALL-FOLLOW: strafe the obstacle tangent (⊥ to-player) on the side
        // the wall already let us slide toward, then re-seek. Runs even
        // inside reach — a blocked melee flips this on to hunt the doorway.
        bot.followT -= dt
        moveX = -dirZ * stats.speed * bot.followSign
        moveZ = dirX * stats.speed * bot.followSign
      } else if (reachDist > stats.reach) {
        let sx = dirX
        let sz = dirZ
        // Dogs weave as they close in.
        if (bot.kind === 'dog') {
          const weave = Math.sin(bot.phase * 0.9 + bot.seed) * 0.5
          sx += -dirZ * weave
          sz += dirX * weave
          const n = Math.hypot(sx, sz) || 1
          sx /= n
          sz /= n
        }
        // Climbing drones barely advance — rise first, then crest the wall.
        const advance = droneBlocked ? 0.15 : 1
        moveX = sx * stats.speed * advance
        moveZ = sz * stats.speed * advance
      } else if (bot.attackCooldown <= 0) {
        if (meleeBlocked(world, bot)) {
          // In reach but a solid is between us (thin walls/door leaves beat
          // the reach radius): don't punch drywall — pause, then ground bots
          // wall-follow to a way in; drones just re-probe (walls are cover).
          bot.attackCooldown = MELEE_BLOCKED_RETRY
          if (grounded) {
            bot.followT = FOLLOW_TIME
            bot.followSign = bot.seed % 2 < 1 ? 1 : -1
          }
        } else {
          bot.attackCooldown = 1.1
          // bot→player XZ direction; damagePlayer normalizes and handles
          // knockback, directional flash, sfx and the stagger routing.
          damagePlayer(stats.damage, { x: dirX, z: dirZ })
        }
      }

      if (!grounded) {
        bot.position.x += moveX * dt
        bot.position.z += moveZ * dt
        if (!frozen) {
          // DRONE WALL RULE: the same truth as ground bots — one capsule
          // pass vs host colliders + live voxels, run AFTER the altitude
          // lerp and the horizontal step so neither axis can phase through
          // walls, roofs or placed pieces (the probes above are steering;
          // the capsule is truth). Position is the body center; collide*
          // wants feet, so offset by half the capsule height and back.
          _botVel.set(moveX, 0, moveZ)
          _droneFeet.set(
            bot.position.x,
            bot.position.y - DRONE_CAPSULE.height / 2,
            bot.position.z,
          )
          collideCapsule(_droneFeet, _botVel, world.colliders, DRONE_CAPSULE)
          collideVoxelTargets(_droneFeet, _botVel, DRONE_CAPSULE.radius, DRONE_CAPSULE.height)
          bot.position.set(
            _droneFeet.x,
            _droneFeet.y + DRONE_CAPSULE.height / 2,
            _droneFeet.z,
          )
        }
      } else if (!frozen) {
        const prevX = bot.position.x
        const prevZ = bot.position.z
        // GROUND SETTLE (bots on floors): pull toward the cached landing
        // plane (destruction.probeLandingY) instead of y = 0 — bots stand on
        // slabs/floors, and a carved hole underfoot drops them to the storey
        // below. Step-ups (slabs, stoops) still release at the gentle rate.
        settleGroundBot(world, bot, dt)
        bot.position.x += moveX * dt
        bot.position.z += moveZ * dt
        // BOT WALL RULE: one capsule pass vs host colliders + live voxels —
        // the same resolution path as the player, small bot-sized capsule.
        _botVel.set(moveX, 0, moveZ)
        collideCapsule(bot.position, _botVel, world.colliders, GROUND_BOT_CAPSULE)
        collideVoxelTargets(
          bot.position,
          _botVel,
          GROUND_BOT_CAPSULE.radius,
          GROUND_BOT_CAPSULE.height,
        )
        // Blocked-progress bookkeeping → wall-follow trigger.
        const intended = Math.hypot(moveX, moveZ) * dt
        let blockedNow = false
        if (intended > 1e-5) {
          const ax = bot.position.x - prevX
          const az = bot.position.z - prevZ
          blockedNow = 1 - Math.hypot(ax, az) / intended > BLOCKED_RATIO
          if (blockedNow) {
            bot.blockedT += dt
            if (bot.followT <= 0 && bot.blockedT >= BLOCKED_TIME) {
              bot.blockedT = 0
              bot.followT = FOLLOW_TIME
              // Side pick: whichever tangent the wall already slid us toward
              // (residual displacement); dead-stop ties fall back to the seed.
              const slide = ax * -dirZ + az * dirX
              bot.followSign =
                Math.abs(slide) > 1e-4 ? Math.sign(slide) : bot.seed % 2 < 1 ? 1 : -1
            }
          } else {
            bot.blockedT = 0
          }
        }
        // DOORWAY HUNT: the stuck clock runs while hindered (grinding a
        // solid, or mid wall-follow — a stint that itself means pursuit
        // failed). Past DOOR_STUCK_TIME the budgeted scan (≤1 per bot per
        // DOOR_SCAN_PERIOD, blocked bots only) looks for a closed door
        // within DOOR_SCAN_RANGE and arms the fumble mission.
        accrueDoorStuck(bot, blockedNow || bot.followT > 0, dt)
        if (doorScanDue(bot, dt)) {
          const doorId = pickDoorCandidate(
            world,
            bot.position.x,
            bot.position.z,
            DOOR_SCAN_RANGE,
            _doorCenter,
          )
          if (doorId !== null) setDoorApproach(bot, doorId, _doorCenter.x, _doorCenter.z)
        }
      }
    }

    // Wave-cleared banner (phase 9 juice lane): fire on the alive>0 → 0
    // edge only while a wave is actually running — death/reset stay silent.
    let alive = 0
    for (const b of bots) if (b.state === 'alive') alive++
    if (aliveWas.current > 0 && alive === 0 && waveState.alerted && waveState.wave > 0)
      session.hud.waveCleared?.()
    aliveWas.current = alive

    buzz.current?.setIntensity(nearestDrone === Infinity ? 0 : Math.max(0, 1 - nearestDrone / 22) * 0.09)

    // Order-sensitive id+state hash — same change-detection semantics as a
    // joined signature string, zero allocations.
    let sig = bots.length | 0
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i]!
      sig = (sig * 33 + bot.id) | 0
      sig = (sig * 33 + (bot.state === 'dying' ? 1 : 0)) | 0
    }
    if (sig !== signature.current) {
      signature.current = sig
      setTick((t) => t + 1)
    }
  })

  void tick
  return (
    <group userData={{ __boots: true }}>
      {bots.map((bot) => (
        <BotModel bot={bot} key={bot.id} />
      ))}
    </group>
  )
}

// --- SHARED VISUAL KIT --------------------------------------------------------
// Every unit is assembled from THREE shared geometries (a unit box, a unit
// sphere, a unit disc — scaled per mesh) and a small fixed material set, so a
// spawned bot allocates ZERO geometries/materials (the old per-bot JSX
// primitives allocated ~7 of each per droid). Stock materials only —
// WebGPU-safe, no new shader surface. Per-unit looks come from
// bot.visual (enemies-state.botVisualParams — seeded off the unit id).
const unitBox = new BoxGeometry(1, 1, 1)
const unitSphere = new SphereGeometry(1, 10, 8)
const unitDisc = new CylinderGeometry(1, 1, 1, 12)

function std(color: string, metalness: number, roughness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, metalness, roughness })
}
const CHASSIS = std('#dfe3e8', 0.35, 0.4)
const CHASSIS_DARK = std('#c7ccd4', 0.35, 0.4)
const LIMB = std('#9aa1ab', 0.4, 0.45)
const ARM = std('#b7bdc6', 0.4, 0.45)
const JOINT = std('#7c828c', 0.5, 0.35)
const DOG_BODY = std('#e8b23a', 0.3, 0.5)
const DOG_HEAD = std('#2f3238', 0, 0.5)
const DOG_DARK = std('#3a3d42', 0, 0.5)
const DRONE_BODY = std('#2c2f34', 0, 0.5)
const DRONE_FRAME = std('#4a4e55', 0, 0.5)
const ROTOR = std('#7d838c', 0, 0.4)
/** DAMAGE READ (<40% / <20% hp): main panels flip to these scorched sets —
 * the shared-material analog of an instanceColor darken. */
const SCORCH_MILD = std('#8a8078', 0.2, 0.7)
const SCORCH_HEAVY = std('#4c443c', 0.1, 0.85)
/** Per-wave accents (visor slits, shoulder stripes) — unlit so they read as
 * glowing without any emissive/shader surface. One material per palette entry. */
const ACCENTS = ACCENT_PALETTE.map((c) => new MeshBasicMaterial({ color: c }))
/** Drone sensor eye — bright unlit red, same glow trick. */
const EYE = new MeshBasicMaterial({ color: '#ff4038' })

/** Rotor disc XZ seats: cross-frame arm ends (4) / bar-frame ends (2). */
const ROTORS_4 = [
  [0.184, 0.184],
  [-0.184, 0.184],
  [-0.184, -0.184],
  [0.184, -0.184],
] as const
const ROTORS_2 = [
  [0.25, 0],
  [-0.25, 0],
] as const

/** Per-part animation/scorch data stamped into mesh userData at mount. */
type BotPart = {
  role?: 'legL' | 'legR' | 'armL' | 'armR' | 'gait' | 'tail' | 'rotor' | 'hull'
  /** Swing amplitude (droid legs/arms, rad). */
  amp?: number
  /** Gait phase offset (dog legs, rad). */
  off?: number
  /** Spin rate (rotors, signed rad/s — dt-scaled in the frame loop). */
  spin?: number
  /** Pristine material to restore when the scorch read clears (hull). */
  base?: Material
}

function BotModel({ bot }: { bot: Bot }) {
  const ref = useRef<Group>(null)
  /** Applied scorch stage (0 pristine, 1 <40% hp, 2 <20%) — swap-on-change. */
  const scorch = useRef(0)

  useFrame((_, rawDt) => {
    const group = ref.current
    if (!group) return
    group.position.copy(bot.position)
    group.rotation.set(0, bot.yaw, 0)
    if (bot.state === 'dying') {
      const t = Math.min(1, bot.deadT / 0.5)
      group.rotation.z = (Math.PI / 2) * t
      if (bot.deadT > 1.2) {
        group.position.y -= (bot.deadT - 1.2) * 0.6
      }
      return
    }
    // Walk cycles — roles + per-unit params stamped in the JSX below; the
    // userData records are created once at mount, so this loop allocates
    // nothing. Droid arms counter-swing their legs; dog legs each carry a
    // seeded gait phase; rotors are rotation-only dt-scaled spins (rad/s,
    // wrapped to ±2π so rotation.y never drifts into float-precision loss).
    const swing = Math.sin(bot.phase)
    const dt = Math.min(rawDt, 1 / 30)
    for (const child of group.children) {
      const part = child.userData as BotPart
      if (part.role === 'legL') child.rotation.x = swing * (part.amp ?? 0.7)
      else if (part.role === 'legR') child.rotation.x = -swing * (part.amp ?? 0.7)
      else if (part.role === 'armL') child.rotation.x = -swing * (part.amp ?? 0.5)
      else if (part.role === 'armR') child.rotation.x = swing * (part.amp ?? 0.5)
      else if (part.role === 'gait') child.rotation.x = Math.sin(bot.phase + (part.off ?? 0)) * 0.65
      else if (part.role === 'tail') child.rotation.y = Math.sin(bot.phase * 1.7) * 0.55
      else if (part.role === 'rotor') {
        const y = child.rotation.y + (part.spin ?? 54) * dt
        const tau = Math.PI * 2
        child.rotation.y = y > tau ? y - tau : y < -tau ? y + tau : y
      }
    }
    // DAMAGE READ: below 40% hp the main panels flip to the scorched set
    // (heavier again under 20%) — shared-material swap, only on stage change.
    const hp = bot.health / BOT_STATS[bot.kind].health
    const stage = hp < 0.2 ? 2 : hp < 0.4 ? 1 : 0
    if (stage !== scorch.current) {
      scorch.current = stage
      for (const child of group.children) {
        const part = child.userData as BotPart
        if (part.role !== 'hull' || !part.base) continue
        ;(child as Mesh).material = stage === 2 ? SCORCH_HEAVY : stage === 1 ? SCORCH_MILD : part.base
      }
    }
  })

  if (bot.kind === 'droid') {
    const v = bot.visual
    const accent = ACCENTS[v.accent % ACCENTS.length]!
    const armAmp = v.swingAmp * 0.75
    return (
      <group ref={ref} scale={v.scale}>
        {/* torso core + chest plate + pelvis */}
        <mesh
          geometry={unitBox}
          material={CHASSIS}
          position={[0, 1.08, 0]}
          scale={[0.4, 0.52, 0.24]}
          userData={{ role: 'hull', base: CHASSIS }}
        />
        <mesh
          geometry={unitBox}
          material={CHASSIS_DARK}
          position={[0, 1.2, 0.13]}
          scale={[0.46, 0.3, 0.08]}
          userData={{ role: 'hull', base: CHASSIS_DARK }}
        />
        <mesh geometry={unitBox} material={LIMB} position={[0, 0.8, 0]} scale={[0.3, 0.16, 0.2]} />
        {/* head + visor slit (per-wave accent) */}
        <mesh
          geometry={unitBox}
          material={CHASSIS_DARK}
          position={[0, 1.56, 0]}
          scale={[0.22, 0.22, 0.22]}
          userData={{ role: 'hull', base: CHASSIS_DARK }}
        />
        <mesh geometry={unitBox} material={accent} position={[0, 1.57, 0.115]} scale={[0.17, 0.05, 0.02]} />
        {/* shoulder pads + the left-pad stripe (per-wave accent) */}
        <mesh geometry={unitBox} material={CHASSIS} position={[-0.29, 1.38, 0]} scale={[0.16, 0.1, 0.2]} />
        <mesh geometry={unitBox} material={CHASSIS} position={[0.29, 1.38, 0]} scale={[0.16, 0.1, 0.2]} />
        <mesh geometry={unitBox} material={accent} position={[-0.29, 1.44, 0]} scale={[0.17, 0.024, 0.21]} />
        {/* thin arms (counter-swing, per-unit amplitude) + shoulder joints */}
        <mesh
          geometry={unitBox}
          material={ARM}
          position={[-0.32, 1.1, 0]}
          scale={[0.08, 0.48, 0.1]}
          userData={{ role: 'armL', amp: armAmp }}
        />
        <mesh
          geometry={unitBox}
          material={ARM}
          position={[0.32, 1.1, 0]}
          scale={[0.08, 0.48, 0.1]}
          userData={{ role: 'armR', amp: armAmp }}
        />
        <mesh geometry={unitSphere} material={JOINT} position={[-0.32, 1.36, 0]} scale={0.07} />
        <mesh geometry={unitSphere} material={JOINT} position={[0.32, 1.36, 0]} scale={0.07} />
        {/* thin legs (per-unit swing amplitude) + hip joints */}
        <mesh
          geometry={unitBox}
          material={LIMB}
          position={[-0.12, 0.42, 0]}
          scale={[0.11, 0.7, 0.14]}
          userData={{ role: 'legL', amp: v.swingAmp }}
        />
        <mesh
          geometry={unitBox}
          material={LIMB}
          position={[0.12, 0.42, 0]}
          scale={[0.11, 0.7, 0.14]}
          userData={{ role: 'legR', amp: v.swingAmp }}
        />
        <mesh geometry={unitSphere} material={JOINT} position={[-0.12, 0.76, 0]} scale={0.075} />
        <mesh geometry={unitSphere} material={JOINT} position={[0.12, 0.76, 0]} scale={0.075} />
      </group>
    )
  }

  if (bot.kind === 'dog') {
    const v = bot.visual
    const headZ = 0.3 * v.bodyLen + 0.09
    return (
      <group ref={ref}>
        <mesh
          geometry={unitBox}
          material={DOG_BODY}
          position={[0, 0.48, 0]}
          scale={[0.3, 0.24, 0.62 * v.bodyLen]}
          userData={{ role: 'hull', base: DOG_BODY }}
        />
        {/* head block + snout + ear nubs */}
        <mesh geometry={unitBox} material={DOG_HEAD} position={[0, 0.56, headZ]} scale={[0.17, 0.15, 0.17]} />
        <mesh
          geometry={unitBox}
          material={DOG_DARK}
          position={[0, 0.52, headZ + 0.12]}
          scale={[0.1, 0.08, 0.12]}
        />
        <mesh
          geometry={unitBox}
          material={DOG_DARK}
          position={[-0.05, 0.67, headZ - 0.03]}
          scale={[0.035, 0.07, 0.035]}
        />
        <mesh
          geometry={unitBox}
          material={DOG_DARK}
          position={[0.05, 0.67, headZ - 0.03]}
          scale={[0.035, 0.07, 0.035]}
        />
        {/* tail segment — wags off the run phase while chasing */}
        <mesh
          geometry={unitBox}
          material={DOG_DARK}
          position={[0, 0.58, -(0.3 * v.bodyLen + 0.1)]}
          scale={[0.045, 0.045, 0.24]}
          userData={{ role: 'tail' }}
        />
        {/* legs — per-unit gait phase offsets (FL, FR, BL, BR) */}
        {(
          [
            [-0.12, 0.26, 0],
            [0.12, 0.26, 1],
            [-0.12, -0.26, 2],
            [0.12, -0.26, 3],
          ] as const
        ).map(([x, z, i]) => (
          <mesh
            key={i}
            geometry={unitBox}
            material={DOG_DARK}
            position={[x, 0.24, z * v.bodyLen]}
            scale={[0.07, 0.46, 0.07]}
            userData={{ role: 'gait', off: v.gait[i] }}
          />
        ))}
      </group>
    )
  }

  const v = bot.visual
  const four = v.rotors === 4
  return (
    <group ref={ref}>
      {/* body — round vs boxy per unit */}
      {v.round ? (
        <mesh
          geometry={unitSphere}
          material={DRONE_BODY}
          scale={[0.13, 0.09, 0.13]}
          userData={{ role: 'hull', base: DRONE_BODY }}
        />
      ) : (
        <mesh
          geometry={unitBox}
          material={DRONE_BODY}
          scale={[0.2, 0.09, 0.2]}
          userData={{ role: 'hull', base: DRONE_BODY }}
        />
      )}
      {/* frame: cross arms under 4 rotors, a single bar under 2 */}
      {four ? (
        <>
          <mesh
            geometry={unitBox}
            material={DRONE_FRAME}
            position={[0, 0.02, 0]}
            rotation={[0, Math.PI / 4, 0]}
            scale={[0.52, 0.02, 0.05]}
          />
          <mesh
            geometry={unitBox}
            material={DRONE_FRAME}
            position={[0, 0.02, 0]}
            rotation={[0, -Math.PI / 4, 0]}
            scale={[0.52, 0.02, 0.05]}
          />
        </>
      ) : (
        <mesh geometry={unitBox} material={DRONE_FRAME} position={[0, 0.02, 0]} scale={[0.56, 0.02, 0.06]} />
      )}
      {/* rotor discs — thin elliptical cylinders so the y-spin actually reads;
          alternating spin direction, rotation only */}
      {(four ? ROTORS_4 : ROTORS_2).map(([x, z], i) => (
        <mesh
          key={i}
          geometry={unitDisc}
          material={ROTOR}
          position={[x, 0.07, z]}
          scale={[0.115, 0.014, 0.08]}
          userData={{ role: 'rotor', spin: i % 2 ? -54 : 54 }}
        />
      ))}
      {/* sensor eye — bright unlit red, reads as a glow */}
      <mesh geometry={unitSphere} material={EYE} position={[0, -0.03, four ? 0.08 : 0.07]} scale={0.04} />
    </group>
  )
}
