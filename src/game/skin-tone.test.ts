import { afterEach, describe, expect, test } from 'bun:test'
import { Color } from 'three'
import {
  averagePixelTone,
  cellPatternTone,
  cellToneAt,
  clearToneAudit,
  FLOOR_CLOD_DARK_HEX,
  FLOOR_DIRT_LIGHT_HEX,
  FLOOR_FLECK_MIX,
  FLOOR_FLECK_RATE,
  floorColumnHash,
  coreCellColor,
  isUntexturedWhite,
  kindFallbackTone,
  mapPatternGrid,
  patternGridCacheSize,
  pendingToneCount,
  primedCellColor,
  resetSkinTones,
  resolveSurfaceTone,
  CEILING_FACE_TINT,
  CEILING_WHITE_HEX,
  retryPendingTones,
  setSkinToneRenderer,
  SKIN_TILE_M,
  STRUCTURE_TOP_HEX,
  type SkinToneKind,
  type SkinToneRenderer,
  type SkinToneSource,
  type SurfaceMaterialLike,
  TONE_GRID_SIZE,
  TONE_RETRY_MAX,
  toneAuditReport,
} from './skin-tone'

/**
 * Pins for the extracted primeSkin per-cell color math (skin-tone.ts):
 * paint.tsx's drain lerps coats up FROM these tones, so they must stay
 * bit-identical to what voxel-walls.tsx primes — every branch (plain wall,
 * slab ceiling face, roof deck/courses, item cellColors) is pinned against
 * a hand-rolled reference of the original loop.
 */

/** The original primeSkin per-cell math, hand-rolled as the reference. */
function reference(wall: SkinToneSource, i: number): Color {
  const j1 = ((i * 2654435761) % 97) / 97
  const j2 = ((i * 1597334677) % 89) / 89
  let base = wall.baseColor
  let jitter = 0.1
  if (wall.cellColors) {
    base = new Color(
      wall.cellColors[i * 3]!,
      wall.cellColors[i * 3 + 1]!,
      wall.cellColors[i * 3 + 2]!,
    )
  } else if (wall.kind === 'slab' && wall.grid.coords[i * 3 + 1] === 0) {
    base = wall.baseColor.clone().offsetHSL(0, -0.06, 0.14)
  } else if (wall.kind === 'roof') {
    if (wall.grid.coords[i * 3 + 2] !== 0) {
      base = wall.baseColor.clone().offsetHSL(0, -0.08, 0.16)
    } else {
      base =
        wall.grid.coords[i * 3 + 1]! % 3 === 2
          ? wall.baseColor.clone().offsetHSL(0, 0, -0.055)
          : wall.baseColor
      jitter = 0.16
    }
  }
  return base.clone().offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * jitter)
}

const coords = (triples: [number, number, number][]): Int16Array => {
  const out = new Int16Array(triples.length * 3)
  triples.forEach(([x, y, z], i) => {
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = z
  })
  return out
}

const expectSame = (a: Color, b: Color) => {
  expect(a.r).toBeCloseTo(b.r, 10)
  expect(a.g).toBeCloseTo(b.g, 10)
  expect(a.b).toBeCloseTo(b.b, 10)
}

