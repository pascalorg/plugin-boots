import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import { BoxGeometry, Group, Mesh, Vector3 } from 'three'
import type { WallNodeLike } from './world'
import { collectWorld, deriveGridAnchor } from './world'

/**
 * GRID ANCHOR derivation (deriveGridAnchor): the rigid XZ frame that lets
 * the build lattice adopt the building's dominant walls. Pure-math suites
 * feed minimal fake wall entries (node start/end + a root whose matrixWorld
 * carries the building rotation — the world-levels fixture idiom); one
 * integration test runs the real collectWorld sweep over a ROTATED level
 * and asserts the stashed anchor composes the level transform.
 */

/** Fake wall entry: level-local start/end + a (default identity) root. */
let wallSeq = 0
function wallEntry(
  start: [number, number],
  end: [number, number],
  root = new Group(),
): { node: WallNodeLike; root: Group } {
  root.updateMatrixWorld(true)
  return { node: { id: `wall_${wallSeq++}`, start, end }, root }
}

/** End point of a wall of `length` at object-yaw `deg` from `start` —
 * object-yaw convention: local +X maps to (cos yaw, −sin yaw). */
function endAt(start: [number, number], deg: number, length: number): [number, number] {
  const yaw = (deg * Math.PI) / 180
  return [start[0] + Math.cos(yaw) * length, start[1] - Math.sin(yaw) * length]
}

describe('deriveGridAnchor — dominant yaw (length-weighted, folded mod 90°)', () => {
  test('two long parallel walls + a short perpendicular one: all vote together', () => {
    const walls = [
      wallEntry([10, 5], endAt([10, 5], 30, 8)),
      wallEntry([0, 0], endAt([0, 0], 30, 7)),
      // Perpendicular (30° + 90°): folds MOD 90° onto the same 30° vote.
      wallEntry([-3, 2], endAt([-3, 2], 120, 2)),
    ]
    const anchor = deriveGridAnchor(walls)
    expect(anchor.yaw).toBeCloseTo(Math.PI / 6, 8)
    // Anchor point = the LONGEST wall's world start.
    expect(anchor.x).toBeCloseTo(10, 8)
    expect(anchor.z).toBeCloseTo(5, 8)
  })

  test('length weighting: the long walls beat a short odd-angled one', () => {
    const walls = [
      wallEntry([2, 2], endAt([2, 2], 30, 5)),
      wallEntry([0, 8], endAt([0, 8], 30, 4)),
      // A short wall at 10° votes a different bin and loses on length.
      wallEntry([6, 0], endAt([6, 0], 10, 3)),
    ]
    const anchor = deriveGridAnchor(walls)
    expect(anchor.yaw).toBeCloseTo(Math.PI / 6, 8)
  })

  test('degenerate stubs never vote and never place the anchor', () => {
    const walls = [
      wallEntry([1, 1], endAt([1, 1], 17, 0.2)), // sub-0.3 m stub at an odd yaw
      wallEntry([3, 6], endAt([3, 6], 0, 6)), // cardinal, start on the lattice
    ]
    expect(deriveGridAnchor(walls)).toEqual({ x: 0, z: 0, yaw: 0 })
  })

  test('no walls at all → identity', () => {
    expect(deriveGridAnchor([])).toEqual({ x: 0, z: 0, yaw: 0 })
  })
})

