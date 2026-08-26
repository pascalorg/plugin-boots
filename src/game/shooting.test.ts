import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { resetDestruction, useDestruction } from './destruction'
import { playerRig } from './player'
import { fire } from './shooting'
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
