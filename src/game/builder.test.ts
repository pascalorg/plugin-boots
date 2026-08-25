import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { FULL_MASK, type PlacedPiece } from '../store'
import {
  CELLS,
  cellCenter,
  cellDims,
  isOccupied,
  maskBit,
  PIECE_DIMS,
  piecePose,
  planWallMask,
  raycastPieceCell,
  resolveSnap,
  trimmedWallSpan,
} from './builder'
import { dropTarget, resetDestruction, useDestruction } from './destruction'
import { playerRig } from './player'
import { fire } from './shooting'
import type { WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Builder grammar, headless: the pure snap resolver (wall chains + stacks,
 * floor tiling, roof low-edge docking), identical-pose occupancy, the 3×3
 * cell-mask math (cell picking, Keep's mask → node planning), and the
 * destructibility route for placed pieces (nodeType 'block' → voxelize on
 * first hit, dropTarget on undo).
 */

let nextId = 1
function placed(
  piece: PlacedPiece['piece'],
  x: number,
  y: number,
  z: number,
  yaw: number,
  mask = FULL_MASK,
): PlacedPiece {
  return { id: nextId++, piece, position: [x, y, z], yaw, mask }
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

  test('stacks on top when the aim ray passes above 3/4 of the height', () => {
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

  // Stacking-reach cases: STACK_GATE = 0.75 · WALL_H (2.8) = 2.1.
  test('a level gaze at eye height (1.58) does NOT stack — real tilt required', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const raw = { x: 0, y: 0, z: 0, yaw: Math.PI / 2 }
    // 1.58 clears the old mid-height gate (1.4) — that auto-towered.
    expect(resolveSnap('wall', pieces, raw, () => 1.58)).toBeNull()
    // Just above the 3/4 gate (2.1) stacks.
    const snap = resolveSnap('wall', pieces, raw, () => 2.2)
    expect(snap).not.toBeNull()
    expect(snap!.y).toBeCloseTo(2.8)
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

describe('resolveSnap: floor on wall top (roofing)', () => {
  // Same STACK_GATE as walls: aim ray must clear 0.75 · WALL_H = 2.1 at the
  // wall's XZ, so ground-level floor tiling beside a wall never lifts.
  test('a level gaze never lifts the floor onto the wall — real tilt required', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const raw = { x: 0.3, y: 0, z: 1.2, yaw: 0 }
    expect(resolveSnap('floor', pieces, raw, aimLow)).toBeNull()
    // Eye-height level gaze (1.58) is still below the 2.1 gate.
    expect(resolveSnap('floor', pieces, raw, () => 1.58)).toBeNull()
  })

  test('upward tilt roofs the wall: floor at the top, edge flush, near side', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    // Wall yaw 0 → normal (0, 1): candidates at z ±1.5, y = WALL_H.
    const snap = resolveSnap('floor', pieces, { x: 0.3, y: 0, z: 1.2, yaw: 0 }, aimHigh)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(0)
    expect(snap!.y).toBeCloseTo(2.8)
    expect(snap!.z).toBeCloseTo(1.5) // the player's side of the wall plane
    expect(snap!.yaw).toBeCloseTo(0) // adopts the wall's yaw
    // Edge flush: near floor edge z = 1.5 − 1.5 = 0, on the wall line.
  })

  test('the far side of the wall plane is the second candidate', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const snap = resolveSnap('floor', pieces, { x: -0.3, y: 0, z: -1.2, yaw: Math.PI / 2 }, aimHigh)
    expect(snap).not.toBeNull()
    expect(snap!.y).toBeCloseTo(2.8)
    expect(snap!.z).toBeCloseTo(-1.5)
    expect(snap!.yaw).toBeCloseTo(0) // wall yaw adopted (floor is π/2-symmetric)
  })

  test('rotated wall: candidates offset along the wall normal', () => {
    const pieces = [placed('wall', 0, 0, 0, Math.PI / 2)]
    // Wall runs along Z, normal (1, 0): candidates at x ±1.5.
    const snap = resolveSnap('floor', pieces, { x: 1.2, y: 0, z: 0.3, yaw: 0 }, aimHigh)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(1.5)
    expect(snap!.y).toBeCloseTo(2.8)
    expect(snap!.z).toBeCloseTo(0)
  })

  test('ground tiling beside a wall stays flat under a level gaze', () => {
    const pieces = [placed('floor', 0, 0, 0, 0), placed('wall', 3, 0, 1.5, 0)]
    const snap = resolveSnap('floor', pieces, { x: 3, y: 0, z: 0.6, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(3) // the floor-tile candidate, not a roof pose
    expect(snap!.y).toBeCloseTo(0)
    expect(snap!.z).toBeCloseTo(0)
  })

  test('same-level tile outweighs the roof pose when both are in range', () => {
    const pieces = [placed('floor', 0, 0, 0, 0), placed('wall', 3, 0, 0.9, 0)]
    // aimHigh: the roof candidate at (3, 2.8, −0.6) IS considered (XZ 0.9 ≤
    // SNAP_RANGE) but the Y weight keeps the ground tile at (3, 0, 0) ahead.
    const snap = resolveSnap('floor', pieces, { x: 3, y: 0, z: 0.3, yaw: 0 }, aimHigh)
    expect(snap).not.toBeNull()
    expect(snap!.y).toBeCloseTo(0)
    expect(snap!.z).toBeCloseTo(0)
  })

  test('occupancy at roof level respects the floor π/2 symmetry', () => {
    const pieces = [placed('wall', 0, 0, 0, 0), placed('floor', 0, 2.8, 1.5, 0)]
    expect(isOccupied(pieces, 'floor', 0, 2.8, 1.5, Math.PI / 2)).toBe(true) // same square
    expect(isOccupied(pieces, 'floor', 0, 2.8, -1.5, 0)).toBe(false) // far side still free
    expect(isOccupied(pieces, 'floor', 0, 0, 1.5, 0)).toBe(false) // ground level still free
  })
})

describe('resolveSnap: roofs', () => {
  test('low edge docks to a floor edge, rising away from the floor', () => {
    const pieces = [placed('floor', 0, 0, 0, 0)]
    const snap = resolveSnap('roof', pieces, { x: 2.7, y: 0, z: 0.3, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(3)
    expect(snap!.z).toBeCloseTo(0)
    // Low edge = center + 1.5·(-sin yaw, -cos yaw) must land on the floor
    // edge at (1.5, 0) — i.e. the roof climbs away from the floor.
    const lowX = snap!.x - 1.5 * Math.sin(snap!.yaw)
    const lowZ = snap!.z - 1.5 * Math.cos(snap!.yaw)
    expect(lowX).toBeCloseTo(1.5)
    expect(lowZ).toBeCloseTo(0)
  })

  test('low edge docks to a wall base, high edge kissing the wall top', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const snap = resolveSnap('roof', pieces, { x: 0.3, y: 0, z: 1.2, yaw: 0 }, aimLow)
    expect(snap).not.toBeNull()
    expect(snap!.x).toBeCloseTo(0)
    expect(snap!.z).toBeCloseTo(1.5)
    // High edge = center - 1.5·L sits on the wall line (z = 0); the roof
    // rises WALL_H so it tops out level with the wall.
    const highZ = snap!.z + 1.5 * Math.cos(snap!.yaw)
    expect(highZ).toBeCloseTo(0)
  })
})

describe('isOccupied: identical poses up to piece symmetry', () => {
  test('walls match modulo π, roofs are direction-sensitive', () => {
    const pieces = [placed('wall', 0, 0, 0, 0), placed('roof', 6, 0, 0, 0)]
    expect(isOccupied(pieces, 'wall', 0, 0, 0, 0)).toBe(true)
    expect(isOccupied(pieces, 'wall', 0, 0, 0, Math.PI)).toBe(true) // same box
    expect(isOccupied(pieces, 'wall', 0, 2.8, 0, 0)).toBe(false) // stacked level is free
    expect(isOccupied(pieces, 'floor', 0, 0, 0, 0)).toBe(false) // other piece kind
    expect(isOccupied(pieces, 'roof', 6, 0, 0, Math.PI)).toBe(false) // reversed roof differs
    expect(isOccupied(pieces, 'roof', 6, 0, 0, -0.0)).toBe(true)
  })

  test('floors match modulo π/2 (square footprint)', () => {
    const pieces = [placed('floor', 0, 0, 0, 0)]
    expect(isOccupied(pieces, 'floor', 0, 0, 0, Math.PI / 2)).toBe(true)
    expect(isOccupied(pieces, 'floor', 0, 0, 3, 0)).toBe(false)
  })
})

// --- 3×3 cell grid math ----------------------------------------------------

describe('cell grid: bits, dims, centers', () => {
  test('maskBit is col + row·3', () => {
    expect(maskBit(0, 0)).toBe(0)
    expect(maskBit(1, 0)).toBe(1) // bottom-center (door pocket)
    expect(maskBit(1, 1)).toBe(4) // center (window pocket)
    expect(maskBit(2, 2)).toBe(8)
    expect(CELLS).toBe(3)
  })

  test('wall cells are 1 × 0.93 × full thickness; planes split 3×3', () => {
    expect(cellDims('wall')[0]).toBeCloseTo(1)
    expect(cellDims('wall')[1]).toBeCloseTo(2.8 / 3)
    expect(cellDims('wall')[2]).toBeCloseTo(0.12)
    expect(cellDims('floor')).toEqual([1, 0.12, 1])
    expect(cellDims('roof')[2]).toBeCloseTo(4.1 / 3)
  })

  test('cell centers: wall row 0 is the bottom, floor row 0 is local −Z', () => {
    const wallBottomLeft = cellCenter('wall', 0, 0)
    expect(wallBottomLeft[0]).toBeCloseTo(-1)
    expect(wallBottomLeft[1]).toBeCloseTo(-2.8 / 2 + 2.8 / 6)
    expect(cellCenter('wall', 1, 1)).toEqual([0, 0, 0]) // dead center
    const floorNear = cellCenter('floor', 2, 0)
    expect(floorNear[0]).toBeCloseTo(1)
    expect(floorNear[2]).toBeCloseTo(-1)
  })
})

describe('raycastPieceCell: crosshair → cell', () => {
  test('straight-on wall shots resolve center / bottom-center / corner cells', () => {
    const wall = placed('wall', 0, 0, 0, 0)
    const center = raycastPieceCell(wall, 0, 1.4, 5, 0, 0, -1, 10)
    expect(center).not.toBeNull()
    expect(center!.bit).toBe(4)
    expect(center!.t).toBeCloseTo(5 - 0.06)
    expect(raycastPieceCell(wall, 0, 0.4, 5, 0, 0, -1, 10)!.bit).toBe(1) // bottom-center
    const corner = raycastPieceCell(wall, -1.2, 2.4, 5, 0, 0, -1, 10)!
    expect(corner.col).toBe(0)
    expect(corner.row).toBe(2)
    expect(corner.bit).toBe(6)
  })

  test('yawed wall maps columns in its local frame', () => {
    // Yaw π/2: local +X (col 2) points at world −Z.
    const wall = placed('wall', 0, 0, 0, Math.PI / 2)
    const hit = raycastPieceCell(wall, 5, 1.4, -1.2, -1, 0, 0, 10)
    expect(hit).not.toBeNull()
    expect(hit!.col).toBe(2)
    expect(hit!.row).toBe(1)
    expect(hit!.bit).toBe(5)
  })

  test('beyond maxDist misses; tilted roof rows follow the incline', () => {
    const wall = placed('wall', 0, 0, 0, 0)
    expect(raycastPieceCell(wall, 0, 1.4, 5, 0, 0, -1, 3)).toBeNull()
    // Roof at yaw 0: low edge at world z −1.5, rising to +1.5. A straight
    // -down ray over the low third must land in row 0, center column.
    const roof = placed('roof', 0, 0, 0, 0)
    const hit = raycastPieceCell(roof, 0, 5, -1.04, 0, -1, 0, 10)
    expect(hit).not.toBeNull()
    expect(hit!.col).toBe(1)
    expect(hit!.row).toBe(0)
  })
})

// --- Keep: mask → node planning --------------------------------------------

describe('planWallMask: trim columns + pocket detection', () => {
  const col = (c: number) => (1 << c) | (1 << (c + 3)) | (1 << (c + 6))

  test('intact mask keeps a plain full wall', () => {
    expect(planWallMask(FULL_MASK)).toEqual({
      kind: 'wall',
      trimStartCols: 0,
      trimEndCols: 0,
      pocket: 'none',
      exact: true,
    })
  })

  test('empty mask is skipped', () => {
    expect(planWallMask(0)).toEqual({ kind: 'skip' })
  })

  test('center pocket with the ring alive reads as a window', () => {
    const plan = planWallMask(FULL_MASK & ~(1 << 4))
    expect(plan.kind).toBe('wall')
    if (plan.kind === 'wall') {
      expect(plan.pocket).toBe('window')
      expect(plan.exact).toBe(true)
      expect(plan.trimStartCols).toBe(0)
      expect(plan.trimEndCols).toBe(0)
    }
  })

  test('bottom-center pocket reads as a door (center may join it)', () => {
    const short = planWallMask(FULL_MASK & ~(1 << 1))
    const tall = planWallMask(FULL_MASK & ~((1 << 1) | (1 << 4)))
    expect(short.kind === 'wall' && short.pocket).toBe('door')
    expect(tall.kind === 'wall' && tall.pocket).toBe('door')
  })

  test('fully-dead end columns trim the wall', () => {
    const left = planWallMask(FULL_MASK & ~col(0))
    expect(left.kind === 'wall' && left.trimStartCols).toBe(1)
    expect(left.kind === 'wall' && left.trimEndCols).toBe(0)
    expect(left.kind === 'wall' && left.exact).toBe(true)
    const right = planWallMask(FULL_MASK & ~col(2))
    expect(right.kind === 'wall' && right.trimEndCols).toBe(1)
    const middleOnly = planWallMask(col(1))
    expect(middleOnly.kind === 'wall' && middleOnly.trimStartCols).toBe(1)
    expect(middleOnly.kind === 'wall' && middleOnly.trimEndCols).toBe(1)
    expect(middleOnly.kind === 'wall' && middleOnly.exact).toBe(true)
  })

  test('other patterns fall back to a best-effort (inexact) trimmed wall', () => {
    const cornerOut = planWallMask(FULL_MASK & ~1)
    expect(cornerOut.kind === 'wall' && cornerOut.exact).toBe(false)
    expect(cornerOut.kind === 'wall' && cornerOut.trimStartCols).toBe(0)
    const trimmedAndHoled = planWallMask((FULL_MASK & ~col(0)) & ~(1 << 4))
    expect(trimmedAndHoled.kind === 'wall' && trimmedAndHoled.trimStartCols).toBe(1)
    expect(trimmedAndHoled.kind === 'wall' && trimmedAndHoled.exact).toBe(false)
  })
})

describe('trimmedWallSpan: dead columns shorten the node', () => {
  test('yaw 0: trim eats 1 m of span per dead column, from the right end', () => {
    const full = trimmedWallSpan([0, 0, 0], 0, 0, 0)
    expect(full.start[0]).toBeCloseTo(-1.5)
    expect(full.end[0]).toBeCloseTo(1.5)
    const startTrim = trimmedWallSpan([0, 0, 0], 0, 1, 0)
    expect(startTrim.start[0]).toBeCloseTo(-0.5)
    expect(startTrim.end[0]).toBeCloseTo(1.5)
    const endTrim = trimmedWallSpan([0, 0, 0], 0, 0, 2)
    expect(endTrim.start[0]).toBeCloseTo(-1.5)
    expect(endTrim.end[0]).toBeCloseTo(-0.5)
  })

  test('yawed wall trims along its own axis', () => {
    // Yaw π/2 → local +X = world −Z; the wall runs through (2, 3) along Z.
    const span = trimmedWallSpan([2, 0, 3], Math.PI / 2, 1, 0)
    expect(span.start[0]).toBeCloseTo(2)
    expect(span.start[1]).toBeCloseTo(3.5)
    expect(span.end[0]).toBeCloseTo(2)
    expect(span.end[1]).toBeCloseTo(1.5)
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
    overlayRoots: [],
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
