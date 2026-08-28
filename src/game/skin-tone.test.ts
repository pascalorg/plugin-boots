import { describe, expect, test } from 'bun:test'
import { Color } from 'three'
import { primedCellColor, type SkinToneSource } from './skin-tone'

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
