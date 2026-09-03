import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { FEEL, recoilEnvelope, swayProfile } from './feel'
import { type HandPoseId, WRIST } from './hand-pose'
import type { ToolId } from './viewmodel'

/** The one skin / sleeve pair, re-exported so a rig that only knows the grip
 * table (the avatar's HeldWeapon) can colour its hands to match. */
export { AVATAR_SKIN_HEX, SLEEVE_HEX } from './hand-pose'

/**
 * HOW EACH WEAPON IS HELD — the one grip table both rigs share, plus the
 * motion curves every hand plays and the IK bridge the avatar's support arm
 * needs. Pure: module temps only, no React, no scene objects.
 *
 * Weapon MODEL space (weapon-models.tsx): grip at the origin, barrel down −Z,
 * +Y up. A `HandGrip` places a hand-pose.ts hand in that space by AXES, not
 * Eulers: `position` is the palm centre (the hand frame's origin), `up` is
 * the weapon-space direction the hand's +Y takes (along the grip, pinky →
 * index), `palm` is the direction the palm FACES (from the hand toward what
 * it presses). `gripQuaternion` turns those into the rotation — Gram-Schmidt,
 * right-handed, nothing to guess.
 *
 * `arm` is the first-person sleeve direction from the wrist toward the
 * (off-screen) shoulder, as Euler [pitch, yaw, 0] applied to local +Z in
 * weapon space: +pitch heads down, +yaw heads +X (screen-right).
 */

export type HandSide = 'R' | 'L'
export type ArmDir = { pitch: number; yaw: number }
export type HandGrip = {
  position: readonly [number, number, number]
  up: readonly [number, number, number]
  palm: readonly [number, number, number]
  pose: HandPoseId
  arm: ArmDir
}
export type WeaponHold = {
  right: HandGrip
  left: HandGrip | null
  /** The right index rides a trigger (articulated finger + squeeze on fire). */
  trigger: boolean
}

