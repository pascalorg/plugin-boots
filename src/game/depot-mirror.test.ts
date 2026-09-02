import { describe, expect, test } from 'bun:test'
import {
  MIRROR_DEPTH,
  MIRROR_DUMMY_SCALE,
  MIRROR_LATERAL_MAX,
  MIRROR_MAX_STANDOFF,
  MIRROR_MIN_STANDOFF,
  MIRROR_PANE_SIZE,
  MIRROR_PANE_X,
  MIRROR_PANE_Z,
  MIRROR_PLINTH_TOP,
  MIRROR_RANGE,
  MIRROR_SILL_Y,
  mirrorEngaged,
  reflectStand,
  reflectYaw,
  wrapAngle,
} from './depot-mirror'
import { EYE_HEIGHT } from './collision'
import { DEPOT_SIZE } from './guntable'

/**
 * THE DEPOT MIRROR's math. Everything here is depot-local: +x toward the
 * breaker end wall, +z out the opening, and the pane is a plane of constant z
 * whose normal points out at the player.
 *
 * Two things have to be true for a mirror to read as one rather than as a
 * mannequin in a box, and both are pure:
 *
 * 1. THE HEADING IS A REAL REFLECTION. Turn toward the glass and it turns back
 *    at you; walk along the wall and it keeps its bearing; turn left and it
 *    turns right. That is the whole illusion, and it is the one part this file
 *    does NOT compress.
 * 2. THE REFLECTION IS ALWAYS IN ITS FRAME. The cabinet is 0.5 m deep, so a
 *    true reflection would stand behind a steel wall. Depth and lateral offset
 *    are clamped instead — and clamped means clamped: from ANY standing spot in
 *    the container, the dummy is inside the box, which is what keeps it from
 *    ever clipping through the glass or vanishing sideways.
 *
 * The layout block at the end pins the cabinet into the one clear panel of back
 * wall (past the gun rack, inside the far end wall) so that widening the rack
 * one day fails a test here instead of silently burying the mirror behind it.
 */

/** Where a Pascaline's forward points at depot-local yaw φ (the rig faces -Z). */
function facing(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)]
}

const [PANE_W, PANE_H] = MIRROR_PANE_SIZE

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
      // Same direction, canonical angle.
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 12)
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 12)
    }
  })
})

