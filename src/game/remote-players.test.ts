import { describe, expect, test } from 'bun:test'
import { Group } from 'three'
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
  blendArticulation,
  IDLE,
  placeRoot,
  STRIDE,
  HAND_COLLAPSE,
  applyArticulation,
  BLEND_RATE,
  IDLE_FADE_S,
  avatarDebug,
  AVATAR_RECOIL,
  createMotion,
  footPlantDrop,
  GAIT_MIN_S,
  GAIT_RATE,
  GAIT_RATE_MAX,
  GAIT_SETTLE_RATE,
  gaitRate,
  LAND,
  LATERAL_SWING,
  layerMotion,
  LEG_LEN_M,
  LEG_SWING_CAP,
  legSwingFor,
  RUN_SPEED_M_S,
  SPEED_DISP_ZERO,
  STEP_LEN_RUN_M,
  STEP_LEN_WALK_M,
  stepLength,
  TURN,
  updateMotion,
  WALK_S,
} from './remote-players'
import { presenceDebug, wrapAngle } from './presence'

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
    expect(out.legSwing).toBeCloseTo(legSwingFor(0.5)) // a stride LENGTH: ~constant above a creep
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
    // Scales with speed; still means no LIFT — only the idle weight shift is left.
    articulate(out, 0, 0.5, 0, true, false)
    expect(out.kneeL).toBeCloseTo(KNEE_LIFT_MAX * 0.5 + IDLE.shiftKnee * 0.5 * (1 - 0.5 / IDLE_FADE_S) * 0)
    articulate(out, 0, 0, 0, true, false)
    expect(out.kneeL).toBeLessThanOrEqual(IDLE.shiftKnee + 1e-9)
    expect(out.kneeR).toBeLessThanOrEqual(IDLE.shiftKnee + 1e-9)
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

  test('a standing body is never still: the idle layer moves torso, head, knees and the free arm over time', () => {
    const a = createArticulation()
    const b = createArticulation()
    articulate(a, 0, 0, 0, true, false, 'tool', 1.0)
    articulate(b, 0, 0, 0, true, false, 'tool', 3.7)
    // Something moved between the two instants, in every idle channel.
    expect(a.torsoYaw).not.toBeCloseTo(b.torsoYaw, 4)
    expect(a.torsoRoll).not.toBeCloseTo(b.torsoRoll, 4)
    expect(a.headYaw).not.toBeCloseTo(b.headYaw, 4)
    expect(a.armSwing).not.toBeCloseTo(b.armSwing, 4)
    expect(a.kneeL + a.kneeR).toBeGreaterThan(0) // weight on one leg, the other knee soft
    // ...but all of it is subtle: a shift of weight, not a dance.
    for (const o of [a, b]) {
      expect(Math.abs(o.torsoYaw)).toBeLessThanOrEqual(IDLE.swayYaw + 1e-9)
      expect(Math.abs(o.headYaw)).toBeLessThanOrEqual(IDLE.lookYaw + 1e-9)
      expect(Math.abs(o.swayX)).toBeLessThanOrEqual(IDLE.shiftLean + 1e-9)
    }
  })

  test('the idle layer fades out with speed and is gone at a jog', () => {
    const still = createArticulation()
    const jog = createArticulation()
    // Same phase (π/2: no stride twist), same instant — only the speed differs.
    articulate(still, Math.PI / 2, 0, 0, true, false, 'tool', 2.0)
    articulate(jog, Math.PI / 2, 1, 0, true, false, 'tool', 2.0)
    expect(Math.abs(still.torsoYaw)).toBeGreaterThan(0)
    expect(jog.torsoYaw).toBeCloseTo(-STRIDE.twist * Math.sin(Math.PI / 2), 9) // stride only, no idle sway
    expect(jog.headYaw).toBeCloseTo(-jog.torsoYaw * STRIDE.headCounter, 9)
  })

  test('two peers with different seeds do not move in unison', () => {
    const a = createArticulation()
    const b = createArticulation()
    articulate(a, 0, 0, 0, true, false, 'tool', 2.0, MODEL_ARMS, 0)
    articulate(b, 0, 0, 0, true, false, 'tool', 2.0, MODEL_ARMS, 2.1)
    expect(a.headYaw).not.toBeCloseTo(b.headYaw, 4)
    expect(a.torsoPitch).not.toBeCloseTo(b.torsoPitch, 4)
  })

  test('the stride twists the shoulders against the legs, rolls the hips, sways the root, and the head counters', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0)
    // Left leg forward (legSwing > 0): shoulders twist the other way.
    expect(out.legSwing).toBeGreaterThan(0)
    expect(out.torsoYaw).toBeCloseTo(-STRIDE.twist, 9)
    expect(out.torsoRoll).toBeCloseTo(STRIDE.roll, 9)
    expect(out.swayX).toBeCloseTo(STRIDE.sway, 9)
    expect(out.headYaw).toBeCloseTo(STRIDE.twist * STRIDE.headCounter, 9)
    // Half a cycle later everything mirrors.
    articulate(out, -Math.PI / 2, 1, 0, true, false, 'tool', 0)
    expect(out.torsoYaw).toBeCloseTo(STRIDE.twist, 9)
    expect(out.torsoRoll).toBeCloseTo(-STRIDE.roll, 9)
    // The free arm swinging forward bends its elbow more than one hanging back.
    articulate(out, -Math.PI / 2, 1, 0, true, false, 'tool', 0) // armSwing > 0: forward
    const fwd = out.elbowL
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0)
    expect(fwd).toBeGreaterThan(out.elbowL)
  })

  test('hands close on what they hold: right for anything, left only for a two-handed gun', () => {
    const out = createArticulation()
    articulate(out, 0, 0, 0, true, false, 'none')
    expect(out.gripL).toBe(0)
    expect(out.gripR).toBe(0)
    articulate(out, 0, 0, 0, true, false, 'tool')
    expect(out.gripR).toBe(1)
    expect(out.gripL).toBe(0)
    articulate(out, 0, 0, 0, true, false, 'long')
    expect(out.gripR).toBe(1)
    expect(out.gripL).toBe(1)
    articulate(out, 0, 0, 0, true, true, 'long') // staggered: the gun hangs in one hand
    expect(out.gripR).toBe(1)
    expect(out.gripL).toBe(0)
  })

  test('blendArticulation eases toward the target, frame-rate independent, legs faster than arms', () => {
    const live = createArticulation()
    const target = createArticulation()
    target.armAim = 1.0
    target.legSwing = 0.5
    target.gripR = 1
    // One 1/60 step: partway there, legs further along than arms.
    blendArticulation(live, target, 1 / 60)
    const legFrac = live.legSwing / 0.5
    const armFrac = live.armAim / 1.0
    expect(legFrac).toBeGreaterThan(armFrac)
    expect(armFrac).toBeGreaterThan(0)
    expect(armFrac).toBeLessThan(1)
    // Sixty 1/60 steps ≈ one 1 s step (exponential, not per-frame).
    const a = createArticulation()
    for (let i = 0; i < 60; i++) blendArticulation(a, target, 1 / 60)
    const b = createArticulation()
    blendArticulation(b, target, 1)
    expect(a.armAim).toBeCloseTo(b.armAim, 6)
    // After a second it has essentially arrived.
    expect(a.armAim).toBeCloseTo(1.0, 3)
    expect(a.gripR).toBeCloseTo(1, 3)
    // A zero or negative dt never moves it backward or explodes.
    const c = createArticulation()
    blendArticulation(c, target, 0)
    expect(c.armAim).toBe(0)
    blendArticulation(c, target, -1)
    expect(c.armAim).toBe(0)
  })

  test('applyArticulation collapses a gripping hand and shows its fist; releases both when open', () => {
    const mk = () => ({ current: new Group() })
    const refs = {
      torso: mk(), head: mk(), armL: mk(), armR: mk(), legL: mk(), legR: mk(),
      headDetail: mk(), bodyDetail: mk(), handL: mk(), handR: mk(), fistL: mk(), fistR: mk(),
    }
    const a = createArticulation()
    a.gripR = 1
    a.gripL = 0
    applyArticulation(refs, a)
    expect(refs.handR.current.scale.x).toBeCloseTo(HAND_COLLAPSE, 9)
    expect(refs.fistR.current.visible).toBe(true)
    expect(refs.handL.current.scale.x).toBe(1)
    expect(refs.fistL.current.visible).toBe(false)
    a.gripR = 0
    applyArticulation(refs, a)
    expect(refs.handR.current.scale.x).toBe(1)
    expect(refs.fistR.current.visible).toBe(false)
    // Torso yaw/roll and head yaw land on the pivots too.
    a.torsoYaw = 0.1
    a.torsoRoll = -0.05
    a.headYaw = 0.2
    applyArticulation(refs, a)
    expect(refs.torso.current.rotation.y).toBeCloseTo(0.1, 12)
    expect(refs.torso.current.rotation.z).toBeCloseTo(-0.05, 12)
    expect(refs.head.current.rotation.y).toBeCloseTo(0.2, 12)
  })

  test('placeRoot lifts by the bob and sways along the body\'s own +x, whatever the yaw', () => {
    const root = new Group()
    const a = createArticulation()
    a.bobY = 0.03
    a.swayX = 0.02
    placeRoot(root, 1, 2, 3, 0, a) // facing −Z: +x is world +x
    expect(root.position.x).toBeCloseTo(1.02, 12)
    expect(root.position.y).toBeCloseTo(2.03, 12)
    expect(root.position.z).toBeCloseTo(3, 12)
    placeRoot(root, 1, 2, 3, Math.PI / 2, a) // facing −X: +x is world −Z
    expect(root.position.x).toBeCloseTo(1, 12)
    expect(root.position.z).toBeCloseTo(3 - 0.02, 12)
  })

  test('gait phase advances at the stride cadence and SETTLES to legs-together when stopped', () => {
    expect(advanceGait(1, 1, 0.1)).toBeCloseTo(1 + 0.1 * GAIT_RATE_MAX)
    expect(GAIT_RATE).toBe(GAIT_RATE_MAX)
    expect(advanceGait(1, 0, 0.1)).toBe(0) // toward the nearest k·π (0), 1 rad of travel allowed
    expect(advanceGait(2, 0, 0.1)).toBe(3) // toward π, capped at GAIT_SETTLE_RATE·dt
    expect(advanceGait(3.1, 0, 0.1)).toBe(Math.round(3.1 / Math.PI) * Math.PI) // lands exactly, never past
    expect(advanceGait(1, -5, 0.1)).toBe(0) // hostile s reads as stopped
    expect(advanceGait(1, Number.NaN, 0.1)).toBe(0)
  })
})

