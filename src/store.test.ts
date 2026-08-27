import { beforeEach, describe, expect, test } from 'bun:test'
import { FULL_MASK, useBoots } from './store'

/**
 * Store contract for build grammar v2 (docs/BUILD-GRAMMAR-V2-REVIEW.md,
 * agent 4): PlacedPiece carries an OPTIONAL grid slotId — legacy pieces
 * without one must keep flowing through every action untouched — and the
 * support-collapse path removes pieces BY ID from anywhere in the list
 * (removeLastPlaced only serves the undo key).
 */

beforeEach(() => {
  // placed[] is module-global state shared across test files — start clean.
  useBoots.getState().resolvePlaced()
})

describe('addPlaced: slotId passthrough + return value', () => {
  test('stores slotId when given and returns the stored piece', () => {
    const stored = useBoots
      .getState()
      .addPlaced({ piece: 'wall', position: [3, 0, 1.5], yaw: Math.PI / 2, slotId: 'Wx:1,0,0' })
    expect(stored.id).toBeGreaterThan(0)
    expect(stored.slotId).toBe('Wx:1,0,0')
    expect(stored.mask).toBe(FULL_MASK)
    // The returned object IS the stored one (id ↔ slotId wiring reads it).
    expect(useBoots.getState().placed.at(-1)).toBe(stored)
  })

  test('legacy add without slotId stays valid (render-only, off-graph)', () => {
    const stored = useBoots.getState().addPlaced({ piece: 'floor', position: [0, 0, 0], yaw: 0 })
    expect(stored.slotId).toBeUndefined()
    expect(useBoots.getState().placed.at(-1)).toBe(stored)
  })

  test('ids stay unique and increasing across mixed adds', () => {
    const a = useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    const b = useBoots
      .getState()
      .addPlaced({ piece: 'stairs', position: [1.5, 0, 1.5], yaw: 0, slotId: 'R:0,0,0' })
    expect(b.id).toBeGreaterThan(a.id)
  })
})

describe('removePlaced: by-id removal (support-collapse contract)', () => {
  test('removes from the middle, preserves order, returns the piece', () => {
    const a = useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0, slotId: 'Wz:0,0,0' })
    const b = useBoots.getState().addPlaced({ piece: 'wall', position: [3, 0, 0], yaw: 0, slotId: 'Wz:1,0,0' })
    const c = useBoots.getState().addPlaced({ piece: 'floor', position: [1.5, 2.8, 1.5], yaw: 0, slotId: 'F:0,0,1' })
    const removed = useBoots.getState().removePlaced(b.id)
    expect(removed).toBe(b)
    expect(useBoots.getState().placed).toEqual([a, c])
    // Survivors are the same objects — no gratuitous mesh/collider swaps.
    expect(useBoots.getState().placed[0]).toBe(a)
  })

  test('unknown id is a no-op returning undefined (double-collapse safe)', () => {
    const a = useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    useBoots.getState().removePlaced(a.id)
    expect(useBoots.getState().removePlaced(a.id)).toBeUndefined()
    expect(useBoots.getState().placed).toEqual([])
  })
})

describe('removeLastPlaced: unchanged undo semantics', () => {
  test('pops the newest piece; undefined when empty', () => {
    expect(useBoots.getState().removeLastPlaced()).toBeUndefined()
    const a = useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    const b = useBoots.getState().addPlaced({ piece: 'wall', position: [3, 0, 0], yaw: 0 })
    expect(useBoots.getState().removeLastPlaced()).toBe(b)
    expect(useBoots.getState().placed).toEqual([a])
  })
})

describe('slotId survives every piece-mutating action', () => {
  test('setPlacedMask keeps slotId on the swapped piece object', () => {
    const a = useBoots
      .getState()
      .addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0, slotId: 'Wz:0,0,0' })
    useBoots.getState().setPlacedMask(a.id, 0b000000111)
    const after = useBoots.getState().placed[0]!
    expect(after.mask).toBe(0b000000111)
    expect(after.slotId).toBe('Wz:0,0,0')
  })

  test('transformPlaced keeps slotId through the piece-type rebuild', () => {
    const a = useBoots
      .getState()
      .addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0, slotId: 'Wz:0,0,0' })
    useBoots.getState().transformPlaced(a.id, 'stairs', Math.PI / 2)
    const after = useBoots.getState().placed[0]!
    expect(after.piece).toBe('stairs')
    expect(after.mask).toBe(FULL_MASK)
    expect(after.slotId).toBe('Wz:0,0,0')
  })
})