describe('deriveGridAnchor — rotated-building composition', () => {
  test('the wall root matrixWorld yaw composes with the local start/end yaw', () => {
    // The wall is LOCALLY cardinal (start/end along level X) — the whole
    // building is rotated 30° and moved at the level, the way real scenes
    // rotate wholesale. world.walls stores level-local start/end, so the
    // derivation must read the rotation off the root's matrixWorld.
    const root = new Group()
    root.rotation.y = Math.PI / 6
    root.position.set(3, 0, -2)
    const wall = wallEntry([2, 1], [6, 1], root)
    const anchor = deriveGridAnchor([wall])
    expect(anchor.yaw).toBeCloseTo(Math.PI / 6, 8)
    // The anchor point is the level-local start pushed through the SAME
    // matrixWorld the meshes render with.
    const start = new Vector3(2, 0, 1).applyMatrix4(root.matrixWorld)
    expect(anchor.x).toBeCloseTo(start.x, 8)
    expect(anchor.z).toBeCloseTo(start.z, 8)
  })

  test('longest wall wins the anchor point across mixed roots', () => {
    const rotated = new Group()
    rotated.rotation.y = Math.PI / 6
    const walls = [
      wallEntry([1, 1], endAt([1, 1], 30, 5)),
      // Locally cardinal under a 30°-rotated root — world yaw 30° again,
      // and at 9 m it is the longest: its WORLD start places the anchor.
      wallEntry([4, -2], [13, -2], rotated),
      wallEntry([0, 4], endAt([0, 4], 30, 3)),
    ]
    const anchor = deriveGridAnchor(walls)
    const start = new Vector3(4, 0, -2).applyMatrix4(rotated.matrixWorld)
    expect(anchor.x).toBeCloseTo(start.x, 8)
    expect(anchor.z).toBeCloseTo(start.z, 8)
    expect(anchor.yaw).toBeCloseTo(Math.PI / 6, 8)
  })
})

describe('deriveGridAnchor — identity snap for aligned buildings', () => {
  test('cardinal walls starting ON the 3 m lattice snap to exact identity', () => {
    // X-running and Z-running (folds to cardinal too), both on the lattice.
    expect(deriveGridAnchor([wallEntry([3, -6], [9, -6])])).toEqual({ x: 0, z: 0, yaw: 0 })
    expect(deriveGridAnchor([wallEntry([0, 0], [0, 6])])).toEqual({ x: 0, z: 0, yaw: 0 })
  })

  test('within the 2 cm / 0.5° epsilons still snaps', () => {
    const anchor = deriveGridAnchor([wallEntry([3.01, -5.985], [9.01, -5.985])])
    expect(anchor).toEqual({ x: 0, z: 0, yaw: 0 })
  })

  test('a cardinal building OFF the lattice anchors to its wall start', () => {
    const anchor = deriveGridAnchor([wallEntry([1, 0.5], [7, 0.5])])
    expect(anchor.yaw).toBeCloseTo(0, 8)
    expect(anchor.x).toBeCloseTo(1, 8)
    expect(anchor.z).toBeCloseTo(0.5, 8)
    // NOT snapped: 1 m and 0.5 m are metres off any CELL multiple.
    expect(anchor).not.toEqual({ x: 0, z: 0, yaw: 0 })
  })
})

// ── collectWorld integration: the anchor is stashed on GameWorld ───────────

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

describe('collectWorld stashes the grid anchor', () => {
  test('a wholesale-rotated level yields a composed, non-identity anchor', () => {
    // Real-host shape: the wall's REGISTERED root is a level-origin group
    // (wall nodes carry no transform of their own); the level group holds
    // the building rotation. Mesh geometry spans the node's start/end.
    const level = new Group()
    level.rotation.y = Math.PI / 6
    level.position.set(10, 0, 4)
    const wallRoot = new Group()
    const mesh = new Mesh(new BoxGeometry(4, 2.8, 0.2))
    mesh.position.set(0, 1.4, 0) // midpoint of start (−2,0) → end (2,0)
    wallRoot.add(mesh)
    level.add(wallRoot)
    level.updateMatrixWorld(true)

    register('level_rot', 'level', level)
    register('wall_rot', 'wall', wallRoot)
    useScene.getState().setScene(
      {
        level_rot: {
          id: 'level_rot',
          type: 'level',
          parentId: null,
          visible: true,
          level: 0,
          children: ['wall_rot'],
        },
        wall_rot: {
          id: 'wall_rot',
          type: 'wall',
          parentId: 'level_rot',
          visible: true,
          start: [-2, 0],
          end: [2, 0],
          height: 2.8,
          thickness: 0.2,
        },
      } as never,
      ['level_rot'] as never,
    )

    const world = collectWorld()
    expect(world.gridAnchor).toBeDefined()
    expect(world.gridAnchor!.yaw).toBeCloseTo(Math.PI / 6, 6)
    const start = new Vector3(-2, 0, 0).applyMatrix4(wallRoot.matrixWorld)
    expect(world.gridAnchor!.x).toBeCloseTo(start.x, 6)
    expect(world.gridAnchor!.z).toBeCloseTo(start.z, 6)
  })
})
