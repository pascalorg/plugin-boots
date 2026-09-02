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
  AIR_KNEE,
  BREATH_AMP,
  BREATH_RATE,
  FREE_ELBOW,
  GRIPS,
  limbDir,
  MODEL_ARMS,
  solveArm,
  KNEE_LIFT_MAX,
  RUN_LEAN,
  SLUMP_KNEE,
  gripFor,
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
  test('grounded gait: leg swing sine scales with s, the free arm counter-swings', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, false) // sin=1, full speed
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX)
    expect(out.armSwing).toBeLessThan(0) // counter-phase (default grip: a tool, so the left arm is free)
    articulate(out, Math.PI / 2, 0.5, 0, true, false)
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX * 0.5)
    articulate(out, Math.PI / 2, 0, 0, true, false)
    expect(out.legSwing).toBe(0) // standing still — no treadmill
    expect(out.bobY).toBe(0)
  })

  test('the knee lifts on the leg that is swinging forward, and only then', () => {
    const out = createArticulation()
    // Left leg mid-swing forward (hip angle rising through zero): left knee up.
    articulate(out, 0, 1, 0, true, false)
    expect(out.kneeL).toBeCloseTo(KNEE_LIFT_MAX)
    expect(out.kneeR).toBe(0)
    // Half a cycle on: the right leg's turn.
    articulate(out, Math.PI, 1, 0, true, false)
    expect(out.kneeR).toBeCloseTo(KNEE_LIFT_MAX)
    expect(out.kneeL).toBe(0)
    // Heel strike / toe-off (hip at its extremes): both knees straight.
    articulate(out, Math.PI / 2, 1, 0, true, false)
    expect(out.kneeL).toBeCloseTo(0)
    expect(out.kneeR).toBeCloseTo(0)
    // Scales with speed; still means straight.
    articulate(out, 0, 0.5, 0, true, false)
    expect(out.kneeL).toBeCloseTo(KNEE_LIFT_MAX * 0.5)
    articulate(out, 0, 0, 0, true, false)
    expect(out.kneeL).toBe(0)
  })

  test('running leans the torso forward with speed; standing, it just breathes', () => {
    const out = createArticulation()
    articulate(out, 0, 1, 0, true, false, 'tool', 0)
    expect(out.torsoPitch).toBeCloseTo(RUN_LEAN)
    articulate(out, 0, 0, 0, true, false, 'tool', 0)
    const still = out.torsoPitch
    articulate(out, 0, 0, 0, true, false, 'tool', Math.PI / 2 / BREATH_RATE)
    expect(out.torsoPitch - still).toBeCloseTo(BREATH_AMP)
    expect(Math.abs(out.torsoPitch)).toBeLessThan(0.05) // a breath, not a bow
  })

  test('airborne pose: legs split, knees tucked, free arm thrown back, no bob', () => {
    const out = createArticulation()
    articulate(out, 1.3, 0.8, 0, false, false)
    expect(out.legSwing).toBe(AIR_LEG_SPLIT)
    expect(out.kneeL).toBe(AIR_KNEE)
    expect(out.kneeR).toBe(AIR_KNEE)
    expect(out.armSwing).toBe(AIR_ARM_SWING)
    expect(out.bobY).toBe(0)
  })

  test('slump when staggered: torso lean, hung weapon arm, soft knees, half shuffle', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, true, 'long')
    expect(out.torsoPitch).toBe(SLUMP_TORSO)
    expect(out.armAim).toBe(SLUMP_ARM_AIM) // even a rifle hangs
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX * 0.5)
    expect(out.kneeL).toBeGreaterThanOrEqual(SLUMP_KNEE)
    expect(out.headPitch).toBeLessThan(0) // head hangs
  })

  test('head tracks the remote pitch (clamped)', () => {
    const out = createArticulation()
    articulate(out, 0, 0, 0.4, true, false)
    expect(out.headPitch).toBeCloseTo(0.4)
    articulate(out, 0, 0, 3, true, false) // absurd pitch clamps
    expect(out.headPitch).toBeCloseTo(0.6)
    articulate(out, 0, 0, -3, true, false)
    expect(out.headPitch).toBeCloseTo(-0.6)
  })

  test('solveArm puts the grip on the target, elbow bending the human way', () => {
    const a = MODEL_ARMS
    const fk = (sol: { swing: number; yaw: number; elbow: number }) => {
      const du = limbDir(sol.swing, sol.yaw)
      const df = limbDir(sol.swing + sol.elbow, sol.yaw)
      return [0, 1, 2].map((i) => a.upperArmLen * du[i]! + a.reach * df[i]!)
    }
    for (const target of [
      [-0.1, -0.1, -0.24],
      [0.05, -0.3, -0.2],
      [-0.2, 0.05, -0.3],
      [0.0, -0.4, -0.05],
    ] as const) {
      const sol = solveArm(target, a)
      const hand = fk(sol)
      for (let i = 0; i < 3; i++) expect(hand[i]).toBeCloseTo(target[i]!, 9)
      for (let i = 0; i < 3; i++) expect(sol.hand[i]).toBeCloseTo(target[i]!, 9)
      expect(sol.elbow).toBeGreaterThanOrEqual(0)
      expect(sol.elbow).toBeLessThanOrEqual(Math.PI)
    }
    // Out of reach: a (nearly) straight arm pointed at it.
    const far = solveArm([0, -0.2, -2], a)
    expect(far.elbow).toBeLessThan(0.06)
    expect(far.swing).toBeCloseTo(Math.atan2(2, 0.2), 1)
  })

  test('with a gun, the BARREL points where the peer looks, whatever the arm does', () => {
    const out = createArticulation()
    for (const grip of ['long', 'short'] as const) {
      for (const pitch of [-0.8, -0.3, 0, 0.4, 1.0]) {
        articulate(out, 0, 0, pitch, true, false, grip)
        expect(out.armAim + out.elbowR + out.weaponTilt).toBeCloseTo(GRIPS[grip].barrelFromDown + pitch, 9)
        expect(out.elbowR).toBeGreaterThanOrEqual(0)
      }
      articulate(out, 0, 0, 3, true, false, grip) // clamped, like the head
      expect(out.armAim + out.elbowR + out.weaponTilt).toBeCloseTo(GRIPS[grip].barrelFromDown + 1.2, 9)
    }
  })

  test('guns are held with BOTH hands: the left lands on the foregrip along the barrel, and both hands are within reach', () => {
    const out = createArticulation()
    const a = MODEL_ARMS
    const fk = (swing: number, yaw: number, elbow: number) => {
      const du = limbDir(swing, yaw)
      const df = limbDir(swing + elbow, yaw)
      return [0, 1, 2].map((i) => a.upperArmLen * du[i]! + a.reach * df[i]!)
    }
    for (const grip of ['long', 'short'] as const) {
      for (const pitch of [-0.4, 0, 0.5]) {
        articulate(out, Math.PI / 2, 1, pitch, true, false, grip) // mid-stride: the hold does not swing
        const right = fk(out.armAim, out.armRYaw, out.elbowR) // relative to the right shoulder
        const left = fk(out.armSwing, out.armLYaw, out.elbowL) // relative to the left shoulder
        const barrel = limbDir(GRIPS[grip].barrelFromDown + pitch, out.armRYaw)
        // Left hand = right hand + foregrip along the barrel (a touch to the left), in one frame.
        const expectLeft = [
          right[0]! + 2 * a.shoulderX + GRIPS[grip].foregrip * barrel[0] - 0.03,
          right[1]! + GRIPS[grip].foregrip * barrel[1],
          right[2]! + GRIPS[grip].foregrip * barrel[2],
        ]
        // Both hands must be REACHABLE from their shoulders — a clamped IK lands short.
        const reach = a.upperArmLen + a.reach
        expect(Math.hypot(...right)).toBeLessThan(reach)
        expect(Math.hypot(...expectLeft)).toBeLessThan(reach)
        for (let i = 0; i < 3; i++) expect(left[i]).toBeCloseTo(expectLeft[i]!, 6)
        expect(left[2]).toBeLessThanOrEqual(right[2]! + 1e-9) // never behind the right hand
        expect(out.armLYaw).toBeLessThan(0) // in toward the body
        expect(out.armRYaw).toBeGreaterThan(0)
        expect(out.elbowL).toBeGreaterThan(0)
      }
    }
    // The gun arm never stride-swings — the same pose whatever the phase.
    articulate(out, 0, 1, 0, true, false, 'long')
    const held = { ...out }
    articulate(out, Math.PI / 2, 1, 0, true, false, 'long')
    expect(out.armAim).toBeCloseTo(held.armAim)
    expect(out.armSwing).toBeCloseTo(held.armSwing)
  })

  test('a tool rides in one relaxed hand by the hip while the other arm swings free', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0.5, true, false, 'tool')
    expect(out.elbowR).toBeGreaterThan(0.2) // bent, not locked
    expect(out.armAim).toBeLessThan(Math.PI / 4) // low, not raised
    expect(out.armSwing).toBeLessThan(0) // counter-swinging the stride
    expect(out.armLYaw).toBe(0)
    expect(out.elbowL).toBe(FREE_ELBOW)
    // The tool points forward-down, not at the sky.
    const dir = out.armAim + out.elbowR + out.weaponTilt
    expect(dir).toBeCloseTo(GRIPS.tool.barrelFromDown + 0.5, 9)
  })

  test('empty hands: both arms swing, in opposition', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, false, 'none')
    expect(out.armSwing).toBeLessThan(0)
    expect(out.armAim).toBeCloseTo(-out.armSwing)
  })

  test('gripFor: guns by length, tools in hand, nothing in empty hands, strangers as tools', () => {
    expect(gripFor('rifle')).toBe('long')
    expect(gripFor('minigun')).toBe('long')
    expect(gripFor('pistol')).toBe('short')
    for (const w of ['knife', 'hammer', 'builder', 'paint']) expect(gripFor(w)).toBe('tool')
    expect(gripFor('')).toBe('none')
    expect(gripFor('laser-from-the-future')).toBe('tool')
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
