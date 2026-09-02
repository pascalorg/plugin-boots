import { describe, expect, test } from 'bun:test'
import {
  anchorsAgree,
  laddersAgree,
  newSettleMemory,
  readingKey,
  SETTLE_MAX_REANCHORS,
  SETTLE_MAX_RECOLLECTS,
  SETTLE_QUIET_CHECKS,
  SETTLE_STABLE_CHECKS,
  SETTLE_WINDOW_MS,
  type SettleMemory,
  type SettleReading,
  settleDrifted,
  settleStep,
} from './entry-settle'

/**
 * ENTRY-SNAPSHOT SELF-CORRECTION (entry-settle.ts). The live bug this encodes: a
 * late joiner collected its world while the scene was still arriving, derived
 * the build lattice from a level-LOCAL point (wall roots still at identity),
 * published a stamp ~15 m off the lot, and had every peer's slot-addressed
 * piece refused for the session. The watcher polls what it WOULD publish
 * against what it DID, and corrects once the readings stop moving.
 *
 * The guards are the point of the suite: moving the lattice under pieces that
 * are already addressed in it would relocate them, and a re-collect drops
 * destruction. Both are refused, capped, and reported.
 */

const A = { x: 19.602, yaw: 0, z: -11.249 } // the settled frame (client A)
const LOCAL = { x: 4.177, yaw: 0, z: -15.425 } // what the late joiner published
const LADDER = [0, 2.5, 5, 7.5]

function reading(over: Partial<SettleReading> = {}): SettleReading {
  return {
    collectedWalls: 347,
    elapsedMs: 400,
    hasDamage: false,
    hasPieces: false,
    hasSlotPieces: false,
    installed: A,
    installedLadder: LADDER,
    live: A,
    liveLadder: LADDER,
    liveWalls: 347,
    ...over,
  }
}

/** Run the watcher over the same reading until it acts (or gives up). */
function drive(
  r: SettleReading,
  mem: SettleMemory = newSettleMemory(),
  rounds = 6,
): { actions: string[]; mem: SettleMemory } {
  const actions: string[] = []
  let carried = mem
  for (let n = 0; n < rounds; n++) {
    const step = settleStep(r, carried)
    carried = step.mem
    actions.push(step.action)
  }
  return { actions, mem: carried }
}

describe('anchor/ladder agreement', () => {
  test('millimetre noise is the same lattice (the stamp quantizes it away)', () => {
    expect(anchorsAgree(A, { x: A.x + 0.001, yaw: 0.0001, z: A.z - 0.001 })).toBe(true)
  })

  test('the measured late-joiner offset is NOT the same lattice', () => {
    expect(anchorsAgree(A, LOCAL)).toBe(false)
  })

  test('yaw alone splits a lattice (slots rotate about the anchor)', () => {
    expect(anchorsAgree(A, { ...A, yaw: 0.02 })).toBe(false)
  })

  test('two nulls agree; one null does not', () => {
    expect(anchorsAgree(null, null)).toBe(true)
    expect(anchorsAgree(A, null)).toBe(false)
    expect(laddersAgree(null, null)).toBe(true)
    expect(laddersAgree(LADDER, null)).toBe(false)
  })

  test('a ladder short a rung disagrees (it is in the stamp preimage)', () => {
    expect(laddersAgree(LADDER, [0, 2.5, 5])).toBe(false)
    expect(laddersAgree(LADDER, [0, 2.5, 5, 7.5001])).toBe(true)
  })
})

describe('drift detection', () => {
  test('a matching reading is not drift', () => {
    expect(settleDrifted(reading())).toBe(false)
  })

  test('the late-joiner anchor is drift', () => {
    expect(settleDrifted(reading({ installed: LOCAL, live: A }))).toBe(true)
  })

  test('a snapshot short of walls is drift even when the frame agrees', () => {
    expect(settleDrifted(reading({ collectedWalls: 236, liveWalls: 347 }))).toBe(true)
  })

  test('a snapshot with MORE walls than the live registry is not drift', () => {
    // Walls die during play (a levelled wall leaves the registry). The
    // snapshot is allowed to be the larger set — that is not an early collect.
    expect(settleDrifted(reading({ collectedWalls: 347, liveWalls: 340 }))).toBe(false)
  })

  test('the stability key tracks the live side only', () => {
    const one = reading({ installed: LOCAL })
    const two = reading({ installed: A })
    expect(readingKey(one)).toBe(readingKey(two))
    expect(readingKey(reading({ live: LOCAL }))).not.toBe(readingKey(one))
  })
})

