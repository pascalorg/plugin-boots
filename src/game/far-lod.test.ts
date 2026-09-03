import { describe, expect, test } from 'bun:test'
import {
  BAND_MID_M,
  BAND_NEAR_M,
  bodyDetailVisible,
  DEFAULT_FOV_DEG,
  distanceBand,
  noopRaycast,
  RING_MIN_SCALE,
  ringGeometry,
  ringMaterialCount,
  ringMaterialFor,
  ringVisible,
  SPECTATOR_RING_RENDER_ORDER,
  SPECTATOR_TAG_MAX_DIST,
  SPECTATOR_TAG_RENDER_ORDER,
  spectatorTagOpacity,
  TAG_HEIGHT_M,
  TAG_SCALE_MAX,
  TAG_TARGET_PX,
  tagBottomY,
  tagDepthTest,
  tagFontPx,
  tagLiftY,
  tagRenderOrder,
  tagScale,
  worldPerPixel,
} from './far-lod'

/**
 * The spectator's far-LOD decisions (far-lod.ts) are pure so the whole
 * "small people from the editor camera" behaviour is pinned headless: a
 * constant-pixel tag for BOTH camera kinds, lifted so it never covers the
 * avatar, X-ray + ring decisions, distance bands. The numbers below are the
 * ones the plan measured against (fov 50, 900 px tall canvas; ortho zoom 20).
 */

const persp = { isPerspectiveCamera: true, fov: 50, zoom: 1 }
const ortho = { isOrthographicCamera: true, zoom: 20 }
const H = 900

describe('worldPerPixel', () => {
  test('perspective: 2·d·tan(fov/2)/h — ≈0.00829 m/px at 8 m', () => {
    expect(worldPerPixel(persp, 8, H)).toBeCloseTo(0.00829, 4)
    // Linear in distance.
    expect(worldPerPixel(persp, 16, H)).toBeCloseTo(2 * worldPerPixel(persp, 8, H), 9)
    // A taller viewport packs more pixels into the same field: fewer m/px.
    expect(worldPerPixel(persp, 8, 1800)).toBeCloseTo(worldPerPixel(persp, 8, H) / 2, 9)
  })

  test('perspective zoom narrows the field (three applies zoom in the projection)', () => {
    expect(worldPerPixel({ ...persp, zoom: 2 }, 8, H)).toBeCloseTo(worldPerPixel(persp, 8, H) / 2, 9)
  })

  test('orthographic (drei: 1 world unit = zoom px): 1/zoom, distance-independent', () => {
    expect(worldPerPixel(ortho, 5, H)).toBeCloseTo(0.05, 9)
    expect(worldPerPixel(ortho, 500, 300)).toBeCloseTo(0.05, 9)
  })

  test('defaults: missing fov reads as the editor orbit camera, bad inputs never NaN', () => {
    expect(DEFAULT_FOV_DEG).toBe(50)
    expect(worldPerPixel({}, 8, H)).toBeCloseTo(worldPerPixel(persp, 8, H), 9)
    expect(Number.isFinite(worldPerPixel(persp, 8, 0))).toBe(true)
    expect(worldPerPixel(persp, -3, H)).toBe(0)
    expect(worldPerPixel({ isOrthographicCamera: true, zoom: 0 }, 1, H)).toBe(1)
  })
})

