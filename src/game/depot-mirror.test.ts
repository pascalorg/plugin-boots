import { describe, expect, test } from 'bun:test'
import { EYE_HEIGHT } from './collision'
import {
  MIRROR_FRAME,
  MIRROR_PANE_SIZE,
  MIRROR_PANE_X,
  MIRROR_PANE_Z,
  MIRROR_RANGE,
  MIRROR_SILL_Y,
  MIRROR_TARGET_SIZE,
  mirrorEngaged,
  wrapAngle,
} from './depot-mirror'
import { DEPOT_SIZE } from './guntable'

/**
 * THE DEPOT MIRROR's placement and gating. The optics — the reflected eye, the
 * off-axis frustum, the UV flip — are mirror-view.test.ts; this file pins the
 * one thing a real mirror still needs decided by hand: where it hangs.
 *
 * Everything is depot-local: +x toward the breaker end wall, +z out the
 * opening, the pane a plane of constant z whose normal points at the player.
 * The layout block pins the glass into the one clear panel of back wall (past
 * the gun rack, inside the far end wall) so that widening the rack one day
 * fails a test here instead of silently burying the mirror behind it.
 */

const [PANE_W, PANE_H] = MIRROR_PANE_SIZE
/** The deck plate you stand on tops out here (depot-local). */
const DECK_Y = 0.12
/** A Pascaline rig, sole to hat crown, in rig units (its origin is the ground). */
const RIG_HEIGHT = 1.875

describe('wrapAngle', () => {
  test('brings any heading into (-π, π]', () => {
    expect(wrapAngle(0)).toBe(0)
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle(1.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI, 12)
    for (const a of [-9, -4.2, -1, 0.3, 2, 6.5, 12]) {
      const w = wrapAngle(a)
      expect(w).toBeGreaterThan(-Math.PI - 1e-12)
      expect(w).toBeLessThanOrEqual(Math.PI + 1e-12)
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 12)
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 12)
    }
  })
})

describe('mirrorEngaged', () => {
  test('on in front of the glass, off across the lot', () => {
    expect(mirrorEngaged(MIRROR_PANE_X, MIRROR_PANE_Z + 1)).toBe(true)
    expect(mirrorEngaged(MIRROR_PANE_X, MIRROR_PANE_Z + MIRROR_RANGE - 0.01)).toBe(true)
    expect(mirrorEngaged(MIRROR_PANE_X, MIRROR_PANE_Z + MIRROR_RANGE + 0.01)).toBe(false)
    expect(mirrorEngaged(MIRROR_PANE_X + 40, MIRROR_PANE_Z + 1)).toBe(false)
  })

  test('off behind the back wall — out there the mirror is corrugated steel', () => {
    expect(mirrorEngaged(MIRROR_PANE_X, MIRROR_PANE_Z - 0.5)).toBe(false)
    expect(mirrorEngaged(MIRROR_PANE_X, MIRROR_PANE_Z)).toBe(false)
  })

  test('reach spans the container, so the whole depot floor is in front of it', () => {
    // Standing at the opening, at the mirror's end: still engaged.
    expect(mirrorEngaged(MIRROR_PANE_X, DEPOT_SIZE[2] / 2)).toBe(true)
    // And at the opening's far corner, by the breaker end.
    expect(mirrorEngaged(MIRROR_PANE_X + 2, DEPOT_SIZE[2] / 2)).toBe(true)
  })
})

describe('mirror placement', () => {
  test('flush to the back wall: a flat pane, a hand\'s width of nothing behind it', () => {
    // Back wall inner face is z = −1.15. The glass sits just proud of it, with
    // no cabinet depth: whatever is behind the plane is the wall, and the pass
    // clips it at the glass.
    expect(MIRROR_PANE_Z).toBeGreaterThan(-1.15)
    expect(MIRROR_PANE_Z - -1.15).toBeLessThan(0.05)
  })

  test('it lands in the one clear panel of back wall: past the rack, inside the end wall', () => {
    // Gun-rack rails span x ∈ [−1.65, 1.65]; the far end wall's inner face is
    // at −(DEPOT_SIZE[0]/2) + 0.05 = −2.9. Frame included.
    const left = MIRROR_PANE_X - PANE_W / 2 - MIRROR_FRAME
    const right = MIRROR_PANE_X + PANE_W / 2 + MIRROR_FRAME
    expect(left).toBeGreaterThan(-DEPOT_SIZE[0] / 2 + 0.05)
    expect(right).toBeLessThan(-1.65)
  })

  test('the glass and its frame clear the deck and the container roof', () => {
    expect(MIRROR_SILL_Y - MIRROR_FRAME).toBeGreaterThan(DECK_Y)
    expect(MIRROR_SILL_Y + PANE_H + MIRROR_FRAME + 0.3).toBeLessThan(DEPOT_SIZE[1])
  })

  test('FULL-LENGTH: standing a stride away you see your boots and your hat', () => {
    // Plane-mirror geometry: your eye at E sees a point at height y on your own
    // body at the glass height (E + y) / 2 — independent of how far you stand.
    // So boots-to-hat needs the glass to span from (E + deck)/2 to (E + hat)/2.
    const eye = DECK_Y + EYE_HEIGHT
    const boots = DECK_Y
    const hat = DECK_Y + RIG_HEIGHT
    expect(MIRROR_SILL_Y).toBeLessThan((eye + boots) / 2)
    expect(MIRROR_SILL_Y + PANE_H).toBeGreaterThan((eye + hat) / 2)
  })

  test('your own eyes land in the middle third of the glass', () => {
    // A mirror you check your face in should not put that face at the edge:
    // the eye line reflects at eye height, which should sit in the upper-middle
    // of the pane rather than at its rim.
    const eye = DECK_Y + EYE_HEIGHT
    const frac = (eye - MIRROR_SILL_Y) / PANE_H
    expect(frac).toBeGreaterThan(0.55)
    expect(frac).toBeLessThan(0.9)
  })

  test('the render target has the pane\'s aspect (square-ish texels, no stretch)', () => {
    const [tw, th] = MIRROR_TARGET_SIZE
    const targetAspect = tw / th
    const paneAspect = PANE_W / PANE_H
    expect(Math.abs(targetAspect / paneAspect - 1)).toBeLessThan(0.05)
    // Half-ish resolution: enough for a mirror, cheap enough to run every frame.
    expect(th).toBeGreaterThanOrEqual(512)
    expect(th).toBeLessThanOrEqual(1080)
  })
})
