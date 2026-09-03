/**
 * FIRST-PERSON FEEL — the pure core.
 * ---------------------------------------------------------------------------
 * Every camera/viewmodel "juice" curve in one place: head bob (phase-locked to
 * footsteps), landing dip, step-offset eye smoothing, strafe lean, a damped
 * oscillator shake (13 Hz, not white noise), the hurt kick, and the weapon
 * recoil + sway profile the viewmodel builds on. No three/R3F imports, zero
 * allocation in any step function: every function mutates the FeelState it is
 * handed and returns a number/boolean, so the loop can call them every frame.
 *
 * TRUTH vs COSMETICS: nothing in here ever touches `playerRig.position` (the
 * TRUE eye, read by the wire, builder, item-place, enemies and the aim ray).
 * The Player loop applies these offsets at the CAMERA WRITE ONLY.
 *
 * SIGN CONVENTION — read this before touching a sign:
 *   All roll values are three.js YXZ `camera.rotation.z`: POSITIVE tilts the
 *   head screen-LEFT. A right strafe leans right → NEGATIVE roll. A hit from
 *   the right (damagePlayer angle +π/2, the HUD's right edge) knocks the head
 *   LEFT, away from the blow → POSITIVE hurtRoll.
 *   Pitch is `camera.rotation.x`: POSITIVE looks UP. Recoil and the hurt kick
 *   are positive (head snaps back); the landing pitch and the shake's first
 *   swing are negative (flinch down).
 * If a headed run ever disagrees, flip the constant HERE, never at the write.
 */

export const FEEL = {
  /** Frame-dt cap (s). NaN / negative / zero deltas clamp to 0 (a no-op frame). */
  DT_MAX: 1 / 30,
  /** Metres per footstep = one |sin| bob hump; the heel strike is the bob low point. */
  BOB_STRIDE: 2.3,
  /** Camera bob amplitude at full run: vertical (m) and lateral (m). */
  BOB_Y: 0.028,
  BOB_X: 0.014,
  /** Bob amplitude envelope rates (1/s): ease-in when moving, ease-out on stop. */
  BOB_ATTACK: 8,
  BOB_RELEASE: 10,
  /** Fall speed (m/s, magnitude) that starts a camera landing dip … */
  LAND_DIP_FALL: 3,
  /** … and the one that also plays the landing thump (a 0.5 m drop, a jump). */
  LAND_SFX_FALL: 4,
  /** Dip depth per m/s of fall speed, clamped to [MIN, MAX] metres. */
  LAND_DIP_PER_MS: 0.012,
  LAND_DIP_MIN: 0.03,
  LAND_DIP_MAX: 0.1,
  /** Full dip cycle (s): half-sine down and back. */
  LAND_DIP_TIME: 0.32,
  /** Nose-down pitch (rad) per metre of current dip. */
  LAND_PITCH_PER_M: 0.9,
  /** Step-offset eye smoothing: exponential rate (1/s) and the largest lift
   * that is smoothed — bigger jumps (teleports, falls) snap. */
  STEP_SMOOTH_RATE: 18,
  STEP_SMOOTH_MAX: 0.35,
  /** Strafe lean (rad at full lateral run speed) and its ease rate (1/s). */
  STRAFE_ROLL: 0.02,
  ROLL_RATE: 8,
  /** Camera shake: damped oscillator frequency (Hz), decay (1/s), rad per
   * unit of power, and the power cap (stacked explosions). */
  SHAKE_HZ: 13,
  SHAKE_DECAY: 9,
  SHAKE_AMP: 0.012,
  SHAKE_MAX: 4,
  /** Being hit: shake power per damage point, floored so a 10-dmg PvP round
   * registers, capped so a grenade does not whiplash. */
  HURT_SHAKE_PER_DMG: 0.08,
  HURT_SHAKE_MIN: 1.0,
  HURT_SHAKE_MAX: 2.5,
  /** Hurt head-knock: roll away from the blow (rad), pitch snap-back (rad),
   * exponential recovery (1/s). */
  HURT_ROLL: 0.08,
  HURT_PITCH: 0.06,
  HURT_DECAY: 7,
  /** Thumb mode halves rotational juice — a phone in the hands has no horizon. */
  TOUCH_SHAKE_SCALE: 0.5,
  /** Weapon recoil: full kick + return cycle (s) and the small forward settle
   * (fraction of the kick) the weapon sinks past rest before coming home. */
  RECOIL_TIME: 0.24,
  RECOIL_SETTLE: 0.06,
  /** Weapon sway amplitudes (m, m, rad) at walking cadence (wide, lazy,
   * rolling figure-8) and at full run (tighter, more vertical). */
  SWAY_WALK_X: 0.014,
  SWAY_WALK_Y: 0.007,
  SWAY_WALK_ROLL: 0.014,
  SWAY_RUN_X: 0.011,
  SWAY_RUN_Y: 0.016,
  SWAY_RUN_ROLL: 0.01,
} as const

