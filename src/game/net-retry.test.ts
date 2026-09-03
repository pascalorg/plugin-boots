import { describe, expect, test } from 'bun:test'
import { NET_RETRY_MS, untilNet } from './net-retry'

/**
 * The bind-retry contract (see net-retry.ts): the host's collab bus lands
 * asynchronously, so both multiplayer lifecycles bind through `untilNet`.
 * These pin the three shapes the callers rely on — immediate success schedules
 * nothing, late success runs `onReady` exactly once, and cancel before success
 * means `onReady` never runs — with real timers at a short interval, so the
 * behaviour under test is the one the browser sees.
 *
 * Timing discipline: every POSITIVE expectation ("it kept asking", "onReady
 * ran") is polled up to a bounded deadline instead of read after a fixed nap —
 * a loaded CI box (or a machine running seven builders) can stall a 5 ms
 * interval for tens of milliseconds. Every NEGATIVE expectation ("nothing else
 * fired") waits a window ≥ 12 interval periods, so a timer that was NOT
 * cleared would have to fire many times to slip through.
 */

/** The retry interval under test (ms) — short, so the suite stays fast. */
const STEP_MS = 5
/** A window long enough that an un-cleared STEP_MS interval fires ≥ 12 times. */
const QUIET_MS = 60
/** Upper bound on how long a polled condition may take (ms). */
const DEADLINE_MS = 2000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Poll `cond` every 2 ms until it holds; throws past the deadline. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > DEADLINE_MS) throw new Error(`timed out waiting for: ${what}`)
    await sleep(2)
  }
}

describe('untilNet (bus-bind retry)', () => {
  test('cadence is one poll per second — cheap enough to run forever without a bus', () => {
    expect(NET_RETRY_MS).toBe(1000)
  })

  test('bus already there: start once, onReady once, nothing scheduled', async () => {
    let starts = 0
    let ready = 0
    const cancel = untilNet(
      () => {
        starts++
        return true
      },
      () => ready++,
      STEP_MS,
    )
    expect(starts).toBe(1)
    expect(ready).toBe(1)
    await sleep(QUIET_MS)
    expect(starts).toBe(1) // no interval was armed
    expect(ready).toBe(1)
    expect(() => cancel()).not.toThrow()
  })

  test('bus lands later: keeps trying, then onReady exactly once and stops', async () => {
    let bus = false
    let starts = 0
    let ready = 0
    const cancel = untilNet(
      () => {
        starts++
        return bus
      },
      () => ready++,
      STEP_MS,
    )
    expect(starts).toBe(1)
    expect(ready).toBe(0)
    await until(() => starts >= 3, 'the retry interval to keep asking') // it kept asking
    expect(ready).toBe(0) // …but never claimed readiness
    bus = true
    await until(() => ready === 1, 'onReady after the bus landed')
    const settled = starts
    await sleep(QUIET_MS)
    expect(starts).toBe(settled) // interval cleared on success
    expect(ready).toBe(1)
    cancel()
  })

  test('cancel before the bus arrives: no more starts, onReady never', async () => {
    let starts = 0
    let ready = 0
    const cancel = untilNet(
      () => {
        starts++
        return false
      },
      () => ready++,
      STEP_MS,
    )
    // Cancel only once the interval is provably running (≥ 1 retry landed).
    await until(() => starts >= 2, 'the retry interval to be running')
    cancel()
    const atCancel = starts
    await sleep(QUIET_MS)
    expect(starts).toBe(atCancel)
    expect(ready).toBe(0)
    expect(() => cancel()).not.toThrow() // idempotent
  })

  test('onReady is optional', async () => {
    let bus = false
    let starts = 0
    const cancel = untilNet(
      () => {
        starts++
        return bus
      },
      undefined,
      STEP_MS,
    )
    bus = true
    // With no onReady the only observable is that the interval stops itself.
    await until(() => starts >= 2, 'the success poll')
    const settled = starts
    await sleep(QUIET_MS)
    expect(starts).toBe(settled)
    expect(() => cancel()).not.toThrow()
  })
})
