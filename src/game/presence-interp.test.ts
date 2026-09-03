import { describe, expect, test } from 'bun:test'
import { MOVE } from './movement'
import {
  angleDist,
  createRing,
  createSampledPose,
  createSmoother,
  createTiming,
  EXTRAP_SINK_M,
  EXTRAPOLATE_MAX_MS,
  INTERP_DELAY_MAX_MS,
  INTERP_DELAY_MIN_MS,
  INTERP_DELAY_MS,
  INTERP_DELAY_SLEW_MS_PER_S,
  interpDelayFor,
  isStale,
  latestSnapshot,
  lerpAngle,
  type PresenceFrame,
  pushSnapshot,
  MAX_SHOTS_PER_SAMPLE,
  RING_CAP,
  sampleAt,
  SHOT_COUNTER_MOD,
  shotsFired,
  slewDelay,
  SMOOTH_DEADBAND_M,
  SMOOTH_RATE,
  smoothPose,
  STALE_MS,
  TELEPORT_SNAP_M,
  TIMING_GAP_MS,
  TIMING_SPACING_MIN_MS,
  updateTiming,
  validateFrame,
  WIRE_GRAVITY,
} from './presence-interp'

/** A well-formed wire frame; tests override single fields to break it. */
function frame(overrides: Partial<PresenceFrame> = {}): PresenceFrame {
  return {
    v: 1,
    ph: 'game',
    p: [1.25, 0, -3.5],
    yaw: 0.5,
    pitch: -0.1,
    w: 'rifle',
    s: 0.6,
    g: true,
    st: false,
    f: 0,
    ...overrides,
  }
}

function push(ring: ReturnType<typeof createRing>, sentAt: number, over: Partial<PresenceFrame> = {}) {
  return pushSnapshot(ring, sentAt, frame(over))
}

describe('validateFrame — the trust boundary', () => {
  test('accepts a well-formed v1 frame and returns a normalized copy', () => {
    const input = frame()
    const out = validateFrame(input)
    expect(out).not.toBeNull()
    expect(out).not.toBe(input) // copy, never the caller's object
    expect(out!.p).toEqual([1.25, 0, -3.5])
    expect(out!.p).not.toBe(input.p)
    expect(out!.w).toBe('rifle')
    expect(out!.g).toBe(true)
  })

  test('rejects non-objects and null', () => {
    expect(validateFrame(null)).toBeNull()
    expect(validateFrame(undefined)).toBeNull()
    expect(validateFrame(42)).toBeNull()
    expect(validateFrame('frame')).toBeNull()
  })

  test('rejects wrong protocol version', () => {
    expect(validateFrame(frame({ v: 2 as never }))).toBeNull()
    expect(validateFrame({ ...frame(), v: undefined })).toBeNull()
  })

  test('rejects unknown phase', () => {
    expect(validateFrame(frame({ ph: 'lobby' as never }))).toBeNull()
  })

  test('rejects malformed, NaN and oversize positions', () => {
    expect(validateFrame({ ...frame(), p: [1, 2] })).toBeNull() // wrong arity
    expect(validateFrame({ ...frame(), p: [1, 2, 3, 4] })).toBeNull() // oversize
    expect(validateFrame({ ...frame(), p: [Number.NaN, 0, 0] })).toBeNull()
    expect(validateFrame({ ...frame(), p: [0, Number.POSITIVE_INFINITY, 0] })).toBeNull()
    expect(validateFrame({ ...frame(), p: [0, 0, 1e6] })).toBeNull() // beyond POS_LIMIT
    expect(validateFrame({ ...frame(), p: '1,2,3' })).toBeNull()
  })

  test('rejects NaN/absurd angles', () => {
    expect(validateFrame(frame({ yaw: Number.NaN }))).toBeNull()
    expect(validateFrame(frame({ pitch: Number.NaN }))).toBeNull()
    expect(validateFrame(frame({ yaw: 100 }))).toBeNull()
  })

  test('rejects oversize/empty weapon ids and non-boolean flags', () => {
    expect(validateFrame(frame({ w: '' }))).toBeNull()
    expect(validateFrame(frame({ w: 'x'.repeat(64) }))).toBeNull()
    expect(validateFrame(frame({ g: 1 as never }))).toBeNull()
    expect(validateFrame(frame({ st: 'yes' as never }))).toBeNull()
  })

  test('clamps s into [0,1] instead of dropping the frame', () => {
    expect(validateFrame(frame({ s: 4 }))!.s).toBe(1)
    expect(validateFrame(frame({ s: -0.5 }))!.s).toBe(0)
    expect(validateFrame(frame({ s: Number.NaN }))).toBeNull()
  })

  /**
   * `f` arrived after v1 shipped, so it is a SOFT field: a peer still running
   * the older build sends nine fields, and refusing those frames would cost
   * them their whole avatar over a feature they cannot send. Junk normalizes to
   * 0 (no shot) rather than rejecting, for the same reason.
   */
  test('the fire counter defaults to 0 and normalizes into a byte', () => {
    expect(validateFrame({ ...frame(), f: undefined })!.f).toBe(0)
    expect(validateFrame(frame({ f: 'many' as never }))!.f).toBe(0)
    expect(validateFrame(frame({ f: Number.NaN }))!.f).toBe(0)
    expect(validateFrame(frame({ f: -3 }))!.f).toBe(SHOT_COUNTER_MOD - 3)
    expect(validateFrame(frame({ f: 300 }))!.f).toBe(44)
    expect(validateFrame(frame({ f: 12.9 }))!.f).toBe(12)
    expect(validateFrame(frame({ f: 255 }))!.f).toBe(255)
  })
})

