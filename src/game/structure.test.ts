import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  collapseWholeTarget,
  damageTarget,
  ensureVoxelTarget,
  resetDestruction,
  useDestruction,
} from './destruction'
import { slotId } from './grid'
import { onCollapse, registerPlacement, resetPieceSlots, setSceneSupportProbe } from './piece-slots'
import {
  probeTargetSupport,
  runStructureTickNow,
  STRUCTURE_TICK_MS,
  STRUCTURE_WAVE_MS,
  structurePendingWork,
} from './structure'
import type { ColliderEntry, GameWorld } from './world'
import { bvhFor } from './world'

/**
 * Cross-target support cascade (MULTILEVEL-PLAN Phase B3 V1): the pure
 * support probe's geometry, the carve → dirty → tick → whole-target crumble
 * wiring through destruction.ts, the wave caps + stagger, and the builder
 * piece-graph notification. Everything runs on real BVH box fixtures — the
 * same family as destruction.test.ts.
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

/** Empty world shell — tests push colliders / wall entries as needed. */
function makeWorld(): GameWorld {
  return {
    colliders: [],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: new Box3(),
    spawn: new Vector3(0, 0, 30),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Register a host wall (world.walls entry + collider) so ensureVoxelTarget
 * takes the anatomy lane and structure.ts flags it a crumble candidate.
 * `center` is the wall's world center; length runs along X. */
function addWall(
  world: GameWorld,
  nodeId: string,
  center: [number, number, number],
  length = 2,
  height = 2.7,
): ColliderEntry {
  const collider = boxCollider(nodeId, 'wall', [length, height, 0.12], center)
  world.colliders.push(collider)
  world.walls.set(nodeId, {
    node: {
      id: nodeId,
      start: [center[0] - length / 2, center[2]],
      end: [center[0] + length / 2, center[2]],
      height,
      thickness: 0.12,
    },
    root: collider.root,
    meshes: [collider.mesh],
  })
  return collider
}

/** A thin slab plate whose TOP surface lands at `topY`. */
function addSlab(
  world: GameWorld,
  nodeId: string,
  center: [number, number],
  topY: number,
  size: [number, number] = [2.4, 0.6],
  thickness = 0.15,
): ColliderEntry {
  const collider = boxCollider(
    nodeId,
    'slab',
    [size[0], thickness, size[1]],
    [center[0], topY - thickness / 2, center[1]],
  )
  world.colliders.push(collider)
  return collider
}

/** Carve EVERY cell of a target (full-depth radius beats the pierce gate). */
function carveAll(world: GameWorld, nodeId: string, points: [number, number, number][]): void {
  for (const [x, y, z] of points) {
    damageTarget(world, nodeId, new Vector3(x, y, z), 1.5)
  }
  expect(useDestruction.getState().targets.get(nodeId)!.grid.aliveCount).toBe(0)
}

const probeCtx = (world: GameWorld) => ({
  colliders: world.colliders,
  targets: () => useDestruction.getState().targets.values(),
})

const aliveOf = (nodeId: string) =>
  useDestruction.getState().targets.get(nodeId)!.grid.aliveCount

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  resetDestruction() // also resets structure.ts
  resetPieceSlots()
})

describe('probeTargetSupport — geometry', () => {
  test('wall on terrain is supported', () => {
    const world = makeWorld()
    addWall(world, 'wall-g', [0, 1.35, 0])
    const target = ensureVoxelTarget(world, 'wall-g')!
    expect(target.kind).toBe('wall')
    expect(probeTargetSupport(target, probeCtx(world))).toBe(true)
  })

  test('floating wall (nothing within the gap below) is unsupported', () => {
    const world = makeWorld()
    addWall(world, 'wall-f', [10, 4.05, 0]) // base at y = 2.7, air below
    const target = ensureVoxelTarget(world, 'wall-f')!
    expect(probeTargetSupport(target, probeCtx(world))).toBe(false)
  })

  test('wall on a live (non-voxelized) slab collider is supported', () => {
    const world = makeWorld()
    addWall(world, 'wall-s', [20, 4.05, 0])
    addSlab(world, 'slab-s', [20, 0], 2.7)
    const target = ensureVoxelTarget(world, 'wall-s')!
    expect(probeTargetSupport(target, probeCtx(world))).toBe(true)
  })

  test('wall on a VOXELIZED slab: live cells support, a full carve does not', () => {
    const world = makeWorld()
    addWall(world, 'wall-v', [30, 4.05, 0])
    addSlab(world, 'slab-v', [30, 0], 2.7)
    const wall = ensureVoxelTarget(world, 'wall-v')!
    ensureVoxelTarget(world, 'slab-v')! // collider hands over disabled
    expect(probeTargetSupport(wall, probeCtx(world))).toBe(true)
    carveAll(world, 'slab-v', [[29.2, 2.62, 0], [30, 2.62, 0], [30.8, 2.62, 0]])
    expect(probeTargetSupport(wall, probeCtx(world))).toBe(false)
  })

  test('a fully dead or pitched-basis target reports supported (never falls)', () => {
    const world = makeWorld()
    addWall(world, 'wall-d', [40, 4.05, 0])
    const target = ensureVoxelTarget(world, 'wall-d')!
    const pitched = {
      nodeId: 'roof-x',
      grid: { ...target.grid, q: { x: 0.3, y: 0, z: 0, w: 0.9539 } },
    }
    expect(probeTargetSupport(pitched, probeCtx(world))).toBe(true)
    collapseWholeTarget('wall-d')
    expect(probeTargetSupport(target, probeCtx(world))).toBe(true)
  })
})

