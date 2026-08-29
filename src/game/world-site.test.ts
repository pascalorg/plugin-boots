import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, PlaneGeometry } from 'three'
import {
  buildSiteSnapshot,
  bvhFor,
  collectMeshes,
  collectWorld,
  type ColliderEntry,
  pointInPolygonXZ,
  siteGroundYAt,
  SPAWN_SETTLE_EPS,
  spawnGroundY,
} from './world'

/**
 * Host site / terrain integration (SITE-SPEC items 1–4): the lot's terrain
 * surface + skirt (or flat polygon fill) become indestructible 'site' walk
 * colliders, with three REQUIRED guards pinned here —
 * 1. buildingAabb NEVER unions site meshes (else the spawn ring / nature
 *    hole / sky center / crater rejection inflate to the whole parcel);
 * 2. the host's horizon plate (userData.pascalExport = 'strip', raycast
 *    noop) is never collected — BVH collision bypasses mesh.raycast, so it
 *    would become a map-wide walkable floor;
 * 3. site never enters the walls / doors / operables lanes, and the site
 *    sweep fences at EVERY registered root so child buildings stay out of
 *    the indestructible site lane.
 * Plus the ground-read helpers nature drapes with: pointInPolygonXZ and
 * siteGroundYAt (the BVH fallback when the host core predates the analytic
 * terrain field), and the v1 spawn posture over terrain (hills probe true,
 * excavations clamp to the y = 0 lot plane).
 */

type Registered = { id: string; kind: string }
const registered: Registered[] = []

function register(id: string, kind: string, root: Group | Mesh): void {
  sceneRegistry.nodes.set(id, root)
  sceneRegistry.byType[kind]!.add(id)
  registered.push({ id, kind })
}

afterEach(() => {
  for (const { id, kind } of registered.splice(0)) {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType[kind]!.delete(id)
  }
  useScene.getState().setScene({}, [])
})

// ---------------------------------------------------------------------------
// pointInPolygonXZ
// ---------------------------------------------------------------------------

