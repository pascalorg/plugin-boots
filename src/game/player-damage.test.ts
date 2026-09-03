import { beforeEach, describe, expect, test } from 'bun:test'
import { useBoots } from '../store'
import { FEEL, resetFeelState } from './feel'
import { damagePlayer, getUpPitch, playerDebug, playerRig } from './player'

/**
 * Headless coverage for the "you can't die" damage entry point. The frame-
 * loop half (stagger timer, sway, regen ticking) needs R3F and is covered by
 * live QA; this pins the store-visible contract the pacing agent builds on:
 * health floors at 1 + staggered flips on lethal hits, the mercy window eats
 * damage (and dampens knockback) while staggered, knockback is floored so
 * every hit reads as a shove, and the get-up pitch curve keeps its shape
 * (slump → small lift → exactly level).
 */
describe('damagePlayer', () => {
  beforeEach(() => {
    useBoots.setState({ phase: 'game', health: 100, staggered: false })
    playerDebug.drainShove()
    resetFeelState(playerDebug.feel())
    playerRig.yaw = 0
  })

  test('reduces health by the amount', () => {
    damagePlayer(12)
    expect(useBoots.getState().health).toBe(88)
    expect(useBoots.getState().staggered).toBe(false)
  })

  test('does nothing outside the game phase', () => {
    useBoots.setState({ phase: 'editor' })
    damagePlayer(50)
    expect(useBoots.getState().health).toBe(100)
  })

  test('lethal damage staggers instead of killing: health pins to 1', () => {
    useBoots.setState({ health: 10 })
    damagePlayer(50, { x: 1, z: 0 })
    expect(useBoots.getState().health).toBe(1)
    expect(useBoots.getState().staggered).toBe(true)
  })

  test('exactly-zero damage result also staggers (never 0 hp)', () => {
    useBoots.setState({ health: 5 })
    damagePlayer(5)
    expect(useBoots.getState().health).toBe(1)
    expect(useBoots.getState().staggered).toBe(true)
  })

  test('mercy window: no hp loss while already staggered', () => {
    useBoots.setState({ health: 1, staggered: true })
    damagePlayer(30, { x: 0, z: 1 })
    expect(useBoots.getState().health).toBe(1)
    expect(useBoots.getState().staggered).toBe(true)
  })

  test('a bot melee (12 dmg) queues a 2.5 m/s shove in the push direction', () => {
    damagePlayer(12, { x: 1, z: 0 })
    const shove = playerDebug.drainShove()
    expect(shove.x).toBeCloseTo(2.5, 5)
    expect(shove.z).toBeCloseTo(0, 5)
  })

  test('a dog nip (9 dmg) is floored to the 2.2 m/s minimum shove', () => {
    damagePlayer(9, { x: 1, z: 0 })
    const shove = playerDebug.drainShove()
    expect(shove.x).toBeCloseTo(2.2, 5) // raw 9 * 2.5/12 = 1.875 → floor
    expect(shove.z).toBeCloseTo(0, 5)
  })

  test('the floor does not touch hits already above it (drone, 14 dmg)', () => {
    damagePlayer(14, { x: 0, z: 1 })
    const shove = playerDebug.drainShove()
    expect(shove.z).toBeCloseTo((14 * 2.5) / 12, 5) // ≈2.9167, unchanged
  })

  test('shove power caps at 6 m/s for huge hits', () => {
    damagePlayer(90, { x: 0, z: 1 })
    const shove = playerDebug.drainShove()
    expect(Math.hypot(shove.x, shove.z)).toBeCloseTo(6, 5)
  })

  test('mercy window dampens knockback to 40% (no juggling while downed)', () => {
    useBoots.setState({ health: 1, staggered: true })
    damagePlayer(12, { x: 1, z: 0 })
    const shove = playerDebug.drainShove()
    expect(shove.x).toBeCloseTo(2.5 * 0.4, 5)
  })

  test('mercy dampening applies to the floored value (9 dmg downed → 2.2 * 0.4)', () => {
    useBoots.setState({ health: 1, staggered: true })
    damagePlayer(9, { x: 1, z: 0 })
    const shove = playerDebug.drainShove()
    expect(shove.x).toBeCloseTo(2.2 * 0.4, 5)
  })

  test('the hit that CAUSES the stagger still shoves at full power', () => {
    useBoots.setState({ health: 5 })
    damagePlayer(12, { x: 0, z: -1 })
    expect(useBoots.getState().staggered).toBe(true)
    const shove = playerDebug.drainShove()
    expect(shove.z).toBeCloseTo(-2.5, 5)
  })

  // --- FELT hit: the camera reacts (feel.ts hurt kick + shake) --------------

  /** damagePlayer's bearing formula: attacker sits at −fromDir, yaw 0 → +x is RIGHT. */
  const bearing = (fromDir: { x: number; z: number }): number => {
    const ax = -fromDir.x
    const az = -fromDir.z
    const sinY = Math.sin(playerRig.yaw)
    const cosY = Math.cos(playerRig.yaw)
    return Math.atan2(ax * cosY - az * sinY, -ax * sinY - az * cosY)
  }

  test('a 10-dmg PvP round from the side shakes ≥ 1.0 and knocks the head AWAY from the attacker', () => {
    // Push direction +x → the attacker stands at −x. With yaw 0, −x is the
    // player's LEFT (bearing −π/2), so the head is knocked RIGHT (negative roll).
    damagePlayer(10, { x: 1, z: 0 })
    const f = playerDebug.feel()
    expect(f.shakeAmp).toBeGreaterThanOrEqual(1.0)
    expect(f.shakeT).toBe(0)
    const angle = bearing({ x: 1, z: 0 })
    expect(Math.sin(angle)).toBeLessThan(0) // attacker on the left…
    expect(f.hurtRoll).toBeLessThan(0) // …head knocked right, away from it
    expect(Math.sign(f.hurtRoll)).toBe(Math.sign(Math.sin(angle)))
    expect(f.shakeSign).toBe(-1)
  })

  test('a push toward −x (attacker on the RIGHT) rolls the head LEFT: positive', () => {
    damagePlayer(10, { x: -1, z: 0 })
    const f = playerDebug.feel()
    expect(Math.sin(bearing({ x: -1, z: 0 }))).toBeGreaterThan(0)
    expect(f.hurtRoll).toBeGreaterThan(0)
    expect(f.hurtRoll).toBeCloseTo(FEEL.HURT_ROLL, 6)
    expect(f.shakeSign).toBe(1)
  })

  test('direction-less damage: shake ≥ 1.0, no roll, a pitch snap-back', () => {
    damagePlayer(10)
    const f = playerDebug.feel()
    expect(f.shakeAmp).toBeGreaterThanOrEqual(1.0)
    expect(f.hurtRoll).toBe(0)
    expect(f.hurtPitch).toBeGreaterThan(0)
  })

  test('a hit taken while staggered shakes at the mercy scale (40 %)', () => {
    useBoots.setState({ health: 1, staggered: true })
    damagePlayer(10, { x: 0, z: 1 })
    expect(playerDebug.feel().shakeAmp).toBeCloseTo(FEEL.HURT_SHAKE_MIN * 0.4, 6)
  })

  test('a hit in the editor phase leaves the feel state untouched', () => {
    useBoots.setState({ phase: 'editor' })
    damagePlayer(50, { x: 1, z: 0 })
    const f = playerDebug.feel()
    expect(f.shakeAmp).toBe(0)
    expect(f.hurtRoll).toBe(0)
    expect(f.hurtPitch).toBe(0)
  })

  test('playerRig.shake feeds the same oscillator (grenade / hammer callers)', () => {
    playerRig.shake(1.4)
    expect(playerDebug.feel().shakeAmp).toBeCloseTo(1.4, 6)
    playerRig.shake(10)
    expect(playerDebug.feel().shakeAmp).toBe(FEEL.SHAKE_MAX)
    playerRig.shake(-1)
    expect(playerDebug.feel().shakeAmp).toBe(FEEL.SHAKE_MAX)
  })
})

describe('getUpPitch (get-up recovery curve)', () => {
  test('starts at the full slump (head still hung)', () => {
    expect(getUpPitch(0)).toBeLessThan(0)
  })

  test('lifts slightly past level in the back half', () => {
    let peak = -Infinity
    for (let u = 0.5; u <= 0.95; u += 0.05) peak = Math.max(peak, getUpPitch(u))
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(0.03) // a beat, not a launch
  })

  test('settles to exactly level', () => {
    expect(getUpPitch(1)).toBeCloseTo(0, 10)
  })

  test('clamps out-of-range progress', () => {
    expect(getUpPitch(-0.5)).toBe(getUpPitch(0))
    expect(getUpPitch(1.5)).toBe(getUpPitch(1))
  })
})
