import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry } from '@pascal-app/core'
import { Box3, BoxGeometry, Color, Group, Matrix4, Mesh, PlaneGeometry, Vector3 } from 'three'
import { scatter } from './nature'
import {
  bvhFor,
  type ColliderEntry,
  collectRoadFootprints,
  footprintFromTriangles,
  type GameWorld,
  meshFootprintTriangles,
  pointOnRoad,
  type RoadFootprint,
} from './world'

/**
 * Owner playtest: "still grass on top of road". Nature scatter must reject
 * every sample landing on a hard-surface footprint — Streetscape road
 * networks (kind `streetscape:road-network`, meshes named `road-*`) and
 * flat host pads (driveway slabs, parking-spot items, block pavers) — with
 * a clearance margin past the pavement edge. All decision math is pure and
 * covered here; the rendering side stays visual-only.
 */

/** A flat quad lying in XZ (a road-surface ribbon segment analog). */
function flatQuad(
  width: number,
  depth: number,
  center: [number, number, number],
  name = '',
): Mesh {
  const mesh = new Mesh(new PlaneGeometry(width, depth).rotateX(-Math.PI / 2))
  mesh.name = name
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  return mesh
}

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

function makeWorld(roadFootprints?: RoadFootprint[]): GameWorld {
  return {
    colliders: [],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    roadFootprints,
    buildingAabb: new Box3(),
    spawn: new Vector3(),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('meshFootprintTriangles', () => {
  test('projects a transformed flat quad to two XZ triangles with correct bounds', () => {
    const quad = flatQuad(4, 2, [10, 0.1, 5])
    const triangles = meshFootprintTriangles(quad)
    expect(triangles.length).toBe(12) // two triangles, 6 floats each
    const footprint = footprintFromTriangles(triangles)!
    expect(footprint.minX).toBeCloseTo(8, 5)
    expect(footprint.maxX).toBeCloseTo(12, 5)
    expect(footprint.minZ).toBeCloseTo(4, 5)
    expect(footprint.maxZ).toBeCloseTo(6, 5)
  })

  test('skips triangles entirely above the elevation cutoff (bridge decks)', () => {
    const deck = flatQuad(4, 2, [0, 5, 0])
    expect(meshFootprintTriangles(deck).length).toBe(0)
  })

  test('skips XZ-degenerate vertical faces', () => {
    // Unrotated plane: all variation is in XY, so the XZ projection has
    // zero area — a wall face seen from above.
    const vertical = new Mesh(new PlaneGeometry(2, 2))
    vertical.updateMatrixWorld(true)
    expect(meshFootprintTriangles(vertical).length).toBe(0)
  })

  test('footprintFromTriangles returns null when nothing survived', () => {
    expect(footprintFromTriangles(new Float32Array(0))).toBeNull()
  })
})

describe('pointOnRoad', () => {
  const quad = footprintFromTriangles(meshFootprintTriangles(flatQuad(4, 2, [10, 0.1, 5])))!

  test('true inside, true within margin of the edge, false beyond it', () => {
    expect(pointOnRoad([quad], 10, 5)).toBe(true) // dead center
    expect(pointOnRoad([quad], 12.2, 5)).toBe(true) // 0.2 past edge x=12, margin 0.3
    expect(pointOnRoad([quad], 12.4, 5)).toBe(false) // 0.4 past edge
    expect(pointOnRoad([quad], 50, 50)).toBe(false) // far away
  })

  test('explicit margin is honored', () => {
    expect(pointOnRoad([quad], 12.2, 5, 0)).toBe(false)
    expect(pointOnRoad([quad], 11.9, 5, 0)).toBe(true)
  })

  test('winding-agnostic point-in-triangle', () => {
    const ccw = footprintFromTriangles(new Float32Array([0, 0, 4, 0, 0, 4]))!
    const cw = footprintFromTriangles(new Float32Array([0, 0, 0, 4, 4, 0]))!
    expect(pointOnRoad([ccw], 1, 1, 0)).toBe(true)
    expect(pointOnRoad([cw], 1, 1, 0)).toBe(true)
    expect(pointOnRoad([ccw], 3.5, 3.5, 0)).toBe(false)
    expect(pointOnRoad([cw], 3.5, 3.5, 0)).toBe(false)
  })

  test('missing or empty footprints reject nothing', () => {
    expect(pointOnRoad(undefined, 0, 0)).toBe(false)
    expect(pointOnRoad([], 0, 0)).toBe(false)
  })
})

describe('collectRoadFootprints — flat host pads', () => {
  test('flat slabs count, walls and tall or elevated things do not', () => {
    const colliders = [
      boxCollider('slab-1', 'slab', [6, 0.2, 3], [20, 0.1, 0]), // driveway pad
      boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0]), // kind not a pad
      boxCollider('block-1', 'block', [1, 2, 1], [0, 1, 10]), // too tall
      boxCollider('item-1', 'item', [2, 0.1, 2], [30, 3, 0]), // flat but 3 m up
    ]
    const footprints = collectRoadFootprints(colliders)
    expect(footprints.length).toBe(1)
    expect(pointOnRoad(footprints, 20, 0)).toBe(true) // on the pad
    expect(pointOnRoad(footprints, 0, 10)).toBe(false) // tall block site
    expect(pointOnRoad(footprints, 30, 0)).toBe(false) // elevated item site
  })
})

