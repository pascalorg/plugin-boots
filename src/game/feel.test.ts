import { describe, expect, test } from 'bun:test'
import {
  addShake,
  advanceBob,
  advanceRoll,
  bobX,
  bobY,
  clampFrameDt,
  createFeelState,
  decayHurt,
  FEEL,
  hurtKick,
  landDip,
  recoilEnvelope,
  resetFeelState,
  shakeOffsets,
  smoothEyeY,
  swayProfile,
  triggerLanding,
} from './feel'

const RUN = 6.5
const DT60 = 1 / 60
const DT30 = 1 / 30

/** movement.ts friction on a stop: control = max(speed, stopSpeed 1.4), drop = control·7·dt. */
const frictionStep = (speed: number, dt: number): number =>
  Math.max(0, speed - Math.max(speed, 1.4) * 7 * dt)

describe('clampFrameDt', () => {
  test('non-positive and NaN deltas become a no-op 0', () => {
    expect(clampFrameDt(-300)).toBe(0)
    expect(clampFrameDt(Number.NaN)).toBe(0)
    expect(clampFrameDt(0)).toBe(0)
    expect(clampFrameDt(-1e-9)).toBe(0)
  })
  test('caps a tab-switch delta at DT_MAX and passes normal frames through', () => {
    expect(clampFrameDt(0.1)).toBeCloseTo(1 / 30, 12)
    expect(clampFrameDt(DT60)).toBe(DT60)
  })
})

