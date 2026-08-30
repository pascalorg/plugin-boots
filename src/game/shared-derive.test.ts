/**
 * The derivations, tested for the one property that matters: two clients with
 * the same replicated inputs get the same answer, whatever order they walk
 * them in and whatever they happen to have materialized locally.
 *
 * The paint fold is tested against the REAL coat arithmetic imported from
 * paint.tsx, not a copy of it, so the test fails if the game's rule changes
 * out from under the shared model.
 */

import { describe, expect, test } from 'bun:test'
import { coatBaseStrength, paintColorOf, paintStrengthOf, paintValue } from './paint'
import {
  buriedApertures,
  canonicalCellOrder,
  canonicalNodeOrder,
  canonicalRecordOrder,
  deriveCollapse,
  electSlots,
  foldCoats,
  gridStamp,
  hashString,
  MAX_DERIVED_COLLAPSE,
  mulberry32,
  seededCellUnit,
  seededUnit,
  sheetHasFlown,
  stableSeed,
  strokesByNode,
  type CoatOps,
  type CoatSplat,
} from './shared-derive'
import { cellKey, type NodeId, type PieceRec, type StrokeRec } from './shared-world'

const shuffled = <T>(list: readonly T[], rand: () => number): T[] => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

// ── Seeds ───────────────────────────────────────────────────────────────────

describe('stable seeds', () => {
  test('hashString matches the games own FNV-1a', () => {
    // Same constants, same result: 'a' → 0x811c9dc5 ^ 97, × 0x01000193.
    expect(hashString('a')).toBe(Math.imul(0x811c9dc5 ^ 97, 0x01000193) >>> 0)
    expect(hashString('')).toBe(0x811c9dc5)
    expect(hashString('__boots-node-3f2a')).toBe(hashString('__boots-node-3f2a'))
    expect(hashString('__boots-node-3f2a')).not.toBe(hashString('__boots-node-3f2b'))
  })

  test('a cell seed depends only on its key, never on call order', () => {
    const node = '__boots-node-3f2a'
    const keys = Array.from({ length: 200 }, (_, i) => cellKey(i % 20, (i * 7) % 20, i % 2))
    const forward = keys.map((k) => seededCellUnit(node, k, 'scale'))
    const rand = mulberry32(11)
    const order = shuffled(keys.map((k, i) => [k, i] as const), rand)
    for (const [key, at] of order) {
      expect(seededCellUnit(node, key, 'scale')).toBe(forward[at] as number)
    }
  })

  test('channels are independent and values are in range', () => {
    let sum = 0
    for (let i = 0; i < 500; i++) {
      const a = seededCellUnit('n', i, 'scale')
      const b = seededCellUnit('n', i, 'spin')
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(1)
      expect(a).not.toBe(b)
      sum += a
    }
    // Roughly uniform: the mean of 500 draws should be near 0.5.
    expect(Math.abs(sum / 500 - 0.5)).toBeLessThan(0.06)
  })

  test('two nodes never share a cell decision', () => {
    for (let i = 0; i < 50; i++) {
      expect(seededUnit(stableSeed('wall-a', i))).not.toBe(seededUnit(stableSeed('wall-b', i)))
    }
  })

  test('mulberry32 is reproducible and machine-independent', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) expect(a()).toBe(b())
  })
})

// ── Grid fingerprint ────────────────────────────────────────────────────────

describe('gridStamp', () => {
  test('same lot, same stamp; different lot, different stamp', () => {
    const a = gridStamp(12.5, -3.25, [0, 2.7, 5.4])
    expect(gridStamp(12.5, -3.25, [0, 2.7, 5.4])).toBe(a)
    expect(gridStamp(12.5, -3.25, [0, 2.7])).not.toBe(a)
    expect(gridStamp(12.6, -3.25, [0, 2.7, 5.4])).not.toBe(a)
    expect(gridStamp(12.5, -3.24, [0, 2.7, 5.4])).not.toBe(a)
  })

  test('float noise below a millimetre cannot split two clients', () => {
    const a = gridStamp(12.5, -3.25, [0, 2.7, 5.4])
    expect(gridStamp(12.5000001, -3.2499999, [0, 2.7000001, 5.4])).toBe(a)
  })

  test('never returns the reserved 0', () => {
    for (let i = 0; i < 2000; i++) expect(gridStamp(i * 0.001, -i * 0.002, [i * 0.01])).not.toBe(0)
  })
})

// ── Canonical orders ────────────────────────────────────────────────────────

