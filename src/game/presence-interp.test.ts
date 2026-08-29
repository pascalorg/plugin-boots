import { describe, expect, test } from 'bun:test'
import {
  angleDist,
  createRing,
  createSampledPose,
  EXTRAPOLATE_MAX_MS,
  isStale,
  latestSnapshot,
  lerpAngle,
  type PresenceFrame,
  pushSnapshot,
  RING_CAP,
  sampleAt,
  STALE_MS,
  TELEPORT_SNAP_M,
  validateFrame,
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
