/**
 * Entry-loading progress — the pure math behind the veil's bar (owner
 * report 2026-08-28: "terrible lag when launching and the first 1s of
 * play — can't I get a loading bar that's quick but smooth?").
 *
 * Session entry front-loads REAL work: collectWorld (sync snapshot),
 * budgeted prevoxelize (walls awake + everything else dormant), the
 * dormant prime queue, and the serialized warm-draw GPU uploads
 * (150–327 ms frames measured on big scenes). The old veil faded on a
 * fixed 1.2 s clock and revealed mid-churn; this module maps the actual
 * pipeline onto one 0..1 signal so the veil lifts when play is smooth.
 *
 * WEIGHTED STAGES (sequential ranges, additive within):
 *   world snapshot committed .......... 0    → 0.15
 *   wall prevoxelize fraction ......... 0.15 → 0.55   (walls with targets / total walls)
 *   dormant prime queue drained ....... 0.55 → 0.85   (peak-relative; complete only
 *                                                      once prevoxelize is done — the
 *                                                      queue still GROWS until then)
 *   first warm frames after primes .... 0.85 → 1.0    (WARM_FRAMES_TARGET frames)
 *
 * CAP: `advanceProgress` snaps to 1 at LOADING_CAP_MS regardless — the
 * player is never trapped behind a wedged stage; the driver reports what
 * was still pending (pendingLabel) and hud.ts console.infos it.
 *
 * MONOTONIC: the prime fraction is peak-relative and the peak can grow
 * faster than the drain (prevoxelize keeps enqueueing), so the raw signal
 * may wobble down — `advanceProgress(prev, sample)` clamps to
 * max(prev, next) and is the only thing the driver feeds the bar.
 *
 * Dependency-free pure math — fully testable headless (loading.test.ts).
 *
 * CONFORMING SHELLS (S0) add NO stage weight: shell builds run INSIDE
 * ensureVoxelTarget's wall path (destruction.ts buildWallShell), on the
 * same 4 ms prevoxelize budget — the wall stage's fraction (walls with
 * targets / total walls) already carries their cost, amortized as a few
 * extra prevoxelize frames (~25–50 ms house-wide, flag ON only). A
 * separate weight would double-count work the wall counter is measuring.
 */

/** Never hold the veil longer than this, no matter what's pending. */
export const LOADING_CAP_MS = 4000

/** Warm frames counted after the primes drain before the veil lifts —
 * ~20 frames absorb the serialized warm-draw GPU uploads (one replica
 * upload per frame) plus the first steady renders. */
export const WARM_FRAMES_TARGET = 20

/** Stage boundaries (see header). */
export const STAGE_SNAPSHOT = 0.15
export const STAGE_WALLS_END = 0.55
export const STAGE_PRIMES_END = 0.85

/** Prime-stage fraction ceiling while prevoxelize is still enqueueing —
 * an empty-for-now queue must not read as "primes done" mid-build. */
const PRIME_FRAC_OPEN_CEIL = 0.95

