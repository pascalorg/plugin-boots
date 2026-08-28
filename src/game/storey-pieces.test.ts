import { describe, expect, test } from 'bun:test'
import {
  cellCenter,
  cellDims,
  PIECE_DIMS,
  pieceDims,
  piecePose,
  raycastPieceCell,
  WALL_H,
} from './builder'
import { faceLift, TILE_INSET, tileSize } from './edit-overlay'
import { CORNER_RISE, cornerRoofGeometry, raycastRoofCorner } from './roof-corners'

/**
 * ADAPTIVE STOREYS — pieces conform to their slot's LOCAL span
 * (PlacedPiece.height, stamped from grid.storeySpan at placement): wall
 * height, stairs rise/tilt/plank length, roof corner rise, 3×3 cell rows,
 * edit-overlay tiles and the F-edit raycasts all follow it. The legacy
 * span (2.8) is pinned BIT-EXACT to the classic constants so every
 * pre-ladder piece renders and raycasts unchanged.
 */

describe('pieceDims / piecePose under a 2.5 m span', () => {
  test('legacy span returns PIECE_DIMS itself — including the 4.1 plank', () => {
    expect(pieceDims('wall', WALL_H)).toBe(PIECE_DIMS.wall)
    expect(pieceDims('stairs', WALL_H)).toBe(PIECE_DIMS.stairs)
    expect(pieceDims('wall')).toBe(PIECE_DIMS.wall) // default = legacy
    // Floors/roof fallback boxes carry no height — span never matters.
    expect(pieceDims('floor', 2.5)).toBe(PIECE_DIMS.floor)
    expect(pieceDims('roof', 2.5)).toBe(PIECE_DIMS.roof)
  })

  test('walls are span tall; the stairs plank is the exact hypotenuse', () => {
    expect(pieceDims('wall', 2.5)).toEqual([3, 2.5, 0.12])
    const stairs = pieceDims('stairs', 2.5)
    expect(stairs[0]).toBe(3)
    expect(stairs[1]).toBe(0.12)
    expect(stairs[2]).toBeCloseTo(Math.hypot(3, 2.5), 10)
    // Cached tuple — hot paths never allocate per call.
    expect(pieceDims('stairs', 2.5)).toBe(stairs)
  })

  test('poses center on the span; stairs tilt to rise exactly one span', () => {
    const wall = piecePose('wall', 2.5, 2.5)
    expect(wall.y).toBeCloseTo(2.5 + 1.25, 10)
    const stairs = piecePose('stairs', 0, 2.5)
    expect(stairs.y).toBeCloseTo(1.25, 10)
    expect(stairs.tilt).toBeCloseTo(-Math.atan2(2.5, 3), 10)
    // Plank length · sin(tilt) = the span: the ramp tops out flush with
    // the NEXT storey's floor, never 0.3 m proud.
    const rise = pieceDims('stairs', 2.5)[2] * Math.sin(-stairs.tilt)
    expect(rise).toBeCloseTo(2.5, 10)
    // Legacy default: the deliberate ≈−43° tilt is untouched.
    expect(piecePose('stairs', 0).tilt).toBeCloseTo(-Math.atan2(2.8, 3), 10)
  })
})

describe('3×3 cell math under a 2.5 m span', () => {
  test('wall rows are span/3 (≈0.833) tall; slabs split their plane', () => {
    const dims = cellDims('wall', 2.5)
    expect(dims[0]).toBeCloseTo(1, 10)
    expect(dims[1]).toBeCloseTo(2.5 / 3, 10) // 0.8333…
    expect(dims[2]).toBeCloseTo(0.12, 10)
    expect(cellDims('floor', 2.5)).toEqual([1, 0.12, 1])
    expect(cellDims('stairs', 2.5)[2]).toBeCloseTo(Math.hypot(3, 2.5) / 3, 10)
    // Legacy default unchanged.
    expect(cellDims('wall')[1]).toBeCloseTo(2.8 / 3, 10)
  })

  test('cell centers follow the span vertically', () => {
    const bottomLeft = cellCenter('wall', 0, 0, 2.5)
    expect(bottomLeft[0]).toBeCloseTo(-1, 10)
    expect(bottomLeft[1]).toBeCloseTo(-2.5 / 2 + 2.5 / 6, 10)
    expect(cellCenter('wall', 1, 1, 2.5)).toEqual([0, 0, 0])
  })

  test('raycastPieceCell reads the piece height', () => {
    const wall = { piece: 'wall' as const, position: [0, 0, 0] as [number, number, number], yaw: 0, height: 2.5 }
    // y = 2.4 on a 2.5 m wall is the TOP row (2.4/2.5·3 = 2.88 → row 2)…
    const top = raycastPieceCell(wall, 0, 2.4, 5, 0, 0, -1, 10)
    expect(top).not.toBeNull()
    expect(top!.row).toBe(2)
    // …and y = 2.7 sails OVER it (a legacy 2.8 wall would still be hit).
    expect(raycastPieceCell(wall, 0, 2.7, 5, 0, 0, -1, 10)).toBeNull()
    const legacy = { piece: 'wall' as const, position: [0, 0, 0] as [number, number, number], yaw: 0 }
    expect(raycastPieceCell(legacy, 0, 2.7, 5, 0, 0, -1, 10)!.row).toBe(2)
  })
})

describe('roof corner rise follows the span', () => {
  test('cornerRoofGeometry peaks at the given rise (legacy default pinned)', () => {
    const spanPatch = cornerRoofGeometry([0, 0, 1, 1], 2.5)
    expect(spanPatch.boundingBox!.max.y).toBeCloseTo(2.5 + 0.12, 5)
    const legacyPatch = cornerRoofGeometry([0, 0, 1, 1])
    expect(legacyPatch.boundingBox!.max.y).toBeCloseTo(CORNER_RISE + 0.12, 5)
    // Distinct cache rows — a 2.5 patch never aliases the legacy one.
    expect(spanPatch).not.toBe(legacyPatch)
    expect(cornerRoofGeometry([0, 0, 1, 1], 2.5)).toBe(spanPatch)
  })

  test('raycastRoofCorner aims at the risen patch', () => {
    // Flat cap raised 2.5: a horizontal ray at y = 2.57 (top sheet) hits;
    // the legacy-rise raycast at the same height would pass under 2.92.
    const hit = raycastRoofCorner(
      [1, 1, 1, 1],
      { x: 0, y: 0, z: 0, yaw: 0 },
      0,
      5,
      0,
      0,
      -1,
      0,
      10,
      2.5,
    )
    expect(hit).not.toBeNull()
    expect(hit!.t).toBeCloseTo(5 - (2.5 + 0.12), 5)
  })
})

describe('edit-overlay lattice under a 2.5 m span', () => {
  test('wall tiles are span/3 tall after the grout inset', () => {
    const [w, h] = tileSize('wall', 2.5)
    expect(w).toBeCloseTo(1 * (1 - 2 * TILE_INSET), 10)
    expect(h).toBeCloseTo((2.5 / 3) * (1 - 2 * TILE_INSET), 10)
    // Legacy default unchanged; slab lifts don't depend on the span.
    expect(tileSize('wall')[1]).toBeCloseTo((2.8 / 3) * (1 - 2 * TILE_INSET), 10)
    expect(faceLift('floor', 2.5)).toBeCloseTo(faceLift('floor'), 10)
  })
})
