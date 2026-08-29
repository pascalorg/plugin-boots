import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { collideCapsule } from './collision'
import {
  collideVoxelTargets,
  ensureVoxelTarget,
  resetDestruction,
} from './destruction'
import { meleeBlocked } from './enemies'
import {
  type Bot,
  type BotKind,
  botVisualParams,
  DRONE_CAPSULE,
  droneDescentBlocked,
  dronePathBlocked,
  pointInColliderBoxes,
  segmentHitsBox,
} from './enemies-state'
import { playerRig } from './player'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * DRONE WALL RULE + fair fights — drones used to have ZERO collision
 * (horizontal step + a pure vertical lerp through geometry), avoidance
 * probes slaved to the PLAYER's altitude, XZ-only reach and attacks that
 * skipped the melee LOS gate: they phased through elevated floors and hit
 * you through your own roof. Pinned here:
 * - the pure steering math (path sweep with vertical intent, wall-top skim,
 *   descent-corridor hold — enemies-state.ts),
 * - the capsule TRUTH: a drone lerping down onto a placed floor, or flying
 *   at a pristine/voxelized wall, resolves exactly like a ground bot and
 *   never phases (collideCapsule + collideVoxelTargets, DRONE_CAPSULE),
 * - melee LOS for ALL bot kinds: an elevated wall between a drone and the
 *   player blocks the hit, and the exact segment sweep means a closed door
 *   leaf near either end of the swing blocks it too (the old single
 *   midpoint probe let bots punch through doors).
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

function makeWorld(colliders: ColliderEntry[]): GameWorld {
  const buildingAabb = new Box3()
  for (const collider of colliders) buildingAabb.union(collider.worldBox)
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

/** A wall the destruction system can voxelize (enemies-wall.test.ts shape). */
function makeWallWorld(): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const world = makeWorld([wall])
  world.walls = new Map([
    [
      'wall-1',
      {
        node: { id: 'wall-1', start: [-1, 0], end: [1, 0], height: 2.7, thickness: 0.12 },
        root: wall.root,
        meshes: [wall.mesh],
      },
    ],
  ])
  return world
}

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
    visual: botVisualParams(1, kind, 0),
  }
}

/** The exact per-frame drone step from enemies.tsx: altitude lerp toward
 * targetY, horizontal step, then the DRONE_CAPSULE resolution (the truth). */
function flyDrone(
  world: GameWorld,
  from: Vector3,
  targetY: number,
  moveX: number,
  moveZ: number,
  seconds: number,
): Vector3 {
  const pos = from.clone()
  const vel = new Vector3()
  const feet = new Vector3()
  const dt = 1 / 60
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) {
    pos.y += (targetY - pos.y) * Math.min(1, dt * 2.2)
    pos.x += moveX * dt
    pos.z += moveZ * dt
    vel.set(moveX, 0, moveZ)
    feet.set(pos.x, pos.y - DRONE_CAPSULE.height / 2, pos.z)
    collideCapsule(feet, vel, world.colliders, DRONE_CAPSULE)
    collideVoxelTargets(feet, vel, DRONE_CAPSULE.radius, DRONE_CAPSULE.height)
    pos.set(feet.x, feet.y + DRONE_CAPSULE.height / 2, feet.z)
  }
  return pos
}

afterEach(() => {
  resetDestruction()
})

describe('drone steering probes: pure path/descent decisions', () => {
  // An elevated floor slab: top at y = 5, well above the ground-bot band.
  const floor = { worldBox: new Box3(new Vector3(-2, 4.8, -3), new Vector3(2, 5, 0)) }

  test('descending path toward the player reads the floor it would cut through', () => {
    // Drone at y 6 diving forward+down; the old rotor-height probes (bot y
    // and bot y - 0.6 at the far point) both clear the slab — the fix probes
    // the DISPLACEMENT, vertical included, and catches it.
    expect(pointInColliderBoxes([floor], 0, 6, -0.2)).toBe(false)
    expect(pointInColliderBoxes([floor], 0, 5.4, -0.2)).toBe(false)
    expect(dronePathBlocked([floor], 0, 6, 1, 0, -1.2, -1.2)).toBe(true)
  })

  test('clear air along the whole displacement is not blocked', () => {
    expect(dronePathBlocked([floor], 0, 6, 1, 0, 0, -1.2)).toBe(false)
  })

  test('wall-top skim: a wall crested just barely still reads solid', () => {
    // Wall top at y 5.5; flight line level at y 6 never intersects it — the
    // extra probe 0.6 under the far end does, so the drone keeps climbing
    // instead of clipping the parapet.
    const wall = { worldBox: new Box3(new Vector3(-2, 0, -1.5), new Vector3(2, 5.5, -1.1)) }
    expect(dronePathBlocked([wall], 0, 6, 0, 0, 0, -1.2)).toBe(true)
    // A full meter higher clears it.
    expect(dronePathBlocked([wall], 0, 6.6, 0, 0, 0, -1.2)).toBe(false)
  })

  test('descent corridor: a thin slab under the rotors holds altitude', () => {
    // Drone hovering 0.6 over the slab top wants to settle 0.5 — the sweep
    // (drop + rotor clearance) hits the 0.2-thick slab; point samples at
    // half/full depth would straddle it.
    expect(droneDescentBlocked([floor], 0, 5.6, -1, 0.5)).toBe(true)
    // Same drop with the slab far below the corridor: free to settle.
    expect(droneDescentBlocked([floor], 0, 9, -1, 0.5)).toBe(false)
    // Off the slab's footprint: free to settle.
    expect(droneDescentBlocked([floor], 5, 5.6, -1, 0.5)).toBe(false)
  })

  test('segmentHitsBox: exact slab test, both misses and grazes', () => {
    const box = new Box3(new Vector3(-1, 0, -0.06), new Vector3(1, 2, 0.06))
    // Straight through the leaf.
    expect(segmentHitsBox(box, 0, 1, 1, 0, 0, -1, 2)).toBe(true)
    // Stops short of it.
    expect(segmentHitsBox(box, 0, 1, 1, 0, 0, -1, 0.5)).toBe(false)
    // Parallel, offset outside.
    expect(segmentHitsBox(box, 0, 3, 1, 0, 0, -1, 2)).toBe(false)
  })
})

