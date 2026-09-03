import { describe, expect, test } from 'bun:test'
import { Euler, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import {
  armDirection,
  bobProfile,
  FALLBACK_HOLD,
  gripQuaternion,
  gripToShoulder,
  HAND_GRIPS,
  handLimbDir,
  handPartsInCamera,
  heelPoint,
  holdFor,
  LEFT_IN_HAND,
  leftGripFor,
  readyBob,
  RECOIL_TIME,
  recoilCurve,
  remoteKickFor,
  TRIGGER_TIME,
  triggerCurve,
  type WeaponHold,
  WRIST_JOINT,
} from './hand-grips'
import { MODEL_ARMS, solveArm } from './remote-players'
import type { ToolId } from './viewmodel'
import * as viewmodel from './viewmodel'

/**
 * THE GRIP CONTRACT. `gripQuaternion` must be a proper rotation that puts the
 * hand's +Y along `up` and the palm normal along `palm` (otherwise a hand faces
 * away from its own grip); every hand origin must sit on its weapon's grip
 * LINE (weapon-models numbers, restated here so a model edit fails a test
 * instead of floating a hand); `gripToShoulder` must equal a real three FK
 * chain; and every first-person part must stay clear of the near plane
 * wherever it is inside the view cone.
 */

const WEAPONS = Object.keys(HAND_GRIPS) as ToolId[]
const v = (x: number, y: number, z: number) => new Vector3(x, y, z)

describe('gripQuaternion', () => {
  test('is a proper right-handed basis mapping (0,1,0) → up and the palm normal → palm, every hold and side', () => {
    const q = new Quaternion()
    const m = new Matrix4()
    for (const w of WEAPONS) {
      const hold = HAND_GRIPS[w]
      for (const [g, side] of [
        [hold.right, 'R'],
        [hold.left, 'L'],
      ] as const) {
        if (!g) continue
        gripQuaternion(g, side, q)
        m.makeRotationFromQuaternion(q)
        expect(m.determinant()).toBeCloseTo(1, 9)
        const up = v(0, 1, 0).applyQuaternion(q)
        const upWant = v(g.up[0], g.up[1], g.up[2]).normalize()
        expect(up.distanceTo(upWant)).toBeLessThan(1e-9)
        // right palm faces −X in the hand frame, left palm +X
        const palmNormal = v(side === 'R' ? -1 : 1, 0, 0).applyQuaternion(q)
        const palmWant = v(g.palm[0], g.palm[1], g.palm[2])
        palmWant.addScaledVector(upWant, -palmWant.dot(upWant)).normalize()
        expect(palmNormal.distanceTo(palmWant)).toBeLessThan(1e-9)
      }
    }
  })

  test('heelPoint is WRIST_JOINT along the rotated +Z from the palm origin', () => {
    const q = new Quaternion()
    const heel: [number, number, number] = [0, 0, 0]
    for (const w of WEAPONS) {
      const g = HAND_GRIPS[w].right
      gripQuaternion(g, 'R', q)
      const want = v(0, 0, WRIST_JOINT).applyQuaternion(q).add(v(...g.position))
      heelPoint(g, 'R', heel)
      expect(v(...heel).distanceTo(want)).toBeLessThan(1e-12)
    }
  })

  test('armDirection is Rx(pitch)·Ry(yaw)·(0,0,1): +pitch heads down, +yaw heads +X', () => {
    const d: [number, number, number] = [0, 0, 0]
    armDirection({ pitch: 0, yaw: 0 }, d)
    expect(d).toEqual([0, -0, 1])
    armDirection({ pitch: 0.5, yaw: 0 }, d)
    expect(d[1]).toBeLessThan(0)
    armDirection({ pitch: 0, yaw: 0.5 }, d)
    expect(d[0]).toBeGreaterThan(0)
    const e = new Euler(0.7, -0.3, 0, 'XYZ')
    const want = v(0, 0, 1).applyEuler(e)
    armDirection({ pitch: 0.7, yaw: -0.3 }, d)
    expect(v(...d).distanceTo(want)).toBeLessThan(1e-12)
  })
})

/** Grip LINES from weapon-models.tsx: a point and the axis direction. */
type Line = { p: [number, number, number]; d: Vector3 }
const rakedY = (a: number) => v(0, 1, 0).applyEuler(new Euler(a, 0, 0))
const GRIP_LINES: Record<ToolId, { right: Line; left: Line | null }> = {
  pistol: { right: { p: [0, -0.05, 0.03], d: rakedY(0.32) }, left: null }, // left cups the right hand, not the grip
  rifle: { right: { p: [0, -0.045, 0.015], d: rakedY(0.34) }, left: null },
  minigun: { right: { p: [0, -0.05, 0.02], d: rakedY(0.34) }, left: { p: [0, -0.04, -0.2], d: rakedY(-0.12) } },
  knife: { right: { p: [0, -0.014, 0.052], d: v(0, 0, 1).applyEuler(new Euler(0.12, 0, 0)) }, left: null },
  hammer: { right: { p: [0, 0, 0], d: v(0, 1, 0) }, left: { p: [0, 0, 0], d: v(0, 1, 0) } },
  builder: { right: { p: [0, 0, 0], d: v(0, 1, 0) }, left: null },
  paint: { right: { p: [0, 0, 0], d: v(0, 1, 0) }, left: null },
}
const distToLine = (p: readonly [number, number, number], line: Line): number => {
  const rel = v(p[0] - line.p[0], p[1] - line.p[1], p[2] - line.p[2])
  const along = rel.dot(line.d)
  return rel.addScaledVector(line.d, -along).length()
}

describe('HAND_GRIPS placement', () => {
  test('every hand origin lies within 3 cm of its grip line and `up` within 25° of it', () => {
    const cos25 = Math.cos((25 * Math.PI) / 180)
    for (const w of WEAPONS) {
      const hold = HAND_GRIPS[w]
      const lines = GRIP_LINES[w]
      const check = (g: NonNullable<WeaponHold['left']>, line: Line, label: string) => {
        const dist = distToLine(g.position, line)
        expect(dist, `${label} origin off the grip line by ${dist.toFixed(3)} m`).toBeLessThan(0.03)
        const up = v(...g.up).normalize()
        expect(Math.abs(up.dot(line.d)), `${label} up vs grip axis`).toBeGreaterThan(cos25)
      }
      check(hold.right, lines.right, `${w} right`)
      if (hold.left && lines.left) check(hold.left, lines.left, `${w} left`)
    }
    // The pistol's support hand cups the right hand's fingers, off the line by design:
    // still close (≤ 4 cm) and on the LEFT of the grip.
    const pl = HAND_GRIPS.pistol.left!
    expect(distToLine(pl.position, GRIP_LINES.pistol.right)).toBeLessThan(0.04)
    expect(pl.position[0]).toBeLessThan(0)
  })

  test('the rifle support hand cups the handguard from below, palm up, under the wood', () => {
    const g = HAND_GRIPS.rifle.left!
    expect(g.palm[1]).toBeGreaterThan(0.9)
    // handguard: centre (0, 0.046, −0.32), 0.048 × 0.056 × 0.2 — the LEFT palm's
    // inner face is at hand x = −0.014, and the left hand's +X is the palm
    // direction (+Y here), so the face sits 0.014 BELOW the origin: it must
    // meet the wood's underside (y 0.018) within 1 cm
    expect(g.position[2]).toBeGreaterThan(-0.42)
    expect(g.position[2]).toBeLessThan(-0.22)
    expect(Math.abs(g.position[1] - 0.014 - 0.018)).toBeLessThan(0.01)
  })

  test('palms face the grip: right hands press from +X, left hands from −X (or below)', () => {
    for (const w of WEAPONS) {
      const hold = HAND_GRIPS[w]
      // the palm normal points from the hand toward the grip → the hand sits on
      // the opposite side of the grip line from where its palm points
      const r = hold.right
      const rLine = GRIP_LINES[w].right
      const toLine = v(rLine.p[0] - r.position[0], rLine.p[1] - r.position[1], rLine.p[2] - r.position[2])
      const along = toLine.dot(rLine.d)
      toLine.addScaledVector(rLine.d, -along)
      // (a hand ON the axis — most grips — has no side to face; the roll is taste)
      if (toLine.length() > 0.01) expect(toLine.normalize().dot(v(...r.palm)), `${w} right palm`).toBeGreaterThan(0.5)
    }
    expect(HAND_GRIPS.pistol.left!.palm[0]).toBeGreaterThan(0)
    expect(HAND_GRIPS.minigun.left!.palm[0]).toBeGreaterThan(0)
  })

  test('holdFor / leftGripFor: unknown wire ids get the fallback, known ones the table', () => {
    expect(holdFor('zzz')).toBe(FALLBACK_HOLD)
    expect(holdFor('')).toBe(FALLBACK_HOLD)
    expect(holdFor('rifle')).toBe(HAND_GRIPS.rifle)
    expect(leftGripFor('zzz')).toBeNull()
    expect(leftGripFor('knife')).toBeNull()
    const lr = leftGripFor('rifle')!
    const r = HAND_GRIPS.rifle.right.position
    const l = HAND_GRIPS.rifle.left!.position
    expect(lr).toEqual([l[0] - r[0], l[1] - r[1], l[2] - r[2]])
    expect(LEFT_IN_HAND.hammer).not.toBeNull()
    expect(FALLBACK_HOLD.left).toBeNull()
    expect(FALLBACK_HOLD.trigger).toBe(false)
  })

  test('guns have a trigger, tools do not', () => {
    expect(HAND_GRIPS.pistol.trigger).toBe(true)
    expect(HAND_GRIPS.rifle.trigger).toBe(true)
    expect(HAND_GRIPS.minigun.trigger).toBe(true)
    for (const w of ['knife', 'hammer', 'builder', 'paint'] as ToolId[]) expect(HAND_GRIPS[w].trigger).toBe(false)
    for (const w of WEAPONS) if (HAND_GRIPS[w].trigger) expect(HAND_GRIPS[w].right.pose).toBe('trigger')
  })
})

describe('gripToShoulder', () => {
  test('equals a real three FK chain (armR YXZ → elbow → weapon Rx(−π/2+tilt) → point) within 1e-6', () => {
    const arms = MODEL_ARMS
    const holds: [ToolId, readonly [number, number, number]][] = [
      ['rifle', [0.14, -0.1, 0.18]],
      ['pistol', [0.14, -0.02, 0.36]],
      ['minigun', [0.14, -0.1, 0.18]],
    ]
    for (const [w, hand] of holds) {
      const p = leftGripFor(w)!
      for (const pitch of [-0.4, 0, 0.5]) {
        // rightHandTarget (remote-players): [-inward, fwd·sin + up·cos, -(fwd·cos - up·sin)]
        const [inward, up, fwd] = hand
        const target: [number, number, number] = [
          -inward,
          fwd * Math.sin(pitch) + up * Math.cos(pitch),
          -(fwd * Math.cos(pitch) - up * Math.sin(pitch)),
        ]
        const right = solveArm(target, arms)
        const barrel = Math.PI / 2 + pitch
        const tilt = barrel - (right.swing + right.elbow)

        const armR = new Group()
        armR.rotation.order = 'YXZ'
        armR.rotation.y = right.yaw
        armR.rotation.x = right.swing
        const elbow = new Group()
        elbow.position.set(0, -arms.upperArmLen, 0)
        elbow.rotation.x = right.elbow
        armR.add(elbow)
        const weapon = new Group()
        weapon.position.set(0, -arms.reach, 0.02)
        weapon.rotation.x = -Math.PI / 2 + tilt
        elbow.add(weapon)
        const point = new Object3D()
        point.position.set(p[0], p[1], p[2])
        weapon.add(point)
        armR.updateMatrixWorld(true)
        const want = point.getWorldPosition(new Vector3())
        want.x += 2 * arms.shoulderX

        const got: [number, number, number] = [0, 0, 0]
        gripToShoulder(p, right, barrel, arms.shoulderX, got)
        expect(v(...got).distanceTo(want), `${w} pitch ${pitch}`).toBeLessThan(1e-6)
      }
    }
  })

  test('handLimbDir matches the limb convention (hanging = −Y, swung forward = −Z)', () => {
    expect(handLimbDir(0, 0)).toEqual([-0, -1, -0])
    const f = handLimbDir(Math.PI / 2, 0)
    expect(f[2]).toBeCloseTo(-1, 12)
    expect(f[1]).toBeCloseTo(0, 12)
  })
})

describe('motion curves', () => {
  test('recoilCurve: 0.55 on the shot frame, 1 at the peak, ~0 at the end, decaying envelope', () => {
    expect(recoilCurve(0)).toBeCloseTo(0.55, 12)
    expect(recoilCurve(0.1)).toBeCloseTo(1, 12)
    expect(Math.abs(recoilCurve(1))).toBeLessThan(0.01)
    let prevEnv = Number.POSITIVE_INFINITY
    let overshoot = 0
    for (let t = 0.1; t <= 1; t += 0.01) {
      const u = (t - 0.1) / 0.9
      const env = Math.exp(-6 * u)
      expect(Math.abs(recoilCurve(t))).toBeLessThanOrEqual(env + 1e-12)
      expect(env).toBeLessThanOrEqual(prevEnv)
      prevEnv = env
      overshoot = Math.min(overshoot, recoilCurve(t))
    }
    expect(overshoot).toBeLessThan(-0.03) // a real return past centre …
    expect(overshoot).toBeGreaterThan(-0.12) // … but not a second kick
    expect(RECOIL_TIME).toBeGreaterThan(0.1)
  })

  test('triggerCurve: 0 → 1 at 0.04 s → 0 at TRIGGER_TIME (normalised input)', () => {
    expect(triggerCurve(0)).toBe(0)
    expect(triggerCurve(0.04 / TRIGGER_TIME)).toBeCloseTo(1, 9)
    expect(triggerCurve(1)).toBeCloseTo(0, 9)
    expect(triggerCurve(2)).toBe(0)
    expect(triggerCurve(0.02 / TRIGGER_TIME)).toBeCloseTo(0.5, 9)
  })

  test('bobProfile: zero at rest, monotone non-decreasing, amp ≤ 0.03, run > walk', () => {
    const o = { amp: 0, lateral: 0, roll: 0 }
    bobProfile(0, o)
    expect(o).toEqual({ amp: 0, lateral: 0, roll: 0 })
    let prev = { amp: 0, lateral: 0, roll: 0 }
    for (let s = 0; s <= 1.0001; s += 0.02) {
      bobProfile(s, o)
      expect(o.amp).toBeGreaterThanOrEqual(prev.amp)
      expect(o.lateral).toBeGreaterThanOrEqual(prev.lateral)
      expect(o.roll).toBeGreaterThanOrEqual(prev.roll)
      expect(o.amp).toBeLessThanOrEqual(0.03)
      prev = { ...o }
    }
    const walk = bobProfile(0.46, { amp: 0, lateral: 0, roll: 0 })
    const run = bobProfile(1, { amp: 0, lateral: 0, roll: 0 })
    expect(run.amp).toBeGreaterThan(walk.amp * 1.5)
    expect(run.amp).toBeCloseTo(0.022, 6)
  })

  test('readyBob is a single dip; remoteKickFor is bounded with minigun < pistol', () => {
    expect(readyBob(0)).toBeCloseTo(0, 12)
    expect(readyBob(0.5)).toBeCloseTo(0.03, 12)
    expect(readyBob(1)).toBeCloseTo(0, 12)
    expect(readyBob(3)).toBeCloseTo(0, 12)
    for (const w of ['rifle', 'pistol', 'minigun', 'zzz']) {
      expect(remoteKickFor(w)).toBeGreaterThan(0)
      expect(remoteKickFor(w)).toBeLessThan(0.2)
    }
    expect(remoteKickFor('minigun')).toBeLessThan(remoteKickFor('pistol'))
  })
})

/**
 * Viewmodel POSES / ADS_POSES. Bound to the real export when viewmodel.tsx
 * exports them (feel lane, round 2); until then this copy of its table keeps
 * the near-plane test honest — update it if the poses move.
 */
type Pose = { pos: [number, number, number]; rot: [number, number, number] }
const POSES_COPY: Record<ToolId, Pose> = {
  knife: { pos: [0.3, -0.3, -0.42], rot: [0.05, -0.24, 0.12] },
  pistol: { pos: [0.3, -0.28, -0.45], rot: [0, -0.07, 0.03] },
  rifle: { pos: [0.33, -0.3, -0.5], rot: [0.01, -0.09, 0.04] },
  minigun: { pos: [0.22, -0.36, -0.56], rot: [0.01, -0.05, 0.02] },
  hammer: { pos: [0.3, -0.42, -0.42], rot: [-1.25, -0.16, 0.1] },
  builder: { pos: [0.32, -0.33, -0.46], rot: [0.07, -0.28, 0.14] },
  paint: { pos: [0.28, -0.3, -0.4], rot: [0.12, -0.3, 0.1] },
}
const ADS_COPY: Partial<Record<ToolId, Pose>> = {
  pistol: { pos: [0, -0.21, -0.38], rot: [0, 0, 0] },
  rifle: { pos: [0, -0.235, -0.44], rot: [0, 0, 0] },
}
const vm = viewmodel as unknown as { POSES?: Record<ToolId, Pose>; ADS_POSES?: Partial<Record<ToolId, Pose>> }
const POSES = vm.POSES ?? POSES_COPY
const ADS_POSES = vm.ADS_POSES ?? ADS_COPY

describe('near plane (frustum-aware)', () => {
  const NEAR = 0.1
  const TAN_HALF = Math.tan((46 * Math.PI) / 180) // fov 92 vertical
  const ASPECT = 2.4 // conservative
  const outsideCone = (x: number, y: number, z: number) => {
    const h = -z * TAN_HALF
    return Math.abs(y) > h || Math.abs(x) > h * ASPECT
  }
  const okPoint = (x: number, y: number, z: number) => z <= -NEAR || outsideCone(x, y, z)

  test('every first-person hand part is behind the near plane wherever it is inside the view cone', () => {
    const cases: { w: ToolId; pose: Pose; extra: Parameters<typeof handPartsInCamera>[4]; label: string }[] = []
    for (const w of WEAPONS) {
      const carry = POSES[w]
      cases.push({ w, pose: carry, extra: { recoilZ: 0, drawY: 0, drawPitch: 0, hamPitch: 0 }, label: `${w} carry` })
      cases.push({ w, pose: carry, extra: { recoilZ: 0.07, drawY: 0, drawPitch: 0, hamPitch: 0 }, label: `${w} recoil` })
      cases.push({ w, pose: carry, extra: { recoilZ: 0, drawY: -0.24, drawPitch: -0.55, hamPitch: 0 }, label: `${w} draw` })
      const ads = ADS_POSES[w]
      if (ads) {
        cases.push({ w, pose: ads, extra: { recoilZ: 0, drawY: 0, drawPitch: 0, hamPitch: 0 }, label: `${w} ads` })
        cases.push({ w, pose: ads, extra: { recoilZ: 0.07, drawY: 0, drawPitch: 0, hamPitch: 0 }, label: `${w} ads recoil` })
      }
      if (w === 'hammer') {
        cases.push({ w, pose: carry, extra: { recoilZ: 0.05, drawY: 0.06, drawPitch: 0, hamPitch: 0.9 }, label: 'hammer raise' })
        cases.push({ w, pose: carry, extra: { recoilZ: -0.12, drawY: -0.2, drawPitch: 0, hamPitch: -0.65 }, label: 'hammer strike' })
      }
    }
    for (const c of cases) {
      for (const side of ['R', 'L'] as const) {
        const pts: number[] = []
        handPartsInCamera(c.pose.pos, c.pose.rot, HAND_GRIPS[c.w], side, c.extra, pts)
        if (side === 'L' && !HAND_GRIPS[c.w].left) {
          expect(pts.length).toBe(0)
          continue
        }
        expect(pts.length).toBeGreaterThan(0)
        for (let i = 0; i < pts.length; i += 3) {
          const x = pts[i]!
          const y = pts[i + 1]!
          const z = pts[i + 2]!
          expect(okPoint(x, y, z), `${c.label} ${side} sample ${i / 3} at (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})`).toBe(true)
        }
      }
    }
  })

  test('the hand origins themselves sit inside the frame at carry (something to look at)', () => {
    for (const w of WEAPONS) {
      const pts: number[] = []
      handPartsInCamera(POSES[w].pos, POSES[w].rot, HAND_GRIPS[w], 'R', { recoilZ: 0, drawY: 0, drawPitch: 0, hamPitch: 0 }, pts)
      const [x, y, z] = [pts[0]!, pts[1]!, pts[2]!]
      expect(z).toBeLessThan(-0.25)
      expect(Math.abs(y) / -z, `${w} right palm y`).toBeLessThan(TAN_HALF * 1.05)
      expect(Math.abs(x) / -z, `${w} right palm x`).toBeLessThan(TAN_HALF * 1.8)
    }
  })
})