/**
 * THE GAIT IS A STRIDE LENGTH. Feet plant when the phase advances π per step
 * of ground; these pin the geometry that makes a remote runner's feet stick
 * instead of skating, and the settle that ends a stop with the feet together.
 */
describe('gait model — stride length, not cadence', () => {
  test('step length: the walk\'s up to WALK_S, lengthening to the run\'s at s = 1, monotone', () => {
    expect(stepLength(0)).toBe(STEP_LEN_WALK_M)
    expect(stepLength(WALK_S)).toBe(STEP_LEN_WALK_M)
    expect(stepLength(1)).toBeCloseTo(STEP_LEN_RUN_M, 12)
    expect(STEP_LEN_RUN_M).toBeCloseTo(2 * LEG_LEN_M * Math.sin(LEG_SWING_CAP), 12)
    let previous = 0
    for (let s = 0; s <= 1.0001; s += 0.05) {
      expect(stepLength(s)).toBeGreaterThanOrEqual(previous - 1e-12)
      previous = stepLength(s)
    }
    expect(LEG_LEN_M).toBeCloseTo(0.829, 3)
  })

  test('gaitRate plants the feet: rate·stepLength/π equals the speed, up to the cadence cap', () => {
    for (const v of [0.6, 1, 1.5, 3, 4.5]) {
      const s = v / RUN_SPEED_M_S
      expect((gaitRate(s) * stepLength(s)) / Math.PI).toBeCloseTo(v, 9)
    }
    expect(gaitRate(GAIT_MIN_S / 2)).toBe(0) // nobody steps at a creep
    expect(gaitRate(1)).toBe(GAIT_RATE_MAX)
    // At a full sprint the cap bites: the feet cover ~80 % and slide the rest.
    const covered = (GAIT_RATE_MAX * stepLength(1)) / Math.PI
    expect(1 - covered / RUN_SPEED_M_S).toBeLessThanOrEqual(0.25)
    expect(1 - covered / RUN_SPEED_M_S).toBeGreaterThan(0.1)
  })

  test('integrating advanceGait for 10 s at 1.5 / 3 / 4.5 m/s covers the distance within 3 %', () => {
    for (const v of [1.5, 3, 4.5]) {
      const s = v / RUN_SPEED_M_S
      let phase = 0.37
      const start = phase
      for (let i = 0; i < 600; i++) phase = advanceGait(phase, s, 1 / 60)
      const distance = ((phase - start) / Math.PI) * stepLength(s)
      expect(Math.abs(distance - v * 10) / (v * 10)).toBeLessThan(0.03)
    }
  })

  test('legSwingFor: 0 at rest, fades in under GAIT_MIN_S, the walk\'s half-angle above it, the cap at a run', () => {
    expect(legSwingFor(0)).toBe(0)
    const walkAngle = Math.asin(STEP_LEN_WALK_M / (2 * LEG_LEN_M))
    expect(legSwingFor(GAIT_MIN_S / 2)).toBeCloseTo(walkAngle / 2, 9)
    expect(legSwingFor(GAIT_MIN_S)).toBeCloseTo(walkAngle, 9)
    expect(legSwingFor(WALK_S)).toBeCloseTo(walkAngle, 9)
    expect(legSwingFor(1)).toBeCloseTo(LEG_SWING_CAP, 9)
    expect(LEG_SWING_MAX).toBe(legSwingFor(1))
    expect(legSwingFor(-1)).toBe(0)
  })

  test('legs settle: from any phase at s = 0 the legs are together within 300 ms at 60 fps, monotone', () => {
    for (const start of [0.3, 1.2, 2.0, 2.9, -1.1, 7.5, 100.4]) {
      let phase = start
      const target = Math.round(start / Math.PI) * Math.PI
      let previousDist = Math.abs(target - start)
      for (let i = 0; i < 18; i++) {
        phase = advanceGait(phase, 0, 1 / 60)
        const dist = Math.abs(target - phase)
        expect(dist).toBeLessThanOrEqual(previousDist + 1e-12) // never past, never back
        previousDist = dist
      }
      expect(Math.abs(Math.sin(phase))).toBeLessThan(0.05)
      const out = createArticulation()
      articulate(out, phase, 0, 0, true, false)
      expect(out.legSwing).toBeCloseTo(0, 6)
    }
    expect(GAIT_SETTLE_RATE * 0.3).toBeGreaterThan(Math.PI / 2) // the worst case fits
  })
})

