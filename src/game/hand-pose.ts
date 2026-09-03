/**
 * HAND ANATOMY + POSES — pure math, no three import. One source of truth for
 * what a hand IS, consumed identically by the first-person rig (hand-rig.tsx,
 * weapon-hands.tsx) and, in round 2, by the avatar's HeldWeapon.
 *
 * THE HAND FRAME (a RIGHT hand closed on a VERTICAL grip through the origin):
 *   +Y  up the grip, pinky → index (the knuckle line runs along Y).
 *   +X  the palm side: the palm slab sits at x ∈ [PALM.x, PALM.x + PALM.t]
 *       with its inner face pressing the grip from the right (palm normal −X).
 *   −Z  where the fingers point at rest (knuckles at the palm's front edge);
 *       a positive curl about +Y carries −Z toward −X, i.e. the fingers wrap
 *       around the FRONT of the grip and close on its left side.
 *   +Z  the heel/wrist — the forearm continues from here.
 *   The thumb roots at the top (+Y) of the palm behind the grip (+Z) and
 *   crosses the back of the grip toward −X, its second segment hooking forward.
 * Check: fingers (−Z) × thumb (+Y) = +X = the back of the hand. A right hand.
 *
 * The LEFT hand is the X-mirror of this frame (mirrorX): palm at −X facing
 * +X, curls toward +X, thumb toward +X.
 *
 * Sized between the mascot's 10.8 cm hand and an adult hand (palm 7.5 cm
 * across, middle finger 7.7 cm) so the first-person view and the avatar can
 * share one shape without either reading as a glove or a doll.
 */

/** Skin tone shared by the first-person hands and the avatar's gripping
 * hands: the midpoint of the mascot GLB's hand (#f4cdba) and forearm
 * (#ebc6b4) texels, so a procedural hand meets the modelled wrist without a
 * colour step. Round 2 recolours remote-players' SKIN_MATERIAL to this. */
export const AVATAR_SKIN_HEX = '#efc7b3'
/** The jacket sleeve — remote-players' JACKET_MATERIAL colour. */
export const SLEEVE_HEX = '#22242a'

/** Palm slab: thickness (x), width across the knuckles (y), length wrist→knuckles (z),
 * and `x`, the inner face pressing the grip. */
export const PALM = { w: 0.075, t: 0.026, l: 0.08, x: 0.014 } as const
/** Wrist stub behind the palm (first-person hand only; the avatar has a modelled
 * forearm): a short truncated cone along +Z centred at `z`, offset `x` to sit
 * under the palm. */
export const WRIST = { r0: 0.027, r1: 0.03, len: 0.035, z: 0.055, x: 0.024 } as const
/** Where the finger chains root: the palm's front edge, biased to the grip side. */
export const KNUCKLE = { x: 0.02, z: -0.036 } as const

export type FingerName = 'index' | 'middle' | 'ring' | 'pinky'
export type FingerSpec = {
  name: FingerName
  /** Knuckle position along the grip (hand-frame y). */
  y: number
  /** Proximal, middle, distal segment lengths (m). */
  segs: readonly [number, number, number]
  /** Capsule radius. */
  r: number
  /** Fan about X at rest (rad): +tilts the finger toward +Y. */
  spread: number
}
export const FINGERS: readonly FingerSpec[] = [
  { name: 'index', y: 0.027, segs: [0.03, 0.024, 0.018], r: 0.0095, spread: 0.04 },
  { name: 'middle', y: 0.009, segs: [0.032, 0.026, 0.019], r: 0.01, spread: 0.01 },
  { name: 'ring', y: -0.009, segs: [0.029, 0.024, 0.018], r: 0.0093, spread: -0.02 },
  { name: 'pinky', y: -0.027, segs: [0.022, 0.018, 0.015], r: 0.008, spread: -0.06 },
]

/** Thumb: rooted at the top-back corner of the palm, resting Euler (rx, ry) aims
 * the first segment left and slightly back over the grip's backstrap; the curl
 * (rad) subtracts from ry — `seg0`/`seg1` are the shares each segment takes —
 * so a bigger curl hooks the second segment forward around the grip's far side. */
export const THUMB = {
  root: [0.022, 0.034, 0.034] as readonly [number, number, number],
  segs: [0.034, 0.028] as readonly [number, number],
  r: 0.0105,
  rest: { rx: -0.3, ry: 2.0 },
  curl: { seg0: 0.3, seg1: 0.9 },
} as const

/** Fingers taper: each segment's capsule radius as a share of the finger's. */
export const FINGER_TAPER: readonly [number, number, number] = [1, 0.9, 0.8]
export const THUMB_TAPER: readonly [number, number] = [1, 0.88]

