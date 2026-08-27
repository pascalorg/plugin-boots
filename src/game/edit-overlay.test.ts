import { describe, expect, test } from 'bun:test'
import type { BuildPiece } from '../store'
import { CELLS, cellDims } from './builder'
import {
  boxEdgeSegments,
  FACE_LIFT,
  faceLift,
  hoverRectSegments,
  rectSegments,
  TILE_INSET,
  tileSize,
} from './edit-overlay'

/**
 * Edit-overlay lattice math, headless: tile inset (the grout gap), face
 * lift, and the LineSegments vertex layouts the outline geometries are
 * built from. The components themselves are exercised live (F-edit QA).
 */

const PIECES: BuildPiece[] = ['wall', 'floor', 'stairs', 'roof']

describe('tile inset math', () => {
  test('tiles span the cell minus one grout inset per side, every piece', () => {
    for (const piece of PIECES) {
      const [w, h, d] = cellDims(piece)
      const [tw, th] = tileSize(piece)
      const [cw, ch] = piece === 'wall' ? [w, h] : [w, d]
      expect(tw).toBeCloseTo(cw * (1 - 2 * TILE_INSET))
      expect(th).toBeCloseTo(ch * (1 - 2 * TILE_INSET))
      // Adjacent tiles never touch: the gap between them is two insets.
      expect(cw - tw).toBeCloseTo(2 * TILE_INSET * cw)
    }
  })

  test('wall tiles split the wall plane, slabs their plane', () => {
    // Wall: 3 m wide × 2.8 m tall → 1 × 0.9333 cells before the inset.
    const [ww, wh] = tileSize('wall')
    expect(ww).toBeCloseTo((3 / CELLS) * 0.88)
    expect(wh).toBeCloseTo((2.8 / CELLS) * 0.88)
    // Floor: 3 × 3 slab → square tiles.
    const [fw, fh] = tileSize('floor')
    expect(fw).toBeCloseTo(fh)
  })

  test('faceLift floats one lift off the piece half-thickness', () => {
    for (const piece of PIECES) {
      const dims = cellDims(piece)
      const half = (piece === 'wall' ? dims[2] : dims[1]) / 2
      expect(faceLift(piece)).toBeCloseTo(half + FACE_LIFT)
    }
    // Wall thickness 0.12 → the lattice floats 2 cm off each face.
    expect(faceLift('wall')).toBeCloseTo(0.06 + FACE_LIFT)
  })
})

describe('lattice segment layouts', () => {
  test('tile outline is 4 segments; the full 3×3 lattice reads 36', () => {
    const points = rectSegments(2, 1)
    expect(points.length).toBe(4 * 2 * 3)
    // Every vertex sits on the rect border (|x| = w/2 or |y| = h/2), z = 0.
    for (let i = 0; i < points.length; i += 3) {
      const onEdge = Math.abs(points[i]!) === 1 || Math.abs(points[i + 1]!) === 0.5
      expect(onEdge).toBe(true)
      expect(points[i + 2]!).toBe(0)
    }
    // Nine tiles per face → 36 segments per 3×3 lattice face.
    expect((CELLS * CELLS * points.length) / 6).toBe(36)
  })

  test('hover outline doubles the rect: 8 segments, inner strictly inside', () => {
    const points = hoverRectSegments(2, 1)
    expect(points.length).toBe(8 * 2 * 3)
    const outerMax = Math.max(...Array.from(points.slice(0, 24)).filter((_, i) => i % 3 === 0))
    const innerMax = Math.max(...Array.from(points.slice(24)).filter((_, i) => i % 3 === 0))
    expect(outerMax).toBe(1)
    expect(innerMax).toBeLessThan(outerMax)
    expect(innerMax).toBeGreaterThan(0)
  })

  test('corner-marker wireframe is the 12 cube edges', () => {
    const points = boxEdgeSegments(0.5)
    expect(points.length).toBe(12 * 2 * 3)
    // Every vertex is a cube corner: all coordinates at ±size/2.
    for (const value of points) {
      expect(Math.abs(value)).toBeCloseTo(0.25)
    }
  })
})
