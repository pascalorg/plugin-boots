import { beforeEach, describe, expect, test } from 'bun:test'
import {
  COLLAPSE_RING_MS,
  DIED_SLOT_LOCKOUT_MS,
  diedAt,
  flushCollapse,
  hasPendingCollapse,
  isDeathLocked,
  isOccupied,
  isSupported,
  notifySceneSupportChanged,
  onCollapse,
  onPieceRemoved,
  pieceAt,
  registerPlacement,
  resetPieceSlots,
  setSceneSupportProbe,
  slotOf,
  unregister,
} from './piece-slots'

/** Stubbed store: the collapse listener IS the store hook in production
 * (debris burst + removePlaced → unmount cleanup). Tests just record. */
type Fall = { pieceId: number; slotId: string; ring: number }
function recordFalls(): Fall[] {
  const falls: Fall[] = []
  onCollapse((pieceId, slotId, ring) => falls.push({ pieceId, slotId, ring }))
  return falls
}

beforeEach(() => {
  resetPieceSlots()
})

describe('occupancy registry', () => {
  test('register/unregister round-trips both directions', () => {
    expect(registerPlacement('Wz:0,0,0', 7)).toBe(true)
    expect(isOccupied('Wz:0,0,0')).toBe(true)
    expect(pieceAt('Wz:0,0,0')).toBe(7)
    expect(slotOf(7)).toBe('Wz:0,0,0')
    expect(unregister('Wz:0,0,0')).toBe(7)
    expect(isOccupied('Wz:0,0,0')).toBe(false)
    expect(slotOf(7)).toBeUndefined()
    expect(unregister('Wz:0,0,0')).toBeNull()
  })

  test('an occupied slot refuses another piece', () => {
    registerPlacement('F:1,1,0', 1)
    expect(registerPlacement('F:1,1,0', 2)).toBe(false)
    expect(pieceAt('F:1,1,0')).toBe(1)
    // Same piece re-asserting its own slot is fine.
    expect(registerPlacement('F:1,1,0', 1)).toBe(true)
  })

  test('a piece moving slots drops its old mapping (1:1 invariant)', () => {
    registerPlacement('Wz:0,0,0', 3)
    registerPlacement('R:0,0,0', 3) // transformPlaced wall→ramp re-slot
    expect(isOccupied('Wz:0,0,0')).toBe(false)
    expect(pieceAt('R:0,0,0')).toBe(3)
    expect(slotOf(3)).toBe('R:0,0,0')
  })
})

describe('support answers (grid.WorldProbe)', () => {
  test('storey-0 slots are terrain-supported even when empty', () => {
    expect(isSupported('Wz:4,4,0')).toBe(true)
    expect(isSupported('F:-2,3,0')).toBe(true)
  })

  test('an empty sky slot with no neighbors is unsupported', () => {
    expect(isSupported('Wz:0,0,2')).toBe(false)
    expect(isSupported('F:5,5,3')).toBe(false)
  })

  test('an empty R slot on open terrain is supported — ground ramps/roofs always place', () => {
    // Genre parity (owner QA 2026-08-27): stairs and roofs at storey 0 need
    // no wall, floor, or scene geometry — TERRAIN is their support root.
    expect(isSupported('R:30,30,0')).toBe(true)
    expect(isSupported('R:-7,12,0')).toBe(true)
    expect(isSupported('R:30,30,1')).toBe(false) // sky ramp still needs support
  })

  test('a candidate touching a supported piece is supported', () => {
    registerPlacement('Wz:0,0,0', 1) // grounded
    registerPlacement('Wz:0,0,1', 2) // stacked, supported through 1
    expect(isSupported('Wz:0,0,1')).toBe(true) // occupied → graph answer
    expect(isSupported('Wz:0,0,2')).toBe(true) // empty, on top of 2
    expect(isSupported('F:0,0,2')).toBe(true) // ceiling off the stacked wall
    expect(isSupported('Wz:9,9,2')).toBe(false) // far away in the sky
  })

  test('placements invalidate the candidate memo', () => {
    expect(isSupported('Wz:0,0,1')).toBe(false) // memoized "no"
    registerPlacement('Wz:0,0,0', 1)
    expect(isSupported('Wz:0,0,1')).toBe(true) // re-answered after the add
  })

  test('scene probe props up off-terrain slots and is cached per slot', () => {
    let calls = 0
    setSceneSupportProbe((slotId) => {
      calls++
      return slotId === 'F:5,5,1'
    })
    expect(isSupported('F:5,5,1')).toBe(true) // empty, scene-propped
    registerPlacement('F:5,5,1', 9)
    expect(isSupported('F:5,5,1')).toBe(true) // occupied, probe is its root
    expect(isSupported('F:5,6,1')).toBe(true) // candidate beside it
    const before = calls
    registerPlacement('F:5,6,1', 10) // graph recompute → cachedProbe only
    expect(isSupported('F:5,6,1')).toBe(true)
    expect(calls).toBe(before) // probe never re-ran for known slots
    notifySceneSupportChanged()
    isSupported('F:5,5,1')
    expect(calls).toBeGreaterThan(before) // notify cleared the probe cache
  })
})

