import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type BootsEnvelope,
  type CollabBus,
  type CollabBusMessage,
  type CollabParticipant,
  getCollabBus,
  NET_PROTOCOL,
  type NetMessage,
  PLUGIN_ID,
  resetNetKinds,
  stopNet,
} from './net'
import {
  admitRemote,
  buildFrame,
  CROWD_SWAP_MARGIN_M,
  CROWDED_REMOTES,
  type CrowdSlot,
  framesEqual,
  getRemotes,
  getRosterVersion,
  IDLE_MAX_SILENCE_MS,
  ingestPoseFrame,
  type LocalPose,
  MAX_REMOTE_AVATARS,
  onPresenceEvent,
  POSE_KIND,
  type PresenceEvent,
  presenceCounters,
  presenceDebug,
  presenceTick,
  publishIntervalMs,
  shouldPublish,
  startPresence,
  stopPresence,
  wrapAngle,
} from './presence'
import type { PresenceFrame } from './presence-interp'
import { latestSnapshot, STALE_MS } from './presence-interp'

/**
 * The AVATAR layer's contract. presence.ts rides net.ts as one frame kind
 * ('pose'), so the seams split cleanly and are tested separately:
 *   net.test.ts       → envelope, sequence numbers, self-echo, kind routing,
 *                       payload cap, late-join election (the TRANSPORT).
 *   this file         → publish cadence, the remote registry's join/leave
 *                       edges, the crowd ceiling, lifecycle, QA counters —
 *                       driven through ingestPoseFrame, which by contract
 *                       receives an ALREADY validated, ordered, non-echo
 *                       frame. One test at the end drives a real host
 *                       message all the way through the transport to pin the
 *                       wiring between the two.
 */

// ── Fake bus ─────────────────────────────────────────────────────────────────

type FakeBus = CollabBus & {
  publishes: Array<{ pluginId: string; event: string; data: unknown }>
  publishResult: 'sent' | 'deferred' | 'suppressed'
  handler: ((msg: CollabBusMessage) => void) | null
  rosterHandler: ((participants: CollabParticipant[]) => void) | null
  participants: CollabParticipant[]
  unsubscribed: number
}

function makeBus(): FakeBus {
  const bus: FakeBus = {
    version: 1,
    projectId: 'project-1',
    sessionId: 'session-me',
    clientId: 'client-me',
    userId: 'user-me',
    publishes: [],
    publishResult: 'sent',
    handler: null,
    rosterHandler: null,
    participants: [
      { userId: 'user-me', name: 'Me', sessions: [{ sessionId: 'session-me', clientId: 'client-me' }] },
      { userId: 'user-a', name: 'Alice', sessions: [{ sessionId: 'session-a', clientId: 'client-a' }] },
    ],
    unsubscribed: 0,
    publish(pluginId, event, data) {
      bus.publishes.push({ pluginId, event, data })
      return bus.publishResult
    },
    subscribe(_pluginId, handler) {
      bus.handler = handler
      return () => {
        bus.unsubscribed++
        bus.handler = null
      }
    },
    getParticipants() {
      return bus.participants
    },
    onParticipants(handler) {
      bus.rosterHandler = handler
      return () => {
        bus.rosterHandler = null
      }
    },
  }
  return bus
}

const g = globalThis as { __pascalCollabBus?: CollabBus }

function installBus(): FakeBus {
  const bus = makeBus()
  g.__pascalCollabBus = bus
  return bus
}

function localPose(over: Partial<LocalPose> = {}): LocalPose {
  return {
    ph: 'game',
    x: 1.234,
    y: 1.58,
    z: -2.567,
    yaw: 0.5,
    pitch: -0.25,
    w: 'rifle',
    s: 0.5,
    g: true,
    st: false,
    ...over,
  }
}

function gameFrame(over: Partial<PresenceFrame> = {}): PresenceFrame {
  return {
    v: 1,
    ph: 'game',
    p: [1, 0, 2],
    yaw: 0.1,
    pitch: 0,
    w: 'pistol',
    s: 0.3,
    g: true,
    st: false,
    ...over,
  }
}

/**
 * A delivered pose frame as net.ts hands it over: payload already validated
 * and normalized, self-echo already dropped, sequence already ordered.
 * presence.ts reads none of seq/skipped/part — ordering is the transport's
 * job — so they stay at their trivial values here.
 */
