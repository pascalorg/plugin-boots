import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import { clearDebris } from './debris'
import {
  ensureVoxelTarget,
  resetDestruction,
  SHELL_NEAR_RADIUS,
  setShellFlag,
  shellBuildTick,
  shellPendingCount,
  shellQueueSphere,
  useDestruction,
} from './destruction'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * The deferred-shell queue's NEAR-GATE SPHERE must contain the node.
 *
 * A far target defers its shell build and queues one entry: a center and a
 * radius. The gate is `centerDistance − r > SHELL_NEAR_RADIUS ⇒ still far,
 * end the pass`, i.e. the sphere is a deliberately CONSERVATIVE stand-in
 * for the node's world AABB — it may over-include (a sphere always does),
 * it may never under-include. If it fails to contain the node, a wall the
 * player is standing next to reads as far, never prebuilds, and gets its
 * shell only through the wake-path sync build — which is budget-capped and
 * falls back to voxel-only PERMANENTLY when a blast spends the budget. The
 * player sees that wall wake as flat voxel bricks instead of its own
 * surface.
 *
 * The fixture is a DIAGONAL wall on purpose. buildStuds used to collect the
 * wall's mesh bounds into the same module scratch ensureVoxelTarget's node
 * AABB lives in, by expanding over the transformed min and max CORNERS
 * only. Two corners are a correct AABB exactly while the transform keeps
 * the box axis-aligned — so every axis-aligned fixture in the suite passed
 * while any rotated wall queued an under-sized sphere.
 */

const WALL_LENGTH = 6
const WALL_HEIGHT = 2.7
const WALL_THICKNESS = 0.3
/** −45°: the box's local +X maps to (+cos, 0, +sin) in world, so the wall
 * runs diagonally and its transform mixes the signs of the plan axes. */
const WALL_YAW = -Math.PI / 4

function diagonalWall(nodeId = 'wall-diag'): { world: GameWorld; mesh: Mesh } {
  const mesh = new Mesh(
    new BoxGeometry(WALL_LENGTH, WALL_HEIGHT, WALL_THICKNESS),
    new MeshStandardMaterial({ color: '#b04030' }),
  )
  mesh.position.set(0, WALL_HEIGHT / 2, 0)
  mesh.rotation.y = WALL_YAW
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  const collider: ColliderEntry = {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType: 'wall',
  }
  const half = WALL_LENGTH / 2
  const dirX = Math.cos(WALL_YAW)
  const dirZ = -Math.sin(WALL_YAW)
  const world = {
    colliders: [collider],
    walls: new Map([
      [
        nodeId,
        {
          node: {
            id: nodeId,
            start: [-half * dirX, -half * dirZ],
            end: [half * dirX, half * dirZ],
            height: WALL_HEIGHT,
            thickness: WALL_THICKNESS,
          },
          root: mesh,
          meshes: [mesh],
        },
      ],
    ]),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: worldBox.clone(),
    spawn: new Vector3(20, 0, 20),
    spawnYaw: 0,
    levelId: null,
  } as unknown as GameWorld
  return { world, mesh }
}

/** The node's true world AABB — every corner of the transformed box. */
function trueBox(mesh: Mesh): Box3 {
  mesh.geometry.computeBoundingBox()
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
}

/** What expanding over the transformed min/max CORNERS ONLY produces — the
 * shape of the old scratch clobber, kept here so the fixture can prove it
 * is actually exercising the difference. */
function twoCornerBox(mesh: Mesh): Box3 {
  const local = mesh.geometry.boundingBox!
  return new Box3()
    .expandByPoint(local.min.clone().applyMatrix4(mesh.matrixWorld))
    .expandByPoint(local.max.clone().applyMatrix4(mesh.matrixWorld))
}

const halfDiagonal = (box: Box3) => box.getSize(new Vector3()).length() / 2

function corners(box: Box3): Vector3[] {
  const out: Vector3[] = []
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) out.push(new Vector3(x, y, z))
  return out
}

