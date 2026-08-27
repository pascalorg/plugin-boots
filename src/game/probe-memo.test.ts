import { describe, expect, test } from 'bun:test'
import { createProbeMemo, type LandingProbe } from './probe-memo'

/**
 * Pins for the landing-probe memo (perf round 2026-08-27, finding B4):
 * same-cell reuse, XZ/Y cell separation, TTL expiry, injection-clear —
 * the properties debris.tsx/dust.tsx rely on to keep a grenade's ~200-piece
 * probe burst down to one probeLandingY per footprint cell.
 */

function countingProbe(height = 7): { probe: LandingProbe; calls: () => number } {
  let calls = 0
  return {
    probe: () => {
      calls++
      return height
    },
    calls: () => calls,
  }
}

describe('createProbeMemo', () => {
  test('same-cell lookups within the TTL run the probe once', () => {
    const memo = createProbeMemo(() => 0)
    const { probe, calls } = countingProbe(3.5)
    expect(memo.get(probe, 1.0, 2.0, 3.0)).toBe(3.5)
    // 0.5 m XZ bucket: everything inside the cell shares the result.
    expect(memo.get(probe, 1.1, 2.2, 3.1)).toBe(3.5)
    expect(memo.get(probe, 0.9, 1.8, 2.9)).toBe(3.5)
    expect(calls()).toBe(1)
  })

  test('peek misses cold, hits after probe', () => {
    const memo = createProbeMemo(() => 0)
    const { probe } = countingProbe(1.25)
    expect(memo.peek(4, 0, 4)).toBeUndefined()
    expect(memo.probe(probe, 4, 0, 4)).toBe(1.25)
    expect(memo.peek(4, 0, 4)).toBe(1.25)
  })

  test('distinct XZ cells probe separately', () => {
    const memo = createProbeMemo(() => 0)
    const { probe, calls } = countingProbe()
    memo.get(probe, 0, 0, 0)
    memo.get(probe, 5, 0, 0) // 10 cells over in x
    memo.get(probe, 0, 0, 5)
    expect(calls()).toBe(3)
  })

  test('storeys never share a cell (1 m y-band separation)', () => {
    const memo = createProbeMemo(() => 0)
    let calls = 0
    const probe: LandingProbe = (_x, y) => {
      calls++
      return y > 2 ? 3 : 0 // upstairs floor vs terrain
    }
    expect(memo.get(probe, 1, 0.2, 1)).toBe(0)
    expect(memo.get(probe, 1, 3.2, 1)).toBe(3) // same XZ, upper storey
    expect(calls).toBe(2)
  })

  test('entries expire after the TTL (bounded staleness)', () => {
    let t = 0
    const memo = createProbeMemo(() => t)
    const { probe, calls } = countingProbe()
    memo.get(probe, 0, 0, 0)
    t = 399
    memo.get(probe, 0, 0, 0) // still fresh
    expect(calls()).toBe(1)
    t = 401
    memo.get(probe, 0, 0, 0) // expired → re-probe
    expect(calls()).toBe(2)
  })

  test('clear drops everything (probe re-injection contract)', () => {
    const memo = createProbeMemo(() => 0)
    const { probe, calls } = countingProbe()
    memo.get(probe, 0, 0, 0)
    memo.clear()
    memo.get(probe, 0, 0, 0)
    expect(calls()).toBe(2)
  })

  test('a cached 0 is a hit, not a miss', () => {
    const memo = createProbeMemo(() => 0)
    const { probe, calls } = countingProbe(0)
    expect(memo.get(probe, 2, 0, 2)).toBe(0)
    expect(memo.get(probe, 2, 0, 2)).toBe(0)
    expect(calls()).toBe(1)
    expect(memo.peek(2, 0, 2)).toBe(0)
  })
})
