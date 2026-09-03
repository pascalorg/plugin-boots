/**
 * FRAME CRASH GUARD — per-site strike counters for useFrame subscribers.
 * ---------------------------------------------------------------------------
 * R3F's update() iterates its subscribers unguarded: one throwing subscriber
 * skips every subscriber after it AND the render, every frame, while the rAF
 * survives — a fullscreen session that freezes with the inputs swallowed. The
 * guard wraps a frame callback so a throw is caught, logged (budgeted), and
 * counted PER SITE: `FRAME_CRASH_LIMIT` consecutive throws at one site fire
 * the crash handler (the session installs `exitGame`) exactly once, then that
 * site's counter resets. A frame that completes resets ONLY its own site — a
 * swallowed throw in the Player must never wash out the Viewmodel's strikes,
 * and a healthy booster `advance` must never reset a site that is failing
 * inside it (that was the flaw of a single global counter).
 *
 * Pure: no three/R3F imports, no allocation on the happy path (the Map entry
 * for a site is created on its first crash only).
 */

import { perfEvent } from './perf-monitor'

/** Consecutive throws at ONE site before the crash handler fires. */
export const FRAME_CRASH_LIMIT = 3
/** console.error budget per site — after that the crash is perf-logged only. */
const LOG_BUDGET = 3

const strikes = new Map<string, number>()
const logged = new Map<string, number>()
let handler: (() => void) | null = null

/**
 * Install/clear the handler fired when a site reaches the limit (exitGame).
 * Installing one (a new session) also forgets every site's strikes AND its
 * console budget, so a session that crashed three times an hour ago does not
 * make this session's first crash silent in the console.
 */
export function setFrameCrashHandler(fn: (() => void) | null): void {
  handler = fn
  if (fn !== null) {
    strikes.clear()
    logged.clear()
  }
}

/**
 * Record a throw at `name`. Logs the first LOG_BUDGET occurrences per site,
 * always emits a perf event, and returns true when this strike reached the
 * limit — the caller fires the handler (guardedFrame does) and the site's
 * counter is reset so a survivor gets a fresh three strikes.
 */
export function reportFrameCrash(name: string, err: unknown): boolean {
  const n = (logged.get(name) ?? 0) + 1
  logged.set(name, n)
  if (n <= LOG_BUDGET) console.error('[boots] frame crash', name, err)
  perfEvent(`crash:${name}`)
  const count = (strikes.get(name) ?? 0) + 1
  if (count >= FRAME_CRASH_LIMIT) {
    strikes.set(name, 0)
    return true
  }
  strikes.set(name, count)
  return false
}

/** A frame at `name` completed: reset that site's consecutive-strike count only. */
export function frameOk(name: string): void {
  const pending = strikes.get(name)
  if (pending !== undefined && pending !== 0) strikes.set(name, 0)
}

/** Test hook: forget every site and the handler. */
export function resetFrameGuard(): void {
  strikes.clear()
  logged.clear()
  handler = null
}

/**
 * Wrap a useFrame callback `(state, dt)`: exceptions are swallowed and counted
 * per site, the limit fires the crash handler once. Fixed 2-arity on purpose —
 * a rest-args wrapper would allocate an array every frame. The wrapper is
 * created ONCE at the useFrame call — no per-frame closure.
 */
export function guardedFrame<S, D>(
  name: string,
  fn: (state: S, dt: D) => void,
): (state: S, dt: D) => void {
  return (state: S, dt: D) => {
    try {
      fn(state, dt)
      frameOk(name)
    } catch (e) {
      if (reportFrameCrash(name, e)) handler?.()
    }
  }
}
