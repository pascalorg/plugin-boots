import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { collideCapsule } from './collision'
import {
  collideVoxelTargets,
  damageTarget,
  ensureVoxelTarget,
  resetDestruction,
} from './destruction'
import { BOT_SETTLE_RATE, GROUND_BOT_CAPSULE } from './enemies-state'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * BOT WALL RULE regression (owner playtest: "robots walking through the
 * walls"). Ground bots resolve exactly like the player — one capsule pass
 * vs host colliders, then vs live voxels — so this drives a bot-sized
 * capsule (GROUND_BOT_CAPSULE) through the same beeline integration
 * enemies.tsx performs each frame and pins the three behaviors that matter:
 * pristine host walls block, pre-voxelized walls block while their voxels
 * live, and a carved breach lets bots pour through (desired!).
 */

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

/** One 2m × 2.7m × 0.12m wall on the z=0 line, nothing else. */
function makeWorld(): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const colliders = [wall]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map([
      [
        'wall-1',
        {
          node: { id: 'wall-1', start: [-1, 0], end: [1, 0], height: 2.7, thickness: 0.12 },
          root: wall.root,
          meshes: [wall.mesh],
        },
      ],
    ]),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/**
 * The exact per-frame ground-bot step from enemies.tsx: beeline intent,
 * position moves, then collideCapsule + collideVoxelTargets own placement.
 * Returns the final feet position after `seconds` at 60 Hz.
 */
function marchBot(
  world: GameWorld,
  from: Vector3,
  target: Vector3,
  speed: number,
  seconds: number,
): Vector3 {
  const pos = from.clone()
  const vel = new Vector3()
  const dir = new Vector3()
  const dt = 1 / 60
  const SETTLE = BOT_SETTLE_RATE // near-support settle — releases capsule step-ups
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    dir.set(target.x - pos.x, 0, target.z - pos.z)
    if (dir.lengthSq() < 1e-6) break
    dir.normalize()
    if (pos.y > 0) pos.y = Math.max(0, pos.y - SETTLE * dt)
    pos.x += dir.x * speed * dt
    pos.z += dir.z * speed * dt
    vel.set(dir.x * speed, 0, dir.z * speed)
    collideCapsule(pos, vel, world.colliders, GROUND_BOT_CAPSULE)
    collideVoxelTargets(pos, vel, GROUND_BOT_CAPSULE.radius, GROUND_BOT_CAPSULE.height)
  }
  return pos
}

afterEach(() => {
  resetDestruction()
})

describe('BOT WALL RULE: ground bots never phase through walls', () => {
  test('pristine host wall blocks a dog-speed beeline (no voxels yet)', () => {
    const world = makeWorld()
    const end = marchBot(world, new Vector3(0, 0, 2), new Vector3(0, 0, -2), 4.6, 4)
    // The wall face is at z = +0.06; the capsule core can never cross it.
    expect(end.z).toBeGreaterThan(0)
  })

  test('pre-voxelized wall blocks while its voxels live (host collider disabled)', () => {
    const world = makeWorld()
    ensureVoxelTarget(world, 'wall-1')
    expect(world.colliders[0]!.disabled).toBe(true) // voxels own collision now
    const end = marchBot(world, new Vector3(0, 0, 2), new Vector3(0, 0, -2), 4.6, 4)
    expect(end.z).toBeGreaterThan(0)
  })

  test('bots pour through a carved breach (desired after destruction)', () => {
    const world = makeWorld()
    ensureVoxelTarget(world, 'wall-1')
    // Blow a bot-sized ground-level hole through BOTH skins.
    damageTarget(world, 'wall-1', new Vector3(0, 0.6, -0.06), 1.2)
    damageTarget(world, 'wall-1', new Vector3(0, 0.6, 0.06), 1.2)
    const end = marchBot(world, new Vector3(0, 0, 2), new Vector3(0, 0, -2), 4.6, 4)
    expect(end.z).toBeLessThan(-1) // reached the player side through the hole
  })
})
