'use client'

import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { Group } from 'three'
import { useBoots } from '../store'
import { EYE_HEIGHT } from './collision'
import { clampFrameDt } from './feel'
import { leftGripFor } from './hand-grips'
import { playerRig } from './player'
import { SHOT_COUNTER_MOD, shotsFired } from './presence-interp'
import {
  advanceGait,
  applyArticulation,
  articulate,
  AvatarRig,
  blendArticulation,
  createArticulation,
  createMotion,
  createRigRefs,
  gripFor,
  layerMotion,
  localPaletteIndex,
  MODEL_ARMS,
  placeRoot,
  updateMotion,
} from './remote-players'
import {
  layerThirdPersonAim,
  pointMuzzleFxAt,
  steerThirdPersonBody,
} from './third-person-motion'
import { vehicleRig } from './vehicle-state'

export const LOCAL_AVATAR_NAME = 'boots-local-avatar'

const LOCAL_FLASH_LIFE_S = 0.05

/** The player's own Pascaline for the over-the-shoulder camera. It uses the
 * exact rig, skeleton, hands, weapon holds and motion layers that other players
 * see. Unlike the old local-only shortcut, it also derives strafe/backpedal,
 * body/view separation, landing squash and per-round recoil. First person and
 * the vehicle cab keep it hidden. */
export function LocalPlayerAvatar() {
  const weapon = useBoots((s) => s.weapon)
  const staggered = useBoots((s) => s.staggered)
  const rootRef = useRef<Group>(null)
  const refs = useRef({
    ...createRigRefs(),
    fx: { current: null as Group | null },
    flash: { current: null as Group | null },
  }).current
  const pose = useRef(createArticulation())
  const target = useRef(createArticulation())
  const layered = useRef(createArticulation())
  const motion = useRef(createMotion())
  const phase = useRef(0)
  const clock = useRef(0)
  const lastShots = useRef(-1)
  const flashT = useRef(0)
  const wasVisible = useRef(false)

  useFrame((_, rawDt) => {
    const root = rootRef.current
    if (!root) return
    const visible = vehicleRig.view === 'third' && !vehicleRig.driving
    root.visible = visible
    const shotCounter = playerRig.shots % SHOT_COUNTER_MOD
    if (!visible) {
      wasVisible.current = false
      lastShots.current = shotCounter
      flashT.current = 0
      if (refs.fx.current) refs.fx.current.visible = false
      return
    }

    const dt = clampFrameDt(rawDt)
    clock.current += dt
    const firstVisibleFrame = !wasVisible.current
    if (firstVisibleFrame) motion.current = createMotion()
    wasVisible.current = true
    const shots = firstVisibleFrame ? 0 : shotsFired(lastShots.current, shotCounter)
    lastShots.current = shotCounter
    const m = motion.current
    const speed = updateMotion(
      m,
      playerRig.position.x,
      playerRig.position.y,
      playerRig.position.z,
      playerRig.yaw,
      playerRig.grounded,
      staggered,
      shots,
      weapon,
      0,
      dt,
    )
    steerThirdPersonBody(m, playerRig.yaw, playerRig.ads, dt)
    phase.current = advanceGait(phase.current, playerRig.grounded ? speed : 0, dt)
    const grip = gripFor(weapon)
    articulate(
      target.current,
      phase.current,
      speed,
      playerRig.pitch,
      playerRig.grounded,
      staggered,
      grip,
      clock.current,
      MODEL_ARMS,
      0,
      m.moveRel,
      leftGripFor(weapon),
    )
    if (firstVisibleFrame) Object.assign(pose.current, target.current)
    else blendArticulation(pose.current, target.current, dt)
    layerMotion(layered.current, pose.current, m, playerRig.yaw)
    layerThirdPersonAim(layered.current, playerRig.ads, grip)
    placeRoot(
      root,
      playerRig.position.x,
      playerRig.position.y - EYE_HEIGHT,
      playerRig.position.z,
      m.bodyYaw,
      layered.current,
    )
    root.rotation.y = m.bodyYaw
    applyArticulation(refs, layered.current)

    const fx = refs.fx.current
    if (fx) {
      if (shots > 0 || flashT.current > 0) pointMuzzleFxAt(fx, playerRig.shotTarget)
      if (shots > 0) {
        fx.visible = true
        flashT.current = LOCAL_FLASH_LIFE_S
        if (refs.flash.current) refs.flash.current.rotation.z = Math.random() * Math.PI * 2
      } else if (flashT.current > 0) {
        flashT.current -= dt
        if (flashT.current <= 0) fx.visible = false
      }
    }
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
