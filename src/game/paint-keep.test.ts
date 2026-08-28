import { describe, expect, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import {
  applyPaint,
  buildPaintPatches,
  dominantPaint,
  mintSceneMaterialId,
  type PaintedNode,
  usePaintKeep,
} from './paint-keep'

/** cell → packed (color << 8) | strength coat, from [cell, color,
 * strengthByte?] triples (full-strength 255 by default — the classic
 * "one color per cell" ledger read). */
const coats = (pairs: [number, number, number?][]) =>
  new Map<number, number>(pairs.map(([cell, color, s]) => [cell, (color << 8) | (s ?? 255)]))

describe('dominantPaint (the save-the-paint aggregator)', () => {
  test('per-cell majority wins', () => {
    expect(
      dominantPaint(
        coats([
          [0, 2],
          [1, 2],
          [2, 2],
          [3, 4],
        ]),
      ),
    ).toBe(2)
  })

  test('votes are strength-weighted — a heavy coat beats wide overspray', () => {
    // Two saturated sage cells (2 × 255) outweigh five faint navy
    // speckles (5 × 40): the deliberate coat wins the save.
    expect(
      dominantPaint(
        coats([
          [0, 2, 255],
          [1, 2, 255],
          [2, 4, 40],
          [3, 4, 40],
          [4, 4, 40],
          [5, 4, 40],
          [6, 4, 40],
        ]),
      ),
    ).toBe(2)
  })

  test('zero-strength cells never vote', () => {
    expect(dominantPaint(coats([[0, 3, 0]]))).toBeNull()
    expect(
      dominantPaint(
        coats([
          [0, 3, 0],
          [1, 5, 1],
        ]),
      ),
    ).toBe(5)
  })

  test('dead cells do not vote — dominance can flip', () => {
    const cells = coats([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 5],
      [4, 5],
    ])
    expect(dominantPaint(cells)).toBe(1)
    // Cells 0-2 shot out after painting: navy-side survivors take it.
    const alive = (cell: number) => cell >= 3
    expect(dominantPaint(cells, alive)).toBe(5)
  })

  test('ties break to the lower palette index (stable)', () => {
    expect(
      dominantPaint(
        coats([
          [0, 6],
          [1, 3],
        ]),
      ),
    ).toBe(3)
    // Same votes, reversed insertion order — same winner.
    expect(
      dominantPaint(
        coats([
          [0, 3],
          [1, 6],
        ]),
      ),
    ).toBe(3)
  })

  test('nothing voted → null (empty ledger or every cell dead)', () => {
    expect(dominantPaint(coats([]))).toBeNull()
    expect(dominantPaint(coats([[0, 1]]), () => false)).toBeNull()
  })

  test('later coats already overwrote earlier ones — the map is the truth', () => {
    // paint.tsx's ledger stores ONE packed coat per cell; a re-coated cell
    // votes only for its final color.
    const cells = coats([
      [0, 0],
      [1, 0],
    ])
    cells.set(0, (4 << 8) | 255)
    cells.set(1, (4 << 8) | 255)
    expect(dominantPaint(cells)).toBe(4)
  })
})

/** Painted-node record with the fields the planner reads. */
const coat = (nodeId: string, color: string, colorName = 'NAVY'): PaintedNode => ({
  nodeId,
  color,
  colorName,
  cells: 1,
})

