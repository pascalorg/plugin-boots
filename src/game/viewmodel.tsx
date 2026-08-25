'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useRef } from 'react'
import type { Group, Mesh } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { getSession } from './session'
import { fire } from './shooting'
import { playerRig } from './player'
import { WEAPONS } from './weapons'
import type { GameWorld } from './world'

/**
 * First-person viewmodel: low-poly primitive weapons parented to a group
 * that copies the camera every frame (the host camera isn't guaranteed to
 * be in the scene graph, so children can't ride it directly). Also owns the
 * trigger loop — rate gating, semi vs auto, recoil, muzzle flash.
 */

export function Viewmodel({ world }: { world: GameWorld }) {
  const camera = useThree((s) => s.camera)
  const rigRef = useRef<Group>(null!)
  const swingRef = useRef<Group>(null!)
  const flashRef = useRef<Mesh>(null!)
  const cooldown = useRef(0)
  const prevFiring = useRef(false)
  const swingT = useRef(1)
  const recoilT = useRef(1)
  const flashT = useRef(0)

  const weapon = useBoots((s) => s.weapon)

  useFrame((_, rawDt) => {
    const session = getSession()
    const rig = rigRef.current
    if (!session || !rig) return
    const dt = Math.min(rawDt, 1 / 30)

    rig.position.copy(camera.position)
    rig.quaternion.copy(camera.quaternion)

    // Discrete actions: weapon slots, wheel cycling, build controls.
    const state = useBoots.getState()
    for (const action of session.input.consumeActions()) {
      if (action === 'Digit1') switchWeapon('knife')
      else if (action === 'Digit2') switchWeapon('pistol')
      else if (action === 'Digit3') switchWeapon('rifle')
      else if (action === 'Digit4' || action === 'KeyB') switchWeapon('builder')
      else if (action === 'WheelUp' || action === 'WheelDown') {
        const list = [...state.owned, 'builder' as const]
        const at = list.indexOf(state.weapon)
        const next = list[(at + (action === 'WheelDown' ? 1 : list.length - 1)) % list.length]!
        switchWeapon(next)
      } else if (action === 'KeyQ' && state.weapon === 'builder') {
        const order = ['wall', 'floor', 'ramp'] as const
        state.setBuildPiece(order[(order.indexOf(state.buildPiece) + 1) % order.length]!)
      }
    }

    cooldown.current -= dt
    swingT.current = Math.min(1, swingT.current + dt * 5.2)
    recoilT.current = Math.min(1, recoilT.current + dt * 9)
    flashT.current -= dt
    if (flashRef.current) flashRef.current.visible = flashT.current > 0

    const firing = session.input.state.firing
    const current = useBoots.getState().weapon
    if (current !== 'builder') {
      const def = WEAPONS[current]
      const wantsShot = def.auto ? firing : firing && !prevFiring.current
      if (wantsShot && cooldown.current <= 0) {
        cooldown.current = 1 / def.rate
        if (def.melee) {
          swingT.current = 0
          sfx.knifeSwing()
        } else {
          recoilT.current = 0
          flashT.current = 0.045
          playerRig.recoil += def.kick
          if (def.id === 'pistol') sfx.pistolShot()
          else sfx.rifleShot()
        }
        const outcome = fire(world, def)
        if (outcome === 'bot') {
          session.hud.hitmarker()
          sfx.hitmarker()
        }
      }
    }
    prevFiring.current = firing

    // Weapon pose: idle sway + bob echo + swing/recoil springs.
    const swing = 1 - swingT.current
    const recoil = 1 - recoilT.current
    const bob = Math.sin(playerRig.speed > 0.5 ? performance.now() * 0.008 : 0) * 0.004
    if (swingRef.current) {
      swingRef.current.position.set(0, bob - swing * 0.1, recoil * 0.07)
      swingRef.current.rotation.set(-swing * 1.7 + recoil * 0.14, swing * 0.5, swing * 0.3)
    }
  })

  const showKnife = weapon === 'knife'
  const showPistol = weapon === 'pistol'
  const showRifle = weapon === 'rifle'
  const showBuilder = weapon === 'builder'

  return (
    <group ref={rigRef} userData={{ __boots: true }}>
      <group position={[0.26, -0.24, -0.5]} ref={swingRef}>
        {/* Knife */}
        <group rotation={[0, -0.35, 0]} visible={showKnife}>
          <mesh position={[0, -0.02, 0.06]}>
            <boxGeometry args={[0.032, 0.032, 0.12]} />
            <meshStandardMaterial color="#2d2a26" roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.012, -0.1]} rotation={[0.06, 0, 0]}>
            <boxGeometry args={[0.008, 0.05, 0.24]} />
            <meshStandardMaterial color="#c9ccd1" metalness={0.7} roughness={0.25} />
          </mesh>
        </group>
        {/* Pistol */}
        <group visible={showPistol}>
          <mesh position={[0, -0.05, 0.05]} rotation={[0.28, 0, 0]}>
            <boxGeometry args={[0.038, 0.11, 0.05]} />
            <meshStandardMaterial color="#3a3d42" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.02, -0.06]}>
            <boxGeometry args={[0.042, 0.055, 0.24]} />
            <meshStandardMaterial color="#23262b" metalness={0.4} roughness={0.4} />
          </mesh>
        </group>
        {/* Rifle */}
        <group visible={showRifle}>
          <mesh position={[0, 0, -0.12]}>
            <boxGeometry args={[0.05, 0.075, 0.52]} />
            <meshStandardMaterial color="#33363b" metalness={0.35} roughness={0.45} />
          </mesh>
          <mesh position={[0, -0.08, -0.02]} rotation={[0.35, 0, 0]}>
            <boxGeometry args={[0.04, 0.14, 0.05]} />
            <meshStandardMaterial color="#5a4632" roughness={0.7} />
          </mesh>
          <mesh position={[0, 0.005, -0.42]}>
            <cylinderGeometry args={[0.014, 0.014, 0.18]} />
            <meshStandardMaterial color="#1e2023" metalness={0.5} roughness={0.35} />
          </mesh>
          <mesh position={[0, -0.02, 0.14]}>
            <boxGeometry args={[0.045, 0.09, 0.16]} />
            <meshStandardMaterial color="#5a4632" roughness={0.7} />
          </mesh>
        </group>
        {/* Builder: the blueprint hammer */}
        <group rotation={[0, -0.3, 0.15]} visible={showBuilder}>
          <mesh position={[0, -0.03, 0]}>
            <cylinderGeometry args={[0.014, 0.016, 0.24]} />
            <meshStandardMaterial color="#7a5c3e" roughness={0.8} />
          </mesh>
          <mesh position={[0, 0.1, 0]}>
            <boxGeometry args={[0.06, 0.05, 0.11]} />
            <meshStandardMaterial color="#4d8fd1" metalness={0.3} roughness={0.4} />
          </mesh>
        </group>
        {/* Muzzle flash */}
        <mesh position={[0, 0.005, -0.6]} ref={flashRef} visible={false}>
          <planeGeometry args={[0.16, 0.16]} />
          <meshBasicMaterial color="#ffd27a" depthWrite={false} transparent opacity={0.9} />
        </mesh>
      </group>
    </group>
  )
}

function switchWeapon(target: 'knife' | 'pistol' | 'rifle' | 'builder'): void {
  const state = useBoots.getState()
  if (target !== 'builder' && !state.owned.includes(target)) return
  if (state.weapon === target) return
  state.setWeapon(target)
  sfx.weaponSwitch()
}