describe('primedCellColor (shared primeSkin tone math)', () => {
  test('plain wall: base + two-hash jitter, deterministic per cell', () => {
    const wall: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#c9c1b2'),
      grid: { coords: coords([[0, 0, 0], [1, 0, 0], [2, 1, 0]]) },
    }
    const out = new Color()
    for (let i = 0; i < 3; i++) {
      expectSame(primedCellColor(out, wall, i), reference(wall, i))
      // Same cell, same tone — the drain re-derives it every re-coat.
      expectSame(primedCellColor(new Color(), wall, i), primedCellColor(out, wall, i))
    }
  })

  test('slab: the grid-Y-0 ceiling face lightens, the top skin keeps the floor tone', () => {
    const wall: SkinToneSource = {
      kind: 'slab',
      baseColor: new Color('#8f8577'),
      grid: { coords: coords([[0, 0, 0], [0, 1, 0]]) },
    }
    const out = new Color()
    expectSame(primedCellColor(out, wall, 0), reference(wall, 0))
    expectSame(primedCellColor(out, wall, 1), reference(wall, 1))
    // The ceiling face really is lighter than the top face's base read.
    const ceiling = primedCellColor(new Color(), wall, 0)
    const hslC = { h: 0, s: 0, l: 0 }
    const hslB = { h: 0, s: 0, l: 0 }
    ceiling.getHSL(hslC)
    wall.baseColor.getHSL(hslB)
    expect(hslC.l).toBeGreaterThan(hslB.l)
  })

  test('roof: inner-skin deck, shingle course stripe every 3rd up-slope row', () => {
    const wall: SkinToneSource = {
      kind: 'roof',
      baseColor: new Color('#6d6258'),
      grid: {
        coords: coords([
          [0, 0, 1], // inner skin (deck)
          [0, 2, 0], // outer skin, course row (y % 3 === 2)
          [0, 1, 0], // outer skin, plain row
        ]),
      },
    }
    const out = new Color()
    for (let i = 0; i < 3; i++) {
      expectSame(primedCellColor(out, wall, i), reference(wall, i))
    }
  })

  test('floor-family slab (floorCore): under-layers wear the dirt subfloor, top keeps the floor tone', () => {
    // ny = 3: iy 0 (bottom skin) + iy 1 (rim middle) are UNDER-layers →
    // dirt; iy 2 is the walking surface → the resolved floor tone,
    // bit-identical to a plain slab top (owner wave 5: a carved floor
    // reveals earth, never drywall white). The dirt wears the per-COLUMN
    // clod blend (owner "broken floor looks broken"): the (ix,iz) hash
    // lerps the FLOOR_CLOD anchors, then the generic per-cell jitter.
    const wall: SkinToneSource = {
      kind: 'slab',
      floorCore: true,
      baseColor: new Color('#a0784e'),
      grid: { coords: coords([[0, 0, 0], [0, 1, 0], [0, 2, 0]]), ny: 3 },
    }
    const dirtReference = (i: number): Color => {
      const j1 = ((i * 2654435761) % 97) / 97
      const j2 = ((i * 1597334677) % 89) / 89
      return new Color(FLOOR_CLOD_DARK_HEX)
        .lerp(new Color(FLOOR_DIRT_LIGHT_HEX), (floorColumnHash(0, 0) % 1024) / 1024)
        .offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * 0.1)
    }
    const out = new Color()
    expectSame(primedCellColor(out, wall, 0), dirtReference(0))
    expectSame(primedCellColor(out, wall, 1), dirtReference(1))
    // Top layer: exactly the plain-slab top math (no ceiling lighten, no dirt).
    expectSame(primedCellColor(out, wall, 2), reference({ ...wall, floorCore: false }, 2))
    // The dirt really reads warm brown, not white.
    const dirt = primedCellColor(new Color(), wall, 0)
    expect(isUntexturedWhite(dirt)).toBe(false)
    expect(dirt.r).toBeGreaterThan(dirt.g)
    expect(dirt.g).toBeGreaterThan(dirt.b)
  })

  test('floor-core dirt varies per plan column: deterministic, ~±0.11 lightness spread, always earth', () => {
    // A 10×10 plan of bottom-skin cells (iy 0, ny 3): the clod hash must
    // spread the columns well past the old flat ±0.05 jitter — rubble, not
    // one brown sheet — while staying deterministic and never white.
    const plan: [number, number, number][] = []
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) plan.push([x, 0, z])
    const wall: SkinToneSource = {
      kind: 'slab',
      floorCore: true,
      baseColor: new Color('#a0784e'),
      grid: { coords: coords(plan), ny: 3 },
    }
    const hsl = { h: 0, s: 0, l: 0 }
    let minL = Infinity
    let maxL = -Infinity
    const out = new Color()
    for (let i = 0; i < plan.length; i++) {
      primedCellColor(out, wall, i)
      expect(isUntexturedWhite(out)).toBe(false)
      expect(out.r).toBeGreaterThan(out.b) // warm, always
      out.getHSL(hsl)
      if (hsl.l < minL) minL = hsl.l
      if (hsl.l > maxL) maxL = hsl.l
      // Deterministic: the same cell re-primes to the same tone.
      expectSame(primedCellColor(new Color(), wall, i), out)
    }
    // Clod anchors (~±0.06 linear lightness) + cell jitter (±0.05): the
    // total spread must clearly beat the old ±0.05-only band, and stay
    // bounded (subtle rubble, not noise).
    expect(maxL - minL).toBeGreaterThan(0.12)
    expect(maxL - minL).toBeLessThan(0.3)
  })

  test('floor-core flecks: ~1 in 5 columns folds a desaturated pattern sample into the dirt', () => {
    // A blue-tile floor (striped map — the blue half is unmistakable in
    // brown dirt): with the toneGrid present, FLOOR_FLECK_RATE of columns
    // lerp FLOOR_FLECK_MIX of the desaturated sample in; the rest stay
    // bit-identical to the grid-less dirt. Dirt first, flecks second.
    const grid = mapPatternGrid(stripedMap())!
    const plan: [number, number, number][] = []
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) plan.push([x, 0, z])
    const flecked: SkinToneSource = {
      kind: 'slab',
      floorCore: true,
      baseColor: new Color('#a0784e'),
      toneGrid: grid,
      grid: { coords: coords(plan), ny: 3, cellX: 0.15, cellY: 0.05, cellZ: 0.15 },
    }
    const plain: SkinToneSource = { ...flecked, toneGrid: undefined }
    let flecks = 0
    const a = new Color()
    const b = new Color()
    for (let i = 0; i < plan.length; i++) {
      primedCellColor(a, flecked, i)
      primedCellColor(b, plain, i)
      if (a.equals(b)) continue
      flecks++
      // A fleck is a MIX into the dirt, not a replacement — the shift stays
      // well under the lerp fraction's reach (the HSL jitter riding on top
      // keeps it approximate, so bound loosely).
      expect(Math.abs(a.r - b.r)).toBeLessThan(FLOOR_FLECK_MIX + 0.15)
      expect(isUntexturedWhite(a)).toBe(false)
    }
    const rate = flecks / plan.length
    expect(rate).toBeGreaterThan(FLOOR_FLECK_RATE - 0.12)
    expect(rate).toBeLessThan(FLOOR_FLECK_RATE + 0.12)
  })

  test('floorCore without grid.ny falls back to the legacy slab math (defensive)', () => {
    const wall: SkinToneSource = {
      kind: 'slab',
      floorCore: true,
      baseColor: new Color('#8f8577'),
      grid: { coords: coords([[0, 0, 0], [0, 1, 0]]) },
    }
    const out = new Color()
    expectSame(primedCellColor(out, wall, 0), reference(wall, 0))
    expectSame(primedCellColor(out, wall, 1), reference(wall, 1))
  })

  test('ceiling plates never mute per CELL — every layer keeps the legacy slab math bit-exact', () => {
    // Live host ceilings voxelize as ONE cell layer whose bottom face IS
    // the room ceiling: any per-cell mute would darken the interior view
    // (the 2026-08-29 regression). The attic-side mute rides the ceiling
    // geometry's VERTEX colors instead (CEILING_FACE_TINT) — so the cell
    // tone must stay the plain slab chain on every layer, top included.
    const wall: SkinToneSource = {
      kind: 'slab',
      baseColor: new Color('#f2efe9'), // interior-white ceiling paint
      grid: { coords: coords([[0, 0, 0], [0, 1, 0], [0, 2, 0]]), ny: 3 },
    }
    const out = new Color()
    expectSame(primedCellColor(out, wall, 0), reference(wall, 0))
    expectSame(primedCellColor(out, wall, 1), reference(wall, 1))
    expectSame(primedCellColor(out, wall, 2), reference(wall, 2))
  })

  test('CEILING_FACE_TINT lands the interior-white ceiling exactly on STRUCTURE_TOP', () => {
    // The face keying contract: vertexColor × instanceColor. A default
    // interior-white ceiling cell wearing the tint on its attic faces must
    // read STRUCTURE_TOP — muted, never anywhere near untextured white —
    // and any darker (painted) tone can only get darker still.
    const white = new Color(CEILING_WHITE_HEX)
    const structure = new Color(STRUCTURE_TOP_HEX)
    const tinted = new Color(
      white.r * CEILING_FACE_TINT[0],
      white.g * CEILING_FACE_TINT[1],
      white.b * CEILING_FACE_TINT[2],
    )
    expectSame(tinted, structure)
    expect(isUntexturedWhite(tinted)).toBe(false)
    for (const c of CEILING_FACE_TINT) {
      expect(c).toBeGreaterThan(0)
      expect(c).toBeLessThan(0.5) // a real mute, not a subtle darken
    }
  })

  test('wall: the TOP row (the plate) wears muted structure, every other row keeps the wall tone', () => {
    const wall: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#e8e2d5'),
      grid: { coords: coords([[0, 0, 0], [0, 1, 0], [1, 2, 0], [0, 2, 1]]), ny: 3 },
    }
    const structureReference = (i: number): Color => {
      const j1 = ((i * 2654435761) % 97) / 97
      const j2 = ((i * 1597334677) % 89) / 89
      return new Color(STRUCTURE_TOP_HEX).offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * 0.1)
    }
    const out = new Color()
    expectSame(primedCellColor(out, wall, 0), reference(wall, 0))
    expectSame(primedCellColor(out, wall, 1), reference(wall, 1))
    // Both top-row cells mute — the rim spans the full thickness.
    expectSame(primedCellColor(out, wall, 2), structureReference(2))
    expectSame(primedCellColor(out, wall, 3), structureReference(3))
  })

  test('top-rim muting never fires without grid.ny, on single-row walls, or on any slab', () => {
    const out = new Color()
    // No ny (legacy callers): walls keep the plain math on every row.
    const noNy: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#c9c1b2'),
      grid: { coords: coords([[0, 0, 0], [0, 5, 0]]) },
    }
    expectSame(primedCellColor(out, noNy, 0), reference(noNy, 0))
    expectSame(primedCellColor(out, noNy, 1), reference(noNy, 1))
    // Single-row wall grid: that one row is the whole visible face.
    const single: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#c9c1b2'),
      grid: { coords: coords([[0, 0, 0]]), ny: 1 },
    }
    expectSame(primedCellColor(out, single, 0), reference(single, 0))
    // Slabs (floors keep their walking surface; ceilings keep the interior
    // tone — their attic mute is per FACE): the top layer keeps the
    // resolved tone.
    const floor: SkinToneSource = {
      kind: 'slab',
      baseColor: new Color('#a0784e'),
      grid: { coords: coords([[0, 2, 0]]), ny: 3 },
    }
    expectSame(primedCellColor(out, floor, 0), reference(floor, 0))
  })

  test('item cellColors win over every kind branch', () => {
    const wall: SkinToneSource = {
      kind: 'slab',
      baseColor: new Color('#ff0000'),
      cellColors: new Float32Array([0.2, 0.4, 0.6, 0.1, 0.2, 0.3]),
      grid: { coords: coords([[0, 0, 0], [1, 0, 0]]) },
    }
    const out = new Color()
    expectSame(primedCellColor(out, wall, 0), reference(wall, 0))
    expectSame(primedCellColor(out, wall, 1), reference(wall, 1))
  })

  test('never mutates the target baseColor', () => {
    const base = new Color('#9cab8b')
    const wall: SkinToneSource = {
      kind: 'roof',
      baseColor: base.clone(),
      grid: { coords: coords([[0, 2, 0], [0, 0, 1]]) },
    }
    primedCellColor(new Color(), wall, 0)
    primedCellColor(new Color(), wall, 1)
    expectSame(wall.baseColor, base)
  })
})