describe('head bob', () => {
  test('4 s at run speed = 11 heel strikes (26 m / 2.3 m stride) with ≤ 4.5 mm per frame', () => {
    const f = createFeelState()
    let prev = 0
    let maxDelta = 0
    for (let i = 0; i < 240; i++) {
      advanceBob(f, RUN, true, RUN, DT60)
      const y = bobY(f)
      maxDelta = Math.max(maxDelta, Math.abs(y - prev))
      prev = y
    }
    expect(f.footsteps).toBe(11)
    expect(maxDelta).toBeLessThanOrEqual(0.0045)
  })

  test('the heel strike is the bob LOW point (footstep fires as |sin| crosses 0)', () => {
    const f = createFeelState()
    f.bobAmp = 1
    for (let i = 0; i < 600; i++) {
      const before = bobY(f)
      const struck = advanceBob(f, RUN, true, RUN, DT60)
      if (struck) {
        // Just past the low point: the eye is within one frame of the floor.
        expect(bobY(f)).toBeLessThan(0.005)
        expect(before).toBeLessThan(0.006)
      }
    }
    expect(f.footsteps).toBeGreaterThan(20)
  })

  test('amplitude eases in when moving and out when stopped; the phase FREEZES on a stop', () => {
    const f = createFeelState()
    for (let i = 0; i < 60; i++) advanceBob(f, RUN, true, RUN, DT60)
    expect(f.bobAmp).toBeGreaterThan(0.99)
    const phase = f.bobPhase
    for (let i = 0; i < 60; i++) expect(advanceBob(f, 0, true, RUN, DT60)).toBe(false)
    expect(f.bobPhase).toBe(phase)
    expect(f.bobAmp).toBeLessThan(0.01)
    expect(bobY(f)).toBeLessThan(0.0003)
    expect(Math.abs(bobX(f))).toBeLessThan(0.0002)
  })

  test('airborne frames freeze the phase too (a jump at run speed does not buzz)', () => {
    const f = createFeelState()
    for (let i = 0; i < 60; i++) advanceBob(f, RUN, true, RUN, DT60)
    const phase = f.bobPhase
    let prev = bobY(f)
    for (let i = 0; i < 30; i++) {
      advanceBob(f, RUN, false, RUN, DT60)
      const y = bobY(f)
      // Monotone release, never an alternating jump: that IS the no-buzz property.
      expect(y).toBeLessThanOrEqual(prev + 1e-12)
      expect(prev - y).toBeLessThanOrEqual(0.005)
      prev = y
    }
    expect(f.bobPhase).toBe(phase)
  })

  /**
   * STOP-BUZZ REGRESSION. Sweep 64 stop phases: run at full speed, then release
   * under movement.ts friction. The eye must never jump more than running bob
   * itself moves (4.1 mm/frame @60 Hz, 8.3 mm @30 Hz) and must settle fast.
   */
  const stopSweep = (dt: number) => {
    let worst = 0
    let slowestSettle = 0
    for (let k = 0; k < 64; k++) {
      const f = createFeelState()
      f.bobAmp = 1
      f.bobPhase = (k / 64) * Math.PI
      let speed = RUN
      let prev = bobY(f)
      let settledAt = Number.POSITIVE_INFINITY
      const frames = Math.round(1.2 / dt)
      for (let i = 0; i < frames; i++) {
        speed = frictionStep(speed, dt)
        advanceBob(f, speed, true, RUN, dt)
        const y = bobY(f)
        worst = Math.max(worst, Math.abs(y - prev))
        prev = y
        if (f.bobAmp < 0.01 && settledAt === Number.POSITIVE_INFINITY) settledAt = (i + 1) * dt
      }
      slowestSettle = Math.max(slowestSettle, settledAt)
    }
    return { worst, slowestSettle }
  }

  test('stop sweep @60 Hz: ≤ 4.5 mm/frame, amplitude gone within 0.7 s', () => {
    const { worst, slowestSettle } = stopSweep(DT60)
    expect(worst).toBeLessThanOrEqual(0.0045)
    expect(slowestSettle).toBeLessThanOrEqual(0.7)
  })

  test('stop sweep @30 Hz: ≤ 8.5 mm/frame, amplitude gone within 0.7 s', () => {
    const { worst, slowestSettle } = stopSweep(DT30)
    expect(worst).toBeLessThanOrEqual(0.0085)
    expect(slowestSettle).toBeLessThanOrEqual(0.7)
  })

  /**
   * Proof the sweep catches the bug: the OLD player.tsx formula
   * (`bobPhase *= 1 - min(1, dt*10)` whenever not (grounded && speed > 0.5),
   * amplitude = min(1, speed/runSpeed) with no easing) aliases a large phase
   * through |sin| as soon as the player leaves the ground at speed — a jump
   * at a full run — and the eye jumps by more than 12 mm per frame.
   */
  const oldFormulaAirborneSweep = (dt: number) => {
    let worst = 0
    for (let k = 0; k < 64; k++) {
      // 4 s of running at 1.9 rad/m puts the phase near 49 rad — a real session value.
      let phase = 49 + (k / 64) * Math.PI
      const amp = 1 // speed stays 6.5 in the air
      let prev = Math.abs(Math.sin(phase)) * 0.028 * amp
      for (let i = 0; i < 12; i++) {
        phase *= 1 - Math.min(1, dt * 10)
        const y = Math.abs(Math.sin(phase)) * 0.028 * amp
        worst = Math.max(worst, Math.abs(y - prev))
        prev = y
      }
    }
    return worst
  }

  test('the OLD phase-decay formula buzzes > 12 mm/frame in the same airborne sweep', () => {
    expect(oldFormulaAirborneSweep(DT60)).toBeGreaterThan(0.012)
  })

  test('the new formula stays ≤ 5 mm/frame and monotone in that airborne sweep', () => {
    let worst = 0
    for (let k = 0; k < 64; k++) {
      const f = createFeelState()
      f.bobAmp = 1
      f.bobPhase = 49 + (k / 64) * Math.PI
      let prev = bobY(f)
      for (let i = 0; i < 12; i++) {
        advanceBob(f, RUN, false, RUN, DT60)
        const y = bobY(f)
        expect(y).toBeLessThanOrEqual(prev + 1e-12)
        worst = Math.max(worst, prev - y)
        prev = y
      }
    }
    expect(worst).toBeLessThanOrEqual(0.005)
  })

  test('the phase wraps on a 2π boundary past 1e6 rad without a visible jump', () => {
    const f = createFeelState()
    f.bobAmp = 1
    f.bobPhase = 1e6 - 0.01
    const before = bobY(f)
    advanceBob(f, RUN, true, RUN, DT60)
    expect(f.bobPhase).toBeLessThan(10)
    expect(Math.abs(bobY(f) - before)).toBeLessThan(0.005)
  })
})

