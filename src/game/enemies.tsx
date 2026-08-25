'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { type Group, Vector3 } from 'three'
import { useBoots } from '../store'
import { HEARTBEAT_HP, type HeartbeatHandle, heartbeatBpm, lowHpSeverity, sfx } from './audio'
import {
  ALERT_SECONDS,
  BOT_STATS,
  type Bot,
  bots,
  debugFlags,
  resetBots,
  spawnBot,
  waveState,
} from './enemies-state'
import { damagePlayer, playerRig } from './player'
import { getSession } from './session'
import type { GameWorld } from './world'

/**
 * Wave-based horde: humanoid droids, robot dogs, FPV drones — they beeline
 * for you and you mow them down. Bots steer, they don't collide: pursuit
 * (and the mercy ring below) moves positions directly, so during standoffs
 * they can pass through placed builder pieces and props. Accepted for now —
 * they never attack from inside a piece, they just reposition through it.
 *
 * Pacing (see enemies-state.ts for the state shape):
 * - Peaceful until the first gun pickup, then a 5s "They heard you"
 *   countdown on the wave line, then WAVE 1 and the normal director.
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

const _toPlayer = new Vector3()
const _center = new Vector3()

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

export function Enemies({ world }: { world: GameWorld }) {
  const [tick, setTick] = useState(0)
  const signature = useRef('')
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
        label = `They heard you — ${Math.ceil(waveState.countdown)}`
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
      bot.phase += dt * (bot.kind === 'dog' ? 11 : 6)

      _toPlayer.set(
        playerRig.position.x - bot.position.x,
        0,
        playerRig.position.z - bot.position.z,
      )
      const dist = _toPlayer.length()
      bot.yaw = Math.atan2(_toPlayer.x, _toPlayer.z)

      if (bot.kind === 'drone') {
        // Mercy: drones climb an extra meter and hold while you're staggered.
        if (!frozen) {
          const targetY =
            playerRig.position.y +
            0.9 +
            (staggered ? 1 : 0) +
            Math.sin(bot.phase * 0.7 + bot.seed) * 0.5
          bot.position.y += (targetY - bot.position.y) * Math.min(1, dt * 2.2)
        }
        nearestDrone = Math.min(nearestDrone, bot.position.distanceTo(playerRig.position))
      }

      if (frozen) {
        // Dev freeze (debugFlags.botsFrozen): no steering, no attacks — the
        // walk cycle keeps idling so frozen bots still read as alive.
      } else if (staggered) {
        // Mercy window: nobody attacks a downed player. Ground bots steer to
        // hold a 4–6 m standoff ring; drones freeze in place (climb above).
        if (bot.kind !== 'drone' && dist > 0.001 && (dist < MERCY_MIN || dist > MERCY_MAX)) {
          _toPlayer.normalize()
          const sign = dist < MERCY_MIN ? -1 : 1
          bot.position.x += _toPlayer.x * stats.speed * sign * dt
          bot.position.z += _toPlayer.z * stats.speed * sign * dt
        }
      } else if (dist > stats.reach) {
        _toPlayer.normalize()
        // Dogs weave as they close in.
        if (bot.kind === 'dog') {
          const weave = Math.sin(bot.phase * 0.9 + bot.seed) * 0.5
          const px = -_toPlayer.z
          const pz = _toPlayer.x
          _toPlayer.x += px * weave
          _toPlayer.z += pz * weave
          _toPlayer.normalize()
        }
        bot.position.x += _toPlayer.x * stats.speed * dt
        bot.position.z += _toPlayer.z * stats.speed * dt
      } else if (bot.attackCooldown <= 0) {
        bot.attackCooldown = 1.1
        // bot→player XZ direction; damagePlayer normalizes and handles
        // knockback, directional flash, sfx and the stagger routing.
        damagePlayer(stats.damage, { x: _toPlayer.x, z: _toPlayer.z })
      }
    }

    buzz.current?.setIntensity(nearestDrone === Infinity ? 0 : Math.max(0, 1 - nearestDrone / 22) * 0.09)

    const sig = bots.map((b) => `${b.id}:${b.state}`).join(',')
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
