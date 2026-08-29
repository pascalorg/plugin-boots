import { describe, expect, test } from 'bun:test'
import {
  buildShellData,
  cellOfTriangle,
  clipTriangleByPlanes,
  clusterCells,
  mulberry32,
  SHELL_TRI_CAP,
  type ShellGrid,
  type ShellSourceTri,
  triangleArea,
} from './shell'

const cube = (nx: number, ny: number, nz: number, cell = 1): ShellGrid => ({
  nx,
  ny,
  nz,
  cellX: cell,
  cellY: cell,
  cellZ: cell,
  count: nx * ny * nz,
})

const FLAT_Z = [0, 0, 1, 0, 0, 1, 0, 0, 1]

/** Two-triangle quad in the z=depth plane, CCW winding (+z face normal). */
const quadTris = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  materialIndex: number,
): ShellSourceTri[] => [
  {
    positions: [x0, y0, z, x1, y0, z, x1, y1, z],
    normals: FLAT_Z,
    uvs: [0, 0, 1, 0, 1, 1],
    materialIndex,
  },
  {
    positions: [x0, y0, z, x1, y1, z, x0, y1, z],
    normals: FLAT_Z,
    uvs: [0, 0, 1, 1, 0, 1],
    materialIndex,
  },
]

describe('mulberry32', () => {
  test('deterministic per seed, uniform range', () => {
    const a = mulberry32(1337)
    const b = mulberry32(1337)
    for (let i = 0; i < 100; i++) {
      const r = a()
      expect(b()).toBe(r)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
    expect(mulberry32(7)()).not.toBe(mulberry32(8)())
  })
})

describe('clipTriangleByPlanes', () => {
  test('quad spanning 3 cells clips into area-conserving pieces', () => {
    const tris = quadTris(0.2, 0.2, 2.8, 0.8, 0.5, 0)
    let total = 0
    let count = 0
    for (const tri of tris) {
      for (const piece of clipTriangleByPlanes(tri.positions, tri.normals, tri.uvs, 1, 1, 1)) {
        total += triangleArea(piece.positions)
        count++
      }
    }
    expect(count).toBeGreaterThan(2) // the x=1 and x=2 planes actually split
    expect(Math.abs(total - 2.6 * 0.6)).toBeLessThan(1e-6)
  })

  test('every output triangle lies inside its centroid cell', () => {
    const grid = cube(4, 2, 1)
    const positions = [0.1, 0.1, 0.3, 3.7, 0.5, 0.3, 1.2, 1.9, 0.3]
    const pieces = clipTriangleByPlanes(positions, FLAT_Z, [0, 0, 1, 0, 0.5, 1], 1, 1, 1)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      const cell = cellOfTriangle(piece.positions, grid)
      const ix = cell % 4
      const iy = Math.floor(cell / 4) % 2
      const iz = Math.floor(cell / 8)
      expect(iz).toBe(0)
      for (let v = 0; v < 3; v++) {
        const x = piece.positions[v * 3]!
        const y = piece.positions[v * 3 + 1]!
        const z = piece.positions[v * 3 + 2]!
        expect(x).toBeGreaterThanOrEqual(ix - 1e-8)
        expect(x).toBeLessThanOrEqual(ix + 1 + 1e-8)
        expect(y).toBeGreaterThanOrEqual(iy - 1e-8)
        expect(y).toBeLessThanOrEqual(iy + 1 + 1e-8)
        expect(z).toBeGreaterThanOrEqual(-1e-8)
        expect(z).toBeLessThanOrEqual(1 + 1e-8)
      }
    }
  })

  test('outer-boundary skin faces land in the outermost cell (1 mm nudge)', () => {
    const grid = cube(2, 1, 1)
    // Face ON x=2 (upper lattice boundary), winding gives +x face normal:
    // nudged centroid at x=1.999 → cell ix=1, the outermost.
    const outer = [2, 0.2, 0.2, 2, 0.8, 0.2, 2, 0.5, 0.8]
    expect(cellOfTriangle(outer, grid)).toBe(1)
    // Face ON x=0 with −x face normal: nudged to x=0.001 → cell ix=0.
    const inner = [0, 0.8, 0.2, 0, 0.2, 0.2, 0, 0.5, 0.8]
    expect(cellOfTriangle(inner, grid)).toBe(0)
  })

  test('uv interpolation at the x=1.5 cut is analytically exact', () => {
    // Linear uv field over the triangle: u = x/3, v = y/2.
    const positions = [0, 0, 0, 3, 0, 0, 0, 2, 0]
    const uvs = [0, 0, 1, 0, 0, 1]
    const pieces = clipTriangleByPlanes(positions, FLAT_Z, uvs, 1.5, 1.5, 1.5)
    expect(pieces.length).toBeGreaterThan(1)
    let cutVerts = 0
    for (const piece of pieces) {
      for (let v = 0; v < 3; v++) {
        const x = piece.positions[v * 3]!
        const y = piece.positions[v * 3 + 1]!
        expect(Math.abs(piece.uvs[v * 2]! - x / 3)).toBeLessThan(1e-12)
        expect(Math.abs(piece.uvs[v * 2 + 1]! - y / 2)).toBeLessThan(1e-12)
        if (x === 1.5) {
          cutVerts++
          expect(piece.uvs[v * 2]!).toBe(0.5)
        }
      }
    }
    expect(cutVerts).toBeGreaterThan(0) // the cut vertices exist, pinned to the plane
  })
})

