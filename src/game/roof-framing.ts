import type { SegmentMember } from './destruction'
import type { VoxelBasis } from './voxel'

/**
 * Roof framing reveal (docs/MULTILEVEL-PLAN.md Phase C3) — pure geometry:
 * per-plane RAFTERS (+ ridge boards and eave plates where cheap) as
 * SegmentMember-shaped sticks, so a shot-open roof shows lumber exactly
 * like a shot-open wall shows studs. No imports from destruction.ts at
 * runtime (type-only) — this module is standalone while the roof-plane
 * voxel lane is in flight; the destruction manager wires the call sites.
 *
 * ── Conventions (all world-space, verified numerically in the test) ────
 * A plane is described by yaw ψ + pitch θ (radians) and its EAVE line:
 *   across  A = ( cosψ,        0,     sinψ )         eave/ridge direction
 *   normal  N = ( sinψ·sinθ,  cosθ,  −cosψ·sinθ )    outward plane normal
 *   upSlope U = (−sinψ·cosθ,  sinθ,   cosψ·cosθ )    eave → ridge tangent
 * (right-handed: A × N = U; at ψ = 0 the slope climbs toward +Z).
 *
 * MEMBER orientation extends the yaw-only stick convention additively:
 * a member with `pitch` renders local→world = Ry(−yaw)·Rz(pitch) — the
 * +X-aligned box tilts up by `pitch` in its local XY plane, then yaws.
 * pitch = 0 collapses to the existing [0, −yaw, 0] stud/plate convention
 * bit-for-bit. Long axis (local X) in world:
 *   ( cosθ·cos yaw, sinθ, cosθ·sin yaw )
 * so a rafter built for a plane stores yaw = ψ + π/2 (the up-slope
 * heading — the same ±π/2 the framing engine uses) and pitch = θ, and its
 * local Y IS the plane normal. `rafterObbBasis(yaw, pitch)` returns the
 * matching WORLD→BOX basis for voxel.ts's `raycastObb`.
 *
 * ── Wiring contract (the 2–3 call sites the manager owns) ──────────────
 * 1. destruction.ts SegmentMember: add optional `pitch?: number` (this
 *    module's RafterMember already carries it — structurally compatible).
 * 2. destruction.ts raycastSegments: when `segment.pitch` is set, route
 *    through voxel.ts raycastObb with rafterObbBasis(yaw, pitch) instead
 *    of raycastYawObb. (damageSegment / chipSegmentSplash long-axis
 *    spread may optionally tilt their axis to
 *    (cosθ·cos yaw, sinθ, cosθ·sin yaw) — the yaw-only horizontal
 *    projection they use today is an acceptable approximation.)
 * 3. voxel-walls.tsx uploadLayer: when `m.pitch` is set, compose the
 *    instance quaternion Qy(−yaw)·Qz(pitch) instead of the yaw-only
 *    axis-angle. Until then rafters draw un-tilted — harmless interim.
 * 4. ensureVoxelTarget roof lane: members = buildRafters(roofNode,
 *    segmentNodes, planes) → one target: use as `segments`/`studs`
 *    directly; per-plane targets: splitRaftersByPlane re-ids per group.
 * Damage semantics come free: hp RAFTER_HP (= the stud/joist 2), chip /
 * snap / splash-chip all run through the shared segment machinery.
 */

// ── Lumber + layout tunables (exported for tests) ───────────────────────────

