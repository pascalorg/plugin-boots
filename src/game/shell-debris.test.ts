import { describe, expect, test } from 'bun:test'
import type { Material } from 'three'
import { mulberry32, type ShellData, type ShellGroup } from './shell'
import {
  claimSlot,
  clearShellDebris,
  fragmentIndexSlice,
  fragmentMaterialIndex,
  pickDebrisFragments,
  SHELL_DEBRIS_CAP,
  type ShellDebrisBody,
  shellDebrisCensus,
  shellDebrisScale,
  spawnShellDebris,
  stepDebris,
} from './shell-debris'

/**
 * Minimal ShellData for the pure debris tests. Vertex v sits at
 * (v, 0.5, −2) so index-block centroids are trivially predictable; the
 * index is the pack-contract identity (index[i] === i), and default cells
 * give fragment f the single cell f.
 */
const fakeShell = (opts: {
  fragments: { indexStart: number; indexCount: number }[]
  groups?: ShellGroup[]
  cellsOfFragment?: number[][]
}): ShellData => {
  let total = 0
  for (const f of opts.fragments) total = Math.max(total, f.indexStart + f.indexCount)
  const positions = new Float32Array(total * 3)
  for (let v = 0; v < total; v++) {
    positions[v * 3] = v
    positions[v * 3 + 1] = 0.5
    positions[v * 3 + 2] = -2
  }
  return {
    positions,
    normals: new Float32Array(total * 3),
    uvs: new Float32Array(total * 2),
    index: Uint32Array.from({ length: total }, (_, i) => i),
    groups: opts.groups ?? [{ start: 0, count: total, materialIndex: 0 }],
    fragments: opts.fragments,
    fragmentForCell: new Int32Array(0),
    cellsOfFragment: opts.cellsOfFragment ?? opts.fragments.map((_, f) => [f]),
  }
}

describe('pickDebrisFragments', () => {
  const tenFragments = Array.from({ length: 10 }, (_, f) => ({
    indexStart: f * 3,
    indexCount: 3,
  }))
  /** Cell c's center at (c, 0, 0) — distance to the carve is |c − carveX|. */
  const centers = (cell: number): [number, number, number] => [cell, 0, 0]

  test('nearest-first by squared distance to the first cell center', () => {
    const shell = fakeShell({ fragments: tenFragments })
    const picked = pickDebrisFragments([2, 9, 5, 7], shell, [9, 0, 0], centers, 3)
    expect(picked).toEqual([9, 7, 5])
  })

  test('caps at 8 by default', () => {
    const shell = fakeShell({ fragments: tenFragments })
    const all = [3, 1, 4, 0, 9, 2, 6, 5, 8, 7]
    const picked = pickDebrisFragments(all, shell, [9, 0, 0], centers)
    expect(picked).toEqual([9, 8, 7, 6, 5, 4, 3, 2])
    expect(pickDebrisFragments(all, shell, [9, 0, 0], centers, 0)).toEqual([])
  })

  test('deterministic ties break by fragment id, whatever the input order', () => {
    const shell = fakeShell({ fragments: tenFragments })
    const tied = (): [number, number, number] => [5, 5, 5]
    expect(pickDebrisFragments([3, 1, 2], shell, [0, 0, 0], tied)).toEqual([1, 2, 3])
    expect(pickDebrisFragments([2, 3, 1], shell, [0, 0, 0], tied)).toEqual([1, 2, 3])
  })

  test('skips fragments without cells', () => {
    const shell = fakeShell({
      fragments: tenFragments.slice(0, 3),
      cellsOfFragment: [[0], [], [2]],
    })
    expect(pickDebrisFragments([0, 1, 2], shell, [0, 0, 0], centers)).toEqual([0, 2])
  })
})