const norm = (v: readonly [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
/** Rx(a)·(0,1,0): the axis of a grip box raked by `rotation={[a,0,0]}`. */
const rakedUp = (a: number): [number, number, number] => [0, Math.cos(a), Math.sin(a)]

/**
 * THE TABLE. Positions sit on each weapon's grip line (weapon-models numbers;
 * hand-grips.test.ts checks the distance). Palm directions:
 *   right hands press the grip from the right (palm −X), left hands from the
 *   left (+X) — except the rifle's support hand, which cups the handguard from
 *   below (palm +Y).
 * A one-handed hold has `left: null`. Guns are `trigger: true`.
 */
export const HAND_GRIPS: Record<ToolId, WeaponHold> = {
  // Knife: REVERSE grip on the handle (runs +Z): pinky toward the guard, the
  // thumb capping the pommel, knuckles up, palm toward the body — the one
  // hold where a level blade points forward while the forearm comes from
  // below-right (a hammer grip would put the heel on TOP of the fist).
  knife: {
    right: {
      position: [0, -0.014, 0.052],
      up: norm([0, -0.12, 0.993]),
      palm: [-1, 0, 0],
      pose: 'fist',
      arm: { pitch: 0.85, yaw: 0.45 },
    },
    left: null,
    trigger: false,
  },
  // Pistol: right high on the raked grip, index on the trigger; left cups the
  // right hand's fingers from the left, a touch lower.
  pistol: {
    right: { position: [0, -0.04, 0.028], up: rakedUp(0.32), palm: [-1, 0, 0], pose: 'trigger', arm: { pitch: 0.6, yaw: 0.5 } },
    left: { position: [-0.034, -0.058, 0.03], up: rakedUp(0.32), palm: [1, 0, 0], pose: 'wrap', arm: { pitch: 0.6, yaw: -0.55 } },
    trigger: true,
  },
  // Rifle: right on the pistol grip; left under the handguard, palm up,
  // fingers over its right flank, the hand angled so the wrist bends less.
  rifle: {
    right: { position: [0, -0.045, 0.02], up: rakedUp(0.34), palm: [-1, 0, 0], pose: 'trigger', arm: { pitch: 0.6, yaw: 0.5 } },
    left: {
      position: [0, 0.032, -0.29],
      up: norm([-0.35, 0, -1]),
      palm: [0, 1, 0],
      pose: 'wrap',
      arm: { pitch: 0.95, yaw: -0.5 },
    },
    trigger: true,
  },
  // Minigun: right on the rear grip, left LOW on the vertical front grip —
  // the drum (r 0.095 at y 0.07) swallows the grip's top 2.5 cm, so the hand
  // sits at the grip's lower half where the camera sees it past the drum.
  minigun: {
    right: { position: [0, -0.05, 0.02], up: rakedUp(0.34), palm: [-1, 0, 0], pose: 'trigger', arm: { pitch: 0.6, yaw: 0.5 } },
    left: { position: [0, -0.06, -0.198], up: rakedUp(-0.12), palm: [1, 0, 0], pose: 'wrap', arm: { pitch: 0.55, yaw: -0.55 } },
    trigger: true,
  },
  // Warhammer: two hands stacked on the haft (+Y). The carry pose pitches the
  // haft forward like a lance (viewmodel rot.x −1.25), so the heels point
  // down-right / down-left in camera space and the sleeves drop toward the
  // bottom corners: weapon-space pitch past π/2 (see the camera derivation in
  // hand-grips.test.ts).
  hammer: {
    right: { position: [0, 0.02, 0], up: [0, 1, 0], palm: norm([0.8, 0, 0.6]), pose: 'wrap', arm: { pitch: 2.25, yaw: 0.47 } },
    left: { position: [0, 0.15, 0], up: [0, 1, 0], palm: norm([-0.8, 0, 0.6]), pose: 'wrap', arm: { pitch: 2.25, yaw: -0.47 } },
    trigger: false,
  },
  // Builder claw hammer: one fist on the rubber sleeve, handle vertical.
  builder: {
    right: { position: [0, -0.06, 0], up: [0, 1, 0], palm: [-1, 0, 0], pose: 'fist', arm: { pitch: 0.6, yaw: 0.5 } },
    left: null,
    trigger: false,
  },
  // Spray can: cupped from the right, palm on the can's flank (r 0.042); the
  // existing press lean (viewmodel) stays the nozzle cue.
  paint: {
    right: { position: [0.028, 0, 0], up: [0, 1, 0], palm: [-1, 0, 0], pose: 'can', arm: { pitch: 0.6, yaw: 0.5 } },
    left: null,
    trigger: false,
  },
}

/** What an unknown wire id gets: a fist at the origin, one hand, no trigger. */
export const FALLBACK_HOLD: WeaponHold = {
  right: { position: [0, 0, 0], up: [0, 1, 0], palm: [-1, 0, 0], pose: 'fist', arm: { pitch: 0.6, yaw: 0.5 } },
  left: null,
  trigger: false,
}

/** THE way a wire string reaches the table — a newer peer's weapon id gets
 * FALLBACK_HOLD instead of an undefined that throws at render. */
export function holdFor(weapon: string): WeaponHold {
  return (HAND_GRIPS as Record<string, WeaponHold | undefined>)[weapon] ?? FALLBACK_HOLD
}

/** The left hand in the RIGHT-HAND-AT-ORIGIN frame (left.position − right.position):
 * what HeldWeapon uses once it wraps the weapon behind `−right.position`, and
 * what `gripToShoulder` turns into the support arm's IK target. */
export const LEFT_IN_HAND: Record<string, readonly [number, number, number] | null> = (() => {
  const out: Record<string, readonly [number, number, number] | null> = {}
  for (const key of Object.keys(HAND_GRIPS) as ToolId[]) {
    const h = HAND_GRIPS[key]
    out[key] = h.left
      ? [
          h.left.position[0] - h.right.position[0],
          h.left.position[1] - h.right.position[1],
          h.left.position[2] - h.right.position[2],
        ]
      : null
  }
  return out
})()
export function leftGripFor(weapon: string): readonly [number, number, number] | null {
  return LEFT_IN_HAND[weapon] ?? null
}

// ── Orientation ───────────────────────────────────────────────────────────────

const _x = new Vector3()
const _y = new Vector3()
const _z = new Vector3()
const _m4 = new Matrix4()

/**
 * The hand's rotation in weapon space: Y = `up`; X = the back-of-hand direction
 * (−palm for a right hand, +palm for the mirrored left), Gram-Schmidt'd against
 * Y; Z = X × Y. A proper right-handed basis — the test checks det = +1 and that
 * (0,1,0) → up and the palm normal → palm.
 */
export function gripQuaternion(g: HandGrip, side: HandSide, out: Quaternion): Quaternion {
  _y.set(g.up[0], g.up[1], g.up[2]).normalize()
  const s = side === 'R' ? -1 : 1
  _x.set(g.palm[0] * s, g.palm[1] * s, g.palm[2] * s)
  _x.addScaledVector(_y, -_x.dot(_y)).normalize()
  _z.crossVectors(_x, _y)
  _m4.makeBasis(_x, _y, _z)
  return out.setFromRotationMatrix(_m4)
}

/** Where the hand's heel is in weapon space: the palm origin pushed along the
 * hand's +Z by `WRIST.z + WRIST.len/2` (the wrist stub's far end) — the point
 * the first-person sleeve hangs from, so a rolled hand never leaves a gap. */
export const WRIST_JOINT = WRIST.z + WRIST.len / 2
const _q = new Quaternion()
export function heelPoint(g: HandGrip, side: HandSide, out: [number, number, number]): [number, number, number] {
  gripQuaternion(g, side, _q)
  _z.set(0, 0, WRIST_JOINT).applyQuaternion(_q)
  out[0] = g.position[0] + _z.x
  out[1] = g.position[1] + _z.y
  out[2] = g.position[2] + _z.z
  return out
}

/** Unit direction of `arm` in weapon space: Rx(pitch)·Ry(yaw)·(0,0,1). */
export function armDirection(arm: ArmDir, out: [number, number, number]): [number, number, number] {
  const sy = Math.sin(arm.yaw)
  const cy = Math.cos(arm.yaw)
  out[0] = sy
  out[1] = -Math.sin(arm.pitch) * cy
  out[2] = Math.cos(arm.pitch) * cy
  return out
}

// ── The avatar's IK bridge ───────────────────────────────────────────────────

/** remote-players' limbDir, re-implemented here to avoid an import cycle: the
 * direction of a limb swung `theta` from hanging and yawed `yaw`. */
export function handLimbDir(theta: number, yaw: number): [number, number, number] {
  const st = Math.sin(theta)
  return [-st * Math.sin(yaw), -Math.cos(theta), -st * Math.cos(yaw)]
}

/**
 * A point `p` given in the HELD-WEAPON group's frame (the right hand's palm at
 * its origin, Rx(−π/2 + tilt) applied, so the weapon's −Z barrel points where
 * `barrel` says) → the LEFT shoulder's frame, for the support arm's IK. The
 * chain it mirrors (remote-players.tsx / pascaline-model.ts):
 *   armR (YXZ: y = yaw, x = swing) → elbow at (0, −upperArm, 0) rot.x = elbow
 *   → weapon at (0, −reach, 0.02) rot.x = −π/2 + tilt → p.
 * `right` is solveArm's solution for the right arm (its `hand` is the weapon
 * origin), `barrel` = swing + elbow + tilt, `shoulderX` the half shoulder width
 * (the left shoulder sits at −2·shoulderX from the right one).
 */
export function gripToShoulder(
  p: readonly [number, number, number],
  right: { yaw: number; swing: number; elbow: number; hand: readonly [number, number, number] },
  barrel: number,
  shoulderX: number,
  out: [number, number, number],
): [number, number, number] {
  const th = right.swing + right.elbow
  const sy = Math.sin(right.yaw)
  const cy = Math.cos(right.yaw)
  // The weapon group's origin: the forearm's end plus the 0.02 m local +Z offset.
  const hzx = Math.cos(th) * sy
  const hzy = -Math.sin(th)
  const hzz = Math.cos(th) * cy
  const ox = right.hand[0] + 0.02 * hzx
  const oy = right.hand[1] + 0.02 * hzy
  const oz = right.hand[2] + 0.02 * hzz
  // Weapon-frame axes in shoulder space.
  const xx = cy
  const xy = 0
  const xz = -sy
  const zd = handLimbDir(barrel, right.yaw)
  const zx = -zd[0]
  const zy = -zd[1]
  const zz = -zd[2]
  // Y = Z × X
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  out[0] = ox + p[0] * xx + p[1] * yx + p[2] * zx + 2 * shoulderX
  out[1] = oy + p[0] * xy + p[1] * yy + p[2] * zy
  out[2] = oz + p[0] * xz + p[1] * yz + p[2] * zz
  return out
}

// ── Motion curves ────────────────────────────────────────────────────────────

/**
 * ONE recoil, ONE sway: feel.ts owns them (recoilEnvelope over
 * FEEL.RECOIL_TIME, swayProfile over the eased speed). The viewmodel evaluates
 * both once a frame and hands the values to the hands through
 * weapon-hands' `handSignals`; the hands only run the envelope themselves when
 * nothing drives them. Re-exported here so the grip table stays the one import
 * a hand rig needs.
 */
export const RECOIL_TIME = FEEL.RECOIL_TIME
export { recoilEnvelope, swayProfile }
/** @deprecated round-1 name for feel.recoilEnvelope (1 on the shot frame → 0). */
export const recoilCurve = recoilEnvelope

/** The index squeeze after a shot, seconds: the SHOT FRAME is the pull. */
export const TRIGGER_TIME = 0.14
/** 1 (fully pulled) from the shot frame through the first 0.03 s, then a
 * smooth release to exactly 0 at TRIGGER_TIME. The bang happens at full pull,
 * so nothing here animates a pull AFTER the shot it caused. */
export const TRIGGER_HOLD = 0.03
export function triggerCurve(t: number): number {
  if (t <= 0) return 1
  if (t >= 1) return 0
  const s = t * TRIGGER_TIME
  if (s <= TRIGGER_HOLD) return 1
  const u = (s - TRIGGER_HOLD) / (TRIGGER_TIME - TRIGGER_HOLD)
  return 1 - u * u * (3 - 2 * u)
}
/** A HELD trigger (auto stream, a semi shot not yet released, a spinning-up
 * rotary) keeps the index pulled: ease-in / ease-out rates (1/s). */
export const TRIGGER_PULL_RATE = 40
export const TRIGGER_RELEASE_RATE = 12

/** The share of the weapon's sway (feel.swayProfile, weapon space) the SUPPORT
 * hand does NOT follow — a soft grip lets the gun move a little inside it. */
export const SWAY_COMPLIANCE = 0.25

/** The support hand's settle after a weapon swap, seconds. */
export const READY_TIME = 0.32
/** A single dip-and-return (metres) the support hand plays over READY_TIME. */
export function readyBob(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return Math.sin(Math.PI * c) * 0.03
}

/** How far (m) the gun slides back through a soft support hand at full recoil
 * — applied NEGATIVE along weapon +Z to the left hand. */
export const SUPPORT_LAG = 0.012
/** Extra index curl (rad) at full ADS: a finger that means it. */
export const TRIGGER_ADS_TIGHTEN = 0.12
/** A freshly-drawn weapon rises from a droop over this long (avatar swap). */
export const SWAP_TIME = 0.15

/** Peak muzzle climb (rad) a REMOTE avatar's gun plays per shot, on its own
 * 0.16 s timer: pistol snaps, the minigun's 24/s stream barely trembles.
 * Barrel-up = weaponRef.rotation.x INCREASES (Rx(−π/2 + tilt) raises the barrel
 * with +tilt). */
export function remoteKickFor(weapon: string): number {
  if (weapon === 'pistol') return 0.12
  if (weapon === 'minigun') return 0.035
  return 0.09
}

// ── Near-plane guard (tests) ─────────────────────────────────────────────────

const _pos = new Vector3()
const _rot = new Quaternion()
const _pt = new Vector3()
const _dir = new Vector3()
const _e = new Euler()

export type PoseExtra = { recoilZ: number; drawY: number; drawPitch: number; hamPitch: number }

/**
 * Camera-space sample points (x, y, z triples appended to `out`) of one hand
 * on a viewmodel pose: the palm origin, the heel, and the sleeve axis sampled
 * every 5 cm from 6 to 42 cm along `arm` from the heel. `posePos`/`poseRot`
 * are the viewmodel POSES entry (XYZ Euler), `extra` the animation offsets the
 * frame loop adds (recoil z, draw-in y/pitch, hammer swing pitch). For the
 * frustum-aware near-plane test — parts may cross z > −near only outside the
 * view cone.
 */
export function handPartsInCamera(
  posePos: readonly [number, number, number],
  poseRot: readonly [number, number, number],
  hold: WeaponHold,
  side: HandSide,
  extra: PoseExtra,
  out: number[],
): number[] {
  const g = side === 'R' ? hold.right : hold.left
  if (!g) return out
  _pos.set(posePos[0], posePos[1] + extra.drawY, posePos[2] + extra.recoilZ)
  _e.set(poseRot[0] + extra.drawPitch + extra.hamPitch, poseRot[1], poseRot[2], 'XYZ')
  _rot.setFromEuler(_e)
  const push = (wx: number, wy: number, wz: number) => {
    _pt.set(wx, wy, wz).applyQuaternion(_rot).add(_pos)
    out.push(_pt.x, _pt.y, _pt.z)
  }
  push(g.position[0], g.position[1], g.position[2])
  const heel: [number, number, number] = [0, 0, 0]
  heelPoint(g, side, heel)
  push(heel[0], heel[1], heel[2])
  const d: [number, number, number] = [0, 0, 0]
  armDirection(g.arm, d)
  _dir.set(d[0], d[1], d[2])
  for (let s = 0.06; s <= 0.42 + 1e-9; s += 0.05) {
    push(heel[0] + _dir.x * s, heel[1] + _dir.y * s, heel[2] + _dir.z * s)
  }
  return out
}
