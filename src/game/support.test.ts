import { describe, expect, test } from 'bun:test'
import { type SlotId, SupportGraph } from './support'

/** Symmetric adjacency stub from an edge list — the grid.ts stand-in. */
function adjacencyOf(edges: [SlotId, SlotId][]): (slotId: SlotId) => SlotId[] {
  const map = new Map<SlotId, SlotId[]>()
  const link = (a: SlotId, b: SlotId) => {
    const list = map.get(a) ?? []
    if (!list.includes(b)) list.push(b)
    map.set(a, list)
  }
  for (const [a, b] of edges) {
    link(a, b)
    link(b, a)
  }
  return (slotId) => map.get(slotId) ?? []
}

const sorted = (rings: SlotId[][]) => rings.map((ring) => [...ring].sort())

describe('SupportGraph basics', () => {
  test('add/remove/has and grounded support', () => {
    const graph = new SupportGraph(adjacencyOf([['g', 'a']]))
    graph.add('g', { grounded: true })
    graph.add('a')
    expect(graph.has('g')).toBe(true)
    expect(graph.has('a')).toBe(true)
    expect(graph.size).toBe(2)
    expect(graph.isSupported('g')).toBe(true)
    expect(graph.isSupported('a')).toBe(true)
    expect(graph.isSupported('missing')).toBe(false)
    graph.remove('a')
    expect(graph.has('a')).toBe(false)
    expect(graph.isSupported('a')).toBe(false)
  })

  test('adjacency through absent slots does not carry support', () => {
    // g — hole — b: b only touches the empty slot.
    const graph = new SupportGraph(adjacencyOf([['g', 'hole'], ['hole', 'b']]))
    graph.add('g', { grounded: true })
    graph.add('b')
    expect(graph.isSupported('b')).toBe(false)
  })

  test('add invalidates the cache — a new grounded neighbor re-supports', () => {
    const graph = new SupportGraph(adjacencyOf([['g', 'a'], ['a', 'b'], ['g2', 'a']]))
    graph.add('g', { grounded: true })
    graph.add('a')
    graph.add('b')
    graph.remove('g')
    expect(graph.isSupported('a')).toBe(false)
    expect(graph.isSupported('b')).toBe(false)
    graph.add('g2', { grounded: true })
    expect(graph.isSupported('a')).toBe(true)
    expect(graph.isSupported('b')).toBe(true)
  })

  test('repeated isSupported queries reuse the cached BFS', () => {
    let calls = 0
    const touching = adjacencyOf([['g', 'a'], ['a', 'b']])
    const graph = new SupportGraph((slotId) => {
      calls++
      return touching(slotId)
    })
    graph.add('g', { grounded: true })
    graph.add('a')
    graph.add('b')
    graph.isSupported('b')
    const after = calls
    graph.isSupported('a')
    graph.isSupported('b')
    graph.isSupported('g')
    expect(calls).toBe(after)
    graph.remove('b') // dirty again
    graph.isSupported('a')
    expect(calls).toBeGreaterThan(after)
  })
})

describe('computeCollapse — tower', () => {
  test('remove the base → rings ordered by distance from the cut', () => {
    // g (grounded) — a — b — c — d, a straight tower.
    const graph = new SupportGraph(
      adjacencyOf([['g', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'd']]),
    )
    graph.add('g', { grounded: true })
    for (const id of ['a', 'b', 'c', 'd']) graph.add(id)

    graph.remove('g')
    expect(graph.computeCollapse('g')).toEqual([['a'], ['b'], ['c'], ['d']])
    // The doomed component is evicted with it.
    expect(graph.size).toBe(0)
    expect(graph.isSupported('a')).toBe(false)
  })

  test('branching component groups whole rings per BFS distance', () => {
    // g — a — {b1, b2} — c: b1 and b2 sit at the same distance.
    const graph = new SupportGraph(
      adjacencyOf([['g', 'a'], ['a', 'b1'], ['a', 'b2'], ['b1', 'c'], ['b2', 'c']]),
    )
    graph.add('g', { grounded: true })
    for (const id of ['a', 'b1', 'b2', 'c']) graph.add(id)

    graph.remove('g')
    expect(sorted(graph.computeCollapse('g'))).toEqual([['a'], ['b1', 'b2'], ['c']])
  })

  test('supported survivors stay in the graph', () => {
    // Two towers off one grounded pad; cutting one arm spares the other.
    const graph = new SupportGraph(
      adjacencyOf([['g', 'a'], ['a', 'b'], ['g', 'x'], ['x', 'y']]),
    )
    graph.add('g', { grounded: true })
    for (const id of ['a', 'b', 'x', 'y']) graph.add(id)

    graph.remove('a')
    expect(graph.computeCollapse('a')).toEqual([['b']])
    expect(graph.has('x')).toBe(true)
    expect(graph.isSupported('y')).toBe(true)
  })
})

