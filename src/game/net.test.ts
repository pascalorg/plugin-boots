import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  type BootsEnvelope,
  type BootsFrameKind,
  type CollabBus,
  type CollabBusMessage,
  type CollabParticipant,
  forgetSender,
  FRAME_KINDS,
  getCollabBus,
  getParticipants,
  ingestBusMessage,
  isFrameKind,
  localSessionId,
  MAX_PAYLOAD_SERIALIZED,
  NET_PROTOCOL,
  netAvailable,
  netCounters,
  type NetMessage,
  onFrame,
  onParticipants,
  onStateRequest,
  onStateSnapshot,
  participantName,
  payloadFits,
  PLUGIN_ID,
  publishFrame,
  readEnvelope,
  registerFrameKind,
  requestState,
  resetNetKinds,
  sendStateSnapshot,
  SEQ_TRACK_MAX,
  serializedLength,
  shouldAnswerStateRequest,
  startNet,
  stopNet,
} from './net'

/**
 * THE TRANSPORT CONTRACT — this is what the destruction/build sync core
 * builds against, so every promise net.ts makes is pinned here:
 * feature detection (the flag-off guarantee), the envelope codec, per-kind
 * sequence numbers and the `skipped` loss signal, bounded memory, the
 * payload cap, kind routing and handler isolation, and the late-join
 * request/snapshot handshake with its single-responder election.
 */

// ── Fake bus ─────────────────────────────────────────────────────────────────

type FakeBus = CollabBus & {
  publishes: Array<{ pluginId: string; event: string; data: unknown }>
  publishResult: 'sent' | 'deferred' | 'suppressed'
  publishThrows: boolean
  handler: ((msg: CollabBusMessage) => void) | null
  rosterHandler: ((participants: CollabParticipant[]) => void) | null
  participants: CollabParticipant[]
  unsubscribed: number
}