function poseMsg(over: Partial<NetMessage<PresenceFrame>> = {}): NetMessage<PresenceFrame> {
  return {
    kind: POSE_KIND,
    data: gameFrame(),
    seq: 1,
    skipped: 0,
    part: 1,
    parts: 1,
    sessionId: 'session-a',
    clientId: 'client-a',
    userId: 'user-a',
    sentAt: 1000,
    ...over,
  }
}

/** A raw host bus message carrying a well-formed envelope — for the one test
 * that exercises the real transport path end to end. */
function busMsg(frame: PresenceFrame, seq = 1, over: Partial<CollabBusMessage> = {}): CollabBusMessage {
  return {
    event: POSE_KIND,
    data: { v: NET_PROTOCOL, kind: POSE_KIND, seq, data: frame } satisfies BootsEnvelope,
    sessionId: 'session-a',
    clientId: 'client-a',
    userId: 'user-a',
    sentAt: 1000,
    ...over,
  }
}

/** The pose inside published frame `i` (publishes carry ENVELOPES now). */
function publishedFrame(bus: FakeBus, i: number): PresenceFrame {
  return (bus.publishes[i]!.data as BootsEnvelope).data as PresenceFrame
}

afterEach(() => {
  stopPresence()
  stopNet() // in case a test opened the transport without presence
  resetNetKinds() // registered kinds are module-global — do not bleed
  delete g.__pascalCollabBus
})

// ── Feature detection ────────────────────────────────────────────────────────

describe('feature detection — absent bus means total no-op', () => {
  test('no bus: getCollabBus null, startPresence false, everything inert', () => {
    // Counters are module-global; assert they do not MOVE (bun shares the
    // module registry across test files, so absolutes are order-dependent).
    const before = presenceCounters()
    expect(getCollabBus()).toBeNull()
    expect(startPresence(() => localPose())).toBe(false)
    stopPresence() // must not throw
    presenceTick(1000) // must not throw
    expect(getRemotes().size).toBe(0)
    expect(presenceCounters()).toEqual(before)
  })

  test('wrong protocol version reads as no bus', () => {
    const bus = makeBus()
    bus.version = 2
    g.__pascalCollabBus = bus
    expect(getCollabBus()).toBeNull()
    expect(startPresence(() => localPose())).toBe(false)
  })

  test('a v1 bus is detected and subscribed to under the plugin id', () => {
    const bus = installBus()
    expect(startPresence(() => localPose())).toBe(true)
    expect(bus.handler).not.toBeNull()
    expect(bus.rosterHandler).not.toBeNull()
    expect(PLUGIN_ID).toBe('pascal:boots')
  })

  /**
   * FLAG-OFF PROOF. `NEXT_PUBLIC_PLUGIN_COLLAB` is a HOST flag: the host
   * installs `globalThis.__pascalCollabBus` only when it is on, so "flag
   * off" reaches the plugin as "no bus" — the exact state asserted here.
   * Nothing is scheduled, nothing is sampled, nothing is allocated: the
   * whole feature's cost with the flag off is one failed property read.
   */
  test('flag off (no bus): no timer, no sampler, no allocation, zero cost', () => {
    const setInterval = spyOn(globalThis, 'setInterval')
    const rosterBefore = getRosterVersion()
    const countersBefore = presenceCounters()
    let sampled = 0
    expect(
      startPresence(() => {
        sampled++
        return localPose()
      }),
    ).toBe(false)
    // No interval was ever scheduled — there is no 25 ms adapter tick at all.
    expect(setInterval).not.toHaveBeenCalled()
    // Ticks and inbound frames are hard no-ops (the bus can't even deliver).
    for (let i = 0; i < 100; i++) {
      presenceTick(1000 + i * 25)
      ingestPoseFrame(poseMsg({ sentAt: 1000 + i }), 5000 + i)
    }
    // The local pose sampler is NEVER called: no playerRig reads, no work.
    expect(sampled).toBe(0)
    expect(getRemotes().size).toBe(0)
    // Not one roster bump: nothing for the renderer to re-render off.
    expect(getRosterVersion()).toBe(rosterBefore)
    const dump = presenceDebug()
    expect(dump.remotes).toEqual([])
    // Not one frame published, ingested or culled — the counters never moved.
    expect(dump.published).toBe(countersBefore.published)
    expect(dump.received).toBe(countersBefore.received)
    expect(dump.culled).toBe(countersBefore.culled)
    setInterval.mockRestore()
  })
})

