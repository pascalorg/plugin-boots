import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import type { PlacedPiece } from '../store'
import { isOccupied, PIECE_DIMS, piecePose, resolveSnap } from './builder'
import { dropTarget, resetDestruction, useDestruction } from './destruction'
import { playerRig } from './player'
import { fire } from './shooting'
import type { WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Builder phase-2 grammar, headless: the pure snap resolver (wall chains +
 * stacks, floor tiling, ramp low-edge docking), identical-pose occupancy,
 * and the destructibility route for placed pieces (nodeType 'block' →
 * voxelize on first hit, dropTarget on undo).
 */

let nextId = 1
function placed(piece: PlacedPiece['piece'], x: number, y: number, z: number, yaw: number): PlacedPiece {
  return { id: nextId++, piece, position: [x, y, z], yaw }
}

/** Aim ray that stays level at this height — gates wall stacking. */
const aimLow = () => 0
const aimHigh = () => 100

describe('resolveSnap: walls', () => {
  test('chains end-to-end along the neighbor axis when yaw is parallel', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const snap = resolveSnap('wall', pieces, { x: 3.9, y: 0, z: 0.6, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(3)
    expect(snap!.y).toBeCloseTo(0)
    expect(snap!.z).toBeCloseTo(0)
    expect(snap!.yaw).toBeCloseTo(0)
  })

  test('perpendicular yaw does not chain (corner walls stay on the grid)', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const snap = resolveSnap('wall', pieces, { x: 3.9, y: 0, z: 0.6, yaw: Math.PI / 2 }, aimLow)
    expect(snap).toBeNull()
  })

  test('stacks on top when the aim ray passes above mid-height', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    // Perpendicular yaw so only the stack candidate exists.
    const raw = { x: 0, y: 0, z: 0, yaw: Math.PI / 2 }
    expect(resolveSnap('wall', pieces, raw, aimLow)).toBeNull()
    const snap = resolveSnap('wall', pieces, raw, aimHigh)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(0)
    expect(snap!.y).toBeCloseTo(2.8)
    expect(snap!.z).toBeCloseTo(0)
    expect(snap!.yaw).toBeCloseTo(0) // stacked wall adopts the wall below
  })

  test('nearest candidate wins, plain grid when nothing is in range', () => {
    const pieces = [placed('wall', 0, 0, 0, 0), placed('wall', 9, 0, 0, 0)]
    const snap = resolveSnap('wall', pieces, { x: 5.7, y: 0, z: 0.3, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(6) // wall B's near-end candidate outpulls A's
    expect(resolveSnap('wall', pieces, { x: 30, y: 0, z: 30, yaw: 0 }, aimLow)).toBeNull()
  })
})

describe('resolveSnap: floors', () => {
  test('tiles edge-to-edge on the same plane, any approach side', () => {
    const pieces = [placed('floor', 0, 0, 0, 0)]
    const snap = resolveSnap('floor', pieces, { x: 0.6, y: 0, z: 2.4, yaw: Math.PI / 2 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(0)
    expect(snap!.y).toBeCloseTo(0)
    expect(snap!.z).toBeCloseTo(3)
  })
})

describe('resolveSnap: ramps', () => {
  test('low edge docks to a floor edge, rising away from the floor', () => {
    const pieces = [placed('floor', 0, 0, 0, 0)]
    const snap = resolveSnap('ramp', pieces, { x: 2.7, y: 0, z: 0.3, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(3)
    expect(snap!.z).toBeCloseTo(0)
    // Low edge = center + 1.5·(-sin yaw, -cos yaw) must land on the floor
    // edge at (1.5, 0) — i.e. the ramp climbs away from the floor.
    const lowX = snap!.x - 1.5 * Math.sin(snap!.yaw)
    const lowZ = snap!.z - 1.5 * Math.cos(snap!.yaw)
    expect(lowX).toBeCloseTo(1.5)
    expect(lowZ).toBeCloseTo(0)
  })

  test('low edge docks to a wall base, high edge kissing the wall top', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const snap = resolveSnap('ramp', pieces, { x: 0.3, y: 0, z: 1.2, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(0)
    expect(snap!.z).toBeCloseTo(1.5)
    // High edge = center - 1.5·L sits on the wall line (z = 0); the ramp
    // rises WALL_H so it tops out level with the wall.
    const highZ = snap!.z + 1.5 * Math.cos(snap!.yaw)
    expect(highZ).toBeCloseTo(0)
  })
})

describe('isOccupied: identical poses up to piece symmetry', () => {
  test('walls match modulo π, ramps are direction-sensitive', () => {
    const pieces = [placed('wall', 0, 0, 0, 0), placed('ramp', 6, 0, 0, 0)]
    expect(isOccupied(pieces, 'wall', 0, 0, 0, 0)).toBe(true)
    expect(isOccupied(pieces, 'wall', 0, 0, 0, Math.PI)).toBe(true) // same box
    expect(isOccupied(pieces, 'wall', 0, 2.8, 0, 0)).toBe(false) // stacked level is free
    expect(isOccupied(pieces, 'floor', 0, 0, 0, 0)).toBe(false) // other piece kind
    expect(isOccupied(pieces, 'ramp', 6, 0, 0, Math.PI)).toBe(false) // reversed ramp differs
    expect(isOccupied(pieces, 'ramp', 6, 0, 0, -0.0)).toBe(true)
  })

  test('floors match modulo π/2 (square footprint)', () => {
    const pieces = [placed('floor', 0, 0, 0, 0)]
    expect(isOccupied(pieces, 'floor', 0, 0, 0, Math.PI / 2)).toBe(true)
    expect(isOccupied(pieces, 'floor', 0, 0, 3, 0)).toBe(false)
  })
})

// --- Destructibility of placed pieces (requirement: built walls break) -----

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

/** A world holding exactly one placed-piece collider, registered the way
 * PlacedPieceMesh does it: nodeType 'block', mesh doubling as collider. */
function worldWithPlacedWall(): GameWorld {
  const pose = piecePose('wall', 0)
  const mesh = new Mesh(new BoxGeometry(...PIECE_DIMS.wall))
  mesh.position.set(0, pose.y, 0)
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const entry: ColliderEntry = {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
    root: mesh,
    nodeId: '__boots-piece-1',
    nodeType: 'block',
  }
  return {
    colliders: [entry],
    walls: new Map(),
    glass: [],
    doors: [],
    buildingAabb: entry.worldBox.clone(),
    spawn: new Vector3(0, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

afterEach(() => {
  resetDestruction()
})

describe('placed pieces are destructible', () => {
  test("nodeType 'block' routes through the voxel manager; undo drops the replica", () => {
    const world = worldWithPlacedWall()
    playerRig.position.set(0, 1.4, 5)
    playerRig.yaw = 0
    playerRig.pitch = 0
    playerRig.speed = 0
    playerRig.grounded = true

    expect(fire(world, GUN)).toBe('wall') // voxelized + carved, not a spark
    expect(useDestruction.getState().targets.has('__boots-piece-1')).toBe(true)

    // G-undo path: PlacedPieceMesh cleanup calls dropTarget(nodeId).
    dropTarget('__boots-piece-1')
    expect(useDestruction.getState().targets.has('__boots-piece-1')).toBe(false)
  })
})
