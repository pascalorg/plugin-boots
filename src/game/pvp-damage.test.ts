import { afterEach, describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { EYE_HEIGHT } from './collision'
import { type CollabBus, type NetMessage, resetNetKinds, stopNet } from './net'
import { getRemotes, ingestPoseFrame, POSE_KIND, startPresence, stopPresence } from './presence'
import type { PresenceFrame } from './presence-interp'
import { consumeHits, DRAWN_FRESH_MS, raycastRemotePlayers, rayHitsCapsule, validatePvpFrame } from './pvp-damage'

/**
 * PvP hit damage — the two pure cores that decide a hit and de-dup the wire.
 * The roster raycast + the netcode wrap these; these pin the geometry and the
 * idempotency that make PvP fair and coalescing-safe.
 */

// A player standing at world origin: feet (0,0,0), a 1.78 m capsule, r 0.42.
const FEET = { x: 0, y: 0, z: 0 }
const H = 1.78
const R = 0.42

describe('rayHitsCapsule', () => {
  test('a level shot down the barrel at chest height hits', () => {
    // Eye at z=5, aiming -Z along x=0 at chest height 1.0 — passes through the
    // capsule axis at (0,1.0,0), distance 0.
    const t = rayHitsCapsule(0, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).not.toBeNull()
    expect(t!).toBeCloseTo(5, 3)
  })

  test('a shot two metres to the side misses', () => {
    const t = rayHitsCapsule(2, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).toBeNull()
  })

  test('a shot just inside the radius still hits', () => {
    const t = rayHitsCapsule(0.4, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).not.toBeNull()
  })

  test('a target behind the shooter is never hit', () => {
    // Eye at z=-5 aiming -Z: the player at origin is behind (toward +Z).
    const t = rayHitsCapsule(0, 1.0, -5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).toBeNull()
  })

  test('a nearer wall (maxDist) occludes the player', () => {
    // Same clean hit, but the world cull already found geometry at 3 m.
    const t = rayHitsCapsule(0, 1.0, 5, 0, 0, -1, FEET.x, FEET.y, FEET.z, H, R, 3)
    expect(t).toBeNull()
  })

  test('a steep shot at the feet clamps to the segment end and can still hit', () => {
    // Standing over them, aiming straight down onto the head.
    const t = rayHitsCapsule(0, 4, 0, 0, -1, 0, FEET.x, FEET.y, FEET.z, H, R, 100)
    expect(t).not.toBeNull()
  })
})

describe('consumeHits (idempotent counter diff)', () => {
  const MAX = 4
  test('first tag from a shooter applies once', () => {
    const seen = new Map<string, number>()
    expect(consumeHits('shooterA', 1, seen, MAX)).toBe(1)
    expect(seen.get('shooterA')).toBe(1)
  })

  test('a duplicate frame (same counter) applies nothing', () => {
    const seen = new Map<string, number>([['shooterA', 1]])
    expect(consumeHits('shooterA', 1, seen, MAX)).toBe(0)
  })

  test('a jump in the counter applies exactly the delta', () => {
    const seen = new Map<string, number>([['shooterA', 1]])
    expect(consumeHits('shooterA', 3, seen, MAX)).toBe(2)
    expect(seen.get('shooterA')).toBe(3)
  })

  test('a coalesced burst is capped at maxBurst', () => {
    const seen = new Map<string, number>([['shooterA', 1]])
    expect(consumeHits('shooterA', 100, seen, MAX)).toBe(MAX)
    // ...but seen advances to the true counter so no double-apply later.
    expect(seen.get('shooterA')).toBe(100)
  })

  test('a reordered older frame is ignored', () => {
    const seen = new Map<string, number>([['shooterA', 5]])
    expect(consumeHits('shooterA', 3, seen, MAX)).toBe(0)
    expect(seen.get('shooterA')).toBe(5)
  })

  test('two shooters are tracked independently', () => {
    const seen = new Map<string, number>()
    expect(consumeHits('a', 2, seen, MAX)).toBe(2)
    expect(consumeHits('b', 1, seen, MAX)).toBe(1)
    expect(consumeHits('a', 2, seen, MAX)).toBe(0)
  })

  test('a missing / non-finite counter applies nothing', () => {
    const seen = new Map<string, number>()
    expect(consumeHits('a', undefined, seen, MAX)).toBe(0)
    expect(consumeHits('a', Number.NaN, seen, MAX)).toBe(0)
    expect(seen.size).toBe(0)
  })
})

describe('validatePvpFrame', () => {
  test('rejects non-objects', () => {
    expect(validatePvpFrame(null)).toBeNull()
    expect(validatePvpFrame(42)).toBeNull()
    expect(validatePvpFrame({})).toBeNull()
    expect(validatePvpFrame({ hits: 5 })).toBeNull()
  })

  test('keeps finite non-negative counters and drops the rest', () => {
    const out = validatePvpFrame({ hits: { a: 2, b: -1, c: Number.NaN, d: 'x', e: 0 } })
    expect(out).toEqual({ hits: { a: 2, e: 0 } })
  })

  test('an empty hits map is valid', () => {
    expect(validatePvpFrame({ hits: {} })).toEqual({ hits: {} })
  })
})

// ── The roster raycast hits the DRAWN body ───────────────────────────────────

/** The smallest host bus that lets presence start (the transport is
 * feature-detected off globalThis.__pascalCollabBus). */
function installBus(): void {
  const bus: CollabBus = {
    version: 1,
    projectId: 'project-1',
    sessionId: 'session-me',
    clientId: 'client-me',
    userId: 'user-me',
    publish: () => 'sent',
    subscribe: () => () => {},
    getParticipants: () => [],
    onParticipants: () => () => {},
  }
  ;(globalThis as { __pascalCollabBus?: CollabBus }).__pascalCollabBus = bus
}

function poseMsg(sentAt: number, p: [number, number, number]): NetMessage<PresenceFrame> {
  return {
    kind: POSE_KIND,
    data: { v: 1, ph: 'game', p, yaw: 0, pitch: 0, w: 'rifle', s: 0, g: true, st: false, f: 0 },
    seq: 1,
    skipped: 0,
    part: 1,
    parts: 1,
    sessionId: 'session-a',
    clientId: 'client-a',
    userId: 'user-a',
    sentAt,
  }
}

afterEach(() => {
  stopPresence()
  stopNet()
  resetNetKinds()
  delete (globalThis as { __pascalCollabBus?: CollabBus }).__pascalCollabBus
})

describe('raycastRemotePlayers — the capsule is where the peer is DRAWN, the ring only as a fallback', () => {
  /** A level shot along −z at chest height from x = `x`, z = 5. */
  const shoot = (x: number) => raycastRemotePlayers(new Vector3(x, 1.2, 5), new Vector3(0, 0, -1), 100)

  /** One peer standing at the origin on the wire (eye at EYE_HEIGHT). */
  function standingPeer() {
    installBus()
    expect(startPresence(() => ({ ph: 'game', x: 0, y: EYE_HEIGHT, z: 20, yaw: 0, pitch: 0, w: 'rifle', s: 0, g: true, st: false, f: 0 }))).toBe(true)
    const t0 = Date.now() - 1000
    ingestPoseFrame(poseMsg(t0, [0, EYE_HEIGHT, 0]), t0)
    ingestPoseFrame(poseMsg(t0 + 100, [0, EYE_HEIGHT, 0]), t0 + 100)
    return getRemotes().get('session-a')!
  }

  test('never drawn on this page → the ring at the floor delay decides', () => {
    const remote = standingPeer()
    expect(remote.drawnAt).toBe(0)
    const hit = shoot(0)
    expect(hit).not.toBeNull()
    expect(hit!.sessionId).toBe('session-a')
    expect(hit!.distance).toBeCloseTo(5, 1)
    expect(shoot(2)).toBeNull()
  })

  test('drawn fresh 2 m to the side: shooting where you SEE them hits, shooting the wire position misses', () => {
    const remote = standingPeer()
    remote.drawnX = 2
    remote.drawnY = EYE_HEIGHT
    remote.drawnZ = 0
    remote.drawnAt = Date.now()
    const hit = shoot(2)
    expect(hit).not.toBeNull()
    expect(hit!.point.x).toBeCloseTo(2, 6)
    expect(shoot(0)).toBeNull() // the ring says x = 0; nobody is drawn there
  })

  test(`a drawn stamp older than DRAWN_FRESH_MS (${DRAWN_FRESH_MS} ms — unmounted, culled, no scene) falls back to the ring`, () => {
    const remote = standingPeer()
    remote.drawnX = 2
    remote.drawnY = EYE_HEIGHT
    remote.drawnZ = 0
    remote.drawnAt = Date.now() - DRAWN_FRESH_MS - 1
    expect(shoot(2)).toBeNull()
    expect(shoot(0)).not.toBeNull()
    // …and one drawn a frame ago is still the picture.
    remote.drawnAt = Date.now() - 40
    expect(shoot(2)).not.toBeNull()
    expect(DRAWN_FRESH_MS).toBe(250)
  })

  test('a spectator (ph editor) has no capsule even with a drawn stamp', () => {
    const remote = standingPeer()
    remote.drawnX = 0
    remote.drawnY = EYE_HEIGHT
    remote.drawnZ = 0
    remote.drawnAt = Date.now()
    remote.ph = 'editor'
    expect(shoot(0)).toBeNull()
  })
})
