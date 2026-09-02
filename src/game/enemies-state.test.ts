import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import {
  type Bot,
  GROUND_REACH_Y,
  postStaggerGrace,
  startWindup,
  stepWindup,
  STRIKE_GRACE_S,
  tellProgress,
  WINDUP_S,
  withinVerticalReach,
} from './enemies-state'

/**
 * THE TELL. A melee is announced before it lands, lands only at the end of its
 * wind-up, and never lands on a player a storey away or one who just got up.
 * All of it is pure state math the frame loop merely calls.
 */

function bot(kind: Bot['kind']): Bot {
  return {
    id: 1,
    kind,
    position: new Vector3(),
    yaw: 0,
    health: 10,
    state: 'alive',
    deadT: 0,
    attackCooldown: 0,
    windupT: 0,
    strikeT: 0,
    phase: 0,
    seed: 0,
    blockedT: 0,
    followT: 0,
    followSign: 1,
    climb: 0,
    groundY: 0,
    groundX: 0,
    groundZ: 0,
    groundT: 0,
    stuckT: 0,
    doorScanT: 0,
    doorId: null,
    doorX: 0,
    doorZ: 0,
    doorFumbleT: 0,
    doorT: 0,
  } as unknown as Bot
}

describe('the wind-up', () => {
  test('a swing is announced for its kind\'s wind-up and strikes exactly once, at the end', () => {
    for (const kind of ['droid', 'dog', 'drone'] as const) {
      const b = bot(kind)
      expect(stepWindup(b, 0.1)).toBe('idle')
      startWindup(b)
      expect(b.windupT).toBe(WINDUP_S[kind])
      const dt = 0.05
      let strikes = 0
      let winding = 0
      for (let t = 0; t < 2; t += dt) {
        const r = stepWindup(b, dt)
        if (r === 'strike') strikes++
        if (r === 'winding') winding++
      }
      expect(strikes).toBe(1)
      expect(winding).toBeGreaterThan(3)
      expect(b.windupT).toBe(0)
      expect(stepWindup(b, dt)).toBe('idle')
    }
  })

  test('the tell runs 0 → 1 over the wind-up and is 0 when nothing is coming', () => {
    const b = bot('droid')
    expect(tellProgress(b)).toBe(0)
    startWindup(b)
    expect(tellProgress(b)).toBeCloseTo(0, 9)
    stepWindup(b, WINDUP_S.droid / 2)
    expect(tellProgress(b)).toBeCloseTo(0.5, 9)
    stepWindup(b, WINDUP_S.droid / 2 - 0.01)
    expect(tellProgress(b)).toBeGreaterThan(0.9)
    expect(tellProgress(b)).toBeLessThanOrEqual(1)
  })

  test('a frozen horde does not advance a wind-up', () => {
    const b = bot('dog')
    startWindup(b)
    expect(stepWindup(b, 0)).toBe('winding')
    expect(b.windupT).toBe(WINDUP_S.dog)
  })
})

describe('reach is three-dimensional', () => {
  test('a ground bot cannot hit a player a storey above or below its feet', () => {
    expect(withinVerticalReach('droid', 0, 0)).toBe(true)
    expect(withinVerticalReach('droid', 0, GROUND_REACH_Y - 0.01)).toBe(true)
    expect(withinVerticalReach('droid', 0, 2.5)).toBe(false) // a balcony
    expect(withinVerticalReach('dog', 2.5, 0)).toBe(false) // the dog is the one upstairs
    expect(withinVerticalReach('dog', 0, -GROUND_REACH_Y - 0.01)).toBe(false)
  })

  test('drones fly to the player and always can', () => {
    expect(withinVerticalReach('drone', 0, 6)).toBe(true)
    expect(withinVerticalReach('drone', 9, -3)).toBe(true)
  })
})

describe('the post-stagger grace', () => {
  test('starts the frame the stagger ends, counts down, and is moot while staggered', () => {
    expect(postStaggerGrace(true, true, 0, 0.1)).toBe(0) // still down: mercy handles it
    const g0 = postStaggerGrace(true, false, 0, 0.1) // just got up
    expect(g0).toBe(STRIKE_GRACE_S)
    const g1 = postStaggerGrace(false, false, g0, 0.4)
    expect(g1).toBeCloseTo(STRIKE_GRACE_S - 0.4, 9)
    let g = g1
    for (let i = 0; i < 20; i++) g = postStaggerGrace(false, false, g, 0.1)
    expect(g).toBe(0)
    // Never negative, and a fresh stagger resets to nothing while down.
    expect(postStaggerGrace(false, true, 0.5, 0.1)).toBe(0)
  })
})