describe('shotsFired — a counter difference, not an event', () => {
  test('the first sighting of a peer never replays their magazine', () => {
    // -1 is "never sampled": walking up to someone who has fired 57 rounds must
    // not open with 57 muzzle flashes at once.
    expect(shotsFired(-1, 57)).toBe(0)
    expect(shotsFired(-1, 0)).toBe(0)
  })

  test('a steady stream is one shot per step', () => {
    expect(shotsFired(4, 5)).toBe(1)
    expect(shotsFired(4, 4)).toBe(0)
  })

  test('a dropped frame becomes a burst, not a lost shot', () => {
    expect(shotsFired(4, 6)).toBe(2)
    expect(shotsFired(4, 7)).toBe(3)
  })

  test('the byte wrap is invisible', () => {
    expect(shotsFired(SHOT_COUNTER_MOD - 1, 0)).toBe(1)
    expect(shotsFired(SHOT_COUNTER_MOD - 2, 1)).toBe(3)
  })

  test(`a big jump is capped at ${MAX_SHOTS_PER_SAMPLE}`, () => {
    // A peer who was out of range for a whole minigun burst comes back with a
    // gap of 200 on their counter. That is not 200 flashes and 200 reports; it
    // is "they were shooting", and a few rounds say so at bounded cost.
    expect(shotsFired(0, 200)).toBe(MAX_SHOTS_PER_SAMPLE)
    expect(shotsFired(0, SHOT_COUNTER_MOD - 1)).toBe(MAX_SHOTS_PER_SAMPLE)
  })

  test('junk counters are silent', () => {
    expect(shotsFired(0, Number.NaN)).toBe(0)
    expect(shotsFired(Number.NaN, 5)).toBe(0)
    expect(shotsFired(0, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('snapshot ring — order, capacity, recycling', () => {
  test('in-order pushes grow the ring; newest is the latest snapshot', () => {
    const ring = createRing()
    expect(latestSnapshot(ring)).toBeNull()
    expect(push(ring, 100)).toBe(true)
    expect(push(ring, 200, { p: [9, 0, 0] })).toBe(true)
    expect(ring.count).toBe(2)
    expect(latestSnapshot(ring)!.sentAt).toBe(200)
    expect(latestSnapshot(ring)!.x).toBe(9)
  })

  test('out-of-order and duplicate sentAt frames are dropped', () => {
    const ring = createRing()
    push(ring, 100)
    push(ring, 200)
    expect(push(ring, 150)).toBe(false) // late
    expect(push(ring, 200)).toBe(false) // duplicate
    expect(ring.count).toBe(2)
    expect(latestSnapshot(ring)!.sentAt).toBe(200)
  })

  test('the ring caps at RING_CAP and recycles the oldest slots', () => {
    const ring = createRing()
    for (let i = 0; i < RING_CAP + 10; i++) push(ring, (i + 1) * 100, { p: [i, 0, 0] })
    expect(ring.count).toBe(RING_CAP)
    expect(latestSnapshot(ring)!.sentAt).toBe((RING_CAP + 10) * 100)
    // The oldest surviving snapshot is (10 pushes past cap) in — sampling
    // before it clamps to it, proving the early slots were recycled.
    const out = createSampledPose()
    sampleAt(ring, 0, out)
    expect(out.x).toBe(10) // slots 0..9 recycled; oldest survivor is i=10
  })

  test('slots are reused, never reallocated (zero steady-state alloc)', () => {
    const ring = createRing(4)
    const slotRefs = [...ring.slots]
    for (let i = 0; i < 20; i++) push(ring, i * 10)
    expect(ring.slots[0]).toBe(slotRefs[0]!)
    expect(ring.slots[3]).toBe(slotRefs[3]!)
  })
})

describe('sampleAt — lerp between brackets', () => {
  test('positions lerp linearly across the bracketing pair', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [2, 0.5, -1] }) // 2.3 m hop — under the snap radius
    const out = createSampledPose()
    expect(sampleAt(ring, 1050, out)).toBe(true)
    expect(out.x).toBeCloseTo(1)
    expect(out.y).toBeCloseTo(0.25)
    expect(out.z).toBeCloseTo(-0.5)
    expect(out.frozen).toBe(false)
  })

  test('yaw takes the shortest arc across the ±π seam', () => {
    const ring = createRing()
    push(ring, 1000, { yaw: 3.1, p: [0, 0, 0] })
    push(ring, 1100, { yaw: -3.1, p: [0.5, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1050, out)
    // Midpoint of the SHORT way (through π), never near 0 (the long way).
    expect(angleDist(out.yaw, Math.PI)).toBeLessThan(1e-6)
  })

  test('pitch lerps (shortest arc degenerates to plain lerp in ±π/2)', () => {
    const ring = createRing()
    push(ring, 1000, { pitch: -0.2, p: [0, 0, 0] })
    push(ring, 1100, { pitch: 0.4, p: [0, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1075, out)
    expect(out.pitch).toBeCloseTo(0.25)
  })

  test('discrete fields (w/g/st) ride the newer bracket snapshot', () => {
    const ring = createRing()
    push(ring, 1000, { w: 'knife', g: true, st: false, p: [0, 0, 0] })
    push(ring, 1100, { w: 'minigun', g: false, st: true, p: [1, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1010, out)
    expect(out.w).toBe('minigun')
    expect(out.g).toBe(false)
    expect(out.st).toBe(true)
  })

  /**
   * The fire counter is the ONE discrete field that rides the OLDER snapshot,
   * and this test is why: a shot is an instant, not a state. Sampling 10 ms into
   * a 100 ms bracket, the avatar is still 90 ms of travel away from where the
   * newer snapshot was taken — voicing that snapshot's round now would put the
   * bang ahead of the body it came out of. The older side is exactly where the
   * pose currently IS, so the flash, the report and the arm agree.
   */
  test('the fire counter rides the OLDER bracket snapshot', () => {
    const ring = createRing()
    push(ring, 1000, { f: 4, p: [0, 0, 0] })
    push(ring, 1100, { f: 6, p: [1, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1010, out)
    expect(out.f).toBe(4)
    // …and it reaches the newer count once the sample gets there.
    sampleAt(ring, 1100, out)
    expect(out.f).toBe(6)
  })

  test('a lone snapshot and an extrapolated pose both carry its count', () => {
    const ring = createRing()
    push(ring, 1000, { f: 9, p: [0, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1000, out)
    expect(out.f).toBe(9)
    sampleAt(ring, 1000 + EXTRAPOLATE_MAX_MS, out) // past the newest, frozen
    expect(out.f).toBe(9)
  })

  test('before the oldest snapshot the pose clamps to it', () => {
    const ring = createRing()
    push(ring, 1000, { p: [5, 0, 5] })
    push(ring, 1100, { p: [6, 0, 6] })
    const out = createSampledPose()
    sampleAt(ring, 500, out)
    expect(out.x).toBe(5)
    expect(out.z).toBe(5)
  })

  test('an empty ring samples false; a lone snapshot holds its pose', () => {
    const ring = createRing()
    const out = createSampledPose()
    expect(sampleAt(ring, 1000, out)).toBe(false)
    push(ring, 1000, { p: [3, 1, 2] })
    expect(sampleAt(ring, 5000, out)).toBe(true)
    expect(out.x).toBe(3) // no pair → no velocity → hold
    expect(out.frozen).toBe(true) // ...and it reads frozen well past the cap
  })
})

describe('sampleAt — extrapolate ≤200ms, then freeze', () => {
  test('past the newest snapshot the pose rides the last velocity', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [1, 0, 0] }) // 10 m/s along x
    const out = createSampledPose()
    sampleAt(ring, 1200, out) // 100ms past newest
    expect(out.x).toBeCloseTo(2)
    expect(out.frozen).toBe(false)
  })

  test('extrapolation freezes at EXTRAPOLATE_MAX_MS', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [1, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1100 + EXTRAPOLATE_MAX_MS, out)
    const frozenX = out.x
    expect(frozenX).toBeCloseTo(3) // 1 + 10 m/s × 0.2 s
    sampleAt(ring, 1100 + EXTRAPOLATE_MAX_MS + 5000, out) // way later
    expect(out.x).toBeCloseTo(frozenX) // frozen, not sliding away
    expect(out.frozen).toBe(true)
  })

  test('no extrapolation across a teleport pair (velocity would be absurd)', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [50, 0, 0] }) // 50 m in 100 ms — a teleport
    const out = createSampledPose()
    sampleAt(ring, 1200, out)
    expect(out.x).toBe(50) // held at the landing point, not flung to 100
  })
})

describe('sampleAt — a stopped sender holds instead of sliding', () => {
  test('newest frame with s = 0 on the ground: no extrapolation, zero velocity', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0], s: 0.6 })
    push(ring, 1100, { p: [0.4, 0, 0], s: 0 }) // the deceleration pair; the sender has planted its feet
    const out = createSampledPose()
    sampleAt(ring, 1200, out)
    expect(out.x).toBe(0.4) // not 0.8
    expect(out.vx).toBe(0)
    expect(out.frozen).toBe(false)
  })

  test('…but a moving sender (s > 0) still extrapolates, and an airborne one still falls', () => {
    const moving = createRing()
    push(moving, 1000, { p: [0, 0, 0], s: 0.6 })
    push(moving, 1100, { p: [0.4, 0, 0], s: 0.5 })
    const out = createSampledPose()
    sampleAt(moving, 1200, out)
    expect(out.x).toBeCloseTo(0.8)
    const air = createRing()
    push(air, 1000, { p: [0, 2, 0], s: 0, g: false })
    push(air, 1100, { p: [0, 1.8, 0], s: 0, g: false })
    sampleAt(air, 1150, out)
    expect(out.y).toBeLessThan(1.8) // s is horizontal speed; a straight-down fall still guesses the fall
  })
})

describe('sampleAt — teleport snap', () => {
  test(`brackets farther than ${TELEPORT_SNAP_M}m apart snap, never tween`, () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [20, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1050, out) // mid-bracket
    expect(out.x).toBe(20) // snapped to the far side — no mid-map ghost
  })

  test('brackets within the snap radius still lerp normally', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [2.9, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1050, out)
    expect(out.x).toBeCloseTo(1.45)
  })
})

