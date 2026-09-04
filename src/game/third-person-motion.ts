import { type Object3D, Quaternion, Vector3 } from 'three'
import type { AvatarArticulation, AvatarMotion, Grip } from './remote-players'
import { wrapAngle } from './presence'

/** Aimed Pascaline stance: lean the body into the stock while counter-rotating
 * the head and arms. The sight/barrel direction therefore stays on the real
 * aim ray instead of climbing with the torso. */
export const THIRD_PERSON_AIM_LEAN = 0.075
export const THIRD_PERSON_AIM_ROLL = 0.025
export const THIRD_PERSON_AIM_TURN_RATE = 18

const FX_FORWARD = new Vector3(0, 0, -1)
const _fxDirection = new Vector3()
const _fxOrigin = new Vector3()
const _fxParentWorld = new Quaternion()
const _fxWorld = new Quaternion()

/** Point a muzzle effect's local -Z axis along a world-space direction while
 * leaving its muzzle position parented to the gun. This removes the arm IK's
 * inward yaw from flashes/tracers without changing the hand grip. */
export function orientMuzzleFx(fx: Object3D, worldDirection: Vector3): void {
  if (worldDirection.lengthSq() < 1e-12) return
  _fxDirection.copy(worldDirection).normalize()
  _fxWorld.setFromUnitVectors(FX_FORWARD, _fxDirection)
  if (fx.parent) {
    fx.parent.updateWorldMatrix(true, false)
    fx.parent.getWorldQuaternion(_fxParentWorld)
    fx.quaternion.copy(_fxParentWorld.invert()).multiply(_fxWorld)
  } else {
    fx.quaternion.copy(_fxWorld)
  }
}

/** Aim from the gun's real muzzle position to the resolved hitscan endpoint.
 * The over-the-shoulder camera and the barrel therefore converge on the same
 * target instead of drawing parallel lines past one another. */
export function pointMuzzleFxAt(fx: Object3D, worldTarget: Vector3): void {
  fx.getWorldPosition(_fxOrigin)
  _fxDirection.subVectors(worldTarget, _fxOrigin)
  orientMuzzleFx(fx, _fxDirection)
}

/** Authoritative view direction used by remote peers, matching shooting.ts. */
export function avatarAimDirection(out: Vector3, yaw: number, pitch: number): Vector3 {
  const cp = Math.cos(pitch)
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
}

export function layerThirdPersonAim(
  out: AvatarArticulation,
  ads: number,
  grip: Grip,
): AvatarArticulation {
  if (grip !== 'long' && grip !== 'short') return out
  const t = ads < 0 ? 0 : ads > 1 ? 1 : ads
  const lean = THIRD_PERSON_AIM_LEAN * t
  out.torsoPitch += lean
  out.torsoRoll -= THIRD_PERSON_AIM_ROLL * t
  // Head and both hands retain their world-space aim while the torso leans.
  out.headPitch -= lean
  out.armAim -= lean
  out.armSwing -= lean
  return out
}

/** ADS brings the hips behind the crosshair instead of leaving Pascaline's
 * torso wound around a stationary lower body. Hip-fire keeps the shared
 * remote-avatar dead-zone behavior. */
export function steerThirdPersonBody(
  motion: AvatarMotion,
  viewYaw: number,
  ads: number,
  dt: number,
): number {
  const t = ads < 0 ? 0 : ads > 1 ? 1 : ads
  if (t === 0 || dt <= 0) return motion.bodyYaw
  const diff = wrapAngle(viewYaw - motion.bodyYaw)
  motion.bodyYaw = wrapAngle(
    motion.bodyYaw + diff * (1 - Math.exp(-THIRD_PERSON_AIM_TURN_RATE * t * dt)),
  )
  return motion.bodyYaw
}