/** Focus `gap` metres OUTSIDE the sphere gate, straight along +x from the
 * node's AABB center: at gap < 0 the node is inside the gate. */
function focusAt(box: Box3, gap: number): { x: number; y: number; z: number } {
  const center = box.getCenter(new Vector3())
  return { x: center.x + SHELL_NEAR_RADIUS + halfDiagonal(box) + gap, y: center.y, z: center.z }
}

const targets = () => useDestruction.getState().targets

afterEach(() => {
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
  resetDestruction()
  clearDebris()
})

describe('deferred shell queue: the near-gate sphere contains the node', () => {
  test('the diagonal fixture really does distinguish the two box formulas', () => {
    // Guard on the test itself: an axis-aligned wall makes every assertion
    // below vacuous, because two corners are then the whole AABB.
    const { mesh } = diagonalWall()
    const deficit = halfDiagonal(trueBox(mesh)) - halfDiagonal(twoCornerBox(mesh))
    expect(deficit).toBeGreaterThan(0.1)
    expect(twoCornerBox(mesh).containsBox(trueBox(mesh))).toBe(false)
  })

  test('a deferred DIAGONAL wall queues the node AABB, not the wall-mesh 2-corner box', () => {
    const { world, mesh } = diagonalWall()
    const box = trueBox(mesh)
    shellBuildTick(0, focusAt(box, 1)) // stamp the focus; never work
    ensureVoxelTarget(world, 'wall-diag')
    expect(targets().get('wall-diag')!.shellPending).toEqual({ kind: 'single' })
    const sphere = shellQueueSphere('wall-diag')!
    expect(sphere).not.toBeNull()
    // CONTAINMENT — the property the gate depends on.
    for (const corner of corners(box)) {
      const d = Math.hypot(corner.x - sphere.x, corner.y - sphere.y, corner.z - sphere.z)
      expect(d).toBeLessThanOrEqual(sphere.r + 1e-6)
    }
    // TIGHTNESS — the AABB's own bounding sphere, so an over-reaching fix
    // (a building-wide union, say) fails here just as an under-sized one
    // fails containment above.
    const center = box.getCenter(new Vector3())
    expect(sphere.x).toBeCloseTo(center.x, 6)
    expect(sphere.y).toBeCloseTo(center.y, 6)
    expect(sphere.z).toBeCloseTo(center.z, 6)
    expect(sphere.r).toBeCloseTo(halfDiagonal(box), 6)
  })

  test('a diagonal wall just INSIDE the gate builds on a funded tick', () => {
    const { world, mesh } = diagonalWall()
    const box = trueBox(mesh)
    // 2 cm inside the sphere gate — and still 1.1 m of AABB clearance past
    // SHELL_NEAR_RADIUS, so voxelize legitimately DEFERS it first.
    const focus = focusAt(box, -0.02)
    expect(box.distanceToPoint(new Vector3(focus.x, focus.y, focus.z))).toBeGreaterThan(
      SHELL_NEAR_RADIUS,
    )
    shellBuildTick(0, focus)
    ensureVoxelTarget(world, 'wall-diag')
    expect(shellPendingCount()).toBe(1)
    expect(shellBuildTick(50, focus)).toBe(true)
    expect(targets().get('wall-diag')!.shell).toBeDefined()
    expect(shellPendingCount()).toBe(0)
  })

  test('a diagonal wall genuinely OUTSIDE the gate stays pending', () => {
    const { world, mesh } = diagonalWall()
    const box = trueBox(mesh)
    const focus = focusAt(box, 0.5)
    shellBuildTick(0, focus)
    ensureVoxelTarget(world, 'wall-diag')
    expect(shellBuildTick(50, focus)).toBe(false)
    expect(targets().get('wall-diag')!.shell).toBeUndefined()
    expect(shellPendingCount()).toBe(1)
  })
})