describe('canonical orders', () => {
  test('nodes, cells and records all have one agreed order', () => {
    expect(canonicalNodeOrder(['b', 'a', 'C'])).toEqual(['C', 'a', 'b'])
    expect(canonicalCellOrder([30, 4, 1000, 4])).toEqual([4, 4, 30, 1000])
    const recs = [
      { id: 'z#1', lamport: 1 },
      { id: 'a#1', lamport: 5 },
      { id: 'b#1', lamport: 1 },
    ]
    expect(canonicalRecordOrder(recs).map((r) => r.id)).toEqual(['b#1', 'z#1', 'a#1'])
  })

  test('record order is total, so no two clients can disagree', () => {
    const recs = Array.from({ length: 60 }, (_, i) => ({
      id: `p${i % 3}#${i}`,
      lamport: i % 7,
    }))
    const rand = mulberry32(3)
    const reference = canonicalRecordOrder(recs).map((r) => r.id)
    for (let trial = 0; trial < 20; trial++) {
      expect(canonicalRecordOrder(shuffled(recs, rand)).map((r) => r.id)).toEqual(reference)
    }
  })
})

// ── Collapse ────────────────────────────────────────────────────────────────

/**
 * A toy support graph: a node stands if it is grounded, or if any of its
 * supports is still alive. This is the shape of the real question without the
 * real question's tier-dependence.
 */
function graphOf(
  supports: Record<string, string[]>,
  grounded: readonly string[],
): {
  dependentsOf: (id: NodeId) => NodeId[]
  isSupported: (id: NodeId, dead: ReadonlySet<NodeId>) => boolean
} {
  const dependents = new Map<string, string[]>()
  for (const [node, holders] of Object.entries(supports)) {
    for (const holder of holders) {
      const list = dependents.get(holder) ?? []
      list.push(node)
      dependents.set(holder, list)
    }
  }
  const groundSet = new Set(grounded)
  return {
    dependentsOf: (id) => dependents.get(id) ?? [],
    isSupported: (id, dead) => {
      if (groundSet.has(id)) return true
      const holders = supports[id] ?? []
      return holders.some((h) => !dead.has(h))
    },
  }
}

describe('deriveCollapse', () => {
  test('a chain falls all the way down', () => {
    const g = graphOf({ b: ['a'], c: ['b'], d: ['c'] }, ['a'])
    const fell = deriveCollapse({ dead: new Set(['a']), seeds: ['b'], ...g })
    expect(fell).toEqual(['b', 'c', 'd'])
  })

  test('a node with a surviving support stays up', () => {
    const g = graphOf({ c: ['a', 'b'] }, ['a', 'b'])
    expect(deriveCollapse({ dead: new Set(['a']), seeds: ['c'], ...g })).toEqual([])
    expect(deriveCollapse({ dead: new Set(['a', 'b']), seeds: ['c'], ...g })).toEqual(['c'])
  })

  test('the answer does not depend on seed order — the whole point', () => {
    const supports: Record<string, string[]> = {}
    const rand = mulberry32(17)
    const ids = Array.from({ length: 120 }, (_, i) => `n${i}`)
    for (let i = 3; i < ids.length; i++) {
      const holders = [ids[Math.floor(rand() * i)] as string]
      if (rand() < 0.4) holders.push(ids[Math.floor(rand() * i)] as string)
      supports[ids[i] as string] = holders
    }
    const g = graphOf(supports, ['n0', 'n1', 'n2'])
    const dead = new Set(['n0', 'n5', 'n9'])
    const seeds = ids.slice(3)
    const reference = deriveCollapse({ dead, seeds, ...g })
    expect(reference.length).toBeGreaterThan(5)
    for (let trial = 0; trial < 25; trial++) {
      expect(deriveCollapse({ dead, seeds: shuffled(seeds, rand), ...g })).toEqual(reference)
    }
  })

  test('a mutual-support pair answers the same either way round', () => {
    // a and b hold each other and nothing else does. Whatever one thinks of
    // that physically, the two clients must agree — and they do, in both seed
    // orders, because each round tests against a frozen dead set instead of
    // one being mutated mid-walk.
    const g = graphOf({ a: ['b'], b: ['a'] }, [])
    expect(deriveCollapse({ dead: new Set(), seeds: ['a', 'b'], ...g })).toEqual([])
    expect(deriveCollapse({ dead: new Set(), seeds: ['b', 'a'], ...g })).toEqual([])
    // Break the cycle and the whole thing goes, in either order.
    const dead = new Set(['b'])
    expect(deriveCollapse({ dead, seeds: ['a'], ...g })).toEqual(['a'])
  })

  test('the fixpoint does not care whether the frontier arrives at once', () => {
    // One shot with every seed, versus pumping seeds in one at a time and
    // feeding the growing dead set back in — the same final set either way.
    const g = graphOf({ b: ['a'], c: ['b'], d: ['b'], e: ['d'] }, ['a'])
    const seeds = ['b', 'c', 'd', 'e']
    const oneShot = deriveCollapse({ dead: new Set(['a']), seeds, ...g })

    const dead = new Set(['a'])
    const piecemeal: NodeId[] = []
    for (const seed of ['e', 'c', 'b', 'd']) {
      for (const id of deriveCollapse({ dead, seeds: [seed], ...g })) {
        dead.add(id)
        piecemeal.push(id)
      }
    }
    expect(canonicalNodeOrder(piecemeal)).toEqual(oneShot)
  })

  test('already-dead seeds are not reported again', () => {
    const g = graphOf({ b: ['a'] }, ['a'])
    expect(deriveCollapse({ dead: new Set(['a', 'b']), seeds: ['a', 'b'], ...g })).toEqual([])
  })

  test('a cyclic graph terminates', () => {
    const g = graphOf({ a: ['b'], b: ['c'], c: ['a'] }, [])
    const fell = deriveCollapse({ dead: new Set(), seeds: ['a'], ...g })
    expect(fell.length).toBeLessThanOrEqual(3)
  })

  test('the safety valve is far above any real lot', () => {
    expect(MAX_DERIVED_COLLAPSE).toBeGreaterThan(2000)
  })

  test('input sets are never mutated', () => {
    const g = graphOf({ b: ['a'] }, ['a'])
    const dead = new Set(['a'])
    deriveCollapse({ dead, seeds: ['b'], ...g })
    expect([...dead]).toEqual(['a'])
  })
})

