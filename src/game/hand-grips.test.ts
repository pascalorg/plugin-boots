import { describe, expect, test } from 'bun:test'
import { Euler, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import * as feel from './feel'
import {
  armDirection,
  AVATAR_SKIN_HEX,
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
  recoilEnvelope,
  remoteKickFor,
  SWAY_COMPLIANCE,
  swayProfile,
  TRIGGER_HOLD,
  TRIGGER_PULL_RATE,
  TRIGGER_RELEASE_RATE,
  TRIGGER_TIME,
  triggerCurve,
  type WeaponHold,
  WRIST_JOINT,
} from './hand-grips'
import * as handPose from './hand-pose'
import { MODEL_ARMS, solveArm } from './remote-players'
import { ADS_POSES, POSES, type ToolId, type VmPose } from './viewmodel'

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

describe('motion curves — feel.ts is the one source', () => {
  test('recoil: RECOIL_TIME is FEEL.RECOIL_TIME and recoilEnvelope/recoilCurve ARE feel.recoilEnvelope', () => {
    expect(RECOIL_TIME).toBe(feel.FEEL.RECOIL_TIME)
    expect(recoilEnvelope).toBe(feel.recoilEnvelope)
    expect(recoilCurve).toBe(feel.recoilEnvelope)
    expect(recoilEnvelope(0)).toBe(1) // the kick reads on the shot frame
    expect(recoilEnvelope(1)).toBe(0)
    expect(recoilEnvelope(2)).toBe(0)
  })

  test('sway: swayProfile IS feel.swayProfile; the skin constant is the shared one', () => {
    expect(swayProfile).toBe(feel.swayProfile)
    expect(AVATAR_SKIN_HEX).toBe(handPose.AVATAR_SKIN_HEX)
    expect(SWAY_COMPLIANCE).toBeGreaterThan(0)
    expect(SWAY_COMPLIANCE).toBeLessThan(0.5) // the hand still follows the gun
  })

  test('triggerCurve: 1 on the shot frame and through TRIGGER_HOLD, a smooth monotone release to exactly 0 at TRIGGER_TIME', () => {
    expect(triggerCurve(0)).toBe(1)
    expect(triggerCurve(TRIGGER_HOLD / TRIGGER_TIME)).toBe(1)
    expect(triggerCurve(1)).toBe(0)
    expect(triggerCurve(2)).toBe(0)
    let prev = 1
    for (let t = 0; t <= 1; t += 0.01) {
      const v = triggerCurve(t)
      expect(v).toBeLessThanOrEqual(prev + 1e-12)
      expect(v).toBeGreaterThanOrEqual(0)
      prev = v
    }
    const mid = (TRIGGER_HOLD + (TRIGGER_TIME - TRIGGER_HOLD) / 2) / TRIGGER_TIME
    expect(triggerCurve(mid)).toBeCloseTo(0.5, 9)
    expect(TRIGGER_PULL_RATE).toBeGreaterThan(TRIGGER_RELEASE_RATE) // pulls snap, releases ease
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

/** Viewmodel POSES / ADS_POSES — the REAL exported tables (round 2). */
type Pose = VmPose

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

  test('the right WRIST (heel) is inside the frame at carry with room for the cuff, every weapon but the hammer', () => {
    // The heel is sample 1 (palm 0, heel 1, then the sleeve). The frame's
    // bottom edge is 46° down; the cuff (4 cm at ~0.35 m ≈ 6.5°) needs the
    // heel at ≤ 41° or it hangs under the frame — the round-1 look.
    const HEEL_MAX = Math.tan((41 * Math.PI) / 180)
    for (const w of WEAPONS) {
      if (w === 'hammer') continue // the lance carry: heels point down by design
      const pts: number[] = []
      handPartsInCamera(POSES[w].pos, POSES[w].rot, HAND_GRIPS[w], 'R', { recoilZ: 0, drawY: 0, drawPitch: 0, hamPitch: 0 }, pts)
      const [x, y, z] = [pts[3]!, pts[4]!, pts[5]!]
      expect(z).toBeLessThan(-0.2)
      expect(Math.abs(y) / -z, `${w} right heel y/z = ${(Math.abs(y) / -z).toFixed(3)}`).toBeLessThan(HEEL_MAX)
      expect(Math.abs(x) / -z, `${w} right heel x`).toBeLessThan(TAN_HALF * 1.6)
    }
  })

  test('the right sleeve heads screen-right and down on every one-handed and gun carry (toward the shoulder side)', () => {
    const d: [number, number, number] = [0, 0, 0]
    for (const w of WEAPONS) {
      if (w === 'hammer') continue
      armDirection(HAND_GRIPS[w].right.arm, d)
      expect(d[0], `${w} right arm heads +X`).toBeGreaterThan(0.2)
      expect(d[1], `${w} right arm heads down`).toBeLessThan(-0.2)
    }
    for (const w of ['pistol', 'rifle', 'minigun'] as ToolId[]) {
      armDirection(HAND_GRIPS[w].left!.arm, d)
      expect(d[0], `${w} left arm heads −X`).toBeLessThan(-0.2)
    }
  })

  test('the minigun support hand sits on the lower half of the front grip, under the drum (y < −0.045)', () => {
    const g = HAND_GRIPS.minigun.left!
    expect(g.position[1]).toBeLessThan(-0.045)
    expect(g.position[1]).toBeGreaterThan(-0.08) // still on the 0.11 m grip
  })
})