describe('landing dip', () => {
  test('a jump landing (−5.4 m/s) dips 0.065 m, peaks there, returns to exactly 0 and stays', () => {
    const f = createFeelState()
    expect(triggerLanding(f, -5.4)).toBe(true)
    expect(f.landDepth).toBeCloseTo(0.0648, 4)
    let peak = 0
    let frames = 0
    while (f.landT < 1) {
      peak = Math.max(peak, landDip(f, DT60))
      frames++
    }
    expect(peak).toBeGreaterThan(0.06)
    expect(peak).toBeLessThanOrEqual(f.landDepth + 1e-12)
    expect(frames).toBeGreaterThanOrEqual(18)
    expect(frames).toBeLessThanOrEqual(21)
    expect(landDip(f, DT60)).toBe(0)
    expect(landDip(f, DT60)).toBe(0)
  })

  test('fires from a 0.3 m curb (−3.1 m/s) but not from a step (−2.9 m/s)', () => {
    const f = createFeelState()
    expect(triggerLanding(f, -3.1)).toBe(true)
    expect(f.landDepth).toBeCloseTo(0.0372, 4)
    const g = createFeelState()
    expect(triggerLanding(g, -2.9)).toBe(false)
    expect(landDip(g, DT60)).toBe(0)
  })

  test('the depth is clamped: a 3 m fall caps at 0.1 m, a soft landing floors at 0.03 m', () => {
    const f = createFeelState()
    triggerLanding(f, -9.8)
    expect(f.landDepth).toBe(FEEL.LAND_DIP_MAX)
    resetFeelState(f)
    triggerLanding(f, -3)
    expect(f.landDepth).toBeCloseTo(0.036, 6)
  })

  test('idle state costs nothing: landDip is exactly 0 and NaN fall speed never fires', () => {
    const f = createFeelState()
    expect(landDip(f, DT60)).toBe(0)
    expect(triggerLanding(f, Number.NaN)).toBe(false)
  })
})