describe('the late-joiner correction', () => {
  test('waits for consecutive identical readings, then re-anchors once', () => {
    const r = reading({ installed: LOCAL, live: A })
    const { actions, mem } = drive(r, newSettleMemory(), SETTLE_STABLE_CHECKS + 1)
    expect(actions.slice(0, SETTLE_STABLE_CHECKS - 1)).toEqual(
      Array(SETTLE_STABLE_CHECKS - 1).fill('wait'),
    )
    expect(actions[SETTLE_STABLE_CHECKS - 1]).toBe('reanchor')
    expect(mem.reanchors).toBeGreaterThanOrEqual(1)
  })

  test('a scene still moving never gets acted on', () => {
    // Each sample derives a different live anchor: the transforms are landing.
    let mem = newSettleMemory()
    for (let n = 0; n < 8; n++) {
      const step = settleStep(
        reading({ installed: LOCAL, live: { x: 4 + n, yaw: 0, z: -15 } }),
        mem,
      )
      mem = step.mem
      expect(step.action).toBe('wait')
    }
  })

  test('re-anchoring is REFUSED while a slot-addressed piece exists', () => {
    // The slot id is an address in the lattice being replaced.
    const r = reading({ hasPieces: true, hasSlotPieces: true, installed: LOCAL, live: A })
    const { actions, mem } = drive(r)
    expect(actions).toContain('blocked')
    expect(mem.reanchors).toBe(0)
    expect(mem.done).toBe(true)
  })

  test('a free-standing piece does not block the frame correction', () => {
    const r = reading({ hasPieces: true, hasSlotPieces: false, installed: LOCAL, live: A })
    expect(drive(r).actions).toContain('reanchor')
  })

  test('caps at SETTLE_MAX_REANCHORS, then blocks', () => {
    const r = reading({ installed: LOCAL, live: A })
    const { actions, mem } = drive(r, newSettleMemory(), 40)
    expect(mem.reanchors).toBe(SETTLE_MAX_REANCHORS)
    expect(actions.filter((a) => a === 'reanchor').length).toBe(SETTLE_MAX_REANCHORS)
    expect(actions).toContain('blocked')
  })
})

describe('the missing-walls correction', () => {
  test('a short snapshot re-collects when nothing is at stake', () => {
    const r = reading({ collectedWalls: 236, installed: LOCAL, live: A, liveWalls: 347 })
    const { actions, mem } = drive(r, newSettleMemory(), SETTLE_STABLE_CHECKS)
    expect(actions[SETTLE_STABLE_CHECKS - 1]).toBe('recollect')
    expect(mem.recollects).toBe(SETTLE_MAX_RECOLLECTS)
    // The re-collect re-derives the frame on its own — no re-anchor spent.
    expect(mem.reanchors).toBe(0)
  })

  test('damage refuses the re-collect but still allows the cheap fix', () => {
    const r = reading({ collectedWalls: 236, hasDamage: true, installed: LOCAL, live: A, liveWalls: 347 })
    const { actions, mem } = drive(r, newSettleMemory(), SETTLE_STABLE_CHECKS)
    expect(actions[SETTLE_STABLE_CHECKS - 1]).toBe('reanchor')
    expect(mem.recollects).toBe(0)
  })

  test('walls short, frame already right, damage present → blocked, not thrash', () => {
    const r = reading({ collectedWalls: 236, hasDamage: true, liveWalls: 347 })
    const { actions, mem } = drive(r)
    expect(actions).toContain('blocked')
    expect(mem.done).toBe(true)
    expect(mem.recollects).toBe(0)
    expect(mem.reanchors).toBe(0)
  })
})