describe('fragmentIndexSlice', () => {
  const shell = fakeShell({
    fragments: [
      { indexStart: 0, indexCount: 3 },
      { indexStart: 3, indexCount: 6 },
      { indexStart: 9, indexCount: 3 },
    ],
  })

  test('copies exactly the block and returns its count', () => {
    const out = new Uint32Array(6).fill(99)
    expect(fragmentIndexSlice(shell, 1, out)).toBe(6)
    expect([...out]).toEqual([3, 4, 5, 6, 7, 8])
    // A shorter block only overwrites its own count — the tail is stale
    // by contract (drawRange covers the first `count` entries only).
    expect(fragmentIndexSlice(shell, 2, out)).toBe(3)
    expect([...out]).toEqual([9, 10, 11, 6, 7, 8])
  })

  test('unknown fragment copies nothing and returns 0', () => {
    const out = new Uint32Array(6).fill(99)
    expect(fragmentIndexSlice(shell, 42, out)).toBe(0)
    expect([...out]).toEqual([99, 99, 99, 99, 99, 99])
  })
})

describe('fragmentMaterialIndex', () => {
  test('group lookup via the fragment indexStart', () => {
    const shell = fakeShell({
      fragments: [
        { indexStart: 0, indexCount: 3 },
        { indexStart: 3, indexCount: 6 },
        { indexStart: 9, indexCount: 3 },
      ],
      groups: [
        { start: 0, count: 9, materialIndex: 2 },
        { start: 9, count: 3, materialIndex: 0 },
      ],
    })
    expect(fragmentMaterialIndex(shell, 0)).toBe(2)
    expect(fragmentMaterialIndex(shell, 1)).toBe(2)
    expect(fragmentMaterialIndex(shell, 2)).toBe(0)
    expect(fragmentMaterialIndex(shell, 42)).toBe(0)
  })
})

describe('stepDebris', () => {
  const body = (over: Partial<ShellDebrisBody> = {}): ShellDebrisBody => ({
    alive: true,
    px: 0,
    py: 5,
    pz: 0,
    vx: 1,
    vy: 0,
    vz: -1,
    rx: 0,
    ry: 0,
    rz: 0,
    wx: 2,
    wy: -4,
    wz: 6,
    floorY: 0,
    ttl: 3,
    ttl0: 3,
    bounced: false,
    ...over,
  })

  test('gravity 14, exact integration, spin by angularVel', () => {
    const b = body()
    expect(stepDebris(b, 0.5)).toBe(true)
    expect(b.vy).toBe(-7) // 0 − 14·0.5
    expect(b.px).toBe(0.5)
    expect(b.py).toBe(1.5) // 5 + (−7)·0.5
    expect(b.pz).toBe(-0.5)
    expect(b.rx).toBe(1)
    expect(b.ry).toBe(-2)
    expect(b.rz).toBe(3)
    expect(b.ttl).toBe(2.5)
    expect(b.bounced).toBe(false)
  })

  test('one damped bounce at floorY: restitution 0.3, horizontal ×0.75', () => {
    const b = body({ py: 0.1, vy: -10, vx: 2, vz: -2 })
    expect(stepDebris(b, 0.1)).toBe(true)
    expect(b.py).toBe(0) // clamped to floorY
    expect(b.vy).toBeCloseTo(11.4 * 0.3, 10) // −(−10 − 14·0.1)·0.3
    expect(b.vx).toBeCloseTo(1.5, 10)
    expect(b.vz).toBeCloseTo(-1.5, 10)
    expect(b.bounced).toBe(true)
  })

  test('after the bounce, contacts settle: vy pinned to 0, friction ×0.7', () => {
    const b = body({ py: 0, vy: -1, vx: 1, vz: 1, bounced: true })
    expect(stepDebris(b, 0.01)).toBe(true)
    expect(b.py).toBe(0)
    expect(b.vy).toBe(0)
    expect(b.vx).toBeCloseTo(0.7, 10)
    expect(b.vz).toBeCloseTo(0.7, 10)
  })

  test('no floor clamp while rising, even below the plane', () => {
    const b = body({ py: 0.5, floorY: 1, vy: 5 })
    expect(stepDebris(b, 0.1)).toBe(true)
    expect(b.vy).toBeCloseTo(3.6, 10)
    expect(b.py).toBeCloseTo(0.86, 10)
    expect(b.bounced).toBe(false)
  })

  test('ttl expiry kills the slot before integrating', () => {
    const b = body({ ttl: 0.05 })
    expect(stepDebris(b, 0.1)).toBe(false)
    expect(b.alive).toBe(false)
    expect(b.px).toBe(0)
    expect(b.py).toBe(5)
  })

  test('a dead slot is a no-op', () => {
    const b = body({ alive: false })
    expect(stepDebris(b, 0.1)).toBe(false)
    expect(b.ttl).toBe(3)
    expect(b.py).toBe(5)
  })
})

