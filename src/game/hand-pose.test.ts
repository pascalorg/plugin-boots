import { describe, expect, test } from 'bun:test'
import {
  AVATAR_SKIN_HEX,
  CUFF_HEX,
  FINGER_TAPER,
  FINGER_TIP,
  FINGERS,
  fingerSegmentTransforms,
  HAND_POSES,
  handBounds,
  type HandPoseId,
  indexChain,
  INDEX_SEGMENTS,
  KNUCKLE,
  KNUCKLE_BULGE,
  makeSegments,
  mirrorX,
  PALM,
  SEGMENT_COUNT,
  segmentEnd,
  SLEEVE_HEX,
  THUMB,
  THUMB_TAPER,
  THUMB_TIP,
  TRIGGER_CURL,
  TRIGGER_REST,
  WRIST,
} from './hand-pose'

/**
 * THE HAND'S ANATOMY, as numbers. A hand that renders is a hand whose fingers
 * end where a grip is: these pin the forward kinematics (fingertips around the
 * grip axis, never through the palm), the trigger finger out front, the mirror,
 * and — the one that bites — that the NESTED index chain the articulated
 * trigger finger mounts composes to the FLAT records the merged geometry uses.
 */

const POSES: HandPoseId[] = ['fist', 'trigger', 'wrap', 'can']
const end: [number, number, number] = [0, 0, 0]

function tips(pose: HandPoseId): [number, number, number][] {
  const segs = fingerSegmentTransforms(HAND_POSES[pose], makeSegments())
  const out: [number, number, number][] = []
  for (let f = 0; f < 4; f++) {
    const distal = segs[f * 3 + 2]!
    segmentEnd(distal, end)
    out.push([end[0], end[1], end[2]])
  }
  return out
}
const radial = (p: readonly [number, number, number]) => Math.hypot(p[0], p[2])

