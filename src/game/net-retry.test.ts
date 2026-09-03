import { describe, expect, test } from 'bun:test'
import { NET_RETRY_MS, untilNet } from './net-retry'

/**
 * The bind-retry contract (see net-retry.ts): the host's collab bus lands
 * asynchronously, so both multiplayer lifecycles bind through `untilNet`.
 * These pin the three shapes the callers rely on — immediate success schedules
 * nothing, late success runs `onReady` exactly once, and cancel before success
 * means `onReady` never runs — with real timers at a short interval, so the
 * behaviour under test is the one the browser sees.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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
      5,
    )
    expect(starts).toBe(1)
    expect(ready).toBe(1)
    await sleep(30)
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
      5,
    )
    expect(starts).toBe(1)
    expect(ready).toBe(0)
    await sleep(25)
    expect(starts).toBeGreaterThan(1) // it kept asking
    expect(ready).toBe(0) // …but never claimed readiness
    bus = true
    await sleep(25)
    expect(ready).toBe(1)
    const settled = starts
    await sleep(25)
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
      5,
    )
    await sleep(15)
    cancel()
    const atCancel = starts
    await sleep(25)
    expect(starts).toBe(atCancel)
    expect(ready).toBe(0)
    expect(() => cancel()).not.toThrow() // idempotent
  })

  test('onReady is optional', async () => {
    let bus = false
    const cancel = untilNet(() => bus, undefined, 5)
    bus = true
    await sleep(20)
    expect(() => cancel()).not.toThrow()
  })
})
