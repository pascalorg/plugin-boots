import { describe, expect, test } from 'bun:test'
import { Box3, Color, Vector3 } from 'three'
import {
  FAR_GRASS_COUNT,
  FAR_GRASS_FALLOFF,
  FAR_GRASS_INNER,
  FAR_GRASS_OUTER,
  farGrassRadius,
  farTuftGeometry,
  farTuftScale,
  HAZE_FULL,
  HAZE_INNER,
  HAZE_LIFT,
  hazeAlpha,
  hazeGeometry,
  HORIZON_FAR,
  HORIZON_SEGMENTS,
  HORIZON_SKY_RADIUS,
  discContour,
  skirtGeometry,
} from './horizon'
import { GROUND_RADIUS, groundGeometry, scatter } from './nature'
import type { GameWorld } from './world'

/**
 * THE ENDLESS LOT, headless. Everything that makes the void world read as an
 * open field is pure math here: the skirt's shared edge with the lawn disc
 * (the one seam that could crack or z-fight), the haze ramp that has to be
 * fully opaque BEFORE the lawn ends, the far-tuft density law and its
 * dissolve-to-nothing scale. Rendering is covered by the headed QA runs
 * (/tmp/boots-lobby).
 */

function emptyWorld(): GameWorld {
  return {
    colliders: [],
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb: new Box3(),
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

describe('the rig fits the frame: radii ordering', () => {
  test('haze closes before the lawn ends, and the dome sits outside the lawn', () => {
    // If the haze were still translucent at the lawn's rim, the rim would be
    // a visible line. If the dome were inside the lawn, ground would draw
    // OVER the sky. Both orderings are load-bearing.
    expect(HAZE_INNER).toBeLessThan(HAZE_FULL)
    expect(HAZE_FULL).toBeLessThan(HORIZON_FAR)
    expect(HORIZON_FAR).toBeLessThan(HORIZON_SKY_RADIUS)
    // …and the whole rig stays inside the host camera's far plane (1000),
    // with room for a player standing well off the lot center.
    expect(HORIZON_SKY_RADIUS).toBeLessThan(1000 - 200)
    // The haze plate floats over the lawn — a zero lift is a depth tie.
    expect(HAZE_LIFT).toBeGreaterThan(0)
  })
})

describe('discContour — the lawn disc\'s own contour, regenerated', () => {
  test('every skirt-ring vertex is EXACTLY a disc contour vertex (no crack, no overlap)', () => {
    // The seam guarantee: groundGeometry triangulates a Shape whose outer
    // contour three resolves at 2 × curveSegments; the skirt's inner ring has
    // to be those same points, bit for bit, or the shared edge either cracks
    // (background through the lawn) or overlaps (coplanar z-fight).
    const disc = groundGeometry({ buildingAabb: new Box3() })
    const discPos = disc.getAttribute('position')
    const skirt = skirtGeometry(GROUND_RADIUS, GROUND_RADIUS * 2)
    const skirtPos = skirt.getAttribute('position')
    const contour = discContour(GROUND_RADIUS)
    const rings = contour.length / 2
    expect(rings).toBe(HORIZON_SEGMENTS * 2 + 1)

    // Index the disc's vertices by their exact float32 bits.
    const discKeys = new Set<string>()
    for (let i = 0; i < discPos.count; i++) {
      discKeys.add(`${discPos.getX(i)}|${discPos.getY(i)}`)
    }
    for (let i = 0; i < rings; i++) {
      const x = skirtPos.getX(i)
      const y = skirtPos.getY(i)
      // Bit-identical to a disc vertex is the assertion that matters; the
      // radius itself only lands within float32's ~1e-5 at this scale.
      expect(discKeys.has(`${x}|${y}`)).toBe(true)
      expect(Math.hypot(x, y)).toBeCloseTo(GROUND_RADIUS, 4)
    }
    disc.dispose()
    skirt.dispose()
  })

  test('the skirt only ever runs OUTWARD from the disc, out to HORIZON_FAR', () => {
    const skirt = skirtGeometry(GROUND_RADIUS, GROUND_RADIUS * 2)
    const position = skirt.getAttribute('position')
    let maxR = 0
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i))
      expect(r).toBeGreaterThanOrEqual(GROUND_RADIUS - 1e-3)
      expect(position.getZ(i)).toBe(0)
      if (r > maxR) maxR = r
    }
    expect(maxR).toBeCloseTo(HORIZON_FAR, 3)
    skirt.dispose()
  })

  test('every skirt triangle winds CCW-from-+Z, like the disc\'s own', () => {
    // The mesh rotates −π/2 about X: CCW-from-+Z is the up-facing side. Wind
    // it backwards and the entire skirt culls away (invisible lawn, visible
    // rim — the exact bug this whole file exists to kill).
    const skirt = skirtGeometry(GROUND_RADIUS, GROUND_RADIUS * 2)
    const position = skirt.getAttribute('position')
    const index = skirt.getIndex()!
    expect(index.count).toBe(HORIZON_SEGMENTS * 2 * 6)
    for (let f = 0; f < index.count / 3; f++) {
      const a = index.getX(f * 3)
      const b = index.getX(f * 3 + 1)
      const c = index.getX(f * 3 + 2)
      const area =
        (position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a)) -
        (position.getY(b) - position.getY(a)) * (position.getX(c) - position.getX(a))
      expect(area).toBeGreaterThan(0)
    }
    skirt.dispose()
  })

  test('skirt UVs continue the disc\'s meters-per-tile mapping across the seam', () => {
    // Same normalization the disc applies (raw shape meters / 2R + 0.5), so
    // the shared grass texture keeps ONE grain — a different span would show
    // the seam as a scale change even with the geometry perfect.
    const skirt = skirtGeometry(GROUND_RADIUS, GROUND_RADIUS * 2)
    const position = skirt.getAttribute('position')
    const uv = skirt.getAttribute('uv')
    for (const i of [0, 1, 40, 96, 97, 150]) {
      expect(uv.getX(i)).toBeCloseTo(position.getX(i) / (GROUND_RADIUS * 2) + 0.5, 5)
      expect(uv.getY(i)).toBeCloseTo(position.getY(i) / (GROUND_RADIUS * 2) + 0.5, 5)
    }
    skirt.dispose()
  })
})