// ── Publish policy (pure) ────────────────────────────────────────────────────

describe('publish policy — cadence, idle skip, keep-alive', () => {
  test('12 Hz base, 10 Hz once MORE than 4 remotes are live', () => {
    expect(publishIntervalMs(0)).toBeCloseTo(1000 / 12)
    expect(publishIntervalMs(CROWDED_REMOTES)).toBeCloseTo(1000 / 12) // exactly 4 → base
    expect(publishIntervalMs(CROWDED_REMOTES + 1)).toBeCloseTo(1000 / 10)
  })

  test('rate gate: no publish inside the interval, changed or not', () => {
    expect(shouldPublish({ now: 1050, lastPublishAt: 1000, remoteCount: 0, changed: true })).toBe(
      false,
    )
    expect(shouldPublish({ now: 1084, lastPublishAt: 1000, remoteCount: 0, changed: true })).toBe(
      true,
    )
  })

  test('idle skip: an unchanged pose is not re-sent inside 500 ms', () => {
    expect(shouldPublish({ now: 1100, lastPublishAt: 1000, remoteCount: 0, changed: false })).toBe(
      false,
    )
    expect(
      shouldPublish({
        now: 1000 + IDLE_MAX_SILENCE_MS + 1,
        lastPublishAt: 1000,
        remoteCount: 0,
        changed: false,
      }),
    ).toBe(true) // the keep-alive that feeds peers' staleness clocks
  })

  test('framesEqual: epsilon-gated on pose, exact on discrete fields', () => {
    const a = gameFrame()
    expect(framesEqual(a, gameFrame())).toBe(true)
    expect(framesEqual(a, gameFrame({ p: [1.01, 0, 2] }))).toBe(true) // sub-epsilon
    expect(framesEqual(a, gameFrame({ p: [1.05, 0, 2] }))).toBe(false)
    expect(framesEqual(a, gameFrame({ yaw: 0.101 }))).toBe(true)
    expect(framesEqual(a, gameFrame({ yaw: 0.2 }))).toBe(false)
    expect(framesEqual(a, gameFrame({ w: 'rifle' }))).toBe(false)
    expect(framesEqual(a, gameFrame({ g: false }))).toBe(false)
    expect(framesEqual(a, gameFrame({ st: true }))).toBe(false)
    expect(framesEqual(a, gameFrame({ ph: 'editor' }))).toBe(false)
  })
})

// ── Frame building ───────────────────────────────────────────────────────────

describe('buildFrame — wire quantization', () => {
  test('2-decimal positions, 3-decimal wrapped angles, clamped s', () => {
    const out = gameFrame()
    buildFrame(localPose({ x: 1.23456, yaw: Math.PI * 2 + 0.5, s: 1.7 }), out)
    expect(out.p[0]).toBe(1.23)
    expect(out.p[2]).toBe(-2.57)
    expect(out.yaw).toBe(0.5) // unbounded rig yaw wraps onto the wire
    expect(out.pitch).toBe(-0.25)
    expect(out.s).toBe(1)
    expect(out.v).toBe(1)
  })

  test('wrapAngle maps into (-π, π]', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI)
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI / 2)
    expect(wrapAngle(0.25)).toBe(0.25)
  })
})

// ── Publish loop through the fake bus ────────────────────────────────────────

