import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { resetDestruction, useDestruction } from './destruction'
import { playerRig } from './player'
import { fire, isMetalHit, isMetalTarget } from './shooting'
import { WEAPONS, type WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Tear routing, headless: kind-'wall' targets carve at weapon.tearRadius
 * (falling back to holeRadius) while every non-wall destructible stays on
 * holeRadius — plus the arsenal data that sells the owner's "MASSIVE holes
 * fast" call. Emission policy (walls dust-silent here) is enforced by code
 * ownership in destruction.ts and reviewed there.
 */

/** Deterministic test guns — zero spread so rays go exactly where aimed. */
const GUN: WeaponDef = {
  id: 'rifle',
  rate: 10,
  auto: true,
  damage: 24,
  holeRadius: 0.19,
  spread: 0,
  range: 90,
  melee: false,
  kick: 0,
}
const TEAR_GUN: WeaponDef = { ...GUN, tearRadius: 0.55 }

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

/** A 2m × 2.7m × 0.12m wall at the origin and a crate-item volume at x=10,
 * both facing the z=5 firing line — same layout as the smoke pass. */
function makeWorld(): GameWorld {
  const wall = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const crate = boxCollider('crate-1', 'item', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const colliders = [wall, crate]
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

/** Stand at (x, y, z) looking straight down -Z (yaw 0, pitch 0). */
function aimFrom(x: number, y: number, z: number): void {
  playerRig.position.set(x, y, z)
  playerRig.yaw = 0
  playerRig.pitch = 0
  playerRig.speed = 0
  playerRig.grounded = true
}

/** Fire one shot at a pristine world and report voxels the carve removed. */
function removedByOneShot(gun: WeaponDef, nodeId: string, aimX: number): number {
  resetDestruction()
  const world = makeWorld()
  aimFrom(aimX, 1.35, 5)
  expect(fire(world, gun)).toBe('wall')
  const target = useDestruction.getState().targets.get(nodeId)!
  expect(target).toBeDefined()
  return target.grid.count - target.grid.aliveCount
}

afterEach(() => {
  resetDestruction()
  // The rig is a module singleton and this file moves it: hand it back at the
  // origin. A leftover position is not inert — toggleOperable derives a door's
  // SWING DIRECTION from where the player stands, so a stale rig mirrors every
  // leaf the next test file opens (that is what broke door-stale-pose and
  // door-repose under `bun test --randomize`).
  playerRig.position.set(0, 0, 0)
  playerRig.shotTarget.set(0, 0, -1)
})

describe('third-person tracer target', () => {
  test('records the exact resolved hitscan endpoint for the offset muzzle', () => {
    resetDestruction()
    const world = makeWorld()
    aimFrom(0, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall')
    expect(playerRig.shotTarget.x).toBeCloseTo(0)
    expect(playerRig.shotTarget.y).toBeCloseTo(1.35)
    expect(playerRig.shotTarget.z).toBeCloseTo(0.06)
  })
})

describe('tear routing: tearRadius rules walls, holeRadius rules volumes', () => {
  test('a wall carve with tearRadius removes far more than holeRadius alone', () => {
    const plain = removedByOneShot(GUN, 'wall-1', 0)
    const torn = removedByOneShot(TEAR_GUN, 'wall-1', 0)
    expect(plain).toBeGreaterThan(0)
    // 0.55 m vs 0.19 m carve disc through both skins — MASSIVE, not subtle.
    expect(torn).toBeGreaterThan(plain * 3)
  })

  test('tearRadius does NOT touch non-wall volumes (tear lane = walls + slabs only)', () => {
    const plain = removedByOneShot(GUN, 'crate-1', 10)
    const torn = removedByOneShot(TEAR_GUN, 'crate-1', 10)
    expect(useDestruction.getState().targets.get('crate-1')!.kind).toBe('volume')
    expect(plain).toBeGreaterThan(0)
    expect(torn).toBe(plain)
  })

  test('no tearRadius falls back to holeRadius on walls (legacy defs keep working)', () => {
    const explicit = removedByOneShot({ ...GUN, tearRadius: GUN.holeRadius }, 'wall-1', 0)
    const fallback = removedByOneShot(GUN, 'wall-1', 0)
    expect(fallback).toBe(explicit)
  })
})

/**
 * Metal spark gate (phase 9 juice): only an explicit voxelize-time
 * `metal: true` flag routes a carve to the spark lane — every shape of
 * missing/false keeps the porcelain chip/puff read (targets predating the
 * destruction.ts sampling included). Pure, so it's pinned exhaustively.
 */
describe('metal spark gate', () => {
  test('only metal: true sparks metal', () => {
    expect(isMetalTarget(undefined)).toBe(false)
    expect(isMetalTarget(null)).toBe(false)
    expect(isMetalTarget({})).toBe(false)
    expect(isMetalTarget({ metal: false })).toBe(false)
    expect(isMetalTarget({ metal: undefined })).toBe(false)
    expect(isMetalTarget({ metal: true })).toBe(true)
  })

  test('per-cell mask localizes sparks; mask-less metal sparks everywhere', () => {
    const grid = {
      count: 2,
      centers: new Float32Array([0, 0, 0, 10, 0, 0]),
    }
    const masked = { metal: true, cellMetal: new Uint8Array([1, 0]), grid }
    expect(isMetalHit(masked, { x: 0.1, y: 0, z: 0 })).toBe(true) // near the metal cell
    expect(isMetalHit(masked, { x: 9.9, y: 0, z: 0 })).toBe(false) // near the wood cell
    // No mask (legacy / host-resolved metalness read): the flag alone decides.
    expect(isMetalHit({ metal: true, grid }, { x: 9.9, y: 0, z: 0 })).toBe(true)
    // The coarse gate still rules everything out when the flag is off.
    expect(isMetalHit({ metal: false, cellMetal: new Uint8Array([1, 1]), grid }, { x: 0, y: 0, z: 0 })).toBe(false)
    expect(isMetalHit(null, { x: 0, y: 0, z: 0 })).toBe(false)
  })

  test('a metal-flagged target changes cosmetics only — carves still land', () => {
    resetDestruction()
    const world = makeWorld()
    aimFrom(10, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall') // first blood voxelizes the crate
    const target = useDestruction.getState().targets.get('crate-1')!
    ;(target as { metal?: boolean }).metal = true
    const before = target.grid.count - target.grid.aliveCount
    expect(fire(world, GUN)).toBe('wall') // spark lane, headless-silent
    expect(target.grid.count - target.grid.aliveCount).toBeGreaterThan(before)
  })
})

describe('arsenal tear data', () => {
  test('every weapon tears wider than it drills', () => {
    for (const weapon of Object.values(WEAPONS)) {
      expect(weapon.tearRadius).toBeDefined()
      expect(weapon.tearRadius!).toBeGreaterThan(weapon.holeRadius)
    }
  })

  test('pistol tears ≈ 0.9 m across; minigun stays a hose (smaller per bullet)', () => {
    expect(WEAPONS.pistol.tearRadius!).toBeCloseTo(0.45)
    expect(WEAPONS.knife.tearRadius!).toBeCloseTo(0.3)
    expect(WEAPONS.rifle.tearRadius!).toBeCloseTo(0.55)
    expect(WEAPONS.minigun.tearRadius!).toBeCloseTo(0.34)
    expect(WEAPONS.minigun.tearRadius!).toBeLessThan(WEAPONS.rifle.tearRadius!)
    expect(WEAPONS.minigun.rate).toBeGreaterThanOrEqual(24)
  })
})

/**
 * BULLETS SEE THE LEAF (owner report 2026-08-29: "when in open position,
 * if I shoot it, it doesn't break"): an OPEN door's colliders are
 * `disabled` for movement but flagged `ballistic` by interact.tsx — the
 * hitscan loop must still test them, so the leaf voxelizes instead of the
 * round sailing through the doorway into whatever stands behind (live
 * repro: 3 rifle shots on the open warner-2 west door all carved the wall
 * 5 m behind while the door target stayed pristine at 98/98 cells).
 */
describe('ballistic colliders — open doors still eat the shot', () => {
  function doorWorld(): GameWorld {
    const door = boxCollider('door-1', 'door', [1, 2.1, 0.08], [0, 1.05, 0])
    const backWall = boxCollider('wall-1', 'wall', [4, 2.7, 0.12], [0, 1.35, -3])
    const colliders = [door, backWall]
    const buildingAabb = new Box3()
    for (const c of colliders) buildingAabb.union(c.worldBox)
    return {
      colliders,
      walls: new Map([
        [
          'wall-1',
          {
            node: { id: 'wall-1', start: [-2, -3], end: [2, -3], height: 2.7, thickness: 0.12 },
            root: backWall.root,
            meshes: [backWall.mesh],
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

  test('disabled WITHOUT ballistic: the round flies through and hits the wall behind (the bug)', () => {
    resetDestruction()
    const world = doorWorld()
    world.colliders[0]!.disabled = true
    aimFrom(0, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall')
    expect(useDestruction.getState().targets.has('door-1')).toBe(false)
    expect(useDestruction.getState().targets.has('wall-1')).toBe(true)
  })

  test('disabled + ballistic: the open leaf takes the hit and voxelizes (the fix)', () => {
    resetDestruction()
    const world = doorWorld()
    world.colliders[0]!.disabled = true
    world.colliders[0]!.ballistic = true
    aimFrom(0, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall') // door is DESTRUCTIBLE → carve lane
    expect(useDestruction.getState().targets.has('door-1')).toBe(true)
    expect(useDestruction.getState().targets.has('wall-1')).toBe(false)
    const target = useDestruction.getState().targets.get('door-1')!
    expect(target.grid.count - target.grid.aliveCount).toBeGreaterThan(0)
  })

  test('walkOnly stays bullet-transparent even when ballistic is set (voxels own those rays)', () => {
    resetDestruction()
    const world = doorWorld()
    world.colliders[0]!.walkOnly = true
    world.colliders[0]!.ballistic = true
    aimFrom(0, 1.35, 5)
    expect(fire(world, GUN)).toBe('wall')
    expect(useDestruction.getState().targets.has('door-1')).toBe(false)
    expect(useDestruction.getState().targets.has('wall-1')).toBe(true)
  })
})
