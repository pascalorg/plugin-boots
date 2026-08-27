import { describe, expect, test } from 'bun:test'
import { dominantPaint } from './paint-keep'

/** cell → palette index, from [cell, color] pairs. */
const coats = (pairs: [number, number][]) => new Map<number, number>(pairs)

describe('dominantPaint (the save-the-paint aggregator)', () => {
  test('per-cell majority wins', () => {
    expect(
      dominantPaint(
        coats([
          [0, 2],
          [1, 2],
          [2, 2],
          [3, 4],
        ]),
      ),
    ).toBe(2)
  })

  test('dead cells do not vote — dominance can flip', () => {
    const cells = coats([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 5],
      [4, 5],
    ])
    expect(dominantPaint(cells)).toBe(1)
    // Cells 0-2 shot out after painting: navy-side survivors take it.
    const alive = (cell: number) => cell >= 3
    expect(dominantPaint(cells, alive)).toBe(5)
  })

  test('ties break to the lower palette index (stable)', () => {
    expect(
      dominantPaint(
        coats([
          [0, 6],
          [1, 3],
        ]),
      ),
    ).toBe(3)
    // Same votes, reversed insertion order — same winner.
    expect(
      dominantPaint(
        coats([
          [0, 3],
          [1, 6],
        ]),
      ),
    ).toBe(3)
  })

  test('nothing voted → null (empty ledger or every cell dead)', () => {
    expect(dominantPaint(coats([]))).toBeNull()
    expect(dominantPaint(coats([[0, 1]]), () => false)).toBeNull()
  })

  test('later coats already overwrote earlier ones — the map is the truth', () => {
    // paint.tsx's ledger stores ONE color per cell; a re-coated cell votes
    // only for its final color.
    const cells = coats([
      [0, 0],
      [1, 0],
    ])
    cells.set(0, 4)
    cells.set(1, 4)
    expect(dominantPaint(cells)).toBe(4)
  })
})