describe('computeCollapse — bridge', () => {
  test('two grounded ends: nothing falls until the second cut', () => {
    // g1 — m1 — m2 — m3 — g2, grounded at both ends.
    const graph = new SupportGraph(
      adjacencyOf([['g1', 'm1'], ['m1', 'm2'], ['m2', 'm3'], ['m3', 'g2']]),
    )
    graph.add('g1', { grounded: true })
    graph.add('g2', { grounded: true })
    for (const id of ['m1', 'm2', 'm3']) graph.add(id)

    graph.remove('m2')
    expect(graph.computeCollapse('m2')).toEqual([])
    expect(graph.isSupported('m1')).toBe(true)
    expect(graph.isSupported('m3')).toBe(true)

    graph.remove('g2')
    expect(graph.computeCollapse('g2')).toEqual([['m3']])
    expect(graph.isSupported('m1')).toBe(true)
  })
})

describe('external support probe', () => {
  test('probe props up a chain; flipping it collapses the dependents', () => {
    // w hangs off a scene wall (probe), x and y hang off w.
    let sceneWallAlive = true
    const graph = new SupportGraph(
      adjacencyOf([['w', 'x'], ['x', 'y']]),
      (slotId) => slotId === 'w' && sceneWallAlive,
    )
    graph.add('w')
    graph.add('x')
    graph.add('y')
    expect(graph.isSupported('y')).toBe(true)

    sceneWallAlive = false
    graph.invalidate()
    // The slot that lost its footing is still present → it leads ring 0.
    expect(graph.computeCollapse('w')).toEqual([['w'], ['x'], ['y']])
    expect(graph.size).toBe(0)
  })

  test('grounded flag keeps a slot up even when the probe says no', () => {
    const graph = new SupportGraph(adjacencyOf([]), () => false)
    graph.add('g', { grounded: true })
    expect(graph.isSupported('g')).toBe(true)
  })
})

describe('perf sanity', () => {
  test('500 slots, 100 removals with collapse compute under 50ms', () => {
    // A 50 × 10 wall of slots, bottom row grounded, 4-neighbor adjacency.
    const cols = 50
    const rows = 10
    const id = (c: number, r: number) => `${c}:${r}`
    const touching = (slotId: string): string[] => {
      const [c = 0, r = 0] = slotId.split(':').map(Number)
      const out: string[] = []
      if (c > 0) out.push(id(c - 1, r))
      if (c < cols - 1) out.push(id(c + 1, r))
      if (r > 0) out.push(id(c, r - 1))
      if (r < rows - 1) out.push(id(c, r + 1))
      return out
    }
    const graph = new SupportGraph(touching)
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) graph.add(id(c, r), { grounded: r === 0 })
    }
    expect(graph.size).toBe(500)

    const start = performance.now()
    let removals = 0
    // Cut every other column at the base (25 full-column cascades), then
    // chew through mid-wall slots — 100 removals total, each recomputing.
    for (let c = 0; c < cols && removals < 100; c += 2) {
      graph.remove(id(c, 0))
      graph.computeCollapse(id(c, 0))
      removals++
    }
    for (let c = 1; c < cols && removals < 100; c += 2) {
      for (let r = 1; r < rows && removals < 100; r += 3) {
        if (!graph.has(id(c, r))) continue
        graph.remove(id(c, r))
        graph.computeCollapse(id(c, r))
        removals++
      }
    }
    for (let c = 0; c < cols && removals < 100; c++) {
      for (let r = 0; r < rows && removals < 100; r++) {
        if (!graph.has(id(c, r))) continue
        graph.remove(id(c, r))
        graph.computeCollapse(id(c, r))
        removals++
      }
    }
    const elapsed = performance.now() - start
    expect(removals).toBe(100)
    expect(elapsed).toBeLessThan(50)
  })
})