// ── resolveSurfaceTone: the "no voxel stays white" chain ────────────────────

/** DataTexture-style readable map: every texel one flat RGBA byte color. */
function readableMap(r: number, g: number, b: number, w = 2, h = 2): SurfaceMaterialLike['map'] {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  return { image: { data, width: w, height: h } } as unknown as SurfaceMaterialLike['map']
}

/** A map whose image can never be read on the CPU (compressed / headless). */
function unreadableMap(): SurfaceMaterialLike['map'] {
  return { image: { width: 4, height: 4 } } as unknown as SurfaceMaterialLike['map']
}

const srgbTone = (r: number, g: number, b: number) =>
  new Color().setRGB(r / 255, g / 255, b / 255, 'srgb')

afterEach(() => {
  resetSkinTones()
  setSkinToneRenderer(null)
})

describe('resolveSurfaceTone (fallback chain)', () => {
  test('kind fallbacks are plausible materials, never untextured white', () => {
    for (const kind of ['wall', 'slab', 'volume', 'roof', 'item', 'floor'] as SkinToneKind[]) {
      const tone = kindFallbackTone(kind)
      expect(isUntexturedWhite(tone)).toBe(false)
    }
    // And the detector itself: white/near-white trips, real colors don't.
    expect(isUntexturedWhite(new Color('#ffffff'))).toBe(true)
    expect(isUntexturedWhite(new Color(0.95, 0.95, 0.95))).toBe(true)
    expect(isUntexturedWhite(new Color('#d8d2c7'))).toBe(false)
  })

  test("the 'floor' fallback is wood-family: warm brown, darker than the slab greige", () => {
    const floor = kindFallbackTone('floor')
    expect(floor.r).toBeGreaterThan(floor.g)
    expect(floor.g).toBeGreaterThan(floor.b)
    const slab = kindFallbackTone('slab')
    const l = (c: Color) => (c.r + c.g + c.b) / 3
    expect(l(floor)).toBeLessThan(l(slab))
  })

  test('no material at all → kind fallback + no-material audit', () => {
    const tone = resolveSurfaceTone('node-a', 'slab', null)
    expectSame(tone, kindFallbackTone('slab'))
    expect(toneAuditReport()).toEqual([{ nodeId: 'node-a', kind: 'slab', why: 'no-material' }])
  })

  test('readable map wins: average tone × base color, audit clean', () => {
    const material: SurfaceMaterialLike = {
      color: new Color(0.5, 1, 1),
      map: readableMap(255, 0, 0),
    }
    const tone = resolveSurfaceTone('node-b', 'wall', material)
    const expected = srgbTone(255, 0, 0).multiply(material.color!)
    expectSame(tone, expected)
    expect(toneAuditReport()).toEqual([])
    expect(pendingToneCount()).toBe(0)
  })

  test('averagePixelTone decodes sRGB bytes into the working space', () => {
    const tone = averagePixelTone([128, 64, 32, 255], true)!
    expectSame(tone, srgbTone(128, 64, 32))
    // GPU readbacks are already working-space — no decode.
    const linear = averagePixelTone([128, 64, 32, 255], false)!
    expectSame(linear, new Color(128 / 255, 64 / 255, 32 / 255))
  })

  test('white base, no map → kind fallback + white-base audit', () => {
    const tone = resolveSurfaceTone('node-c', 'roof', { color: new Color('#ffffff') })
    expectSame(tone, kindFallbackTone('roof'))
    expect(toneAuditReport()).toEqual([{ nodeId: 'node-c', kind: 'roof', why: 'white-base' }])
  })

  test('colored base, no map → the base color, audit clean', () => {
    const base = new Color('#59702c')
    const tone = resolveSurfaceTone('node-d', 'wall', { color: base.clone() })
    expectSame(tone, base)
    expect(toneAuditReport()).toEqual([])
  })

  test('unreadable map + white base → fallback now, pending retry delivers when the image loads', () => {
    const material: SurfaceMaterialLike = { color: new Color('#ffffff'), map: unreadableMap() }
    let delivered: Color | null = null
    const tone = resolveSurfaceTone('node-e', 'wall', material, (t) => {
      delivered = t
    })
    expectSame(tone, kindFallbackTone('wall'))
    expect(toneAuditReport()).toEqual([{ nodeId: 'node-e', kind: 'wall', why: 'pending' }])
    expect(pendingToneCount()).toBe(1)
    // The texture "finishes loading": its image becomes CPU-readable.
    const loaded = readableMap(0, 255, 0)!
    ;(material.map as { image?: unknown }).image = loaded.image
    retryPendingTones()
    expect(delivered).not.toBeNull()
    expectSame(delivered!, srgbTone(0, 255, 0)) // × white base = itself
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport()).toEqual([])
  })

  test('unreadable map + colored base → base color immediately, still retrying', () => {
    const base = new Color('#7a3b2e')
    const tone = resolveSurfaceTone(
      'node-f',
      'slab',
      { color: base.clone(), map: unreadableMap() },
      () => {},
    )
    expectSame(tone, base)
    expect(pendingToneCount()).toBe(1)
    expect(toneAuditReport()).toEqual([{ nodeId: 'node-f', kind: 'slab', why: 'pending' }])
  })

  test('retry exhausts after TONE_RETRY_MAX passes → map-unreadable audit, no delivery', () => {
    let delivered = 0
    resolveSurfaceTone('node-g', 'roof', { color: new Color('#fff'), map: unreadableMap() }, () => {
      delivered++
    })
    for (let i = 0; i < TONE_RETRY_MAX; i++) retryPendingTones()
    expect(pendingToneCount()).toBe(0)
    expect(delivered).toBe(0)
    expect(toneAuditReport()).toEqual([{ nodeId: 'node-g', kind: 'roof', why: 'map-unreadable' }])
    // Further passes are no-ops.
    retryPendingTones()
    expect(toneAuditReport()).toHaveLength(1)
  })

  test('no retint callback → immediate map-unreadable audit (retrying could never deliver)', () => {
    resolveSurfaceTone('node-h', 'volume', { color: new Color('#fff'), map: unreadableMap() })
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport()).toEqual([{ nodeId: 'node-h', kind: 'volume', why: 'map-unreadable' }])
  })

  test('a re-resolve replaces the pending entry (no double retries)', () => {
    resolveSurfaceTone('node-i', 'wall', { map: unreadableMap() }, () => {})
    resolveSurfaceTone('node-i', 'wall', { map: unreadableMap() }, () => {})
    expect(pendingToneCount()).toBe(1)
  })

  test('clearToneAudit forgets the node (dropTarget)', () => {
    resolveSurfaceTone('node-j', 'wall', { map: unreadableMap() }, () => {})
    clearToneAudit('node-j')
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport()).toEqual([])
  })

  test('GPU readback lane: a registered renderer resolves compressed maps async', async () => {
    // Fake renderer: "samples" every texture as one flat linear color.
    const renderer: SkinToneRenderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      render: () => {},
      readRenderTargetPixels: (_t, _x, _y, w, h, buffer) => {
        for (let i = 0; i < w * h * 4; i += 4) {
          buffer[i] = 64
          buffer[i + 1] = 128
          buffer[i + 2] = 255
          buffer[i + 3] = 255
        }
      },
    }
    setSkinToneRenderer(renderer)
    const material: SurfaceMaterialLike = { color: new Color(0.5, 0.5, 0.5), map: unreadableMap() }
    let delivered: Color | null = null
    const tone = resolveSurfaceTone('node-k', 'roof', material, (t) => {
      delivered = t
    })
    // Sync answer is the chain fallback (gray base is non-white → kept)…
    expectSame(tone, material.color!)
    // …and attempt 0 kicked the readback immediately — no 1 s wait.
    await new Promise((r) => setTimeout(r, 0))
    expect(delivered).not.toBeNull()
    // The readback flows through the Float32 pattern grid — expect f32.
    const linear = new Color(
      Math.fround(64 / 255),
      Math.fround(128 / 255),
      Math.fround(255 / 255),
    )
    expectSame(delivered!, linear.clone().multiply(material.color!))
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport()).toEqual([])
    // The tone cached per map: the next resolve answers synchronously.
    const again = resolveSurfaceTone('node-l', 'roof', {
      color: new Color(1, 1, 1),
      map: material.map,
    })
    expectSame(again, linear)
  })
})

