'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { type Group, Vector3 } from 'three'
import { useBoots } from '../store'
import { HEARTBEAT_HP, type HeartbeatHandle, heartbeatBpm, lowHpSeverity, sfx } from './audio'
import { collideCapsule } from './collision'
import { collideVoxelTargets, raycastVoxelTargets } from './destruction'
import { doorsDebug } from './doors'
import {
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
  GROUND_BOT_CAPSULE,
  pickDoorCandidate,
  resetBots,
  setDoorApproach,
  settleGroundBot,
  spawnBot,
  waveState,
} from './enemies-state'
import { damagePlayer, playerRig } from './player'
import { getSession } from './session'
import type { GameWorld } from './world'

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
 * - MELEE LOS: an attack only lands if raycastVoxelTargets + a collider-box
 *   midpoint probe show clear air to the player — no punching through a
 *   sheet of drywall; a blocked attack triggers wall-follow instead.
 * - GROUND SETTLE (bots on floors): droids/dogs settle toward the live
 *   landing plane under their feet (enemies-state.settleGroundBot →
 *   destruction.probeLandingY, cached ~0.2 s per bot, never per frame) —
 *   they stand on slabs/upper floors, and a carved hole underfoot drops
 *   them to the storey below. No stair pathing yet.
 * - DRONES: no capsule. A forward point probe (~1.2 m ahead, at rotor height
 *   and just below) vs every collider worldBox — voxelized walls keep their
 *   box, so drones climb over buildings rather than thread breaches — feeds
 *   `bot.climb`: they rise while blocked, settle slowly when clear, and
 *   barely advance horizontally mid-climb.
 *
 * Pacing (see enemies-state.ts for the state shape):
 * - Peaceful until the first gun pickup, then a 5s "⚠ AI robot zombies
 *   incoming — N" countdown on the wave line (waveState.countdownActive is
 *   true for exactly that window — the gun-table siren spins off it), then
 *   WAVE 1 and the normal director.
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
const _probe = new Vector3()
const _chest = new Vector3()
const _meleeDir = new Vector3()
const _doorCenter = new Vector3()

/** Spawn the next wave in a ring around the building. */
function spawnWave(world: GameWorld): void {
  waveState.wave++
  waveState.intermission = 5
  const count = 3 + waveState.wave * 2
  const center = world.buildingAabb.isEmpty()
    ? _center.set(0, 0, 0)
    : world.buildingAabb.getCenter(_center)
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 22 + Math.random() * 12
    spawnBot(
      KIND_CYCLE[i % KIND_CYCLE.length]!,
      center.x + Math.cos(angle) * radius,
      center.z + Math.sin(angle) * radius,
    )
  }
}

/** Drone forward probe: point-vs-collider worldBox. Disabled entries
 * (voxelized walls) stay INCLUDED on purpose — the box outlives the hidden
 * mesh, so drones climb over breached buildings instead of threading holes
 * meant for ground bots. */
function pointInColliderBox(world: GameWorld, x: number, y: number, z: number): boolean {
  _probe.set(x, y, z)
  for (const collider of world.colliders) {
    if (collider.worldBox.containsPoint(_probe)) return true
  }
  return false
}

/** True when a solid sits between the bot's chest and the player's head —
 * melee never lands through drywall. Voxel grids get a real ray (their thin
 * skins would slip between point samples); non-voxelized solids (closed
 * doors, props) a midpoint box probe. Attack-frames only, never per-frame. */
