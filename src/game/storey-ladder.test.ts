import { afterEach, describe, expect, test } from 'bun:test'
import {
  getStoreyLadder,
  isTerrainGrounded,
  parseSlotId,
  resetStoreyLadder,
  resolveTargetSlot,
  setStoreyLadder,
  slotPose,
  STOREY,
  storeyBase,
  storeyOfY,
  storeySpan,
} from './grid'

/**
 * ADAPTIVE STOREYS — the grid's session storey ladder (grid.ts). Real
 * buildings stack at the host default 2.5 m (and can vary per level), not
 * the fort-builder's uniform 2.8 STOREY; the ladder aligns storey s to the
 * building's real level bases. Everything here is pure module math:
 * storeyBase/storeySpan/storeyOfY, normalization (terrain prepend,
 * non-climbing entries), the fallback (no ladder → bit-exact 2.8
 * multiples), terrain grounding, and the resolveTargetSlot integration —
 * including the floor-piece y-plane DDA walking NON-uniform boundaries.
 */

const OPEN = { isOccupied: () => false, isSupported: () => true }

/** The canonical host building: two 2.5 m levels, top boundary 5, then the
 * derivation's sky rungs at 2.8 multiples. */
const HOST_LADDER = [0, 2.5, 5, 7.8, 10.6, 13.4]

afterEach(() => {
  resetStoreyLadder()
})

describe('fallback (no ladder): pure 2.8 multiples, bit-exact legacy', () => {
  test('storeyBase / storeySpan / storeyOfY', () => {
    expect(getStoreyLadder()).toBeNull()
    expect(storeyBase(0)).toBe(0)
    expect(storeyBase(2)).toBe(2 * STOREY)
    expect(storeySpan(0)).toBe(STOREY)
    expect(storeySpan(7)).toBe(STOREY)
    // The legacy +0.1 feet grace: exactly ON a floor plane belongs to it.
    expect(storeyOfY(0)).toBe(0)
    expect(storeyOfY(STOREY)).toBe(1)
    expect(storeyOfY(STOREY - 0.05)).toBe(1)
    expect(storeyOfY(STOREY - 0.2)).toBe(0)
    expect(storeyOfY(-1)).toBe(-1) // callers clamp, exactly like legacy
  })

  test('a too-short or null ladder resets to the fallback', () => {
    setStoreyLadder([1.7])
    expect(getStoreyLadder()).toBeNull()
    setStoreyLadder(HOST_LADDER)
    expect(getStoreyLadder()).not.toBeNull()
    setStoreyLadder(null)
    expect(getStoreyLadder()).toBeNull()
    expect(storeyBase(1)).toBe(STOREY)
  })
})

describe('ladder installed: storeys follow the building', () => {
  test('bases and spans read the rungs; outside the ladder extends by 2.8', () => {
    setStoreyLadder(HOST_LADDER)
    expect(storeyBase(0)).toBe(0)
    expect(storeyBase(1)).toBe(2.5)
    expect(storeyBase(2)).toBe(5)
    expect(storeySpan(0)).toBe(2.5)
    expect(storeySpan(1)).toBe(2.5)
    expect(storeySpan(2)).toBeCloseTo(STOREY, 10) // first sky rung
    // Above the top rung: pure STOREY multiples keep every helper total.
    expect(storeyBase(5)).toBeCloseTo(13.4, 10)
    expect(storeyBase(7)).toBeCloseTo(13.4 + 2 * STOREY, 10)
    expect(storeySpan(9)).toBeCloseTo(STOREY, 10)
  })

  test('storeyOfY scans the rungs, extends past both ends, keeps the grace', () => {
    setStoreyLadder(HOST_LADDER)
    expect(storeyOfY(0)).toBe(0)
    expect(storeyOfY(1.9)).toBe(0)
    expect(storeyOfY(2.5)).toBe(1) // feet exactly ON the second floor
    expect(storeyOfY(2.45)).toBe(1) // the +0.1 grace
    expect(storeyOfY(2.3)).toBe(0)
    expect(storeyOfY(4.9)).toBe(2)
    expect(storeyOfY(13.4 + STOREY + 0.5)).toBe(6) // above the sky rungs
    expect(storeyOfY(-3)).toBe(-2) // below the ladder — callers clamp
  })

  test('normalization: non-finite and non-climbing entries drop', () => {
    setStoreyLadder([0, Number.NaN, 2.5, 2.5, 2.49, 5])
    expect(getStoreyLadder()).toEqual([0, 2.5, 5])
  })

  test('elevated building: the terrain storey [0, base] is prepended', () => {
    setStoreyLadder([1.2, 3.7, 6.2])
    expect(getStoreyLadder()).toEqual([0, 1.2, 3.7, 6.2])
    expect(storeyBase(0)).toBe(0)
    expect(storeySpan(0)).toBe(1.2) // the crawl band up to the real level
    expect(storeyBase(1)).toBe(1.2)
    expect(storeySpan(1)).toBe(2.5)
    // A base within ~5 cm of the terrain plane does NOT prepend.
    setStoreyLadder([0.03, 2.53])
    expect(getStoreyLadder()).toEqual([0.03, 2.53])
  })

  test('sunk building: a slightly buried bottom rung snaps to the terrain plane', () => {
    // Without the snap NO storey base sat on the terrain (|base| ≤ 5 cm),
    // so piece-slots could never root the support graph on open ground —
    // ground placement was refused building-wide.
    setStoreyLadder([-0.3, 2.2, 4.7])
    expect(getStoreyLadder()).toEqual([0, 2.2, 4.7])
    expect(isTerrainGrounded('Wz:0,0,0')).toBe(true)
    expect(storeySpan(0)).toBeCloseTo(2.2, 10)
  })

  test('low first level: the bottom rung becomes the terrain rung, no degenerate sliver', () => {
    // Prepending 0 under a 0.4 m base minted a 0.4 m storey — shorter than
    // the MIN_STOREY_SPAN merge deriveStoreyLadder applies to real levels.
    setStoreyLadder([0.4, 2.9, 5.4])
    expect(getStoreyLadder()).toEqual([0, 2.9, 5.4])
    expect(isTerrainGrounded('Wz:0,0,0')).toBe(true)
    expect(storeySpan(0)).toBeCloseTo(2.9, 10)
  })

  test('basement ladder keeps its own ground rung untouched', () => {
    setStoreyLadder([-2.5, 0, 2.8])
    expect(getStoreyLadder()).toEqual([-2.5, 0, 2.8])
    expect(isTerrainGrounded('Wz:0,0,0')).toBe(false) // base −2.5 — the basement
    expect(isTerrainGrounded('Wz:0,0,1')).toBe(true) // base 0 — the ground level
  })
})