function makeBus(): FakeBus {
  const bus: FakeBus = {
    version: 1,
    projectId: 'lobby',
    sessionId: 'session-me',
    clientId: 'client-me',
    userId: 'user-me',
    publishes: [],
    publishResult: 'sent',
    publishThrows: false,
    handler: null,
    rosterHandler: null,
    participants: [
      { userId: 'user-me', name: 'Me', sessions: [{ sessionId: 'session-me', clientId: 'client-me' }] },
      { userId: 'user-a', name: 'Alice', sessions: [{ sessionId: 'session-a', clientId: 'client-a' }] },
    ],
    unsubscribed: 0,
    publish(pluginId, event, data) {
      if (bus.publishThrows) throw new Error('bus tearing down')
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

/** A permissive echo validator — this suite tests the TRANSPORT, and each
 * kind's real validator is that kind owner's own test's problem. */
const echo = (data: unknown): unknown => (data === null || data === undefined ? null : data)

function inbound(
  envelope: unknown,
  over: Partial<CollabBusMessage> = {},
): CollabBusMessage {
  const kind =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as { kind?: string }).kind
      : undefined
  return {
    event: kind ?? 'pose',
    data: envelope,
    sessionId: 'session-a',
    clientId: 'client-a',
    userId: 'user-a',
    sentAt: 1000,
    ...over,
  }
}

function frame(
  kind: BootsFrameKind,
  seq: number,
  data: unknown,
  extra: Partial<BootsEnvelope> = {},
): BootsEnvelope {
  return { v: NET_PROTOCOL, kind, seq, data, ...extra }
}

/** Collect everything delivered to `kind`. */
function collect<P = unknown>(kind: BootsFrameKind): { got: Array<NetMessage<P>>; off: () => void } {
  const got: Array<NetMessage<P>> = []
  const off = onFrame<P>(kind, (msg) => got.push(msg))
  return { got, off }
}

afterEach(() => {
  stopNet()
  resetNetKinds()
  delete g.__pascalCollabBus
})

// ── Feature detection / the flag-off guarantee ────────────────────────────────

describe('feature detection — no bus is a total no-op', () => {
  /**
   * `NEXT_PUBLIC_PLUGIN_COLLAB` is a HOST flag: the host installs
   * `globalThis.__pascalCollabBus` only when it is on, so "flag off" arrives
   * here as "no bus". Every entry point must be inert in that state — this is
   * the proof the whole feature costs nothing when disabled.
   */
  test('flag off: startNet false, publish unavailable, nothing delivered', () => {
    const before = netCounters()
    expect(getCollabBus()).toBeNull()
    expect(startNet()).toBe(false)
    expect(netAvailable()).toBe(false)
    expect(localSessionId()).toBeNull()
    expect(getParticipants()).toEqual([])
    expect(participantName('user-a')).toBeNull()

    let delivered = 0
    registerFrameKind('pose', echo)
    const off = onFrame('pose', () => {
      delivered++
    })
    expect(publishFrame('pose', { hello: 'world' })).toBe('unavailable')
    expect(requestState('destruction')).toBe('unavailable')
    expect(sendStateSnapshot('destruction', 'session-a', { cells: [] })).toBe('unavailable')
    // Even a well-formed inbound frame cannot be delivered: there is no wire.
    ingestBusMessage(inbound(frame('pose', 1, { x: 1 })))
    expect(delivered).toBe(0)
    expect(netCounters()).toEqual(before)
    // Teardown on a transport that never opened must not throw.
    stopNet()
    forgetSender('session-a')
    off()
  })

  test('a non-v1 bus reads as no bus (protocol gate)', () => {
    const bus = makeBus()
    bus.version = 2
    g.__pascalCollabBus = bus
    expect(getCollabBus()).toBeNull()
    expect(startNet()).toBe(false)
    expect(bus.handler).toBeNull() // never even subscribed
  })

  test('one subscription serves every kind, under the plugin id', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    registerFrameKind('destruction', echo)
    const subscribe = spyOn(bus, 'subscribe')
    expect(startNet()).toBe(true)
    expect(startNet()).toBe(true) // idempotent — a remount keeps the wire
    // ONE subscription total, for every kind: a second start must not open a
    // duplicate that would double-deliver every frame.
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(bus.handler).not.toBeNull()
    expect(netAvailable()).toBe(true)
    expect(localSessionId()).toBe('session-me')
    subscribe.mockRestore()
  })
})

// ── Envelope codec ───────────────────────────────────────────────────────────

describe('envelope codec — readEnvelope', () => {
  test('a well-formed envelope round-trips, part/parts default to 1', () => {
    const read = readEnvelope(frame('destruction', 7, { cells: [1, 2] }))
    expect(read).toEqual({
      v: NET_PROTOCOL,
      kind: 'destruction',
      seq: 7,
      part: 1,
      parts: 1,
      data: { cells: [1, 2] },
    })
  })

  test('chunk markers survive when present', () => {
    const read = readEnvelope(frame('state-snapshot', 1, 'chunk', { part: 2, parts: 5 }))
    expect(read?.part).toBe(2)
    expect(read?.parts).toBe(5)
  })

  test('a falsy-but-present data field is kept (0, null, false are payloads)', () => {
    for (const data of [0, null, false, '']) {
      expect(readEnvelope(frame('pose', 1, data))?.data).toBe(data)
    }
  })

  test('every malformed envelope reads as null', () => {
    const bad: Array<[string, unknown]> = [
      ['null', null],
      ['a number', 5],
      ['a string', 'pose'],
      ['an array', []],
      ['an empty object', {}],
      ['a bad protocol', { v: 2, kind: 'pose', seq: 1, data: {} }],
      ['an unknown kind', { v: 1, kind: 'exec', seq: 1, data: {} }],
      ['a missing kind', { v: 1, seq: 1, data: {} }],
      ['a missing data field', { v: 1, kind: 'pose', seq: 1 }],
      ['seq 0', { v: 1, kind: 'pose', seq: 0, data: {} }],
      ['a negative seq', { v: 1, kind: 'pose', seq: -1, data: {} }],
      ['a fractional seq', { v: 1, kind: 'pose', seq: 2.5, data: {} }],
      ['a NaN seq', { v: 1, kind: 'pose', seq: Number.NaN, data: {} }],
      ['a string seq', { v: 1, kind: 'pose', seq: '1', data: {} }],
      ['part without parts', { v: 1, kind: 'pose', seq: 1, part: 2, data: {} }],
      ['part > parts', { v: 1, kind: 'pose', seq: 1, part: 3, parts: 2, data: {} }],
      ['parts past the chunk bound', { v: 1, kind: 'pose', seq: 1, part: 1, parts: 2000, data: {} }],
    ]
    for (const [why, data] of bad) expect(readEnvelope(data), why).toBeNull()
  })

  test('isFrameKind guards the union; the kind list is the wire contract', () => {
    for (const kind of FRAME_KINDS) expect(isFrameKind(kind)).toBe(true)
    for (const junk of ['exec', '', 'Pose', null, 7, {}]) expect(isFrameKind(junk)).toBe(false)
    // Pinned deliberately: adding a kind is additive, RENAMING one is breaking.
    expect([...FRAME_KINDS]).toEqual([
      'pose',
      'destruction',
      'build',
      'state-request',
      'state-snapshot',
    ])
  })
})

// ── Publish ──────────────────────────────────────────────────────────────────

describe('publish — sequencing, host verdicts, the payload cap', () => {
  test('each kind gets its OWN host event and its own monotonic counter', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    registerFrameKind('destruction', echo)
    startNet()
    publishFrame('pose', { a: 1 })
    publishFrame('destruction', { b: 1 })
    publishFrame('pose', { a: 2 })
    expect(bus.publishes.map((p) => p.event)).toEqual(['pose', 'destruction', 'pose'])
    expect(bus.publishes.every((p) => p.pluginId === PLUGIN_ID)).toBe(true)
    const seqs = bus.publishes.map((p) => (p.data as BootsEnvelope).seq)
    // Per-kind counters: the destruction stream is not perturbed by poses.
    expect(seqs).toEqual([1, 1, 2])
  })

  test('the host verdict is returned verbatim — the caller decides what to do', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    startNet()
    expect(publishFrame('pose', { a: 1 })).toBe('sent')
    bus.publishResult = 'deferred'
    expect(publishFrame('pose', { a: 2 })).toBe('deferred')
    bus.publishResult = 'suppressed'
    expect(publishFrame('pose', { a: 3 })).toBe('suppressed')
    // Only accepted frames count as published...
    expect(netCounters().published).toBe(1)
    // ...but the SEQUENCE advanced on every attempt, so a receiver's `skipped`
    // reports frames the host coalesced away instead of reading as contiguous.
    // This is the signal a delta-shaped kind must watch.
    expect(bus.publishes.map((p) => (p.data as BootsEnvelope).seq)).toEqual([1, 2, 3])
  })

  test('an unregistered kind is refused loudly, never silently dropped', () => {
    installBus()
    startNet()
    expect(publishFrame('build', { pieces: [] })).toBe('unregistered')
  })

  test('an oversize payload is refused here, never truncated or left to the host', () => {
    const bus = installBus()
    registerFrameKind('destruction', echo)
    startNet()
    const fat = { blob: 'x'.repeat(MAX_PAYLOAD_SERIALIZED + 1) }
    expect(payloadFits(fat)).toBe(false)
    expect(publishFrame('destruction', fat)).toBe('too-large')
    expect(bus.publishes.length).toBe(0)
    // Just inside the budget still goes out — the cap is a real budget, not a
    // guess: chunk with {part, parts} when a snapshot outgrows it.
    const snug = { blob: 'x'.repeat(MAX_PAYLOAD_SERIALIZED - 20) }
    expect(payloadFits(snug)).toBe(true)
    expect(publishFrame('destruction', snug)).toBe('sent')
  })

  test('chunk markers ride the envelope only when parts > 1', () => {
    const bus = installBus()
    registerFrameKind('state-snapshot', echo)
    startNet()
    publishFrame('state-snapshot', 'a', { part: 1, parts: 1 })
    publishFrame('state-snapshot', 'b', { part: 2, parts: 3 })
    const first = bus.publishes[0]!.data as BootsEnvelope
    const second = bus.publishes[1]!.data as BootsEnvelope
    expect(first.parts).toBeUndefined() // a whole frame stays minimal
    expect(second.part).toBe(2)
    expect(second.parts).toBe(3)
  })

  test('serializedLength survives the unserializable; a cyclic payload cannot be sent', () => {
    installBus()
    registerFrameKind('destruction', echo)
    startNet()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(serializedLength(cyclic)).toBe(Number.POSITIVE_INFINITY)
    expect(publishFrame('destruction', cyclic)).toBe('too-large')
  })

  test('a throwing bus never breaks a caller', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    startNet()
    bus.publishThrows = true
    expect(publishFrame('pose', { a: 1 })).toBe('unavailable')
  })
})