describe('collapse cascade — onPieceRemoved', () => {
  test('undoing a tower base collapses the rest in ring order', () => {
    const falls = recordFalls()
    registerPlacement('Wz:0,0,0', 1)
    registerPlacement('Wz:0,0,1', 2)
    registerPlacement('Wz:0,0,2', 3)

    onPieceRemoved('Wz:0,0,0')
    // The trigger slot empties immediately; the doomed pieces stay visible
    // (occupied) through the stagger window.
    expect(isOccupied('Wz:0,0,0')).toBe(false)
    expect(isOccupied('Wz:0,0,1')).toBe(true)
    expect(isOccupied('Wz:0,0,2')).toBe(true)
    expect(hasPendingCollapse()).toBe(true)
    expect(falls).toEqual([])

    flushCollapse()
    expect(falls).toEqual([
      { pieceId: 2, slotId: 'Wz:0,0,1', ring: 0 },
      { pieceId: 3, slotId: 'Wz:0,0,2', ring: 1 },
    ])
    expect(hasPendingCollapse()).toBe(false)
    expect(isOccupied('Wz:0,0,1')).toBe(false)
    expect(isOccupied('Wz:0,0,2')).toBe(false)
    expect(slotOf(2)).toBeUndefined()
    expect(slotOf(3)).toBeUndefined()
  })

  test('rings fire on real timers ~COLLAPSE_RING_MS apart', async () => {
    const falls = recordFalls()
    registerPlacement('Wz:0,0,0', 1)
    registerPlacement('Wz:0,0,1', 2)
    registerPlacement('Wz:0,0,2', 3)
    onPieceRemoved('Wz:0,0,0')
    await Bun.sleep(COLLAPSE_RING_MS / 2)
    expect(falls.length).toBe(1) // ring 0 landed, ring 1 still pending
    await Bun.sleep(COLLAPSE_RING_MS)
    expect(falls.map((f) => f.pieceId)).toEqual([2, 3])
    expect(hasPendingCollapse()).toBe(false)
  })

  test('removal is idempotent (re-entry from a collapsed piece cleanup)', () => {
    const falls = recordFalls()
    registerPlacement('Wz:0,0,0', 1)
    onPieceRemoved('Wz:0,0,0')
    onPieceRemoved('Wz:0,0,0') // unmount cleanup calls back in — no-op
    flushCollapse()
    expect(falls).toEqual([])
  })

  test('supported survivors stay: side-braced stack loses nothing', () => {
    const falls = recordFalls()
    registerPlacement('Wz:0,0,0', 1)
    registerPlacement('Wz:0,0,1', 2)
    registerPlacement('Wz:1,0,0', 3) // grounded second column
    registerPlacement('Wz:1,0,1', 4) // braces piece 2 sideways
    onPieceRemoved('Wz:0,0,0')
    flushCollapse()
    expect(falls).toEqual([])
    expect(isOccupied('Wz:0,0,1')).toBe(true)
    expect(isOccupied('Wz:1,0,1')).toBe(true)
  })

  test('a piece undone mid-stagger is not collapsed twice', () => {
    const falls = recordFalls()
    registerPlacement('Wz:0,0,0', 1)
    registerPlacement('Wz:0,0,1', 2)
    registerPlacement('Wz:0,0,2', 3)
    onPieceRemoved('Wz:0,0,0')
    onPieceRemoved('Wz:0,0,1') // player undid piece 2 before its ring fired
    flushCollapse()
    expect(falls).toEqual([{ pieceId: 3, slotId: 'Wz:0,0,2', ring: 1 }])
  })
})