describe('fingerSegmentTransforms', () => {
  test('every pose yields 14 finite segments with positive lengths and radii', () => {
    for (const pose of POSES) {
      const segs = fingerSegmentTransforms(HAND_POSES[pose], makeSegments())
      expect(segs.length).toBe(SEGMENT_COUNT)
      for (const s of segs) {
        for (const v of [s.px, s.py, s.pz, s.rx, s.ry, s.rz, s.len, s.r, s.r1, s.joint, s.tip]) expect(Number.isFinite(v)).toBe(true)
        expect(s.len).toBeGreaterThan(0)
        expect(s.r).toBeGreaterThan(0)
      }
    }
  })

  test('PROFILE: each chain is one cone — r ≥ r1, continuous across joints, a knuckle bulge only at the first joint, a tip only at the last', () => {
    const segs = fingerSegmentTransforms(HAND_POSES.fist, makeSegments())
    const chains = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
      [12, 13],
    ]
    for (const chain of chains) {
      for (let i = 0; i < chain.length; i++) {
        const s = segs[chain[i]!]!
        expect(s.r1).toBeLessThan(s.r) // tapers
        expect(s.r1).toBeGreaterThan(0)
        if (i === 0) expect(s.joint).toBeCloseTo(s.r * KNUCKLE_BULGE, 12)
        else {
          expect(s.joint).toBeCloseTo(s.r, 12)
          expect(s.r).toBeCloseTo(segs[chain[i - 1]!]!.r1, 12) // continuous
        }
        if (i === chain.length - 1) expect(s.tip).toBeCloseTo(s.r1, 12)
        else expect(s.tip).toBe(0)
      }
    }
    expect(FINGER_TAPER[0]).toBe(1)
    expect(FINGER_TAPER[1]).toBeLessThan(FINGER_TAPER[0])
    expect(FINGER_TAPER[2]).toBeLessThan(FINGER_TAPER[1])
    expect(FINGER_TIP).toBeLessThan(FINGER_TAPER[2])
    expect(THUMB_TIP).toBeLessThan(THUMB_TAPER[1])
    expect(KNUCKLE_BULGE).toBeGreaterThan(1)
    expect(KNUCKLE_BULGE).toBeLessThan(1.25) // a ridge, not a bead
  })

  test('fingers are slim: every radius ≤ 8.5 mm, neighbours leave a gap at the knuckles, the wrist is an ellipse', () => {
    for (const f of FINGERS) {
      expect(f.r).toBeLessThanOrEqual(0.0085)
      expect(f.r).toBeGreaterThan(0.005)
    }
    expect(THUMB.r).toBeLessThanOrEqual(0.0095)
    for (let i = 1; i < FINGERS.length; i++) {
      const a = FINGERS[i - 1]!
      const b = FINGERS[i]!
      const gap = a.y - b.y - a.r * KNUCKLE_BULGE - b.r * KNUCKLE_BULGE
      expect(gap, `${a.name}/${b.name} knuckle gap`).toBeGreaterThan(0.0005)
    }
    expect(WRIST.sx).toBeGreaterThan(0.5)
    expect(WRIST.sx).toBeLessThan(0.8)
  })

  test('chains are continuous: each segment starts where the previous one ended', () => {
    const segs = fingerSegmentTransforms(HAND_POSES.fist, makeSegments())
    const chains = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
      [12, 13],
    ]
    for (const chain of chains) {
      for (let i = 1; i < chain.length; i++) {
        const prev = segs[chain[i - 1]!]!
        const cur = segs[chain[i]!]!
        segmentEnd(prev, end)
        expect(cur.px).toBeCloseTo(end[0], 12)
        expect(cur.py).toBeCloseTo(end[1], 12)
        expect(cur.pz).toBeCloseTo(end[2], 12)
      }
    }
  })

  test('fingers root at the knuckle line and the thumb at its root', () => {
    const segs = fingerSegmentTransforms(HAND_POSES.wrap, makeSegments())
    for (let f = 0; f < 4; f++) {
      const k = segs[f * 3]!
      expect(k.px).toBe(KNUCKLE.x)
      expect(k.pz).toBe(KNUCKLE.z)
      expect(k.py).toBe(FINGERS[f]!.y)
    }
    const t0 = segs[12]!
    expect([t0.px, t0.py, t0.pz]).toEqual([...THUMB.root])
  })

  test("'fist' fingertips close around the grip axis, never through the palm", () => {
    for (const tip of tips('fist')) {
      expect(radial(tip)).toBeLessThan(0.045)
      expect(tip[0]).toBeLessThan(PALM.x) // stays on the grip side of the palm's inner face
      expect(tip[0]).toBeLessThan(0) // and actually crossed to the far side of the grip
    }
  })

  test("'wrap' sits looser (≤ 5.8 cm) and 'can' looser still (≤ 7.5 cm)", () => {
    for (const tip of tips('wrap')) expect(radial(tip)).toBeLessThan(0.058)
    for (const tip of tips('can')) expect(radial(tip)).toBeLessThan(0.075)
    // and the order holds: a can is a bigger thing than a haft than a grip
    const mean = (pose: HandPoseId) => tips(pose).reduce((a, t) => a + radial(t), 0) / 4
    expect(mean('fist')).toBeLessThan(mean('wrap'))
    expect(mean('wrap')).toBeLessThan(mean('can'))
  })

  test("'trigger' puts the index forward on the trigger and keeps the other three closed", () => {
    const [index, ...rest] = tips('trigger')
    expect(index![2]).toBeLessThan(-0.06) // well past the palm's front edge
    // The pad lands near the grip's centre line (x≈0) where a trigger blade hangs.
    expect(Math.abs(index![0])).toBeLessThan(0.04)
    for (const tip of rest) expect(radial(tip)).toBeLessThan(0.045)
  })

  test('the thumb crosses the back of the grip and ends on its far side', () => {
    const segs = fingerSegmentTransforms(HAND_POSES.fist, makeSegments())
    const t0 = segs[12]!
    segmentEnd(t0, end)
    expect(end[0]).toBeLessThan(THUMB.root[0]) // heads −X
    expect(end[2]).toBeGreaterThan(0.02) // behind the grip's back face
    segmentEnd(segs[13]!, end)
    expect(end[0]).toBeLessThan(-0.02) // ends on the far (left) side
    expect(Math.abs(end[2])).toBeLessThan(0.035) // hooked forward, level with the grip
  })
})