// ── Inbound: sequencing and routing ──────────────────────────────────────────

describe('inbound — sequence semantics', () => {
  test('the first frame from a sender is contiguous by definition', () => {
    installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    ingestBusMessage(inbound(frame('pose', 42, { x: 1 })))
    expect(got.length).toBe(1)
    expect(got[0]!.seq).toBe(42)
    expect(got[0]!.skipped).toBe(0)
    // The envelope's sender identity and clock come through for interpolation.
    expect(got[0]!.sessionId).toBe('session-a')
    expect(got[0]!.userId).toBe('user-a')
    expect(got[0]!.sentAt).toBe(1000)
    expect(got[0]!.parts).toBe(1)
    off()
  })

  test('a gap reports how much was lost; the stream never rewinds', () => {
    installBus()
    registerFrameKind('destruction', echo)
    startNet()
    const { got, off } = collect('destruction')
    for (const seq of [1, 2, 6, 7]) {
      ingestBusMessage(inbound(frame('destruction', seq, { s: seq })))
    }
    expect(got.map((m) => m.seq)).toEqual([1, 2, 6, 7])
    // 3,4,5 went missing — the signal a state-carrying kind uses to decide it
    // must ask for a fresh snapshot instead of applying a delta.
    expect(got.map((m) => m.skipped)).toEqual([0, 0, 3, 0])
    off()
  })

  test('duplicates and reorders are dropped, not applied twice', () => {
    installBus()
    registerFrameKind('destruction', echo)
    startNet()
    const { got, off } = collect('destruction')
    ingestBusMessage(inbound(frame('destruction', 5, { s: 5 })))
    ingestBusMessage(inbound(frame('destruction', 5, { s: 5 }))) // duplicate
    ingestBusMessage(inbound(frame('destruction', 3, { s: 3 }))) // late reorder
    ingestBusMessage(inbound(frame('destruction', 6, { s: 6 })))
    expect(got.map((m) => m.seq)).toEqual([5, 6])
    off()
  })

  test('sequence state is per (sender, kind) — senders and kinds never collide', () => {
    installBus()
    registerFrameKind('pose', echo)
    registerFrameKind('destruction', echo)
    startNet()
    const poses = collect('pose')
    const demo = collect('destruction')
    ingestBusMessage(inbound(frame('pose', 9, 'a-pose'), { sessionId: 'session-a' }))
    // Same seq from a different sender: independent stream, delivered.
    ingestBusMessage(inbound(frame('pose', 9, 'b-pose'), { sessionId: 'session-b' }))
    // Same sender, same seq, different kind: also independent.
    ingestBusMessage(inbound(frame('destruction', 9, 'a-demo'), { sessionId: 'session-a' }))
    expect(poses.got.map((m) => m.data)).toEqual(['a-pose', 'b-pose'])
    expect(demo.got.map((m) => m.data)).toEqual(['a-demo'])
    poses.off()
    demo.off()
  })

  test(`inbound trackers are bounded at ${SEQ_TRACK_MAX} senders`, () => {
    installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    // A flood of fabricated session ids is the classic memory-exhaustion
    // shape. Trackers recycle oldest-first, so the map cannot grow without
    // bound; the cost is that a long-silent sender may replay one seq.
    ingestBusMessage(inbound(frame('pose', 50, 'first'), { sessionId: 'session-victim' }))
    for (let i = 0; i < SEQ_TRACK_MAX * 2; i++) {
      ingestBusMessage(inbound(frame('pose', 1, i), { sessionId: `session-flood-${i}` }))
    }
    const count = got.length
    // The victim's tracker was recycled long ago, so an old seq is accepted
    // again — bounded memory is worth more than perfect replay rejection.
    ingestBusMessage(inbound(frame('pose', 50, 'replay'), { sessionId: 'session-victim' }))
    expect(got.length).toBe(count + 1)
    off()
  })

  test('forgetSender releases a departed peer’s tracker', () => {
    installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    ingestBusMessage(inbound(frame('pose', 5, 'before')))
    ingestBusMessage(inbound(frame('pose', 5, 'dup'))) // dropped
    expect(got.length).toBe(1)
    forgetSender('session-a') // the peer left and came back
    ingestBusMessage(inbound(frame('pose', 5, 'after')))
    expect(got.map((m) => m.data)).toEqual(['before', 'after'])
    off()
  })
})