describe('collapse cascade — scene support lost', () => {
  test('a demolished scene prop drops its dependents through the rings', () => {
    const falls = recordFalls()
    let sceneWallAlive = true
    setSceneSupportProbe((slotId) => slotId === 'F:2,2,1' && sceneWallAlive)
    registerPlacement('F:2,2,1', 10) // hangs off the scene wall
    registerPlacement('F:2,3,1', 11) // hangs off 10
    expect(isSupported('F:2,3,1')).toBe(true)

    sceneWallAlive = false
    notifySceneSupportChanged()
    flushCollapse()
    expect(falls).toEqual([
      { pieceId: 10, slotId: 'F:2,2,1', ring: 0 },
      { pieceId: 11, slotId: 'F:2,3,1', ring: 1 },
    ])
    expect(isOccupied('F:2,2,1')).toBe(false)
  })

  test('hints narrow the seed scan to the changed neighborhood', () => {
    const falls = recordFalls()
    let alive = true
    setSceneSupportProbe((slotId) => slotId === 'F:2,2,1' && alive)
    registerPlacement('F:2,2,1', 10)
    registerPlacement('Wz:8,8,0', 20) // grounded elsewhere, untouched
    alive = false
    notifySceneSupportChanged(['F:2,2,1'])
    flushCollapse()
    expect(falls.map((f) => f.pieceId)).toEqual([10])
    expect(isOccupied('Wz:8,8,0')).toBe(true)
  })
})

describe('died-slot lockout (turbo)', () => {
  test('every death mode stamps the slot; the window is 0.15 s', () => {
    registerPlacement('Wz:0,0,0', 1)
    unregister('Wz:0,0,0')
    const stamp = diedAt('Wz:0,0,0')
    expect(stamp).toBeGreaterThan(0)
    expect(isDeathLocked('Wz:0,0,0', stamp)).toBe(true)
    expect(isDeathLocked('Wz:0,0,0', stamp + DIED_SLOT_LOCKOUT_MS - 1)).toBe(true)
    // +1 ms past the window, not the exact boundary: (stamp + 150) - stamp
    // can round below 150 in float64 when stamp carries fractional bits.
    expect(isDeathLocked('Wz:0,0,0', stamp + DIED_SLOT_LOCKOUT_MS + 1)).toBe(false)
    expect(isDeathLocked('Wz:9,9,0')).toBe(false) // never died
  })

  test('collapsed pieces stamp their slots too', () => {
    registerFallsTower()
    onPieceRemoved('Wz:0,0,0')
    flushCollapse()
    for (const slotId of ['Wz:0,0,0', 'Wz:0,0,1', 'Wz:0,0,2']) {
      expect(diedAt(slotId)).toBeGreaterThan(0)
    }
  })

  test('a successful re-fill clears the stamp', () => {
    registerPlacement('Wz:0,0,0', 1)
    unregister('Wz:0,0,0')
    registerPlacement('Wz:0,0,0', 2)
    expect(diedAt('Wz:0,0,0')).toBe(0)
    expect(isDeathLocked('Wz:0,0,0')).toBe(false)
  })
})

describe('lifecycle', () => {
  test('reset cancels pending rings without firing and forgets everything', () => {
    const falls = recordFalls()
    registerFallsTower()
    onPieceRemoved('Wz:0,0,0')
    expect(hasPendingCollapse()).toBe(true)
    resetPieceSlots()
    expect(hasPendingCollapse()).toBe(false)
    flushCollapse()
    expect(falls).toEqual([])
    expect(isOccupied('Wz:0,0,1')).toBe(false)
    expect(diedAt('Wz:0,0,0')).toBe(0)
  })
})

function registerFallsTower(): void {
  registerPlacement('Wz:0,0,0', 1)
  registerPlacement('Wz:0,0,1', 2)
  registerPlacement('Wz:0,0,2', 3)
}
