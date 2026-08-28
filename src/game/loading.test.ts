import { describe, expect, test } from 'bun:test'
import {
  advanceProgress,
  BAR_MIN_INTERVAL_MS,
  barPercent,
  LOADING_CAP_MS,
  loadingProgress,
  type LoadingSample,
  pendingLabel,
  primesDone,
  shouldWriteBar,
  STAGE_PRIMES_END,
  STAGE_SNAPSHOT,
  STAGE_WALLS_END,
  WARM_FRAMES_TARGET,
} from './loading'

/**
 * Entry-loading progress math (owner report 2026-08-28: "terrible lag when
 * launching… can't I get a loading bar that's quick but smooth?"). The veil
 * reveals on REAL pipeline progress: snapshot 0.15, wall prevoxelize
 * 0.15→0.55, dormant prime drain 0.55→0.85, warm frames 0.85→1.0 — capped
 * at 4 s so the player is never trapped, monotonic so the bar never runs
 * backwards.
 */

/** A sample builder — defaults describe a mid-entry moment. */
function sample(overrides: Partial<LoadingSample> = {}): LoadingSample {
  return {
    snapshotDone: true,
    wallsTotal: 12,
    wallsVoxelized: 0,
    prevoxelizeDone: false,
    primeQueuePeak: 0,
    primeQueueRemaining: 0,
    warmFrames: 0,
    elapsedMs: 500,
    ...overrides,
  }
}

describe('stage weights', () => {
  test('no snapshot yet → 0', () => {
    expect(loadingProgress(sample({ snapshotDone: false }))).toBe(0)
  })

  test('snapshot alone lands the first stage boundary', () => {
    expect(loadingProgress(sample())).toBeCloseTo(STAGE_SNAPSHOT, 10)
  })

  test('wall fraction interpolates 0.15→0.55', () => {
    expect(loadingProgress(sample({ wallsVoxelized: 6 }))).toBeCloseTo(
      STAGE_SNAPSHOT + (STAGE_WALLS_END - STAGE_SNAPSHOT) * 0.5,
      10,
    )
    // All walls voxelized but colliders still prevoxelizing: walls stage full.
    expect(loadingProgress(sample({ wallsVoxelized: 12 }))).toBeCloseTo(STAGE_WALLS_END, 10)
  })

  test('a wall-less lot completes the wall stage outright', () => {
    expect(loadingProgress(sample({ wallsTotal: 0 }))).toBeCloseTo(STAGE_WALLS_END, 10)
  })

  test('prime drain interpolates 0.55→0.85 once prevoxelize is done', () => {
    const p = loadingProgress(
      sample({
        wallsVoxelized: 12,
        prevoxelizeDone: true,
        primeQueuePeak: 10,
        primeQueueRemaining: 5,
      }),
    )
    expect(p).toBeCloseTo(STAGE_WALLS_END + (STAGE_PRIMES_END - STAGE_WALLS_END) * 0.5, 10)
  })

  test('primes never read complete while prevoxelize is still enqueueing', () => {
    // Queue momentarily empty mid-build — must NOT hit the 0.85 boundary.
    const p = loadingProgress(
      sample({ wallsVoxelized: 12, primeQueuePeak: 4, primeQueueRemaining: 0 }),
    )
    expect(p).toBeLessThan(STAGE_PRIMES_END)
    expect(
      primesDone(sample({ primeQueuePeak: 4, primeQueueRemaining: 0, prevoxelizeDone: false })),
    ).toBe(false)
  })

  test('prevoxelize done + queue drained = the primes boundary', () => {
    const s = sample({
      wallsVoxelized: 12,
      prevoxelizeDone: true,
      primeQueuePeak: 10,
      primeQueueRemaining: 0,
    })
    expect(primesDone(s)).toBe(true)
    expect(loadingProgress(s)).toBeCloseTo(STAGE_PRIMES_END, 10)
  })

  test('a scene with no dormant primes completes the stage on prevoxelize done', () => {
    const s = sample({ wallsVoxelized: 12, prevoxelizeDone: true, primeQueuePeak: 0 })
    expect(loadingProgress(s)).toBeCloseTo(STAGE_PRIMES_END, 10)
  })

  test('warm frames interpolate 0.85→1.0 and only count after primes drain', () => {
    const done = sample({
      wallsVoxelized: 12,
      prevoxelizeDone: true,
      primeQueuePeak: 10,
      primeQueueRemaining: 0,
    })
    expect(loadingProgress({ ...done, warmFrames: WARM_FRAMES_TARGET / 2 })).toBeCloseTo(
      STAGE_PRIMES_END + (1 - STAGE_PRIMES_END) * 0.5,
      10,
    )
    expect(loadingProgress({ ...done, warmFrames: WARM_FRAMES_TARGET })).toBe(1)
    // Warm frames fed while primes are still queued must not inflate anything.
    const early = sample({ wallsVoxelized: 3, warmFrames: WARM_FRAMES_TARGET })
    expect(loadingProgress(early)).toBeLessThan(STAGE_WALLS_END)
  })
})