describe('hazeAlpha — the ground dissolves into the sky', () => {
  test('clean near field, fully opaque before the lawn ends, monotone between', () => {
    expect(hazeAlpha(0)).toBe(0)
    expect(hazeAlpha(HAZE_INNER)).toBe(0)
    expect(hazeAlpha(HAZE_FULL)).toBe(1)
    expect(hazeAlpha(HORIZON_FAR)).toBe(1)
    // The playable area (the depot, the fort, the first 60 m) is untouched.
    expect(hazeAlpha(60)).toBe(0)
    let previous = -1
    for (let r = 0; r <= HORIZON_FAR; r += 5) {
      const alpha = hazeAlpha(r)
      expect(alpha).toBeGreaterThanOrEqual(previous)
      expect(alpha).toBeLessThanOrEqual(1)
      previous = alpha
    }
  })

  test('the ramp is gentle where the player looks and heavy at the far end', () => {
    // A linear ramp washed the mid field out; the gamma keeps the green
    // reading green out past the far tuft layer and does its work in the
    // last degree or two under the horizon.
    expect(hazeAlpha(120)).toBeLessThan(0.1)
    expect(hazeAlpha(FAR_GRASS_OUTER)).toBeLessThan(0.2)
    expect(hazeAlpha(350)).toBeGreaterThan(0.35)
    expect(hazeAlpha(450)).toBeGreaterThan(0.75)
  })

  test('the haze plate spans HAZE_INNER → HORIZON_FAR with v as its radius', () => {
    const haze = hazeGeometry()
    const position = haze.getAttribute('position')
    const uv = haze.getAttribute('uv')
    let minR = Number.POSITIVE_INFINITY
    let maxR = 0
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i))
      minR = Math.min(minR, r)
      maxR = Math.max(maxR, r)
      // v is the radial parameter the baked ramp is indexed by.
      expect(uv.getY(i)).toBeCloseTo((r - HAZE_INNER) / (HORIZON_FAR - HAZE_INNER), 4)
    }
    expect(minR).toBeCloseTo(HAZE_INNER, 3)
    expect(maxR).toBeCloseTo(HORIZON_FAR, 3)
    haze.dispose()
  })
})