describe('pointInPolygonXZ', () => {
  const square: Array<[number, number]> = [
    [-10, -10],
    [10, -10],
    [10, 10],
    [-10, 10],
  ]

  test('inside / outside a square', () => {
    expect(pointInPolygonXZ(square, 0, 0)).toBe(true)
    expect(pointInPolygonXZ(square, 9.9, -9.9)).toBe(true)
    expect(pointInPolygonXZ(square, 10.1, 0)).toBe(false)
    expect(pointInPolygonXZ(square, 0, -11)).toBe(false)
  })

  test('winding-agnostic (reversed ring answers the same)', () => {
    const reversed = [...square].reverse()
    expect(pointInPolygonXZ(reversed, 3, 3)).toBe(true)
    expect(pointInPolygonXZ(reversed, 30, 3)).toBe(false)
  })

  test('concave polygon: the notch is outside', () => {
    // A "C": square with a bite from the right edge into the middle.
    const c: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 6],
      [10, 6],
      [10, 10],
      [0, 10],
    ]
    expect(pointInPolygonXZ(c, 2, 5)).toBe(true) // spine of the C
    expect(pointInPolygonXZ(c, 8, 5)).toBe(false) // inside the notch
    expect(pointInPolygonXZ(c, 8, 2)).toBe(true) // lower arm
  })

  test('fewer than 3 points is no polygon — nothing is inside', () => {
    expect(pointInPolygonXZ([], 0, 0)).toBe(false)
    expect(
      pointInPolygonXZ(
        [
          [0, 0],
          [5, 5],
        ],
        2,
        2,
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// siteGroundYAt — the BVH fallback ground authority
// ---------------------------------------------------------------------------

/** A 20×20 m site "terrain": plane with world height y = 0.2 · x (−2..+2 m
 * of relief across the lot, ~11° — a hill toward +x, a dig toward −x). */
function rampSiteCollider(
  overrides: Partial<Pick<ColliderEntry, 'nodeId' | 'nodeType' | 'disabled'>> = {},
): ColliderEntry {
  const geometry = new PlaneGeometry(20, 20, 4, 4)
  geometry.rotateX(-Math.PI / 2)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) position.setY(i, 0.2 * position.getX(i))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  const mesh = new Mesh(geometry)
  mesh.updateMatrixWorld(true)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId: 'site_terrain',
    nodeType: 'site',
    ...overrides,
  }
}

describe('siteGroundYAt', () => {
  test('reads the terrain surface height straight down at (x, z)', () => {
    const world = { colliders: [rampSiteCollider()] }
    expect(siteGroundYAt(world, 5, 0)).toBeCloseTo(1, 5)
    expect(siteGroundYAt(world, -5, 3)).toBeCloseTo(-1, 5)
    expect(siteGroundYAt(world, 0, -7)).toBeCloseTo(0, 5)
  })

  test('null when no site collider covers the XZ (off the lot)', () => {
    const world = { colliders: [rampSiteCollider()] }
    expect(siteGroundYAt(world, 30, 0)).toBeNull()
  })

  test('only SITE colliders answer — slabs/walls are not lot ground', () => {
    const world = { colliders: [rampSiteCollider({ nodeType: 'slab' })] }
    expect(siteGroundYAt(world, 5, 0)).toBeNull()
  })

  test('disabled site colliders are skipped', () => {
    const world = { colliders: [rampSiteCollider({ disabled: true })] }
    expect(siteGroundYAt(world, 5, 0)).toBeNull()
  })

  test('steep banks still answer (no walkability filter — flora drapes onto them)', () => {
    // y = 2 · x is ~63°, past the walkable limit; the drape still needs it.
    const geometry = new PlaneGeometry(4, 4, 2, 2)
    geometry.rotateX(-Math.PI / 2)
    const position = geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) position.setY(i, 2 * position.getX(i))
    geometry.computeBoundingBox()
    const mesh = new Mesh(geometry)
    mesh.updateMatrixWorld(true)
    const world = {
      colliders: [
        {
          mesh,
          bvh: bvhFor(mesh),
          inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
          worldBox: new Box3().setFromObject(mesh),
          root: mesh,
          nodeId: 'site_bank',
          nodeType: 'site',
        },
      ],
    }
    expect(siteGroundYAt(world, 1, 0)).toBeCloseTo(2, 5)
  })
})

// ---------------------------------------------------------------------------
// v1 spawn posture over terrain: hills probe true, excavations clamp to 0
// ---------------------------------------------------------------------------

describe('spawnGroundY over site terrain (v1 lot-plane posture)', () => {
  test('a hill under the spawn XZ lifts the feet to the surface', () => {
    expect(spawnGroundY([rampSiteCollider()], 5, 0)).toBeCloseTo(1 + SPAWN_SETTLE_EPS, 5)
  })

  test('an excavation clamps up to the y = 0 lot plane (invisible floor)', () => {
    expect(spawnGroundY([rampSiteCollider()], -5, 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// collectWorld: 'site' colliders + the three required guards
// ---------------------------------------------------------------------------

/**
 * A registered site the way the host SiteRenderer builds one: the lot
 * surface mesh + the presentation horizon plate (pascalExport 'strip',
 * raycast noop) + a child building (registered, NON-solid kind) hosting a
 * registered wall and an unregistered decoration mesh.
 */
function buildSiteScene() {
  const site = new Group()

  // Lot surface: 60×50 m ground plate (stands in for terrain surface/fill).
  const lotSurface = new Mesh(new BoxGeometry(60, 0.2, 50))
  lotSurface.position.set(0, -0.1, 0)
  site.add(lotSurface)

  // Presentation horizon plate — must NEVER become a collider.
  const horizon = new Mesh(new BoxGeometry(800, 0.01, 800))
  horizon.position.set(0, -0.07, 0)
  horizon.userData.pascalExport = 'strip'
  site.add(horizon)

  // Child building (registered under a NON-solid container kind) with a
  // registered wall and an unregistered presentation mesh.
  const building = new Group()
  site.add(building)
  const wall = new Mesh(new BoxGeometry(4, 2.8, 0.2))
  wall.position.set(0, 1.4, 0)
  building.add(wall)
  const decoration = new Mesh(new BoxGeometry(1, 1, 1))
  decoration.position.set(2, 0.5, 2)
  building.add(decoration)

  site.updateMatrixWorld(true)

  register('site_1', 'site', site)
  register('building_1', 'building', building)
  register('wall_1', 'wall', wall)

  useScene.getState().setScene(
    {
      site_1: {
        id: 'site_1',
        type: 'site',
        parentId: null,
        visible: true,
        polygon: {
          points: [
            [-30, -25],
            [30, -25],
            [30, 25],
            [-30, 25],
          ],
        },
        children: ['building_1'],
      },
      building_1: {
        id: 'building_1',
        type: 'building',
        parentId: 'site_1',
        visible: true,
        children: ['wall_1'],
      },
      wall_1: {
        id: 'wall_1',
        type: 'wall',
        parentId: 'building_1',
        visible: true,
        start: [-2, 0],
        end: [2, 0],
        height: 2.8,
        thickness: 0.2,
        children: [],
      },
    } as never,
    ['site_1'] as never,
  )

  return { site, lotSurface, horizon, building, wall, decoration }
}

describe('collectWorld with a host site', () => {
  test("the lot surface is a 'site' collider; the wall keeps its own lane", () => {
    const { lotSurface, wall } = buildSiteScene()
    const world = collectWorld()

    const siteColliders = world.colliders.filter((c) => c.nodeType === 'site')
    expect(siteColliders.map((c) => c.mesh)).toEqual([lotSurface])
    expect(siteColliders[0]!.nodeId).toBe('site_1')
    expect(world.colliders.filter((c) => c.nodeId === 'wall_1').map((c) => c.mesh)).toEqual([wall])
  })

  test('REQUIRED guard: buildingAabb excludes the site (spawn ring / hole / sky center stay building-sized)', () => {
    buildSiteScene()
    const world = collectWorld()

    // The wall spans x −2..2, z −0.1..0.1; the lot spans ±30/±25. Any union
    // with the lot would blow these bounds out to the parcel.
    expect(world.buildingAabb.min.x).toBeCloseTo(-2, 3)
    expect(world.buildingAabb.max.x).toBeCloseTo(2, 3)
    expect(world.buildingAabb.max.z).toBeLessThan(1)
    expect(world.buildingAabb.min.y).toBeGreaterThanOrEqual(-0.001)
  })

  test('REQUIRED guard: the horizon strip plate is never collected (collider nor sweep)', () => {
    const { horizon, site } = buildSiteScene()
    const world = collectWorld()

    expect(world.colliders.some((c) => c.mesh === horizon)).toBe(false)
    // The collectMeshes filter itself, not just the site lane:
    expect(collectMeshes(site).includes(horizon)).toBe(false)
  })

  test('REQUIRED guard: site never enters the walls / doors / operables lanes', () => {
    buildSiteScene()
    const world = collectWorld()

    expect(world.walls.has('site_1')).toBe(false)
    expect(world.doors.some((d) => d.nodeId === 'site_1')).toBe(false)
    expect(world.operables?.some((o) => o.nodeId === 'site_1')).toBe(false)
  })

  test('the site sweep fences at EVERY registered root — child-building meshes stay out of the site lane', () => {
    const { decoration, wall } = buildSiteScene()
    const world = collectWorld()

    const siteMeshes = world.colliders.filter((c) => c.nodeType === 'site').map((c) => c.mesh)
    expect(siteMeshes.includes(wall)).toBe(false)
    expect(siteMeshes.includes(decoration)).toBe(false)
    // The unregistered decoration belongs to no lane at all — exactly the
    // pre-site behavior for meshes under non-solid containers.
    expect(world.colliders.some((c) => c.mesh === decoration)).toBe(false)
  })

  test('GameWorld.site snapshot: id + world polygon, no terrain data ⇒ flat', () => {
    buildSiteScene()
    const world = collectWorld()

    expect(world.site).not.toBeNull()
    expect(world.site!.nodeId).toBe('site_1')
    expect(world.site!.polygon).toEqual([
      [-30, -25],
      [30, -25],
      [30, 25],
      [-30, 25],
    ])
    expect(world.site!.hasTerrain).toBe(false)
    expect(world.site!.surfaceHeightAt).toBeNull()
  })

  test('no site in the scene ⇒ world.site is null (nature keeps its disc)', () => {
    const level = new Group()
    const wall = new Mesh(new BoxGeometry(4, 2.8, 0.2))
    wall.position.set(0, 1.4, 0)
    level.add(wall)
    level.updateMatrixWorld(true)
    register('level_1', 'level', level)
    register('wall_1', 'wall', wall)
    useScene.getState().setScene(
      {
        level_1: { id: 'level_1', type: 'level', visible: true, children: ['wall_1'] },
        wall_1: {
          id: 'wall_1',
          type: 'wall',
          parentId: 'level_1',
          visible: true,
          start: [-2, 0],
          end: [2, 0],
          children: [],
        },
      } as never,
      ['level_1'] as never,
    )

    const world = collectWorld()
    expect(world.site).toBeNull()
  })

  test('a hidden site is not collected (no colliders, no snapshot)', () => {
    const { site } = buildSiteScene()
    site.visible = false
    const world = collectWorld()

    expect(world.colliders.some((c) => c.nodeType === 'site')).toBe(false)
    expect(world.site).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildSiteSnapshot — polygon transform + analytic-helper feature detection
// ---------------------------------------------------------------------------

describe('buildSiteSnapshot', () => {
  test('null pick ⇒ null snapshot', () => {
    expect(buildSiteSnapshot(null)).toBeNull()
  })

  test('polygon points go through the site root matrixWorld', () => {
    const root = new Group()
    root.position.set(10, 0, 5)
    root.updateMatrixWorld(true)
    const snapshot = buildSiteSnapshot({
      id: 'site_x',
      root,
      node: {
        polygon: {
          points: [
            [0, 0],
            [4, 0],
            [4, 4],
          ],
        },
      },
    })!
    expect(snapshot.polygon).toEqual([
      [10, 5],
      [14, 5],
      [14, 9],
    ])
  })

  test('terrain + host helpers ⇒ analytic surfaceHeightAt closure over the field', () => {
    const field = { token: true }
    const snapshot = buildSiteSnapshot(
      { id: 'site_x', root: new Group(), node: { polygon: { points: [] }, terrain: { v: 1 } } },
      {
        fieldOf: (site) => (site.id === 'site_x' ? field : null),
        surfaceHeightAt: (f, x, z) => (f === field ? x + z : Number.NaN),
      },
    )!
    expect(snapshot.hasTerrain).toBe(true)
    expect(snapshot.surfaceHeightAt).not.toBeNull()
    expect(snapshot.surfaceHeightAt!(2, 3)).toBe(5)
  })

  test('terrain WITHOUT host helpers (pinned-core reality) ⇒ hasTerrain true, closure null — BVH fallback territory', () => {
    const snapshot = buildSiteSnapshot(
      { id: 'site_x', root: new Group(), node: { polygon: { points: [] }, terrain: { v: 1 } } },
      null,
    )!
    expect(snapshot.hasTerrain).toBe(true)
    expect(snapshot.surfaceHeightAt).toBeNull()
  })

  test('a throwing helper degrades to the fallback, never crashes Jump-in', () => {
    const snapshot = buildSiteSnapshot(
      { id: 'site_x', root: new Group(), node: { terrain: { v: 1 } } },
      {
        fieldOf: () => {
          throw new Error('host-version mismatch')
        },
        surfaceHeightAt: () => 0,
      },
    )!
    expect(snapshot.surfaceHeightAt).toBeNull()
    expect(snapshot.polygon).toEqual([])
  })

  test('malformed polygon points are skipped, not crashed on', () => {
    const snapshot = buildSiteSnapshot({
      id: 'site_x',
      root: new Group(),
      node: { polygon: { points: [[1, 2], 'junk', [3], [4, 5]] } },
    })!
    expect(snapshot.polygon).toEqual([
      [1, 2],
      [4, 5],
    ])
  })
})
