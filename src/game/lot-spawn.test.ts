import { describe, expect, test } from 'bun:test'
import {
  RING_MIN,
  RING_MIN_ON_LOT,
  RING_SPAN,
  waveSpawnXZ,
} from './enemies-state'
import {
  LOT_SPAWN_INSET,
  lotPerimeterPoint,
  lotRadiusAlong,
  pointInPolygonXZ,
} from './world'

/**
 * WAVE SPAWNS STAND ON THE LOT — the other half of the y = 0 sweep.
 *
 * The ring spawner picked a random bearing and a 22–34 m radius around the
 * building's center and trusted the world to have ground there. On the owner's
 * real project it does not: past the site polygon the parcel carries no
 * terrain and no collider, so a bot born out there settled onto the session's
 * backstop plane (−5.61 m on warner-2) and marched in from UNDER the world.
 * Observed spawns: (−4.46, −35.35) and (−29.64, 1.32), both off the parcel.
 *
 * Everything here is pure geometry: no three.js, no BVH, no host. The two
 * primitives (world.ts) are tested directly, then the placement policy
 * (enemies-state.waveSpawnXZ) on top of them. The invariant every case
 * asserts is the same one: THE POINT IS INSIDE THE POLYGON.
 */

/** A generous parcel: 40 × 40 m centred on the origin. */
const SQUARE: Array<[number, number]> = [
  [-20, -20],
  [20, -20],
  [20, 20],
  [-20, 20],
]

/**
 * An L-shaped parcel (the concave case). The notch matters: a ray from the
 * origin can LEAVE the lot and re-enter it further out, so "first crossing
 * wins" would refuse the whole far arm.
 *
 *   z=30 ┌──────┐
 *        │      │
 *   z=10 │  ┌───┘        the notch: x > 10, 10 < z < 30
 *        │  │
 *    z=0 └──┘
 *       x=0 10   30
 */
const ELL: Array<[number, number]> = [
  [0, 0],
  [30, 0],
  [30, 10],
  [10, 10],
  [10, 30],
  [0, 30],
]

/** A parcel narrower than 2 × LOT_SPAWN_INSET: nothing can be inset into it. */
const SLIVER: Array<[number, number]> = [
  [-20, -1],
  [20, -1],
  [20, 1],
  [-20, 1],
]

// ---------------------------------------------------------------------------
// lotRadiusAlong — the deterministic clamp
// ---------------------------------------------------------------------------