describe('publish loop — sent, deferred-skip, idle keep-alive', () => {
  test('first tick publishes; unchanged ticks idle-skip until 500 ms', () => {
    const bus = installBus()
    startPresence(() => localPose())
    presenceTick(1000)
    expect(bus.publishes.length).toBe(1)
    // Poses ride their OWN host event, so the host's per-event coalescing can
    // never let a pose stream swallow another kind's frame.
    expect(bus.publishes[0]!.event).toBe(POSE_KIND)
    expect(bus.publishes[0]!.pluginId).toBe(PLUGIN_ID)
    expect(presenceCounters().published).toBe(1)
    presenceTick(1100) // unchanged, inside keep-alive → skip
    presenceTick(1200)
    expect(bus.publishes.length).toBe(1)
    presenceTick(1000 + IDLE_MAX_SILENCE_MS + 1) // keep-alive fires
    expect(bus.publishes.length).toBe(2)
  })

  test('a changed pose publishes at the base cadence', () => {
    const bus = installBus()
    let x = 0
    startPresence(() => localPose({ x }))
    presenceTick(1000)
    x = 5 // moved
    presenceTick(1050) // inside the 83 ms interval → rate-gated
    expect(bus.publishes.length).toBe(1)
    presenceTick(1090)
    expect(bus.publishes.length).toBe(2)
  })

  test("'deferred' is a skip, not a queue — and does not count as published", () => {
    const bus = installBus()
    let x = 0
    startPresence(() => localPose({ x }))
    bus.publishResult = 'deferred'
    presenceTick(1000)
    expect(bus.publishes.length).toBe(1)
    expect(presenceCounters().published).toBe(0) // deferred ≠ published
    x = 5
    bus.publishResult = 'sent'
    presenceTick(1090)
    expect(bus.publishes.length).toBe(2)
    // The retried frame is FRESH (x=5), never the old deferred one.
    expect(publishedFrame(bus, 1).p[0]).toBe(5)
    expect(presenceCounters().published).toBe(1)
  })

  test('the wire object is a plain copy, never a live scratch reference', () => {
    const bus = installBus()
    let x = 0
    startPresence(() => localPose({ x }))
    presenceTick(1000)
    x = 9
    presenceTick(2000)
    const first = publishedFrame(bus, 0)
    const second = publishedFrame(bus, 1)
    expect(first).not.toBe(second)
    expect(first.p[0]).toBe(0) // still the frame-1 value — no mutation
    expect(second.p[0]).toBe(9)
  })
})

// ── Remote registry: join / leave edges ──────────────────────────────────────

