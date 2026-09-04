import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type BootsEnvelope,
  type CollabBus,
  type CollabBusMessage,
  type CollabParticipant,
  getCollabBus,
  NET_PROTOCOL,
  netAvailable,
  netBus,
  type NetMessage,
  PLUGIN_ID,
  resetNetIdentity,
  resetNetKinds,
  stopNet,
} from './net'
import {
  admitRemote,
  BACKGROUND_KEEPALIVE_MS,
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
  rebindTransport,
  reconcileRoster,
  registerPresenceDebugSource,
  remoteLabel,
  ROSTER_GRACE_MS,
  rosterGraceExpired,
  shouldPublish,
  startPresence,
  startSpectating,
  stopPresence,
  stopSpectating,
  TICK_MS,
  TICK_TOLERANCE_MS,
  wrapAngle,
  wrapShots,
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
    f: 0,
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
    f: 0,
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

/** The transport's sequence number on published frame `i`. */
function publishedSeq(bus: FakeBus, i: number): number {
  return (bus.publishes[i]!.data as BootsEnvelope).seq
}

afterEach(() => {
  stopPresence()
  stopSpectating() // a receive-only adapter left by a spectate test
  stopNet() // in case a test opened the transport without presence
  resetNetKinds() // registered kinds are module-global — do not bleed
  resetNetIdentity() // the bus-swap history outlives stopNet by design
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

  test(`rate gate tolerance: the qualifying tick a hair early (${TICK_MS * 4 - 1} ms) passes, three ticks never`, () => {
    // 21 ms ticks: the 4th lands at 84 ms — or 83 when the timer runs a
    // millisecond early. Without the half-tick tolerance that publish slipped
    // to the 5th tick, and 25 ms ticks could only ever hit 100 ms (10 Hz).
    expect(TICK_TOLERANCE_MS).toBe(TICK_MS / 2)
    expect(shouldPublish({ now: 1083, lastPublishAt: 1000, remoteCount: 0, changed: true })).toBe(true)
    expect(shouldPublish({ now: 1063, lastPublishAt: 1000, remoteCount: 0, changed: true })).toBe(false)
    // Crowded (100 ms gate): four ticks (84) no, five (105) yes.
    expect(shouldPublish({ now: 1084, lastPublishAt: 1000, remoteCount: 5, changed: true })).toBe(false)
    expect(shouldPublish({ now: 1105, lastPublishAt: 1000, remoteCount: 5, changed: true })).toBe(true)
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

  /**
   * The one that makes remote gunfire audible at all: a player standing still
   * and emptying a magazine is IDLE by every other measure on the frame, so
   * without the fire counter in the comparison the idle skip would sit on those
   * rounds until the 500 ms keep-alive and the shots would arrive in a clump
   * half a second late.
   */
  test('framesEqual: a changed fire counter is never idle', () => {
    expect(framesEqual(gameFrame(), gameFrame({ f: 1 }))).toBe(false)
    expect(framesEqual(gameFrame({ f: 7 }), gameFrame({ f: 7 }))).toBe(true)
    // Even across the wrap, where the count goes DOWN.
    expect(framesEqual(gameFrame({ f: 255 }), gameFrame({ f: 0 }))).toBe(false)
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

  test('the fire counter rides the frame, wrapped into a byte', () => {
    const out = gameFrame()
    buildFrame(localPose({ f: 41 }), out)
    expect(out.f).toBe(41)
    // A long session keeps counting locally; the wire only ever sees a byte,
    // and peers read DIFFERENCES, so the wrap costs nothing.
    buildFrame(localPose({ f: 300 }), out)
    expect(out.f).toBe(44)
  })

  test('the resolved hitscan endpoint is centimeter-quantized onto the pose', () => {
    const out = gameFrame()
    buildFrame(localPose({ t: [12.345, 4.567, -8.901] }), out)
    expect(out.t).toEqual([12.35, 4.57, -8.9])
    buildFrame(localPose({ t: undefined }), out)
    expect(out.t).toBeUndefined()
  })

  test('wrapShots: byte-wrapped, non-negative, junk-proof', () => {
    expect(wrapShots(0)).toBe(0)
    expect(wrapShots(255)).toBe(255)
    expect(wrapShots(256)).toBe(0)
    expect(wrapShots(257)).toBe(1)
    expect(wrapShots(12.7)).toBe(12) // a counter is a count
    expect(wrapShots(-5)).toBe(0)
    expect(wrapShots(Number.NaN)).toBe(0)
    expect(wrapShots(Number.POSITIVE_INFINITY)).toBe(0)
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

  test(`a moving pose publishes ~12 Hz over 10 s of ${TICK_MS} ms ticks (118-121, not 101)`, () => {
    const bus = installBus()
    let x = 0
    startPresence(() => localPose({ x }))
    for (let t = TICK_MS; t <= 10000; t += TICK_MS) {
      x += 0.1 // always changed
      presenceTick(t)
    }
    expect(bus.publishes.length).toBeGreaterThanOrEqual(118)
    expect(bus.publishes.length).toBeLessThanOrEqual(121)
  })

  test('…and still 115-125 times when every tick lands 0-8 ms or 0-16 ms LATE (a loaded main thread)', () => {
    // setInterval never fires early but fires late under load — a 60 fps game
    // loop delays a 21 ms timer by up to a frame. The half-tick tolerance is
    // measured from the ACTUAL last publish, so a late publishing tick makes
    // the next 4th tick read short; this pins that the cadence survives it
    // (a 3 ms tolerance measured 11.4 / 10.9 Hz here — see TICK_TOLERANCE_MS).
    for (const lateMax of [8, 16]) {
      stopPresence()
      stopNet()
      resetNetKinds()
      const bus = installBus()
      let x = 0
      startPresence(() => localPose({ x }))
      let seed = 987654321 + lateMax
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      for (let t = TICK_MS; t <= 10000; t += TICK_MS) {
        x += 0.1
        presenceTick(t + rnd() * lateMax) // 21 ms grid, each tick 0..lateMax late
      }
      expect(bus.publishes.length).toBeGreaterThanOrEqual(115)
      expect(bus.publishes.length).toBeLessThanOrEqual(125)
    }
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

  test(`roster drop via onParticipants removes ghosts — after ${ROSTER_GRACE_MS} ms of grace, on the tick`, () => {
    const bus = installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    const t0 = Date.now()
    ingestPoseFrame(poseMsg(), t0)
    // Alice vanishes from the roster (tab closed, socket dropped) — through
    // the real bus subscription, which stamps the live clock.
    bus.rosterHandler?.([bus.participants[0]!])
    expect(getRemotes().size).toBe(1) // not yet: the roster alone is a hint
    const marked = getRemotes().get('session-a')!.rosterMissingSince
    expect(marked).toBeGreaterThanOrEqual(t0)
    expect(presenceDebug().remotes[0]!.rosterMissingMs).toBeGreaterThanOrEqual(0)
    presenceTick(marked + ROSTER_GRACE_MS) // at the bound — still here
    expect(getRemotes().size).toBe(1)
    presenceTick(marked + ROSTER_GRACE_MS + 1)
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  test('the join event carries the chosen nick when the frame has one (remoteLabel)', () => {
    installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(poseMsg({ data: gameFrame({ nm: 'Zed' }) }), 5000)
    expect(events[0]!.name).toBe('Zed')
    // The same rule, exported: nick, then roster, then 'builder'.
    expect(remoteLabel({ nick: 'Zed', userId: 'user-a' })).toBe('Zed')
    expect(remoteLabel({ nick: '', userId: 'user-a' })).toBe('Alice')
    expect(remoteLabel({ nick: '', userId: 'user-nobody' })).toBe('builder')
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

  test('an out-of-order frame feeds neither the arrival timing nor the clock offset', () => {
    installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg({ sentAt: 1000 }), 5000)
    ingestPoseFrame(poseMsg({ sentAt: 1084 }), 5084)
    ingestPoseFrame(poseMsg({ sentAt: 1168 }), 5168)
    const remote = getRemotes().get('session-a')!
    const before = { ...remote.timing }
    const offsetBefore = remote.clockOffset
    // A reordered frame (older than the newest) arriving late.
    ingestPoseFrame(poseMsg({ sentAt: 1126 }), 5300)
    expect(remote.timing).toEqual(before) // lastSentAt not rewound, no spacing/jitter/gap sample
    expect(remote.clockOffset).toBe(offsetBefore)
    expect(remote.lastReceivedAt).toBe(5300) // liveness still counts it
    // A duplicate of the newest is refused the same way.
    ingestPoseFrame(poseMsg({ sentAt: 1168 }), 5310)
    expect(remote.timing).toEqual(before)
    // The next in-order frame samples its true 84 ms spacing, not 1252 − 1126.
    ingestPoseFrame(poseMsg({ sentAt: 1252 }), 5252)
    expect(remote.timing.spacingEma).toBeCloseTo(84, 6)
    expect(remote.timing.gaps).toBe(0)
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

describe('presenceDebug — timing, delay, drawn pose, extra sources', () => {
  test('ingest feeds the arrival timing: 84 ms frames sample spacing, a 500 ms keep-alive is a gap', () => {
    installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg({ sentAt: 1000 }), 5000)
    ingestPoseFrame(poseMsg({ sentAt: 1084 }), 5084)
    ingestPoseFrame(poseMsg({ sentAt: 1168 }), 5168)
    const remote = getRemotes().get('session-a')!
    expect(remote.timing.spacingEma).toBeCloseTo(84, 6)
    expect(remote.timing.gaps).toBe(0)
    ingestPoseFrame(poseMsg({ sentAt: 1668 }), 5668)
    expect(remote.timing.gaps).toBe(1)
    expect(remote.timing.lastGapMs).toBe(500)
    expect(remote.timing.spacingEma).toBeCloseTo(84, 6)
    // A late frame (offset 40 ms over the EMA) registers as jitter.
    ingestPoseFrame(poseMsg({ sentAt: 1752 }), 5792)
    expect(remote.timing.jitterEma).toBeGreaterThan(0)
  })

  test('the dump carries spacing/jitter/gaps, the renderer delay, the drawn eye, net drops, the tick', () => {
    installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg({ data: gameFrame({ p: [3, 1, -2] }) }), Date.now())
    let dump = presenceDebug()
    let entry = dump.remotes[0]!
    expect(entry.spacingMs).toBe(84)
    expect(entry.jitterMs).toBe(0)
    expect(entry.gaps).toBe(0)
    expect(entry.lastGapMs).toBe(0)
    expect(entry.delayMs).toBe(0) // nothing has drawn this peer on this page
    expect(entry.drawn).toBeNull()
    expect(entry.drawnAgeMs).toBe(-1)
    expect(typeof dump.netDropped).toBe('number')
    expect(dump.tickMs).toBe(TICK_MS)
    expect(dump.extra).toEqual(expect.any(Object))
    // The renderer writes where it drew the peer; consumers read it when fresh.
    const remote = getRemotes().get('session-a')!
    remote.drawnX = 3.1
    remote.drawnY = 1.02
    remote.drawnZ = -2.05
    remote.drawnAt = Date.now()
    remote.delayMs = 150
    dump = presenceDebug()
    entry = dump.remotes[0]!
    expect(entry.drawn).toEqual([3.1, 1.02, -2.05])
    expect(entry.drawnAgeMs).toBeGreaterThanOrEqual(0)
    expect(entry.delayMs).toBe(150)
  })

  test('registered debug sources ride along under extra.<name>, plain data, and unregister cleanly', () => {
    const off = registerPresenceDebugSource('probe', () => ({ a: 1 }))
    expect(presenceDebug().extra.probe).toEqual({ a: 1 })
    const offBad = registerPresenceDebugSource('bad', () => {
      throw new Error('boom')
    })
    expect(presenceDebug().extra.bad).toBeNull() // a broken source never breaks the dump
    off()
    offBad()
    expect(presenceDebug().extra.probe).toBeUndefined()
    expect(presenceDebug().extra.bad).toBeUndefined()
  })
})

// ── Roster grace ─────────────────────────────────────────────────────────────

describe('roster grace — a roster drop is a hint, not a despawn', () => {
  /** The roster with Alice gone: only our own session listed. */
  const meOnly = (bus: FakeBus): CollabParticipant[] => [bus.participants[0]!]

  test(`missing from the roster: marked at once, dropped by the tick after ${ROSTER_GRACE_MS} ms, with a leave`, () => {
    const bus = installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(poseMsg(), 5000)
    const v = getRosterVersion()
    reconcileRoster(meOnly(bus), 5000)
    const remote = getRemotes().get('session-a')!
    expect(remote.rosterMissingSince).toBe(5000)
    expect(getRosterVersion()).toBe(v) // no roster bump for a mark
    presenceTick(5000 + ROSTER_GRACE_MS)
    expect(getRemotes().size).toBe(1)
    presenceTick(5000 + ROSTER_GRACE_MS + 1)
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  test('an EMPTY roster is the host mid-restart — ignored, nobody is even marked', () => {
    installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg(), 5000)
    reconcileRoster([], 5000)
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBe(0)
    // A roster with participants but no sessions at all is the same non-statement.
    reconcileRoster([{ userId: 'user-me', name: 'Me', sessions: [] }], 5100)
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBe(0)
    presenceTick(5000 + ROSTER_GRACE_MS + 1) // past the grace, inside STALE_MS
    expect(getRemotes().size).toBe(1)
  })

  test('listed again inside the grace → the mark clears, no leave', () => {
    const bus = installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestPoseFrame(poseMsg(), 5000)
    reconcileRoster(meOnly(bus), 5000)
    reconcileRoster(bus.participants, 5500) // presence sync caught up
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBe(0)
    presenceTick(5000 + ROSTER_GRACE_MS + 1)
    expect(getRemotes().size).toBe(1)
    expect(events.map((e) => e.type)).toEqual(['join'])
    off()
  })

  test('a frame from a roster-missing peer clears the mark — host-stamped frames outrank the roster', () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg(), 5000)
    reconcileRoster(meOnly(bus), 5000)
    ingestPoseFrame(poseMsg({ sentAt: 1100 }), 5500)
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBe(0)
    presenceTick(5000 + ROSTER_GRACE_MS + 1)
    expect(getRemotes().size).toBe(1)
    // A roster that STILL omits it restarts the countdown from now, not from 5000.
    reconcileRoster(meOnly(bus), 6000)
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBe(6000)
  })

  test('repeated roster pushes keep the ORIGINAL start of the countdown', () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg(), 5000)
    reconcileRoster(meOnly(bus), 5000)
    reconcileRoster(meOnly(bus), 5900)
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBe(5000)
    presenceTick(5000 + ROSTER_GRACE_MS + 1)
    expect(getRemotes().size).toBe(0)
  })

  test('rosterGraceExpired (pure): 0 never expires; past the window it does', () => {
    expect(rosterGraceExpired({ rosterMissingSince: 0 }, 1e9)).toBe(false)
    expect(rosterGraceExpired({ rosterMissingSince: 5000 }, 5000 + ROSTER_GRACE_MS)).toBe(false)
    expect(rosterGraceExpired({ rosterMissingSince: 5000 }, 5000 + ROSTER_GRACE_MS + 1)).toBe(true)
    expect(ROSTER_GRACE_MS).toBeLessThan(STALE_MS) // an explicit drop is still the stronger hint
    // …but it must OUTLAST a live peer's slowest keep-alive: a background tab
    // (1 Hz timer throttle) sends every ~1000-1100 ms, and a grace that expired
    // between two of those dropped someone who was still there.
    expect(BACKGROUND_KEEPALIVE_MS).toBeGreaterThan(IDLE_MAX_SILENCE_MS * 2)
    expect(ROSTER_GRACE_MS).toBeGreaterThanOrEqual(BACKGROUND_KEEPALIVE_MS + IDLE_MAX_SILENCE_MS)
  })

  test('a background-tab peer (keep-alive every ~1.1 s) that a lagging roster keeps omitting is never dropped', () => {
    const bus = installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    let sentAt = 1000
    ingestPoseFrame(poseMsg({ sentAt }), 5000)
    // Alice's tab is in the background: one frame every BACKGROUND_KEEPALIVE_MS
    // (a hair over the throttle). The host roster, half-synced after a restart,
    // omits her on every push (every 300 ms) for ten seconds straight.
    let nextFrameAt = 5000 + BACKGROUND_KEEPALIVE_MS + 50
    let nextRosterAt = 5300
    for (let t = 5000 + TICK_MS; t < 15000; t += TICK_MS) {
      if (t >= nextFrameAt) {
        sentAt += BACKGROUND_KEEPALIVE_MS + 50
        ingestPoseFrame(poseMsg({ sentAt }), t)
        nextFrameAt += BACKGROUND_KEEPALIVE_MS + 50
      }
      if (t >= nextRosterAt) {
        reconcileRoster(meOnly(bus), t)
        nextRosterAt += 300
      }
      presenceTick(t)
    }
    expect(getRemotes().size).toBe(1) // never dropped: her frames outrank the roster every time
    expect(events.map((e) => e.type)).toEqual(['join']) // and so no leave/join churn
    off()
  })

  test('the spectating adapter reconciles with the same grace', () => {
    const bus = installBus()
    expect(startSpectating()).toBe(true)
    ingestPoseFrame(poseMsg(), 5000)
    reconcileRoster(meOnly(bus), 5000)
    presenceTick(5000 + ROSTER_GRACE_MS)
    expect(getRemotes().size).toBe(1)
    presenceTick(5000 + ROSTER_GRACE_MS + 1)
    expect(getRemotes().size).toBe(0)
  })
})

// ── Bus rebinding ────────────────────────────────────────────────────────────

describe('bus rebinding — the host may swap or remove the bus under a running adapter', () => {
  test('a swapped bus is followed on the next tick: transport + roster move, the registry survives untouched', () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestPoseFrame(poseMsg(), 5000)
    presenceTick(5000) // one publish on the first bus
    expect(bus.publishes.length).toBe(1)
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    const v = getRosterVersion()
    expect(presenceDebug().rebinds).toBe(0)

    const next = makeBus()
    g.__pascalCollabBus = next
    presenceTick(5100)

    expect(netBus()).toBe(next)
    expect(bus.unsubscribed).toBe(1) // the old wire is released…
    expect(bus.rosterHandler).toBeNull() // …and so is the old roster subscription
    expect(next.handler).not.toBeNull()
    expect(next.rosterHandler).not.toBeNull()
    // Nobody left, nobody joined, nothing to re-render.
    expect(getRemotes().size).toBe(1)
    expect(getRosterVersion()).toBe(v)
    expect(events).toEqual([])
    const dump = presenceDebug()
    expect(dump.rebinds).toBe(1)
    expect(dump.swaps).toBe(1)
    expect(dump.bound).toBe(true)
    // Frames on the NEW bus reach the registry — from seq 1, because the
    // transport's per-sender trackers were reset with the swap.
    const received = presenceCounters().received
    next.handler!(busMsg(gameFrame({ p: [7, 0, 0] }), 1, { sentAt: 1200 }))
    expect(presenceCounters().received).toBe(received + 1)
    expect(latestSnapshot(getRemotes().get('session-a')!.ring)!.x).toBe(7)
    // …and our own frames went out on it AT ONCE — the tick that rebound also
    // published (the idle gate is reset by a rebind), no 500 ms of invisibility.
    expect(next.publishes.length).toBe(1)
    expect(bus.publishes.length).toBe(1) // only the pre-swap publish
    presenceTick(5200) // unchanged pose → the normal idle skip applies again
    expect(next.publishes.length).toBe(1)
    // The new roster subscription is live: a drop there starts the grace clock.
    next.rosterHandler!([next.participants[0]!])
    expect(getRemotes().get('session-a')!.rosterMissingSince).toBeGreaterThan(0)
    off()
  })

  test('our frames on a new bus CONTINUE the sequence — a peer whose tracker knows us never sees a rewind', () => {
    // The host keeps our sessionId across a channel restart (use-project-awareness
    // recreates the bus from the same input.sessionId), so every peer still holds
    // an ordered tracker for `session-me|pose` at our last seq. A counter that
    // restarted at 1 on the new bus would be refused as a rewind until their
    // 3 s staleness sweep despawned us, and the next accepted frame re-joined us —
    // a leave/join for a blip. net.ts keeps the counter page-monotonic; this is
    // the adapter-level pin that a rebind rides on it.
    const bus = installBus()
    startPresence(() => localPose())
    presenceTick(1000)
    presenceTick(1000 + IDLE_MAX_SILENCE_MS + 1) // the keep-alive
    expect(bus.publishes.length).toBe(2)
    expect(publishedSeq(bus, 1)).toBe(2)

    const next = makeBus() // same sessionId: a restart, not a re-key
    g.__pascalCollabBus = next
    presenceTick(1100 + IDLE_MAX_SILENCE_MS) // rebinds and publishes at once
    expect(next.publishes.length).toBe(1)
    expect(publishedSeq(next, 0)).toBe(3) // not 1

    // An outage spends no numbers; the bus that returns continues from 3.
    delete g.__pascalCollabBus
    presenceTick(2200)
    presenceTick(2200 + IDLE_MAX_SILENCE_MS + 1) // publish ticks with nowhere to go
    const back = makeBus()
    g.__pascalCollabBus = back
    presenceTick(3000)
    expect(back.publishes.length).toBe(1)
    expect(publishedSeq(back, 0)).toBe(4)
  })

  test('the bus goes away: the transport closes, the registry holds, and the peer is adopted when a bus returns', () => {
    const bus = installBus()
    startPresence(() => localPose())
    presenceTick(1000) // one publish on the first bus
    ingestPoseFrame(poseMsg(), 1000)
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))

    delete g.__pascalCollabBus
    presenceTick(1100)
    expect(netAvailable()).toBe(false)
    expect(presenceDebug().bound).toBe(false)
    expect(bus.rosterHandler).toBeNull() // the dead roster subscription is released
    expect(getRemotes().size).toBe(1) // an outage is not a leave
    presenceTick(1100 + IDLE_MAX_SILENCE_MS + 1) // a publish tick with nowhere to go
    expect(bus.publishes.length).toBe(1)
    expect(presenceDebug().rebinds).toBe(1)

    const next = makeBus()
    g.__pascalCollabBus = next
    presenceTick(1700)
    expect(netBus()).toBe(next)
    expect(presenceDebug().bound).toBe(true)
    expect(presenceDebug().rebinds).toBe(2)
    expect(next.rosterHandler).not.toBeNull()
    // The peer's stream picks up where the wire left off: accepted, no re-join.
    next.handler!(busMsg(gameFrame(), 41, { sentAt: 1700 }))
    expect(getRemotes().get('session-a')!.lastReceivedAt).toBeGreaterThan(1000)
    expect(events).toEqual([])
    // Publishing resumed on the returned bus with the tick that rebound (the
    // rate gate was clear: the last attempt was the dead-wire one at 1601).
    expect(next.publishes.length).toBe(1)
    presenceTick(1800) // unchanged → idle skip
    expect(next.publishes.length).toBe(1)
    off()
  })

  test('startPresence during an outage ADOPTS the spectating registry and reports false until the bus is back', () => {
    installBus()
    expect(startSpectating()).toBe(true)
    ingestPoseFrame(poseMsg(), 5000)
    delete g.__pascalCollabBus
    presenceTick(5100)
    expect(netAvailable()).toBe(false)

    // JUMP IN while the host is between buses.
    expect(startPresence(() => localPose())).toBe(false) // honest: not live yet…
    expect(getRemotes().size).toBe(1) // …but the registry is adopted, not rebuilt
    stopSpectating() // the editor layer's cleanup on the phase flip: a no-op now — the game owns it
    expect(getRemotes().size).toBe(1)

    const next = makeBus()
    g.__pascalCollabBus = next
    expect(startPresence(() => localPose())).toBe(true) // the retry that lands
    expect(netBus()).toBe(next)
    presenceTick(5200)
    expect(next.publishes.length).toBe(1) // publishing began on the first tick with a bus
    expect(getRemotes().size).toBe(1)
  })

  test('stopPresence says goodbye on a bus that returned between ticks', () => {
    installBus()
    startPresence(() => localPose())
    presenceTick(1000)
    delete g.__pascalCollabBus
    presenceTick(1100)
    const next = makeBus()
    g.__pascalCollabBus = next
    stopPresence() // no tick has run since the bus came back
    expect(next.publishes.length).toBe(1)
    expect(publishedFrame(next, 0).ph).toBe('editor')
    expect(next.unsubscribed).toBe(1)
    expect(next.rosterHandler).toBeNull()
  })

  test('steady state is not a rebind; an inactive adapter never rebinds', () => {
    expect(rebindTransport()).toBe(false) // nothing running
    installBus()
    startPresence(() => localPose())
    for (let t = 1000; t < 3000; t += TICK_MS) presenceTick(t)
    expect(rebindTransport()).toBe(false)
    expect(presenceDebug().rebinds).toBe(0)
    expect(presenceDebug().swaps).toBe(0)
  })

  test('a stale transport left by an earlier session is moved onto the installed bus at start', () => {
    // The transport is opened (by us, in a previous life) on bus X…
    const stale = installBus()
    startPresence(() => localPose())
    stopSpectating() // not the owner — a no-op that proves nothing leaks
    // …then the host installs Y while the adapter is down but net is not
    // restarted through presence: startNet would idle on X.
    stopPresence()
    expect(netBus()).toBeNull()
    g.__pascalCollabBus = stale // X back so startNet has something to bind to
    startSpectating()
    const fresh = makeBus()
    g.__pascalCollabBus = fresh
    // The tick follows it, as always; but a game start finding net on X must too.
    expect(startPresence(() => localPose())).toBe(true)
    expect(netBus()).toBe(fresh)
    expect(fresh.rosterHandler).not.toBeNull()
  })
})

describe('presenceDebug — roster truth fields', () => {
  test('name is the label rule; nick, rosterName, lastSeenMs and rosterMissingMs ride along', () => {
    const bus = installBus()
    startPresence(() => localPose())
    const t0 = Date.now()
    ingestPoseFrame(poseMsg({ data: gameFrame({ nm: 'Zed' }) }), t0)
    let entry = presenceDebug().remotes[0]!
    expect(entry.name).toBe('Zed') // what the tag, the toasts and the pill print
    expect(entry.nick).toBe('Zed')
    expect(entry.rosterName).toBe('Alice')
    expect(entry.lastSeenMs).toBe(t0)
    expect(entry.ageMs).toBe(Date.now() - t0)
    expect(entry.rosterMissingMs).toBe(0)
    // Without a nick the label falls back to the roster name.
    ingestPoseFrame(poseMsg({ sentAt: 1100 }), t0 + 84)
    entry = presenceDebug().remotes[0]!
    expect(entry.name).toBe('Alice')
    expect(entry.nick).toBe('')
    expect(entry.lastSeenMs).toBe(t0 + 84)
    // A roster drop shows as a running rosterMissingMs.
    reconcileRoster([bus.participants[0]!], Date.now() - 300)
    expect(presenceDebug().remotes[0]!.rosterMissingMs).toBeGreaterThanOrEqual(300)
    const dump = presenceDebug()
    expect(dump.bound).toBe(true)
    expect(dump.swaps).toBe(0)
    expect(dump.rebinds).toBe(0)
    expect(dump.rosterGraceMs).toBe(ROSTER_GRACE_MS)
  })
})