describe('staleness + angle helpers', () => {
  test(`isStale flips past ${STALE_MS}ms of silence`, () => {
    expect(isStale(1000, 1000 + STALE_MS)).toBe(false)
    expect(isStale(1000, 1000 + STALE_MS + 1)).toBe(true)
  })

  test('lerpAngle wraps; angleDist is symmetric and wrapped', () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5)
    expect(angleDist(3.1, -3.1)).toBeCloseTo(2 * Math.PI - 6.2)
    expect(angleDist(-3.1, 3.1)).toBeCloseTo(2 * Math.PI - 6.2)
    expect(angleDist(0.5, 0.5)).toBe(0)
  })
})

// ── Arrival timing + adaptive delay ──────────────────────────────────────────

describe('arrival timing — what the relay actually delivers', () => {
  test('steady 100 ms frames with zero deviation converge spacingEma, jitterEma stays 0', () => {
    const t = createTiming()
    expect(t.spacingEma).toBe(84) // the design rate, before any evidence
    for (let i = 0; i < 60; i++) updateTiming(t, 1000 + i * 100, 0)
    expect(t.spacingEma).toBeCloseTo(100, 0)
    expect(t.jitterEma).toBe(0)
    expect(t.gaps).toBe(0)
    expect(t.lastSentAt).toBe(1000 + 59 * 100)
  })

  test(`a keep-alive gap (> ${TIMING_GAP_MS} ms) is COUNTED, never sampled as spacing`, () => {
    const t = createTiming()
    for (let i = 0; i < 40; i++) updateTiming(t, 1000 + i * 84, 0)
    const before = t.spacingEma
    const last = 1000 + 39 * 84
    updateTiming(t, last + 500, 0) // idle keep-alive
    expect(t.gaps).toBe(1)
    expect(t.lastGapMs).toBe(500)
    expect(t.spacingEma).toBe(before) // a quiet peer does not look like a slow network
    expect(t.lastSentAt).toBe(last + 500)
    updateTiming(t, last + 500 + 1000, 0) // a hidden tab at 1 Hz
    expect(t.gaps).toBe(2)
    expect(t.lastGapMs).toBe(1000)
    // The next normal frame samples normally again.
    updateTiming(t, last + 1500 + 84, 0)
    expect(t.spacingEma).toBeCloseTo(before, 6)
  })

  test('offset deviation feeds the jitter average; spacing clamps at the floor', () => {
    const t = createTiming()
    for (let i = 0; i < 60; i++) updateTiming(t, 1000 + i * 84, 20)
    expect(t.jitterEma).toBeCloseTo(20, 0)
    const fast = createTiming()
    for (let i = 0; i < 60; i++) updateTiming(fast, 1000 + i * 5, 0) // a burst
    expect(fast.spacingEma).toBeCloseTo(TIMING_SPACING_MIN_MS, 0)
    // Duplicate / out-of-order sentAt (spacing ≤ 0) is not a sample either.
    const dup = createTiming()
    updateTiming(dup, 1000, 0)
    updateTiming(dup, 1000, 0)
    updateTiming(dup, 900, 0)
    expect(dup.spacingEma).toBe(84)
    expect(dup.gaps).toBe(0)
  })
})

