import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  FRAME_CRASH_LIMIT,
  frameOk,
  guardedFrame,
  reportFrameCrash,
  resetFrameGuard,
  setFrameCrashHandler,
} from './frame-guard'

/**
 * Per-site strike counters: a throwing useFrame subscriber is caught and
 * counted by NAME, three consecutive throws at one site fire the crash
 * handler exactly once, a completed frame resets only its own site, and one
 * site's crashes never touch another's count (the global-counter flaw).
 */
describe('frame guard', () => {
  let errorSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    resetFrameGuard()
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
    resetFrameGuard()
  })

  test('two crashes then a good frame reset that site: no handler', () => {
    let fired = 0
    setFrameCrashHandler(() => fired++)
    expect(reportFrameCrash('player', new Error('a'))).toBe(false)
    expect(reportFrameCrash('player', new Error('b'))).toBe(false)
    frameOk('player')
    expect(reportFrameCrash('player', new Error('c'))).toBe(false)
    expect(reportFrameCrash('player', new Error('d'))).toBe(false)
    expect(fired).toBe(0)
  })

  test('three consecutive crashes fire the handler exactly once, then the site starts fresh', () => {
    let fired = 0
    setFrameCrashHandler(() => fired++)
    let boom = true
    const wrapped = guardedFrame<null, number>('player', () => {
      if (boom) throw new Error('kaboom')
    })
    for (let i = 0; i < FRAME_CRASH_LIMIT; i++) wrapped(null, 1 / 60)
    expect(fired).toBe(1)
    // Two more throws do not re-fire (fresh three strikes after the reset)…
    wrapped(null, 1 / 60)
    wrapped(null, 1 / 60)
    expect(fired).toBe(1)
    // …a good frame wipes them, and the wrapper keeps calling through.
    boom = false
    wrapped(null, 1 / 60)
    boom = true
    wrapped(null, 1 / 60)
    wrapped(null, 1 / 60)
    expect(fired).toBe(1)
    wrapped(null, 1 / 60)
    expect(fired).toBe(2)
  })

  test("a crash at site 'a' never advances or resets site 'b'", () => {
    let fired = 0
    setFrameCrashHandler(() => fired++)
    reportFrameCrash('b', new Error('1'))
    reportFrameCrash('b', new Error('2'))
    // 'a' crashing (and 'a' completing) must not touch b's two strikes.
    reportFrameCrash('a', new Error('x'))
    frameOk('a')
    expect(fired).toBe(0)
    expect(reportFrameCrash('b', new Error('3'))).toBe(true)
    // And b reaching the limit did not spend any of a's strikes: a was reset
    // by its own good frame, so it needs a full three again.
    expect(reportFrameCrash('a', new Error('y'))).toBe(false)
    expect(reportFrameCrash('a', new Error('z'))).toBe(false)
    expect(reportFrameCrash('a', new Error('w'))).toBe(true)
  })

  test('the wrapper passes (state, dt) through and returns to the caller on a good frame', () => {
    const seen: number[] = []
    const wrapped = guardedFrame<{ tag: string }, number>('vm', (s, dt) => {
      expect(s.tag).toBe('r3f')
      seen.push(dt)
    })
    wrapped({ tag: 'r3f' }, 0.016)
    wrapped({ tag: 'r3f' }, 0.017)
    expect(seen).toEqual([0.016, 0.017])
  })

  test('console.error budget stops at 3 per site; every crash still counts', () => {
    let fired = 0
    setFrameCrashHandler(() => fired++)
    for (let i = 0; i < 7; i++) reportFrameCrash('player', new Error(String(i)))
    expect(errorSpy).toHaveBeenCalledTimes(3)
    // 7 strikes = two limit hits (3, 6) with one strike pending.
    expect(fired).toBe(0) // reportFrameCrash only RETURNS true; guardedFrame fires.
    reportFrameCrash('viewmodel', new Error('other site logs on its own budget'))
    expect(errorSpy).toHaveBeenCalledTimes(4)
  })

  test('installing a handler (a new session) forgets old strikes AND re-arms the console budget', () => {
    let fired = 0
    setFrameCrashHandler(() => fired++)
    // Last session: two pending strikes and the whole console budget spent.
    for (let i = 0; i < 5; i++) reportFrameCrash('player', new Error(String(i)))
    expect(errorSpy).toHaveBeenCalledTimes(3)
    // Session teardown clears the handler (keeps nothing else) …
    setFrameCrashHandler(null)
    // … a new session installs one: its FIRST crash logs again and needs a
    // full three strikes (the two pending ones did not carry over).
    setFrameCrashHandler(() => fired++)
    expect(reportFrameCrash('player', new Error('fresh'))).toBe(false)
    expect(errorSpy).toHaveBeenCalledTimes(4)
    expect(reportFrameCrash('player', new Error('fresh 2'))).toBe(false)
    expect(reportFrameCrash('player', new Error('fresh 3'))).toBe(true)
    expect(fired).toBe(0) // reportFrameCrash only returns; guardedFrame fires
  })

  test('no handler installed: the limit is reached silently and the wrapper survives', () => {
    const wrapped = guardedFrame<null, number>('player', () => {
      throw new Error('always')
    })
    for (let i = 0; i < 10; i++) wrapped(null, 1 / 60)
    expect(errorSpy).toHaveBeenCalledTimes(3)
  })
})