describe('inbound — the trust boundary and routing', () => {
  test('self-echo never comes back to us', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    ingestBusMessage(inbound(frame('pose', 1, 'mine'), { sessionId: bus.sessionId }))
    expect(got.length).toBe(0)
    off()
  })

  test('a host event that disagrees with the envelope kind is a spoof — dropped', () => {
    installBus()
    registerFrameKind('pose', echo)
    registerFrameKind('destruction', echo)
    startNet()
    const poses = collect('pose')
    const demo = collect('destruction')
    // A destruction frame smuggled under the pose event, or vice versa: the
    // host's coalescing key and the payload's kind must agree or neither is
    // trustworthy.
    ingestBusMessage({ ...inbound(frame('destruction', 1, 'x')), event: 'pose' })
    ingestBusMessage({ ...inbound(frame('pose', 1, 'y')), event: 'destruction' })
    expect(poses.got.length).toBe(0)
    expect(demo.got.length).toBe(0)
    poses.off()
    demo.off()
  })

  test('a validator rejection stops the frame dead — no handler call', () => {
    installBus()
    registerFrameKind('pose', (data) =>
      typeof data === 'object' && data !== null && 'ok' in data ? data : null,
    )
    startNet()
    const { got, off } = collect('pose')
    ingestBusMessage(inbound(frame('pose', 1, { nope: true })))
    expect(got.length).toBe(0)
    ingestBusMessage(inbound(frame('pose', 2, { ok: true })))
    expect(got.length).toBe(1)
    off()
  })

  test('handlers receive the NORMALIZED payload, never the sender’s object', () => {
    installBus()
    // A validator that hands back a copy is the contract; the transport must
    // deliver exactly what the validator returned.
    registerFrameKind('pose', (data) => ({ safe: (data as { x?: number }).x ?? 0 }))
    startNet()
    const { got, off } = collect<{ safe: number }>('pose')
    const hostile = { x: 3, extra: 'cargo' }
    ingestBusMessage(inbound(frame('pose', 1, hostile)))
    expect(got[0]!.data).toEqual({ safe: 3 })
    expect(got[0]!.data).not.toBe(hostile)
    off()
  })

  test('a kind with a handler but no validator is undeliverable, not unvalidated', () => {
    installBus()
    startNet()
    // Subscribing before the owner registers its validator must NOT open a
    // hole: an unvalidated payload is never allowed to exist.
    const { got, off } = collect('build')
    ingestBusMessage(inbound(frame('build', 1, { anything: true })))
    expect(got.length).toBe(0)
    registerFrameKind('build', echo) // the owner catches up
    ingestBusMessage(inbound(frame('build', 2, { anything: true })))
    expect(got.length).toBe(1)
    off()
  })

  test('one subsystem’s throwing handler never costs another its frames', () => {
    installBus()
    registerFrameKind('pose', echo)
    startNet()
    let good = 0
    const offBad = onFrame('pose', () => {
      throw new Error('subsystem bug')
    })
    const offGood = onFrame('pose', () => {
      good++
    })
    expect(() => ingestBusMessage(inbound(frame('pose', 1, 'x')))).not.toThrow()
    expect(good).toBe(1)
    offBad()
    offGood()
  })

  test('unsubscribing stops delivery; re-registering a validator swaps it', () => {
    installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    ingestBusMessage(inbound(frame('pose', 1, 'in')))
    off()
    ingestBusMessage(inbound(frame('pose', 2, 'out')))
    expect(got.length).toBe(1)
    // Hot-reload shape: the second registration wins, handlers are untouched.
    const second = collect('pose')
    registerFrameKind('pose', () => null)
    ingestBusMessage(inbound(frame('pose', 3, 'rejected-now')))
    expect(second.got.length).toBe(0)
    second.off()
  })

  test('stopNet closes the wire and forgets sequences; kinds survive', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    ingestBusMessage(inbound(frame('pose', 5, 'a')))
    stopNet()
    expect(bus.unsubscribed).toBe(1)
    expect(netAvailable()).toBe(false)
    ingestBusMessage(inbound(frame('pose', 6, 'b'))) // wire closed
    expect(got.length).toBe(1)
    stopNet() // idempotent
    expect(bus.unsubscribed).toBe(1)
    // A new session: the kind is still registered (it belongs to its module),
    // and the sequence state is fresh, so seq 5 is welcome again.
    startNet()
    ingestBusMessage(inbound(frame('pose', 5, 'c')))
    expect(got.map((m) => m.data)).toEqual(['a', 'c'])
    off()
  })

  test('the host subscription is wired to the ingest path', () => {
    const bus = installBus()
    registerFrameKind('pose', echo)
    startNet()
    const { got, off } = collect('pose')
    bus.handler!(inbound(frame('pose', 1, 'through-the-wire')))
    expect(got.map((m) => m.data)).toEqual(['through-the-wire'])
    off()
  })
})