describe('interpDelayFor / slewDelay — the cushion a peer earns', () => {
  test(`a clean 84 ms stream sits on the floor (${INTERP_DELAY_MIN_MS} ms); jitter lifts it; the ceiling is ${INTERP_DELAY_MAX_MS}`, () => {
    const clean = createTiming()
    expect(interpDelayFor(clean)).toBe(INTERP_DELAY_MIN_MS)
    expect(INTERP_DELAY_MS).toBe(INTERP_DELAY_MIN_MS) // the legacy alias
    const jittery = createTiming()
    jittery.jitterEma = 20
    expect(interpDelayFor(jittery)).toBeGreaterThanOrEqual(180)
    expect(interpDelayFor(jittery)).toBeLessThan(INTERP_DELAY_MAX_MS)
    const awful = createTiming()
    awful.jitterEma = 200
    awful.spacingEma = 250
    expect(interpDelayFor(awful)).toBe(INTERP_DELAY_MAX_MS)
  })

  test(`slewDelay moves at most ${INTERP_DELAY_SLEW_MS_PER_S} ms per second, either way, and lands exactly`, () => {
    expect(slewDelay(150, 320, 1 / 60)).toBeCloseTo(152, 9)
    expect(slewDelay(320, 150, 0.5)).toBeCloseTo(260, 9)
    expect(slewDelay(150, 151, 1)).toBe(151)
    expect(slewDelay(200, 200, 1)).toBe(200)
    expect(slewDelay(200, 150, 0)).toBe(200) // no time, no move
  })
})