// ── Slot election ───────────────────────────────────────────────────────────

const piece = (id: string, lamport: number, slot: string, mask = 511): PieceRec => ({
  id,
  lamport,
  kind: 'wall',
  slot,
  mask,
  yaw: 0,
  height: 2.7,
  corners: null,
})

describe('electSlots', () => {
  test('the later claim wins, and everyone agrees who that is', () => {
    const claims = [piece('bob#4', 9, 'Wx:1,0,0'), piece('alice#2', 5, 'Wx:1,0,0')]
    const rand = mulberry32(8)
    for (let trial = 0; trial < 10; trial++) {
      const { winners, losers } = electSlots(shuffled(claims, rand))
      expect(winners.get('wall|Wx:1,0,0')?.id).toBe('bob#4')
      expect(losers.map((r) => r.id)).toEqual(['alice#2'])
    }
  })

  test('a simultaneous claim is broken by id, not by arrival', () => {
    const claims = [piece('bob#1', 7, 'Wx:1,0,0'), piece('alice#1', 7, 'Wx:1,0,0')]
    const rand = mulberry32(9)
    for (let trial = 0; trial < 10; trial++) {
      const { winners } = electSlots(shuffled(claims, rand))
      expect(winners.get('wall|Wx:1,0,0')?.id).toBe('bob#1')
    }
  })

  test('different kinds may share a slot string', () => {
    const { winners, losers } = electSlots([
      piece('a#1', 1, 'F:0,0,0'),
      { ...piece('a#2', 1, 'F:0,0,0'), kind: 'floor' },
    ])
    expect(winners.size).toBe(2)
    expect(losers).toEqual([])
  })

  test('unclaimed slots produce nothing', () => {
    expect(electSlots([]).winners.size).toBe(0)
  })
})

// ── Paint fold ──────────────────────────────────────────────────────────────

const OPS: CoatOps = { pack: paintValue, base: coatBaseStrength }

const stroke = (id: string, lamport: number, color: number, node = 'wall-a'): StrokeRec => ({
  id,
  lamport,
  node,
  color,
  x: 0,
  y: 0,
  z: 0,
  radius: 0.18,
})

/** Every stroke hits the same three cells with a fixed weight. */
const flatExpand = (add: number) => (): CoatSplat[] =>
  [
    { cell: 10, add },
    { cell: 11, add },
    { cell: 12, add },
  ]

