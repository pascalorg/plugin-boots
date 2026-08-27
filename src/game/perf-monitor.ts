'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect } from 'react'

/**
 * Lag recorder (owner request 2026-08-27): the owner plays on localhost,
 * we read the spikes afterwards — no profiler, no tooling, no overhead.
 *
 * One module singleton, driven by a single useFrame subscriber
 * (<PerfMonitor/>, default priority — it observes the same render loop the
 * game runs in). Per frame: one Float32Array ring write (60 s at 60 fps),
 * one exponential-mean update, one threshold compare. ZERO allocations on
 * the frame path — spike entries are per-spike, and spikes are by
 * definition rare.
 *
 * SPIKE LOG: a frame whose delta exceeds max(3 × rolling mean, 50 ms) is
 * recorded as a compact `{t, delta, mean, tag}` row (bounded at 200,
 * oldest dropped). `tag` attributes the spike to the most recent
 * `perfEvent(name)` within the last 500 ms of wall clock — systems mark
 * their expensive moments (detonation, first trigger, voxelize burst…)
 * with one-line calls, and the log names the culprit for free. perfEvent
 * outside a session is two variable writes — safe anywhere, always.
 *
 * READOUT: `perfSnapshot()` (surfaced on the `__boots` handle as
 * `perf: () => perfSnapshot()`) computes mean/p95/worst over the ring
 * window on demand and hands out COPIES, never live refs. `perfReset()`
 * starts a fresh trace. The component also dumps
 * `console.info('[boots] perf', summary)` on unmount, so every play
 * session ends with a readable trace in the console without asking.
 *
 * Dependency-free pure math — nothing here renders, allocates per frame,
 * or touches the scene store (WebGPU-irrelevant by construction).
 */

/** Ring capacity — 60 s of history at 60 fps. p95/worst read this window. */
const RING_CAPACITY = 3600
/** Exponential rolling-mean weight — ~1 s half-life at 60 fps. */
const MEAN_ALPHA = 0.02
/** A spike is a delta beyond BOTH bars: 3× the rolling mean… */
const SPIKE_FACTOR = 3
/** …and an absolute floor (ms) so a quiet 60 fps scene doesn't log 17 ms
 * frames as "spikes" just because the mean sits at 5 ms. */
const SPIKE_FLOOR_MS = 50
/** Spike log bound — oldest entries drop beyond this. */
const SPIKE_CAP = 200
/** Wall-clock window (ms) inside which the latest perfEvent tags a spike. */
const EVENT_WINDOW_MS = 500

export type PerfSpike = {
  /** Game elapsed (s) at the spike frame — the sum of recorded deltas. */
  t: number
  /** The offending frame delta (ms). */
  delta: number
  /** Rolling mean (ms) BEFORE this frame folded in — the threshold base. */
  mean: number
  /** Most recent perfEvent within EVENT_WINDOW_MS, or '' (untagged). */
  tag: string
}

export type PerfSummary = {
  /** Frames recorded since the last reset (ring keeps the newest 3600). */
  frames: number
  /** Rolling exponential mean (ms). */
  mean: number
  /** 95th-percentile delta (ms) over the ring window. */
  p95: number
  /** Worst delta (ms) over the ring window. */
  worst: number
  /** Copies of the spike log, oldest first. */
  spikes: PerfSpike[]
}

export type FrameStats = {
  /** Fold one frame delta (ms) into the ring/mean and spike-test it. */
  recordFrame: (deltaMs: number) => void
  /** Mark "an expensive thing just started/happened" for spike tagging. */
  event: (name: string) => void
  /** On-demand summary — copies, never live refs. */
  stats: () => PerfSummary
  /** Drop everything (ring, mean, elapsed, spikes, event memory). */
  reset: () => void
}

/** `now` is injectable for tests; defaults to the wall clock. It only
 * feeds the event-tag window — frame timing comes from the deltas. */
export function createFrameStats(now: () => number = () => performance.now()): FrameStats {
  const ring = new Float32Array(RING_CAPACITY)
  let head = 0
  let count = 0
  let frames = 0
  let mean = 0
  let elapsed = 0
  let lastEventName = ''
  let lastEventAt = Number.NEGATIVE_INFINITY
  const spikes: PerfSpike[] = []

  const recordFrame = (deltaMs: number): void => {
    elapsed += deltaMs / 1000
    if (frames === 0) {
      // Seed: the first frame IS the history — and never a spike (there is
      // no baseline to spike against; session frame #1 is a load frame).
      mean = deltaMs
    } else {
      if (deltaMs > Math.max(mean * SPIKE_FACTOR, SPIKE_FLOOR_MS)) {
        if (spikes.length >= SPIKE_CAP) spikes.shift()
        spikes.push({
          t: elapsed,
          delta: deltaMs,
          mean,
          tag: now() - lastEventAt <= EVENT_WINDOW_MS ? lastEventName : '',
        })
      }
      mean += MEAN_ALPHA * (deltaMs - mean)
    }
    ring[head] = deltaMs
    head = (head + 1) % RING_CAPACITY
    if (count < RING_CAPACITY) count++
    frames++
  }

  const stats = (): PerfSummary => {
    // On-demand only (never per frame) — a sorted copy of the live window
    // is the simplest correct p95, and 3600 numbers sort in microseconds.
    const window: number[] = []
    for (let i = 0; i < count; i++) window.push(ring[i]!)
    window.sort((a, b) => a - b)
    return {
      frames,
      mean,
      p95: count > 0 ? window[Math.min(count - 1, Math.ceil(count * 0.95) - 1)]! : 0,
      worst: count > 0 ? window[count - 1]! : 0,
      spikes: spikes.map((spike) => ({ ...spike })),
    }
  }

  return {
    recordFrame,
    event: (name: string) => {
      lastEventName = name
      lastEventAt = now()
    },
    stats,
    reset: () => {
      head = 0
      count = 0
      frames = 0
      mean = 0
      elapsed = 0
      lastEventName = ''
      lastEventAt = Number.NEGATIVE_INFINITY
      spikes.length = 0
    },
  }
}

// --- Module singleton (the one the game wires into) --------------------------

const monitor = createFrameStats()

/** Tag the next ~500 ms of spikes with `name` — call at the START of an
 * expensive moment (detonation, first trigger, voxelize, GLB landing…).
 * Two variable writes; safe to call from anywhere, session or not. */
export function perfEvent(name: string): void {
  monitor.event(name)
}

/** The `__boots.perf()` payload — computed on demand, copies only. */
export function perfSnapshot(): PerfSummary {
  return monitor.stats()
}

/** Start a fresh trace (also exposed on the `__boots` handle). */
export function perfReset(): void {
  monitor.reset()
}

/**
 * The one frame driver. Mounts inside ActiveGame (sessions only): a fresh
 * trace per session, and unmounting — session exit — dumps the summary to
 * the console so a play session leaves a readable trace with zero tooling.
 * (Dev-only Fast Refresh remounts restart the trace; players never remount
 * mid-session — see ActiveGame's remount-healing note.)
 */
export function PerfMonitor(): null {
  useEffect(() => {
    monitor.reset()
    return () => {
      const summary = monitor.stats()
      if (summary.frames > 0) console.info('[boots] perf', summary)
    }
  }, [])
  // Default priority (0) — observe the loop, never reorder it.
  useFrame((_, rawDt) => {
    monitor.recordFrame(rawDt * 1000)
  })
  return null
}
