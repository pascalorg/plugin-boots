import { describe, expect, test } from 'bun:test'
import {
  advanceGait,
  AIR_ARM_SWING,
  AIR_LEG_SPLIT,
  articulate,
  assignPalette,
  AVATAR_PALETTE,
  createArticulation,
  DETAIL_MAX_DIST,
  detailVisible,
  flashScale,
  hashUserId,
  LEG_SWING_MAX,
  materialsFor,
  paletteIndexFor,
  remoteMuzzle,
  shotKindFor,
  SLUMP_ARM_AIM,
  SLUMP_TORSO,
  SPAWN_SCALE_MS,
  spawnScale,
  TAG_FADE_START,
  TAG_MAX_DIST,
  tagOpacity,
  tagVisible,
  TRACER_LEN,
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
    expect(`#${a.vest.color.getHexString()}`).toBe(AVATAR_PALETTE[2])
    // The hat band is a darker cut of the same tint (the hat stays white).
    expect(a.band.color.r).toBeLessThan(a.vest.color.r + 1e-6)
  })
})

/**
 * Distinct colors are the whole point of the customization: "each new player
 * has a different color". The hash alone cannot promise that, so the deal is
 * roster-wide — and it has to come out the same on every screen from nothing
 * but the id set, because there is no message that carries it.
 */
describe('palette assignment — one tint each, agreed without coordination', () => {
  test('a lot of players up to the palette size all get different tints', () => {
    for (let n = 1; n <= AVATAR_PALETTE.length; n++) {
      const ids = Array.from({ length: n }, (_, i) => `user-${i}`)
      const deal = assignPalette(ids)
      expect(deal.size).toBe(n)
      expect(new Set(deal.values()).size).toBe(n) // no two share
      for (const slot of deal.values()) {
        expect(slot).toBeGreaterThanOrEqual(0)
        expect(slot).toBeLessThan(AVATAR_PALETTE.length)
      }
    }
  })

  test('every client computes the same deal, whatever order it learned them in', () => {
    const ids = ['zoe', 'ada', 'grace', 'linus', 'hopper']
    const mine = assignPalette(ids)
    const theirs = assignPalette([...ids].reverse())
    const late = assignPalette([ids[2]!, ids[0]!, ids[4]!, ids[1]!, ids[3]!])
    for (const id of ids) {
      expect(theirs.get(id)).toBe(mine.get(id))
      expect(late.get(id)).toBe(mine.get(id))
    }
  })

  test('an uncontested id keeps the tint its hash asked for', () => {
    const deal = assignPalette(['solo-user'])
    expect(deal.get('solo-user')).toBe(paletteIndexFor('solo-user'))
  })

  test('one person on two devices is one entry, not two tints', () => {
    const deal = assignPalette(['ada', 'ada', 'grace'])
    expect(deal.size).toBe(2)
    expect(deal.get('ada')).toBe(paletteIndexFor('ada'))
  })

  test('a joiner can MOVE an id already in the lot to another slot', () => {
    // Why localPaletteIndex is a subscription and not a mount-time read (the
    // depot mirror): collisions walk forward through the SORTED id set, so
    // somebody arriving with a lower-sorted id and the same preferred slot
    // takes it and pushes the sitting player to the next one. Find such a pair
    // rather than assert a hash by hand — the hash is free to change.
    let moved: [string, string] | null = null
    for (let i = 0; i < 400 && !moved; i++) {
      for (let j = 0; j < 400; j++) {
        const a = `player-${i}`
        const b = `player-${j}`
        if (a >= b) continue
        if (paletteIndexFor(a) !== paletteIndexFor(b)) continue
        moved = [b, a] // b was alone; a sorts first and takes the slot
        break
      }
    }
    expect(moved).not.toBeNull()
    const [sitting, joiner] = moved!
    const alone = assignPalette([sitting])
    const together = assignPalette([sitting, joiner])
    expect(alone.get(sitting)).toBe(paletteIndexFor(sitting))
    expect(together.get(sitting)).not.toBe(alone.get(sitting))
  })

  test('past the palette size it degrades to the hash instead of failing', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `user-${i}`)
    const deal = assignPalette(ids)
    expect(deal.size).toBe(20)
    // The first 8 dealt (sorted order) still hold 8 distinct slots.
    expect(new Set(deal.values()).size).toBe(AVATAR_PALETTE.length)
    for (const slot of deal.values()) expect(slot).toBeLessThan(AVATAR_PALETTE.length)
  })
})

