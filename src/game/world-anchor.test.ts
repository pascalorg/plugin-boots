import { afterEach, describe, expect, test } from 'bun:test'
import { sceneRegistry, useScene } from '@pascal-app/core'
import { BoxGeometry, Group, Mesh, Vector3 } from 'three'
import { gridStamp } from './shared-derive'
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
    // matrixWorld the meshes render with — to the MILLIMETRE, which is as far
    // as the anchor is allowed to be precise: it is a fingerprint two peers must
    // derive identically off a live matrix, so it is quantized at the source
    // (see ANCHOR_YAW_SNAP / quantPos in world.ts).
    const start = new Vector3(2, 0, 1).applyMatrix4(root.matrixWorld)
    expect(anchor.x).toBeCloseTo(start.x, 3)
    expect(anchor.z).toBeCloseTo(start.z, 3)
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
    expect(anchor.x).toBeCloseTo(start.x, 3) // millimetre: the anchor is quantized
    expect(anchor.z).toBeCloseTo(start.z, 3)
    expect(anchor.yaw).toBeCloseTo(Math.PI / 6, 8)
  })
})

describe('deriveGridAnchor — the anchor is a fingerprint, not a measurement', () => {
  /**
   * THE BUG THIS BLOCK EXISTS FOR (2026-09-01, prod). The anchor yaw is read
   * through a LIVE matrixWorld — the host LevelSystem lerps level groups every
   * frame and leaves ~1e-4 rad of residue that never settles. Two peers on the
   * same lot therefore derive yaws that differ in the fifth decimal, and
   * `gridStamp` used to hash the yaw on a 65536-step turn (0.0055°/step), so a
   * +ε and a −ε around zero — the same angle — landed on step 0 versus step
   * 65535. Different fingerprint ⇒ every slot-addressed piece the other peer
   * placed was REFUSED, in both directions, for the whole session. The contract
   * these tests pin: jitter smaller than the snap must produce the SAME anchor
   * and the SAME stamp, and a real rotation must still survive.
   */
  const jittered = (residue: number, base = 0) => {
    const root = new Group()
    root.rotation.y = base + residue
    // Start off the 3 m lattice, so the identity snap does not fire and the
    // derivation actually has to hash a live yaw — the production shape.
    return deriveGridAnchor([wallEntry([1, 0.5], [7, 0.5], root)])
  }
  const stampOf = (a: { x: number; z: number; yaw: number }) => gridStamp(a.x, a.z, a.yaw, [0])

  test('render residue around zero yields one anchor and one stamp', () => {
    // The three residues measured in one real session, audited three times.
    const anchors = [6.4e-6, -6.6e-5, 2.2e-5].map((r) => jittered(r))
    for (const anchor of anchors) {
      expect(Math.abs(anchor.yaw - anchors[0]!.yaw)).toBe(0)
      expect(anchor.x).toBe(anchors[0]!.x)
      expect(anchor.z).toBe(anchors[0]!.z)
      expect(stampOf(anchor)).toBe(stampOf(anchors[0]!))
    }
  })

  test('residue straddling zero does not wrap to the far end of the turn', () => {
    // The exact pair that broke production: same angle, opposite signs.
    expect(stampOf(jittered(1e-5))).toBe(stampOf(jittered(-1e-5)))
  })

  test('residue around a genuinely rotated building agrees too', () => {
    const base = Math.PI / 6
    const plus = jittered(1e-4, base)
    const minus = jittered(-1e-4, base)
    expect(Math.abs(plus.yaw - minus.yaw)).toBe(0)
    expect(stampOf(plus)).toBe(stampOf(minus))
    expect(plus.yaw).toBeCloseTo(base, 4)
  })

  test('a real rotation survives the snap — this is not a cardinal clamp', () => {
    const odd = (12.37 * Math.PI) / 180
    const anchor = jittered(0, odd)
    expect(anchor.yaw).not.toBe(0)
    // Worst case is half a step: 0.025°, i.e. 7 mm of skew over a 16 m wall.
    expect(Math.abs(anchor.yaw - odd)).toBeLessThanOrEqual((0.025 * Math.PI) / 180 + 1e-12)
    // …and a different real angle is a different lot, as the gate needs.
    expect(stampOf(anchor)).not.toBe(stampOf(jittered(0, (24.74 * Math.PI) / 180)))
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
    expect(world.gridAnchor!.x).toBeCloseTo(start.x, 3) // millimetre, as derived
    expect(world.gridAnchor!.z).toBeCloseTo(start.z, 3)
  })
})
