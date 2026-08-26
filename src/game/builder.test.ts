import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { FULL_MASK, type PlacedPiece, useBoots } from '../store'
import {
  builderDebug,
  cancelPieceClad,
  CELLS,
  cellCenter,
  cellDims,
  CLAD_BURST_MS,
  cladQueueSize,
  drainCladQueue,
  HALF_WALL_MASK,
  isOccupied,
  maskBit,
  PIECE_DIMS,
  piecePose,
  planEditExitTransform,
  planWallMask,
  raycastPieceCell,
  requestPieceClad,
  resetCladQueue,
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
import {
  damageTarget,
  dropTarget,
  ensureVoxelTarget,
  resetDestruction,
  useDestruction,
} from './destruction'
import { resolveTargetSlot, STOREY, type TargetInput, parseSlotId } from './grid'
import {
  DIED_SLOT_LOCKOUT_MS,
  diedAt,
  flushCollapse,
  isDeathLocked,
  isOccupied as slotIsOccupied,
  isSupported as slotIsSupported,
  onCollapse,
  onPieceRemoved,
  registerPlacement,
  resetPieceSlots,
  setSceneSupportProbe,
} from './piece-slots'
import { playerRig } from './player'
import { fire } from './shooting'
import type { WeaponDef } from './weapons'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Builder grammar v2, headless: the SLOT-LOCKED ghost (grid.resolveTargetSlot
 * wired to piece-slots occupancy/support — the pose can never leave the
 * discrete slot set), the two flows (ceiling = floor one storey up, ramps
 * chain a storey per cell), R semantics (wall far-edge flip / floor no-op /
 * roof ascent cycle), the slot-keyed turbo cadence (press → 0.15 s, new
 * slots ≥ 0.05 s, per-hold dedupe, died-slot lockout), identical-pose
 * occupancy (edit transforms), the 3×3 cell-mask math (cell picking, Keep's
 * mask → node planning with height trims + off-center pockets), the
 * edit-exit stair-mask → ramp transform (masks 311/95, exact-only,
 * occupancy-guarded, transformPlaced store swap), and the destructibility
 * route for placed pieces (nodeType 'block' → voxelize INSTANTLY at
 * placement for singles, via the budgeted clad FIFO for turbo bursts;
 * dropTarget on Z-undo).
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

// --- Slot-locked ghost: grid targeting × piece-slots authority ---------------

/** Open world: nothing occupied, everything supported (pure grid checks). */
const OPEN = { isOccupied: () => false, isSupported: () => true }
/** The live wiring builder.tsx uses: piece-slots answers both questions. */
const REGISTRY = { isOccupied: slotIsOccupied, isSupported: slotIsSupported }

function rig(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  piece: TargetInput['piece'],
  rotState = 0,
): TargetInput {
  return { position: [x, y, z], yaw, pitch, piece, rotState }
}

const onLattice = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-9

describe('slot-locked ghost: the pose can never leave the discrete slot set', () => {
  afterEach(() => {
    resetPieceSlots()
  })

  test('any rig input resolves to a lattice pose (the ghost never floats)', () => {
    const pieces: TargetInput['piece'][] = ['wall', 'floor', 'roof']
    const positions: [number, number, number][] = [
      [1.5, 0, 1.5],
      [2.9, 0, 0.13],
      [-4.7, 2.8, 7.2],
      [0.01, 5.61, -0.01],
    ]
    for (const piece of pieces) {
      for (const [x, y, z] of positions) {
        for (const yaw of [0, 0.4, -Math.PI / 2, 2.5]) {
          for (const pitch of [0, 0.8, -0.9]) {
            for (const rotState of [0, 1, 2]) {
              const t = resolveTargetSlot(rig(x, y, z, yaw, pitch, piece, rotState), OPEN)
              expect(parseSlotId(t.slotId)).not.toBeNull()
              // Slot centers sit on the half-cell lattice; bases on storeys;
              // yaw on quarter turns — nothing in between, ever.
              expect(onLattice(t.pose.position[0], 1.5)).toBe(true)
              expect(onLattice(t.pose.position[1], STOREY)).toBe(true)
              expect(onLattice(t.pose.position[2], 1.5)).toBe(true)
              expect(onLattice(t.pose.yaw, Math.PI / 2)).toBe(true)
            }
          }
        }
      }
    }
  })

  test('a registered slot reads occupied → red ghost with the reason', () => {
    const input = rig(1.5, 0, 1.5, -Math.PI / 2, 0, 'wall')
    const free = resolveTargetSlot(input, REGISTRY)
    expect(free.slotId).toBe('Wx:1,0,0')
    expect(free.valid).toBe(true)
    expect(registerPlacement(free.slotId, 1)).toBe(true)
    const blocked = resolveTargetSlot(input, REGISTRY)
    expect(blocked.valid).toBe(false)
    expect(blocked.reason).toBe('occupied')
    // Double-registration of the same slot by ANOTHER piece is refused.
    expect(registerPlacement(free.slotId, 2)).toBe(false)
  })

  test('ceiling flow: floor piece past the +35° band caps your own cell', () => {
    // Feet mid cell (0,0), looking steeply up: the target is the top face
    // of the player's own cell — a ceiling, one storey up.
    const input = rig(1.5, 0, 1.5, 0, 0.9, 'floor')
    const alone = resolveTargetSlot(input, REGISTRY)
    expect(alone.slotId).toBe('F:0,0,1')
    expect(alone.pose.position).toEqual([1.5, STOREY, 1.5])
    // Unsupported in an empty world → red (a ceiling needs a wall).
    expect(alone.valid).toBe(false)
    expect(alone.reason).toBe('unsupported')
    // A grounded wall bounding the cell props it → blue.
    registerPlacement('Wx:0,0,0', 11)
    const propped = resolveTargetSlot(input, REGISTRY)
    expect(propped.slotId).toBe('F:0,0,1')
    expect(propped.valid).toBe(true)
  })

  test('ramp chain: every cell you climb targets the next ramp a storey up', () => {
    // On the ground, facing +X: the first ramp fills the neighbor cell,
    // ascending away from the player (quarter 1 → pose yaw π/2).
    const first = resolveTargetSlot(rig(1.5, 0, 1.5, -Math.PI / 2, 0, 'roof'), OPEN)
    expect(first.slotId).toBe('R:1,0,0')
    expect(first.pose.yaw).toBeCloseTo(Math.PI / 2)
    // Standing at the top of that ramp (feet one storey up, inside its
    // cell), still facing +X: the NEXT cell, one storey higher.
    const second = resolveTargetSlot(rig(4.5, STOREY, 1.5, -Math.PI / 2, 0, 'roof'), OPEN)
    expect(second.slotId).toBe('R:2,0,1')
    expect(second.pose.position[1]).toBeCloseTo(STOREY)
    expect(second.pose.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('R semantics: wall far-edge flip parity, floor no-op, roof quarter', () => {
    // Wall: rotState 1 flips to the far edge of the target cell.
    expect(resolveTargetSlot(rig(1.5, 0, 1.5, -Math.PI / 2, 0, 'wall', 1), OPEN).slotId).toBe(
      'Wx:2,0,0',
    )
    expect(resolveTargetSlot(rig(1.5, 0, 1.5, -Math.PI / 2, 0, 'wall', 2), OPEN).slotId).toBe(
      'Wx:1,0,0',
    )
    // Floor: rotState is ignored entirely.
    const f0 = resolveTargetSlot(rig(1.5, 0, 1.5, 0, 0, 'floor', 0), OPEN)
    const f3 = resolveTargetSlot(rig(1.5, 0, 1.5, 0, 0, 'floor', 3), OPEN)
    expect(f3.slotId).toBe(f0.slotId)
    expect(f3.pose.yaw).toBe(f0.pose.yaw)
    // Roof: each rotState adds a quarter to the ascent.
    const r1 = resolveTargetSlot(rig(1.5, 0, 1.5, -Math.PI / 2, 0, 'roof', 1), OPEN)
    expect(r1.slotId).toBe('R:1,0,0')
    expect(r1.pose.yaw).toBeCloseTo(Math.PI) // quarter 2: descent back at you
  })

  test('support flows through the registry: a floor a storey up needs a wall', () => {
    expect(slotIsSupported('F:0,0,1')).toBe(false)
    registerPlacement('Wx:0,0,0', 21) // grounded (storey 0)
    expect(slotIsSupported('F:0,0,1')).toBe(true) // rests on the wall below
    expect(slotIsSupported('F:5,5,1')).toBe(false) // far away, still floating
  })

  test('died-slot lockout: onPieceRemoved stamps the slot for 0.15 s', () => {
    registerPlacement('Wz:0,0,0', 31)
    onPieceRemoved('Wz:0,0,0')
    expect(slotIsOccupied('Wz:0,0,0')).toBe(false)
    const died = diedAt('Wz:0,0,0')
    expect(died).toBeGreaterThan(0)
    expect(isDeathLocked('Wz:0,0,0', died + DIED_SLOT_LOCKOUT_MS - 1)).toBe(true)
    expect(isDeathLocked('Wz:0,0,0', died + DIED_SLOT_LOCKOUT_MS + 1)).toBe(false)
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

  test('elevated floors: same square matches, far side and ground stay free', () => {
    const pieces = [placed('wall', 0, 0, 0, 0), placed('floor', 0, 2.8, 1.5, 0)]
    expect(isOccupied(pieces, 'floor', 0, 2.8, 1.5, Math.PI / 2)).toBe(true) // same square
    expect(isOccupied(pieces, 'floor', 0, 2.8, -1.5, 0)).toBe(false) // far side still free
    expect(isOccupied(pieces, 'floor', 0, 0, 1.5, 0)).toBe(false) // ground level still free
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

describe('turboStamp: slot-keyed hold-to-place cadence', () => {
  test('genre-canon values: 0.15 first, ≥0.05 per new slot', () => {
    expect(TURBO_FIRST).toBeCloseTo(0.15)
    expect(TURBO_NEXT).toBeCloseTo(0.05)
    expect(TURBO_FIRST).toBeGreaterThan(TURBO_NEXT)
  })

  test('fresh press stamps and arms the long lockout; held new slots run fast', () => {
    expect(turboStamp(0, true, true, false, false)).toBe(TURBO_FIRST)
    expect(turboStamp(0, false, true, false, false)).toBe(TURBO_NEXT)
  })

  test('no stamp while cooling, on a repeat slot, a dead slot, or a red ghost', () => {
    expect(turboStamp(0.01, true, true, false, false)).toBeNull() // cooldown gate first
    expect(turboStamp(0, false, true, true, false)).toBeNull() // one attempt per slot per hold
    expect(turboStamp(0, false, true, false, true)).toBeNull() // died-slot lockout
    expect(turboStamp(0, true, false, false, false)).toBeNull() // invalid is silent
    expect(turboStamp(0, false, false, false, false)).toBeNull()
  })

  test('hovering one slot stamps once per hold — even after the cooldown', () => {
    const attempted = new Set<string>()
    const slot = 'Wz:1,0,0'
    expect(turboStamp(0, true, true, attempted.has(slot), false)).toBe(TURBO_FIRST)
    attempted.add(slot)
    // Cooldown long expired, still the same slot: the dedupe holds.
    expect(turboStamp(-5, false, true, attempted.has(slot), false)).toBeNull()
  })

  test('a held sweep: press stamps at t=0, the first NEW slot waits 0.15, then 0.05 cadence', () => {
    // Simulate the frame loop's cooldown countdown against a strafing
    // crosshair (every frame the ray enters a new slot), in integer 10 ms
    // frames so the timeline is exact. turboStamp's gate is unit-agnostic
    // (> 0); the dedupe Set mirrors builder.tsx's holdAttempted.
    const stamps: number[] = []
    const attempted = new Set<string>()
    let cooldown = 0 // in frames
    for (let frame = 0; frame <= 30; frame++) {
      const slot = `Wz:${frame},0,0` // sweeping: a fresh slot every frame
      const arm = turboStamp(cooldown, frame === 0, true, attempted.has(slot), false)
      if (arm !== null) {
        stamps.push(frame)
        attempted.add(slot)
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

// --- Destruction ↔ slot registry seams (manager wiring, phase 5) ------------
// Destruction is the THIRD door a piece leaves through (undo Z and the
// support cascade are the others): a replica carved to zero voxels must run
// the exact undo cleanup, and scene carves must re-check scene-propped
// pieces (destruction.settleSupportAfterRemoval → piece-slots).

/** One box collider registered the way PlacedPieceMesh / scene walls do it. */
function worldWithBoxCollider(nodeId: string): GameWorld {
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
    nodeId,
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

describe('destruction ↔ slot registry (the third door pieces leave through)', () => {
  afterEach(() => {
    resetDestruction()
    resetPieceSlots()
    useBoots.setState({ placed: [] })
  })

  test('a piece carved to zero voxels runs the undo cleanup and cascades', () => {
    const store = useBoots.getState()
    const base = store.addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0, slotId: 'Wz:0,0,0' })
    const upper = store.addPlaced({
      piece: 'wall',
      position: [0, STOREY, 0],
      yaw: 0,
      slotId: 'Wz:0,0,1',
    })
    registerPlacement('Wz:0,0,0', base.id)
    registerPlacement('Wz:0,0,1', upper.id)
    // The PlacedPieces collapse listener, headless: store removal per ring.
    const off = onCollapse((pieceId) => {
      useBoots.getState().removePlaced(pieceId)
    })

    const nodeId = `__boots-piece-${base.id}`
    const world = worldWithBoxCollider(nodeId)
    expect(ensureVoxelTarget(world, nodeId)).not.toBeNull()
    // Blast-sized carve: every voxel of the replica dies in one call…
    damageTarget(world, nodeId, new Vector3(0, piecePose('wall', 0).y, 0), 10)

    // …so the piece leaves the store + registry and stamps the lockout,
    expect(useBoots.getState().placed.find((p) => p.id === base.id)).toBeUndefined()
    expect(slotIsOccupied('Wz:0,0,0')).toBe(false)
    expect(diedAt('Wz:0,0,0')).toBeGreaterThan(0)
    // and the orphaned piece above falls through the SAME path.
    flushCollapse()
    expect(slotIsOccupied('Wz:0,0,1')).toBe(false)
    expect(diedAt('Wz:0,0,1')).toBeGreaterThan(0)
    expect(useBoots.getState().placed.length).toBe(0)
    off()
  })

  test('scene carves re-check scene-propped pieces (debounced notify)', async () => {
    let alive = true
    setSceneSupportProbe((slotId) => slotId === 'F:2,2,1' && alive)
    const propped = useBoots
      .getState()
      .addPlaced({ piece: 'floor', position: [6, STOREY, 6], yaw: 0, slotId: 'F:2,2,1' })
    registerPlacement('F:2,2,1', propped.id)
    expect(slotIsSupported('F:2,2,1')).toBe(true) // probe answer now cached
    const off = onCollapse((pieceId) => {
      useBoots.getState().removePlaced(pieceId)
    })

    // The scene geometry propping it gets demolished.
    alive = false
    const world = worldWithBoxCollider('scene-block-1')
    expect(ensureVoxelTarget(world, 'scene-block-1')).not.toBeNull()
    damageTarget(world, 'scene-block-1', new Vector3(0, piecePose('wall', 0).y, 0), 0.4)

    // The cached answer stands until the debounced sweep lands…
    expect(slotIsOccupied('F:2,2,1')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 220))
    flushCollapse()
    // …then the orphan cascades out of the registry AND the store.
    expect(slotIsOccupied('F:2,2,1')).toBe(false)
    expect(useBoots.getState().placed.length).toBe(0)
    off()
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

// --- Deferred clad: the turbo voxelize budget (REVIEW perf risk) -------------
// requestPieceClad is what PlacedPieceMesh's layout effect calls now: lone
// placements keep the instant-bricks path, turbo-cadence bursts defer to a
// FIFO drained a few per frame — the piece stays the plain solid mesh
// fallback (visible + collidable) until its turn.

/** A world with `n` placed-wall colliders (nodeIds __boots-piece-1..n),
 * registered the way PlacedPieceMesh does it, spaced one cell apart. */
function worldWithPlacedWalls(n: number): GameWorld {
  const colliders: ColliderEntry[] = []
  const aabb = new Box3()
  for (let i = 0; i < n; i++) {
    const pose = piecePose('wall', 0)
    const mesh = new Mesh(new BoxGeometry(...PIECE_DIMS.wall))
    mesh.position.set(i * 3, pose.y, 0)
    mesh.updateMatrixWorld(true)
    mesh.geometry.computeBoundingBox()
    const entry: ColliderEntry = {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId: `__boots-piece-${i + 1}`,
      nodeType: 'block',
    }
    colliders.push(entry)
    aabb.union(entry.worldBox)
  }
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: aabb,
    spawn: new Vector3(0, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('deferred clad: turbo bursts queue, singles stay instant', () => {
  afterEach(() => {
    resetCladQueue()
    resetDestruction()
  })

  const targets = () => useDestruction.getState().targets

  test('the burst threshold sits BETWEEN the turbo cadences', () => {
    // TURBO_FIRST placements (single clicks, ≥150 ms apart) must voxelize
    // instantly; TURBO_NEXT sweep stamps (50 ms apart) must defer.
    expect(CLAD_BURST_MS).toBeLessThan(TURBO_FIRST * 1000)
    expect(CLAD_BURST_MS).toBeGreaterThan(TURBO_NEXT * 1000)
  })

  test('a lone placement voxelizes instantly — the instant-bricks feel is untouched', () => {
    const world = worldWithPlacedWalls(1)
    requestPieceClad(world, '__boots-piece-1', 0)
    expect(targets().has('__boots-piece-1')).toBe(true)
    expect(world.colliders[0]!.disabled).toBe(true) // voxels own collision now
    expect(cladQueueSize()).toBe(0)
  })

  test('a turbo sweep defers: plain mesh + live collider until the FIFO drains', () => {
    const world = worldWithPlacedWalls(4)
    // Press stamp, then TURBO_NEXT-cadence stamps 50 ms apart.
    requestPieceClad(world, '__boots-piece-1', 0)
    requestPieceClad(world, '__boots-piece-2', 50)
    requestPieceClad(world, '__boots-piece-3', 100)
    requestPieceClad(world, '__boots-piece-4', 150)
    expect(targets().has('__boots-piece-1')).toBe(true) // the press was a single
    // The burst pieces are NOT voxelized yet — the plain solid mesh path
    // (same as a degenerate grid's fallback) keeps them visible + solid.
    expect(targets().has('__boots-piece-2')).toBe(false)
    expect(world.colliders[1]!.disabled).toBeFalsy()
    expect(cladQueueSize()).toBe(3)
    // One frame's drain clads the budget's worth, in placement order…
    drainCladQueue(2)
    expect(targets().has('__boots-piece-2')).toBe(true)
    expect(targets().has('__boots-piece-3')).toBe(true)
    expect(targets().has('__boots-piece-4')).toBe(false)
    expect(world.colliders[1]!.disabled).toBe(true)
    expect(cladQueueSize()).toBe(1)
    // …the next frame finishes the backlog.
    drainCladQueue(2)
    expect(targets().has('__boots-piece-4')).toBe(true)
    expect(cladQueueSize()).toBe(0)
  })

  test('a slow request behind a backlog joins the FIFO (order beats freshness)', () => {
    const world = worldWithPlacedWalls(3)
    requestPieceClad(world, '__boots-piece-1', 0)
    requestPieceClad(world, '__boots-piece-2', 50) // burst → queued
    requestPieceClad(world, '__boots-piece-3', 1000) // slow gap, but a backlog exists
    expect(targets().has('__boots-piece-3')).toBe(false)
    expect(cladQueueSize()).toBe(2)
    drainCladQueue(1)
    expect(targets().has('__boots-piece-2')).toBe(true) // oldest first
    expect(targets().has('__boots-piece-3')).toBe(false)
    drainCladQueue(1)
    expect(targets().has('__boots-piece-3')).toBe(true)
  })

  test('cancel (unmount before its turn) never clads a dead entry nor eats the budget', () => {
    const world = worldWithPlacedWalls(3)
    requestPieceClad(world, '__boots-piece-1', 0)
    requestPieceClad(world, '__boots-piece-2', 50)
    requestPieceClad(world, '__boots-piece-3', 100)
    cancelPieceClad('__boots-piece-2') // Z-undo mid-burst
    expect(cladQueueSize()).toBe(1)
    drainCladQueue(1) // the cancelled row is skipped for free
    expect(targets().has('__boots-piece-2')).toBe(false)
    expect(targets().has('__boots-piece-3')).toBe(true)
    expect(cladQueueSize()).toBe(0)
  })

  test('dedupe per nodeId; a piece clad through another door no-ops on drain', () => {
    const world = worldWithPlacedWalls(2)
    requestPieceClad(world, '__boots-piece-1', 0)
    requestPieceClad(world, '__boots-piece-2', 50)
    requestPieceClad(world, '__boots-piece-2', 100) // mask-edit re-request while queued
    expect(cladQueueSize()).toBe(1)
    // A bullet hits the still-plain piece first: damageTarget's own
    // ensureVoxelTarget clads it ahead of the queue.
    const early = ensureVoxelTarget(world, '__boots-piece-2')
    expect(early).not.toBeNull()
    drainCladQueue()
    expect(targets().get('__boots-piece-2')).toBe(early!) // same target, untouched
    expect(cladQueueSize()).toBe(0)
  })

  test('after the backlog drains and the burst cools, singles are instant again', () => {
    const world = worldWithPlacedWalls(3)
    requestPieceClad(world, '__boots-piece-1', 0)
    requestPieceClad(world, '__boots-piece-2', 50)
    drainCladQueue()
    requestPieceClad(world, '__boots-piece-3', 300) // 250 ms later, queue empty
    expect(targets().has('__boots-piece-3')).toBe(true)
    expect(cladQueueSize()).toBe(0)
  })
})