export type HandPoseId = 'fist' | 'trigger' | 'wrap' | 'can'
/** Per-joint curl angles (rad) for one finger: knuckle, middle, distal. */
export type FingerCurl = readonly [number, number, number]
export type HandPose = {
  index: FingerCurl
  middle: FingerCurl
  ring: FingerCurl
  pinky: FingerCurl
  /** Thumb wrap, 0 (straight) .. 1 (closed over the grip). */
  thumb: number
}

const FIST: FingerCurl = [1.15, 1.05, 0.7]
const WRAP: FingerCurl = [0.9, 0.85, 0.65]
const CAN: FingerCurl = [0.75, 0.7, 0.5]
/** The index finger resting on a trigger: forward past the guard, pad on the
 * blade — see TRIGGER_REST/TRIGGER_CURL for the squeeze. */
const TRIGGER_INDEX: FingerCurl = [0.5, 0.6, 0.5]

/**
 * The four holds. 'fist' closes on a ~2–3 cm bar (knife handle, hammer sleeve,
 * pistol grip); 'trigger' is a fist with the index out on the trigger; 'wrap'
 * is a looser close on a ~3 cm haft or a handguard; 'can' cups a ~4.5 cm can.
 */
export const HAND_POSES: Record<HandPoseId, HandPose> = {
  fist: { index: FIST, middle: FIST, ring: FIST, pinky: FIST, thumb: 1 },
  trigger: { index: TRIGGER_INDEX, middle: FIST, ring: FIST, pinky: FIST, thumb: 1 },
  wrap: { index: WRAP, middle: WRAP, ring: WRAP, pinky: WRAP, thumb: 0.7 },
  can: { index: CAN, middle: CAN, ring: CAN, pinky: CAN, thumb: 0.5 },
}

/** The articulated trigger finger's LOCAL joint angles (rotation.y of the three
 * nested groups) at rest on the trigger, and squeezed. A pull is ~1 cm of pad
 * travel, not a fist. */
export const TRIGGER_REST: FingerCurl = TRIGGER_INDEX
export const TRIGGER_CURL: FingerCurl = [0.75, 0.85, 0.7]

/** One capsule segment in the HAND frame: origin, XYZ Euler, length along its
 * local −Z, radius. `fingerSegmentTransforms` writes ACCUMULATED (flat) records;
 * `indexChain` writes LOCAL (nested) ones — never mix the two. */
export type SegmentXform = {
  px: number
  py: number
  pz: number
  rx: number
  ry: number
  rz: number
  len: number
  r: number
}

/** 4 fingers × 3 + thumb × 2. Index segments are records 0..2. */
export const SEGMENT_COUNT = 14
export const INDEX_SEGMENTS: readonly [number, number, number] = [0, 1, 2]

export function makeSegment(): SegmentXform {
  return { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, len: 0, r: 0 }
}
export function makeSegments(): SegmentXform[] {
  const out: SegmentXform[] = []
  for (let i = 0; i < SEGMENT_COUNT; i++) out.push(makeSegment())
  return out
}

/** Direction of a segment's local −Z after an XYZ Euler (rx, ry, 0) — three's
 * Euler order: Rx · Ry · (0,0,−1). */
function segmentDir(rx: number, ry: number, out: [number, number, number]): void {
  const cy = Math.cos(ry)
  out[0] = -Math.sin(ry)
  out[1] = Math.sin(rx) * cy
  out[2] = -Math.cos(rx) * cy
}

const _d: [number, number, number] = [0, 0, 0]

function curlOf(pose: HandPose, name: FingerName): FingerCurl {
  return pose[name]
}

/**
 * Forward kinematics of the whole hand: 14 ACCUMULATED segment transforms in the
 * hand frame, fingers first (index, middle, ring, pinky × 3), then the thumb's
 * two. Segment i of a chain starts where segment i−1 ended (its origin plus its
 * length along its rotated −Z); ry accumulates the curl.
 */