describe('collectRoadFootprints — streetscape road networks', () => {
  const REGISTERED: string[] = []

  function registerRoadRoot(id: string, root: Group): void {
    sceneRegistry.byType['streetscape:road-network']!.add(id)
    sceneRegistry.nodes.set(id, root)
    REGISTERED.push(id)
  }

  afterEach(() => {
    for (const id of REGISTERED) {
      sceneRegistry.byType['streetscape:road-network']!.delete(id)
      sceneRegistry.nodes.delete(id)
    }
    REGISTERED.length = 0
  })

  test('collects road-* surface meshes, skipping previews / hit targets / bridges', () => {
    const root = new Group()
    root.add(flatQuad(10, 4, [0, 0.12, 5], 'road-segment-surface'))
    root.add(flatQuad(10, 4, [50, 0.12, 50], 'road-segment-preview'))
    root.add(flatQuad(10, 4, [60, 0.12, 60], 'road-edge-hit:e1'))
    root.add(flatQuad(10, 4, [70, 0.12, 70], 'road-bridge-deck'))
    root.add(flatQuad(10, 4, [80, 0.12, 80], 'not-a-road-mesh'))
    root.updateMatrixWorld(true)
    registerRoadRoot('road_test_1', root)

    const footprints = collectRoadFootprints([])
    expect(footprints.length).toBe(1)
    expect(pointOnRoad(footprints, 0, 5)).toBe(true) // paved surface
    expect(pointOnRoad(footprints, 50, 50)).toBe(false) // preview ghost
    expect(pointOnRoad(footprints, 60, 60)).toBe(false) // pick target
    expect(pointOnRoad(footprints, 70, 70)).toBe(false) // bridge
    expect(pointOnRoad(footprints, 80, 80)).toBe(false) // unnamed
  })

  test('roots on hidden branches contribute nothing', () => {
    const root = new Group()
    root.add(flatQuad(10, 4, [0, 0.12, 5], 'road-segment-surface'))
    root.visible = false
    registerRoadRoot('road_test_hidden', root)
    expect(collectRoadFootprints([]).length).toBe(0)
  })
})

describe('scatter road rejection', () => {
  // An 80 × 4 m road strip crossing the scatter ring (z in [3, 7]).
  const strip = footprintFromTriangles(meshFootprintTriangles(flatQuad(80, 4, [0, 0.1, 5])))!
  const color = new Color('#79b054')

  function run(world: GameWorld): Array<[number, number]> {
    const placed: Array<[number, number]> = []
    scatter(world, 11, 600, 2, 30, (_rand, position, matrix) => {
      matrix.setPosition(position)
      placed.push([position.x, position.z])
      return color
    })
    return placed
  }

  test('without footprints the ring DOES cover the road strip (test potency)', () => {
    const placed = run(makeWorld())
    expect(placed.some(([x, z]) => pointOnRoad([strip], x, z))).toBe(true)
  })

  test('with footprints no sample lands on or within the margin of the road', () => {
    const placed = run(makeWorld([strip]))
    expect(placed.length).toBe(600) // rejection did not starve the field
    for (const [x, z] of placed) {
      // 0.29 < the 0.3 rejection margin — nothing may sit even at the rim.
      expect(pointOnRoad([strip], x, z, 0.29)).toBe(false)
    }
  })
})