// ── Sampled velocity ─────────────────────────────────────────────────────────

describe('sampleAt — exposes the velocity it moved with', () => {
  test('the bracket slope in the lerp branch (m/s)', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [2, 0.5, -1] })
    const out = createSampledPose()
    sampleAt(ring, 1050, out)
    expect(out.vx).toBeCloseTo(20)
    expect(out.vy).toBeCloseTo(5)
    expect(out.vz).toBeCloseTo(-10)
  })

  test('the pair slope while extrapolating; 0 once frozen', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0] })
    push(ring, 1100, { p: [1, 0, 0] })
    const out = createSampledPose()
    sampleAt(ring, 1150, out)
    expect(out.x).toBeCloseTo(1.5)
    expect(out.vx).toBeCloseTo(10)
    expect(out.frozen).toBe(false)
    sampleAt(ring, 1100 + EXTRAPOLATE_MAX_MS + 1, out)
    expect(out.frozen).toBe(true)
    expect(out.vx).toBe(0)
    expect(out.vy).toBe(0)
    expect(out.vz).toBe(0)
  })

  test('0 on a teleport pair, clamped to the oldest, or a lone snapshot', () => {
    const tele = createRing()
    push(tele, 1000, { p: [0, 0, 0] })
    push(tele, 1100, { p: [20, 0, 0] })
    const out = createSampledPose()
    sampleAt(tele, 1050, out)
    expect(out.vx).toBe(0)
    sampleAt(tele, 1200, out) // extrapolating past a teleport pair
    expect(out.vx).toBe(0)
    sampleAt(tele, 500, out) // before the oldest
    expect(out.vx).toBe(0)
    const lone = createRing()
    push(lone, 1000, { p: [3, 1, 2] })
    sampleAt(lone, 1050, out)
    expect(out.vx).toBe(0)
    expect(out.vy).toBe(0)
  })
})