export function fingerSegmentTransforms(pose: HandPose, out: SegmentXform[]): SegmentXform[] {
  let k = 0
  for (const f of FINGERS) {
    const curl = curlOf(pose, f.name)
    let px = KNUCKLE.x
    let py = f.y
    let pz = KNUCKLE.z
    let ry = 0
    for (let i = 0; i < 3; i++) {
      ry += curl[i] as number
      const s = out[k++] as SegmentXform
      const len = f.segs[i] as number
      s.px = px
      s.py = py
      s.pz = pz
      s.rx = f.spread
      s.ry = ry
      s.rz = 0
      s.len = len
      s.r = f.r * (FINGER_TAPER[i] as number)
      segmentDir(f.spread, ry, _d)
      px += _d[0] * len
      py += _d[1] * len
      pz += _d[2] * len
    }
  }
  // Thumb: rest Euler, the curl subtracting from ry (wrapping forward).
  const t = pose.thumb
  let px = THUMB.root[0]
  let py = THUMB.root[1]
  let pz = THUMB.root[2]
  let ry = THUMB.rest.ry - THUMB.curl.seg0 * t
  for (let i = 0; i < 2; i++) {
    if (i === 1) ry -= THUMB.curl.seg1 * t
    const s = out[k++] as SegmentXform
    const len = THUMB.segs[i] as number
    s.px = px
    s.py = py
    s.pz = pz
    s.rx = THUMB.rest.rx
    s.ry = ry
    s.rz = 0
    s.len = len
    s.r = THUMB.r * (THUMB_TAPER[i] as number)
    segmentDir(THUMB.rest.rx, ry, _d)
    px += _d[0] * len
    py += _d[1] * len
    pz += _d[2] * len
  }
  return out
}

/**
 * The index finger as a NESTED chain of three LOCAL joints — what the
 * articulated trigger finger mounts: group 0 at the knuckle with rotation
 * (spread, curl0, 0); group 1 at (0,0,−len0) with rotation.y = curl1; group 2
 * at (0,0,−len1) with rotation.y = curl2. Composing these reproduces the flat
 * index records of `fingerSegmentTransforms` (pinned by a test).
 */
export function indexChain(pose: HandPose): [SegmentXform, SegmentXform, SegmentXform] {
  const f = FINGERS[0] as FingerSpec
  const curl = pose.index
  const j0: SegmentXform = {
    px: KNUCKLE.x,
    py: f.y,
    pz: KNUCKLE.z,
    rx: f.spread,
    ry: curl[0],
    rz: 0,
    len: f.segs[0],
    r: f.r,
  }
  const j1: SegmentXform = { px: 0, py: 0, pz: -f.segs[0], rx: 0, ry: curl[1], rz: 0, len: f.segs[1], r: f.r * FINGER_TAPER[1] }
  const j2: SegmentXform = { px: 0, py: 0, pz: -f.segs[1], rx: 0, ry: curl[2], rz: 0, len: f.segs[2], r: f.r * FINGER_TAPER[2] }
  return [j0, j1, j2]
}

/** The same segment on the LEFT hand: X negated, and the yaw/roll flipped so
 * the mirrored −Z still curls toward the mirrored palm. In place. */
export function mirrorX(seg: SegmentXform): SegmentXform {
  seg.px = -seg.px
  seg.ry = -seg.ry
  seg.rz = -seg.rz
  return seg
}

/** Where a segment ends (its origin + len along its rotated −Z). */
export function segmentEnd(seg: SegmentXform, out: [number, number, number]): [number, number, number] {
  segmentDir(seg.rx, seg.ry, _d)
  out[0] = seg.px + _d[0] * seg.len
  out[1] = seg.py + _d[1] * seg.len
  out[2] = seg.pz + _d[2] * seg.len
  return out
}

export type HandBounds = { min: [number, number, number]; max: [number, number, number] }

/** Axis-aligned extents of a posed right hand (palm + wrist + every segment end,
 * padded by the radii). Allocates — for tests and one-off layout, not frames. */
export function handBounds(pose: HandPose, withWrist = false): HandBounds {
  const min: [number, number, number] = [PALM.x, -PALM.w / 2, -PALM.l / 2]
  const max: [number, number, number] = [PALM.x + PALM.t, PALM.w / 2, PALM.l / 2]
  const grow = (x: number, y: number, z: number, r: number) => {
    if (x - r < min[0]) min[0] = x - r
    if (y - r < min[1]) min[1] = y - r
    if (z - r < min[2]) min[2] = z - r
    if (x + r > max[0]) max[0] = x + r
    if (y + r > max[1]) max[1] = y + r
    if (z + r > max[2]) max[2] = z + r
  }
  if (withWrist) {
    grow(WRIST.x, 0, WRIST.z - WRIST.len / 2, WRIST.r0)
    grow(WRIST.x, 0, WRIST.z + WRIST.len / 2, WRIST.r1)
  }
  const segs = fingerSegmentTransforms(pose, makeSegments())
  const end: [number, number, number] = [0, 0, 0]
  for (const s of segs) {
    grow(s.px, s.py, s.pz, s.r)
    segmentEnd(s, end)
    grow(end[0], end[1], end[2], s.r)
  }
  return { min, max }
}
