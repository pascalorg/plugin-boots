import { describe, expect, test } from 'bun:test'
import {
  COAT_ADD,
  coatBaseStrength,
  DRIP_MAX_PER_TICK,
  DRIP_P,
  DRIP_STRENGTH_GATE,
  PAINT_PALETTE,
  paintColorOf,
  paintLabelInk,
  paintLabelTexture,
  paintPrompt,
  paintStrengthOf,
  paintValue,
  RIM_SPECKLE_ADD,
  RIM_SPECKLE_P,
  selectSplatCells,
  shouldDrip,
  speckleHash,
  SPLAT_FAR_DIST,
  SPLAT_FAR_RADIUS,
  SPLAT_NEAR_DIST,
  SPLAT_NEAR_RADIUS,
  SPLAT_RIM_OUTER,
  splatCoat,
  splatFalloff,
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
  test('anchors pinned: generous near pass close, full fan far', () => {
    // The near floor is the owner's "larger area" call: 0.25 m strokes
    // still WRITE against 0.15 m cells, but a close pass feels like paint.
    expect(SPLAT_NEAR_RADIUS).toBe(0.25)
    expect(splatRadiusAt(0)).toBe(SPLAT_NEAR_RADIUS)
    expect(splatRadiusAt(0.4)).toBe(0.25)
    expect(splatRadiusAt(SPLAT_NEAR_DIST)).toBe(0.25)
    // ≥ 8 m the fan is fully open.
    expect(splatRadiusAt(SPLAT_FAR_DIST)).toBe(SPLAT_FAR_RADIUS)
    expect(splatRadiusAt(8)).toBe(1.4)
    expect(splatRadiusAt(12)).toBe(1.4)
  })

  test('mid values pinned — quadratic ease, not linear', () => {
    // Writing range stays tight: 2 m has barely opened.
    expect(splatRadiusAt(2)).toBeCloseTo(0.27347, 4)
    // Halfway (4.5 m) sits at the t² midpoint…
    expect(splatRadiusAt(4.5)).toBeCloseTo(0.5375, 10)
    // …well under the LINEAR midpoint 0.825: the cone blooms late.
    expect(splatRadiusAt(4.5)).toBeLessThan((0.25 + 1.4) / 2)
    expect(splatRadiusAt(6.5)).toBeCloseTo(0.95995, 4)
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
    // Inside writing range the cone has opened < 3 cm past the near floor.
    expect(splatRadiusAt(WRITING_DISTANCE)).toBeLessThan(SPLAT_NEAR_RADIUS + 0.03)
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

  test('cone ends on real 0.15 m wall cells: 3-cell dab close, broad far', () => {
    const wall = row(21, 0.15)
    // Nose against the wall: the generous 0.25 m pass is a 3-cell dab —
    // still narrow enough to write with, no longer a pencil point.
    expect(selectSplatCells(wall, 1.5, 0, 0, splatRadiusAt(1))).toEqual([9, 10, 11])
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

describe('packed ledger values ((color << 8) | strength)', () => {
  test('round trip across the palette and the strength range', () => {
    for (let color = 0; color < PAINT_PALETTE.length; color++) {
      for (const s of [0, 0.25, 0.5, 1]) {
        const value = paintValue(color, s)
        expect(paintColorOf(value)).toBe(color)
        expect(paintStrengthOf(value)).toBeCloseTo(s, 2)
      }
    }
  })

  test('strength clamps to the byte — accumulation can never overflow color bits', () => {
    expect(paintValue(3, 1.7)).toBe((3 << 8) | 255)
    expect(paintValue(3, -0.4)).toBe(3 << 8)
    expect(paintColorOf(paintValue(6, 99))).toBe(6)
  })
})

describe('coatBaseStrength (color change restarts the coat)', () => {
  test('same color accumulates, a new color restarts from zero', () => {
    const sage = paintValue(2, 0.8)
    expect(coatBaseStrength(sage, 2)).toBeCloseTo(0.8, 2)
    expect(coatBaseStrength(sage, 4)).toBe(0)
    expect(coatBaseStrength(undefined, 4)).toBe(0)
  })

  test('REGRESSION: one navy rim fleck on a saturated sage cell reads faint navy, never full', () => {
    // The old carry — min(1, 1.0 + 0.16) — flipped the cell to navy at 255.
    const saturatedSage = paintValue(2, 1)
    const before = coatBaseStrength(saturatedSage, 4)
    const after = paintValue(4, Math.min(1, before + RIM_SPECKLE_ADD))
    expect(paintColorOf(after)).toBe(4)
    expect(paintStrengthOf(after)).toBeCloseTo(RIM_SPECKLE_ADD, 2)
  })
})

describe('splatFalloff (the feathered edge)', () => {
  test('anchors: full at the center, zero at the rim, half mid-way', () => {
    expect(splatFalloff(0)).toBe(1)
    expect(splatFalloff(-1)).toBe(1)
    expect(splatFalloff(1)).toBe(0)
    expect(splatFalloff(2)).toBe(0)
    expect(splatFalloff(0.5)).toBeCloseTo(0.5, 10)
  })

  test('monotonic non-increasing across the splat', () => {
    let prev = splatFalloff(0)
    for (let t = 0.05; t <= 1.2; t += 0.05) {
      const w = splatFalloff(t)
      expect(w).toBeLessThanOrEqual(prev)
      prev = w
    }
  })
})

describe('speckleHash (the rim overspray lottery)', () => {
  test('deterministic per (cell, serial), in [0, 1)', () => {
    for (let cell = 0; cell < 64; cell++) {
      for (const serial of [0, 1, 7, 1000]) {
        const h = speckleHash(cell, serial)
        expect(h).toBe(speckleHash(cell, serial))
        expect(h).toBeGreaterThanOrEqual(0)
        expect(h).toBeLessThan(1)
      }
    }
  })

  test('a new serial redraws the pattern (successive ticks speckle differently)', () => {
    let moved = 0
    for (let cell = 0; cell < 64; cell++) {
      if ((speckleHash(cell, 1) < RIM_SPECKLE_P) !== (speckleHash(cell, 2) < RIM_SPECKLE_P)) {
        moved++
      }
    }
    expect(moved).toBeGreaterThan(0)
  })

  test('lottery rate lands near RIM_SPECKLE_P over many draws', () => {
    let hits = 0
    const draws = 4000
    for (let i = 0; i < draws; i++) if (speckleHash(i, 3) < RIM_SPECKLE_P) hits++
    expect(hits / draws).toBeGreaterThan(RIM_SPECKLE_P * 0.6)
    expect(hits / draws).toBeLessThan(RIM_SPECKLE_P * 1.4)
  })
})

describe('splatCoat (accumulating feathered splat)', () => {
  test('adds peak at the hit point and feather toward the rim', () => {
    const grid = row(9, 0.15)
    const radius = 0.5
    const coats = splatCoat(grid, 0.6, 0, 0, radius, 1)
    const byCell = new Map(coats.map((c) => [c.cell, c.add]))
    // Cell 4 sits exactly at the hit point: the full COAT_ADD.
    expect(byCell.get(4)).toBeCloseTo(COAT_ADD, 10)
    // Feather: strictly less as distance grows, matching the pure curve
    // (precision 6 — grid centers are Float32, the curve math is Float64).
    expect(byCell.get(3)!).toBeCloseTo(COAT_ADD * splatFalloff(0.15 / radius), 6)
    expect(byCell.get(3)!).toBeLessThan(byCell.get(4)!)
    expect(byCell.get(2)!).toBeLessThan(byCell.get(3)!)
    expect(byCell.get(2)!).toBeCloseTo(byCell.get(6)!, 6)
  })

  test('rim annulus cells take only the faint speckle add, by the lottery', () => {
    const grid = row(200, 0.01)
    const radius = 0.5
    const serial = 7 // draws 3 annulus winners — pinned by the hash
    const coats = splatCoat(grid, 0, 0, 0, radius, serial)
    const coated = new Set(coats.map((c) => c.cell))
    let speckles = 0
    for (const { cell, add } of coats) {
      const d = cell * 0.01
      expect(d).toBeLessThanOrEqual(radius * SPLAT_RIM_OUTER + 1e-9)
      if (d > radius) {
        // Annulus: the flat fleck strength, only for lottery winners.
        expect(add).toBe(RIM_SPECKLE_ADD)
        speckles++
      }
    }
    // Membership matches the deterministic lottery exactly, both ways.
    for (let cell = 51; cell <= 62; cell++) {
      expect(coated.has(cell)).toBe(speckleHash(cell, serial) < RIM_SPECKLE_P)
    }
    expect(speckles).toBeGreaterThan(0)
    // Same serial, same splat — fully deterministic.
    expect(splatCoat(grid, 0, 0, 0, radius, serial)).toEqual(coats)
  })

  test('dead cells never coat; beyond 1.25 r nothing lands', () => {
    const grid = row(5, 0.15, [2])
    const coats = splatCoat(grid, 0.3, 0, 0, 0.2, 1)
    expect(coats.some((c) => c.cell === 2)).toBe(false)
    expect(splatCoat(row(4, 0.15), 9, 9, 9, 0.5, 1)).toEqual([])
  })

  test('repeated ticks accumulate to saturation (the ledger math)', () => {
    // Simulate sprayPaint's accumulation on one center cell.
    let strength = 0
    let ticks = 0
    while (strength < 1 && ticks < 10) {
      strength = Math.min(1, strength + COAT_ADD)
      ticks++
    }
    expect(ticks).toBe(Math.ceil(1 / COAT_ADD))
    expect(paintStrengthOf(paintValue(2, strength))).toBe(1)
  })
})

describe('shouldDrip (over-coat runs, P4)', () => {
  test('only saturated wall cells under the per-tick cap can drip', () => {
    expect(shouldDrip('wall', 0.9, 0, 0.1)).toBe(true)
    // Not a near-vertical surface.
    expect(shouldDrip('slab', 0.9, 0, 0.1)).toBe(false)
    expect(shouldDrip('roof', 0.9, 0, 0.1)).toBe(false)
    // First coats never drip — the cell must already sit past the gate.
    expect(shouldDrip('wall', DRIP_STRENGTH_GATE, 0, 0.1)).toBe(false)
    expect(shouldDrip('wall', 0, 0, 0.1)).toBe(false)
    // Per-tick cap.
    expect(shouldDrip('wall', 0.9, DRIP_MAX_PER_TICK, 0.1)).toBe(false)
    expect(shouldDrip('wall', 0.9, DRIP_MAX_PER_TICK - 1, 0.1)).toBe(true)
    // The lottery.
    expect(shouldDrip('wall', 0.9, 0, DRIP_P)).toBe(false)
    expect(shouldDrip('wall', 0.9, 0, DRIP_P - 1e-9)).toBe(true)
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