describe('cap and monotonicity (advanceProgress)', () => {
  test('the 4s cap reveals regardless of pending stages', () => {
    const stuck = sample({ elapsedMs: LOADING_CAP_MS })
    expect(advanceProgress(0.2, stuck)).toBe(1)
    expect(advanceProgress(0, sample({ snapshotDone: false, elapsedMs: LOADING_CAP_MS + 1 }))).toBe(
      1,
    )
  })

  test('below the cap, progress never runs backwards', () => {
    // The prime queue PEAK grows while the drain runs — the raw signal can
    // wobble down; advanceProgress must clamp it.
    const before = sample({
      wallsVoxelized: 12,
      primeQueuePeak: 4,
      primeQueueRemaining: 1, // drained 3/4 → high raw fraction
    })
    const after = sample({
      wallsVoxelized: 12,
      primeQueuePeak: 12, // prevoxelize enqueued 8 more
      primeQueueRemaining: 8, // drained 4/12 → LOWER raw fraction
    })
    expect(loadingProgress(after)).toBeLessThan(loadingProgress(before))
    const p1 = advanceProgress(0, before)
    const p2 = advanceProgress(p1, after)
    expect(p2).toBeGreaterThanOrEqual(p1)
  })

  test('a full entry sequence is monotonic end to end', () => {
    const timeline: LoadingSample[] = [
      sample({ snapshotDone: true, wallsVoxelized: 0 }),
      sample({ wallsVoxelized: 4, primeQueuePeak: 2, primeQueueRemaining: 2 }),
      sample({ wallsVoxelized: 9, primeQueuePeak: 9, primeQueueRemaining: 7 }),
      sample({ wallsVoxelized: 12, primeQueuePeak: 14, primeQueueRemaining: 9 }),
      sample({
        wallsVoxelized: 12,
        prevoxelizeDone: true,
        primeQueuePeak: 14,
        primeQueueRemaining: 3,
      }),
      sample({
        wallsVoxelized: 12,
        prevoxelizeDone: true,
        primeQueuePeak: 14,
        primeQueueRemaining: 0,
        warmFrames: 8,
      }),
      sample({
        wallsVoxelized: 12,
        prevoxelizeDone: true,
        primeQueuePeak: 14,
        primeQueueRemaining: 0,
        warmFrames: WARM_FRAMES_TARGET,
      }),
    ]
    let p = 0
    for (const s of timeline) {
      const next = advanceProgress(p, s)
      expect(next).toBeGreaterThanOrEqual(p)
      expect(next).toBeLessThanOrEqual(1)
      p = next
    }
    expect(p).toBe(1)
  })
})

describe('pendingLabel', () => {
  test('names each unfinished stage, empty once everything is done', () => {
    expect(pendingLabel(sample({ wallsVoxelized: 3 }))).toContain('prevoxelize (walls 3/12)')
    expect(pendingLabel(sample({ primeQueueRemaining: 5, primeQueuePeak: 8 }))).toContain(
      'dormant primes (5 queued)',
    )
    const warmPending = sample({
      wallsVoxelized: 12,
      prevoxelizeDone: true,
      primeQueuePeak: 8,
      primeQueueRemaining: 0,
      warmFrames: 4,
    })
    expect(pendingLabel(warmPending)).toContain(`warm frames (4/${WARM_FRAMES_TARGET})`)
    expect(pendingLabel({ ...warmPending, warmFrames: WARM_FRAMES_TARGET })).toBe('')
  })
})

describe('bar write throttle (one element, width%-only, ≤ 10 Hz)', () => {
  test('same whole percent never writes (change gate)', () => {
    expect(shouldWriteBar(0, 42, 10_000, 0.425)).toBe(false)
    expect(shouldWriteBar(0, 42, 10_000, 0.429)).toBe(false)
  })

  test('a changed percent inside the 10 Hz window is held back', () => {
    expect(shouldWriteBar(1000, 40, 1000 + BAR_MIN_INTERVAL_MS - 1, 0.45)).toBe(false)
    expect(shouldWriteBar(1000, 40, 1000 + BAR_MIN_INTERVAL_MS, 0.45)).toBe(true)
  })

  test('the final write always lands — the reveal never waits on the interval', () => {
    expect(shouldWriteBar(1000, 97, 1001, 1)).toBe(true)
    expect(shouldWriteBar(1000, 97, 1001, 1.2)).toBe(true)
    // …but not if 100% was already written.
    expect(shouldWriteBar(1000, 100, 1001, 1)).toBe(false)
  })

  test('barPercent quantizes to whole floored percents, clamped', () => {
    expect(barPercent(0)).toBe(0)
    expect(barPercent(0.559)).toBe(55)
    expect(barPercent(1)).toBe(100)
    expect(barPercent(1.5)).toBe(100)
    expect(barPercent(-0.2)).toBe(0)
  })
})
