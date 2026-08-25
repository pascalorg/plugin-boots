import { describe, expect, test } from 'bun:test'
import { MOVE, accelerate, applyFriction, stepVelocity, type Vec3 } from './movement'

const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

describe('friction', () => {
  test('stops completely from low speed (no asymptotic glide)', () => {
    const v = vec(0.3, 0, 0)
    for (let i = 0; i < 60; i++) applyFriction(v, 1 / 60, MOVE)
    expect(Math.hypot(v.x, v.z)).toBe(0)
  })

  test('does not touch vertical velocity', () => {
    const v = vec(3, -2, 0)
    applyFriction(v, 1 / 60, MOVE)
    expect(v.y).toBe(-2)
  })
})

describe('accelerate', () => {
  test('caps ground speed at wishSpeed', () => {
    const v = vec()
    for (let i = 0; i < 600; i++) {
      applyFriction(v, 1 / 60, MOVE)
      accelerate(v, 1, 0, MOVE.runSpeed, MOVE.accel, MOVE.runSpeed, 1 / 60)
    }
    const speed = Math.hypot(v.x, v.z)
    expect(speed).toBeGreaterThan(MOVE.runSpeed * 0.8)
    expect(speed).toBeLessThanOrEqual(MOVE.runSpeed + 1e-6)
  })

  test('air-strafing gains speed on perpendicular wish', () => {
    // Moving +X fast; wishing sideways (+Z) in air must ADD speed — the cap
    // only applies to the projection, that's the whole trick.
    const v = vec(6, 0, 0)
    const before = Math.hypot(v.x, v.z)
    accelerate(v, 0, 1, MOVE.runSpeed, MOVE.airAccel, MOVE.airCap, 1 / 60)
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(before)
  })

  test('air wish along velocity is capped hard', () => {
    const v = vec(6, 0, 0)
    accelerate(v, 1, 0, MOVE.runSpeed, MOVE.airAccel, MOVE.airCap, 1 / 60)
    expect(v.x).toBe(6) // already past the air cap — no free speed straight ahead
  })
})

describe('stepVelocity', () => {
  test('jump consumes and sets vertical velocity', () => {
    const v = vec()
    const jumped = stepVelocity(v, { wishX: 0, wishZ: 0, walk: false, jump: true }, true, 1 / 60)
    expect(jumped).toBe(true)
    expect(v.y).toBe(MOVE.jumpSpeed)
  })

  test('gravity pulls while airborne', () => {
    const v = vec(0, 0, 0)
    stepVelocity(v, { wishX: 0, wishZ: 0, walk: false, jump: false }, false, 0.1)
    expect(v.y).toBeCloseTo(-MOVE.gravity * 0.1)
  })

  test('walk modifier limits speed', () => {
    const v = vec()
    for (let i = 0; i < 600; i++) {
      stepVelocity(v, { wishX: 1, wishZ: 0, walk: true, jump: false }, true, 1 / 60)
    }
    expect(Math.hypot(v.x, v.z)).toBeLessThanOrEqual(MOVE.walkSpeed + 1e-6)
  })
})