function meleeBlocked(world: GameWorld, bot: Bot): boolean {
  _chest.set(bot.position.x, bot.position.y + BOT_STATS[bot.kind].bodyY, bot.position.z)
  _meleeDir.copy(playerRig.position).sub(_chest)
  const len = _meleeDir.length()
  if (len < 1e-4) return false
  _meleeDir.divideScalar(len)
  if (raycastVoxelTargets(_chest, _meleeDir, len)) return true
  _probe.copy(_chest).addScaledVector(_meleeDir, len * 0.5)
  for (const collider of world.colliders) {
    if (collider.disabled) continue
    if (collider.worldBox.containsPoint(_probe)) return true
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

    // Wave director: peaceful grace → one-shot alert countdown → waves.
    if (!waveState.alerted) {
      if (boots.owned.includes('pistol') || boots.owned.includes('rifle') || boots.owned.includes('minigun')) {
        waveState.alerted = true
        waveState.countdown = ALERT_SECONDS
        waveState.countdownActive = true // gun-table siren spins off this
        // Distant machine spin-up under the ticking line (stop any stale
        // voice first — resetBots() mid-session re-arms the alert).
        spinup.current?.stop()
        spinup.current = sfx.machineSpinup?.() ?? null
        countdownTick.current = ALERT_SECONDS + 1
      }
    } else if (waveState.countdown > 0) {
      waveState.countdown -= dt
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
      if (waveState.countdown <= 0) {
        waveState.countdownActive = false // siren winds down with the spin-up
        spinup.current?.stop()
        spinup.current = null
        spawnLabel.current = 'HERE THEY COME' // first wave only
        spawnWave(world) // WAVE 1
        waveLabelT.current = 3
      }
    } else if (bots.length === 0) {
      waveState.intermission -= dt
      if (waveState.intermission <= 0) {
        spawnLabel.current = null
        spawnWave(world)
        waveLabelT.current = 3
      }
    } else if (waveLabelT.current > 0) {
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

      // Drone altitude: hover over the player's head, plus whatever climb
      // the forward probe has banked to clear walls/roofs under the path.
      let droneBlocked = false
      if (bot.kind === 'drone') {
        if (!frozen) {
          if (!staggered && dist > stats.reach) {
            // Probe ~1.2 m ahead at rotor height AND just below, so wall
            // tops read solid while skimming — climb while blocked, settle
            // slowly when clear.
            const ax = bot.position.x + dirX * DRONE_PROBE
            const az = bot.position.z + dirZ * DRONE_PROBE
            droneBlocked =
              pointInColliderBox(world, ax, bot.position.y, az) ||
              pointInColliderBox(world, ax, bot.position.y - 0.6, az)
          }
          bot.climb = droneBlocked
            ? Math.min(DRONE_CLIMB_MAX, bot.climb + DRONE_CLIMB_RATE * dt)
            : Math.max(0, bot.climb - DRONE_SETTLE_RATE * dt)
          // Mercy: drones climb an extra meter and hold while you're staggered.
          const targetY =
            playerRig.position.y +
            0.9 +
            bot.climb +
            (staggered ? 1 : 0) +
            Math.sin(bot.phase * 0.7 + bot.seed) * 0.5
          bot.position.y += (targetY - bot.position.y) * Math.min(1, dt * 2.2)
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
      } else if (dist > stats.reach) {
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
        if (grounded && meleeBlocked(world, bot)) {
          // In reach but a wall is between us (thin walls beat the reach
          // radius): don't punch drywall — pause, then wall-follow to a way in.
          bot.attackCooldown = MELEE_BLOCKED_RETRY
          bot.followT = FOLLOW_TIME
          bot.followSign = bot.seed % 2 < 1 ? 1 : -1
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

function BotModel({ bot }: { bot: Bot }) {
  const ref = useRef<Group>(null)

  useFrame(() => {
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
    // Walk cycles.
    const swing = Math.sin(bot.phase)
    for (const child of group.children) {
      const role = (child.userData as { role?: string }).role
      if (role === 'legL') child.rotation.x = swing * 0.7
      else if (role === 'legR') child.rotation.x = -swing * 0.7
      else if (role === 'rotor') child.rotation.y += 0.9
    }
  })

  if (bot.kind === 'droid') {
    return (
      <group ref={ref}>
        <mesh position={[0, 1.05, 0]}>
          <boxGeometry args={[0.46, 0.62, 0.26]} />
          <meshStandardMaterial color="#dfe3e8" metalness={0.35} roughness={0.4} />
        </mesh>
        <mesh position={[0, 1.56, 0]}>
          <boxGeometry args={[0.24, 0.24, 0.24]} />
          <meshStandardMaterial color="#c7ccd4" metalness={0.35} roughness={0.4} />
        </mesh>
        <mesh position={[0, 1.56, 0.125]}>
          <boxGeometry args={[0.18, 0.06, 0.01]} />
          <meshStandardMaterial color="#ff3b30" />
        </mesh>
        <mesh position={[-0.12, 0.72, 0]} userData={{ role: 'legL' }}>
          <boxGeometry args={[0.13, 0.72, 0.16]} />
          <meshStandardMaterial color="#9aa1ab" metalness={0.4} roughness={0.45} />
        </mesh>
        <mesh position={[0.12, 0.72, 0]} userData={{ role: 'legR' }}>
          <boxGeometry args={[0.13, 0.72, 0.16]} />
          <meshStandardMaterial color="#9aa1ab" metalness={0.4} roughness={0.45} />
        </mesh>
        <mesh position={[-0.3, 1.1, 0]} userData={{ role: 'legR' }}>
          <boxGeometry args={[0.1, 0.5, 0.12]} />
          <meshStandardMaterial color="#b7bdc6" metalness={0.4} roughness={0.45} />
        </mesh>
        <mesh position={[0.3, 1.1, 0]} userData={{ role: 'legL' }}>
          <boxGeometry args={[0.1, 0.5, 0.12]} />
          <meshStandardMaterial color="#b7bdc6" metalness={0.4} roughness={0.45} />
        </mesh>
      </group>
    )
  }

  if (bot.kind === 'dog') {
    return (
      <group ref={ref}>
        <mesh position={[0, 0.48, 0]}>
          <boxGeometry args={[0.3, 0.24, 0.62]} />
          <meshStandardMaterial color="#e8b23a" metalness={0.3} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.52, 0.36]}>
          <boxGeometry args={[0.16, 0.14, 0.16]} />
          <meshStandardMaterial color="#2f3238" roughness={0.5} />
        </mesh>
        {(
          [
            [-0.12, 0.26],
            [0.12, 0.26],
            [-0.12, -0.26],
            [0.12, -0.26],
          ] as const
        ).map(([x, z], i) => (
          <mesh key={i} position={[x, 0.24, z]} userData={{ role: i % 2 ? 'legL' : 'legR' }}>
            <boxGeometry args={[0.07, 0.46, 0.07]} />
            <meshStandardMaterial color="#3a3d42" roughness={0.5} />
          </mesh>
        ))}
      </group>
    )
  }

  return (
    <group ref={ref}>
      <mesh>
        <boxGeometry args={[0.2, 0.09, 0.2]} />
        <meshStandardMaterial color="#2c2f34" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.52, 0.02, 0.05]} />
        <meshStandardMaterial color="#4a4e55" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[0, -Math.PI / 4, 0]}>
        <boxGeometry args={[0.52, 0.02, 0.05]} />
        <meshStandardMaterial color="#4a4e55" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.07, 0]} userData={{ role: 'rotor' }}>
        <boxGeometry args={[0.42, 0.01, 0.03]} />
        <meshStandardMaterial color="#7d838c" roughness={0.4} />
      </mesh>
      <mesh position={[0, -0.04, 0.06]}>
        <sphereGeometry args={[0.035]} />
        <meshStandardMaterial color="#ff3b30" />
      </mesh>
    </group>
  )
}