export type FeelState = {
  /** Bob phase (rad): |sin| humps, one per BOB_STRIDE metres. FROZEN while
   * not moving — only the amplitude eases out (that is the stop-buzz fix). */
  bobPhase: number
  /** Eased 0..1 bob amplitude (speed / runSpeed). */
  bobAmp: number
  /** Heel strikes so far (monotone) — QA reads it, audio voices its deltas. */
  footsteps: number
  /** Smoothed feet height the camera rides (step-offset lag). */
  eyeY: number
  eyeInit: boolean
  /** Landing dip progress 0..1 (1 = idle) and its depth (m). */
  landT: number
  landDepth: number
  /** Eased strafe roll (rad, camera.rotation.z-ready). */
  roll: number
  /** Shake oscillator: seconds since the last impulse, power, yaw sign. */
  shakeT: number
  shakeAmp: number
  shakeSign: number
  /** Hurt head-knock offsets (rad), decayed every frame. */
  hurtRoll: number
  hurtPitch: number
}

export function createFeelState(): FeelState {
  return {
    bobPhase: 0,
    bobAmp: 0,
    footsteps: 0,
    eyeY: 0,
    eyeInit: false,
    landT: 1,
    landDepth: 0,
    roll: 0,
    shakeT: 0,
    shakeAmp: 0,
    shakeSign: 1,
    hurtRoll: 0,
    hurtPitch: 0,
  }
}

/** Reset in place (session start) — the state object itself is module-level. */
export function resetFeelState(f: FeelState): void {
  f.bobPhase = 0
  f.bobAmp = 0
  f.footsteps = 0
  f.eyeY = 0
  f.eyeInit = false
  f.landT = 1
  f.landDepth = 0
  f.roll = 0
  f.shakeT = 0
  f.shakeAmp = 0
  f.shakeSign = 1
  f.hurtRoll = 0
  f.hurtPitch = 0
}

/**
 * Frame delta for every feel/gameplay integrator: capped at DT_MAX so a tab
 * switch never teleports, and anything that is not a positive number (NaN, a
 * negative delta from a rewound clock, 0) becomes 0 — a frame that changes
 * nothing, instead of one that runs physics backwards.
 */
export function clampFrameDt(raw: number): number {
  return raw > 0 ? (raw < FEEL.DT_MAX ? raw : FEEL.DT_MAX) : 0
}

/**
 * Advance the head bob. Returns true on the frame a heel strikes (the bob
 * low point, floor(phase/π) increments) — voice the footstep then. The phase
 * only advances while moving on the ground; otherwise it FREEZES and just the
 * amplitude eases out, so a stop never aliases the phase into a buzz.
 */
export function advanceBob(
  f: FeelState,
  speed: number,
  grounded: boolean,
  runSpeed: number,
  dt: number,
): boolean {
  const moving = grounded && speed > 0.5
  const target = moving ? Math.min(1, speed / runSpeed) : 0
  const k = Math.min(1, dt * (target > f.bobAmp ? FEEL.BOB_ATTACK : FEEL.BOB_RELEASE))
  f.bobAmp += (target - f.bobAmp) * k
  if (!moving) return false
  const before = Math.floor(f.bobPhase / Math.PI)
  f.bobPhase += (speed * dt * Math.PI) / FEEL.BOB_STRIDE
  const step = Math.floor(f.bobPhase / Math.PI) > before
  if (step) f.footsteps++
  // Wrap on a 2π boundary (after ~700 km of running) so |sin| stays continuous.
  if (f.bobPhase > 1e6) f.bobPhase -= Math.floor(f.bobPhase / (2 * Math.PI)) * 2 * Math.PI
  return step
}

/** Vertical bob offset (m, ≥ 0): the eye rises between heel strikes. */
export function bobY(f: FeelState): number {
  return Math.abs(Math.sin(f.bobPhase)) * FEEL.BOB_Y * f.bobAmp
}

/** Lateral bob offset (m) along the camera's right vector: left foot, right foot. */
export function bobX(f: FeelState): number {
  return Math.sin(f.bobPhase) * FEEL.BOB_X * f.bobAmp
}

/**
 * Touchdown: start a camera dip when the fall was fast enough. `fallSpeed` is
 * vel.y at the landing frame (negative = falling). Returns whether it fired.
 */