describe('lotRadiusAlong', () => {
  test('no polygon is not a lot: the desired radius passes through untouched', () => {
    // The void / flat-scene path. Byte-identical to the ring before the clamp.
    expect(lotRadiusAlong([], 0, 0, 1, 0, 30)).toBe(30)
    expect(lotRadiusAlong([[0, 0]], 0, 0, 1, 0, 30)).toBe(30)
    expect(
      lotRadiusAlong(
        [
          [0, 0],
          [1, 1],
        ],
        0,
        0,
        1,
        0,
        30,
      ),
    ).toBe(30)
  })

  test('a radius that already fits the lot is left alone', () => {
    expect(lotRadiusAlong(SQUARE, 0, 0, 1, 0, 10)).toBe(10)
    expect(lotRadiusAlong(SQUARE, 0, 0, 0, -1, 18)).toBe(18)
  })

  test('a radius past the boundary is shortened to the boundary minus the inset', () => {
    // +X wall at x = 20, so the clamp is 20 − 1.5.
    expect(lotRadiusAlong(SQUARE, 0, 0, 1, 0, 30)).toBeCloseTo(20 - LOT_SPAWN_INSET, 9)
    expect(lotRadiusAlong(SQUARE, 0, 0, -1, 0, 30)).toBeCloseTo(20 - LOT_SPAWN_INSET, 9)
    expect(lotRadiusAlong(SQUARE, 0, 0, 0, 1, 1e4)).toBeCloseTo(20 - LOT_SPAWN_INSET, 9)
  })

  test('the direction need not be a unit vector (the inset stays in metres)', () => {
    const diagonal = lotRadiusAlong(SQUARE, 0, 0, 3, 3, 40)!
    // The +X/+Z corner is at distance 20·√2 along the diagonal.
    expect(diagonal).toBeCloseTo(20 * Math.SQRT2 - LOT_SPAWN_INSET, 9)
    // Scaling the direction cannot change the answer.
    expect(lotRadiusAlong(SQUARE, 0, 0, 1, 1, 40)).toBeCloseTo(diagonal, 9)
  })

  test('the clamped radius always lands inside the lot, on every bearing', () => {
    for (const polygon of [SQUARE, ELL]) {
      // ELL's interior contains (5, 5); SQUARE's contains the origin.
      const cx = polygon === ELL ? 5 : 0
      const cz = polygon === ELL ? 5 : 0
      for (let i = 0; i < 360; i++) {
        const angle = (i * Math.PI) / 180
        const dirX = Math.cos(angle)
        const dirZ = Math.sin(angle)
        const radius = lotRadiusAlong(polygon, cx, cz, dirX, dirZ, RING_MIN + RING_SPAN)
        expect(radius).not.toBeNull()
        expect(pointInPolygonXZ(polygon, cx + dirX * radius!, cz + dirZ * radius!)).toBe(true)
      }
    }
  })

  test('a concave lot keeps its far arm: the ray may leave and re-enter', () => {
    // From (5, 5) straight up +Z: inside 5→10 (the spine's first stretch is
    // continuous to z = 30 at x = 5, so this bearing has ONE long run).
    expect(lotRadiusAlong(ELL, 5, 5, 0, 1, 30)).toBeCloseTo(25 - LOT_SPAWN_INSET, 9)
    // From (5, 20) along +X: inside until x = 10 (the notch), then OUTSIDE,
    // and there is no further run — the clamp stops at the notch wall.
    const notch = lotRadiusAlong(ELL, 5, 20, 1, 0, 30)!
    expect(notch).toBeCloseTo(5 - LOT_SPAWN_INSET, 9)
    // Crossing the notch diagonally from (5, 20) toward (30, 5) leaves the
    // spine and re-enters the lower arm — the far run is reachable and the
    // clamp prefers it, because it lands nearer the desired 30 m.
    const dirX = 25
    const dirZ = -15
    const far = lotRadiusAlong(ELL, 5, 20, dirX, dirZ, 30)!
    const len = Math.hypot(dirX, dirZ)
    expect(pointInPolygonXZ(ELL, 5 + (dirX / len) * far, 20 + (dirZ / len) * far)).toBe(true)
    // …and it really is the FAR run, past the notch the ray crosses.
    expect(far).toBeGreaterThan(10)
  })

  test('a ring center off the lot still lands its spawn on the lot', () => {
    // Center 40 m west of the parcel, aiming east: the runs start OUTSIDE.
    const radius = lotRadiusAlong(SQUARE, -60, 0, 1, 0, 30)!
    expect(pointInPolygonXZ(SQUARE, -60 + radius, 0)).toBe(true)
    // Nearest reachable radius to the desired 30 is the lot's near edge + inset.
    expect(radius).toBeCloseTo(40 + LOT_SPAWN_INSET, 9)
  })

  test('a lot too thin to inset degenerates to the run midpoint, not to nothing', () => {
    const radius = lotRadiusAlong(SLIVER, 0, 0, 0, 1, 30)!
    // The +Z run is 0 → 1; 2 × inset does not fit, so the midpoint answers.
    expect(radius).toBeCloseTo(0.5, 9)
    expect(pointInPolygonXZ(SLIVER, 0, radius)).toBe(true)
  })

  test('null when the ray never reaches the lot at all', () => {
    // Origin west of the parcel, aiming further west.
    expect(lotRadiusAlong(SQUARE, -60, 0, -1, 0, 30)).toBeNull()
    // Parallel to a wall, outside it.
    expect(lotRadiusAlong(SQUARE, 0, 40, 1, 0, 30)).toBeNull()
  })

  test('deterministic: the same inputs give the same radius', () => {
    const first = lotRadiusAlong(ELL, 5, 5, 0.4, 0.9, 33)
    for (let i = 0; i < 8; i++) expect(lotRadiusAlong(ELL, 5, 5, 0.4, 0.9, 33)).toBe(first)
  })
})

