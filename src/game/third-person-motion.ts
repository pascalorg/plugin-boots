import type { AvatarArticulation, AvatarMotion, Grip } from './remote-players'
import { wrapAngle } from './presence'

/** Aimed Pascaline stance: lean the body into the stock while counter-rotating
 * the head and arms. The sight/barrel direction therefore stays on the real
 * aim ray instead of climbing with the torso. */
export const THIRD_PERSON_AIM_LEAN = 0.075
export const THIRD_PERSON_AIM_ROLL = 0.025
export const THIRD_PERSON_AIM_TURN_RATE = 18

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
