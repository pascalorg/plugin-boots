import { beforeEach, describe, expect, test } from 'bun:test'
import { useBoots } from '../store'
import { damagePlayer } from './player'

/**
 * Headless coverage for the "you can't die" damage entry point. The frame-
 * loop half (stagger timer, sway, regen ticking) needs R3F and is covered by
 * report-side review; this pins the store-visible contract the pacing agent
 * builds on: health floors at 1 + staggered flips on lethal hits, and the
 * mercy window eats damage while staggered.
 */
describe('damagePlayer', () => {
  beforeEach(() => {
    useBoots.setState({ phase: 'game', health: 100, staggered: false })
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
})