export function triggerLanding(f: FeelState, fallSpeed: number): boolean {
  if (!(fallSpeed <= -FEEL.LAND_DIP_FALL)) return false
  f.landT = 0
  f.landDepth = Math.min(
    FEEL.LAND_DIP_MAX,
    Math.max(FEEL.LAND_DIP_MIN, -fallSpeed * FEEL.LAND_DIP_PER_MS),
  )
  return true
}

/** Current landing dip (m, ≥ 0): a half-sine over LAND_DIP_TIME, exactly 0 when idle. */
export function landDip(f: FeelState, dt: number): number {
  if (f.landT >= 1) return 0
  f.landT = Math.min(1, f.landT + dt / FEEL.LAND_DIP_TIME)
  if (f.landT >= 1) return 0
  return Math.sin(Math.PI * f.landT) * f.landDepth
}

/**
 * The feet height the camera rides. Step-offset lifts (≤ STEP_SMOOTH_MAX)
 * are eased at STEP_SMOOTH_RATE so a riser no longer pops the eye 35 cm in one
 * frame; the first call, any airborne frame and anything bigger than a step
 * (teleport, fall, respawn) snap.
 *
 * `expectedRise` is the vertical travel this frame's velocity already
 * EXPLAINS (the pre-move vel.y × dt): on a walkable slope
 * movement.projectOnWalkableSlope tilts the velocity into the plane, so the
 * feet rise ~10 cm every frame at a run — that is motion, not a step, and it
 * passes straight through; only the RESIDUAL (a riser lift the collider added
 * with vel.y = 0) is eased. Without it the ease settled 24 cm below the true
 * eye on a 43° stairs sprint (Δ·(1−k)/k, and frame-rate dependent). The
 * velocity can explain at most the motion actually taken in its own direction:
 * a landing frame that fell less than vel.y·dt (it met the floor mid-frame)
 * and the frame that runs off a slope onto flat ground (vel.y still carries
 * the rise, the feet do not) both resolve to the exact feet height, never a
 * pop the wrong way.
 */
export function smoothEyeY(
  f: FeelState,
  feetY: number,
  grounded: boolean,
  dt: number,
  expectedRise = 0,
): number {
  if (!f.eyeInit) {
    f.eyeInit = true
    f.eyeY = feetY
    return feetY
  }
  const actual = feetY - f.eyeY
  if (!grounded || actual > FEEL.STEP_SMOOTH_MAX + 1e-3 || actual < -(FEEL.STEP_SMOOTH_MAX + 1e-3)) {
    f.eyeY = feetY
    return feetY
  }
  // Explained part: same sign as the actual motion, capped at the actual motion.
  let explained = 0
  if (expectedRise > 0 && actual > 0) explained = expectedRise < actual ? expectedRise : actual
  else if (expectedRise < 0 && actual < 0) explained = expectedRise > actual ? expectedRise : actual
  f.eyeY += explained
  const d = actual - explained
  f.eyeY += d * Math.min(1, dt * FEEL.STEP_SMOOTH_RATE)
  return f.eyeY
}

/**
 * Strafe lean: eases toward -STRAFE_ROLL × (lateral / runSpeed). `lateralVel`
 * is the velocity along the camera's RIGHT vector, so a right strafe gives a
 * NEGATIVE roll = the head tilts screen-right, into the motion.
 */
export function advanceRoll(f: FeelState, lateralVel: number, runSpeed: number, dt: number): number {
  const n = lateralVel / runSpeed
  const target = -(n < -1 ? -1 : n > 1 ? 1 : n) * FEEL.STRAFE_ROLL
  f.roll += (target - f.roll) * Math.min(1, dt * FEEL.ROLL_RATE)
  return f.roll
}

/**
 * Camera-shake impulse. Power accumulates (cap SHAKE_MAX) and restarts the
 * oscillator; `sign` picks the yaw direction of the first swing (+1 = right).
 */
export function addShake(f: FeelState, power: number, sign = 1): void {
  if (!(power > 0)) return
  f.shakeAmp = Math.min(FEEL.SHAKE_MAX, f.shakeAmp + power)
  f.shakeT = 0
  f.shakeSign = sign < 0 ? -1 : 1
}

/**
 * Shake offsets (rad) for this frame, written into `out` (no alloc). A damped
 * 13 Hz oscillator in CLOSED FORM of the time since the impulse, so 60 and
 * 120 Hz displays see the same motion — the old per-frame random jitter
 * doubled its density with the refresh rate. First swing: pitch DOWN (flinch).
 */