/** Rafter stock 2×6 — 38 × 140 mm section. */
export const RAFTER_W = 0.038
export const RAFTER_D = 0.14
/** 24" o.c. rafter spacing (roofs frame wider than the 16" stud grid). */
export const RAFTER_SPACING = 0.6096
/** Rafter lines split into ~1.4 m charcoal sticks (walls use ~1.2). */
export const RAFTER_RUN = 1.4
/** Rafter TOPS sit this far under the plane's inner skin (along −N). */
export const RAFTER_TOP_DROP = 0.01
/** Mirrors destruction.ts SEGMENT_HP — knife chips twice, guns snap. */
export const RAFTER_HP = 2
/** Ridge board on edge — 2×8-ish depth under the ridge line. */
export const RIDGE_D = 0.184
/** Eave plate — flat 2×4 run under the rafter feet. */
export const PLATE_T = 0.038
export const PLATE_W = 0.089
/** Stick end gap (same as wall segments) + plane end inset per slope end. */
const STICK_GAP = 0.012
const END_GAP = 0.02
/** Planes flatter than ~1.7° carry joists (slab lane), never rafters. */
const MIN_PITCH = 0.03
/** Two planes whose ridge midpoints land this close (and face opposite
 * yaws) share ONE ridge board. */
const RIDGE_MATCH_DIST = 0.15
const RIDGE_MATCH_YAW = 0.15

// ── Input shapes (structural — host nodes and roof-lane planes satisfy) ─────

/** Host 'roof' container node (reserved for per-node overrides). */
export type RoofNodeLike = {
  id?: string
  position?: readonly number[]
  rotation?: number
} | null

/** Host 'roof-segment' child — only roofType is consulted today (an
 * all-'flat' roof never frames; flat assemblies are the slab lane's). */
export type RoofSegmentLike = {
  id?: string
  roofType?: string
  pitch?: number
}

/**
 * One roof PLANE in world space — the slice of roof-lane plane data the
 * framing needs. `eaveCenter` is the midpoint of the plane's eave edge ON
 * the assembly's INNER (underside) surface; walking `upSlope` from it
 * stays on that surface, so rafter tops drop below it by RAFTER_TOP_DROP.
 */
export type RoofPlaneBasis = {
  /** Plane yaw ψ (radians) — see the module frame table. */
  yaw: number
  /** Pitch θ from horizontal (radians, > 0). */
  pitch: number
  /** World midpoint of the eave edge, on the inner skin. */
  eaveCenter: readonly [number, number, number]
  /** Eave edge length (m) — extent along `across`. */
  eaveLength: number
  /** Eave→ridge length (m) measured along the plane. */
  slopeLength: number
  /** Optional plane-space FOOTPRINT triangles, packed [a0,u0,a1,u1,a2,u2,…]
   * where `a` is metres along `across` from the eave CENTER and `u` metres
   * along `upSlope` from the eave. When present, every rafter line clips to
   * the real polygon (hip triangles lose their full-length edge lines and
   * no stick top ever pokes past the ridge); absent keeps the rectangular
   * eaveLength × slopeLength layout. */
  polyTris?: readonly number[]
}

export type RafterRole = 'rafter' | 'ridge' | 'plate'

/** SegmentMember + the pitched-stick extras — extra fields are additive,
 * so every SegmentMember consumer (renderer, raycasts, damage) accepts
 * these unchanged. */
export type RafterMember = SegmentMember & {
  /** Slope tilt (radians); 0 for ridge boards / eave plates. */
  pitch: number
  /** Index into the `planeBases` array (ridge boards attach to the
   * lower-indexed plane of their pair). */
  planeIndex: number
  role: RafterRole
}

/** The world frame of a (yaw, pitch) plane — across/normal/upSlope unit
 * vectors per the module table. Exported so the roof lane can cross-check
 * its own plane enumeration against the framing's idea of the slope. */
export function roofPlaneFrame(
  yaw: number,
  pitch: number,
): {
  across: [number, number, number]
  normal: [number, number, number]
  upSlope: [number, number, number]
} {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const ct = Math.cos(pitch)
  const st = Math.sin(pitch)
  return {
    across: [cy, 0, sy],
    normal: [sy * st, ct, -cy * st],
    upSlope: [-sy * ct, st, cy * ct],
  }
}