// ---------------------------------------------------------------------------
// lotPerimeterPoint — the bounded fallback
// ---------------------------------------------------------------------------

describe('lotPerimeterPoint', () => {
  test('every fraction of the way round lands inside the lot', () => {
    for (const polygon of [SQUARE, ELL]) {
      for (let i = 0; i < 64; i++) {
        const point = lotPerimeterPoint(polygon, i / 64)
        expect(point).not.toBeNull()
        expect(pointInPolygonXZ(polygon, point![0], point![1])).toBe(true)
      }
    }
  })

  test('winding-agnostic: a reversed polygon still insets INWARD', () => {
    const reversed = [...SQUARE].reverse()
    for (let i = 0; i < 16; i++) {
      const point = lotPerimeterPoint(reversed, i / 16)!
      expect(pointInPolygonXZ(reversed, point[0], point[1])).toBe(true)
    }
  })

  test('it spreads: distinct fractions give distinct, well-separated points', () => {
    const points: Array<[number, number]> = []
    for (let i = 0; i < 8; i++) points.push(lotPerimeterPoint(SQUARE, (i + 0.5) / 8)!)
    let closest = Number.POSITIVE_INFINITY
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        closest = Math.min(closest, Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]))
      }
    }
    // A 160 m perimeter over 8 spawns is 20 m of edge between neighbours; the
    // tightest pair straddles a corner (a 20 m walk is a ~14 m chord there,
    // ~12 m once both ends are inset). Nothing like a stack.
    expect(closest).toBeGreaterThan(10)
  })

  test('a sliver returns the boundary point itself rather than nothing', () => {
    const point = lotPerimeterPoint(SLIVER, 0.25)
    expect(point).not.toBeNull()
    // Neither offset fits, so the point sits ON the edge — still the parcel.
    expect(Math.abs(point![1])).toBeLessThanOrEqual(1)
  })

  test('degenerate polygons answer null', () => {
    expect(lotPerimeterPoint([], 0.5)).toBeNull()
    expect(
      lotPerimeterPoint(
        [
          [0, 0],
          [1, 0],
        ],
        0.5,
      ),
    ).toBeNull()
    expect(
      lotPerimeterPoint(
        [
          [3, 3],
          [3, 3],
          [3, 3],
        ],
        0.5,
      ),
    ).toBeNull()
  })

  test('fractions outside [0, 1) wrap instead of clamping', () => {
    const at = (f: number) => lotPerimeterPoint(SQUARE, f)!
    expect(at(1.25)[0]).toBeCloseTo(at(0.25)[0], 9)
    expect(at(1.25)[1]).toBeCloseTo(at(0.25)[1], 9)
    expect(at(-0.75)[0]).toBeCloseTo(at(0.25)[0], 9)
  })
})

// ---------------------------------------------------------------------------
// waveSpawnXZ — the placement policy
// ---------------------------------------------------------------------------