describe('step-offset eye smoothing', () => {
  test('first call snaps to the feet', () => {
    const f = createFeelState()
    expect(smoothEyeY(f, 3.2, true, DT60)).toBe(3.2)
  })

  test('a 0.35 m riser is eased: within 5 mm in ≤ 13 frames, never a 350 mm pop', () => {
    const f = createFeelState()
    smoothEyeY(f, 0, true, DT60)
    let y = 0
    let frames = 0
    while (0.35 - y > 0.005) {
      const next = smoothEyeY(f, 0.35, true, DT60)
      expect(next - y).toBeLessThan(0.12)
      y = next
      frames++
    }
    expect(frames).toBeLessThanOrEqual(13)
    expect(frames).toBeGreaterThan(3)
  })

  test('a 0.5 m jump in feet height snaps (teleport / fall), as does any airborne frame', () => {
    const f = createFeelState()
    smoothEyeY(f, 0, true, DT60)
    expect(smoothEyeY(f, 0.5, true, DT60)).toBe(0.5)
    expect(smoothEyeY(f, 0.4, false, DT60)).toBe(0.4)
    expect(smoothEyeY(f, -2, false, DT60)).toBe(-2)
  })

  test('descending a step is eased the same way', () => {
    const f = createFeelState()
    smoothEyeY(f, 1, true, DT60)
    const y = smoothEyeY(f, 0.7, true, DT60)
    expect(y).toBeGreaterThan(0.7)
    expect(y).toBeLessThan(1)
  })

  // ── expectedRise: slope motion is velocity, not a step ──────────────────
  /** 43° plane: projectOnWalkableSlope gives vel.y = 6.5 · tan 43° ≈ 6.06 m/s. */
  const SLOPE_VY = 6.06

  test('a 43° slope sprint (120 frames rising 6.06 m/s) keeps the camera within 1 cm of the feet at 60 AND 30 Hz', () => {
    for (const dt of [DT60, DT30]) {
      const f = createFeelState()
      smoothEyeY(f, 0, true, dt)
      let feet = 0
      let worst = 0
      for (let i = 0; i < 120; i++) {
        feet += SLOPE_VY * dt
        const eye = smoothEyeY(f, feet, true, dt, SLOPE_VY * dt)
        worst = Math.max(worst, Math.abs(feet - eye))
      }
      expect(worst).toBeLessThan(0.01)
    }
  })

  test('REGRESSION: the same sprint WITHOUT the explained rise settles ~24 cm low at 60 Hz (the review finding)', () => {
    const f = createFeelState()
    smoothEyeY(f, 0, true, DT60)
    let feet = 0
    let eye = 0
    for (let i = 0; i < 120; i++) {
      feet += SLOPE_VY * DT60
      eye = smoothEyeY(f, feet, true, DT60)
    }
    // Δ·(1−k)/k with Δ = 0.101 m, k = 0.3 → 0.236 m, and still under the snap
    // threshold, so it never self-corrected.
    expect(feet - eye).toBeGreaterThan(0.2)
    expect(feet - eye).toBeLessThan(0.26)
  })

  test('running DOWN a 43° slope passes through the same way (negative rise)', () => {
    const f = createFeelState()
    smoothEyeY(f, 10, true, DT60)
    let feet = 10
    let worst = 0
    for (let i = 0; i < 90; i++) {
      feet -= SLOPE_VY * DT60
      const eye = smoothEyeY(f, feet, true, DT60, -SLOPE_VY * DT60)
      worst = Math.max(worst, Math.abs(feet - eye))
    }
    expect(worst).toBeLessThan(0.01)
  })

  test('a 0.27 m riser on flat ground (expectedRise 0: vel.y is 0 when grounded) still eases', () => {
    const f = createFeelState()
    smoothEyeY(f, 0, true, DT60)
    const eye = smoothEyeY(f, 0.27, true, DT60, 0)
    expect(eye).toBeGreaterThan(0.05)
    expect(eye).toBeLessThan(0.1) // 0.27 · 0.3 = 0.081 — an eased first frame, not a pop
  })

  test('a riser met mid-slope eases ONLY the unexplained part: rise 0.1 passes, the 0.19 riser eases', () => {
    const f = createFeelState()
    smoothEyeY(f, 0, true, DT60)
    const eye = smoothEyeY(f, 0.29, true, DT60, 0.1)
    expect(eye).toBeCloseTo(0.1 + 0.19 * 0.3, 9)
  })

  test('landing frame: the feet fell LESS than vel.y·dt (met the floor mid-frame) → exact feet, no overshoot below', () => {
    const f = createFeelState()
    smoothEyeY(f, 0.5, false, DT60) // last airborne frame snaps
    const eye = smoothEyeY(f, 0.46, true, DT60, -5.4 * DT60) // fell 4 cm, velocity said 9
    expect(eye).toBe(0.46)
  })

  test('running off a slope onto flat ground: vel.y still carries the rise but the feet stay → exact feet, no pop', () => {
    const f = createFeelState()
    smoothEyeY(f, 2, true, DT60)
    const eye = smoothEyeY(f, 2, true, DT60, SLOPE_VY * DT60)
    expect(eye).toBe(2)
    // …and if the ground snap pulled the feet a hair DOWN that frame, the
    // opposite-sign rise is ignored and the tiny drop is eased as usual.
    const eye2 = smoothEyeY(f, 1.99, true, DT60, SLOPE_VY * DT60)
    expect(eye2).toBeGreaterThan(1.99)
    expect(eye2).toBeLessThan(2)
  })

  test('the explained rise is capped at the motion actually taken — never pushes the eye past the feet', () => {
    const f = createFeelState()
    smoothEyeY(f, 0, true, DT60)
    // Feet rose 5 cm, the velocity claimed 10: the eye lands exactly on the feet.
    expect(smoothEyeY(f, 0.05, true, DT60, 0.1)).toBe(0.05)
    // Airborne frames and out-of-range jumps still snap regardless of the hint.
    expect(smoothEyeY(f, 3, false, DT60, 0.1)).toBe(3)
    expect(smoothEyeY(f, 3.6, true, DT60, 0.1)).toBe(3.6)
  })
})

describe('strafe roll (camera.rotation.z: positive = head tilts screen-LEFT)', () => {
  test('a right strafe (lateral +6.5) leans RIGHT → negative roll; releases to 0', () => {
    const f = createFeelState()
    let roll = 0
    for (let i = 0; i < 60; i++) roll = advanceRoll(f, RUN, RUN, DT60)
    expect(roll).toBeLessThan(-0.019)
    expect(roll).toBeGreaterThanOrEqual(-FEEL.STRAFE_ROLL)
    for (let i = 0; i < 60; i++) roll = advanceRoll(f, 0, RUN, DT60)
    expect(Math.abs(roll)).toBeLessThan(1e-3)
  })

  test('a left strafe leans left → positive roll; the lean is clamped at run speed', () => {
    const f = createFeelState()
    let roll = 0
    for (let i = 0; i < 60; i++) roll = advanceRoll(f, -20, RUN, DT60)
    expect(roll).toBeGreaterThan(0.019)
    expect(roll).toBeLessThanOrEqual(FEEL.STRAFE_ROLL)
  })
})