/**
 * WORLD → BOX-LOCAL basis of a pitched member for voxel.ts `raycastObb`:
 * q = Qz(−pitch) · Qy(yaw) — the inverse of the render rotation
 * Ry(−yaw)·Rz(pitch). pitch = 0 degenerates to yawBasis(yaw) exactly, so
 * the raycastSegments insertion can route EVERY member through this if it
 * prefers one code path. Pass `out` to stay allocation-free in hot loops.
 */
export function rafterObbBasis(yaw: number, pitch: number, out?: VoxelBasis): VoxelBasis {
  const sy = Math.sin(yaw / 2)
  const cy = Math.cos(yaw / 2)
  const sp = Math.sin(pitch / 2)
  const cp = Math.cos(pitch / 2)
  const q = out ?? { x: 0, y: 0, z: 0, w: 1 }
  q.x = sp * sy
  q.y = cp * sy
  q.z = -sp * cy
  q.w = cp * cy
  return q
}

/** Rafter/ridge runs shorter than this never mint a stick (hip-corner
 * slivers read as debris, not framing). */
const MIN_LINE_RUN = 0.15

/** Scratch interval for the footprint clippers. */
const _span = { lo: 0, hi: 0 }

/**
 * Interval of the plane footprint crossed by the line `axis = value` in
 * plane space — `axis` 0 clips a rafter LINE (across = value, returns the
 * up-slope span), `axis` 1 clips the RIDGE (upSlope = value, returns the
 * across span). Min/max over every edge crossing of every packed triangle
 * (roof planes are convex-ish, so the union is one interval). False when
 * the line misses the footprint entirely.
 */
function footprintSpan(
  tris: readonly number[],
  axis: 0 | 1,
  value: number,
  out: { lo: number; hi: number },
): boolean {
  const other = axis === 0 ? 1 : 0
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let t = 0; t + 5 < tris.length; t += 6) {
    for (let e = 0; e < 3; e++) {
      const f = (e + 1) % 3
      const pa = tris[t + e * 2 + axis]!
      const qa = tris[t + e * 2 + other]!
      const pb = tris[t + f * 2 + axis]!
      const qb = tris[t + f * 2 + other]!
      const da = pa - value
      const db = pb - value
      if (da === 0 && db === 0) {
        // Edge lies ON the line — both ends bound the span.
        if (qa < lo) lo = qa
        if (qa > hi) hi = qa
        if (qb < lo) lo = qb
        if (qb > hi) hi = qb
        continue
      }
      if (da * db > 0) continue
      const q = qa + ((value - pa) / (pb - pa)) * (qb - qa)
      if (q < lo) lo = q
      if (q > hi) hi = q
    }
  }
  if (hi < lo) return false
  out.lo = lo
  out.hi = hi
  return true
}

/** Wrap into (−π, π] so stored yaws stay in the stud convention's range. */
const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2)
  if (r > Math.PI) r -= Math.PI * 2
  else if (r <= -Math.PI) r += Math.PI * 2
  return r
}

/**
 * Rafters (+ ridge boards + eave plates) for every roof plane.
 *
 * Layout per plane: rafter LINES 24" o.c. along the eave (first line at
 * the rake edge, same pattern as buildStuds), each line running eave →
 * ridge along the slope, split into ~RAFTER_RUN sticks at the 2×6
 * section, tops RAFTER_TOP_DROP under the inner skin. A ridge board is
 * emitted once per PAIR of planes whose ridge lines coincide with
 * opposite yaws (sheds meet a wall at the top — no board); an eave plate
 * runs flat under each plane's rafter feet. Every member is hp
 * RAFTER_HP / broken:false with ids 0..n−1 across the returned array —
 * ready to BE a target's `segments` array (per-plane targets re-id via
 * splitRaftersByPlane).
 *
 * `roofNode` is reserved (per-node overrides later); `segments` gates the
 * degenerate all-'flat' roof. Planes flatter than MIN_PITCH or smaller
 * than 0.3 m on either extent are skipped.
 */