describe('clusterCells', () => {
  const N = 6
  const cells = Array.from({ length: N * N }, (_, i) => i)
  const adjacency = (cell: number): number[] => {
    const x = cell % N
    const y = Math.floor(cell / N)
    const out: number[] = []
    if (x > 0) out.push(cell - 1)
    if (x < N - 1) out.push(cell + 1)
    if (y > 0) out.push(cell - N)
    if (y < N - 1) out.push(cell + N)
    return out
  }
  /** Left half domain 0, right half domain 1. */
  const domainOf = (cell: number) => (cell % N < 3 ? 0 : 1)

  test('same seed → identical map; different seed → different', () => {
    const a = clusterCells(cells, adjacency, domainOf, mulberry32(1234))
    const b = clusterCells(cells, adjacency, domainOf, mulberry32(1234))
    expect(Array.from(b)).toEqual(Array.from(a))
    const c = clusterCells(cells, adjacency, domainOf, mulberry32(99))
    expect(Array.from(c)).not.toEqual(Array.from(a))
  })

  test('every cell assigned, sizes within 1..6, domains never mix', () => {
    const map = clusterCells(cells, adjacency, domainOf, mulberry32(7))
    const byFragment = new Map<number, number[]>()
    for (const cell of cells) {
      const fragment = map[cell]!
      expect(fragment).toBeGreaterThanOrEqual(0)
      let members = byFragment.get(fragment)
      if (!members) byFragment.set(fragment, (members = []))
      members.push(cell)
    }
    for (const members of byFragment.values()) {
      expect(members.length).toBeGreaterThanOrEqual(1)
      expect(members.length).toBeLessThanOrEqual(6)
      expect(new Set(members.map(domainOf)).size).toBe(1)
    }
  })
})

describe('buildShellData', () => {
  test('fragmentForCell covers every surface cell and mirrors cellsOfFragment', () => {
    const grid = cube(4, 2, 1)
    const data = buildShellData(quadTris(0, 0, 4, 2, 0.5, 0), grid, 42)
    expect(data).not.toBeNull()
    const { fragmentForCell, cellsOfFragment } = data!
    expect(fragmentForCell.length).toBe(grid.count)
    const seen = new Set<number>()
    cellsOfFragment.forEach((fragmentCells, fragment) => {
      expect(fragmentCells.length).toBeGreaterThanOrEqual(1)
      for (const cell of fragmentCells) {
        expect(seen.has(cell)).toBe(false)
        seen.add(cell)
        expect(fragmentForCell[cell]!).toBe(fragment)
      }
    })
    // The full-quad skin touches all 8 cells — every cell is surface here.
    for (let cell = 0; cell < grid.count; cell++) {
      expect(fragmentForCell[cell]!).toBeGreaterThanOrEqual(0)
      expect(seen.has(cell)).toBe(true)
    }
  })

  test('material-major group contiguity; each fragment inside one group', () => {
    const grid = cube(4, 2, 1)
    const tris = [...quadTris(0, 0, 2, 2, 0.5, 0), ...quadTris(2, 0, 4, 2, 0.5, 1)]
    const built = buildShellData(tris, grid, 5)
    expect(built).not.toBeNull()
    const data = built!
    expect(data.index).toBeInstanceOf(Uint32Array)
    expect(data.positions).toBeInstanceOf(Float32Array)
    expect(data.normals).toBeInstanceOf(Float32Array)
    expect(data.uvs).toBeInstanceOf(Float32Array)
    expect(data.normals.length).toBe(data.positions.length)
    expect(data.uvs.length / 2).toBe(data.positions.length / 3)
    // One contiguous group per material, ascending, tiling the index buffer.
    expect(data.groups.map((g) => g.materialIndex)).toEqual([0, 1])
    let cursor = 0
    for (const group of data.groups) {
      expect(group.start).toBe(cursor)
      cursor += group.count
    }
    expect(cursor).toBe(data.index.length)
    // Every fragment's index range sits inside exactly one group, and the
    // ranges together tile the whole buffer.
    let total = 0
    for (const fragment of data.fragments) {
      total += fragment.indexCount
      const containing = data.groups.filter(
        (g) =>
          fragment.indexStart >= g.start &&
          fragment.indexStart + fragment.indexCount <= g.start + g.count,
      )
      expect(containing.length).toBe(1)
    }
    expect(total).toBe(data.index.length)
    // Left-half fragments (ix<2) pack under material 0, right half under 1.
    data.cellsOfFragment.forEach((fragmentCells, fragment) => {
      const expected = fragmentCells[0]! % 4 < 2 ? 0 : 1
      const range = data.fragments[fragment]!
      const group = data.groups.find(
        (g) => range.indexStart >= g.start && range.indexStart < g.start + g.count,
      )!
      expect(group.materialIndex).toBe(expected)
    })
  })

  test('returns null beyond SHELL_TRI_CAP', () => {
    expect(SHELL_TRI_CAP).toBe(12000)
    const grid = cube(1, 1, 1)
    const tri: ShellSourceTri = {
      positions: [0.4, 0.4, 0.5, 0.42, 0.4, 0.5, 0.4, 0.42, 0.5],
      normals: FLAT_Z,
      uvs: [0, 0, 1, 0, 0, 1],
      materialIndex: 0,
    }
    const over = Array.from({ length: SHELL_TRI_CAP + 1 }, () => tri)
    expect(buildShellData(over, grid, 1)).toBeNull()
    expect(buildShellData(over.slice(0, 3), grid, 1)).not.toBeNull()
  })
})
