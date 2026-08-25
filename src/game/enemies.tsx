'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { type Group, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { BOT_STATS, type Bot, bots, resetBots, spawnBot, waveState } from './enemies-state'
import { playerRig } from './player'
import { getSession } from './session'
import type { GameWorld } from './world'

/**
 * Wave-based horde: humanoid droids, robot dogs, FPV drones — they beeline
 * for you and you mow them down. Ground bots probe ahead with a cheap
 * whisker so they hug obstacles instead of phasing through the table.
 */

const KIND_CYCLE = ['droid', 'dog', 'droid', 'drone', 'dog', 'drone'] as const

const _toPlayer = new Vector3()

export function Enemies({ world }: { world: GameWorld }) {
  const [tick, setTick] = useState(0)
  const signature = useRef('')
  const buzz = useRef<ReturnType<typeof sfx.droneBuzz>>(null)
  const waveLabelT = useRef(0)

  useEffect(() => {
    resetBots()
    buzz.current = sfx.droneBuzz()
    return () => {
      buzz.current?.stop()
      resetBots()
    }
  }, [])

  useFrame((_, rawDt) => {
    const session = getSession()
    if (!session) return
    const dt = Math.min(rawDt, 1 / 30)

    // Wave director.
    const alive = bots.filter((b) => b.state === 'alive')
    if (alive.length === 0 && bots.length === 0) {
      waveState.intermission -= dt
      session.hud.wave(`WAVE ${waveState.wave + 1} incoming — ${Math.max(1, Math.ceil(waveState.intermission))}`)
      if (waveState.intermission <= 0) {
        waveState.wave++
        waveState.intermission = 5
        const count = 3 + waveState.wave * 2
        const center = world.buildingAabb.isEmpty()
          ? new Vector3()
          : world.buildingAabb.getCenter(new Vector3())
        for (let i = 0; i < count; i++) {
          const angle = Math.random() * Math.PI * 2
          const radius = 22 + Math.random() * 12
          spawnBot(
            KIND_CYCLE[i % KIND_CYCLE.length]!,
            center.x + Math.cos(angle) * radius,
            center.z + Math.sin(angle) * radius,
          )
        }
        waveLabelT.current = 3
        session.hud.wave(`WAVE ${waveState.wave}`)
      }
    } else if (waveLabelT.current > 0) {
      waveLabelT.current -= dt
      if (waveLabelT.current <= 0) session.hud.wave(null)
    }

    // Integrate bots.
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
        const targetY = playerRig.position.y + 0.9 + Math.sin(bot.phase * 0.7 + bot.seed) * 0.5
        bot.position.y += (targetY - bot.position.y) * Math.min(1, dt * 2.2)
        nearestDrone = Math.min(nearestDrone, bot.position.distanceTo(playerRig.position))
      }

      if (dist > stats.reach) {
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
        const s = useBoots.getState()
        s.setHealth(s.health - stats.damage)
        sfx.damage()
        session.hud.damageFlash()
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
