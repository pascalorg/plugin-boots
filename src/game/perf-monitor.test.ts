import { describe, expect, test } from 'bun:test'
import { createFrameStats, perfEvent, perfReset, perfSnapshot } from './perf-monitor'

/**
 * Pins for the lag recorder (owner request 2026-08-27): ring stats
 * (mean/p95/worst over the 3600-frame window), the two-bar spike threshold
 * (3× rolling mean AND the 50 ms floor), the 500 ms event-tag attribution
 * window, both caps (ring wrap + 200-spike log), reset, and the
 * copies-never-live-refs readout contract __boots.perf() relies on.
 */

/** Manual wall clock for the event-tag window. */
function clock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start
  return { now: () => t, set: (v) => (t = v) }
}

/** Feed `n` frames of `deltaMs` each. */
function feed(stats: ReturnType<typeof createFrameStats>, n: number, deltaMs: number): void {
  for (let i = 0; i < n; i++) stats.recordFrame(deltaMs)
}

describe('createFrameStats — ring statistics', () => {
  test('constant deltas: mean converges exactly, p95 = worst = the delta', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 100, 16)
    const s = stats.stats()
    expect(s.frames).toBe(100)
    expect(s.mean).toBeCloseTo(16, 6)
    expect(s.p95).toBe(16)
    expect(s.worst).toBe(16)
    expect(s.spikes).toEqual([])
  })

  test('p95 and worst read the tail of the distribution', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 90, 10)
    feed(stats, 10, 40) // 40 < max(3×~10, 50) — heavy tail, not spikes
    const s = stats.stats()
    expect(s.worst).toBe(40)
    expect(s.p95).toBe(40) // 95th percentile lands inside the 10% tail
  })

  test('empty monitor reads zeros', () => {
    const s = createFrameStats(() => 0).stats()
    expect(s).toEqual({ frames: 0, mean: 0, p95: 0, worst: 0, spikes: [] })
  })

  test('ring wraps at 3600: an old outlier falls out of p95/worst', () => {
    const stats = createFrameStats(() => 0)
    stats.recordFrame(500) // frame #1 — seeds the mean, never a spike
    feed(stats, 3600, 10) // a full ring of quiet frames overwrites it
    const s = stats.stats()
    expect(s.frames).toBe(3601)
    expect(s.worst).toBe(10)
    expect(s.p95).toBe(10)
    expect(s.spikes).toEqual([]) // 10 never beats max(3×mean, 50)
  })

  test('exponential mean tracks a regime change (alpha 0.02)', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 200, 10)
    feed(stats, 500, 20) // 500 frames at alpha 0.02 ≈ fully converged
    expect(stats.stats().mean).toBeCloseTo(20, 3)
  })
})

describe('createFrameStats — spike detection', () => {
  test('the 50 ms floor gates quiet scenes (3× a 5 ms mean is NOT a spike)', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 100, 5)
    stats.recordFrame(40) // > 3×5 but under the floor
    expect(stats.stats().spikes).toEqual([])
    stats.recordFrame(51) // over both bars
    expect(stats.stats().spikes.length).toBe(1)
  })

  test('3× the rolling mean gates heavy scenes (60 ms on a 40 ms mean is NOT a spike)', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 200, 40)
    stats.recordFrame(60) // > 50 ms floor, but < 3×40
    expect(stats.stats().spikes).toEqual([])
    stats.recordFrame(130) // > 3×40
    expect(stats.stats().spikes.length).toBe(1)
  })

  test('a spike entry carries {t, delta, mean-before, tag}', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 100, 16) // 1.6 s of game time
    stats.recordFrame(100)
    const spike = stats.stats().spikes[0]!
    expect(spike.delta).toBe(100)
    expect(spike.mean).toBeCloseTo(16, 6) // the mean BEFORE the spike folded in
    expect(spike.t).toBeCloseTo(1.7, 6) // 100×16 ms + the 100 ms frame itself
    expect(spike.tag).toBe('')
  })

  test('the very first frame never spikes — it seeds the mean', () => {
    const stats = createFrameStats(() => 0)
    stats.recordFrame(500)
    const s = stats.stats()
    expect(s.spikes).toEqual([])
    expect(s.mean).toBe(500)
  })

  test('spike log is bounded at 200, oldest dropped', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 100, 10)
    for (let i = 0; i < 210; i++) {
      stats.recordFrame(1000 + i) // distinct deltas → identifiable entries
      feed(stats, 50, 10) // settle the mean back down between spikes
    }
    const spikes = stats.stats().spikes
    expect(spikes.length).toBe(200)
    expect(spikes[0]!.delta).toBe(1010) // entries 0–9 fell off the front
    expect(spikes[199]!.delta).toBe(1209)
  })
})