export function buildRafters(
  roofNode: RoofNodeLike | undefined,
  segments: readonly RoofSegmentLike[] | null | undefined,
  planeBases: readonly RoofPlaneBasis[],
): RafterMember[] {
  void roofNode
  const members: RafterMember[] = []
  if (planeBases.length === 0) return members
  if (segments && segments.length > 0 && segments.every((s) => s.roofType === 'flat')) {
    return members
  }

  const push = (
    role: RafterRole,
    planeIndex: number,
    center: [number, number, number],
    size: [number, number, number],
    yaw: number,
    pitch: number,
  ): void => {
    members.push({
      id: members.length,
      center,
      size,
      yaw: wrapAngle(yaw),
      pitch,
      hp: RAFTER_HP,
      broken: false,
      planeIndex,
      role,
    })
  }

  /** Ridge midpoints (inner surface) of framed planes, for pairing. */
  const ridgePoints: Array<{
    plane: number
    x: number
    y: number
    z: number
    yaw: number
    eaveLength: number
    /** Across-offset midpoint + length of the footprint's upper edge (the
     * ridge extent) — eaveLength/0 when the plane has no footprint data. */
    topMid: number
    topLen: number
  }> = []

  for (let p = 0; p < planeBases.length; p++) {
    const plane = planeBases[p]!
    const { yaw, pitch, eaveLength, slopeLength } = plane
    if (!(pitch >= MIN_PITCH) || eaveLength < 0.3 || slopeLength < 0.3) continue
    const [ex, ey, ez] = plane.eaveCenter
    const { across, normal, upSlope } = roofPlaneFrame(yaw, pitch)
    // Rafter center line sits (top drop + half depth) under the inner skin.
    const drop = RAFTER_TOP_DROP + RAFTER_D / 2
    const memberYaw = yaw + Math.PI / 2 // up-slope heading (ψ ± π/2)
    const lines = Math.max(2, Math.floor(eaveLength / RAFTER_SPACING) + 1)
    const poly = plane.polyTris && plane.polyTris.length >= 6 ? plane.polyTris : null
    for (let i = 0; i < lines; i++) {
      const t = Math.min(1, (i * RAFTER_SPACING) / eaveLength)
      const s = (t - 0.5) * eaveLength
      // Clip the line to the plane FOOTPRINT: hip triangles shorten their
      // lines toward the corners (and lose the rake-edge lines entirely),
      // and no stick top ever climbs past the polygon's real upper edge.
      // Rake lines sample a hair inside so a boundary-exact line still
      // reads its own edge instead of missing by float noise.
      let lineLo = 0
      let lineHi = slopeLength
      if (poly) {
        const half = eaveLength / 2
        const sEval = s < -half + 1e-3 ? -half + 1e-3 : s > half - 1e-3 ? half - 1e-3 : s
        if (!footprintSpan(poly, 0, sEval, _span)) continue
        if (_span.lo > lineLo) lineLo = _span.lo
        if (_span.hi < lineHi) lineHi = _span.hi
      }
      const runLen = lineHi - lineLo - 2 * END_GAP
      if (runLen < MIN_LINE_RUN) continue
      const pieces = Math.max(1, Math.round(runLen / RAFTER_RUN))
      const stickLen = runLen / pieces
      for (let k = 0; k < pieces; k++) {
        const d = lineLo + END_GAP + (k + 0.5) * stickLen
        push(
          'rafter',
          p,
          [
            ex + across[0] * s + upSlope[0] * d - normal[0] * drop,
            ey + across[1] * s + upSlope[1] * d - normal[1] * drop,
            ez + across[2] * s + upSlope[2] * d - normal[2] * drop,
          ],
          [stickLen - STICK_GAP, RAFTER_D, RAFTER_W],
          memberYaw,
          pitch,
        )
      }
    }

    // Eave plate: flat 2×4 sticks along the eave, directly under the
    // rafter feet (rafter underside at the eave, then half a plate down).
    const plateY = ey - normal[1] * (RAFTER_TOP_DROP + RAFTER_D) - PLATE_T / 2
    const plateRun = eaveLength - 2 * END_GAP
    const platePieces = Math.max(1, Math.round(plateRun / RAFTER_RUN))
    const plateLen = plateRun / platePieces
    for (let k = 0; k < platePieces; k++) {
      const s = ((k + 0.5) / platePieces - 0.5) * plateRun
      push(
        'plate',
        p,
        [
          ex + across[0] * s - normal[0] * (RAFTER_TOP_DROP + RAFTER_D),
          plateY,
          ez + across[2] * s - normal[2] * (RAFTER_TOP_DROP + RAFTER_D),
        ],
        [plateLen - STICK_GAP, PLATE_T, PLATE_W],
        yaw,
        0,
      )
    }

    // Ridge extent: the footprint's across span just under its upper edge —
    // a hip trapezoid's ridge is much shorter than its eave, so the board
    // must not run the full eave length (it floated past both hip ends).
    let topMid = 0
    let topLen = eaveLength
    if (poly && footprintSpan(poly, 1, Math.max(0, slopeLength - 0.01), _span)) {
      topMid = (_span.lo + _span.hi) / 2
      topLen = _span.hi - _span.lo
    }
    ridgePoints.push({
      plane: p,
      x: ex + upSlope[0] * slopeLength,
      y: ey + upSlope[1] * slopeLength,
      z: ez + upSlope[2] * slopeLength,
      yaw,
      eaveLength,
      topMid,
      topLen,
    })
  }

  // Ridge boards — one per coincident opposite-yaw plane pair. A shed's
  // top edge bears on a wall (no partner), so it never grows a board.
  const used = new Set<number>()
  for (let i = 0; i < ridgePoints.length; i++) {
    if (used.has(i)) continue
    const a = ridgePoints[i]!
    for (let j = i + 1; j < ridgePoints.length; j++) {
      if (used.has(j)) continue
      const b = ridgePoints[j]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      if (dx * dx + dy * dy + dz * dz > RIDGE_MATCH_DIST * RIDGE_MATCH_DIST) continue
      const dyaw = Math.abs(wrapAngle(a.yaw - b.yaw + Math.PI))
      if (dyaw > RIDGE_MATCH_YAW) continue
      used.add(i)
      used.add(j)
      const ax = Math.cos(a.yaw)
      const az = Math.sin(a.yaw)
      // Board run = the SHORTER footprint ridge extent of the pair, centered
      // on plane a's upper-edge midpoint (hip trapezoids: the real ridge,
      // not the full eave).
      const run = Math.min(a.topLen, b.topLen) - 2 * END_GAP
      if (run < MIN_LINE_RUN) break
      const cx = (a.x + b.x) / 2 + ax * a.topMid
      const cy = (a.y + b.y) / 2 - RIDGE_D / 2 // board top touches the seam
      const cz = (a.z + b.z) / 2 + az * a.topMid
      const pieces = Math.max(1, Math.round(run / RAFTER_RUN))
      const len = run / pieces
      for (let k = 0; k < pieces; k++) {
        const s = ((k + 0.5) / pieces - 0.5) * run
        push(
          'ridge',
          a.plane,
          [cx + ax * s, cy, cz + az * s],
          [len - STICK_GAP, RIDGE_D, RAFTER_W],
          a.yaw,
          0,
        )
      }
      break
    }
  }

  return members
}

/**
 * Per-plane view for the one-target-per-plane roof model: groups by
 * `planeIndex` and RE-IDS each group 0..n−1 IN PLACE (SegmentMember ids
 * must be unique within a target). The flat input array's ids are stale
 * afterwards — keep exactly one of the two views.
 */
export function splitRaftersByPlane(
  members: readonly RafterMember[],
  planeCount: number,
): RafterMember[][] {
  const groups: RafterMember[][] = Array.from({ length: planeCount }, () => [])
  for (const member of members) {
    const group = groups[member.planeIndex]
    if (!group) continue
    member.id = group.length
    group.push(member)
  }
  return groups
}