describe('remote registry — join and leave', () => {
  test('first game-phase frame from a session joins it (event + roster bump)', () => {
    installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    const v0 = getRosterVersion()
    ingestPoseFrame(poseMsg(), 5000)
    expect(getRemotes().size).toBe(1)
    expect(getRosterVersion()).toBe(v0 + 1)
    expect(events).toEqual([
      { type: 'join', sessionId: 'session-a', userId: 'user-a', name: 'Alice' },
    ])
    const remote = getRemotes().get('session-a')!
    expect(remote.ph).toBe('game')
    expect(remote.joinedAt).toBe(5000)
    expect(latestSnapshot(remote.ring)!.sentAt).toBe(1000)
    expect(presenceCounters().received).toBe(1)
    off()
  })

  test('explicit editor frame = instant leave', () => {
    installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(poseMsg(), 5000)
    ingestPoseFrame(poseMsg({ data: gameFrame({ ph: 'editor' }), sentAt: 1100 }), 5100)
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  test(`staleness: a remote silent >${STALE_MS}ms despawns on the tick`, () => {
    installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(poseMsg(), 5000)
    presenceTick(5000 + STALE_MS) // exactly at the bound — still alive
    expect(getRemotes().size).toBe(1)
    presenceTick(5000 + STALE_MS + 1)
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  test('roster drop via onParticipants removes ghosts', () => {
    const bus = installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(poseMsg(), 5000)
    // Alice vanishes from the roster (tab closed, socket dropped).
    bus.rosterHandler?.([bus.participants[0]!])
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  /**
   * THE WIRING TEST — the only one here that goes through the real transport.
   * A well-formed host message must reach the registry (proving presence's
   * validator, kind and handler are actually registered with net.ts), and the
   * junk beside it must die at the transport boundary without ever reaching
   * the avatar layer. The transport's own edge cases live in net.test.ts.
   */
  test('a real host message reaches the registry; junk dies at the transport', () => {
    const bus = installBus()
    startPresence(() => localPose())
    const deliver = bus.handler!
    deliver(busMsg(gameFrame(), 1)) // well-formed → joins
    expect(getRemotes().size).toBe(1)
    expect(getRemotes().has('session-a')).toBe(true)

    const received = presenceCounters().received
    deliver(busMsg(gameFrame(), 2, { sessionId: 'session-me' })) // our own echo
    deliver({ ...busMsg(gameFrame(), 3), event: 'chat' }) // event/kind mismatch
    deliver({ ...busMsg(gameFrame(), 4), data: { v: 7 } }) // bad envelope
    deliver({ ...busMsg(gameFrame(), 5), sentAt: Number.NaN }) // corrupt stamp
    deliver(busMsg({ ...gameFrame(), yaw: Number.NaN }, 6)) // payload rejected
    deliver(busMsg(gameFrame(), 1, { sessionId: 'session-b' })) // valid stranger
    // Of those six, exactly ONE reached the avatar layer.
    expect(presenceCounters().received).toBe(received + 1)
    expect(getRemotes().size).toBe(2)
    expect(getRemotes().has('session-me')).toBe(false)
  })

  test('out-of-order frames update liveness but never rewind the ring', () => {
    installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg({ sentAt: 2000, data: gameFrame({ p: [5, 0, 0] }) }), 5000)
    ingestPoseFrame(poseMsg({ sentAt: 1500, data: gameFrame({ p: [9, 0, 0] }) }), 5100)
    const remote = getRemotes().get('session-a')!
    expect(latestSnapshot(remote.ring)!.x).toBe(5) // late frame dropped by the ring
    expect(remote.lastReceivedAt).toBe(5100) // ...but the peer is clearly alive
  })
})

// ── Crowd ceiling ────────────────────────────────────────────────────────────

describe('crowd ceiling — the cap policy (pure)', () => {
  const slot = (sessionId: string, dist: number, lastReceivedAt = 1000): CrowdSlot => ({
    sessionId,
    distSq: dist * dist,
    lastReceivedAt,
  })

  test('under the cap everyone is admitted, nothing is evicted', () => {
    const slots = [slot('a', 5), slot('b', 50)]
    expect(admitRemote(slots, { distSq: 999 * 999 }, 4)).toEqual({ admit: true, evict: null })
  })

  test('at the cap a farther newcomer is culled, not rendered', () => {
    const slots = [slot('a', 5), slot('b', 10)]
    expect(admitRemote(slots, { distSq: 40 * 40 }, 2)).toEqual({ admit: false, evict: null })
  })

  test('at the cap a decisively closer newcomer displaces the FARTHEST slot', () => {
    const slots = [slot('near', 5), slot('far', 60)]
    expect(admitRemote(slots, { distSq: 8 * 8 }, 2)).toEqual({ admit: true, evict: 'far' })
  })

  test(`hysteresis: closer by less than ${CROWD_SWAP_MARGIN_M}m does NOT swap`, () => {
    const slots = [slot('a', 5), slot('far', 30)]
    // 29 m vs 30 m — a real swap would re-mount a rig every frame as two
    // strangers jostle at the same range.
    expect(admitRemote(slots, { distSq: 29 * 29 }, 2)).toEqual({ admit: false, evict: null })
    expect(admitRemote(slots, { distSq: 27.9 * 27.9 }, 2)).toEqual({ admit: true, evict: 'far' })
  })

  test('an unpositioned slot ranks farthest and loses to a positioned newcomer', () => {
    const slots = [slot('a', 5), { sessionId: 'ghost', distSq: Infinity, lastReceivedAt: 1000 }]
    expect(admitRemote(slots, { distSq: 99 * 99 }, 2)).toEqual({ admit: true, evict: 'ghost' })
  })

  test('with no distances at all the cap still holds — oldest-heard goes', () => {
    const slots = [
      { sessionId: 'old', distSq: Infinity, lastReceivedAt: 100 },
      { sessionId: 'new', distSq: Infinity, lastReceivedAt: 900 },
    ]
    expect(admitRemote(slots, { distSq: Infinity }, 2)).toEqual({ admit: true, evict: 'old' })
  })
})

describe('crowd ceiling — enforced at ingest', () => {
  /** Peer i stands i*10 m down +X; the local pose sits near the origin. */
  function crowdFrame(i: number) {
    return poseMsg({
      sessionId: `session-${i}`,
      clientId: `client-${i}`,
      userId: `user-${i}`,
      data: gameFrame({ p: [i * 10, 0, 0] }),
      sentAt: 1000 + i,
    })
  }

  test(`a ${MAX_REMOTE_AVATARS * 3}-peer flood never renders more than ${MAX_REMOTE_AVATARS}`, () => {
    installBus()
    startPresence(() => localPose({ x: 0, y: 0, z: 0 }))
    for (let i = 0; i < MAX_REMOTE_AVATARS * 3; i++) ingestPoseFrame(crowdFrame(i), 5000 + i)
    expect(getRemotes().size).toBe(MAX_REMOTE_AVATARS)
    // The CLOSEST peers kept their slots; the distant crowd was refused.
    const kept = [...getRemotes().keys()].sort(
      (a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]),
    )
    expect(kept).toEqual(
      Array.from({ length: MAX_REMOTE_AVATARS }, (_, i) => `session-${i}`),
    )
    expect(presenceCounters().culled).toBe(MAX_REMOTE_AVATARS * 2)
    // Every frame was still valid and counted — culling is a render decision.
    expect(presenceCounters().received).toBe(MAX_REMOTE_AVATARS * 3)
  })

  test('a culled newcomer is silent: no roster bump, no join toast, no entry', () => {
    installBus()
    startPresence(() => localPose({ x: 0, y: 0, z: 0 }))
    for (let i = 0; i < MAX_REMOTE_AVATARS; i++) ingestPoseFrame(crowdFrame(i), 5000 + i)
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    const version = getRosterVersion()
    ingestPoseFrame(crowdFrame(500), 6000) // 5 km away — never in view
    expect(getRemotes().has('session-500')).toBe(false)
    expect(getRosterVersion()).toBe(version)
    expect(events).toEqual([])
    off()
  })

  test('a close arrival displaces the farthest peer — and never claims it "left"', () => {
    installBus()
    startPresence(() => localPose({ x: 0, y: 0, z: 0 }))
    for (let i = 0; i < MAX_REMOTE_AVATARS; i++) ingestPoseFrame(crowdFrame(i), 5000 + i)
    const farthest = `session-${MAX_REMOTE_AVATARS - 1}`
    expect(getRemotes().has(farthest)).toBe(true)
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(
      poseMsg({
        sessionId: 'session-close',
        userId: 'user-close',
        data: gameFrame({ p: [1, 0, 1] }),
        sentAt: 9000,
      }),
      7000,
    )
    expect(getRemotes().has('session-close')).toBe(true)
    expect(getRemotes().has(farthest)).toBe(false) // slot taken
    expect(getRemotes().size).toBe(MAX_REMOTE_AVATARS) // ceiling holds
    // The displaced peer is still in the project — only 'join' is truthful.
    expect(events.map((e) => e.type)).toEqual(['join'])
    off()
  })

  test('presenceDebug reports the cap and the cull count', () => {
    installBus()
    startPresence(() => localPose({ x: 0, y: 0, z: 0 }))
    for (let i = 0; i < MAX_REMOTE_AVATARS + 3; i++) ingestPoseFrame(crowdFrame(i), 5000 + i)
    const dump = presenceDebug()
    expect(dump.cap).toBe(MAX_REMOTE_AVATARS)
    expect(dump.culled).toBe(3)
    expect(dump.remotes.length).toBe(MAX_REMOTE_AVATARS)
  })
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('start/stop lifecycle', () => {
  test('startPresence is idempotent — a remount swaps the sampler only', () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg(), 5000)
    const v = getRosterVersion()
    expect(startPresence(() => localPose({ x: 42 }))).toBe(true)
    expect(getRemotes().size).toBe(1) // registry survived the remount
    expect(getRosterVersion()).toBe(v)
    expect(bus.unsubscribed).toBe(0)
  })

  test("stopPresence publishes one final explicit ph:'editor' frame, then tears down", () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg(), 5000)
    stopPresence()
    const last = publishedFrame(bus, bus.publishes.length - 1)
    expect(last.ph).toBe('editor') // the goodbye — peers despawn us instantly
    expect(bus.unsubscribed).toBe(1)
    expect(bus.rosterHandler).toBeNull()
    expect(getRemotes().size).toBe(0)
    stopPresence() // second call (ActiveGame unmount after exitGame) → no-op
    expect(bus.unsubscribed).toBe(1)
  })
})

// ── QA dump ──────────────────────────────────────────────────────────────────

describe('presenceDebug — plain copies for __boots', () => {
  test('dumps sessionId/name/p/w/ageMs + counters, never live refs', () => {
    installBus()
    startPresence(() => localPose())
    presenceTick(1000)
    ingestPoseFrame(poseMsg({ data: gameFrame({ p: [3, 1, -2], w: 'minigun' }) }), Date.now())
    const dump = presenceDebug()
    expect(dump.published).toBe(1)
    expect(dump.received).toBe(1)
    expect(dump.remotes.length).toBe(1)
    const entry = dump.remotes[0]!
    expect(entry.sessionId).toBe('session-a')
    expect(entry.name).toBe('Alice')
    expect(entry.p).toEqual([3, 1, -2])
    expect(entry.w).toBe('minigun')
    expect(entry.ageMs).toBeGreaterThanOrEqual(0)
    const remote = getRemotes().get('session-a')!
    expect(entry.p).not.toBe(latestSnapshot(remote.ring)) // plain data
  })
})
