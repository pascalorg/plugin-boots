import { describe, expect, test } from 'bun:test'
import { buildShellData, type ShellData, type ShellGrid, type ShellSourceTri } from './shell'
import {
  aliveFragmentCount,
  drainShellRemovals,
  killFragmentIndices,
  type ShellRemovalBatch,
} from './shell-render'

/** Minimal ShellData for the pure bookkeeping tests — only fragmentForCell
 * and fragments matter to drainShellRemovals. */
const fakeShell = (
  fragmentForCell: number[],
  fragments: { indexStart: number; indexCount: number }[],
): ShellData => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  index: new Uint32Array(0),
  groups: [],
  fragments,
  fragmentForCell: Int32Array.from(fragmentForCell),
  cellsOfFragment: [],
})

describe('killFragmentIndices', () => {
  test('degenerates exactly the block and returns the touched range', () => {
    const index = Uint32Array.from({ length: 18 }, (_, i) => i)
    const pristine = Uint32Array.from(index)
    const range = killFragmentIndices(index, { indexStart: 6, indexCount: 6 })
    expect(range).toEqual({ start: 6, count: 6 })
    // The whole block repeats the block's first vertex …
    for (let i = 6; i < 12; i++) expect(index[i]).toBe(pristine[6]!)
    // … so every triangle inside it is degenerate (three equal indices).
    expect(index[6]).toBe(index[7]!)
    expect(index[7]).toBe(index[8]!)
    expect(index[9]).toBe(index[10]!)
    expect(index[10]).toBe(index[11]!)
    // Neighbors byte-identical on both sides.
    expect([...index.slice(0, 6)]).toEqual([...pristine.slice(0, 6)])
    expect([...index.slice(12)]).toEqual([...pristine.slice(12)])
  })

  test('zero-length fragment is a no-op', () => {
    const index = Uint32Array.from([0, 1, 2])
    const range = killFragmentIndices(index, { indexStart: 1, indexCount: 0 })
    expect(range).toEqual({ start: 1, count: 0 })
    expect([...index]).toEqual([0, 1, 2])
  })
})

describe('drainShellRemovals', () => {
  const fragments = [
    { indexStart: 0, indexCount: 6 },
    { indexStart: 6, indexCount: 3 },
    { indexStart: 9, indexCount: 9 },
  ]

  test('a fragment dies when ANY of its cells dies', () => {
    // Fragment 0 spans cells 0+1 (a multi-cell chip).
    const shell = fakeShell([0, 0, 1, -1, 2], fragments)
    const killed = new Uint8Array(3)
    const batch = drainShellRemovals(shell, [1], killed)
    expect(batch.fragments).toEqual([0])
    expect([...killed]).toEqual([1, 0, 0])
  })

  test('dedupes within one drain and across drains', () => {
    const shell = fakeShell([0, 0, 1, -1, 2], fragments)
    const killed = new Uint8Array(3)
    // Cells 0 and 1 both map to fragment 0 — one death, not two.
    const first = drainShellRemovals(shell, [0, 1, 0], killed)
    expect(first.fragments).toEqual([0])
    // Re-reading the same (non-cleared) queue later is free.
    const second = drainShellRemovals(shell, [0, 1, 0], killed)
    expect(second.fragments).toEqual([])
  })

  test('skips surface-less cells and returns each new fragment once', () => {
    const shell = fakeShell([0, 0, 1, -1, 2], fragments)
    const killed = new Uint8Array(3)
    expect(drainShellRemovals(shell, [3], killed).fragments).toEqual([])
    expect([...killed]).toEqual([0, 0, 0])
    const batch = drainShellRemovals(shell, [4, 2, 0], killed)
    expect(batch.fragments).toEqual([2, 1, 0])
    expect([...killed]).toEqual([1, 1, 1])
  })

  test('reuses a caller-provided batch (lengths reset)', () => {
    const shell = fakeShell([0, 0, 1, -1, 2], fragments)
    const killed = new Uint8Array(3)
    const out: ShellRemovalBatch = { fragments: [7, 7, 7] }
    const batch = drainShellRemovals(shell, [2], killed, out)
    expect(batch).toBe(out)
    expect(out.fragments).toEqual([1])
  })
})