describe('reflectYaw', () => {
  test('look at the glass and the reflection looks back', () => {
    // Facing the back wall (the pane's side) is local yaw 0: forward = (0, -1).
    expect(facing(0)[1]).toBeCloseTo(-1, 12)
    const mirrored = reflectYaw(0)
    const [fx, fz] = facing(mirrored)
    expect(fx).toBeCloseTo(0, 12)
    // ...and the reflection faces back OUT of the cabinet, at the player.
    expect(fz).toBeCloseTo(1, 12)
  })

  test('walking along the wall keeps the bearing (a z-plane mirror only flips depth)', () => {
    // Facing +x (down the container toward the breaker end) is yaw -π/2.
    const alongWall = -Math.PI / 2
    expect(facing(alongWall)[0]).toBeCloseTo(1, 12)
    expect(reflectYaw(alongWall)).toBeCloseTo(alongWall, 12)
    expect(reflectYaw(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })

  test('the depth component flips and the lateral one survives, at every angle', () => {
    for (const yaw of [-3, -2.1, -1.2, -0.4, 0, 0.7, 1.9, 2.8, 3.1]) {
      const [fx, fz] = facing(yaw)
      const [mx, mz] = facing(reflectYaw(yaw))
      expect(mx).toBeCloseTo(fx, 12)
      expect(mz).toBeCloseTo(-fz, 12)
    }
  })

  test('turn left and it turns right (a mirror image, not a copy)', () => {
    // A small left turn from facing the glass: the reflection swings the other
    // way, which is exactly what makes it read as your reflection.
    const turned = reflectYaw(0.3)
    expect(wrapAngle(turned - reflectYaw(0))).toBeCloseTo(-0.3, 12)
  })

  test('reflecting twice is the identity', () => {
    for (const yaw of [-2.5, -0.8, 0, 1.1, 2.9]) {
      expect(reflectYaw(reflectYaw(yaw))).toBeCloseTo(wrapAngle(yaw), 12)
    }
  })
})

describe('reflectStand', () => {
  test('step back and the reflection backs off — until the cabinet runs out', () => {
    const near = reflectStand(MIRROR_PANE_X, MIRROR_PANE_Z + 0.2)
    const far = reflectStand(MIRROR_PANE_X, MIRROR_PANE_Z + 3)
    // Deeper into the cabinet is MORE negative z (the pane's normal is +z).
    expect(near[1]).toBeGreaterThan(far[1])
    // The far one is pinned at the back of the box, not somewhere behind it.
    expect(far[1]).toBeCloseTo(MIRROR_PANE_Z - MIRROR_MAX_STANDOFF, 12)
  })

  test('nose to the glass never pushes a face through it', () => {
    const [, z] = reflectStand(MIRROR_PANE_X, MIRROR_PANE_Z + 0.001)
    expect(z).toBeCloseTo(MIRROR_PANE_Z - MIRROR_MIN_STANDOFF, 12)
    expect(z).toBeLessThan(MIRROR_PANE_Z)
  })

  test('stepping aside slides the reflection a little, and never out of frame', () => {
    const centered = reflectStand(MIRROR_PANE_X, MIRROR_PANE_Z + 1)
    const aside = reflectStand(MIRROR_PANE_X + 0.4, MIRROR_PANE_Z + 1)
    // It MUST move (a fixed dummy reads as a poster)...
    expect(aside[0]).toBeGreaterThan(centered[0])
    // ...but by less than you moved (geared-down parallax).
    expect(aside[0] - centered[0]).toBeLessThan(0.4)
    // ...and a long way off-center is capped, not tracked out of the pane.
    const wayOff = reflectStand(MIRROR_PANE_X + 3, MIRROR_PANE_Z + 1)
    expect(wayOff[0] - MIRROR_PANE_X).toBeCloseTo(MIRROR_LATERAL_MAX, 12)
    const wayOffOther = reflectStand(MIRROR_PANE_X - 3, MIRROR_PANE_Z + 1)
    expect(wayOffOther[0] - MIRROR_PANE_X).toBeCloseTo(-MIRROR_LATERAL_MAX, 12)
  })

  test('from ANY spot in the container the reflection is inside the cabinet', () => {
    // Sweep the whole interior deck (and past the opening, for someone standing
    // outside looking in): the dummy's center must stay within the pane's
    // half-width and between the glass and the back panel.
    const halfX = DEPOT_SIZE[0] / 2
    const halfZ = DEPOT_SIZE[2] / 2
    for (let lx = -halfX; lx <= halfX; lx += 0.25) {
      for (let lz = MIRROR_PANE_Z + 0.01; lz <= halfZ + 3; lz += 0.25) {
        const [dx, dz] = reflectStand(lx, lz)
        expect(Math.abs(dx - MIRROR_PANE_X)).toBeLessThanOrEqual(PANE_W / 2)
        expect(dz).toBeLessThan(MIRROR_PANE_Z)
        expect(dz).toBeGreaterThan(MIRROR_PANE_Z - MIRROR_DEPTH)
      }
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
  })
})

describe('cabinet placement', () => {
  const jamb = 0.06

  test('it lands in the one clear panel of back wall: past the rack, inside the end wall', () => {
    // Gun-rack rails span x ∈ [-1.65, 1.65]; the far end wall's inner face is
    // at -(DEPOT_SIZE[0]/2) + 0.05 = -2.9.
    const left = MIRROR_PANE_X - PANE_W / 2 - jamb
    const right = MIRROR_PANE_X + PANE_W / 2 + jamb
    expect(left).toBeGreaterThan(-DEPOT_SIZE[0] / 2 + 0.05)
    expect(right).toBeLessThan(-1.65)
  })

  test('it never pokes through the back wall or into the walkway', () => {
    // The back wall's inner face is at z = -1.15; the cabinet recedes to
    // exactly that and no further, and its glass stays in the back half of the
    // deck, clear of the bench and the doorway line.
    expect(MIRROR_PANE_Z - MIRROR_DEPTH).toBeGreaterThanOrEqual(-1.15 - 1e-12)
    expect(MIRROR_PANE_Z).toBeLessThan(0)
  })

  test('the whole dummy is visible through the opening', () => {
    // A Pascaline rig stands ~1.85 m from sole to hat, and her origin sits at
    // the ground (a peer's root is planted, not at their feet).
    const RIG_HEIGHT = 1.85
    const head = MIRROR_PLINTH_TOP + RIG_HEIGHT * MIRROR_DUMMY_SCALE
    expect(MIRROR_PLINTH_TOP).toBeGreaterThan(MIRROR_SILL_Y) // boots in frame
    expect(head).toBeLessThan(MIRROR_SILL_Y + PANE_H) // hat in frame
  })

  test('the pane clears the container roof', () => {
    expect(MIRROR_SILL_Y + PANE_H).toBeLessThan(DEPOT_SIZE[1] - 0.2)
  })

  test('the reflection lands on your eye line, not down by your boots', () => {
    // The deck plate you stand on tops out at 0.12 depot-local and your eyes
    // are EYE_HEIGHT above that. What anyone wants out of a mirror is the face
    // and the vest, so the dummy's chest has to sit near that line — the first
    // cut hung the sill 16 cm off the deck and QA photographed a cabinet you
    // had to look 30° DOWN into to find yourself in.
    const DECK_Y = 0.12
    const eye = DECK_Y + EYE_HEIGHT
    // Rig proportions: a Pascaline's chest reads ~1.35 m up her 1.85 m.
    const chest = MIRROR_PLINTH_TOP + 1.35 * MIRROR_DUMMY_SCALE
    expect(Math.abs(chest - eye)).toBeLessThan(0.3)
    // And the opening itself is in front of your face, not around your knees.
    expect(MIRROR_SILL_Y + PANE_H / 2).toBeGreaterThan(eye - 0.6)
  })
})