describe('farGrassRadius — the far layer\'s density law', () => {
  test('spans exactly [inner, outer] and rises monotonically with u', () => {
    expect(farGrassRadius(0)).toBeCloseTo(FAR_GRASS_INNER, 9)
    expect(farGrassRadius(1)).toBeCloseTo(FAR_GRASS_OUTER, 9)
    let previous = -1
    for (let i = 0; i <= 200; i++) {
      const r = farGrassRadius(i / 200)
      expect(r).toBeGreaterThan(previous)
      previous = r
    }
  })

  test('per-area density really falls as r^-FAR_GRASS_FALLOFF', () => {
    // The point of the inverse CDF: no single `bias` exponent gives a true
    // power-law falloff, and the falloff is what makes the layer's end
    // invisible (density already ~0 where the tufts stop).
    const bins = 8
    const width = (FAR_GRASS_OUTER - FAR_GRASS_INNER) / bins
    const counts = new Array<number>(bins).fill(0)
    const samples = 400000
    for (let i = 0; i < samples; i++) {
      const r = farGrassRadius((i + 0.5) / samples)
      let bin = Math.floor((r - FAR_GRASS_INNER) / width)
      if (bin >= bins) bin = bins - 1
      counts[bin]! += 1
    }
    const density = counts.map((count, bin) => {
      const mid = FAR_GRASS_INNER + (bin + 0.5) * width
      return count / (2 * Math.PI * mid * width)
    })
    for (let bin = 1; bin < bins; bin++) {
      const midA = FAR_GRASS_INNER + 0.5 * width
      const midB = FAR_GRASS_INNER + (bin + 0.5) * width
      const expected = (midA / midB) ** FAR_GRASS_FALLOFF
      expect(density[bin]! / density[0]!).toBeCloseTo(expected, 1)
    }
    // …and it really does thin out: the outermost ring carries ~2% of the
    // innermost ring's per-area density — thin enough that the layer's end
    // is a fade, not a boundary.
    expect(density[bins - 1]! / density[0]!).toBeLessThan(0.03)
  })

  test('scatter drives it end to end on an empty lot', () => {
    const world = emptyWorld()
    const green = new Color('#79b054')
    const field = scatter(
      world,
      23,
      2000,
      FAR_GRASS_INNER,
      FAR_GRASS_OUTER,
      (_rand, position, matrix) => {
        matrix.setPosition(position)
        return green
      },
      0.5,
      (u) => farGrassRadius(u),
    )
    expect(field.matrices.length).toBe(2000)
    let inner = 0
    for (const matrix of field.matrices) {
      const r = Math.hypot(matrix.elements[12]!, matrix.elements[14]!)
      expect(r).toBeGreaterThanOrEqual(FAR_GRASS_INNER - 1e-9)
      expect(r).toBeLessThanOrEqual(FAR_GRASS_OUTER + 1e-9)
      if (r < (FAR_GRASS_INNER + FAR_GRASS_OUTER) / 2) inner++
    }
    // Steep falloff ⇒ the great majority seeds in the near half.
    expect(inner / field.matrices.length).toBeGreaterThan(0.8)
  })
})

describe('farTuftScale — the layer ends in nothing, not in an edge', () => {
  test('grows with distance, then dissolves to exactly zero at the rim', () => {
    expect(farTuftScale(0)).toBeCloseTo(1, 9)
    expect(farTuftScale(1)).toBe(0)
    expect(farTuftScale(0.5)).toBeGreaterThan(farTuftScale(0))
    // The last stretch is a fade, not a cliff: small but non-zero just
    // inside the rim, so there is never a final row of full-size blades.
    expect(farTuftScale(0.97)).toBeGreaterThan(0)
    expect(farTuftScale(0.97)).toBeLessThan(0.6)
    let previous = farTuftScale(0.8)
    for (let t = 0.82; t <= 1.0001; t += 0.02) {
      const s = farTuftScale(t)
      expect(s).toBeLessThan(previous + 1e-12)
      previous = s
    }
  })

  test('clamps outside [0, 1] (a t slightly past 1 must not go negative)', () => {
    expect(farTuftScale(-0.5)).toBeCloseTo(1, 9)
    expect(farTuftScale(1.5)).toBe(0)
  })
})

describe('farTuftGeometry — 4 triangles, up normals, blade colors', () => {
  test('two crossed quads, never edge-on, shaded like the near blades', () => {
    const geometry = farTuftGeometry()
    expect(geometry.getIndex()!.count).toBe(12) // 4 triangles
    const position = geometry.getAttribute('position')
    expect(position.count).toBe(8)
    const normal = geometry.getAttribute('normal')
    for (let i = 0; i < normal.count; i++) {
      expect(normal.getY(i)).toBe(1) // flat cartoony shading, like the field
      expect(normal.getX(i)).toBe(0)
      expect(normal.getZ(i)).toBe(0)
    }
    // Root dark, tip light — the blade ramp, so a tuft reads as grass.
    const color = geometry.getAttribute('color')
    expect(color.getY(0)).toBeLessThan(color.getY(2))
    // The two quads really cross (one spans x, the other z).
    let spanX = 0
    let spanZ = 0
    let height = 0
    for (let i = 0; i < position.count; i++) {
      spanX = Math.max(spanX, Math.abs(position.getX(i)))
      spanZ = Math.max(spanZ, Math.abs(position.getZ(i)))
      height = Math.max(height, position.getY(i))
    }
    expect(spanX).toBeGreaterThan(0.02)
    expect(spanZ).toBeGreaterThan(0.02)
    // TALL AND NARROW, like a scaled-up cluster at the field's own seam. A
    // wide short tuft reads as rubble from a rooftop — QA caught exactly
    // that, so the silhouette is pinned here.
    expect(height).toBeGreaterThan(3 * Math.max(spanX, spanZ))
    geometry.dispose()
  })

  test('the layer stays cheap: FAR_GRASS_COUNT tufts cost a fraction of the field', () => {
    // 4 triangles apiece against the near cluster's 15: the whole far layer
    // adds ~11% of the detailed field's triangles, all of it beyond 55 m.
    const farTris = FAR_GRASS_COUNT * 4
    const nearTris = 20000 * 15
    expect(farTris / nearTris).toBeLessThan(0.15)
  })
})