describe('waveSpawnXZ', () => {
  const out: [number, number] = [0, 0]

  test('no site polygon: the raw ring point, exactly as before the clamp', () => {
    waveSpawnXZ(undefined, 3, -4, Math.PI / 6, 30, 0.5, out)
    expect(out[0]).toBeCloseTo(3 + Math.cos(Math.PI / 6) * 30, 12)
    expect(out[1]).toBeCloseTo(-4 + Math.sin(Math.PI / 6) * 30, 12)
    // …and an empty polygon is treated the same way (a site with no points).
    waveSpawnXZ([], 3, -4, Math.PI / 6, 30, 0.5, out)
    expect(out[0]).toBeCloseTo(3 + Math.cos(Math.PI / 6) * 30, 12)
  })

  test('a whole wave lands on the lot, on a parcel the ring overflows', () => {
    const count = 13 // wave 5: 3 + 5 × 2
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      waveSpawnXZ(SQUARE, 0, 0, angle, RING_MIN + (i / count) * RING_SPAN, (i + 0.5) / count, out)
      expect(pointInPolygonXZ(SQUARE, out[0], out[1])).toBe(true)
    }
  })

  test('the bearing is preserved: the clamp shortens, it never rotates', () => {
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2
      waveSpawnXZ(SQUARE, 0, 0, angle, 34, 0.5, out)
      const bearing = Math.atan2(out[1], out[0])
      const delta = Math.abs(((bearing - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
      expect(delta).toBeLessThan(1e-9)
    }
  })

  test('the regression: both observed off-lot spawns now land on the parcel', () => {
    // The two coordinates the audit caught, replayed as bearings + radii from
    // a ring center at the origin on a 40 × 40 parcel.
    for (const [x, z] of [
      [-4.46, -35.35],
      [-29.64, 1.32],
    ]) {
      expect(pointInPolygonXZ(SQUARE, x!, z!)).toBe(false) // the bug
      waveSpawnXZ(SQUARE, 0, 0, Math.atan2(z!, x!), Math.hypot(x!, z!), 0.5, out)
      expect(pointInPolygonXZ(SQUARE, out[0], out[1])).toBe(true) // the fix
      // Same bearing, shorter radius.
      expect(Math.atan2(out[1], out[0])).toBeCloseTo(Math.atan2(z!, x!), 9)
      expect(Math.hypot(out[0], out[1])).toBeLessThan(Math.hypot(x!, z!))
    }
  })

  test('a small parcel falls back to the perimeter — spread, never stacked', () => {
    // 14 × 14 m: every clamped radius is under RING_MIN_ON_LOT, so the whole
    // wave takes the perimeter walk.
    const small: Array<[number, number]> = [
      [-7, -7],
      [7, -7],
      [7, 7],
      [-7, 7],
    ]
    const count = 9
    const points: Array<[number, number]> = []
    for (let i = 0; i < count; i++) {
      waveSpawnXZ(small, 0, 0, (i / count) * Math.PI * 2, 28, (i + 0.5) / count, out)
      expect(pointInPolygonXZ(small, out[0], out[1])).toBe(true)
      expect(Math.hypot(out[0], out[1])).toBeLessThan(RING_MIN_ON_LOT)
      points.push([out[0], out[1]])
    }
    // The degenerate fix this test exists to forbid: a wave on one point.
    let closest = Number.POSITIVE_INFINITY
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        closest = Math.min(closest, Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]))
      }
    }
    expect(closest).toBeGreaterThan(2)
  })

  test('a ring center off the lot still spawns on the lot', () => {
    for (let i = 0; i < 24; i++) {
      waveSpawnXZ(SQUARE, -60, 0, (i / 24) * Math.PI * 2, 30, (i + 0.5) / 24, out)
      expect(pointInPolygonXZ(SQUARE, out[0], out[1])).toBe(true)
    }
  })

  test('deterministic: no re-rolling hidden inside the placement', () => {
    waveSpawnXZ(ELL, 5, 5, 1.1, 33, 0.3, out)
    const first: [number, number] = [out[0], out[1]]
    for (let i = 0; i < 8; i++) {
      waveSpawnXZ(ELL, 5, 5, 1.1, 33, 0.3, out)
      expect(out[0]).toBe(first[0])
      expect(out[1]).toBe(first[1])
    }
  })
})