describe('camera shake (damped 13 Hz oscillator)', () => {
  const out = { pitch: 0, yaw: 0 }

  test('power 10 is capped: |offset| ≤ SHAKE_MAX·SHAKE_AMP on every frame', () => {
    const f = createFeelState()
    addShake(f, 10)
    expect(f.shakeAmp).toBe(FEEL.SHAKE_MAX)
    for (let i = 0; i < 120; i++) {
      shakeOffsets(f, DT60, out)
      expect(Math.abs(out.pitch)).toBeLessThanOrEqual(FEEL.SHAKE_MAX * FEEL.SHAKE_AMP)
      expect(Math.abs(out.yaw)).toBeLessThanOrEqual(FEEL.SHAKE_MAX * FEEL.SHAKE_AMP)
    }
  })

  test('power 1 settles (amp exactly 0, offsets exactly 0) in under 0.6 s', () => {
    const f = createFeelState()
    addShake(f, 1)
    let t = 0
    let settled = Number.POSITIVE_INFINITY
    for (let i = 0; i < 120; i++) {
      shakeOffsets(f, DT60, out)
      t += DT60
      if (f.shakeAmp === 0 && settled === Number.POSITIVE_INFINITY) settled = t
    }
    expect(settled).toBeLessThan(0.6)
    expect(out.pitch).toBe(0)
    expect(out.yaw).toBe(0)
  })

  test('the envelope of the swings decays monotonically', () => {
    const f = createFeelState()
    addShake(f, 1)
    const dt = 1 / 240
    const peaks: number[] = []
    let prev = 0
    let prevPrev = 0
    for (let i = 0; i < 240; i++) {
      shakeOffsets(f, dt, out)
      const a = Math.abs(out.pitch)
      if (prev > prevPrev && prev >= a && prev > 0) peaks.push(prev)
      prevPrev = prev
      prev = a
    }
    expect(peaks.length).toBeGreaterThan(4)
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]!).toBeLessThan(peaks[i - 1]!)
  })

  test('first swing: pitch DOWN (flinch), yaw toward `sign`', () => {
    const f = createFeelState()
    addShake(f, 1, 1)
    shakeOffsets(f, DT60, out)
    expect(out.pitch).toBeLessThan(0)
    expect(out.yaw).toBeGreaterThan(0)
    const g = createFeelState()
    addShake(g, 1, -1)
    shakeOffsets(g, DT60, out)
    expect(out.pitch).toBeLessThan(0)
    expect(out.yaw).toBeLessThan(0)
  })

  test('60 Hz and 120 Hz see the same motion at shared timestamps (closed form in t)', () => {
    const a = createFeelState()
    const b = createFeelState()
    addShake(a, 2)
    addShake(b, 2)
    const oa = { pitch: 0, yaw: 0 }
    const ob = { pitch: 0, yaw: 0 }
    for (let i = 0; i < 40; i++) {
      shakeOffsets(a, DT60, oa)
      shakeOffsets(b, 1 / 120, ob)
      shakeOffsets(b, 1 / 120, ob)
      expect(Math.abs(oa.pitch - ob.pitch)).toBeLessThan(1e-12)
      expect(Math.abs(oa.yaw - ob.yaw)).toBeLessThan(1e-12)
    }
  })

  test('impulses accumulate and restart the oscillator; non-positive power is ignored', () => {
    const f = createFeelState()
    addShake(f, 1)
    shakeOffsets(f, 0.1, out)
    addShake(f, 1.5)
    expect(f.shakeT).toBe(0)
    expect(f.shakeAmp).toBeGreaterThan(1.5)
    addShake(f, 0)
    addShake(f, -3)
    addShake(f, Number.NaN)
    expect(f.shakeT).toBe(0)
  })
})

