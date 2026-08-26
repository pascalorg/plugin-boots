import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { collideCapsule } from './collision'
import {
  collideVoxelTargets,
  damageTarget,
  ensureVoxelTarget,
  resetDestruction,
} from './destruction'
import { type Bot, type BotKind, GROUND_BOT_CAPSULE, settleGroundBot } from './enemies-state'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * BOTS ON FLOORS (Phase D slice): ground bots settle toward the live landing
 * plane under their feet (settleGroundBot → destruction.probeLandingY)
 * instead of y = 0. Pins the three behaviors that matter:
 * - a bot standing on an upper-floor slab STAYS there,
 * - a bot over a carved hole DROPS to the storey below (and does so at the
 *   fall rate, not the gentle step-up settle — the cached probe holds for
 *   ~0.2 s first, never re-probing per frame),
 * - a bot on open terrain keeps the legacy gentle 3 m/s settle to y = 0.
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

/** Ground slab (top y = 0.3) + upper-floor slab (top y = 3.0), no walls. */
function makeWorld(): GameWorld {
  const ground = boxCollider('floor-1', 'slab', [6, 0.3, 6], [0, 0.15, 0])
  const upper = boxCollider('floor-2', 'slab', [4, 0.3, 4], [0, 2.85, 0])
  const colliders = [ground, upper]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Deterministic ground bot — groundT 0 forces a probe on the first settle. */
function makeBot(kind: BotKind, x: number, y: number, z: number): Bot {
  return {
    id: 1,
    kind,
    position: new Vector3(x, y, z),
    yaw: 0,
    health: 65,
    state: 'alive',
    deadT: 0,
    attackCooldown: 1,
    phase: 0,
    seed: 0,
    blockedT: 0,
    followT: 0,
    followSign: 1,
    climb: 0,
    groundY: 0,
    groundT: 0,
    stuckT: 0,
    doorScanT: 0,
    doorId: null,
    doorX: 0,
    doorZ: 0,
    doorFumbleT: 0,
    doorT: 0,
  }
}

/** The grounded per-frame step from enemies.tsx with zero steering intent:
 * settle, then the BOT WALL RULE capsule pass owns final placement. */
function settleFrames(world: GameWorld, bot: Bot, seconds: number): void {
  const dt = 1 / 60
  const vel = new Vector3()
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    settleGroundBot(world, bot, dt)
    vel.set(0, 0, 0)
    collideCapsule(bot.position, vel, world.colliders, GROUND_BOT_CAPSULE)
    collideVoxelTargets(bot.position, vel, GROUND_BOT_CAPSULE.radius, GROUND_BOT_CAPSULE.height)
  }
}

afterEach(() => {
  resetDestruction()
})

describe('BOTS ON FLOORS: ground bots settle to the landing plane, not y = 0', () => {
  test('bot standing on an upper-floor slab stays on it', () => {
    const world = makeWorld()
    const bot = makeBot('droid', 0.5, 3.0, 0.5)
    settleFrames(world, bot, 1)
    expect(bot.position.y).toBeCloseTo(3.0, 3)
  })

  test('bot over a carved hole falls to the storey below (cache holds ~0.2s, then fall rate)', () => {
    const world = makeWorld()
    const bot = makeBot('dog', 0, 3.0, 0)
    // Prime the cache against the intact floor.
    settleFrames(world, bot, 1 / 60)
    expect(bot.groundY).toBeCloseTo(3.0, 3)

    // Blow a bot-sized hole clean through the upper slab under the bot.
    ensureVoxelTarget(world, 'floor-2')
    expect(world.colliders[1]!.disabled).toBe(true) // voxels own the floor now
    damageTarget(world, 'floor-2', new Vector3(0, 3.0, 0), 1.0)
    damageTarget(world, 'floor-2', new Vector3(0, 2.7, 0), 1.0)

    // Cached probe holds — no per-frame probing, so no fall yet.
    settleFrames(world, bot, 0.1)
    expect(bot.position.y).toBeCloseTo(3.0, 3)

    // Re-probe lands within ~0.2 s and the bot drops onto the ground slab
    // (top y = 0.3). 0.8 s only suffices at the 6 m/s fall rate — the gentle
    // 3 m/s settle would still be ~0.9 m up — so this pins the rate too.
    settleFrames(world, bot, 0.8)
    expect(bot.position.y).toBeCloseTo(0.3, 3)
  })

  test('terrain bot keeps the legacy gentle settle to y = 0', () => {
    const world = makeWorld()
    const bot = makeBot('droid', 20, 0.4, 20) // far off both slabs
    // 0.1 s at the near-support rate (3 m/s) sheds exactly 0.3 m…
    settleFrames(world, bot, 0.1)
    expect(bot.position.y).toBeCloseTo(0.1, 3)
    // …and it finishes on the lot plane right after.
    settleFrames(world, bot, 0.1)
    expect(bot.position.y).toBeCloseTo(0, 3)
  })
})