// ── Per-cell texture patterns (stage 2) ─────────────────────────────────────

/** Vertically-striped readable map: left half red, right half blue. */
function stripedMap(w = 8, h = 8, uuid?: string): SurfaceMaterialLike['map'] {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (x < w / 2) data[o] = 255
      else data[o + 2] = 255
      data[o + 3] = 255
    }
  }
  const map = { image: { data, width: w, height: h } } as Record<string, unknown>
  if (uuid) map.uuid = uuid
  return map as unknown as SurfaceMaterialLike['map']
}

/** Dark-shingle map whose 1-texel border ring is TRANSPARENT WHITE — the
 * thumbnail-margin shape that used to dress a roof's eave/rake EDGE cells
 * in white while the field read the true dark tone. */
function borderedMap(w = 8, h = 8): SurfaceMaterialLike['map'] {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        data[o] = 255
        data[o + 1] = 255
        data[o + 2] = 255
        data[o + 3] = 0 // transparent white margin
      } else {
        data[o] = 96
        data[o + 1] = 64
        data[o + 2] = 48
        data[o + 3] = 255 // opaque dark shingle
      }
    }
  }
  return { image: { data, width: w, height: h } } as unknown as SurfaceMaterialLike['map']
}

describe('per-cell texture patterns', () => {
  test('mapPatternGrid resamples the image; cellToneAt reads the stripes', () => {
    const grid = mapPatternGrid(stripedMap())!
    expect(grid.size).toBe(TONE_GRID_SIZE)
    const left = cellToneAt(new Color(), grid, 0.2, 0.5)
    const right = cellToneAt(new Color(), grid, 0.8, 0.5)
    expect(left.r).toBeGreaterThan(0.9)
    expect(left.b).toBeLessThan(0.1)
    expect(right.b).toBeGreaterThan(0.9)
    expect(right.r).toBeLessThan(0.1)
  })

  test('bordered ToneGrid: edge-cell tone == interior family, never the white margin', () => {
    // Roof-edge whites (owner round 5): cellPatternTone tiles v=0 straight
    // onto the eave row, so a transparent/white image margin must backfill
    // from the nearest OPAQUE texel instead of masquerading as pattern.
    const grid = mapPatternGrid(borderedMap())!
    const roof: SkinToneSource = {
      kind: 'roof',
      baseColor: new Color('#5a524a'),
      toneGrid: grid,
      grid: {
        // Cell 0: eave row (iy = 0 → v = 0, the margin row). Cell 1: an
        // interior row of the same column. Both outer skin (iz = 0).
        coords: new Int16Array([1, 0, 0, 1, 1, 0]),
        cellX: 0.2,
        cellY: 0.2,
        cellZ: 0.2,
      },
    }
    const eave = cellPatternTone(new Color(), roof, 0)!
    const interior = cellPatternTone(new Color(), roof, 1)!
    // The margin texel inherited the interior tone — bit-equal here since
    // the opaque field is uniform.
    expectSame(eave, interior)
    expect(isUntexturedWhite(eave)).toBe(false)
    expect(eave.r).toBeLessThan(0.5)
    // The primed cell (tone + jitter) stays in the dark family too.
    const primed = primedCellColor(new Color(), roof, 0)
    expect(isUntexturedWhite(primed)).toBe(false)
    expect(primed.r).toBeLessThan(0.5)
  })

  test('cellToneAt tiles: u wraps in both directions', () => {
    const grid = mapPatternGrid(stripedMap())!
    const base = cellToneAt(new Color(), grid, 0.25, 0.5)
    expectSame(cellToneAt(new Color(), grid, 1.25, 0.5), base)
    expectSame(cellToneAt(new Color(), grid, -0.75, 0.5), base)
    expectSame(cellToneAt(new Color(), grid, 0.25, 2.5), base)
  })

  test('the grid cache is bounded (LRU ~24, keyed per texture uuid)', () => {
    // Evictable fills: 30 distinct uuids never exceed the cap.
    for (let i = 0; i < 30; i++) mapPatternGrid(stripedMap(4, 4, `cache-test-${i}`))
    expect(patternGridCacheSize()).toBeLessThanOrEqual(24)
    // Cache HIT semantics: mutating the underlying image is invisible
    // while cached (same grid object comes back)…
    const map = stripedMap(4, 4, 'cache-test-pinned')!
    const first = mapPatternGrid(map)!
    ;(map.image as { data: Uint8Array }).data.fill(0)
    expect(mapPatternGrid(map)).toBe(first)
    // …and an EVICTED map re-reads its pixels (25 fresh entries push the
    // pinned one out — it was the least recently used by then).
    for (let i = 0; i < 25; i++) mapPatternGrid(stripedMap(4, 4, `cache-evict-${i}`))
    const reread = mapPatternGrid(map)!
    expect(reread).not.toBe(first)
    expect(reread.rgb[0]).toBe(0) // the mutation is visible now
  })

  test('wall UVs: u runs along the SPAN axis, v up the height', () => {
    const grid = mapPatternGrid(stripedMap())!
    // Span on X (nx > nz), cells sized so the span crosses half a tile.
    const wall: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 0, 0], // u = 0 → red half
          [4, 0, 0], // u = 4×0.15/1.2 = 0.5 → blue half
          [0, 3, 1], // same column, higher + inner skin → SAME stripe
        ]),
        cellX: 0.15,
        cellY: 0.15,
        cellZ: 0.04,
        nx: 12,
        nz: 3,
      },
    }
    const a = cellPatternTone(new Color(), wall, 0)!
    const b = cellPatternTone(new Color(), wall, 1)!
    const c = cellPatternTone(new Color(), wall, 2)!
    expect(a.r).toBeGreaterThan(a.b) // red side
    expect(b.b).toBeGreaterThan(b.r) // blue side
    expectSame(c, a) // v moved, thickness ignored — same stripe
  })

  test('wall UVs: a Z-span wall (thickness on X) reads u along Z', () => {
    const grid = mapPatternGrid(stripedMap())!
    const wall: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 0, 0],
          [1, 0, 4], // thickness X moved AND span Z moved: u follows Z
        ]),
        cellX: 0.04,
        cellY: 0.15,
        cellZ: 0.15,
        nx: 3,
        nz: 12,
      },
    }
    const a = cellPatternTone(new Color(), wall, 0)!
    const b = cellPatternTone(new Color(), wall, 1)!
    expect(a.r).toBeGreaterThan(a.b)
    expect(b.b).toBeGreaterThan(b.r)
  })

  test('slab UVs project the plan (x/z); roof UVs run across/up-slope (x/y)', () => {
    const grid = mapPatternGrid(stripedMap())!
    const slab: SkinToneSource = {
      kind: 'slab',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 1, 0],
          [2, 1, 3], // u = 2×0.3/1.2 = 0.5 → the other stripe
        ]),
        cellX: 0.3,
        cellY: 0.05,
        cellZ: 0.3,
      },
    }
    expect(cellPatternTone(new Color(), slab, 0)!.r).toBeGreaterThan(0.5)
    expect(cellPatternTone(new Color(), slab, 1)!.b).toBeGreaterThan(0.5)
    const roof: SkinToneSource = {
      kind: 'roof',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 0, 0], // across = 0 → red
          [4, 0, 0], // across = 4×0.18/1.2 = 0.6 → blue
          [0, 2, 1], // up-slope + inner skin, same across → red still
        ]),
        cellX: 0.18,
        cellY: 0.18,
        cellZ: 0.05,
      },
    }
    expect(cellPatternTone(new Color(), roof, 0)!.r).toBeGreaterThan(0.5)
    expect(cellPatternTone(new Color(), roof, 1)!.b).toBeGreaterThan(0.5)
    expect(cellPatternTone(new Color(), roof, 2)!.r).toBeGreaterThan(0.5)
  })

  test('tiling scale: cells SKIN_TILE_M apart wrap to the same texel', () => {
    const grid = mapPatternGrid(stripedMap())!
    const wall: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 0, 0],
          [8, 0, 0], // 8 × 0.15 m = 1.2 m = exactly one repeat
        ]),
        cellX: SKIN_TILE_M / 8,
        cellY: 0.15,
        cellZ: 0.04,
        nx: 12,
        nz: 3,
      },
    }
    expectSame(cellPatternTone(new Color(), wall, 0)!, cellPatternTone(new Color(), wall, 1)!)
  })

  test('primedCellColor wears the pattern: far-apart cells differ; no grid dims → flat base', () => {
    const grid = mapPatternGrid(stripedMap())!
    const wall: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 0, 0],
          [4, 0, 0],
        ]),
        cellX: 0.15,
        cellY: 0.15,
        cellZ: 0.04,
        nx: 12,
        nz: 3,
      },
    }
    const a = primedCellColor(new Color(), wall, 0)
    const b = primedCellColor(new Color(), wall, 1)
    // The stripe survives the jitter (hue-level difference, not lightness).
    expect(a.r - a.b).toBeGreaterThan(0.5)
    expect(b.b - b.r).toBeGreaterThan(0.5)
    // Cell sizes missing → the pattern lane stands down to the flat base.
    const dimless: SkinToneSource = {
      kind: 'wall',
      baseColor: new Color('#808080'),
      toneGrid: grid,
      grid: { coords: coords([[0, 0, 0]]) },
    }
    const flat = primedCellColor(new Color(), dimless, 0)
    const reference = primedCellColor(new Color(), { ...dimless, toneGrid: undefined }, 0)
    expectSame(flat, reference)
  })

  test('kind modifiers apply RELATIVE to the sampled tone (slab ceiling lightens it)', () => {
    const grid = mapPatternGrid(stripedMap())!
    const slab: SkinToneSource = {
      kind: 'slab',
      baseColor: new Color('#202020'),
      toneGrid: grid,
      grid: {
        coords: coords([
          [0, 0, 0], // ceiling face (y = 0)
          [0, 1, 0], // top skin, same plan spot
        ]),
        cellX: 0.3,
        cellY: 0.05,
        cellZ: 0.3,
      },
    }
    const ceiling = primedCellColor(new Color(), slab, 0)
    const top = primedCellColor(new Color(), slab, 1)
    // Both red-side samples; the ceiling is the lighter one.
    expect(ceiling.r).toBeGreaterThan(ceiling.b)
    const hslC = { h: 0, s: 0, l: 0 }
    const hslT = { h: 0, s: 0, l: 0 }
    ceiling.getHSL(hslC)
    top.getHSL(hslT)
    expect(hslC.l).toBeGreaterThan(hslT.l)
  })
})