/** One sample of the entry pipeline, as the game-root driver sees it. */
export type LoadingSample = {
  /** collectWorld's snapshot committed (true from the driver's first frame). */
  snapshotDone: boolean
  /** world.walls.size — the prevoxelize wall population. */
  wallsTotal: number
  /** Walls with a destruction target already built (useDestruction targets). */
  wallsVoxelized: number
  /** Zero-budget prevoxelizeTick probe: every snapshot node has a target. */
  prevoxelizeDone: boolean
  /** Highest dormantPrimeQueueSize() seen so far (driver-tracked). */
  primeQueuePeak: number
  /** dormantPrimeQueueSize() right now. */
  primeQueueRemaining: number
  /** Frames elapsed AFTER the primes drained (driver counts them). */
  warmFrames: number
  /** Wall-clock ms since the driver's first sample. */
  elapsedMs: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** True once prevoxelize finished AND the prime queue is empty — the gate
 * for the warm-frame stage (and the driver's warm-frame counter). */
export function primesDone(s: LoadingSample): boolean {
  return s.prevoxelizeDone && s.primeQueueRemaining === 0
}

/**
 * Raw weighted progress for one sample, 0..1. NOT cap- or monotonicity-
 * aware on its own — drivers go through advanceProgress.
 */
export function loadingProgress(s: LoadingSample): number {
  if (!s.snapshotDone) return 0

  // Walls: fraction voxelized; a wall-less lot (or a finished prevoxelize
  // pass, which is strictly stronger) completes the stage outright.
  const wallFrac =
    s.prevoxelizeDone || s.wallsTotal <= 0 ? 1 : clamp01(s.wallsVoxelized / s.wallsTotal)

  // Primes: peak-relative drain. Complete ONLY once prevoxelize stopped
  // enqueueing and the queue is empty; while open, cap below 1 so an
  // instantaneous empty queue can't fake completion.
  let primeFrac: number
  if (primesDone(s)) primeFrac = 1
  else if (s.primeQueuePeak <= 0) primeFrac = 0
  else
    primeFrac = Math.min(
      PRIME_FRAC_OPEN_CEIL,
      clamp01((s.primeQueuePeak - s.primeQueueRemaining) / s.primeQueuePeak),
    )

  // Warm frames only count after the primes drained — a driver that
  // (wrongly) fed early frames still can't inflate the signal.
  const warmFrac = primesDone(s) ? clamp01(s.warmFrames / WARM_FRAMES_TARGET) : 0

  return (
    STAGE_SNAPSHOT +
    (STAGE_WALLS_END - STAGE_SNAPSHOT) * wallFrac +
    (STAGE_PRIMES_END - STAGE_WALLS_END) * primeFrac +
    (1 - STAGE_PRIMES_END) * warmFrac
  )
}

/**
 * The driver-facing step: monotonic (never below `prev`) and cap-aware
 * (snaps to 1 at LOADING_CAP_MS — never trap the player). This is the
 * only value that reaches the bar.
 */
export function advanceProgress(prev: number, s: LoadingSample): number {
  if (s.elapsedMs >= LOADING_CAP_MS) return 1
  return Math.max(prev, Math.min(1, loadingProgress(s)))
}

/**
 * Compact "what's still pending" line for the cap console.info — '' once
 * every stage is complete (a reveal with a non-empty label WAS a cap).
 */
export function pendingLabel(s: LoadingSample): string {
  const parts: string[] = []
  if (!s.snapshotDone) parts.push('world snapshot')
  if (!s.prevoxelizeDone) parts.push(`prevoxelize (walls ${s.wallsVoxelized}/${s.wallsTotal})`)
  if (!primesDone(s)) parts.push(`dormant primes (${s.primeQueueRemaining} queued)`)
  else if (s.warmFrames < WARM_FRAMES_TARGET)
    parts.push(`warm frames (${s.warmFrames}/${WARM_FRAMES_TARGET})`)
  return parts.join(', ')
}

// ── Bar write throttle ──────────────────────────────────────────────────────

/** Minimum ms between bar DOM writes — at most 10 Hz. */
export const BAR_MIN_INTERVAL_MS = 100

/** Whole-percent quantization for the bar width (the change gate's unit). */
export function barPercent(progress: number): number {
  return Math.min(100, Math.max(0, Math.floor(progress * 100)))
}

/**
 * Should this progress value hit the DOM? One element, width%-only, at
 * most 10 Hz, change-gated on whole percents — the final write (>= 1)
 * always lands so the reveal never waits on the interval.
 */
export function shouldWriteBar(
  lastWriteAtMs: number,
  lastWrittenPct: number,
  nowMs: number,
  progress: number,
): boolean {
  if (barPercent(progress) === lastWrittenPct) return false
  if (progress >= 1) return true
  return nowMs - lastWriteAtMs >= BAR_MIN_INTERVAL_MS
}