describe('articulation — strafe and backpedal decomposition', () => {
  const amp = legSwingFor(1)

  test('a strafe steps sideways: legSwing 0, |legSide| = amp·LATERAL_SWING', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0, MODEL_ARMS, 0, Math.PI / 2)
    expect(out.legSwing).toBeCloseTo(0, 9)
    expect(out.legSide).toBeCloseTo(amp * LATERAL_SWING, 9)
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0, MODEL_ARMS, 0, -Math.PI / 2)
    expect(out.legSide).toBeCloseTo(-amp * LATERAL_SWING, 9)
  })

  test('a backpedal runs the cycle in reverse (legSwing flips); forward has no lateral step', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0, MODEL_ARMS, 0, 0)
    const forward = out.legSwing
    expect(forward).toBeCloseTo(amp, 9)
    expect(out.legSide).toBe(0)
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0, MODEL_ARMS, 0, Math.PI)
    expect(out.legSwing).toBeCloseTo(-forward, 9)
    expect(out.legSide).toBeCloseTo(0, 9)
    // The free arm keeps swinging with the STRIDE, whatever its direction.
    expect(out.armSwing).not.toBeCloseTo(0, 3)
  })

  test('no lateral step while staggered or airborne', () => {
    const out = createArticulation()
    articulate(out, Math.PI / 2, 1, 0, true, true, 'tool', 0, MODEL_ARMS, 0, Math.PI / 2)
    expect(out.legSide).toBe(0)
    articulate(out, Math.PI / 2, 1, 0, false, false, 'tool', 0, MODEL_ARMS, 0, Math.PI / 2)
    expect(out.legSide).toBe(0)
  })

  test('the leg blend passes a full-speed stride: 1 s of a 17.5 rad/s swing reaches ≥ 95 % amplitude', () => {
    const live = createArticulation()
    const target = createArticulation()
    let peak = 0
    for (let i = 0; i < 60; i++) {
      const t = i / 60
      target.legSwing = Math.sin(GAIT_RATE_MAX * t) * amp
      blendArticulation(live, target, 1 / 60)
      if (t > 0.5) peak = Math.max(peak, Math.abs(live.legSwing))
    }
    expect(peak).toBeGreaterThanOrEqual(0.95 * amp)
    expect(BLEND_RATE.legs).toBeGreaterThanOrEqual(60)
  })

  test('applyArticulation writes legSide as rotation.z on BOTH hips, same sign (a shuffle, never a cross)', () => {
    const mk = () => ({ current: new Group() })
    const refs = {
      torso: mk(), head: mk(), armL: mk(), armR: mk(), legL: mk(), legR: mk(),
      headDetail: mk(), bodyDetail: mk(),
    }
    const a = createArticulation()
    a.legSide = 0.3
    applyArticulation(refs, a)
    expect(refs.legL.current.rotation.z).toBeCloseTo(0.3, 12)
    expect(refs.legR.current.rotation.z).toBeCloseTo(0.3, 12)
  })
})

