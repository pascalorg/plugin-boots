import { afterEach, describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { clearDust, coneDirection, dustCounts, spawnDust, spawnHaze } from './dust'

/**
 * Pure-logic pins for the dust module: cone sampling math, per-kind spawn
 * counts, plume auto-haze, material-kind routing (drywall/concrete/wood),
 * pool-pressure halving, and both legacy call shapes. Rendering (DustSystem)
 * is DOM-bound and covered by review.
 */

afterEach(clearDust)

const P = new Vector3(1, 2, 3)
const SPREAD = (35 * Math.PI) / 180

describe('coneDirection', () => {
  test('u1=0 returns the axis itself', () => {
    const axis = new Vector3(0, 0, 1)
    const out = coneDirection(new Vector3(), axis, SPREAD, 0, 0.37)
    expect(out.distanceTo(axis)).toBeLessThan(1e-6)
  })

  test('samples are unit length and stay inside the cone', () => {
    const axes = [
      new Vector3(0, 0, 1),
      new Vector3(0, 1, 0),
      new Vector3(1, 0, 0),
      new Vector3(-0.3, 0.8, 0.52).normalize(),
    ]
    const minDot = Math.cos(SPREAD) - 1e-6
    const out = new Vector3()
    for (const axis of axes) {
      for (let i = 0; i < 200; i++) {
        coneDirection(out, axis, SPREAD, Math.random(), Math.random())
        expect(Math.abs(out.length() - 1)).toBeLessThan(1e-6)
        expect(out.dot(axis)).toBeGreaterThanOrEqual(minDot)
      }
    }
  })

  test('edge of the cone (u1=1) lands at exactly the spread angle', () => {
    const axis = new Vector3(0, 1, 0)
    const out = coneDirection(new Vector3(), axis, SPREAD, 1, 0.8)
    expect(Math.abs(out.dot(axis) - Math.cos(SPREAD))).toBeLessThan(1e-6)
  })
})

describe('spawnDust kinds', () => {
  test('chip spawns exactly 1 quad', () => {
    spawnDust(P, 0.5, { kind: 'chip', normal: new Vector3(0, 0, 1) })
    expect(dustCounts().puffs).toBe(1)
    expect(dustCounts().haze).toBe(0)
  })

  test('puff spawns 2-3 quads and no haze', () => {
    spawnDust(P, 0.5, { kind: 'puff' })
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
    expect(dustCounts().haze).toBe(0)
  })

  test('plume spawns 6-9 quads plus one auto haze', () => {
    spawnDust(P, 1, { kind: 'plume', normal: new Vector3(1, 0, 0) })
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(6)
    expect(n).toBeLessThanOrEqual(9)
    expect(dustCounts().haze).toBe(1)
  })

  test('legacy scalar call behaves as a puff', () => {
    spawnDust(1, 2, 3, 0.5)
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
  })

  test('2-arg Vector3 call (no opts) behaves as a puff', () => {
    spawnDust(P, 0.5)
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
  })
})

describe('spawnDust material kinds', () => {
  test('wood spawns nothing at all (splinters come from debris)', () => {
    spawnDust(P, 1, { kind: 'wood' })
    spawnDust(1, 2, 3, 1, 'wood')
    expect(dustCounts().puffs).toBe(0)
    expect(dustCounts().haze).toBe(0)
  })

  test('concrete spawns 2-3 puffs and never a haze, even at full intensity', () => {
    spawnDust(P, 1, { kind: 'concrete' })
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
    expect(dustCounts().haze).toBe(0)
  })

  test('drywall at heavy intensity upgrades to a plume + auto haze', () => {
    spawnDust(P, 1, { kind: 'drywall' })
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(6)
    expect(n).toBeLessThanOrEqual(9)
    expect(dustCounts().haze).toBe(1)
  })

  test('drywall at light intensity stays a puff', () => {
    spawnDust(P, 0.3, { kind: 'drywall' })
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
    expect(dustCounts().haze).toBe(0)
  })

  test('legacy 5-arg scalar form accepts a material kind', () => {
    spawnDust(1, 2, 3, 1, 'concrete')
    const n = dustCounts().puffs
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(3)
    expect(dustCounts().haze).toBe(0)
  })
})

describe('pool pressure', () => {
  test('spawn counts halve once the pool runs past 70%', () => {
    // 200 chips = 200 live slots (> 70% of 256), cursor parked on dead ones.
    for (let i = 0; i < 200; i++) spawnDust(P, 1, { kind: 'chip' })
    expect(dustCounts().puffs).toBe(200)
    spawnDust(P, 1, { kind: 'plume' })
    const delta = dustCounts().puffs - 200
    // Unhalved plume would add 6-9; halved adds 3-4.
    expect(delta).toBeGreaterThanOrEqual(3)
    expect(delta).toBeLessThanOrEqual(4)
  })
})

describe('spawnHaze', () => {
  test('accepts Vector3 + radius and legacy scalars', () => {
    spawnHaze(P, 3)
    spawnHaze(1, 2, 3)
    expect(dustCounts().haze).toBe(2)
  })
})
