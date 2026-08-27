import { describe, expect, test } from 'bun:test'
import {
  PAINT_PALETTE,
  paintLabelInk,
  paintLabelTexture,
  paintPrompt,
  selectSplatCells,
  SPLAT_FAR_DIST,
  SPLAT_FAR_RADIUS,
  SPLAT_NEAR_DIST,
  SPLAT_NEAR_RADIUS,
  splatRadiusAt,
  WRITING_DISTANCE,
} from './paint'

/** A straight row of cells along X at `spacing`, all alive by default. */
const row = (count: number, spacing: number, dead: number[] = []) => {
  const centers = new Float32Array(count * 3)
  const alive = new Uint8Array(count).fill(1)
  for (let i = 0; i < count; i++) centers[i * 3] = i * spacing
  for (const i of dead) alive[i] = 0
  return { count, alive, centers }
}

describe('splatRadiusAt (the spray cone)', () => {
  test('anchors pinned: narrow plateau close, full fan far', () => {
    // ≤ 1 m the splat is one 0.15 m cell wide — the writing stroke.
    expect(splatRadiusAt(0)).toBe(SPLAT_NEAR_RADIUS)
    expect(splatRadiusAt(0.4)).toBe(0.12)
    expect(splatRadiusAt(SPLAT_NEAR_DIST)).toBe(0.12)
    // ≥ 8 m the fan is fully open.
    expect(splatRadiusAt(SPLAT_FAR_DIST)).toBe(SPLAT_FAR_RADIUS)
    expect(splatRadiusAt(8)).toBe(1.4)
    expect(splatRadiusAt(12)).toBe(1.4)
  })

  test('mid values pinned — quadratic ease, not linear', () => {
    // Writing range stays tight: 2 m has barely opened.
    expect(splatRadiusAt(2)).toBeCloseTo(0.14612, 4)
    // Halfway (4.5 m) sits at the t² midpoint…
    expect(splatRadiusAt(4.5)).toBeCloseTo(0.44, 10)
    // …well under the LINEAR midpoint 0.76: the cone blooms late.
    expect(splatRadiusAt(4.5)).toBeLessThan((0.12 + 1.4) / 2)
    expect(splatRadiusAt(6.5)).toBeCloseTo(0.9102, 4)
  })

  test('monotonic non-decreasing across the reach', () => {
    let prev = splatRadiusAt(0)
    for (let d = 0.25; d <= 12; d += 0.25) {
      const r = splatRadiusAt(d)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })

  test('writing threshold sits on the narrow plateau side of the curve', () => {
    expect(splatRadiusAt(WRITING_DISTANCE)).toBeLessThan(0.15)
  })
})

describe('selectSplatCells (the paint splat)', () => {
  test('picks every alive cell within the radius, inclusive', () => {
    // Float32-exact spacing so the boundary claim is noise-free: 0.25 m
    // cells around x = 0.5 with radius 0.5 — offsets 0, ±0.25, ±0.5 all in.
    const grid = row(5, 0.25)
    expect(selectSplatCells(grid, 0.5, 0, 0, 0.5)).toEqual([0, 1, 2, 3, 4])
    // Tighter radius trims the run symmetrically.
    expect(selectSplatCells(grid, 0.5, 0, 0, 0.25)).toEqual([1, 2, 3])
  })

  test('cone ends on real 0.15 m wall cells: 1-cell stroke close, broad far', () => {
    const wall = row(21, 0.15)
    // Nose against the wall: the splat is a single cell — legible strokes.
    expect(selectSplatCells(wall, 1.5, 0, 0, splatRadiusAt(1))).toEqual([10])
    // Fully open fan blankets a ~2.8 m run of the row.
    const far = selectSplatCells(wall, 1.5, 0, 0, splatRadiusAt(SPLAT_FAR_DIST))
    expect(far.length).toBeGreaterThanOrEqual(17)
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
    expect(selectSplatCells(row(4, 0.15), 9, 9, 9, splatRadiusAt(3))).toEqual([])
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

describe('can label ("PRESS R" band)', () => {
  test('ink contrast: dark print on light coats, light print on dark', () => {
    expect(paintLabelInk('#f2efe6')).toBe('#1c1e22') // CHALK WHITE
    expect(paintLabelInk('#d3a55f')).toBe('#1c1e22') // OCHRE
    expect(paintLabelInk('#3b4a63')).toBe('#f4f2ea') // NAVY
    expect(paintLabelInk('#44464a')).toBe('#f4f2ea') // CHARCOAL
  })

  test('texture cache is palette-bounded — foreign hex mints nothing', () => {
    expect(paintLabelTexture('#123456')).toBeNull()
  })
})

describe('paint HUD prompt', () => {
  test('writing mode inside WRITING_DISTANCE, plain paint line otherwise', () => {
    expect(WRITING_DISTANCE).toBe(2)
    expect(paintPrompt(true, 'SAGE')).toBe('WRITING MODE — R next color')
    expect(paintPrompt(false, 'SAGE')).toBe('PAINT · SAGE — R next color')
  })
})
