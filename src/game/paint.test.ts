import { describe, expect, test } from 'bun:test'
import {
  COAT_ADD,
  coatBaseStrength,
  coatRadiusFor,
  currentPaintColor,
  currentPaintIndex,
  cyclePaintColor,
  DRIP_MAX_PER_TICK,
  DRIP_P,
  DRIP_STRENGTH_GATE,
  PAINT_PALETTE,
  PAINT_PALETTE_HEXES,
  paintColorOf,
  paintCycleSerial,
  paintLabelInk,
  paintLabelTexture,
  paintPrompt,
  paintStrengthOf,
  paintValue,
  selectSplatCells,
  shouldDrip,
  SPLAT_COALESCE_FRAC,
  SPLAT_CORE_FRAC,
  SPLAT_FAR_DIST,
  SPLAT_FAR_RADIUS,
  SPLAT_NEAR_DIST,
  SPLAT_NEAR_RADIUS,
  SPLAT_SPRITE_JITTER_MAX,
  SPLAT_SPRITE_JITTER_MIN,
  splatCoat,
  splatFalloff,
  splatRadiusAt,
  splatSpriteSize,
  SWATH_MAX_GAP,
  SWATH_MAX_STEPS,
  SWATH_SPACING_FRAC,
  swathPoints,
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

  test('REGRESSION: a faint graze of a new color on a saturated cell reads faint, never full', () => {
    // The old carry — min(1, 1.0 + 0.16) — flipped the cell to the new
    // color at 255 off one weak rim contribution.
    const graze = 0.16
    const saturatedGreen = paintValue(6, 1)
    const before = coatBaseStrength(saturatedGreen, 8)
    const after = paintValue(8, Math.min(1, before + graze))
    expect(paintColorOf(after)).toBe(8)
    expect(paintStrengthOf(after)).toBeCloseTo(graze, 2)
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

describe('splatCoat (accumulating feathered splat)', () => {
  test('adds peak at the hit point and feather toward the rim', () => {
    const grid = row(9, 0.15)
    const radius = 0.5
    const coats = splatCoat(grid, 0.6, 0, 0, radius)
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

  test('REGRESSION (phase 11): nothing lands past the disc radius — no square halo', () => {
    // The old rim-speckle annulus tinted whole cells up to 1.25 r out: a
    // square fleck halo around the round stamp (the blob read the owner
    // rejected). Every coated cell now sits INSIDE the disc.
    const grid = row(200, 0.01)
    const radius = 0.5
    const coats = splatCoat(grid, 0, 0, 0, radius)
    expect(coats.length).toBeGreaterThan(0)
    for (const { cell } of coats) {
      expect(cell * 0.01).toBeLessThanOrEqual(radius + 1e-9)
    }
    // Deterministic — same inputs, same splat.
    expect(splatCoat(grid, 0, 0, 0, radius)).toEqual(coats)
  })

  test('dead cells never coat; a miss lands nothing', () => {
    const grid = row(5, 0.15, [2])
    const coats = splatCoat(grid, 0.3, 0, 0, 0.2)
    expect(coats.some((c) => c.cell === 2)).toBe(false)
    expect(splatCoat(row(4, 0.15), 9, 9, 9, 0.5)).toEqual([])
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

describe('paint palette (the 12-color R carousel)', () => {
  test('12 colors, the owner spread pinned in cycle order', () => {
    expect(PAINT_PALETTE.length).toBe(12)
    expect(PAINT_PALETTE.map((p) => p.name)).toEqual([
      'WHITE',
      'BLACK',
      'GRAY',
      'RED',
      'ORANGE',
      'YELLOW',
      'GREEN',
      'TEAL',
      'BLUE',
      'PURPLE',
      'PINK',
      'BROWN',
    ])
    const seen = new Set<string>()
    for (const swatch of PAINT_PALETTE) {
      expect(swatch.hex).toMatch(/^#[0-9a-f]{6}$/)
      seen.add(swatch.hex)
    }
    expect(seen.size).toBe(PAINT_PALETTE.length)
    // The HUD hex list mirrors the palette exactly (carousel dot order).
    expect(PAINT_PALETTE_HEXES).toEqual(PAINT_PALETTE.map((p) => p.hex))
  })

  test('R steps the carousel with wrap; every cycle bumps the serial', () => {
    const startIndex = currentPaintIndex()
    const startSerial = paintCycleSerial()
    expect(currentPaintColor()).toBe(PAINT_PALETTE[startIndex]!)
    // One R press: the NEXT color, one serial tick (the HUD flash gate).
    const next = cyclePaintColor()
    expect(next).toBe(PAINT_PALETTE[(startIndex + 1) % PAINT_PALETTE.length]!)
    expect(paintCycleSerial()).toBe(startSerial + 1)
    // A full lap wraps back to where it started.
    for (let i = 1; i < PAINT_PALETTE.length; i++) cyclePaintColor()
    expect(currentPaintIndex()).toBe(startIndex)
    expect(paintCycleSerial()).toBe(startSerial + PAINT_PALETTE.length)
  })
})

describe('can label ("PRESS R" band)', () => {
  test('ink contrast: dark print on light coats, light print on dark', () => {
    expect(paintLabelInk('#f4f4ef')).toBe('#1c1e22') // WHITE
    expect(paintLabelInk('#f5c542')).toBe('#1c1e22') // YELLOW
    expect(paintLabelInk('#3e7fe1')).toBe('#f4f2ea') // BLUE
    expect(paintLabelInk('#26282c')).toBe('#f4f2ea') // BLACK
  })

  test('texture cache is palette-bounded — foreign hex mints nothing', () => {
    expect(paintLabelTexture('#123456')).toBeNull()
  })
})

describe('paint HUD prompt', () => {
  test('writing mode inside WRITING_DISTANCE, plain paint line otherwise', () => {
    expect(WRITING_DISTANCE).toBe(2)
    expect(paintPrompt(true, 'TEAL')).toBe('WRITING MODE — R next color')
    expect(paintPrompt(false, 'TEAL')).toBe('PAINT · TEAL — R next color')
  })
})

describe('solid coverage constants (phase 11)', () => {
  test('the stamp is the exact spray-cone diameter — jitter collapsed', () => {
    expect(SPLAT_SPRITE_JITTER_MIN).toBe(1)
    expect(SPLAT_SPRITE_JITTER_MAX).toBe(1)
    // Any rand draw lands the true 2 × radius quad.
    expect(splatSpriteSize(0.25, 0)).toBeCloseTo(0.5, 12)
    expect(splatSpriteSize(0.25, 1)).toBeCloseTo(0.5, 12)
    expect(splatSpriteSize(1.4, 0.33)).toBeCloseTo(2.8, 12)
  })

  test('bridge spacing ≤ radius/2 and the economy distance sits under it', () => {
    expect(SWATH_SPACING_FRAC).toBeLessThanOrEqual(0.5)
    // Coalescing can swallow stamps only CLOSER than the swath spacing —
    // the held-trigger economy can never open a gap in a dragged band.
    expect(SPLAT_COALESCE_FRAC).toBeLessThan(SWATH_SPACING_FRAC)
  })

  test('ledger coats hide UNDER the opaque core, floored at r/2', () => {
    // The stamp is opaque out to SPLAT_CORE_FRAC × r; a coated 0.15 m wall
    // cell's square reaches its center + 0.075 m. Keeping center + half-cell
    // ≤ the CORE means no saturated square can show through the soft rim.
    expect(SPLAT_CORE_FRAC).toBeCloseTo(0.86, 10)
    expect(coatRadiusFor(0.25)).toBeCloseTo(0.14, 10)
    expect(coatRadiusFor(0.25) + 0.075).toBeLessThanOrEqual(SPLAT_CORE_FRAC * 0.25 + 1e-12)
    expect(coatRadiusFor(1.4)).toBeCloseTo(1.129, 10)
    expect(coatRadiusFor(1.4) + 0.075).toBeLessThanOrEqual(SPLAT_CORE_FRAC * 1.4)
    // Tiny radii floor at half — a coat always lands SOMETHING.
    expect(coatRadiusFor(0.1)).toBeCloseTo(0.05, 10)
  })
})

describe('swathPoints (drag continuity — phase 11)', () => {
  test('no anchor, tiny moves and over-long jumps bridge nothing', () => {
    expect(swathPoints(null, 1, 0, 0, 0.25)).toEqual([])
    // Within one spacing of the anchor: the hit's own stamp covers it.
    expect(swathPoints({ x: 0, y: 0, z: 0 }, 0.12, 0, 0, 0.25)).toEqual([])
    expect(swathPoints({ x: 0, y: 0, z: 0 }, 0.125, 0, 0, 0.25)).toEqual([])
    // Farther than SWATH_MAX_GAP is a new stroke — never bridge across it.
    expect(swathPoints({ x: 0, y: 0, z: 0 }, SWATH_MAX_GAP + 0.01, 0, 0, 0.25)).toEqual([])
  })

  test('a dragged tick fills the gap at ≤ radius/2 spacing, endpoints excluded', () => {
    const radius = 0.25
    const spacing = radius * SWATH_SPACING_FRAC
    const points = swathPoints({ x: 0, y: 0, z: 0 }, 1, 0, 0, radius)
    expect(points.length).toBe(7) // ceil(1 / 0.125) − 1
    // Consecutive stamps (anchor → bridges → hit) never sit farther apart
    // than the spacing — full discs of `radius` overlap into a solid band.
    const xs = [0, ...points.map((p) => p.x), 1]
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(spacing + 1e-12)
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
    }
    // Endpoints excluded: the caller stamps the hit itself.
    expect(points[0]!.x).toBeGreaterThan(0)
    expect(points[points.length - 1]!.x).toBeLessThan(1)
  })

  test('interpolation is true 3D along the segment', () => {
    const points = swathPoints({ x: 0, y: 1, z: 2 }, 1, 2, 3, 1)
    expect(points.length).toBeGreaterThan(0)
    for (const p of points) {
      // Every bridge point sits ON the anchor→hit segment (x−0 = y−1 = z−2).
      expect(p.y - 1).toBeCloseTo(p.x, 10)
      expect(p.z - 2).toBeCloseTo(p.x, 10)
    }
  })

  test('per-tick work is capped at SWATH_MAX_STEPS', () => {
    // radius 0.2 → spacing 0.1; a 2.4 m jump wants 23 bridges, gets 20.
    const points = swathPoints({ x: 0, y: 0, z: 0 }, 2.4, 0, 0, 0.2)
    expect(points.length).toBe(SWATH_MAX_STEPS)
    // The cap covers SWATH_MAX_GAP at the NEAR radius exactly (no gaps in
    // any bridgeable drag at the tight end of the cone).
    const near = swathPoints({ x: 0, y: 0, z: 0 }, SWATH_MAX_GAP, 0, 0, SPLAT_NEAR_RADIUS)
    const spacing = SPLAT_NEAR_RADIUS * SWATH_SPACING_FRAC
    expect(near.length).toBeLessThanOrEqual(SWATH_MAX_STEPS)
    expect(SWATH_MAX_GAP / (near.length + 1)).toBeLessThanOrEqual(spacing + 1e-12)
  })
})
