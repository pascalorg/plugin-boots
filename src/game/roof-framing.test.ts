import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, Color, Quaternion, Vector3 } from 'three'
import { sfx } from './audio'
import { clearDebris, debrisCensus, spawnFlatDebris } from './debris'
import {
  damageSegment,
  resetDestruction,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import {
  buildRafters,
  RAFTER_D,
  RAFTER_HP,
  RAFTER_RUN,
  RAFTER_SPACING,
  RAFTER_TOP_DROP,
  RAFTER_W,
  rafterObbBasis,
  RIDGE_D,
  type RoofPlaneBasis,
  roofPlaneFrame,
  splitRaftersByPlane,
} from './roof-framing'
import { raycastObb, raycastYawObb, type VoxelGridData, yawBasis } from './voxel'
import type { GameWorld } from './world'

/**
 * Rafters lane, headless (MULTILEVEL-PLAN Phase C3): layout on a synthetic
 * gable plane pair (count / 24" spacing / orientation straight from the
 * yaw+pitch basis), the 2×6 section, ridge pairing (sheds never grow a
 * board), the OBB basis contract against voxel.ts raycasts, and hp
 * semantics through the SHARED segment damage path — a rafter chips and
 * snaps exactly like a stud because it IS a SegmentMember.
 */

const PSI = Math.PI / 6
const THETA = (35 * Math.PI) / 180
const EAVE_LEN = 7.2
const SLOPE_LEN = 3.0
const EAVE_CENTER: [number, number, number] = [2, 3.05, 1]

function frontPlane(): RoofPlaneBasis {
  return {
    yaw: PSI,
    pitch: THETA,
    eaveCenter: EAVE_CENTER,
    eaveLength: EAVE_LEN,
    slopeLength: SLOPE_LEN,
  }
}

/** The opposite gable face — eave placed so both ridge lines coincide. */
function backPlane(): RoofPlaneBasis {
  const front = roofPlaneFrame(PSI, THETA)
  const back = roofPlaneFrame(PSI + Math.PI, THETA)
  const ridge = [
    EAVE_CENTER[0] + front.upSlope[0] * SLOPE_LEN,
    EAVE_CENTER[1] + front.upSlope[1] * SLOPE_LEN,
    EAVE_CENTER[2] + front.upSlope[2] * SLOPE_LEN,
  ] as const
  return {
    yaw: PSI + Math.PI,
    pitch: THETA,
    eaveCenter: [
      ridge[0] - back.upSlope[0] * SLOPE_LEN,
      ridge[1] - back.upSlope[1] * SLOPE_LEN,
      ridge[2] - back.upSlope[2] * SLOPE_LEN,
    ],
    eaveLength: EAVE_LEN,
    slopeLength: SLOPE_LEN,
  }
}

function gableMembers() {
  return buildRafters(null, [{ roofType: 'gable' }], [frontPlane(), backPlane()])
}

/** The debris ring is a fixed-size pool that only recycles on an update tick,
 * and nothing here ticks it: arriving FULL, it refuses every new particle and
 * `debrisCensus().live` stops rising — which is exactly what the rafter chip
 * asserts (seed 246810 read 768 before and 768 after). Empty is a state; take
 * it going in, not just coming out. */
const isolate = () => {
  resetDestruction()
  clearDebris()
}
beforeEach(isolate)
afterEach(isolate)

describe('roofPlaneFrame', () => {
  test('across/normal/upSlope form the documented right-handed roof frame', () => {
    const { across, normal, upSlope } = roofPlaneFrame(PSI, THETA)
    const a = new Vector3(...across)
    const n = new Vector3(...normal)
    const u = new Vector3(...upSlope)
    // Unit + orthogonal, eave direction horizontal, normal leans cos(pitch).
    expect(a.length()).toBeCloseTo(1, 9)
    expect(n.length()).toBeCloseTo(1, 9)
    expect(u.length()).toBeCloseTo(1, 9)
    expect(a.dot(n)).toBeCloseTo(0, 9)
    expect(a.dot(u)).toBeCloseTo(0, 9)
    expect(n.dot(u)).toBeCloseTo(0, 9)
    expect(a.y).toBeCloseTo(0, 9)
    expect(n.y).toBeCloseTo(Math.cos(THETA), 9)
    expect(u.y).toBeCloseTo(Math.sin(THETA), 9)
    // Right-handed: across × normal = upSlope.
    expect(a.clone().cross(n).distanceTo(u)).toBeCloseTo(0, 9)
  })
})

describe('buildRafters — gable plane layout', () => {
  test('24" o.c. lines split into ~1.4 m sticks of 2×6 at hp 2', () => {
    const members = gableMembers()
    const rafters = members.filter((m) => m.role === 'rafter' && m.planeIndex === 0)
    const lines = Math.max(2, Math.floor(EAVE_LEN / RAFTER_SPACING) + 1)
    const runLen = SLOPE_LEN - 0.04
    const pieces = Math.max(1, Math.round(runLen / RAFTER_RUN))
    expect(lines).toBe(12)
    expect(pieces).toBe(2)
    expect(rafters.length).toBe(lines * pieces)
    // Both planes frame identically.
    expect(members.filter((m) => m.role === 'rafter' && m.planeIndex === 1).length).toBe(
      lines * pieces,
    )
    for (const m of rafters) {
      // Real 2×6: 38 mm across the plane, 140 mm along the normal, the
      // long axis is the ~1.4 m stick run up the slope.
      expect(m.size[0]).toBeCloseTo(runLen / pieces - 0.012, 9)
      expect(m.size[1]).toBeCloseTo(RAFTER_D, 9)
      expect(m.size[2]).toBeCloseTo(RAFTER_W, 9)
      expect(m.hp).toBe(RAFTER_HP)
      expect(m.broken).toBe(false)
      expect(m.pitch).toBeCloseTo(THETA, 9)
    }
    // Ids are unique array indices across the whole build (target contract).
    expect(new Set(members.map((m) => m.id)).size).toBe(members.length)
    members.forEach((m, i) => expect(m.id).toBe(i))
  })

  test('lines land 24" apart along the eave; sticks march up the slope', () => {
    const members = gableMembers()
    const rafters = members.filter((m) => m.role === 'rafter' && m.planeIndex === 0)
    const { across, normal, upSlope } = roofPlaneFrame(PSI, THETA)
    const a = new Vector3(...across)
    const n = new Vector3(...normal)
    const u = new Vector3(...upSlope)
    const eave = new Vector3(...EAVE_CENTER)
    const rel = new Vector3()
    const offsets = new Set<number>()
    for (const m of rafters) {
      rel.set(m.center[0], m.center[1], m.center[2]).sub(eave)
      // Tops exactly RAFTER_TOP_DROP under the inner skin.
      expect(rel.dot(n)).toBeCloseTo(-(RAFTER_TOP_DROP + RAFTER_D / 2), 6)
      // Stick centers sit mid-run up the slope (2 sticks on a 3 m slope).
      const d = rel.dot(u)
      const stick = (SLOPE_LEN - 0.04) / 2
      const near = Math.abs(d - (0.02 + 0.5 * stick)) < 1e-6 || Math.abs(d - (0.02 + 1.5 * stick)) < 1e-6
      expect(near).toBe(true)
      offsets.add(+rel.dot(a).toFixed(6))
    }
    const sorted = [...offsets].sort((x, y) => x - y)
    expect(sorted.length).toBe(12)
    expect(sorted[0]).toBeCloseTo(-EAVE_LEN / 2, 6)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeCloseTo(RAFTER_SPACING, 6)
    }
  })

  test('member yaw/pitch encode the up-slope long axis (ψ ± π/2 convention)', () => {
    const members = gableMembers()
    const { upSlope } = roofPlaneFrame(PSI, THETA)
    const u = new Vector3(...upSlope)
    const m = members.find((x) => x.role === 'rafter' && x.planeIndex === 0)!
    // Long axis from (yaw, pitch): (cosθ·cos yaw, sinθ, cosθ·sin yaw).
    const axis = new Vector3(
      Math.cos(m.pitch) * Math.cos(m.yaw),
      Math.sin(m.pitch),
      Math.cos(m.pitch) * Math.sin(m.yaw),
    )
    expect(axis.distanceTo(u)).toBeCloseTo(0, 9)
    // ...and that yaw is the plane yaw quarter-turned into the slope.
    const expected = Math.atan2(Math.sin(PSI + Math.PI / 2), Math.cos(PSI + Math.PI / 2))
    expect(m.yaw).toBeCloseTo(expected, 9)
  })

  test('flat planes, tiny planes, and all-flat roofs never frame', () => {
    const flat: RoofPlaneBasis = { ...frontPlane(), pitch: 0 }
    const sliver: RoofPlaneBasis = { ...frontPlane(), eaveLength: 0.2 }
    expect(buildRafters(null, undefined, [flat, sliver]).length).toBe(0)
    expect(buildRafters(null, [{ roofType: 'flat' }], [frontPlane()]).length).toBe(0)
    expect(buildRafters(null, [], []).length).toBe(0)
  })
})

