'use client'

import { addAfterEffect, addEffect, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'

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
  /** Milliseconds of the spike frame spent INSIDE the R3F loop (subscribers
   * + render submit), when the loop-effect probes are wired (PerfMonitor
   * does). delta − cpu = outside-loop time: batched React flush (store
   * bumps commit at the microtask boundary AFTER the loop), GC, GPU sync. */
  cpu?: number
  /** Milliseconds of the spike frame's gl.render submit (PerfMonitor's
   * render wrap). cpu − render ≈ the frame's subscriber work. */
  render?: number
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
  /** Report the last completed loop's inside-the-loop duration (ms) — the
   * next spike row carries it as `cpu`. Optional; NaN clears. */
  frameCpu: (ms: number) => void
  /** Report the last render submit's duration (ms) — spike field `render`. */
  frameRender: (ms: number) => void
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

  let lastCpu = Number.NaN
  let lastRender = Number.NaN

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
          cpu: Number.isNaN(lastCpu) ? undefined : lastCpu,
          render: Number.isNaN(lastRender) ? undefined : lastRender,
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
    frameCpu: (ms: number) => {
      lastCpu = ms
    },
    frameRender: (ms: number) => {
      lastRender = ms
    },
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
      lastCpu = Number.NaN
      lastRender = Number.NaN
      spikes.length = 0
    },
  }
}

// --- Module singleton (the one the game wires into) --------------------------

const monitor = createFrameStats()

// --- Section stopwatch (boom decomposition, 2026-08-28 QA round) -------------
// perfEvent names a spike; perfSection says WHERE the milliseconds went.
// Callers time their own expensive phases (blast rings, glass, primes…) and
// fold the duration in here — accumulated totals + call counts, read on
// demand via `__boots.perfSections()`. Only rare moments call this (a blast
// pays a handful of Map hits), never the per-frame idle path.

const sectionTotals = new Map<string, { ms: number; calls: number }>()

/** Fold `ms` of work into section `name` (totals survive until perfReset). */
export function perfSection(name: string, ms: number): void {
  const slot = sectionTotals.get(name)
  if (slot) {
    slot.ms += ms
    slot.calls++
  } else {
    sectionTotals.set(name, { ms, calls: 1 })
  }
}

/** Copies of the accumulated section totals (QA introspection). */
export function perfSections(): Record<string, { ms: number; calls: number }> {
  const out: Record<string, { ms: number; calls: number }> = {}
  for (const [name, slot] of sectionTotals) out[name] = { ms: slot.ms, calls: slot.calls }
  return out
}

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
  sectionTotals.clear()
}

/**
 * The one frame driver. Mounts inside ActiveGame (sessions only): a fresh
 * trace per session, and unmounting — session exit — dumps the summary to
 * the console so a play session leaves a readable trace with zero tooling.
 * (Dev-only Fast Refresh remounts restart the trace; players never remount
 * mid-session — see ActiveGame's remount-healing note.)
 */
export function PerfMonitor(): null {
  const lastNow = useRef(0)
  const gl = useThree((s) => s.gl)
  // Render-submit probe: wrap the renderer's own render for the session —
  // pure CPU-side timing around the host's call, renderer-agnostic
  // (works the same on the WebGL fallback and WebGPU), restored on exit.
  useEffect(() => {
    type RenderFn = (...args: unknown[]) => unknown
    type RendererInfo = {
      programs?: unknown[]
      memory?: { geometries?: number; textures?: number }
      render?: { calls?: number; triangles?: number }
    }
    const holder = gl as unknown as { render: RenderFn; info?: RendererInfo }
    const original = holder.render
    // Previous-frame renderer counters as plain numbers — the fast path
    // stays allocation-free; strings only build on a slow submit.
    let pPrograms = -1
    let pGeoms = -1
    let pTex = -1
    let pCalls = -1
    let pTris = -1
    holder.render = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now()
      const out = original.apply(this, args)
      const dt = performance.now() - t0
      monitor.frameRender(dt)
      // Slow-submit forensics: what the renderer's own counters said on a
      // >30 ms submit vs the frame before — a programs jump = shader
      // compile, textures = upload, calls/triangles = raw draw volume.
      const info = holder.info
      if (info) {
        const programs = info.programs?.length ?? -1
        const geoms = info.memory?.geometries ?? -1
        const tex = info.memory?.textures ?? -1
        const calls = info.render?.calls ?? -1
        const tris = info.render?.triangles ?? -1
        if (dt > 30) {
          console.info(
            `[boots] slow render ${dt.toFixed(1)}ms — programs:${programs} geoms:${geoms} tex:${tex} calls:${calls} tris:${tris} (prev programs:${pPrograms} geoms:${pGeoms} tex:${pTex} calls:${pCalls} tris:${pTris})`,
          )
        }
        pPrograms = programs
        pGeoms = geoms
        pTex = tex
        pCalls = calls
        pTris = tris
      }
      return out
    }
    return () => {
      holder.render = original
    }
  }, [gl])
  useEffect(() => {
    monitor.reset()
    lastNow.current = 0
    // In-loop CPU probe: addEffect fires before the subscribers, then
    // addAfterEffect after the render submit — their span is the loop's
    // synchronous cost. What a spike's delta holds BEYOND that happened
    // outside the loop: the batched React flush of store bumps (microtask,
    // after the rAF callback), GC, or a GPU/compositor stall.
    let loopStart = 0
    const offStart = addEffect(() => {
      loopStart = performance.now()
      return true
    })
    const offEnd = addAfterEffect(() => {
      monitor.frameCpu(performance.now() - loopStart)
      return true
    })
    return () => {
      offStart()
      offEnd()
      const summary = monitor.stats()
      if (summary.frames > 0) console.info('[boots] perf', summary)
    }
  }, [])
  // Default priority (0) — observe the loop, never reorder it.
  // WALL-CLOCK deltas, not the useFrame dt: the host advances R3F through a
  // FrameLimiter in fixed quanta, so rawDt is a synthetic constant (exactly
  // 20 ms at the 50 fps default) no matter how long frames really take —
  // a recorder on that clock reads "all good" forever (perf investigation,
  // 2026-08-28). performance.now() between frames is the truth.
  useFrame(() => {
    const now = performance.now()
    if (lastNow.current > 0) monitor.recordFrame(now - lastNow.current)
    lastNow.current = now
  })
  return null
}
