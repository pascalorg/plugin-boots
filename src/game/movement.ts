/**
 * Quake-family first-person kinematics — the part of the game that has to
 * FEEL right. Pure math over plain vectors so it unit-tests without three.
 *
 * The grammar (per tick):
 *   grounded → applyFriction → accelerate(ground) → jump?
 *   airborne → gravity → accelerate(air, capped wish speed = air strafing)
 * Collision/sliding happens elsewhere; this module only shapes velocity.
 */

export type Vec3 = { x: number; y: number; z: number }

export type MoveConfig = {
  gravity: number
  runSpeed: number
  walkSpeed: number
  /** Ground acceleration, in units of wishSpeed per second. */
  accel: number
  /** Air acceleration, in units of wishSpeed per second. */
  airAccel: number
  /** The classic trick: in air, the projected-speed comparison uses this tiny
   * cap instead of wishSpeed — lets you gain speed by strafing into turns. */
  airCap: number
  friction: number
  /** Friction below this speed decelerates as if moving at this speed —
   * gives the crisp stop instead of an asymptotic glide. */
  stopSpeed: number
  jumpSpeed: number
}

/** Tuned arcade-fast (Serious-Sam-era pacing): quick run, snappy stops,
 * real air-strafe. Circle-strafing is the core verb. */
export const MOVE: MoveConfig = {
  gravity: 16,
  runSpeed: 6.5,
  walkSpeed: 3.0,
  accel: 12,
  airAccel: 12,
  airCap: 1.0,
  friction: 7,
  stopSpeed: 1.4,
  jumpSpeed: 5.4,
}

export type MoveInput = {
  /** Normalized wish direction on the XZ plane (already camera-relative). */
  wishX: number
  wishZ: number
  walk: boolean
  jump: boolean
}

const horizontalSpeed = (v: Vec3) => Math.hypot(v.x, v.z)

export function applyFriction(vel: Vec3, dt: number, cfg: MoveConfig): void {
  const speed = horizontalSpeed(vel)
  if (speed < 1e-4) {
    vel.x = 0
    vel.z = 0
    return
  }
  const control = Math.max(speed, cfg.stopSpeed)
  const drop = control * cfg.friction * dt
  const scale = Math.max(0, (speed - drop) / speed)
  vel.x *= scale
  vel.z *= scale
}

export function accelerate(
  vel: Vec3,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  capSpeed: number,
  dt: number,
): void {
  const current = vel.x * wishX + vel.z * wishZ
  const addSpeed = capSpeed - current
  if (addSpeed <= 0) return
  const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed)
  vel.x += wishX * accelSpeed
  vel.z += wishZ * accelSpeed
}

/**
 * One velocity tick. Mutates `vel`. Returns true if a jump was consumed
 * (caller plays the sound / clears the buffered jump).
 */
export function stepVelocity(
  vel: Vec3,
  input: MoveInput,
  grounded: boolean,
  dt: number,
  cfg: MoveConfig = MOVE,
): boolean {
  const wishLen = Math.hypot(input.wishX, input.wishZ)
  const wishX = wishLen > 1e-6 ? input.wishX / wishLen : 0
  const wishZ = wishLen > 1e-6 ? input.wishZ / wishLen : 0
  const wishSpeed = (input.walk ? cfg.walkSpeed : cfg.runSpeed) * (wishLen > 1e-6 ? 1 : 0)

  let jumped = false
  if (grounded) {
    applyFriction(vel, dt, cfg)
    accelerate(vel, wishX, wishZ, wishSpeed, cfg.accel, wishSpeed, dt)
    if (input.jump) {
      vel.y = cfg.jumpSpeed
      jumped = true
    } else {
      vel.y = Math.max(vel.y, 0)
    }
  } else {
    vel.y -= cfg.gravity * dt
    accelerate(vel, wishX, wishZ, wishSpeed, cfg.airAccel, Math.min(wishSpeed, cfg.airCap), dt)
  }
  return jumped
}
