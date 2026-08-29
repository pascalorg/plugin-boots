import { describe, expect, test } from 'bun:test'
import {
  advanceGait,
  AIR_ARM_SWING,
  AIR_LEG_SPLIT,
  articulate,
  AVATAR_PALETTE,
  createArticulation,
  hashUserId,
  LEG_SWING_MAX,
  materialsFor,
  paletteIndexFor,
  SLUMP_ARM_AIM,
  SLUMP_TORSO,
  SPAWN_SCALE_MS,
  spawnScale,
  TAG_MAX_DIST,
  tagVisible,
} from './remote-players'

/**
 * The pure half of the avatar renderer: palette assignment, articulation
 * rules, join scale-in, name-tag distance gate. The R3F assembly itself is
 * exercised live (two-browser QA) — and its ANTI-GOAL is pinned here as
 * documentation: avatars never join world colliders and are never
 * shootable (they are not registered with any raycast registry).
 */

describe('avatar palette — stable per userId, bounded to 8', () => {
  test('hash is deterministic and the index stays in range', () => {
    expect(hashUserId('user-a')).toBe(hashUserId('user-a'))
    for (const id of ['a', 'user-b', 'ux-9f2', 'long-user-id-with-suffix-42', '']) {
      const index = paletteIndexFor(id)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(AVATAR_PALETTE.length)
    }
    expect(AVATAR_PALETTE.length).toBe(8)
  })

  test('different users spread across the palette', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 64; i++) seen.add(paletteIndexFor(`user-${i}`))
    expect(seen.size).toBeGreaterThan(4) // no degenerate bucketing
  })

  test('materials are cached per slot and tinted from the palette', () => {
    const a = materialsFor(2)
    expect(materialsFor(2)).toBe(a) // cache hit — shared across avatars
    expect(materialsFor(3)).not.toBe(a)
    expect(`#${a.body.color.getHexString()}`).toBe(AVATAR_PALETTE[2])
    // Trim is a darker cut of the same tint.
    expect(a.trim.color.r).toBeLessThan(a.body.color.r + 1e-6)
  })
})

describe('articulation — gait, airborne, slump', () => {
  test('grounded gait: leg swing sine scales with s, arms counter-swing', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, false) // sin=1, full speed
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX)
    expect(out.armSwing).toBeLessThan(0) // counter-phase
    articulate(out, Math.PI / 2, 0.5, 0, true, false)
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX * 0.5)
    articulate(out, Math.PI / 2, 0, 0, true, false)
    expect(out.legSwing).toBe(0) // standing still — no treadmill
    expect(out.bobY).toBe(0)
  })

  test('airborne pose: fixed leg split + thrown-back arm, no bob', () => {
    const out = createArticulation()
    articulate(out, 1.3, 0.8, 0, false, false)
    expect(out.legSwing).toBe(AIR_LEG_SPLIT)
    expect(out.armSwing).toBe(AIR_ARM_SWING)
    expect(out.bobY).toBe(0)
  })

  test('slump when staggered: torso lean, hung weapon arm, half shuffle', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, true)
    expect(out.torsoPitch).toBe(SLUMP_TORSO)
    expect(out.armAim).toBe(SLUMP_ARM_AIM)
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX * 0.5)
    expect(out.headPitch).toBeLessThan(0) // head hangs
  })

  test('head and weapon arm track the remote pitch (clamped)', () => {
    const out = createArticulation()
    articulate(out, 0, 0, 0.4, true, false)
    expect(out.headPitch).toBeCloseTo(0.4)
    expect(out.armAim).toBeCloseTo(Math.PI / 2 + 0.4)
    articulate(out, 0, 0, 3, true, false) // absurd pitch clamps
    expect(out.headPitch).toBeCloseTo(0.6)
    expect(out.armAim).toBeCloseTo(Math.PI / 2 + 1.2)
    articulate(out, 0, 0, -3, true, false)
    expect(out.headPitch).toBeCloseTo(-0.6)
  })

  test('gait phase advances with speed and settles when stopped', () => {
    expect(advanceGait(1, 1, 0.1)).toBeCloseTo(1.7)
    expect(advanceGait(1, 0, 0.1)).toBe(1)
    expect(advanceGait(1, -5, 0.1)).toBe(1) // hostile s never rewinds
  })
})

describe('join scale-in + name-tag gate', () => {
  test(`scale-in ramps 0→1 over ${SPAWN_SCALE_MS}ms, ease-out, never 0`, () => {
    expect(spawnScale(-50)).toBe(0.001) // clock skew never inverts a matrix
    expect(spawnScale(0)).toBe(0.001)
    expect(spawnScale(SPAWN_SCALE_MS / 2)).toBeCloseTo(0.75) // ease-out front-loads
    expect(spawnScale(SPAWN_SCALE_MS)).toBe(1)
    expect(spawnScale(SPAWN_SCALE_MS * 10)).toBe(1)
  })

  test(`name tags hide past ${TAG_MAX_DIST}m`, () => {
    expect(tagVisible(39.9 * 39.9)).toBe(true)
    expect(tagVisible(TAG_MAX_DIST * TAG_MAX_DIST)).toBe(true)
    expect(tagVisible(40.1 * 40.1)).toBe(false)
  })
})
