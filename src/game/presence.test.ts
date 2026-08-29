import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildFrame,
  type CollabBus,
  type CollabBusMessage,
  type CollabParticipant,
  CROWDED_REMOTES,
  framesEqual,
  getCollabBus,
  getRemotes,
  getRosterVersion,
  IDLE_MAX_SILENCE_MS,
  ingestBusMessage,
  type LocalPose,
  onPresenceEvent,
  PLUGIN_ID,
  PLAYER_EVENT,
  type PresenceEvent,
  presenceCounters,
  presenceDebug,
  presenceTick,
  publishIntervalMs,
  reconcileRoster,
  shouldPublish,
  startPresence,
  stopPresence,
  wrapAngle,
} from './presence'
import type { PresenceFrame } from './presence-interp'
import { latestSnapshot, STALE_MS } from './presence-interp'

/**
 * Bus-adapter contract: feature-detected no-op without a bus; publish
 * cadence 12 Hz base / 10 Hz crowded / idle-skip / 500 ms keep-alive /
 * deferred-skip (all PURE and pinned here); remote registry join/leave
 * edges (explicit editor frame, staleness, roster drop); QA counters.
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

function msg(over: Partial<CollabBusMessage> = {}): CollabBusMessage {
  return {
    event: PLAYER_EVENT,
    data: gameFrame(),
    sessionId: 'session-a',
    clientId: 'client-a',
    userId: 'user-a',
    sentAt: 1000,
    ...over,
  }
}

afterEach(() => {
  stopPresence()
  delete g.__pascalCollabBus
})

// ── Feature detection ────────────────────────────────────────────────────────

describe('feature detection — absent bus means total no-op', () => {
  test('no bus: getCollabBus null, startPresence false, everything inert', () => {
    expect(getCollabBus()).toBeNull()
    expect(startPresence(() => localPose())).toBe(false)
    stopPresence() // must not throw
    presenceTick(1000) // must not throw
    expect(getRemotes().size).toBe(0)
    expect(presenceCounters()).toEqual({ published: 0, received: 0 })
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
    expect((bus.publishes[1]!.data as PresenceFrame).p[0]).toBe(5)
    expect(presenceCounters().published).toBe(1)
  })

  test('the wire object is a plain copy, never a live scratch reference', () => {
    const bus = installBus()
    let x = 0
    startPresence(() => localPose({ x }))
    presenceTick(1000)
    x = 9
    presenceTick(2000)
    const first = bus.publishes[0]!.data as PresenceFrame
    const second = bus.publishes[1]!.data as PresenceFrame
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
    ingestBusMessage(msg(), 5000)
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
    ingestBusMessage(msg(), 5000)
    ingestBusMessage(msg({ data: gameFrame({ ph: 'editor' }), sentAt: 1100 }), 5100)
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  test(`staleness: a remote silent >${STALE_MS}ms despawns on the tick`, () => {
    installBus()
    startPresence(() => localPose())
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    ingestBusMessage(msg(), 5000)
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
    ingestBusMessage(msg(), 5000)
    // Alice vanishes from the roster (tab closed, socket dropped).
    bus.rosterHandler?.([bus.participants[0]!])
    expect(getRemotes().size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(['join', 'leave'])
    off()
  })

  test('self-echo, foreign events and invalid frames never join', () => {
    installBus()
    startPresence(() => localPose())
    ingestBusMessage(msg({ sessionId: 'session-me' }), 5000) // our own echo
    ingestBusMessage(msg({ event: 'chat' }), 5000) // not a player event
    ingestBusMessage(msg({ data: { v: 7 } }), 5000) // wrong protocol
    ingestBusMessage(msg({ sentAt: Number.NaN }), 5000) // corrupt envelope
    expect(getRemotes().size).toBe(0)
    expect(presenceCounters().received).toBe(0)
  })

  test('out-of-order frames update liveness but never rewind the ring', () => {
    installBus()
    startPresence(() => localPose())
    ingestBusMessage(msg({ sentAt: 2000, data: gameFrame({ p: [5, 0, 0] }) }), 5000)
    ingestBusMessage(msg({ sentAt: 1500, data: gameFrame({ p: [9, 0, 0] }) }), 5100)
    const remote = getRemotes().get('session-a')!
    expect(latestSnapshot(remote.ring)!.x).toBe(5) // late frame dropped by the ring
    expect(remote.lastReceivedAt).toBe(5100) // ...but the peer is clearly alive
  })
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe('start/stop lifecycle', () => {
  test('startPresence is idempotent — a remount swaps the sampler only', () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestBusMessage(msg(), 5000)
    const v = getRosterVersion()
    expect(startPresence(() => localPose({ x: 42 }))).toBe(true)
    expect(getRemotes().size).toBe(1) // registry survived the remount
    expect(getRosterVersion()).toBe(v)
    expect(bus.unsubscribed).toBe(0)
  })

  test("stopPresence publishes one final explicit ph:'editor' frame, then tears down", () => {
    const bus = installBus()
    startPresence(() => localPose())
    ingestBusMessage(msg(), 5000)
    stopPresence()
    const last = bus.publishes[bus.publishes.length - 1]!.data as PresenceFrame
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
    ingestBusMessage(msg({ data: gameFrame({ p: [3, 1, -2], w: 'minigun' }) }), Date.now())
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