describe('sampleAt — airborne extrapolation is ballistic and floor-clamped', () => {
  test('WIRE_GRAVITY matches the kinematics the sender runs', () => {
    expect(WIRE_GRAVITY).toBe(MOVE.gravity)
  })

  test('a rising pair follows gravity toward its apex, not a straight line', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0], g: false })
    push(ring, 1100, { p: [0, 0.5, 0], g: false }) // 5 m/s up
    const out = createSampledPose()
    sampleAt(ring, 1300, out) // 200 ms past
    // y = 0.5 + 5·0.2 − ½·16·0.2² = 1.18, under the linear 1.5
    expect(out.y).toBeCloseTo(1.18, 6)
    expect(out.vy).toBeCloseTo(5 - WIRE_GRAVITY * 0.2, 6)
  })

  test(`a falling pair never goes below newest.y − ${EXTRAP_SINK_M} m`, () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 2, 0], g: false })
    push(ring, 1100, { p: [0, 1.5, 0], g: false }) // 5 m/s down
    const out = createSampledPose()
    sampleAt(ring, 1300, out)
    expect(out.y).toBeCloseTo(1.5 - EXTRAP_SINK_M, 9) // not 0.18
    expect(out.vy).toBe(0) // resting on the guessed floor
    sampleAt(ring, 1120, out) // 20 ms past: still above the floor
    expect(out.y).toBeGreaterThan(1.5 - EXTRAP_SINK_M)
    expect(out.y).toBeLessThan(1.5)
    expect(out.vy).toBeLessThan(-5)
  })

  test('a grounded pair stays linear (stairs and ramps have real slopes)', () => {
    const ring = createRing()
    push(ring, 1000, { p: [0, 0, 0], g: true })
    push(ring, 1100, { p: [0, 0.5, 0], g: true })
    const out = createSampledPose()
    sampleAt(ring, 1300, out)
    expect(out.y).toBeCloseTo(1.5, 9)
    expect(out.vy).toBeCloseTo(5, 9)
  })
})