describe('terrain grounding under a ladder', () => {
  test('the storey whose base sits ON the terrain plane self-grounds', () => {
    setStoreyLadder(HOST_LADDER)
    expect(isTerrainGrounded('Wz:4,-2,0')).toBe(true)
    expect(isTerrainGrounded('R:10,11,0')).toBe(true)
    expect(isTerrainGrounded('F:0,0,1')).toBe(false)
  })

  test('elevated building: only the prepended terrain storey grounds', () => {
    setStoreyLadder([1.2, 3.7, 6.2])
    expect(isTerrainGrounded('Wz:0,0,0')).toBe(true) // base 0 — the ground
    expect(isTerrainGrounded('Wz:0,0,1')).toBe(false) // base 1.2 — the level
  })
})

describe('resolveTargetSlot over a non-uniform ladder', () => {
  test('slot poses land on the rungs (walls, floors, R slots)', () => {
    setStoreyLadder(HOST_LADDER)
    expect(slotPose({ kind: 'Wx', i: 2, k: 1, s: 1 }).position).toEqual([6, 2.5, 4.5])
    expect(slotPose({ kind: 'F', i: 0, k: 0, s: 2 }).position).toEqual([1.5, 5, 1.5])
    expect(slotPose({ kind: 'R', i: 0, k: 0, s: 3 }).position[1]).toBeCloseTo(7.8, 10)
  })

  test('pitch up targets the storey above AT its real base', () => {
    setStoreyLadder(HOST_LADDER)
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0.8, piece: 'wall', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:1,0,1')
    expect(result.pose.position[1]).toBe(2.5)
  })

  test('ceiling flow: the floor DDA walks the LADDER boundaries, not 2.8 planes', () => {
    setStoreyLadder(HOST_LADDER)
    const steep = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: Math.PI, pitch: 1.2, piece: 'floor', rotState: 0 },
      OPEN,
    )
    expect(steep.slotId).toBe('F:0,0,1')
    expect(steep.pose.position[1]).toBe(2.5) // the real second floor
    // From the real second floor, looking down builds under your feet.
    const under = resolveTargetSlot(
      { position: [1.5, 2.5, 1.5], yaw: Math.PI, pitch: -0.9, piece: 'floor', rotState: 0 },
      OPEN,
    )
    expect(under.slotId).toBe('F:0,0,1')
  })

  test('player standing on the 2.5 m second floor targets storey-1 slots', () => {
    setStoreyLadder(HOST_LADDER)
    const result = resolveTargetSlot(
      { position: [1.5, 2.5, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:1,0,1')
    expect(result.pose.position[1]).toBe(2.5)
  })

  test('stairs march bumps by LADDER storeys past the pitch band', () => {
    setStoreyLadder(HOST_LADDER)
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0.62, piece: 'stairs', rotState: 0 },
      OPEN,
    )
    const slot = parseSlotId(result.slotId)!
    expect(slot.kind).toBe('R')
    expect(slot.s).toBe(1)
    expect(result.pose.position[1]).toBe(2.5)
  })

  test('reset restores the uniform grid mid-suite', () => {
    setStoreyLadder(HOST_LADDER)
    resetStoreyLadder()
    expect(slotPose({ kind: 'Wx', i: 2, k: 1, s: 1 }).position).toEqual([6, STOREY, 4.5])
  })
})