describe('tagScale — constant ~36 px tag', () => {
  test('already ≥ 36 px → 1 (never shrinks the near tag)', () => {
    // 4 m, fov 50, 900 px: the 0.18 m tag is ~43 px tall.
    expect(tagScale(worldPerPixel(persp, 4, H))).toBe(1)
    expect(tagScale(0)).toBe(1)
    expect(tagScale(Number.NaN)).toBe(1)
  })

  test('≈10.4× at 50 m, capped at 12× by 100 m (perspective); 10× in plan view', () => {
    expect(tagScale(worldPerPixel(persp, 50, H))).toBeCloseTo(10.36, 1)
    expect(tagScale(worldPerPixel(persp, 100, H))).toBe(TAG_SCALE_MAX)
    expect(TAG_SCALE_MAX).toBe(12)
    // Ortho zoom 20: the tag is 3.6 px, so 10× makes it the target 36 px.
    expect(tagScale(worldPerPixel(ortho, 30, H))).toBeCloseTo(TAG_TARGET_PX / (TAG_HEIGHT_M * 20), 9)
  })

  test('monotonic non-decreasing in distance', () => {
    let prev = 0
    for (let d = 1; d <= 150; d += 1) {
      const s = tagScale(worldPerPixel(persp, d, H))
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  test('the scaled tag is the target height on screen (within the clamp)', () => {
    // (The 12× cap lands at ≈58 m for a 900 px canvas — past it the tag shrinks
    // again on purpose: a billboard the size of a house helps nobody.)
    for (const d of [20, 40, 55]) {
      const wpp = worldPerPixel(persp, d, H)
      const px = (TAG_HEIGHT_M * tagScale(wpp)) / wpp
      expect(px).toBeCloseTo(TAG_TARGET_PX, 6)
    }
    const far = worldPerPixel(persp, 100, H)
    expect((TAG_HEIGHT_M * tagScale(far)) / far).toBeLessThan(TAG_TARGET_PX)
  })
})

describe('tagLiftY — grows upward, never covers the avatar', () => {
  test('bottom edge stays at 1.96 m for every scale', () => {
    for (const s of [1, 2, 6, 12]) {
      expect(tagBottomY(s)).toBeCloseTo(1.96, 9)
      expect(tagLiftY(s) - 0.09 * s).toBeCloseTo(1.96, 9)
    }
    expect(tagLiftY(1)).toBeCloseTo(2.05, 9) // the 1× tag is exactly where it is today
  })
})

describe('X-ray, ring and opacity decisions', () => {
  test('spectator tag: solid to 200 m, off past it', () => {
    expect(SPECTATOR_TAG_MAX_DIST).toBe(200)
    expect(spectatorTagOpacity(100 * 100)).toBe(1)
    expect(spectatorTagOpacity(200 * 200)).toBe(1)
    expect(spectatorTagOpacity(201 * 201)).toBe(0)
  })

  test('ring appears once the tag needed 2× scaling', () => {
    expect(RING_MIN_SCALE).toBe(2)
    expect(ringVisible(1)).toBe(false)
    expect(ringVisible(1.5)).toBe(false)
    expect(ringVisible(2)).toBe(true)
    expect(ringVisible(12)).toBe(true)
  })

  test('depth test is off only for a spectator; draw order last only for a spectator', () => {
    expect(tagDepthTest(true)).toBe(false)
    expect(tagDepthTest(false)).toBe(true) // PvP fairness: in-game tags never X-ray
    expect(tagRenderOrder(true)).toBe(SPECTATOR_TAG_RENDER_ORDER)
    expect(tagRenderOrder(false)).toBe(0)
    expect(SPECTATOR_RING_RENDER_ORDER).toBeLessThan(SPECTATOR_TAG_RENDER_ORDER)
  })
})

describe('distance bands', () => {
  test('near < 12 m, mid < 60 m, far ≤ 200 m, beyond', () => {
    expect(BAND_NEAR_M).toBe(12)
    expect(BAND_MID_M).toBe(60)
    expect(distanceBand(0)).toBe('near')
    expect(distanceBand(11.9 * 11.9)).toBe('near')
    expect(distanceBand(12 * 12)).toBe('mid')
    expect(distanceBand(59 * 59)).toBe('mid')
    expect(distanceBand(60 * 60)).toBe('far')
    expect(distanceBand(200 * 200)).toBe('far')
    expect(distanceBand(200.5 * 200.5)).toBe('beyond')
  })

  test('body detail draws in near/mid only', () => {
    expect(bodyDetailVisible('near')).toBe(true)
    expect(bodyDetailVisible('mid')).toBe(true)
    expect(bodyDetailVisible('far')).toBe(false)
    expect(bodyDetailVisible('beyond')).toBe(false)
  })
})

describe('tagFontPx — shrink-to-fit at texture-build time', () => {
  test('a short name keeps the start size; a long one shrinks in steps to the floor', () => {
    const widthAt = (chars: number) => (px: number) => chars * px * 0.55
    expect(tagFontPx(widthAt(5), 470)).toBe(52)
    // 16 chars × 52 × 0.55 = 458 → fits at 52.
    expect(tagFontPx(widthAt(16), 470)).toBe(52)
    // 20 chars: 572 at 52, 528 at 48, 484 at 44, 440 at 40 → 40.
    expect(tagFontPx(widthAt(20), 470)).toBe(40)
    // Absurdly wide never goes under the floor.
    expect(tagFontPx(widthAt(200), 470)).toBe(24)
  })
})

describe('shared GPU objects (plain three, WebGPU-safe)', () => {
  test('ring geometry is one lazy singleton', () => {
    const a = ringGeometry()
    expect(a).toBe(ringGeometry())
    expect(a.type).toBe('RingGeometry')
  })

  test('ring material caches per tint and ignores depth', () => {
    const before = ringMaterialCount()
    const m1 = ringMaterialFor('#e8c229')
    const m2 = ringMaterialFor('#e8c229')
    const m3 = ringMaterialFor('#3ab0ff')
    expect(m1).toBe(m2)
    expect(m3).not.toBe(m1)
    expect(ringMaterialCount()).toBe(before + 2)
    expect(m1.depthTest).toBe(false)
    expect(m1.depthWrite).toBe(false)
    expect(m1.transparent).toBe(true)
    expect(m1.type).toBe('MeshBasicMaterial')
  })

  test('noopRaycast returns nothing and never throws', () => {
    expect(noopRaycast()).toBeUndefined()
  })
})