describe('buildRafters — footprint clipping (QA phase-6 round 3)', () => {
  const E = EAVE_LEN
  const S = SLOPE_LEN

  test('a rectangular footprint reproduces the unclipped layout exactly', () => {
    const rect: RoofPlaneBasis = {
      ...frontPlane(),
      polyTris: [-E / 2, 0, E / 2, 0, E / 2, S, -E / 2, 0, E / 2, S, -E / 2, S],
    }
    const clipped = buildRafters(null, [{ roofType: 'shed' }], [rect])
    const plain = buildRafters(null, [{ roofType: 'shed' }], [frontPlane()])
    expect(clipped.length).toBe(plain.length)
    clipped.forEach((m, i) => {
      expect(m.center[0]).toBeCloseTo(plain[i]!.center[0], 6)
      expect(m.center[1]).toBeCloseTo(plain[i]!.center[1], 6)
      expect(m.center[2]).toBeCloseTo(plain[i]!.center[2], 6)
      expect(m.size[0]).toBeCloseTo(plain[i]!.size[0], 9)
    })
  })

  test('a triangular hip-end plane shortens its jacks and drops the rake lines', () => {
    const hip: RoofPlaneBasis = {
      ...frontPlane(),
      polyTris: [-E / 2, 0, E / 2, 0, 0, S], // apex on the ridge line
    }
    const members = buildRafters(null, [{ roofType: 'hip' }], [hip])
    const rafters = members.filter((m) => m.role === 'rafter')
    const plain = buildRafters(null, [{ roofType: 'hip' }], [frontPlane()]).filter(
      (m) => m.role === 'rafter',
    )
    // Rake-edge lines vanish, corner jacks lose sticks — strictly fewer.
    expect(rafters.length).toBeGreaterThan(0)
    expect(rafters.length).toBeLessThan(plain.length)
    const { across, upSlope } = roofPlaneFrame(PSI, THETA)
    const a = new Vector3(...across)
    const u = new Vector3(...upSlope)
    const eave = new Vector3(...EAVE_CENTER)
    const rel = new Vector3()
    const runs = new Set<number>()
    for (const m of rafters) {
      rel.set(m.center[0], m.center[1], m.center[2]).sub(eave)
      const off = rel.dot(a)
      const top = rel.dot(u) + m.size[0] / 2
      // Every stick stays INSIDE the triangle: its top never passes the
      // hip edge for its line (and so never pokes past the ridge apex).
      const lineMax = S * (1 - Math.abs(off) / (E / 2))
      expect(top).toBeLessThanOrEqual(lineMax + 1e-6)
      expect(top).toBeLessThan(S)
      runs.add(+m.size[0].toFixed(4))
    }
    // Jack rafters really do vary in length across the triangle.
    expect(runs.size).toBeGreaterThan(2)
  })

  test('hip trapezoids clip the ridge board to the REAL ridge, not the eave', () => {
    const R = 3 // ridge length ≪ eave length
    const trapezoid = (base: RoofPlaneBasis): RoofPlaneBasis => ({
      ...base,
      polyTris: [-E / 2, 0, E / 2, 0, R / 2, S, -E / 2, 0, R / 2, S, -R / 2, S],
    })
    const members = buildRafters(
      null,
      [{ roofType: 'hip' }],
      [trapezoid(frontPlane()), trapezoid(backPlane())],
    )
    const ridge = members.filter((m) => m.role === 'ridge')
    expect(ridge.length).toBe(Math.max(1, Math.round((R - 0.04) / RAFTER_RUN)))
    const { across, upSlope } = roofPlaneFrame(PSI, THETA)
    const a = new Vector3(...across)
    const mid = new Vector3(...EAVE_CENTER).addScaledVector(new Vector3(...upSlope), SLOPE_LEN)
    const rel = new Vector3()
    for (const m of ridge) {
      rel.set(m.center[0], m.center[1], m.center[2]).sub(mid)
      // Board ends stay within the trapezoid's upper edge.
      expect(Math.abs(rel.dot(a)) + m.size[0] / 2).toBeLessThanOrEqual(R / 2 + 1e-6)
    }
  })
})

