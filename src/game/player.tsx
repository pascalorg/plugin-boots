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

const SENSITIVITY = 0.0021
const GAME_FOV = 92
const FOOTSTEP_STRIDE = 2.3
const MAX_PITCH = Math.PI / 2 - 0.02

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
    camera.fov = GAME_FOV
    camera.updateProjectionMatrix()
    // Restore handled by session.exitGame (it owns savedCamera).
  }, [camera, world])

  useFrame((_, rawDt) => {
    const session = getSession()
    if (!session) return
    const dt = Math.min(rawDt, 1 / 30)
    const input = session.input

    // Look.
    const { dx, dy } = input.consumeLook()
    playerRig.yaw -= dx * SENSITIVITY
    playerRig.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, playerRig.pitch - dy * SENSITIVITY),
    )
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
        walk: keys.has('ShiftLeft') || keys.has('ShiftRight'),
        jump: keys.has('Space'),
      },
      playerRig.grounded,
      dt,
      MOVE,
    )
    if (jumped) sfx.jump()

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

    camera.position.copy(playerRig.position)
    camera.rotation.order = 'YXZ'
    camera.rotation.set(playerRig.pitch + playerRig.recoil, playerRig.yaw, 0)

    // Fall off the world guard.
    if (feet.current.y < -30) {
      feet.current.copy(world.spawn)
      vel.current.set(0, 0, 0)
    }

    // Health floor → arcade respawn.
    if (useBoots.getState().health <= 0) {
      feet.current.copy(world.spawn)
      vel.current.set(0, 0, 0)
      useBoots.getState().setHealth(100)
    }
  })

  return null
}