describe('hurt kick', () => {
  test('10 dmg floors the shake to 1.0, 100 dmg caps it at 2.5', () => {
    expect(hurtKick(createFeelState(), 10, 0)).toBe(FEEL.HURT_SHAKE_MIN)
    expect(hurtKick(createFeelState(), 100, 0)).toBe(FEEL.HURT_SHAKE_MAX)
    expect(hurtKick(createFeelState(), 20, 0)).toBeCloseTo(1.6, 10)
  })

  test('a hit from the RIGHT (+π/2) knocks the head LEFT → positive roll; shake yaw goes right', () => {
    const f = createFeelState()
    hurtKick(f, 10, Math.PI / 2)
    expect(f.hurtRoll).toBeGreaterThan(0)
    expect(f.hurtRoll).toBeCloseTo(FEEL.HURT_ROLL, 10)
    expect(f.shakeSign).toBe(1)
    // Side hits still snap the head back a little (pitch floor 0.4).
    expect(f.hurtPitch).toBeCloseTo(FEEL.HURT_PITCH * 0.4, 10)
  })

  test('a hit from the LEFT (−π/2) knocks the head RIGHT → negative roll; shake yaw goes left', () => {
    const f = createFeelState()
    hurtKick(f, 10, -Math.PI / 2)
    expect(f.hurtRoll).toBeLessThan(0)
    expect(f.shakeSign).toBe(-1)
  })

  test('a hit from straight ahead: no roll, full pitch snap-back', () => {
    const f = createFeelState()
    hurtKick(f, 10, 0)
    expect(Math.abs(f.hurtRoll)).toBeLessThan(1e-12)
    expect(f.hurtPitch).toBeCloseTo(FEEL.HURT_PITCH, 10)
  })

  test('direction-less damage: zero roll, full pitch, shake sign +1', () => {
    const f = createFeelState()
    f.shakeSign = -1
    hurtKick(f, 10)
    expect(f.hurtRoll).toBe(0)
    expect(f.hurtPitch).toBe(FEEL.HURT_PITCH)
    expect(f.shakeSign).toBe(1)
  })

  test('decayHurt recovers under 1e-3 within 1 s and snaps the tail to exactly 0', () => {
    const f = createFeelState()
    hurtKick(f, 50, Math.PI / 2)
    hurtKick(f, 50, Math.PI / 2)
    for (let i = 0; i < 60; i++) decayHurt(f, DT60)
    expect(Math.abs(f.hurtRoll)).toBeLessThan(1e-3)
    expect(Math.abs(f.hurtPitch)).toBeLessThan(1e-3)
    for (let i = 0; i < 300; i++) decayHurt(f, DT60)
    expect(f.hurtRoll).toBe(0)
    expect(f.hurtPitch).toBe(0)
  })
})

describe('weapon recoil envelope (kick + return curve)', () => {
  test('full kick on the fire frame, exactly home at the end', () => {
    expect(recoilEnvelope(0)).toBe(1)
    expect(recoilEnvelope(-1)).toBe(1)
    expect(recoilEnvelope(1)).toBe(0)
    expect(recoilEnvelope(2)).toBe(0)
  })

  test('returns fast first, then eases; a small forward settle near the end', () => {
    let prev = recoilEnvelope(0)
    let min = 1
    for (let u = 0.02; u <= 1; u += 0.02) {
      const v = recoilEnvelope(u)
      if (u <= 0.8) expect(v).toBeLessThan(prev)
      min = Math.min(min, v)
      prev = v
    }
    // Half the kick is gone by u = 0.3 (fast return) …
    expect(recoilEnvelope(0.3)).toBeLessThan(0.5)
    // … and the settle sinks just below rest, never more than 2 % of the kick.
    expect(min).toBeLessThan(0)
    expect(min).toBeGreaterThan(-0.02)
  })
})

describe('speed-profiled weapon sway', () => {
  const out = { x: 0, y: 0, roll: 0 }

  test('exactly zero at rest', () => {
    swayProfile(0, out)
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
    expect(out.roll).toBe(0)
  })

  test('full run = the RUN profile (tighter, vertical); clamps above 1', () => {
    swayProfile(1, out)
    expect(out.x).toBe(FEEL.SWAY_RUN_X)
    expect(out.y).toBe(FEEL.SWAY_RUN_Y)
    expect(out.roll).toBe(FEEL.SWAY_RUN_ROLL)
    swayProfile(3, out)
    expect(out.y).toBe(FEEL.SWAY_RUN_Y)
  })

  test('walking pace (0.46) is lateral-dominant, full run is vertical-dominant', () => {
    swayProfile(3 / 6.5, out)
    expect(out.x).toBeGreaterThan(out.y)
    expect(out.roll).toBeGreaterThan(out.y)
    expect(out.y).toBeGreaterThan(0)
    swayProfile(1, out)
    expect(out.y).toBeGreaterThan(out.x)
  })

  test('every component grows monotonically with speed (a stop fades, never swells)', () => {
    const prev = { x: 0, y: 0, roll: 0 }
    for (let s = 0.02; s <= 1.0001; s += 0.02) {
      swayProfile(s, out)
      expect(out.x).toBeGreaterThan(prev.x)
      expect(out.y).toBeGreaterThan(prev.y)
      expect(out.roll).toBeGreaterThan(prev.roll)
      prev.x = out.x
      prev.y = out.y
      prev.roll = out.roll
    }
  })
})
