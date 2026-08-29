import { describe, expect, test } from 'bun:test'
import { Box3, Group, Matrix4, Mesh, PlaneGeometry, Vector3 } from 'three'
import {
  scatter,
  scatterGroundY,
  shouldMountGroundDisc,
  SITE_FLAT_GROUND_Y,
} from './nature'
import { bvhFor, type GameWorld, pointInPolygonXZ, type SiteSnapshot } from './world'

/**
 * Nature over a host site (SITE-SPEC items 2 + 4, headless): the ground-disc
 * suppression gate (the host lot already renders its own ground + horizon —
 * the boots disc at y = 0.05 would fight it), and the scatter drape — every
 * instance clamped to the lot polygon and standing on the terrain surface
 * height plus its per-kind lift. Analytic path (host core exports the
 * terrain field), BVH-probe fallback, and the flat-site −0.05 fill are all
 * pinned. Rendering (<Nature/>) is DOM-bound and covered by the headed runs.
 */

const SQUARE: Array<[number, number]> = [
  [-30, -25],
  [30, -25],
  [30, 25],
  [-30, 25],
]

function makeSite(overrides: Partial<SiteSnapshot> = {}): SiteSnapshot {
  return {
    nodeId: 'site_1',
    root: new Group(),
    polygon: SQUARE,
    hasTerrain: false,
    surfaceHeightAt: null,
    ...overrides,
  }
}

function makeWorld(overrides: Partial<GameWorld> = {}): GameWorld {
  return {
    colliders: [],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: new Box3(new Vector3(-4, 0, -4), new Vector3(4, 3, 4)),
    spawn: new Vector3(),
    spawnYaw: 0,
    levelId: null,
    ...overrides,
  }
}

/** Site "terrain" collider: 60×50 m plane with world height y = 0.1 · x. */
function rampSiteCollider() {
  const geometry = new PlaneGeometry(60, 50, 6, 5)
  geometry.rotateX(-Math.PI / 2)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) position.setY(i, 0.1 * position.getX(i))
  geometry.computeBoundingBox()
  const mesh = new Mesh(geometry)
  mesh.updateMatrixWorld(true)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId: 'site_1',
    nodeType: 'site',
  }
}

describe('shouldMountGroundDisc — host ground wins', () => {
  test('no site ⇒ the boots disc mounts (legacy lots keep their lawn)', () => {
    expect(shouldMountGroundDisc({ site: null })).toBe(true)
    expect(shouldMountGroundDisc({})).toBe(true)
  })

  test('a collected site ⇒ the disc is suppressed entirely', () => {
    expect(shouldMountGroundDisc({ site: makeSite() })).toBe(false)
  })
})

describe('scatterGroundY — the drape base per sample', () => {
  test('no site ⇒ 0, the legacy lot plane (behavior unchanged)', () => {
    expect(scatterGroundY(makeWorld(), 3, 4)).toBe(0)
  })

  test('analytic path: the host field answers, colliders never probed', () => {
    const world = makeWorld({
      site: makeSite({ hasTerrain: true, surfaceHeightAt: (x, z) => 1 + 0.1 * x - 0.05 * z }),
    })
    expect(scatterGroundY(world, 10, 0)).toBeCloseTo(2, 6)
    expect(scatterGroundY(world, -10, 20)).toBeCloseTo(-1, 6)
  })

  test('BVH fallback: terrain site without host helpers probes the site colliders', () => {
    const world = makeWorld({
      site: makeSite({ hasTerrain: true, surfaceHeightAt: null }),
      colliders: [rampSiteCollider()],
    })
    expect(scatterGroundY(world, 10, 0)).toBeCloseTo(1, 4)
    expect(scatterGroundY(world, -10, 5)).toBeCloseTo(-1, 4)
  })

  test('terrain site, probe misses (off the collider) ⇒ the flat-fill floor, never NaN', () => {
    const world = makeWorld({
      site: makeSite({ hasTerrain: true, surfaceHeightAt: null }),
      colliders: [],
    })
    expect(scatterGroundY(world, 0, 0)).toBe(SITE_FLAT_GROUND_Y)
  })

  test('flat site (no terrain) ⇒ exactly the −0.05 polygon fill plane', () => {
    // With no collider coverage AND with a fill collider at −0.05 the answer
    // is the same plane — the clamp keeps numeric noise from sinking lower.
    expect(scatterGroundY(makeWorld({ site: makeSite() }), 5, 5)).toBe(SITE_FLAT_GROUND_Y)
    expect(SITE_FLAT_GROUND_Y).toBe(-0.05)
  })

  test('flat site clamp: a probed surface BELOW the fill clamps up to it', () => {
    // A dug flat-site collider (data pathology) must not sink flora under
    // the rendered fill: max(fill, probed).
    const dug = rampSiteCollider() // −3..+3 across the lot
    const world = makeWorld({ site: makeSite(), colliders: [dug] })
    expect(scatterGroundY(world, -20, 0)).toBe(SITE_FLAT_GROUND_Y) // probe −2 → clamp
    expect(scatterGroundY(world, 20, 0)).toBeCloseTo(2, 4) // probe +2 wins the max
  })
})