describe('aliveFragmentCount', () => {
  test('counts unkilled fragments', () => {
    expect(aliveFragmentCount(new Uint8Array(0))).toBe(0)
    expect(aliveFragmentCount(Uint8Array.from([0, 0, 0]))).toBe(3)
    expect(aliveFragmentCount(Uint8Array.from([0, 1, 0]))).toBe(2)
    expect(aliveFragmentCount(Uint8Array.from([1, 1]))).toBe(0)
  })
})

describe('end-to-end on a real buildShellData shell', () => {
  const grid: ShellGrid = { nx: 2, ny: 1, nz: 1, cellX: 1, cellY: 1, cellZ: 1, count: 2 }
  const FLAT_Z = [0, 0, 1, 0, 0, 1, 0, 0, 1]
  // Three synthetic tris, none crossing a lattice plane: one in cell 0
  // (material 0), two in cell 1 (material 1) — the differing domains pin
  // the clustering to exactly two fragments for ANY seed.
  const tris: ShellSourceTri[] = [
    {
      positions: [0.1, 0.1, 0.5, 0.9, 0.1, 0.5, 0.9, 0.9, 0.5],
      normals: FLAT_Z,
      uvs: [0, 0, 1, 0, 1, 1],
      materialIndex: 0,
    },
    {
      positions: [1.1, 0.1, 0.5, 1.9, 0.1, 0.5, 1.9, 0.9, 0.5],
      normals: FLAT_Z,
      uvs: [0, 0, 1, 0, 1, 1],
      materialIndex: 1,
    },
    {
      positions: [1.1, 0.1, 0.5, 1.9, 0.9, 0.5, 1.1, 0.9, 0.5],
      normals: FLAT_Z,
      uvs: [0, 0, 1, 1, 0, 1],
      materialIndex: 1,
    },
  ]

  test('killing one cell degenerates its fragment block, leaves the rest intact', () => {
    const shell = buildShellData(tris, grid, 7)
    expect(shell).not.toBeNull()
    const { fragments, fragmentForCell, index } = shell!
    expect(fragments.length).toBe(2)
    const fragA = fragmentForCell[0]!
    const fragB = fragmentForCell[1]!
    expect(fragA).toBeGreaterThanOrEqual(0)
    expect(fragB).toBeGreaterThanOrEqual(0)
    expect(fragA).not.toBe(fragB)
    expect(fragments[fragA]!.indexCount).toBe(3)
    expect(fragments[fragB]!.indexCount).toBe(6)

    // The component's setup: carve a live COPY, keep shell.index pristine.
    const live = new Uint32Array(index)
    const killed = new Uint8Array(fragments.length)
    const batch = drainShellRemovals(shell!, [1], killed)
    expect(batch.fragments).toEqual([fragB])
    const range = killFragmentIndices(live, fragments[fragB]!)
    expect(range).toEqual({ start: fragments[fragB]!.indexStart, count: 6 })

    // Killed block: all six entries repeat the block's first vertex.
    const anchor = index[range.start]!
    for (let i = range.start; i < range.start + range.count; i++) {
      expect(live[i]).toBe(anchor)
    }
    // The other fragment's block is byte-identical to the pristine index.
    const a = fragments[fragA]!
    for (let i = a.indexStart; i < a.indexStart + a.indexCount; i++) {
      expect(live[i]).toBe(index[i]!)
    }
    // And shell.index itself never moved (pack contract: index[i] === i).
    for (let i = 0; i < index.length; i++) expect(index[i]).toBe(i)

    expect(aliveFragmentCount(killed)).toBe(1)
    // Kill the last cell: the shell is fully gone.
    drainShellRemovals(shell!, [0], killed)
    expect(aliveFragmentCount(killed)).toBe(0)
  })
})