describe('detail LOD — the small parts fall away with distance', () => {
  test('near is detailed, far is silhouette, and the boundary is inclusive', () => {
    expect(detailVisible(0)).toBe(true)
    expect(detailVisible((DETAIL_MAX_DIST - 1) ** 2)).toBe(true)
    expect(detailVisible(DETAIL_MAX_DIST ** 2)).toBe(true)
    expect(detailVisible((DETAIL_MAX_DIST + 0.5) ** 2)).toBe(false)
    // Detail drops well before the name tag does — the tag is the last thing
    // to go, because it is the one part that is still legible out there.
    expect(DETAIL_MAX_DIST).toBeLessThan(TAG_MAX_DIST)
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

  test(`name tags are solid to ${TAG_FADE_START}m, then ramp out to nothing`, () => {
    expect(tagOpacity(0)).toBe(1)
    expect(tagOpacity(TAG_FADE_START * TAG_FADE_START)).toBe(1)
    // Halfway through the fade band reads as half opacity.
    const mid = (TAG_FADE_START + TAG_MAX_DIST) / 2
    expect(tagOpacity(mid * mid)).toBeCloseTo(0.5, 5)
    expect(tagOpacity(TAG_MAX_DIST * TAG_MAX_DIST)).toBe(0)
    expect(tagOpacity(1e6)).toBe(0)
  })

  test('the fade is monotonic and never leaves [0,1] (no negative opacity)', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let d = 0; d <= 60; d += 0.5) {
      const opacity = tagOpacity(d * d)
      expect(opacity).toBeGreaterThanOrEqual(0)
      expect(opacity).toBeLessThanOrEqual(1)
      expect(opacity).toBeLessThanOrEqual(previous)
      previous = opacity
    }
  })

  test('anything the fade shows is also inside the visibility gate', () => {
    for (let d = 0; d <= 60; d += 0.5) {
      if (tagOpacity(d * d) > 0) expect(tagVisible(d * d)).toBe(true)
    }
  })
})

/**
 * Remote gunfire, the pure half. The flash itself is R3F assembly reviewed
 * live, but WHICH weapons flash, which report they use and how big the flash
 * gets are rules, and rules get pinned.
 */
describe('remote gunfire — only guns flash', () => {
  test('the three guns have a muzzle, in the weapon-model space', () => {
    for (const gun of ['pistol', 'rifle', 'minigun']) {
      const muzzle = remoteMuzzle(gun)
      expect(muzzle).not.toBeNull()
      // Grip at the origin, barrel down -Z: the muzzle is always in front.
      expect(muzzle![2]).toBeLessThan(0)
    }
    // A longer gun's muzzle is farther out — the flash sits at the tip, not
    // somewhere inside the receiver.
    expect(remoteMuzzle('minigun')![2]).toBeLessThan(remoteMuzzle('pistol')![2])
  })

  test('nothing else does — a knife swing can never bloom a muzzle flash', () => {
    for (const held of ['knife', 'hammer', 'builder', 'paint', '', 'ar15', 'railgun']) {
      expect(remoteMuzzle(held)).toBeNull()
    }
  })

  test('each gun gets its own report; unknown ids fall back audible', () => {
    expect(shotKindFor('pistol')).toBe('pistol')
    expect(shotKindFor('minigun')).toBe('minigun')
    expect(shotKindFor('rifle')).toBe('rifle')
    // A newer peer holding something this build has never heard of still makes
    // a noise: a shot you cannot place beats a silent one.
    expect(shotKindFor('plasma-thing')).toBe('rifle')
    expect(shotKindFor('')).toBe('rifle')
  })

  test('the flash grows with range, monotonically and bounded', () => {
    expect(flashScale(0)).toBe(1)
    let previous = 0
    for (let d = 0; d <= 200; d += 1) {
      const scale = flashScale(d)
      expect(scale).toBeGreaterThanOrEqual(previous)
      expect(scale).toBeLessThanOrEqual(4) // never a beach ball at the fence
      previous = scale
    }
    expect(flashScale(50)).toBe(4)
    expect(flashScale(-10)).toBe(1) // behind the camera is still point blank
  })

  test('the tracer is a stub, not a beam to the target', () => {
    // Impacts announce themselves with their own dust and debris on this
    // client, so the streak only has to say "that barrel just fired".
    expect(TRACER_LEN).toBeGreaterThan(1)
    expect(TRACER_LEN).toBeLessThan(5)
  })
})