describe('scatter over a host site — polygon clamp + drape', () => {
  test('every instance lands inside the lot polygon and on surface + lift', () => {
    const lift = 0.15
    const world = makeWorld({
      site: makeSite({ hasTerrain: true, surfaceHeightAt: (x, z) => 0.5 + 0.02 * x - 0.01 * z }),
    })
    const data = scatter(world, 37, 300, 4, 45, (_rand, position, matrix) => {
      position.y += lift
      matrix.setPosition(position)
      return undefined as never
    })
    expect(data.matrices.length).toBeGreaterThan(0)
    for (const matrix of data.matrices) {
      const e = matrix.elements
      const x = e[12]!
      const y = e[13]!
      const z = e[14]!
      expect(pointInPolygonXZ(SQUARE, x, z)).toBe(true)
      expect(y).toBeCloseTo(0.5 + 0.02 * x - 0.01 * z + lift, 6)
    }
  })

  test('samples outside the polygon are rejected (no flora over the horizon plate)', () => {
    // Tiny lot, wide ring: most of the 12–60 m ring is off-lot.
    const tiny: Array<[number, number]> = [
      [-8, -8],
      [8, -8],
      [8, 8],
      [-8, 8],
    ]
    const world = makeWorld({ site: makeSite({ polygon: tiny }) })
    const data = scatter(world, 23, 200, 12, 60, (_rand, position, matrix) => {
      matrix.setPosition(position)
      return undefined as never
    })
    for (const matrix of data.matrices) {
      const e = matrix.elements
      expect(pointInPolygonXZ(tiny, e[12]!, e[14]!)).toBe(true)
    }
  })

  test('flat site: instances sit at −0.05 + lift, never sunk under the fill', () => {
    const lift = 0.08
    const world = makeWorld({ site: makeSite() })
    const data = scatter(world, 51, 60, 6, 20, (_rand, position, matrix) => {
      position.y += lift
      matrix.setPosition(position)
      return undefined as never
    })
    expect(data.matrices.length).toBeGreaterThan(0)
    for (const matrix of data.matrices) {
      expect(matrix.elements[13]!).toBeCloseTo(SITE_FLAT_GROUND_Y + lift, 6)
    }
  })

  test('degenerate polygon (< 3 points) skips the clamp instead of emptying the field', () => {
    const world = makeWorld({ site: makeSite({ polygon: [] }) })
    const data = scatter(world, 11, 100, 2, 30, (_rand, position, matrix) => {
      matrix.setPosition(position)
      return undefined as never
    })
    expect(data.matrices.length).toBe(100)
  })

  test('no site: layout and Y are byte-identical to the legacy plane', () => {
    const world = makeWorld()
    const data = scatter(world, 11, 150, 2, 30, (_rand, position, matrix) => {
      matrix.setPosition(position)
      return undefined as never
    })
    expect(data.matrices.length).toBe(150)
    for (const matrix of data.matrices) expect(matrix.elements[13]!).toBe(0)
  })
})