describe('buildRafters — ridge boards + eave plates', () => {
  test('a gable pair grows ONE ridge board run, seated under the seam', () => {
    const members = gableMembers()
    const ridge = members.filter((m) => m.role === 'ridge')
    const run = EAVE_LEN - 0.04
    expect(ridge.length).toBe(Math.max(1, Math.round(run / RAFTER_RUN)))
    const { upSlope } = roofPlaneFrame(PSI, THETA)
    const ridgeY = EAVE_CENTER[1] + upSlope[1] * SLOPE_LEN
    for (const m of ridge) {
      expect(m.pitch).toBe(0)
      expect(m.planeIndex).toBe(0)
      expect(m.yaw).toBeCloseTo(PSI, 9)
      expect(m.size[1]).toBeCloseTo(RIDGE_D, 9)
      expect(m.center[1]).toBeCloseTo(ridgeY - RIDGE_D / 2, 6)
    }
  })

  test('a lone shed plane gets rafters + plates but NO ridge board', () => {
    const members = buildRafters(null, [{ roofType: 'shed' }], [frontPlane()])
    expect(members.some((m) => m.role === 'rafter')).toBe(true)
    expect(members.some((m) => m.role === 'plate')).toBe(true)
    expect(members.some((m) => m.role === 'ridge')).toBe(false)
  })

  test('eave plates run flat under the rafter feet', () => {
    const members = gableMembers()
    const plates = members.filter((m) => m.role === 'plate' && m.planeIndex === 0)
    expect(plates.length).toBeGreaterThan(0)
    for (const m of plates) {
      expect(m.pitch).toBe(0)
      expect(m.yaw).toBeCloseTo(PSI, 9)
      expect(m.center[1]).toBeLessThan(EAVE_CENTER[1]) // below the inner skin
    }
  })

  test('splitRaftersByPlane groups by plane and re-ids each group', () => {
    const members = gableMembers()
    const total = members.length
    const groups = splitRaftersByPlane(members, 2)
    expect(groups.length).toBe(2)
    expect(groups[0]!.length + groups[1]!.length).toBe(total)
    for (const group of groups) {
      group.forEach((m, i) => expect(m.id).toBe(i))
    }
    // The ridge run rides the lower-indexed plane of its pair.
    expect(groups[0]!.some((m) => m.role === 'ridge')).toBe(true)
    expect(groups[1]!.some((m) => m.role === 'ridge')).toBe(false)
  })
})