describe('foldCoats', () => {
  test('same colour accumulates towards saturation', () => {
    const ledger = foldCoats(
      [stroke('a#1', 1, 3), stroke('a#2', 2, 3), stroke('a#3', 3, 3)],
      flatExpand(0.45),
      OPS,
    )
    const value = ledger.get(10) as number
    expect(paintColorOf(value)).toBe(3)
    expect(paintStrengthOf(value)).toBeCloseTo(1, 2)
  })

  test('a different colour covers the old coat and restarts', () => {
    const ledger = foldCoats(
      [stroke('a#1', 1, 3), stroke('a#2', 2, 3), stroke('a#3', 3, 5)],
      flatExpand(0.45),
      OPS,
    )
    const value = ledger.get(10) as number
    expect(paintColorOf(value)).toBe(5)
    expect(paintStrengthOf(value)).toBeCloseTo(0.45, 2)
  })

  test('the fold is order-free because it sorts first — colour changes and all', () => {
    const strokes = [
      stroke('a#1', 1, 3),
      stroke('b#1', 2, 5),
      stroke('a#2', 3, 3),
      stroke('b#2', 3, 5),
      stroke('a#3', 4, 3),
    ]
    const rand = mulberry32(23)
    const reference = [...foldCoats(strokes, flatExpand(0.45), OPS).entries()]
    for (let trial = 0; trial < 20; trial++) {
      expect([...foldCoats(shuffled(strokes, rand), flatExpand(0.45), OPS).entries()]).toEqual(
        reference,
      )
    }
    // ...and the reference is NOT what a naive last-writer fold would give:
    // the winner is the highest-lamport colour, at its accumulated strength.
    expect(paintColorOf(reference[0]?.[1] as number)).toBe(3)
  })

  test('re-folding from scratch after a late join lands where the live client is', () => {
    const strokes = [stroke('a#1', 1, 2), stroke('b#1', 2, 2), stroke('a#2', 5, 7)]
    const live = new Map<number, number>()
    // The live client folds them one at a time as they arrive...
    foldCoats([strokes[0] as StrokeRec], flatExpand(0.3), OPS, live)
    foldCoats([strokes[1] as StrokeRec], flatExpand(0.3), OPS, live)
    foldCoats([strokes[2] as StrokeRec], flatExpand(0.3), OPS, live)
    // ...the joiner folds all three at once from the snapshot.
    const joined = foldCoats(strokes, flatExpand(0.3), OPS)
    expect([...joined.entries()]).toEqual([...live.entries()])
  })

  test('strokes carry geometry, so a client expands them against its own grid', () => {
    const strokes = [stroke('a#1', 1, 4)]
    const coarse = foldCoats(strokes, () => [{ cell: 1, add: 0.9 }], OPS)
    const fine = foldCoats(
      strokes,
      () => [
        { cell: 1, add: 0.45 },
        { cell: 2, add: 0.45 },
      ],
      OPS,
    )
    // Different grids, different cells — but each client is internally
    // consistent, and re-folding gives it the same answer every time.
    expect(coarse.size).toBe(1)
    expect(fine.size).toBe(2)
    expect(foldCoats(strokes, () => [{ cell: 1, add: 0.9 }], OPS)).toEqual(coarse)
  })

  test('strokes group by node in canonical order', () => {
    const grouped = strokesByNode([
      stroke('b#1', 5, 1, 'wall-b'),
      stroke('a#1', 9, 1, 'wall-a'),
      stroke('a#2', 1, 1, 'wall-b'),
    ])
    expect([...grouped.keys()].sort()).toEqual(['wall-a', 'wall-b'])
    expect(grouped.get('wall-b')?.map((r) => r.id)).toEqual(['a#2', 'b#1'])
  })
})

// ── Derived-not-replicated ──────────────────────────────────────────────────

describe('derived rules need no replicated state', () => {
  test('an opening in a wall with no cells left is buried', () => {
    const hosts = new Map([
      ['door-1', 'wall-a'],
      ['window-1', 'wall-b'],
      ['door-2', 'wall-a'],
      ['orphan', null],
    ])
    const buried = buriedApertures(
      ['wall-a'],
      [...hosts.keys()],
      (id) => hosts.get(id) ?? null,
    )
    expect(buried).toEqual(['door-1', 'door-2'])
  })

  test('burial is idempotent and order-free', () => {
    const hosts = new Map([['d', 'w']])
    const once = buriedApertures(['w'], ['d'], (id) => hosts.get(id) ?? null)
    const twice = buriedApertures(['w', 'w'], ['d', 'd'], (id) => hosts.get(id) ?? null)
    expect(new Set(twice)).toEqual(new Set(once))
  })

  test('a sheet with every cell dead has flown, an untouched one has not', () => {
    const cells = [1, 2, 3]
    expect(sheetHasFlown(cells, new Set([1, 2, 3]))).toBe(true)
    expect(sheetHasFlown(cells, new Set([1, 2]))).toBe(false)
    expect(sheetHasFlown([], new Set([1]))).toBe(false)
  })
})
