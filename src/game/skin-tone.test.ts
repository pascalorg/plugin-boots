import { afterEach, describe, expect, test } from 'bun:test'
import { Color } from 'three'
import {
  averagePixelTone,
  clearToneAudit,
  isUntexturedWhite,
  kindFallbackTone,
  pendingToneCount,
  primedCellColor,
  resetSkinTones,
  resolveSurfaceTone,
  retryPendingTones,
  setSkinToneRenderer,
  type SkinToneKind,
  type SkinToneRenderer,
  type SkinToneSource,
  type SurfaceMaterialLike,
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
    for (const kind of ['wall', 'slab', 'volume', 'roof', 'item'] as SkinToneKind[]) {
      const tone = kindFallbackTone(kind)
      expect(isUntexturedWhite(tone)).toBe(false)
    }
    // And the detector itself: white/near-white trips, real colors don't.
    expect(isUntexturedWhite(new Color('#ffffff'))).toBe(true)
    expect(isUntexturedWhite(new Color(0.95, 0.95, 0.95))).toBe(true)
    expect(isUntexturedWhite(new Color('#d8d2c7'))).toBe(false)
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
    const gpu = new Color(64 / 255, 128 / 255, 255 / 255).multiply(material.color!)
    expectSame(delivered!, gpu)
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport()).toEqual([])
    // The tone cached per map: the next resolve answers synchronously.
    const again = resolveSurfaceTone('node-l', 'roof', {
      color: new Color(1, 1, 1),
      map: material.map,
    })
    expectSame(again, new Color(64 / 255, 128 / 255, 255 / 255))
  })
})
