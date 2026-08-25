import { beforeEach, describe, expect, test } from 'bun:test'
import { useBoots } from '../store'
import { damagePlayer, getUpPitch, playerDebug } from './player'

/**
 * Headless coverage for the "you can't die" damage entry point. The frame-
 * loop half (stagger timer, sway, regen ticking) needs R3F and is covered by
 * live QA; this pins the store-visible contract the pacing agent builds on:
 * health floors at 1 + staggered flips on lethal hits, the mercy window eats
 * damage (and dampens knockback) while staggered, and the get-up pitch curve
 * keeps its shape (slump → small lift → exactly level).
 */
describe('damagePlayer', () => {
  beforeEach(() => {
    useBoots.setState({ phase: 'game', health: 100, staggered: false })
    playerDebug.drainShove()
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

  test('the hit that CAUSES the stagger still shoves at full power', () => {
    useBoots.setState({ health: 5 })
    damagePlayer(12, { x: 0, z: -1 })
    expect(useBoots.getState().staggered).toBe(true)
    const shove = playerDebug.drainShove()
    expect(shove.z).toBeCloseTo(-2.5, 5)
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
