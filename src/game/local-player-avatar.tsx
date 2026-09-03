'use client'

import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { Group } from 'three'
import { useBoots } from '../store'
import { EYE_HEIGHT } from './collision'
import { clampFrameDt } from './feel'
import { leftGripFor } from './hand-grips'
import { MOVE } from './movement'
import { playerRig } from './player'
import {
  advanceGait,
  applyArticulation,
  articulate,
  AvatarRig,
  blendArticulation,
  createArticulation,
  createRigRefs,
  gripFor,
  localPaletteIndex,
  MODEL_ARMS,
  placeRoot,
} from './remote-players'
import { vehicleRig } from './vehicle-state'

export const LOCAL_AVATAR_NAME = 'boots-local-avatar'

/** The player's own Pascaline for the over-the-shoulder camera. It uses the
 * exact rig, skeleton, hands, weapon holds and gait that other players see;
 * first person and the vehicle cab keep it hidden. */
export function LocalPlayerAvatar() {
  const weapon = useBoots((s) => s.weapon)
  const staggered = useBoots((s) => s.staggered)
  const rootRef = useRef<Group>(null)
  const refs = useRef(createRigRefs()).current
  const pose = useRef(createArticulation())
  const target = useRef(createArticulation())
  const phase = useRef(0)
  const clock = useRef(0)

  useFrame((_, rawDt) => {
    const root = rootRef.current
    if (!root) return
    const visible = vehicleRig.view === 'third' && !vehicleRig.driving
    root.visible = visible
    if (!visible) return

    const dt = clampFrameDt(rawDt)
    clock.current += dt
    const speed = Math.min(1, playerRig.speed / MOVE.runSpeed)
    phase.current = advanceGait(phase.current, playerRig.grounded ? speed : 0, dt)
    articulate(
      target.current,
      phase.current,
      speed,
      playerRig.pitch,
      playerRig.grounded,
      staggered,
      gripFor(weapon),
      clock.current,
      MODEL_ARMS,
      0,
      0,
      leftGripFor(weapon),
    )
    blendArticulation(pose.current, target.current, dt)
    placeRoot(
      root,
      playerRig.position.x,
      playerRig.position.y - EYE_HEIGHT,
      playerRig.position.z,
      playerRig.yaw,
      pose.current,
    )
    root.rotation.y = playerRig.yaw
    applyArticulation(refs, pose.current)
  })

  return (
    <group
      ref={rootRef}
      name={LOCAL_AVATAR_NAME}
      visible={false}
      userData={{ __boots: true, __bootsLocalAvatar: true }}
    >
      <AvatarRig paletteIndex={localPaletteIndex()} refs={refs} weapon={weapon} />
    </group>
  )
}