describe('the window', () => {
  test('an agreeing session keeps watching, then leaves on quiet', () => {
    // Not on the first agreeing sample: the transforms that broke the late
    // joiner landed SECONDS after entry, and until then it agreed with itself.
    let mem = newSettleMemory()
    for (let n = 1; n < SETTLE_QUIET_CHECKS; n++) {
      const step = settleStep(reading({ elapsedMs: n * 400 }), mem)
      expect(step.action).toBe('wait')
      expect(step.mem.done).toBe(false)
      mem = step.mem
    }
    const last = settleStep(reading({ elapsedMs: SETTLE_QUIET_CHECKS * 400 }), mem)
    // Quiet is not done: the watch slows to a sentinel, only the window ends it.
    expect(last.action).toBe('quiet')
    expect(last.mem.quiet).toBe(true)
    expect(last.mem.done).toBe(false)
    const later = settleStep(reading({ elapsedMs: SETTLE_QUIET_CHECKS * 400 + 2000 }), last.mem)
    expect(later.action).toBe('quiet')
    const closed = settleStep(reading({ elapsedMs: SETTLE_WINDOW_MS }), later.mem)
    expect(closed.action).toBe('settled')
    expect(closed.mem.done).toBe(true)
  })

  test('THE LATE LANDING: quiet for six seconds on the wrong frame, then the transforms arrive — still corrected', () => {
    // Measured 2026-09-02: the joiner agreed with itself (installed = live =
    // LOCAL) until the level transforms landed at ~8 s; the first cut had
    // latched "settled" by then and never re-anchored (refusedGrid 11,
    // regrids 0). Quiet must keep one eye open.
    let mem = newSettleMemory()
    for (let n = 1; n <= SETTLE_QUIET_CHECKS + 2; n++) {
      mem = settleStep(reading({ elapsedMs: n * 400, installed: LOCAL, live: LOCAL }), mem).mem
    }
    expect(mem.quiet).toBe(true)
    // 8 s: the scene lands; the live anchor now reads the world point.
    let step = settleStep(reading({ elapsedMs: 8000, installed: LOCAL, live: A }), mem)
    expect(step.action).toBe('wait') // one drifting reading: not yet stable
    step = settleStep(reading({ elapsedMs: 10000, installed: LOCAL, live: A }), step.mem)
    expect(step.action).toBe('reanchor')
    expect(step.mem.reanchors).toBe(1)
    expect(step.mem.quiet).toBe(false)
  })

  test('a refused record is evidence: a nudged drifting reading corrects on the spot', () => {
    const step = settleStep(
      reading({ elapsedMs: 3000, installed: LOCAL, live: A, nudged: true }),
      newSettleMemory(),
    )
    expect(step.action).toBe('reanchor')
    // Without the nudge the same first reading only waits for a second look.
    const unnudged = settleStep(reading({ elapsedMs: 3000, installed: LOCAL, live: A }), newSettleMemory())
    expect(unnudged.action).toBe('wait')
    // A nudge never overrides the guards: addressed pieces still block.
    const guarded = settleStep(
      reading({ elapsedMs: 3000, hasPieces: true, hasSlotPieces: true, installed: LOCAL, live: A, nudged: true }),
      newSettleMemory(),
    )
    expect(guarded.action).toBe('blocked')
  })

  test('a scene that keeps changing never goes quiet — the cap ends it', () => {
    // Walls die during play, so the reading moves without drifting: the quiet
    // exit must not fire, and the cap must still stop the watcher.
    let mem = newSettleMemory()
    for (let n = 1; n <= SETTLE_QUIET_CHECKS * 2; n++) {
      const step = settleStep(
        reading({ collectedWalls: 347, elapsedMs: n * 400, liveWalls: 347 - n }),
        mem,
      )
      expect(step.action).toBe('wait')
      mem = step.mem
    }
    const capped = settleStep(reading({ elapsedMs: SETTLE_WINDOW_MS, liveWalls: 300 }), mem)
    expect(capped.action).toBe('settled')
    expect(capped.mem.done).toBe(true)
  })

  test('a drift that lands late — past a 20 s guess — is still corrected', () => {
    // The first cut of this watcher capped at 20 s and the real landing was at
    // ~26 s on a slow client. The cap must not be the thing that decides.
    const r = reading({ elapsedMs: 26000, installed: LOCAL, live: A })
    expect(drive(r).actions).toContain('reanchor')
  })

  test('drift past the window settles rather than claiming blocked', () => {
    const step = settleStep(
      reading({ elapsedMs: SETTLE_WINDOW_MS + 1, installed: LOCAL, live: A }),
      newSettleMemory(),
    )
    expect(step.action).toBe('settled')
  })

  test('once done, every later step is a no-op', () => {
    const done: SettleMemory = { ...newSettleMemory(), done: true }
    const step = settleStep(reading({ installed: LOCAL, live: A }), done)
    expect(step.action).toBe('settled')
    expect(step.mem).toEqual(done)
  })
})