// ── Residual smoother ────────────────────────────────────────────────────────

describe('smoothPose — corrections glide, motion passes', () => {
  const DT = 1 / 60
  const out = { x: 0, y: 0, z: 0 }

  test('continuous 6.5 m/s: zero corrections, drawn == target', () => {
    const sm = createSmoother()
    for (let i = 0; i < 120; i++) {
      const x = 6.5 * i * DT
      smoothPose(sm, x, 1.58, 0, 6.5, 0, 0, DT, DT, out)
      expect(out.x).toBeCloseTo(x, 12)
    }
    expect(sm.corrections).toBe(0)
  })

  test('a 60 Hz velocity ramp (0 → 6.5 m/s over 5 frames) is motion, not error', () => {
    const sm = createSmoother()
    let x = 0
    let v = 0
    for (let i = 0; i < 30; i++) {
      smoothPose(sm, x, 0, 0, v, 0, 0, DT, DT, out)
      expect(out.x).toBeCloseTo(x, 12)
      v = Math.min(6.5, v + 1.3)
      x += v * DT
    }
    expect(sm.corrections).toBe(0)
    // A fall at 9 m/s and a shove at 12.5 m/s are continuous too.
    const fall = createSmoother()
    for (let i = 0; i < 30; i++) smoothPose(fall, 12.5 * i * DT, 5 - 9 * i * DT, 0, 12.5, -9, 0, DT, DT, out)
    expect(fall.corrections).toBe(0)
  })

  test('a 12 Hz velocity STEP (the ring\'s bracket slope jumps 0 → 6.5 m/s in one frame) is ONE small glide', () => {
    // This is what a real hard start / hard stop / sharp turn looks like to the
    // smoother: the bracket velocity changes in one render frame, so that
    // frame's residual is ~v·dt (0.108 m) — above the deadband. The contract:
    // exactly one correction, the residual is bounded by v·dt, the drawn point
    // never moves backwards, and it converges well under 300 ms.
    const sm = createSmoother()
    for (let i = 0; i < 12; i++) smoothPose(sm, 0, 1.58, 0, 0, 0, 0, DT, DT, out)
    expect(sm.corrections).toBe(0)
    let x = 6.5 * DT
    let prevOut = out.x
    smoothPose(sm, x, 1.58, 0, 6.5, 0, 0, DT, DT, out)
    expect(sm.corrections).toBe(1)
    const residual = x - out.x
    expect(residual).toBeGreaterThan(0)
    expect(residual).toBeLessThanOrEqual(6.5 * DT)
    expect(out.x - prevOut).toBeCloseTo(SMOOTH_DEADBAND_M, 9) // the step frame shows the deadband's worth
    prevOut = out.x
    let converged = -1
    for (let i = 1; i <= 30; i++) {
      x += 6.5 * DT
      smoothPose(sm, x, 1.58, 0, 6.5, 0, 0, DT, DT, out)
      expect(out.x).toBeGreaterThan(prevOut) // never backwards
      prevOut = out.x
      if (converged < 0 && x - out.x < 0.01) converged = i * DT
    }
    expect(sm.corrections).toBe(1) // continuous motion afterwards is never a correction
    expect(converged).toBeGreaterThan(0)
    expect(converged).toBeLessThan(0.3)
    // The mirror image — a hard stop — is the same single glide.
    const stop = createSmoother()
    for (let i = 0; i < 12; i++) smoothPose(stop, 6.5 * i * DT, 1.58, 0, 6.5, 0, 0, DT, DT, out)
    const held = 6.5 * 11 * DT
    smoothPose(stop, held, 1.58, 0, 0, 0, 0, DT, DT, out) // the ring says: stopped here
    expect(stop.corrections).toBe(1)
    expect(out.x).toBeGreaterThan(held) // overshoots by the unpredicted 6.5·dt − deadband …
    expect(out.x - held).toBeLessThanOrEqual(6.5 * DT)
    for (let i = 0; i < 18; i++) smoothPose(stop, held, 1.58, 0, 0, 0, 0, DT, DT, out)
    expect(Math.abs(out.x - held)).toBeLessThan(0.01) // … and settles within 300 ms
    expect(stop.corrections).toBe(1)
  })

  test('a 0.4 m pop glides: one correction, the pop frame moves v·dt + deadband, converged < 400 ms', () => {
    const sm = createSmoother()
    const v = 2
    let x = 0
    let prevOut = 0
    for (let i = 0; i < 30; i++) {
      x = v * i * DT
      smoothPose(sm, x, 0, 0, v, 0, 0, DT, DT, out)
      prevOut = out.x
    }
    // The late frame lands: the target is suddenly 0.4 m further on.
    x += v * DT + 0.4
    smoothPose(sm, x, 0, 0, v, 0, 0, DT, DT, out)
    expect(sm.corrections).toBe(1)
    expect(out.x - prevOut).toBeCloseTo(v * DT + SMOOTH_DEADBAND_M, 9)
    prevOut = out.x
    const glideCap = 0.4 * (1 - Math.exp(-SMOOTH_RATE * DT)) + 0.01
    let converged = -1
    for (let i = 1; i <= 30; i++) {
      x += v * DT
      smoothPose(sm, x, 0, 0, v, 0, 0, DT, DT, out)
      const step = out.x - prevOut
      expect(step).toBeGreaterThan(0) // never backwards
      expect(step).toBeLessThanOrEqual(v * DT + glideCap) // never the whole pop at once
      prevOut = out.x
      if (converged < 0 && Math.abs(out.x - x) < 0.01) converged = i * DT
    }
    expect(sm.corrections).toBe(1) // the glide itself is not a correction
    expect(converged).toBeGreaterThan(0)
    expect(converged).toBeLessThan(0.4)
    expect(sm.maxStepM).toBeLessThan(0.4)
  })

  test(`a ${TELEPORT_SNAP_M} m+ jump snaps — no glide across the map`, () => {
    const sm = createSmoother()
    for (let i = 0; i < 10; i++) smoothPose(sm, i * 0.1, 0, 0, 6, 0, 0, DT, DT, out)
    smoothPose(sm, 50, 0, 0, 0, 0, 0, DT, DT, out)
    expect(out.x).toBe(50)
    expect(sm.corrections).toBe(0)
  })

  test('a 100 ms wall hitch at 6.5 m/s is budgeted on WALL dt — not misread as a pop', () => {
    const sm = createSmoother()
    let x = 0
    for (let i = 0; i < 30; i++) {
      x = 6.5 * i * DT
      smoothPose(sm, x, 0, 0, 6.5, 0, 0, DT, DT, out)
    }
    x += 6.5 * 0.1 // the game loop stalled 100 ms; the peer kept running
    smoothPose(sm, x, 0, 0, 6.5, 0, 0, 0.1, 1 / 30, out)
    expect(sm.corrections).toBe(0)
    expect(out.x).toBeCloseTo(x, 9)
  })

  test('the first call primes: drawn == target, nothing counted', () => {
    const sm = createSmoother()
    smoothPose(sm, 7, 8, 9, 100, 100, 100, DT, DT, out)
    expect(out).toEqual({ x: 7, y: 8, z: 9 })
    expect(sm.corrections).toBe(0)
    expect(sm.maxStepM).toBe(0)
  })
})