describe('createFrameStats — event tag attribution', () => {
  test('a spike within 500 ms of the event wears its tag; later spikes do not', () => {
    const wall = clock()
    const stats = createFrameStats(wall.now)
    feed(stats, 100, 16)
    wall.set(1000)
    stats.event('boom')
    wall.set(1400) // inside the window
    stats.recordFrame(120)
    wall.set(1600) // outside the window
    stats.recordFrame(120)
    const spikes = stats.stats().spikes
    expect(spikes.length).toBe(2)
    expect(spikes[0]!.tag).toBe('boom')
    expect(spikes[1]!.tag).toBe('')
  })

  test('the MOST RECENT event wins', () => {
    const wall = clock()
    const stats = createFrameStats(wall.now)
    feed(stats, 100, 16)
    wall.set(1000)
    stats.event('voxelize')
    wall.set(1200)
    stats.event('wave-spawn')
    wall.set(1300)
    stats.recordFrame(120)
    expect(stats.stats().spikes[0]!.tag).toBe('wave-spawn')
  })

  test('the window boundary is inclusive at exactly 500 ms', () => {
    const wall = clock()
    const stats = createFrameStats(wall.now)
    feed(stats, 100, 16)
    stats.event('edge')
    wall.set(500)
    stats.recordFrame(120)
    wall.set(501)
    stats.recordFrame(120)
    const spikes = stats.stats().spikes
    expect(spikes[0]!.tag).toBe('edge')
    expect(spikes[1]!.tag).toBe('')
  })
})

describe('createFrameStats — reset + readout isolation', () => {
  test('reset drops frames, mean, elapsed, spikes AND event memory', () => {
    const wall = clock()
    const stats = createFrameStats(wall.now)
    feed(stats, 100, 16)
    stats.event('stale')
    stats.recordFrame(120)
    stats.reset()
    expect(stats.stats()).toEqual({ frames: 0, mean: 0, p95: 0, worst: 0, spikes: [] })
    // The pre-reset event never tags a post-reset spike…
    feed(stats, 100, 16)
    wall.set(100) // …even though its wall-clock window hasn't lapsed
    stats.recordFrame(120)
    const spike = stats.stats().spikes[0]!
    expect(spike.tag).toBe('')
    expect(spike.t).toBeCloseTo(100 * 0.016 + 0.12, 6) // elapsed restarted at 0
  })

  test('stats() hands out copies — mutating the readout never touches the log', () => {
    const stats = createFrameStats(() => 0)
    feed(stats, 100, 16)
    stats.recordFrame(120)
    const first = stats.stats()
    first.spikes[0]!.tag = 'vandalized'
    first.spikes.length = 0
    const second = stats.stats()
    expect(second.spikes.length).toBe(1)
    expect(second.spikes[0]!.tag).toBe('')
  })
})

describe('module singleton (the __boots.perf surface)', () => {
  test('perfReset → empty snapshot; perfEvent alone records nothing', () => {
    perfReset()
    perfEvent('idle-probe')
    expect(perfSnapshot()).toEqual({ frames: 0, mean: 0, p95: 0, worst: 0, spikes: [] })
    perfReset()
  })
})
