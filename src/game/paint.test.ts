import { describe, expect, test } from 'bun:test'
import { PAINT_PALETTE, selectSplatCells, SPLAT_RADIUS } from './paint'

/** A straight row of cells along X at `spacing`, all alive by default. */
const row = (count: number, spacing: number, dead: number[] = []) => {
  const centers = new Float32Array(count * 3)
  const alive = new Uint8Array(count).fill(1)
  for (let i = 0; i < count; i++) centers[i * 3] = i * spacing
  for (const i of dead) alive[i] = 0
  return { count, alive, centers }
}

describe('selectSplatCells (the paint splat)', () => {
  test('picks every alive cell within the radius, inclusive', () => {
    // Float32-exact spacing so the boundary claim is noise-free: 0.25 m
    // cells around x = 0.5 with radius 0.5 — offsets 0, ±0.25, ±0.5 all in.
    const grid = row(5, 0.25)
    expect(selectSplatCells(grid, 0.5, 0, 0, 0.5)).toEqual([0, 1, 2, 3, 4])
    // Tighter radius trims the run symmetrically.
    expect(selectSplatCells(grid, 0.5, 0, 0, 0.25)).toEqual([1, 2, 3])
    // The shipped radius covers a ~0.6 m ball of 0.15 m wall cells.
    expect(selectSplatCells(row(9, 0.15), 0.6, 0, 0, SPLAT_RADIUS).length).toBeGreaterThanOrEqual(7)
  })

  test('dead cells never take paint', () => {
    const grid = row(5, 0.15, [2])
    expect(selectSplatCells(grid, 0.3, 0, 0, 0.2)).toEqual([1, 3])
  })

  test('distance is true 3D, not per-axis', () => {
    // One cell offset 0.5 in x AND 0.5 in y — inside the axis box but
    // √0.5 ≈ 0.707 out, past the 0.6 sphere.
    const grid = row(1, 0)
    grid.centers[0] = 0.5
    grid.centers[1] = 0.5
    expect(selectSplatCells(grid, 0, 0, 0, 0.6)).toEqual([])
    expect(selectSplatCells(grid, 0, 0, 0, 0.71)).toEqual([0])
  })

  test('a miss paints nothing', () => {
    expect(selectSplatCells(row(4, 0.15), 9, 9, 9, SPLAT_RADIUS)).toEqual([])
  })
})

describe('paint palette', () => {
  test('6-8 building tones, valid unique hex', () => {
    expect(PAINT_PALETTE.length).toBeGreaterThanOrEqual(6)
    expect(PAINT_PALETTE.length).toBeLessThanOrEqual(8)
    const seen = new Set<string>()
    for (const swatch of PAINT_PALETTE) {
      expect(swatch.hex).toMatch(/^#[0-9a-f]{6}$/)
      expect(swatch.name.length).toBeGreaterThan(0)
      seen.add(swatch.hex)
    }
    expect(seen.size).toBe(PAINT_PALETTE.length)
  })
})