/**
 * The motion layer: what the wire does not carry, derived from the drawn
 * position. These pin the four things a player notices — the gait paced by
 * DISPLAYED speed, a body that lags the aim without ever pointing the gun
 * wrong, a landing that squashes only on a real fall, a shot that kicks.
 */
describe('motion layer — displayed speed, body yaw, landing, recoil', () => {
  const DT = 1 / 60
  const prime = (yaw = 0) => {
    const m = createMotion()
    updateMotion(m, 0, 1.58, 0, yaw, true, false, 0, 'rifle', 0, DT)
    return m
  }

  test('updateMotion follows displacement, not wire s, and snaps to exactly 0 under 5 cm/s', () => {
    const m = prime()
    let z = 0
    let s = 0
    for (let i = 0; i < 60; i++) {
      z -= 6.5 * DT // running along −z (the facing at yaw 0)
      s = updateMotion(m, 0, 1.58, z, 0, true, false, 0, 'rifle', 0, DT)
    }
    expect(m.speedDisp).toBeCloseTo(6.5, 1)
    expect(s).toBeCloseTo(1, 1)
    expect(Math.abs(wrapAngle(m.moveRel))).toBeLessThan(0.05) // forward
    // The body stops dead (a frozen or stalled peer): the speed settles and snaps to 0.
    let settled = -1
    for (let i = 1; i <= 60; i++) {
      s = updateMotion(m, 0, 1.58, z, 0, true, false, 0, 'rifle', 0, DT)
      if (settled < 0 && m.speedDisp === 0) settled = i * DT
    }
    expect(settled).toBeGreaterThan(0)
    expect(settled).toBeLessThan(0.5)
    expect(s).toBe(0)
    expect(SPEED_DISP_ZERO).toBe(0.05)
    // The legs stop with it: below GAIT_MIN_S the gait settles.
    expect(6.5 * Math.exp(-14 * 0.2)).toBeLessThan(GAIT_MIN_S * RUN_SPEED_M_S) // within 200 ms of the stop
  })

  test('moveRel reads the displacement in the BODY frame: right strafe +π/2, backpedal π', () => {
    const strafe = prime()
    let x = 0
    for (let i = 0; i < 40; i++) {
      x += 3 * DT // +x is the body\'s right at yaw 0
      updateMotion(strafe, x, 1.58, 0, 0, true, false, 0, 'rifle', 0, DT)
    }
    expect(Math.abs(wrapAngle(strafe.moveRel - Math.PI / 2))).toBeLessThan(0.05)
    const back = prime()
    let z = 0
    for (let i = 0; i < 40; i++) {
      z += 3 * DT
      updateMotion(back, 0, 1.58, z, 0, true, false, 0, 'rifle', 0, DT)
    }
    expect(Math.abs(wrapAngle(back.moveRel - Math.PI))).toBeLessThan(0.05)
    // A teleport-sized step is not a speed sample.
    const tele = prime()
    updateMotion(tele, 40, 1.58, 0, 0, true, false, 0, 'rifle', 0, DT)
    expect(tele.speedDisp).toBe(0)
  })

  test('gun-points-at-aim invariant: bodyYaw + torso twist == viewYaw and |twist| ≤ torsoMax, standing and moving, under a random view walk', () => {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (const moving of [false, true]) {
      const m = prime(0.4)
      const live = createArticulation()
      const out = createArticulation()
      let view = 0.4
      let x = 0
      let maxTwist = 0
      for (let i = 0; i < 600; i++) {
        view += (rand() - 0.5) * 0.4 // up to ±0.2 rad per frame — a whip
        if (moving) x += 5 * DT
        updateMotion(m, x, 1.58, 0, view, true, false, 0, 'rifle', 0, DT)
        live.torsoYaw = (rand() - 0.5) * 0.1 // whatever the stride/idle gave
        layerMotion(out, live, m, view)
        const twist = out.torsoYaw - live.torsoYaw
        // The upper body carries EXACTLY the rest of the view yaw.
        expect(Math.abs(wrapAngle(m.bodyYaw + twist - view))).toBeLessThan(1e-9)
        maxTwist = Math.max(maxTwist, Math.abs(twist))
      }
      expect(maxTwist).toBeLessThanOrEqual(TURN.torsoMax + 1e-9)
      // The lean is bounded too.
      expect(Math.abs(out.torsoRoll - live.torsoRoll)).toBeLessThanOrEqual(TURN.leanMax + 1e-9)
    }
  })

  test('standing dead zone with hysteresis: 0.3 rad holds, 0.4 turns, the chase stops inside 0.1', () => {
    const m = prime(0)
    for (let i = 0; i < 60; i++) updateMotion(m, 0, 1.58, 0, 0.3, true, false, 0, 'rifle', 0, DT)
    expect(m.bodyYaw).toBe(0) // the head looked around; the feet stayed
    expect(m.turning).toBe(false)
    for (let i = 0; i < 60; i++) updateMotion(m, 0, 1.58, 0, 0.4, true, false, 0, 'rifle', 0, DT)
    expect(m.bodyYaw).toBeGreaterThan(0.25) // it followed …
    expect(Math.abs(wrapAngle(0.4 - m.bodyYaw))).toBeLessThanOrEqual(TURN.release + 1e-9) // … until inside the release
    expect(m.turning).toBe(false)
    const settled = m.bodyYaw
    for (let i = 0; i < 60; i++) updateMotion(m, 0, 1.58, 0, settled + 0.34, true, false, 0, 'rifle', 0, DT)
    expect(m.bodyYaw).toBe(settled) // 0.34 off: inside the dead zone again, holds
    // Moving, the body always follows, closely.
    let x = 0
    for (let i = 0; i < 90; i++) {
      x += 3 * DT
      updateMotion(m, x, 1.58, 0, settled + 0.34, true, false, 0, 'rifle', 0, DT)
    }
    expect(Math.abs(wrapAngle(settled + 0.34 - m.bodyYaw))).toBeLessThan(0.01)
    // A whip past the twist limit: the body snaps round at once, so the torso
    // is never asked to carry more than torsoMax — the aim stays honest.
    const before = m.bodyYaw
    const whip = before + 2.5
    updateMotion(m, x, 1.58, 0, whip, true, false, 0, 'rifle', 0, DT)
    expect(m.bodyYaw).not.toBe(before)
    expect(Math.abs(wrapAngle(whip - m.bodyYaw))).toBeLessThanOrEqual(TURN.torsoMax + 1e-9)
  })

  test('landing: a grounded edge after a −6 m/s fall squashes once and decays within squashS; a −1 m/s blip does nothing', () => {
    const m = prime()
    for (let i = 0; i < 5; i++) updateMotion(m, 0, 1.58 - i * 0.1, 0, 0, false, false, 0, 'rifle', -6, DT)
    expect(m.landT).toBe(0) // still in the air
    updateMotion(m, 0, 1.0, 0, 0, true, false, 0, 'rifle', -6, DT) // the landing bracket reads grounded
    expect(m.landT).toBeGreaterThan(0)
    expect(m.landPower).toBeCloseTo(6 / LAND.fullFall, 9)
    const live = createArticulation()
    const out = createArticulation()
    let peakKnee = 0
    let minBob = 0
    let frames = 0
    while (m.landT > 0 && frames < 60) {
      layerMotion(out, live, m, 0)
      peakKnee = Math.max(peakKnee, out.kneeL - live.kneeL)
      minBob = Math.min(minBob, out.bobY - live.bobY)
      expect(out.kneeR - live.kneeR).toBeCloseTo(out.kneeL - live.kneeL, 12) // both knees
      updateMotion(m, 0, 1.0, 0, 0, true, false, 0, 'rifle', 0, DT)
      frames++
    }
    expect(frames * DT).toBeLessThanOrEqual(LAND.squashS + DT + 1e-9)
    expect(peakKnee).toBeGreaterThan(0.2)
    expect(peakKnee).toBeLessThanOrEqual(LAND.knee * m.landPower + 1e-9)
    expect(minBob).toBeLessThan(-0.03)
    // Staying grounded never re-fires it.
    for (let i = 0; i < 30; i++) updateMotion(m, 0, 1.0, 0, 0, true, false, 0, 'rifle', 0, DT)
    expect(m.landT).toBe(0)
    // A stair-step blip: airborne for a frame at −1 m/s → nothing.
    updateMotion(m, 0, 1.0, 0, 0, false, false, 0, 'rifle', -1, DT)
    updateMotion(m, 0, 1.0, 0, 0, true, false, 0, 'rifle', -1, DT)
    expect(m.landT).toBe(0)
    expect(LAND.minFall).toBe(4) // == the local sfx.land threshold (player.tsx)
  })

  test('landing from the APEX: a plain jump whose 12 Hz slopes never reach −4 m/s still lands (√(2gh)); a 20 cm hop does not', () => {
    // A 5.4 m/s jump: apex 0.91 m. Sampled at 12 Hz the wire slopes average
    // the fall and the last bracket is truncated by the landing, so no slope
    // reads the true impact speed — but the drop from the apex does.
    const g = 16
    const v0 = 5.4
    const airtime = (2 * v0) / g
    const dtWire = 1 / 12
    // Whatever the frame phase relative to the takeoff, the landing registers.
    for (const phase of [0, 0.02, 0.04, 0.06, 0.08]) {
      const m = prime()
      let t = phase
      let prevY = 1.58
      let steepest = 0
      while (t + dtWire < airtime) {
        t += dtWire
        const y = 1.58 + v0 * t - 0.5 * g * t * t
        const slope = (y - prevY) / dtWire
        steepest = Math.min(steepest, slope)
        updateMotion(m, 0, y, 0, 0, false, false, 0, 'rifle', slope, dtWire)
        prevY = y
      }
      // The landing bracket: grounded, back at 1.58, a slope truncated by the landing.
      const last = (1.58 - prevY) / dtWire
      steepest = Math.min(steepest, last)
      updateMotion(m, 0, 1.58, 0, 0, true, false, 0, 'rifle', last, dtWire)
      expect(m.landT).toBeGreaterThan(0)
      expect(m.landPower).toBeGreaterThan(0.6)
      // …and the apex estimate is what carried it whenever the slopes fell short.
      if (-steepest < LAND.minFall) {
        expect(m.landPower).toBeCloseTo(Math.sqrt(2 * g * (m.airTopY - 1.58)) / LAND.fullFall, 6)
      }
    }
    // A 20 cm hop (stair top, a curb): apex speed 2.5 m/s — no squash.
    const hop = prime()
    updateMotion(hop, 0, 1.68, 0, 0, false, false, 0, 'rifle', 1, DT)
    updateMotion(hop, 0, 1.78, 0, 0, false, false, 0, 'rifle', 0, DT)
    updateMotion(hop, 0, 1.58, 0, 0, true, false, 0, 'rifle', -2, DT)
    expect(hop.landT).toBe(0)
  })

  test('recoil: one rifle shot kicks the gun arm by ≥ 0.05 rad, shares into torso and head, settles under 400 ms; a knife kicks nothing', () => {
    const m = prime()
    updateMotion(m, 0, 1.58, 0, 0, true, false, 1, 'rifle', 0, DT)
    expect(m.recoilX).toBeGreaterThanOrEqual(0.05)
    expect(m.recoilX).toBeLessThanOrEqual(AVATAR_RECOIL.rifle!)
    const live = createArticulation()
    const out = createArticulation()
    layerMotion(out, live, m, 0)
    expect(out.armAim - live.armAim).toBeCloseTo(m.recoilX, 12)
    expect(out.torsoPitch).toBeLessThan(live.torsoPitch) // the shoulder rocks back
    expect(out.headPitch).toBeGreaterThan(live.headPitch)
    let settled = -1
    for (let i = 1; i <= 60; i++) {
      updateMotion(m, 0, 1.58, 0, 0, true, false, 0, 'rifle', 0, DT)
      if (settled < 0 && Math.abs(m.recoilX) < 0.005) settled = i * DT
    }
    expect(settled).toBeGreaterThan(0)
    expect(settled).toBeLessThan(0.4)
    const knife = prime()
    updateMotion(knife, 0, 1.58, 0, 0, true, false, 2, 'knife', 0, DT)
    expect(knife.recoilX).toBe(0)
    // A burst stacks (bounded by shotsFired's cap upstream).
    const mg = prime()
    updateMotion(mg, 0, 1.58, 0, 0, true, false, 3, 'minigun', 0, DT)
    expect(mg.recoilX).toBeGreaterThan(AVATAR_RECOIL.minigun! * 2)
  })

  test('layerMotion is the identity at rest — the foot plant is articulate\'s, so it never drops a split it did not make', () => {
    const m = prime(0.3)
    const live = createArticulation()
    live.armAim = 0.7
    live.torsoYaw = 0.05
    live.headPitch = -0.2
    live.legSwing = 0.5 // a blended mid-stride: bobY already carries its plant
    live.legSide = 0.2
    live.bobY = -0.07
    const out = createArticulation()
    layerMotion(out, live, m, 0.3)
    for (const key of Object.keys(live) as Array<keyof typeof live>) {
      expect(out[key]).toBeCloseTo(live[key], 12)
    }
  })

  test('the foot plant lives in articulate: bobY drops L(1 − cos split) so EVERY consumer (peers, the depot mirror) stands on the ground', () => {
    // The geometry, once.
    expect(footPlantDrop({ legSwing: 0, legSide: 0 })).toBe(0)
    expect(footPlantDrop({ legSwing: 0.5, legSide: 0 })).toBeCloseTo(LEG_LEN_M * (1 - Math.cos(0.5)), 12)
    expect(footPlantDrop({ legSwing: 0, legSide: 0.4 })).toBeCloseTo(LEG_LEN_M * (1 - Math.cos(0.4)), 12)
    expect(footPlantDrop({ legSwing: 0.3, legSide: 0.4 })).toBeCloseTo(LEG_LEN_M * (1 - Math.cos(0.5)), 12)
    const out = createArticulation()
    // Stride extreme at a run (sin = 1): the hips are split by the cap, the
    // bob is 0 (cos = 0) and the root sits exactly the plant lower.
    articulate(out, Math.PI / 2, 1, 0, true, false, 'tool', 0, MODEL_ARMS, 0, 0)
    expect(out.legSwing).toBeCloseTo(LEG_SWING_MAX, 12)
    expect(out.bobY).toBeCloseTo(-LEG_LEN_M * (1 - Math.cos(LEG_SWING_MAX)), 9)
    expect(-out.bobY).toBeGreaterThan(0.1) // ~14.5 cm — the number the mirror used to float by
    // Mid-swing (legs passing): no split, only the stride bob remains.
    articulate(out, 0, 1, 0, true, false, 'tool', 0, MODEL_ARMS, 0, 0)
    expect(out.legSwing).toBeCloseTo(0, 12)
    expect(out.bobY).toBeCloseTo(0.04, 9)
    // A strafe splits the hips sideways: the same plant off legSide.
    articulate(out, Math.PI / 2, WALK_S, 0, true, false, 'tool', 0, MODEL_ARMS, 0, Math.PI / 2)
    expect(Math.abs(out.legSwing)).toBeLessThan(1e-9)
    expect(out.bobY).toBeCloseTo(-LEG_LEN_M * (1 - Math.cos(Math.abs(out.legSide))), 9)
    // Standing and airborne: nothing to plant.
    articulate(out, Math.PI / 2, 0, 0, true, false)
    expect(out.bobY).toBe(0)
    articulate(out, Math.PI / 2, 1, 0, false, false)
    expect(out.bobY).toBe(0)
  })

  test('FK: the straight (knee-0) leg\'s foot is within 5 cm of the ground across 64 phases × 3 speeds, exactly 0 at the stride extremes — with AND without the motion layer', () => {
    const m = prime(0)
    const art = createArticulation()
    const out = createArticulation()
    const footOf = (a: typeof art) => {
      // Whichever knee is straight, that leg hangs |legSwing| off vertical.
      const straight = a.kneeL <= 1e-9 || a.kneeR <= 1e-9
      expect(straight).toBe(true)
      return LEG_LEN_M + a.bobY - LEG_LEN_M * Math.cos(a.legSwing)
    }
    for (const s of [0.3, WALK_S, 1]) {
      for (let i = 0; i < 64; i++) {
        const phase = (i / 64) * Math.PI * 2
        articulate(art, phase, s, 0, true, false, 'tool', 0, MODEL_ARMS, 0, 0)
        layerMotion(out, art, m, 0)
        // The depot mirror's path (articulate only) and the peers' (layered): the same plant.
        for (const foot of [footOf(art), footOf(out)]) {
          expect(foot).toBeGreaterThanOrEqual(-1e-9)
          expect(foot).toBeLessThan(0.05)
          if (i === 16 || i === 48) expect(foot).toBeCloseTo(0, 9) // sin = ±1: both feet down, both legs straight
        }
      }
    }
  })

  test('avatarDebug returns plain copies (empty with nothing mounted) and rides presenceDebug().extra.avatars', () => {
    const a = avatarDebug()
    expect(a).toEqual({})
    expect(avatarDebug()).not.toBe(a)
    expect(presenceDebug().extra.avatars).toEqual({})
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