describe('coreCellColor (conforming-shell core tone)', () => {
  test('darkened structural read: lightness −0.18, slight desaturation, pure + deterministic', () => {
    const base = new Color('#c0392b') // saturated brick red
    const out = coreCellColor(base, 'slab', new Color())
    // Non-wall kinds skip the gypsum pull: exactly base.offsetHSL(0, −0.08, −0.18).
    const reference = base.clone().offsetHSL(0, -0.08, -0.18)
    expect(out.r).toBeCloseTo(reference.r, 10)
    expect(out.g).toBeCloseTo(reference.g, 10)
    expect(out.b).toBeCloseTo(reference.b, 10)
    const hslBase = { h: 0, s: 0, l: 0 }
    const hslCore = { h: 0, s: 0, l: 0 }
    base.getHSL(hslBase)
    out.getHSL(hslCore)
    expect(hslCore.l).toBeCloseTo(hslBase.l - 0.18, 10)
    expect(hslCore.s).toBeLessThan(hslBase.s)
    // Base is never mutated; writes into `out` and returns it.
    expect(base.getHexString()).toBe('c0392b')
    const again = new Color()
    expect(coreCellColor(base, 'slab', again)).toBe(again)
    expect(again.equals(out)).toBe(true)
  })

  test("kind tweak: 'wall' cores pull toward the gypsum-gray family, other kinds keep their base", () => {
    const base = new Color('#c0392b')
    const wallCore = coreCellColor(base, 'wall', new Color())
    const slabCore = coreCellColor(base, 'slab', new Color())
    const hslWall = { h: 0, s: 0, l: 0 }
    const hslSlab = { h: 0, s: 0, l: 0 }
    wallCore.getHSL(hslWall)
    slabCore.getHSL(hslSlab)
    // The gypsum pull desaturates the wall core well past the flat tweak…
    expect(hslWall.s).toBeLessThan(hslSlab.s)
    // …and lands it nearer the gray axis (r≈g≈b) than the slab core.
    const graySpread = (c: Color) =>
      Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
    expect(graySpread(wallCore)).toBeLessThan(graySpread(slabCore))
    // Both still read darker than the base.
    const hslBase = { h: 0, s: 0, l: 0 }
    base.getHSL(hslBase)
    expect(hslWall.l).toBeLessThan(hslBase.l)
    expect(hslSlab.l).toBeLessThan(hslBase.l)
  })
})
