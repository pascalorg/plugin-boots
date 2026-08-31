import { describe, expect, test } from 'bun:test'
import { FRESH_BVH_DRAIN, stepBvhDrain } from './warmup'

/**
 * THE MAIN-THREAD BVH DRAIN, AND WHEN IT MUST NOT RUN.
 *
 * warmup.tsx walks the collider list touching each lazy `bvh` getter a few
 * milliseconds per frame, so the builds dissolve into the gear-up beat instead of
 * landing inside the first shot. world.ts's prime queue builds the SAME set in a
 * worker, off the main thread — and while the worker was dead in production
 * (2026-08-29 → 08-31) this loop was the only thing filling the cache, which is
 * part of why nothing felt wrong. With the worker alive it still won the race:
 * the owner's scene has 122 collider geometries and the worker had built 7.
 *
 * Hence the yield. These tests are over the pure step, because the useFrame body
 * cannot be run without a renderer, and every one of the drain's rules —
 * budget, cursor, disabled, mid-session arrivals — had no coverage at all.
 */

type FakeCollider = { id: number; disabled?: boolean }

/** A clock that advances only when told, so "the budget ran out" is a decision
 * of the test and not of the machine it runs on. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function colliders(count: number, disabled: number[] = []): FakeCollider[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    ...(disabled.includes(id) ? { disabled: true } : {}),
  }))
}

describe('stepBvhDrain — yielding to the worker', () => {
  test('touches nothing while the prime queue is still working', () => {
    const list = colliders(5)
    const touched: number[] = []
    const state = stepBvhDrain({
      colliders: list,
      state: FRESH_BVH_DRAIN,
      priming: true,
      budgetMs: 4,
      now: fakeClock().now,
      touch: (c) => touched.push(c.id),
    })
    // The whole point: not one main-thread build while the worker has the queue.
    expect(touched).toEqual([])
    // And no progress is claimed — the cursor is where it was, so the drain
    // still owns everything the queue may fail to reach.
    expect(state).toEqual(FRESH_BVH_DRAIN)
  })

  test('drains the rest as soon as the queue stops — a broken worker is covered', () => {
    const list = colliders(3)
    const touched: number[] = []
    const clock = fakeClock()
    const step = (priming: boolean, state = FRESH_BVH_DRAIN) =>
      stepBvhDrain({
        colliders: list,
        state,
        priming,
        budgetMs: 4,
        now: clock.now,
        touch: (c) => touched.push(c.id),
      })
    const yielded = step(true)
    // The worker breaks: world.ts clears `priming` with the cache still cold.
    const drained = step(false, yielded)
    expect(touched).toEqual([0, 1, 2])
    expect(drained.done).toBe(true)
  })
})

describe('stepBvhDrain — the budget and the cursor', () => {
  test('stops at the budget and resumes where it stopped', () => {
    const list = colliders(6)
    const touched: number[] = []
    const clock = fakeClock()
    // Each touch costs 1.5 ms of a 4 ms budget: three fit (the check is before
    // the touch, so the third starts at 3.0 ms and the fourth never starts).
    const run = (state: typeof FRESH_BVH_DRAIN) =>
      stepBvhDrain({
        colliders: list,
        state,
        priming: false,
        budgetMs: 4,
        now: clock.now,
        touch: (c) => {
          touched.push(c.id)
          clock.advance(1.5)
        },
      })

    const first = run(FRESH_BVH_DRAIN)
    expect(touched).toEqual([0, 1, 2])
    expect(first).toEqual({ cursor: 3, done: false, seenTail: undefined })

    // Next frame: a fresh budget from the current clock reading.
    const second = run(first)
    expect(touched).toEqual([0, 1, 2, 3, 4, 5])
    expect(second.done).toBe(true)
    expect(second.seenTail).toBe(list[5])
  })

  test('skips disabled colliders but still walks past them', () => {
    // A voxelized node handed collision to its grid; building a BVH for the
    // hidden host mesh would be work nothing can ever use.
    const list = colliders(4, [1, 2])
    const touched: number[] = []
    const state = stepBvhDrain({
      colliders: list,
      state: FRESH_BVH_DRAIN,
      priming: false,
      budgetMs: 4,
      now: fakeClock().now,
      touch: (c) => touched.push(c.id),
    })
    expect(touched).toEqual([0, 3])
    expect(state.done).toBe(true)
  })

  test('an empty world finishes without pretending it saw a tail', () => {
    const state = stepBvhDrain({
      colliders: [] as FakeCollider[],
      state: FRESH_BVH_DRAIN,
      priming: false,
      budgetMs: 4,
      now: fakeClock().now,
      touch: () => {
        throw new Error('nothing to touch')
      },
    })
    expect(state).toEqual({ cursor: 0, done: true, seenTail: undefined })
  })
})

describe('stepBvhDrain — colliders that arrive mid-session', () => {
  test('a finished drain costs one identity compare and re-opens on a new tail', () => {
    const list = colliders(2)
    const touched: number[] = []
    const clock = fakeClock()
    const run = (state: typeof FRESH_BVH_DRAIN) =>
      stepBvhDrain({
        colliders: list,
        state,
        priming: false,
        budgetMs: 4,
        now: clock.now,
        touch: (c) => touched.push(c.id),
      })

    const finished = run(FRESH_BVH_DRAIN)
    expect(finished.done).toBe(true)
    // Idle frames touch nothing and return the SAME state object.
    expect(run(finished)).toBe(finished)
    expect(touched).toEqual([0, 1])

    // The item GLB lands: proxy out, model in — same length, new tail.
    list.splice(1, 1)
    list.push({ id: 99 })
    const reopened = run(finished)
    // Re-walked from 0, because a splice can land new entries BELOW the cursor.
    // Re-touching a built one is a WeakMap hit, so the cost is the arrival's.
    expect(touched).toEqual([0, 1, 0, 99])
    expect(reopened.done).toBe(true)
    expect(reopened.seenTail).toBe(list[1])
  })

  test('a re-opened drain still yields to a queue that started meanwhile', () => {
    // Re-entering the game (Esc → Jump in) starts a new prime queue while the
    // previous session's drain state says "done". The tail check must not
    // smuggle main-thread builds past the yield.
    const list = colliders(2)
    const touched: number[] = []
    const finished = stepBvhDrain({
      colliders: list,
      state: FRESH_BVH_DRAIN,
      priming: false,
      budgetMs: 4,
      now: fakeClock().now,
      touch: (c) => touched.push(c.id),
    })
    list.push({ id: 7 })
    const state = stepBvhDrain({
      colliders: list,
      state: finished,
      priming: true,
      budgetMs: 4,
      now: fakeClock().now,
      touch: (c) => touched.push(c.id),
    })
    expect(touched).toEqual([0, 1])
    // Re-opened (so the arrival is not forgotten) but nothing touched.
    expect(state.done).toBe(false)
    expect(state.cursor).toBe(0)
  })
})