describe('buildPaintPatches (the save planner)', () => {
  test('legacy-only node: inline material patch, nothing minted', () => {
    const nodes = {
      wall_a: { material: { preset: 'plaster', properties: { color: '#ffffff', roughness: 0.7 } } },
    }
    const { updates, minted } = buildPaintPatches(nodes, [coat('wall_a', '#3b4a63')])
    expect(minted).toEqual([])
    expect(updates).toEqual([
      {
        id: 'wall_a',
        data: {
          material: {
            preset: 'custom',
            // Existing fields survive — only the color moves.
            properties: { color: '#3b4a63', roughness: 0.7 },
          },
        },
      },
    ])
  })

  test('slot-modelled wall: interior/exterior refs re-point at ONE minted coat', () => {
    // The host renders `node.slots[side]` first — the legacy patch alone
    // would save "repainted" with no visible change (QA round-1 fix 1).
    const nodes = {
      wall_a: { slots: { interior: 'scene:mat_old', exterior: 'library:brick' } },
      wall_b: { slots: { interior: 'library:plaster', skirtingInterior: 'library:oak' } },
    }
    const { updates, minted } = buildPaintPatches(
      nodes,
      [coat('wall_a', '#3b4a63'), coat('wall_b', '#3b4a63')],
      () => 'mat_test0000000000',
    )
    expect(minted).toEqual([
      {
        id: 'mat_test0000000000',
        name: 'NAVY',
        material: { preset: 'custom', properties: { color: '#3b4a63' } },
      },
    ])
    expect(updates[0]!.data.slots).toEqual({
      interior: 'scene:mat_test0000000000',
      exterior: 'scene:mat_test0000000000',
    })
    // Non-surface slots (trims) stay untouched; only the painted sides move.
    expect(updates[1]!.data.slots).toEqual({
      interior: 'scene:mat_test0000000000',
      skirtingInterior: 'library:oak',
    })
  })

  test('distinct coats mint distinct materials; missing nodes are skipped', () => {
    let n = 0
    const nodes = {
      wall_a: { slots: { interior: 'scene:x' } },
      wall_b: { slots: { exterior: 'scene:y' } },
    }
    const { updates, minted } = buildPaintPatches(
      nodes,
      [coat('wall_a', '#3b4a63'), coat('wall_b', '#44464a', 'CHARCOAL'), coat('wall_gone', '#3b4a63')],
      () => `mat_${n++}`,
    )
    expect(updates.map((u) => u.id)).toEqual(['wall_a', 'wall_b'])
    expect(minted.map((m) => m.name)).toEqual(['NAVY', 'CHARCOAL'])
  })

  test('slot-less node never mints — the legacy inline patch is enough', () => {
    const { minted, updates } = buildPaintPatches({ wall_a: {} }, [coat('wall_a', '#9cab8b')])
    expect(minted).toEqual([])
    expect(updates[0]!.data.slots).toBeUndefined()
  })
})

describe('mintSceneMaterialId', () => {
  test('host scene-material id shape: mat_<16 lowercase alphanumerics>', () => {
    expect(mintSceneMaterialId()).toMatch(/^mat_[0-9a-z]{16}$/)
    expect(mintSceneMaterialId()).not.toBe(mintSceneMaterialId())
  })
})

describe('applyPaint against the REAL core store (minting path)', () => {
  test('one set lands minted materials + slot refs + legacy patch, then clears', () => {
    useScene.setState({
      nodes: {
        wall_p: {
          id: 'wall_p',
          type: 'wall',
          slots: { interior: 'scene:mat_before' },
          material: { preset: 'plaster', properties: { color: '#ffffff' } },
        },
      },
    } as never)
    usePaintKeep
      .getState()
      .setPainted([{ nodeId: 'wall_p', color: '#3b4a63', colorName: 'NAVY', cells: 9 }])

    expect(applyPaint()).toBe(1)

    const state = useScene.getState() as ReturnType<typeof useScene.getState> & {
      materials?: Record<string, { material: { properties: { color: string } } }>
    }
    const wall = state.nodes['wall_p' as keyof typeof state.nodes] as unknown as {
      slots: Record<string, string>
      material: { preset: string; properties: { color: string } }
    }
    const ref = wall.slots.interior!
    expect(ref).toMatch(/^scene:mat_[0-9a-z]{16}$/)
    expect(state.materials?.[ref.slice('scene:'.length)]?.material.properties.color).toBe('#3b4a63')
    expect(wall.material).toEqual({ preset: 'custom', properties: { color: '#3b4a63' } })
    expect(usePaintKeep.getState().painted).toEqual([])
  })
})