describe('indexChain', () => {
  test('nested local joints compose to the flat accumulated index records (1e-9)', () => {
    for (const pose of POSES) {
      const flat = fingerSegmentTransforms(HAND_POSES[pose], makeSegments())
      const [j0, j1, j2] = indexChain(HAND_POSES[pose])
      // Compose: world_i = world_{i-1} ∘ local_i, with rotations Rx(spread)·Ry(sum curl).
      let px = j0.px
      let py = j0.py
      let pz = j0.pz
      let ry = j0.ry
      const locals = [j0, j1, j2]
      for (let i = 0; i < 3; i++) {
        const acc = flat[INDEX_SEGMENTS[i]!]!
        expect(acc.px).toBeCloseTo(px, 9)
        expect(acc.py).toBeCloseTo(py, 9)
        expect(acc.pz).toBeCloseTo(pz, 9)
        expect(acc.rx).toBeCloseTo(j0.rx, 9)
        expect(acc.ry).toBeCloseTo(ry, 9)
        expect(acc.len).toBe(locals[i]!.len)
        expect(acc.r).toBeCloseTo(locals[i]!.r, 12)
        expect(acc.r1).toBeCloseTo(locals[i]!.r1, 12)
        expect(acc.joint).toBeCloseTo(locals[i]!.joint, 12)
        expect(acc.tip).toBeCloseTo(locals[i]!.tip, 12)
        // next joint origin: this joint's origin + local (0,0,-len) rotated by the accumulated Euler
        const cy = Math.cos(ry)
        const dx = -Math.sin(ry)
        const dy = Math.sin(j0.rx) * cy
        const dz = -Math.cos(j0.rx) * cy
        const len = locals[i]!.len
        px += dx * len
        py += dy * len
        pz += dz * len
        if (i < 2) {
          const next = locals[i + 1]!
          expect(next.pz).toBe(-len)
          expect(next.px).toBe(0)
          expect(next.py).toBe(0)
          ry += next.ry
        }
      }
    }
  })

  test('TRIGGER_REST is the trigger pose index; TRIGGER_CURL squeezes every joint further', () => {
    expect(TRIGGER_REST).toEqual(HAND_POSES.trigger.index)
    for (let i = 0; i < 3; i++) expect(TRIGGER_CURL[i]!).toBeGreaterThan(TRIGGER_REST[i]!)
    // a pull, not a fist: the pad travels ~1 cm
    const seg = (curl: readonly [number, number, number]) => {
      const segs = fingerSegmentTransforms({ ...HAND_POSES.trigger, index: curl }, makeSegments())
      return segmentEnd(segs[2]!, [0, 0, 0])
    }
    const rest = seg(TRIGGER_REST)
    const pulled = seg(TRIGGER_CURL)
    const travel = Math.hypot(pulled[0] - rest[0], pulled[1] - rest[1], pulled[2] - rest[2])
    expect(travel).toBeGreaterThan(0.006)
    expect(travel).toBeLessThan(0.03)
    expect(pulled[2]).toBeGreaterThan(rest[2]) // the pad comes back toward the palm
  })
})

describe('mirrorX', () => {
  test('negates x and the yaw/roll, keeps |y| and |z| of every segment end', () => {
    const right = fingerSegmentTransforms(HAND_POSES.fist, makeSegments())
    const left = fingerSegmentTransforms(HAND_POSES.fist, makeSegments()).map(mirrorX)
    const re: [number, number, number] = [0, 0, 0]
    const le: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      expect(left[i]!.px).toBeCloseTo(-right[i]!.px, 12)
      expect(left[i]!.py).toBe(right[i]!.py)
      expect(left[i]!.pz).toBe(right[i]!.pz)
      segmentEnd(right[i]!, re)
      segmentEnd(left[i]!, le)
      expect(le[0]).toBeCloseTo(-re[0], 12)
      expect(le[1]).toBeCloseTo(re[1], 12)
      expect(le[2]).toBeCloseTo(re[2], 12)
    }
  })
})

describe('handBounds', () => {
  test("a fist fits in 11 cm on every axis; the wrist only adds behind the palm", () => {
    for (const pose of POSES) {
      const b = handBounds(pose === 'trigger' ? HAND_POSES.trigger : HAND_POSES[pose])
      for (let a = 0; a < 3; a++) {
        expect(b.max[a]! - b.min[a]!).toBeLessThanOrEqual(0.14)
      }
    }
    const fist = handBounds(HAND_POSES.fist)
    expect(fist.max[0]! - fist.min[0]!).toBeLessThanOrEqual(0.11)
    expect(fist.max[1]! - fist.min[1]!).toBeLessThanOrEqual(0.11)
    expect(fist.max[2]! - fist.min[2]!).toBeLessThanOrEqual(0.11)
    const withWrist = handBounds(HAND_POSES.fist, true)
    expect(withWrist.max[2]).toBeGreaterThan(fist.max[2]!)
    expect(withWrist.min[2]).toBe(fist.min[2])
  })
})

describe('colours', () => {
  test('skin, sleeve and cuff are 6-digit hex; the cuff is lighter than the sleeve', () => {
    expect(AVATAR_SKIN_HEX).toMatch(/^#[0-9a-f]{6}$/)
    expect(SLEEVE_HEX).toMatch(/^#[0-9a-f]{6}$/)
    expect(CUFF_HEX).toMatch(/^#[0-9a-f]{6}$/)
    const lum = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16) + Number.parseInt(hex.slice(5, 7), 16)
    expect(lum(CUFF_HEX)).toBeGreaterThan(lum(SLEEVE_HEX) + 60)
  })
})