describe('DRONE_CAPSULE geometry', () => {
  test('REGRESSION: stays a LEGAL capsule — height ≥ 2·radius', () => {
    // radius 0.3 × height 0.5 inverted the core segment (start above end),
    // so both narrow phases resolved a hull overhanging the y..y+height
    // broad-phase box by 0.1 m below AND above: drones hovered proud of
    // floors and bumped lintels early.
    expect(DRONE_CAPSULE.height).toBeGreaterThanOrEqual(2 * DRONE_CAPSULE.radius)
    expect(DRONE_CAPSULE.radius).toBeGreaterThan(0)
  })
})

describe('DRONE WALL RULE: the capsule is truth', () => {
  test('a drone above a placed floor cannot descend through it', () => {
    // Elevated floor slab, top at y = 5; the drone starts at y 6.5 and lerps
    // hard toward a player at ground level. The capsule pass must leave its
    // body resting ON the slab, never below it.
    const world = makeWorld([boxCollider('floor-1', 'block', [4, 0.2, 4], [0, 4.9, 0])])
    const end = flyDrone(world, new Vector3(0, 6.5, 0), 1.5, 0, 0, 4)
    expect(end.y - DRONE_CAPSULE.height / 2).toBeGreaterThanOrEqual(5 - 1e-3)
  })

  test('a pristine elevated wall blocks horizontal drone flight', () => {
    // Wall spanning y 4..6 on the z = 0 line; drone flies level at y 5.
    const world = makeWorld([boxCollider('wall-e', 'wall', [4, 2, 0.12], [0, 5, 0])])
    const end = flyDrone(world, new Vector3(0, 5, 2), 5, 0, -3.4, 4)
    expect(end.z).toBeGreaterThan(0)
  })

  test('a voxelized wall blocks drone flight while its voxels live', () => {
    const world = makeWallWorld()
    ensureVoxelTarget(world, 'wall-1')
    expect(world.colliders[0]!.disabled).toBe(true) // voxels own collision now
    const end = flyDrone(world, new Vector3(0, 1.35, 2), 1.35, 0, -3.4, 4)
    expect(end.z).toBeGreaterThan(0)
  })
})

describe('melee LOS gates every bot kind', () => {
  test('an elevated wall between a drone and the player blocks the hit', () => {
    const world = makeWorld([boxCollider('wall-e', 'wall', [4, 2, 0.12], [0, 5, 0])])
    playerRig.position.set(0, 5, -1.5)
    const drone = makeBot('drone', 0, 5, 1.5)
    expect(meleeBlocked(world, drone)).toBe(true)
    // Same geometry, drone on the player's side of the wall: clear swing.
    drone.position.set(0, 5, -0.5)
    expect(meleeBlocked(world, drone)).toBe(false)
  })

  test('a closed door leaf near the end of the swing still blocks (no punching through doors)', () => {
    // Leaf at z ≈ 1.1 — 0.4 m from the droid's chest, far from the segment
    // midpoint the old probe sampled. The exact sweep catches it.
    const world = makeWorld([boxCollider('door-1', 'door', [1, 2.1, 0.1], [0, 1.05, 1.1])])
    playerRig.position.set(0, 1.6, -0.5)
    const droid = makeBot('droid', 0, 0, 1.5)
    expect(meleeBlocked(world, droid)).toBe(true)
    // Door removed → the same swing lands.
    expect(meleeBlocked(makeWorld([]), droid)).toBe(false)
  })
})
