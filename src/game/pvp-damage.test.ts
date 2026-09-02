import { describe, expect, test } from 'bun:test'
import { consumeHits, rayHitsCapsule, validatePvpFrame } from './pvp-damage'

/**
 * PvP hit damage — the two pure cores that decide a hit and de-dup the wire.
 * The roster raycast + the netcode wrap these; these pin the geometry and the
 * idempotency that make PvP fair and coalescing-safe.
 */

// A player standing at world origin: feet (0,0,0), a 1.78 m capsule, r 0.42.
const FEET = { x: 0, y: 0, z: 0 }
const H = 1.78
const R = 0.42

describe('rayHitsCapsule', () => {
  test('a level shot down the barrel at chest height hits', () => {
    // Eye at z=5, aiming -Z along x=0 at chest height 1.0 — passes through the
    // capsule axis at (0,1.0,0), distance 0.
    const t = rayHitsCapsule(0, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(5, 3)
  })

  test('a shot two metres to the side misses', () => {
    const t = rayHitsCapsule(2, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).toBeNull()
  })

  test('a shot just inside the radius still hits', () => {
    const t = rayHitsCapsule(0.4, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).not.toBeNull()
  })

  test('a target behind the shooter is never hit', () => {
    // Eye at z=-5 aiming -Z: the player at origin is behind (toward +Z).
    const t = rayHitsCapsule(0, 1.0, -5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).toBeNull()
  })

  test('a nearer wall (maxDist) occludes the player', () => {
    // Same clean hit, but the world cull already found geometry at 3 m.
    const t = rayHitsCapsule(0, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 3)
    expect(t).toBeNull()
  })

  test('a steep shot at the feet clamps to the segment end and can still hit', () => {
    // Standing over them, aiming straight down onto the head.
    const t = rayHitsCapsule(0, 4, 0, 0, -1, 0, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).not.toBeNull()
  })
})

describe('consumeHits (idempotent counter diff)', () => {
  const MAX = 4
  test('first tag from a shooter applies once', () => {
    const seen = new Map<string, number>()
    expect(consumeHits('shooterA', 1, seen, MAX)).toBe(1)
    expect(seen.get('shooterA')).toBe(1)
  })

  test('a duplicate frame (same counter) applies nothing', () => {
    const seen = new Map<string, number>([['shooterA', 1]])
    expect(consumeHits('shooterA', 1, seen, MAX)).toBe(0)
  })

  test('a jump in the counter applies exactly the delta', () => {
    const seen = new Map<string, number>([['shooterA', 1]])
    expect(consumeHits('shooterA', 3, seen, MAX)).toBe(2)
    expect(seen.get('shooterA')).toBe(3)
  })

  test('a coalesced burst is capped at maxBurst', () => {
    const seen = new Map<string, number>([['shooterA', 1]])
    expect(consumeHits('shooterA', 100, seen, MAX)).toBe(MAX)
    // ...but seen advances to the true counter so no double-apply later.
    expect(seen.get('shooterA')).toBe(100)
  })

  test('a reordered older frame is ignored', () => {
    const seen = new Map<string, number>([['shooterA', 5]])
    expect(consumeHits('shooterA', 3, seen, MAX)).toBe(0)
    expect(seen.get('shooterA')).toBe(5)
  })

  test('two shooters are tracked independently', () => {
    const seen = new Map<string, number>()
    expect(consumeHits('a', 2, seen, MAX)).toBe(2)
    expect(consumeHits('b', 1, seen, MAX)).toBe(1)
    expect(consumeHits('a', 2, seen, MAX)).toBe(0)
  })

  test('a missing / non-finite counter applies nothing', () => {
    const seen = new Map<string, number>()
    expect(consumeHits('a', undefined, seen, MAX)).toBe(0)
    expect(consumeHits('a', Number.NaN, seen, MAX)).toBe(0)
    expect(seen.size).toBe(0)
  })
})

describe('validatePvpFrame', () => {
  test('rejects non-objects', () => {
    expect(validatePvpFrame(null)).toBeNull()
    expect(validatePvpFrame(42)).toBeNull()
    expect(validatePvpFrame({})).toBeNull()
    expect(validatePvpFrame({ hits: 5 })).toBeNull()
  })

  test('keeps finite non-negative counters and drops the rest', () => {
    const out = validatePvpFrame({ hits: { a: 2, b: -1, c: Number.NaN, d: 'x', e: 0 } })
    expect(out).toEqual({ hits: { a: 2, e: 0 } })
  })

  test('an empty hits map is valid', () => {
    expect(validatePvpFrame({ hits: {} })).toEqual({ hits: {} })
  })
})
