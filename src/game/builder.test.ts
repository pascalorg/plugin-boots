import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { FULL_MASK, type PlacedPiece, useBoots } from '../store'
import {
  builderDebug,
  CELLS,
  cellCenter,
  cellDims,
  HALF_WALL_MASK,
  isOccupied,
  maskBit,
  PIECE_DIMS,
  piecePose,
  planEditExitTransform,
  planWallMask,
  raycastPieceCell,
  resolveSnap,
  rotatedYaw,
  STAIR_DOWN_MASK,
  STAIR_UP_MASK,
  trimmedWallSpan,
  TURBO_FIRST,
  TURBO_NEXT,
  turboStamp,
  TWO_THIRD_WALL_MASK,
  wallExitTransform,
} from './builder'
import { dropTarget, ensureVoxelTarget, resetDestruction, useDestruction } from './destruction'
import { playerRig } from './player'
import { fire } from './shooting'
import type { WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Builder grammar, headless: the pure snap resolver (wall chains + stacks,
 * floor tiling, roof low-edge docking), identical-pose occupancy, the 3×3
 * cell-mask math (cell picking, Keep's mask → node planning with height
 * trims + off-center pockets), the R-rotate quarter-turn math, the turbo
 * hold-to-place cadence, the edit-exit stair-mask → ramp transform (masks
 * 311/95, exact-only, occupancy-guarded, transformPlaced store swap), and
 * the destructibility route for placed pieces (nodeType 'block' → voxelize
 * INSTANTLY at placement, dropTarget on Z-undo).
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

// --- R rotate: manual quarter turns over the auto-facing yaw ----------------

describe('rotatedYaw: quarter-turn offset math', () => {
  test('each press adds 90°, four presses wrap back to the base yaw', () => {
    expect(rotatedYaw(0, 0)).toBeCloseTo(0)
    expect(rotatedYaw(0, 1)).toBeCloseTo(Math.PI / 2)
    expect(Math.abs(rotatedYaw(0, 2))).toBeCloseTo(Math.PI) // π ≡ −π at the wrap seam
    expect(rotatedYaw(0, 3)).toBeCloseTo(-Math.PI / 2) // 3π/2 wraps negative
    expect(rotatedYaw(0, 4)).toBeCloseTo(0)
    expect(rotatedYaw(Math.PI / 2, 1)).toBeCloseTo(-Math.PI) // base + turn wraps too
  })

  test('result stays wrapped in [−π, π) and negative turns wrap the other way', () => {
    for (let turns = -5; turns <= 9; turns++) {
      const yaw = rotatedYaw(Math.PI / 2, turns)
      expect(yaw).toBeGreaterThanOrEqual(-Math.PI - 1e-9)
      expect(yaw).toBeLessThan(Math.PI + 1e-9)
    }
    expect(rotatedYaw(0, -1)).toBeCloseTo(rotatedYaw(0, 3))
    expect(rotatedYaw(0, -3)).toBeCloseTo(rotatedYaw(0, 1))
  })

  test('walls: two presses land on the same box (π symmetry); roofs: all 4 turns are distinct ascents', () => {
    const pieces = [placed('wall', 0, 0, 0, 0), placed('roof', 6, 0, 0, 0)]
    expect(isOccupied(pieces, 'wall', 0, 0, 0, rotatedYaw(0, 2))).toBe(true)
    expect(isOccupied(pieces, 'wall', 0, 0, 0, rotatedYaw(0, 1))).toBe(false)
    // Roof yaw symmetry is 2π: R cycles the 4 ascent orientations, only a
    // full cycle returns to the occupied pose.
    expect(isOccupied(pieces, 'roof', 6, 0, 0, rotatedYaw(0, 0))).toBe(true)
    expect(isOccupied(pieces, 'roof', 6, 0, 0, rotatedYaw(0, 1))).toBe(false)
    expect(isOccupied(pieces, 'roof', 6, 0, 0, rotatedYaw(0, 2))).toBe(false)
    expect(isOccupied(pieces, 'roof', 6, 0, 0, rotatedYaw(0, 3))).toBe(false)
    expect(isOccupied(pieces, 'roof', 6, 0, 0, rotatedYaw(0, 4))).toBe(true)
  })

  test('the rotated yaw steers the snap resolver (chain ↔ corner toggle)', () => {
    const pieces = [placed('wall', 0, 0, 0, 0)]
    const raw = { x: 3.9, y: 0, z: 0.6, yaw: 0 }
    // Auto-facing parallel → chains; one R press turns it perpendicular →
    // the corner stays on the plain grid; a second press is parallel again.
    expect(resolveSnap('wall', pieces, { ...raw, yaw: rotatedYaw(0, 0) }, aimLow)).not.toBeNull()
    expect(resolveSnap('wall', pieces, { ...raw, yaw: rotatedYaw(0, 1) }, aimLow)).toBeNull()
    expect(resolveSnap('wall', pieces, { ...raw, yaw: rotatedYaw(0, 2) }, aimLow)).not.toBeNull()
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
      trimTopRows: 0,
      pocket: 'none',
      pocketCol: 1,
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
      expect(plan.pocketCol).toBe(1)
      expect(plan.exact).toBe(true)
      expect(plan.trimStartCols).toBe(0)
      expect(plan.trimEndCols).toBe(0)
      expect(plan.trimTopRows).toBe(0)
    }
  })

  test('bottom-center pocket reads as a door (center may join it)', () => {
    const short = planWallMask(FULL_MASK & ~(1 << 1))
    const tall = planWallMask(FULL_MASK & ~((1 << 1) | (1 << 4)))
    expect(short.kind === 'wall' && short.pocket).toBe('door')
    expect(short.kind === 'wall' && short.pocketCol).toBe(1)
    expect(tall.kind === 'wall' && tall.pocket).toBe('door')
    expect(tall.kind === 'wall' && tall.pocketCol).toBe(1)
  })

  test('off-center window pockets are exact at any column', () => {
    // Window at col c = the full ring minus exactly the middle-row cell.
    for (const c of [0, 2] as const) {
      const plan = planWallMask(FULL_MASK & ~(1 << (c + 3)))
      expect(plan.kind).toBe('wall')
      if (plan.kind === 'wall') {
        expect(plan.pocket).toBe('window')
        expect(plan.pocketCol).toBe(c)
        expect(plan.exact).toBe(true)
        expect(plan.trimStartCols).toBe(0)
        expect(plan.trimEndCols).toBe(0)
      }
    }
  })

  test('side-door pockets are exact at any column (over-cell may join)', () => {
    for (const c of [0, 2] as const) {
      const short = planWallMask(FULL_MASK & ~(1 << c))
      const tall = planWallMask(FULL_MASK & ~((1 << c) | (1 << (c + 3))))
      expect(short.kind === 'wall' && short.pocket).toBe('door')
      expect(short.kind === 'wall' && short.pocketCol).toBe(c)
      expect(short.kind === 'wall' && short.exact).toBe(true)
      expect(tall.kind === 'wall' && tall.pocket).toBe('door')
      expect(tall.kind === 'wall' && tall.pocketCol).toBe(c)
      expect(tall.kind === 'wall' && tall.exact).toBe(true)
    }
  })

  test('pocket x position maps to (col + 0.5) cell widths in wall-local frame', () => {
    // keep.ts places the pocket node at (pocketCol + 0.5)·cellW from the
    // wall START — col 0 → 0.5 m, col 1 → 1.5 m (the old center), col 2 →
    // 2.5 m, in the untrimmed 3 m frame (pockets never combine with trims).
    const cellW = PIECE_DIMS.wall[0] / CELLS
    expect((0 + 0.5) * cellW).toBeCloseTo(0.5)
    expect((1 + 0.5) * cellW).toBeCloseTo(1.5)
    expect((2 + 0.5) * cellW).toBeCloseTo(2.5)
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

  test('dead TOP rows trim the kept wall height (masks 7 and 63 are exact)', () => {
    const half = planWallMask(0b000000111) // bottom row only
    expect(half.kind).toBe('wall')
    if (half.kind === 'wall') {
      expect(half.trimTopRows).toBe(2)
      expect(half.exact).toBe(true)
      expect(half.trimStartCols).toBe(0)
      expect(half.trimEndCols).toBe(0)
      expect(half.pocket).toBe('none')
      // Keep maps this to height (3 − trimTopRows)·cellH ≈ 0.93 m.
      expect(PIECE_DIMS.wall[1] * ((CELLS - half.trimTopRows) / CELLS)).toBeCloseTo(0.9333, 3)
    }
    const twoThird = planWallMask(0b000111111) // bottom two rows
    expect(twoThird.kind === 'wall' && twoThird.trimTopRows).toBe(1)
    expect(twoThird.kind === 'wall' && twoThird.exact).toBe(true)
    if (twoThird.kind === 'wall') {
      expect(PIECE_DIMS.wall[1] * ((CELLS - twoThird.trimTopRows) / CELLS)).toBeCloseTo(1.8667, 3)
    }
    // Precedence: mask 7 is a height-trim, NOT an inexact span walk.
    expect(half.kind === 'wall' && half.exact).toBe(true)
  })

  test('dead BOTTOM rows under live ones stay a full-height best effort (no floating walls)', () => {
    const floating = planWallMask(0b111111000) // top two rows alive, bottom dead
    expect(floating.kind).toBe('wall')
    if (floating.kind === 'wall') {
      expect(floating.trimTopRows).toBe(0)
      expect(floating.exact).toBe(false)
      expect(floating.trimStartCols).toBe(0)
      expect(floating.trimEndCols).toBe(0)
    }
  })

  test('other patterns fall back to a best-effort (inexact) trimmed wall', () => {
    // A dead TOP corner: not a pocket, not a height trim (row 2 is only
    // partly dead), no dead end column → full-span inexact wall.
    const cornerOut = planWallMask(FULL_MASK & ~(1 << 6))
    expect(cornerOut.kind === 'wall' && cornerOut.exact).toBe(false)
    expect(cornerOut.kind === 'wall' && cornerOut.trimStartCols).toBe(0)
    expect(cornerOut.kind === 'wall' && cornerOut.trimTopRows).toBe(0)
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

// --- Turbo hold-to-place cadence ---------------------------------------------

describe('turboStamp: hold-to-place cadence', () => {
  test('genre-canon values: 0.15 first, 0.05 per held pose change', () => {
    expect(TURBO_FIRST).toBeCloseTo(0.15)
    expect(TURBO_NEXT).toBeCloseTo(0.05)
    expect(TURBO_FIRST).toBeGreaterThan(TURBO_NEXT)
  })

  test('fresh press stamps and arms the long lockout; held re-stamps run fast', () => {
    expect(turboStamp(0, true, false, false)).toBe(TURBO_FIRST)
    expect(turboStamp(0, true, true, false)).toBe(TURBO_FIRST) // press wins the label
    expect(turboStamp(0, false, true, false)).toBe(TURBO_NEXT)
  })

  test('no stamp while cooling, while the pose holds, or over an occupied pose', () => {
    expect(turboStamp(0.01, true, true, false)).toBeNull() // cooldown gate first
    expect(turboStamp(0, false, false, false)).toBeNull() // held, pose unchanged
    expect(turboStamp(0, true, false, true)).toBeNull() // occupied is silent
    expect(turboStamp(0, false, true, true)).toBeNull()
  })

  test('a held sweep: press stamps at t=0, next pose change waits 0.15, then 0.05 cadence', () => {
    // Simulate the frame loop's cooldown countdown against a sweeping
    // crosshair (every frame a new pose), in integer 10 ms frames so the
    // timeline is exact. turboStamp's gate is unit-agnostic (> 0).
    const stamps: number[] = []
    let cooldown = 0 // in frames
    for (let frame = 0; frame <= 30; frame++) {
      const arm = turboStamp(cooldown, frame === 0, true, false)
      if (arm !== null) {
        stamps.push(frame)
        cooldown = Math.round(arm * 100) // seconds → 10 ms frames
      }
      cooldown -= 1
    }
    // Press stamp at 0 → 0.15 s lockout → stamp at frame 15, then every 5.
    expect(stamps).toEqual([0, 15, 20, 25, 30])
  })
})

// --- Edit-exit transforms: exact stair masks fold a wall into a ramp --------

describe('wall mask constants', () => {
  test('half/two-third/stair silhouettes have the documented values', () => {
    expect(HALF_WALL_MASK).toBe(7)
    expect(TWO_THIRD_WALL_MASK).toBe(63)
    expect(STAIR_UP_MASK).toBe(311)
    expect(STAIR_DOWN_MASK).toBe(95)
    // Silhouette check: column heights 1·2·3 (up) and 3·2·1 (down).
    const colHeight = (mask: number, c: number) =>
      [0, 1, 2].filter((r) => mask & (1 << maskBit(c, r))).length
    expect([0, 1, 2].map((c) => colHeight(STAIR_UP_MASK, c))).toEqual([1, 2, 3])
    expect([0, 1, 2].map((c) => colHeight(STAIR_DOWN_MASK, c))).toEqual([3, 2, 1])
  })
})

describe('wallExitTransform: exact-only stair classification', () => {
  test('311 rises toward local +X → roof yaw = wall yaw + 90°', () => {
    for (const wallYaw of [0, Math.PI / 2, -Math.PI / 2]) {
      const t = wallExitTransform(STAIR_UP_MASK, wallYaw)
      expect(t).not.toBeNull()
      expect(t!.piece).toBe('roof')
      expect(t!.yaw).toBeCloseTo(rotatedYaw(wallYaw, 1))
    }
  })

  test('95 rises toward local −X → roof yaw = wall yaw − 90°', () => {
    for (const wallYaw of [0, Math.PI / 2, -Math.PI / 2]) {
      const t = wallExitTransform(STAIR_DOWN_MASK, wallYaw)
      expect(t).not.toBeNull()
      expect(t!.piece).toBe('roof')
      expect(t!.yaw).toBeCloseTo(rotatedYaw(wallYaw, -1))
    }
  })

  test('near-misses and every other pattern stay a carve (null)', () => {
    expect(wallExitTransform(FULL_MASK, 0)).toBeNull()
    expect(wallExitTransform(0, 0)).toBeNull()
    expect(wallExitTransform(HALF_WALL_MASK, 0)).toBeNull()
    expect(wallExitTransform(TWO_THIRD_WALL_MASK, 0)).toBeNull()
    expect(wallExitTransform(STAIR_UP_MASK | (1 << 3), 0)).toBeNull() // one extra cell
    expect(wallExitTransform(STAIR_UP_MASK & ~1, 0)).toBeNull() // one missing cell
    expect(wallExitTransform(STAIR_DOWN_MASK | (1 << 5), 0)).toBeNull()
  })
})

describe('planEditExitTransform: occupancy guard + piece gating', () => {
  test('a stair-masked wall plans a ramp at its own position', () => {
    const wall = placed('wall', 3, 0, 0, Math.PI / 2, STAIR_UP_MASK)
    const plan = planEditExitTransform(wall, [wall])
    expect(plan).not.toBeNull()
    expect(plan!.piece).toBe('roof')
    expect(plan!.yaw).toBeCloseTo(rotatedYaw(Math.PI / 2, 1))
  })

  test('refused when an identical roof pose already exists among OTHERS', () => {
    const wall = placed('wall', 0, 0, 0, 0, STAIR_UP_MASK)
    const targetYaw = rotatedYaw(0, 1)
    const blocking = placed('roof', 0, 0, 0, targetYaw)
    expect(planEditExitTransform(wall, [wall, blocking])).toBeNull()
    // A roof in a DIFFERENT ascent (2π symmetry) does not block.
    const otherFacing = placed('roof', 0, 0, 0, rotatedYaw(0, 3))
    expect(planEditExitTransform(wall, [wall, otherFacing])).not.toBeNull()
    // The wall itself never blocks its own transform.
    expect(planEditExitTransform(wall, [wall])).not.toBeNull()
  })

  test('only walls transform; carved non-stair masks never do', () => {
    const roof = placed('roof', 0, 0, 0, 0, STAIR_UP_MASK)
    expect(planEditExitTransform(roof, [roof])).toBeNull()
    const floor = placed('floor', 0, 0, 0, 0, STAIR_DOWN_MASK)
    expect(planEditExitTransform(floor, [floor])).toBeNull()
    const carved = placed('wall', 0, 0, 0, 0, FULL_MASK & ~(1 << 4))
    expect(planEditExitTransform(carved, [carved])).toBeNull()
  })
})

describe('transformPlaced: in-place piece rebuild (store action)', () => {
  test('swaps piece type + yaw, resets mask to FULL, preserves id/position/order', () => {
    const store = useBoots.getState()
    store.addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    store.addPlaced({ piece: 'wall', position: [3, 0, 0], yaw: 0, mask: STAIR_UP_MASK })
    store.addPlaced({ piece: 'floor', position: [6, 0, 0], yaw: 0 })
    const before = useBoots.getState().placed
    const target = before[1]!
    useBoots.getState().transformPlaced(target.id, 'roof', Math.PI / 2)
    const after = useBoots.getState().placed
    expect(after.length).toBe(before.length)
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id)) // order + ids kept
    const swapped = after[1]!
    expect(swapped.id).toBe(target.id)
    expect(swapped.piece).toBe('roof')
    expect(swapped.yaw).toBeCloseTo(Math.PI / 2)
    expect(swapped.mask).toBe(FULL_MASK)
    expect(swapped.position).toEqual([3, 0, 0])
    // Neighbors untouched (same objects — no gratuitous swaps).
    expect(after[0]).toBe(before[0]!)
    expect(after[2]).toBe(before[2]!)
    useBoots.getState().resolvePlaced()
  })
})

// --- builderDebug.isEditing: the Q-cycle gate viewmodel feature-detects -----

describe('builderDebug.isEditing', () => {
  test('publishes a plain boolean flag, false by default', () => {
    // viewmodel.tsx feature-detects `isEditing` as a plain flag (or getter):
    // absent = never editing. The builder must publish the plain-flag shape.
    expect(typeof builderDebug.isEditing).toBe('boolean')
    expect(builderDebug.isEditing).toBe(false)
    // The exact read viewmodel performs:
    const editFlag = (builderDebug as { isEditing?: boolean | (() => boolean) }).isEditing
    const editing = typeof editFlag === 'function' ? editFlag() : editFlag === true
    expect(editing).toBe(false)
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

    // Z-undo path: PlacedPieceMesh cleanup calls dropTarget(nodeId).
    dropTarget('__boots-piece-1')
    expect(useDestruction.getState().targets.has('__boots-piece-1')).toBe(false)
  })
})

// --- Instant bricks: placements voxelize the moment they land ---------------

describe('instant voxelize at placement (PlacedPieceMesh wiring, mock level)', () => {
  test('ensureVoxelTarget clads the fresh piece and disables its collider — no double-solid', () => {
    const world = worldWithPlacedWall()
    const entry = world.colliders[0]!

    // What the layout effect does right after pushing the collider entry.
    const target = ensureVoxelTarget(world, entry.nodeId)
    expect(target).not.toBeNull()
    expect(target!.kind).toBe('volume') // placed pieces are plain adaptive volumes
    expect(target!.grid.count).toBeGreaterThan(0)
    expect(useDestruction.getState().targets.has('__boots-piece-1')).toBe(true)
    // The mesh collider hands over to the voxel replica in the same call.
    expect(entry.disabled).toBe(true)
    // Idempotent: mask edits re-run the effect against a fresh entry, but a
    // repeat call for a live target must return the SAME target untouched.
    expect(ensureVoxelTarget(world, entry.nodeId)).toBe(target!)

    // Shots carve the pre-clad replica directly — no first-hit flip left.
    playerRig.position.set(0, 1.4, 5)
    playerRig.yaw = 0
    playerRig.pitch = 0
    playerRig.speed = 0
    playerRig.grounded = true
    expect(fire(world, GUN)).toBe('wall')

    // Z-undo / unmount cleanup still drops the replica cleanly.
    dropTarget(entry.nodeId)
    expect(useDestruction.getState().targets.has(entry.nodeId)).toBe(false)
  })
})