describe('rafterObbBasis — the raycast contract', () => {
  test('matches Qz(−pitch)·Qy(yaw) and degenerates to yawBasis at pitch 0', () => {
    const q = rafterObbBasis(PSI + Math.PI / 2, THETA)
    const ref = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), -THETA)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), PSI + Math.PI / 2))
    expect(q.x).toBeCloseTo(ref.x, 9)
    expect(q.y).toBeCloseTo(ref.y, 9)
    expect(q.z).toBeCloseTo(ref.z, 9)
    expect(q.w).toBeCloseTo(ref.w, 9)
    const flat = rafterObbBasis(0.7, 0)
    const yawOnly = yawBasis(0.7)
    expect(flat.x).toBeCloseTo(yawOnly.x, 12)
    expect(flat.y).toBeCloseTo(yawOnly.y, 12)
    expect(flat.z).toBeCloseTo(yawOnly.z, 12)
    expect(flat.w).toBeCloseTo(yawOnly.w, 12)
  })

  test('raycastObb hits a pitched rafter dead-on along the plane normal', () => {
    const members = gableMembers()
    const m = members.find((x) => x.role === 'rafter')!
    const { across, normal } = roofPlaneFrame(PSI, THETA)
    const n = new Vector3(...normal)
    const origin = new Vector3(m.center[0], m.center[1], m.center[2]).addScaledVector(n, 2)
    const basis = rafterObbBasis(m.yaw, m.pitch)
    const hit = raycastObb(
      origin.x, origin.y, origin.z,
      -n.x, -n.y, -n.z,
      m.center[0], m.center[1], m.center[2],
      m.size[0] / 2, m.size[1] / 2, m.size[2] / 2,
      basis,
      10,
    )
    // Member local Y IS the plane normal → entry at half the 140 mm depth.
    expect(hit).not.toBeNull()
    expect(hit!).toBeCloseTo(2 - RAFTER_D / 2, 6)
    // Sliding one stick-width across the eave misses the 38 mm face.
    const a = new Vector3(...across)
    const off = origin.clone().addScaledVector(a, RAFTER_W / 2 + 0.03)
    expect(
      raycastObb(
        off.x, off.y, off.z,
        -n.x, -n.y, -n.z,
        m.center[0], m.center[1], m.center[2],
        m.size[0] / 2, m.size[1] / 2, m.size[2] / 2,
        basis,
        10,
      ),
    ).toBeNull()
  })

  test('pitch-0 members raycast identically through raycastObb and raycastYawObb', () => {
    const args = [1.2, 0.4, -0.3, -0.6, -0.2, 0.75] as const // origin + dir-ish
    const dir = new Vector3(args[3], args[4], args[5]).normalize()
    const viaYaw = raycastYawObb(
      args[0], args[1], args[2], dir.x, dir.y, dir.z,
      0.2, 0.1, 0.5, 0.7, 0.05, 0.3, 0.9, 20,
    )
    const viaBasis = raycastObb(
      args[0], args[1], args[2], dir.x, dir.y, dir.z,
      0.2, 0.1, 0.5, 0.7, 0.05, 0.3, rafterObbBasis(0.9, 0), 20,
    )
    expect(viaYaw).not.toBeNull()
    expect(viaBasis).not.toBeNull()
    expect(viaBasis!).toBeCloseTo(viaYaw!, 9)
  })
})