describe('carve → cascade wiring (destruction hooks)', () => {
  test('carving the slab under an upper wall drops the wall on the next tick', () => {
    const world = makeWorld()
    addWall(world, 'wall-ground', [0, 1.35, 0])
    addWall(world, 'wall-up', [20, 4.05, 0])
    addSlab(world, 'slab-up', [20, 0], 2.7)
    ensureVoxelTarget(world, 'wall-ground')!
    const wall = ensureVoxelTarget(world, 'wall-up')!
    ensureVoxelTarget(world, 'slab-up')!
    // Carving the slab marks its dependents dirty (register-interest hook).
    carveAll(world, 'slab-up', [[19.2, 2.62, 0], [20, 2.62, 0], [20.8, 2.62, 0]])
    expect(wall.grid.aliveCount).toBeGreaterThan(0)
    runStructureTickNow()
    expect(wall.grid.aliveCount).toBe(0)
    // The terrain-borne wall never joins the cascade.
    expect(aliveOf('wall-ground')).toBeGreaterThan(0)
  })

  test('collapse cancels the pending island timer and queues cells for the renderer', () => {
    const world = makeWorld()
    addWall(world, 'wall-q', [50, 4.05, 0])
    const target = ensureVoxelTarget(world, 'wall-q')!
    const total = target.grid.aliveCount
    const removed = collapseWholeTarget('wall-q')
    expect(removed).toBe(total)
    expect(target.removedQueue.length).toBeGreaterThanOrEqual(total)
    expect(collapseWholeTarget('wall-q')).toBe(0) // idempotent
  })
})

describe('cascade caps + stagger', () => {
  test('one tick crumbles at most 4 walls; the rest wait for the next tick', async () => {
    const world = makeWorld()
    addSlab(world, 'slab-wide', [40, 0], 2.7, [8, 0.6])
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const id = `wall-c${i}`
      ids.push(id)
      addWall(world, id, [36.75 + i * 1.3, 4.05, 0], 1)
      ensureVoxelTarget(world, id)!
    }
    ensureVoxelTarget(world, 'slab-wide')!
    carveAll(
      world,
      'slab-wide',
      Array.from({ length: 9 }, (_, i) => [36.4 + i * 0.95, 2.62, 0] as [number, number, number]),
    )
    runStructureTickNow()
    const fallen = ids.filter((id) => aliveOf(id) === 0)
    expect(fallen.length).toBe(4) // STRUCTURE_WAVE_CAP
    expect(structurePendingWork()).toBe(true) // deferred work is never lost
    await sleep(STRUCTURE_TICK_MS + 120)
    for (const id of ids) expect(aliveOf(id)).toBe(0)
  })

  test('a tower cascades wave by wave, STRUCTURE_WAVE_MS apart', async () => {
    const world = makeWorld()
    addWall(world, 'tower-a', [60, 1.35, 0])
    addWall(world, 'tower-b', [60, 4.05, 0])
    addWall(world, 'tower-c', [60, 6.75, 0])
    for (const id of ['tower-a', 'tower-b', 'tower-c']) ensureVoxelTarget(world, id)!
    carveAll(world, 'tower-a', [[59.2, 1.35, 0], [60, 1.35, 0], [60.8, 1.35, 0]])
    runStructureTickNow()
    // Wave 0: only the wall that stood on the carved one falls…
    expect(aliveOf('tower-b')).toBe(0)
    expect(aliveOf('tower-c')).toBeGreaterThan(0)
    expect(structurePendingWork()).toBe(true)
    // …wave 1 lands a beat later (the staggered chain-collapse feel).
    await sleep(STRUCTURE_WAVE_MS + 100)
    expect(aliveOf('tower-c')).toBe(0)
  })
})

describe('piece-graph notification (goal 3)', () => {
  test('a host-wall collapse re-probes builder pieces via notifySceneSupportChanged', async () => {
    const world = makeWorld()
    addWall(world, 'wall-host', [70, 4.05, 0])
    ensureVoxelTarget(world, 'wall-host')!
    // A storey-1 piece (not terrain-grounded) propped only by the scene probe.
    let sceneAlive = true
    setSceneSupportProbe(() => sceneAlive)
    const slot = slotId({ kind: 'Wz', i: 30, k: 0, s: 1 })
    expect(registerPlacement(slot, 7)).toBe(true)
    const fallen: number[] = []
    onCollapse((pieceId) => fallen.push(pieceId))
    // The wall the probe stood for crumbles structurally…
    sceneAlive = false
    collapseWholeTarget('wall-host')
    expect(fallen).toEqual([]) // debounced — not synchronous
    // …and the debounced scene-support sweep (160 ms) cascades the piece.
    await sleep(260)
    expect(fallen).toEqual([7])
  })
})