describe('shellDebrisScale', () => {
  test('full size through life, linear shrink over the last 15%', () => {
    expect(shellDebrisScale(3, 3)).toBe(1)
    expect(shellDebrisScale(0.45, 3)).toBe(1) // exactly at the window edge
    expect(shellDebrisScale(0.225, 3)).toBeCloseTo(0.5, 10)
    expect(shellDebrisScale(0, 3)).toBe(0)
    expect(shellDebrisScale(-1, 3)).toBe(0)
    expect(shellDebrisScale(1, 0)).toBe(0)
  })
})

describe('claimSlot', () => {
  test('first free slot wins', () => {
    const pool = [
      { alive: true, ttl: 0.2 },
      { alive: false, ttl: 0 },
      { alive: false, ttl: 0 },
    ]
    expect(claimSlot(pool)).toBe(1)
  })

  test('full pool evicts the slot closest to expiry', () => {
    const pool = [
      { alive: true, ttl: 2 },
      { alive: true, ttl: 0.5 },
      { alive: true, ttl: 1 },
    ]
    expect(claimSlot(pool)).toBe(1)
  })

  test('ttl ties evict the lowest index', () => {
    const pool = [
      { alive: true, ttl: 1 },
      { alive: true, ttl: 0.5 },
      { alive: true, ttl: 0.5 },
    ]
    expect(claimSlot(pool)).toBe(1)
  })
})

describe('spawnShellDebris (headless pool)', () => {
  const shell = fakeShell({
    fragments: [
      { indexStart: 0, indexCount: 3 },
      { indexStart: 3, indexCount: 6 },
      { indexStart: 9, indexCount: 3 },
      { indexStart: 12, indexCount: 0 },
    ],
    groups: [
      { start: 0, count: 9, materialIndex: 0 },
      { start: 9, count: 3, materialIndex: 1 },
    ],
  })
  const arrays = { positions: shell.positions, normals: shell.normals, uvs: shell.uvs }
  const materials = [{} as Material, {} as Material]

  test('claims one live slot per real fragment, launches upward, deterministic', () => {
    clearShellDebris()
    spawnShellDebris(arrays, shell, [0, 2], materials, [0, 0, -2], 0, mulberry32(7))
    const first = shellDebrisCensus()
    expect(first.live).toBe(2)
    expect(first.meanVy).toBeGreaterThan(0) // outward + up kick
    // Same seed after a clear reproduces the exact same launch.
    clearShellDebris()
    spawnShellDebris(arrays, shell, [0, 2], materials, [0, 0, -2], 0, mulberry32(7))
    expect(shellDebrisCensus().meanVy).toBe(first.meanVy)
    clearShellDebris()
  })

  test('skips unknown and zero-index fragments', () => {
    clearShellDebris()
    spawnShellDebris(arrays, shell, [42, 3], materials, [0, 0, 0], 0, mulberry32(1))
    expect(shellDebrisCensus().live).toBe(0)
  })

  test('the pool is bounded — spawns past the cap evict, never grow', () => {
    clearShellDebris()
    const rng = mulberry32(11)
    for (let wave = 0; wave < 9; wave++) {
      spawnShellDebris(arrays, shell, [0, 1, 2], materials, [1, 0, 0], 0, rng)
    }
    expect(shellDebrisCensus().live).toBe(SHELL_DEBRIS_CAP)
    clearShellDebris()
    expect(shellDebrisCensus().live).toBe(0)
  })
})