// ── hp semantics through the SHARED damage path ─────────────────────────────

function stubGrid(): VoxelGridData {
  return {
    cell: 0.15,
    cellX: 0.15,
    cellY: 0.15,
    cellZ: 0.15,
    nx: 0,
    ny: 0,
    nz: 0,
    yaw: 0,
    q: { x: 0, y: 0, z: 0, w: 1 },
    origin: { x: 0, y: 0, z: 0 },
    count: 0,
    coords: new Int16Array(0),
    centers: new Float32Array(0),
    alive: new Uint8Array(0),
    aliveCount: 0,
    index: new Map(),
  }
}

function stubWorld(): GameWorld {
  return {
    colliders: [],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: new Box3(),
    spawn: new Vector3(),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('rafters ride the shared segment damage path', () => {
  test('damageSegment chips a rafter, then snaps it, exactly like a stud', () => {
    const segments = gableMembers()
    const target: VoxelTarget = {
      nodeId: 'roof-1',
      kind: 'volume',
      grid: stubGrid(),
      baseColor: new Color('#8a7f72'),
      segments,
      studs: segments,
      sheets: [],
      sheetByCell: new Int32Array(0),
      removedQueue: [],
      revision: 0,
    }
    useDestruction.getState().targets.set('roof-1', target)
    const world = stubWorld()
    const m = segments.find((x) => x.role === 'rafter')!
    const point = new Vector3(m.center[0], m.center[1], m.center[2])

    const before = debrisCensus().live
    // Chip: hp 2 → 1, splinters fly, stick stands.
    expect(damageSegment(world, 'roof-1', m.id, 1, point)).toBe(true)
    expect(m.hp).toBe(RAFTER_HP - 1)
    expect(m.broken).toBe(false)
    expect(debrisCensus().live).toBeGreaterThan(before)
    // Snap: charcoal-stick break, revision bump for the member layer.
    const revision = target.revision
    expect(damageSegment(world, 'roof-1', m.id, 24, point)).toBe(true)
    expect(m.hp).toBe(0)
    expect(m.broken).toBe(true)
    expect(target.revision).toBe(revision + 1)
    // A broken stick eats no further damage (same contract as studs).
    expect(damageSegment(world, 'roof-1', m.id, 1, point)).toBe(false)
  })
})

describe('roof feel hooks (audio + debris tone)', () => {
  test('sfx.shingleRip exists and is a headless no-op', () => {
    expect(typeof sfx.shingleRip).toBe('function')
    expect(() => sfx.shingleRip()).not.toThrow()
  })

  test("spawnFlatDebris 'shingle' tone spawns a plate; default stays drywall", () => {
    const base = debrisCensus().flats
    spawnFlatDebris(0, 2, 0, 0.2, 0.25, new Color('#6b6259'), { x: 0, y: -1, z: 0 }, 'shingle')
    expect(debrisCensus().flats).toBe(base + 1)
    spawnFlatDebris(0, 2, 0, 0.2, 0.25, new Color('#e8e4dc'))
    expect(debrisCensus().flats).toBe(base + 2)
  })
})