// ── Roster pass-through ──────────────────────────────────────────────────────

describe('roster', () => {
  test('participants and names come off the live roster', () => {
    const bus = installBus()
    startNet()
    expect(getParticipants().length).toBe(2)
    expect(participantName('user-a')).toBe('Alice')
    expect(participantName('user-nobody')).toBeNull()
    const seen: CollabParticipant[][] = []
    const off = onParticipants((p) => seen.push(p))
    bus.rosterHandler?.([bus.participants[0]!])
    expect(seen.length).toBe(1)
    expect(seen[0]!.length).toBe(1)
    off()
    expect(bus.rosterHandler).toBeNull()
  })
})

// ── Late join ────────────────────────────────────────────────────────────────

describe('late join — request, election, snapshot', () => {
  test('requestState publishes a state-request without any prior subscription', () => {
    const bus = installBus()
    startNet()
    // The whole point: a subsystem asks for state precisely because it has
    // none, so the late-join kinds are owned by the transport and always
    // registered. This must never return 'unregistered'.
    expect(requestState('destruction')).toBe('sent')
    const envelope = bus.publishes[0]!.data as BootsEnvelope
    expect(bus.publishes[0]!.event).toBe('state-request')
    expect(envelope.data).toEqual({ of: 'destruction' })
  })

  test('a peer sees the request with the requester’s session id', () => {
    installBus()
    startNet()
    const seen: Array<{ of: BootsFrameKind; from: string }> = []
    const off = onStateRequest(({ of, from }) => seen.push({ of, from }))
    ingestBusMessage(
      inbound(frame('state-request', 1, { of: 'destruction' }), { sessionId: 'session-joiner' }),
    )
    expect(seen).toEqual([{ of: 'destruction', from: 'session-joiner' }])
    // A malformed request never reaches the owner.
    ingestBusMessage(inbound(frame('state-request', 2, { of: 'exec' })))
    ingestBusMessage(inbound(frame('state-request', 3, 'nonsense')))
    expect(seen.length).toBe(1)
    off()
  })

  test('a snapshot addressed to us is delivered; other people’s are ignored', () => {
    const bus = installBus()
    startNet()
    const mine: unknown[] = []
    const off = onStateSnapshot('destruction', ({ state }) => mine.push(state))
    const snap = (over: Record<string, unknown>, seq: number) =>
      ingestBusMessage(inbound(frame('state-snapshot', seq, { of: 'destruction', ...over })))
    snap({ for: bus.sessionId, state: { cells: [1] } }, 1)
    snap({ for: 'session-somebody-else', state: { cells: [2] } }, 2)
    // Right addressee, wrong kind of state — belongs to another subscriber.
    ingestBusMessage(
      inbound(frame('state-snapshot', 3, { of: 'build', for: bus.sessionId, state: 'x' })),
    )
    snap({ state: { cells: [3] } }, 4) // no addressee at all → invalid
    expect(mine).toEqual([{ cells: [1] }])
    off()
  })

  test('sendStateSnapshot addresses the requester and can be chunked', () => {
    const bus = installBus()
    startNet()
    expect(sendStateSnapshot('destruction', 'session-joiner', { cells: [1, 2, 3] })).toBe('sent')
    const envelope = bus.publishes[0]!.data as BootsEnvelope
    expect(bus.publishes[0]!.event).toBe('state-snapshot')
    expect(envelope.data).toEqual({
      of: 'destruction',
      for: 'session-joiner',
      state: { cells: [1, 2, 3] },
    })
    sendStateSnapshot('destruction', 'session-joiner', 'part-two', { part: 2, parts: 2 })
    const chunk = bus.publishes[1]!.data as BootsEnvelope
    expect(chunk.part).toBe(2)
    expect(chunk.parts).toBe(2)
  })

  test('exactly ONE peer answers: the lowest live sessionId, never the requester', () => {
    const roster = (...ids: string[]): CollabParticipant[] =>
      ids.map((id) => ({
        userId: `user-${id}`,
        name: id,
        sessions: [{ sessionId: id, clientId: `client-${id}` }],
      }))
    const all = roster('session-b', 'session-c', 'session-joiner', 'session-a')
    // Every peer reaches the same verdict from the same roster, with no
    // coordination — so a newcomer gets one snapshot, not N.
    const answers = ['session-a', 'session-b', 'session-c', 'session-joiner'].filter((me) =>
      shouldAnswerStateRequest(me, 'session-joiner', all),
    )
    expect(answers).toEqual(['session-a'])
    // The requester never answers itself, even alone in the room.
    expect(shouldAnswerStateRequest('session-joiner', 'session-joiner', all)).toBe(false)
    expect(
      shouldAnswerStateRequest('session-joiner', 'session-joiner', roster('session-joiner')),
    ).toBe(false)
    // Nobody but the requester present: nobody answers (and nobody crashes).
    expect(shouldAnswerStateRequest('session-a', 'session-joiner', roster('session-joiner'))).toBe(
      false,
    )
    // Multi-session users (two tabs) are ranked per session, not per user.
    const twoTabs: CollabParticipant[] = [
      {
        userId: 'user-a',
        name: 'Alice',
        sessions: [
          { sessionId: 'session-z', clientId: 'c1' },
          { sessionId: 'session-a', clientId: 'c2' },
        ],
      },
    ]
    expect(shouldAnswerStateRequest('session-a', 'session-joiner', twoTabs)).toBe(true)
    expect(shouldAnswerStateRequest('session-z', 'session-joiner', twoTabs)).toBe(false)
  })

  test('the full handshake works end to end over one bus', () => {
    const bus = installBus()
    startNet()
    // We are the elected responder; a joiner asks and we answer with state we
    // own. (The joiner side is the same code path with the ids swapped.)
    const offRequest = onStateRequest(({ of, from }) => {
      if (of !== 'destruction') return
      if (!shouldAnswerStateRequest(bus.sessionId, from, bus.participants)) return
      sendStateSnapshot('destruction', from, { removed: ['cell-1', 'cell-2'] })
    })
    bus.participants = [
      { userId: 'user-me', name: 'Me', sessions: [{ sessionId: 'session-me', clientId: 'c' }] },
      { userId: 'user-j', name: 'Joiner', sessions: [{ sessionId: 'session-zz', clientId: 'c' }] },
    ]
    bus.handler!(
      inbound(frame('state-request', 1, { of: 'destruction' }), { sessionId: 'session-zz' }),
    )
    const envelope = bus.publishes[0]!.data as BootsEnvelope
    expect(envelope.kind).toBe('state-snapshot')
    expect(envelope.data).toEqual({
      of: 'destruction',
      for: 'session-zz',
      state: { removed: ['cell-1', 'cell-2'] },
    })
    offRequest()
  })
})