export function shakeOffsets(f: FeelState, dt: number, out: { pitch: number; yaw: number }): void {
  if (f.shakeAmp <= 0) {
    out.pitch = 0
    out.yaw = 0
    return
  }
  f.shakeT += dt
  const env = f.shakeAmp * Math.exp(-FEEL.SHAKE_DECAY * f.shakeT) * FEEL.SHAKE_AMP
  if (env < 1e-4) {
    f.shakeAmp = 0
    out.pitch = 0
    out.yaw = 0
    return
  }
  const w = 2 * Math.PI * FEEL.SHAKE_HZ * f.shakeT
  out.pitch = -env * Math.sin(w)
  out.yaw = f.shakeSign * 0.6 * env * Math.sin(w * 0.83)
}

/**
 * Being hit. Adds the head-knock (roll AWAY from the attacker, pitch snap
 * back), primes `shakeSign` toward the attacker's side, and RETURNS the shake
 * power (clamped) for the caller's addShake — the caller may scale it first
 * (mercy window). `angle` is damagePlayer's screen-relative bearing: 0 ahead,
 * +π/2 = attacker on the RIGHT → positive hurtRoll = head knocked LEFT.
 * Undefined angle (direction-less damage): no roll, full pitch.
 */
export function hurtKick(f: FeelState, amount: number, angle?: number): number {
  const raw = amount * FEEL.HURT_SHAKE_PER_DMG
  const shake =
    raw < FEEL.HURT_SHAKE_MIN ? FEEL.HURT_SHAKE_MIN : raw > FEEL.HURT_SHAKE_MAX ? FEEL.HURT_SHAKE_MAX : raw
  if (angle === undefined) {
    f.hurtPitch += FEEL.HURT_PITCH
    f.shakeSign = 1
    return shake
  }
  const side = Math.sin(angle)
  f.hurtRoll += side * FEEL.HURT_ROLL
  const ahead = Math.cos(angle)
  f.hurtPitch += FEEL.HURT_PITCH * (ahead < 0.4 ? 0.4 : ahead)
  f.shakeSign = side < 0 ? -1 : 1
  return shake
}

/** Recover the hurt head-knock exponentially (HURT_DECAY). */
export function decayHurt(f: FeelState, dt: number): void {
  const k = Math.min(1, dt * FEEL.HURT_DECAY)
  f.hurtRoll -= f.hurtRoll * k
  f.hurtPitch -= f.hurtPitch * k
  if (f.hurtRoll < 1e-6 && f.hurtRoll > -1e-6) f.hurtRoll = 0
  if (f.hurtPitch < 1e-6 && f.hurtPitch > -1e-6) f.hurtPitch = 0
}

/**
 * Weapon recoil envelope over normalized time u ∈ [0, 1] (u = elapsed /
 * RECOIL_TIME): 1 on the fire frame (instant kick), a fast (1-u)² return that
 * eases into rest, and a small forward SETTLE below zero near the end so the
 * weapon sinks past home and comes back — the "return curve". Exactly 0 at
 * u ≥ 1. Pure: the viewmodel multiplies it into its z push and muzzle climb.
 */
export function recoilEnvelope(u: number): number {
  if (u <= 0) return 1
  if (u >= 1) return 0
  const r = 1 - u
  return r * r - FEEL.RECOIL_SETTLE * Math.sin(Math.PI * u) * u
}

/**
 * Speed-profiled weapon sway amplitudes, written into `out` (no alloc).
 * `speedN` is the eased 0..1 bob amplitude (speed / runSpeed). The overall
 * envelope is linear in speed (so a stop fades the sway out, never swells
 * it) while the SHAPE blends with s²: at walking pace (≈ 0.46) the WALK
 * profile dominates — lateral-heavy, rolling figure-8; at full run the RUN
 * profile takes over — vertical-heavy and tighter. Every component is
 * monotone in speed and exactly 0 at rest. Round 2 (hands) feeds this into
 * the arm rig.
 */
export function swayProfile(speedN: number, out: { x: number; y: number; roll: number }): void {
  const s = speedN < 0 ? 0 : speedN > 1 ? 1 : speedN
  const run = s * s
  const walk = 1 - run
  out.x = s * (FEEL.SWAY_WALK_X * walk + FEEL.SWAY_RUN_X * run)
  out.y = s * (FEEL.SWAY_WALK_Y * walk + FEEL.SWAY_RUN_Y * run)
  out.roll = s * (FEEL.SWAY_WALK_ROLL * walk + FEEL.SWAY_RUN_ROLL * run)
}
