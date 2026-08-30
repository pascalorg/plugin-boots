// ORDERING WORKAROUND, not a dependency. shared-damage.ts imports
// save-demolition.ts, which imports destruction.ts, which calls
// setDamageRuntime() at module scope — so with shared-damage as the graph
// entry, `runtime` is still in its temporal dead zone and the import throws
// (their own shared-damage.test.ts fails the same way on main). Evaluating
// destruction first breaks the cycle. Remove this line once the damage lane
// makes that registration lazy.
import './destruction'

import { afterEach, describe, expect, test } from 'bun:test'
import {
  HEAL_PERIOD_MS,
  MAX_WIRE_TEXT,
  publishWorldSnapshot,
  resetWorldSyncCounters,
  SNAP_MIN_GAP_MS,
  startWorldSync,
  stopWorldSync,
  WORLD_KIND,
  WORLD_SNAP_KIND,
  worldSyncActive,
  worldSyncDebug,
  worldSyncWorld,
} from './net-world'
import {
  type CollabBus,
  type CollabBusMessage,
  ingestBusMessage,
  NET_PROTOCOL,
  resetNetKinds,
  stopNet,
} from './net'
import {
  damageSyncActive,
  flushDamage,
  publishRemovedKeys,
  resetSharedDamage,
} from './shared-damage'
import { buildSyncOn, resetSharedBuild } from './shared-build'
import { bytesToBase64, encodeDeltaText } from './shared-wire'
import { cellKey, emptyDelta, type SharedDelta } from './shared-world'

/**
 * The adapter's own seam: net.ts <-> shared-world.ts. net.test.ts already owns
 * envelopes, sequences and routing; shared-*.test.ts own the lattice. What is
 * only testable HERE is the wiring itself — which kind a delta lands on, that
 * BOTH lanes get attached and detached, that the merge is fed the ENVELOPE's
 * sender and not the payload's, and that flag-off wires nothing at all.
 */

type FakeBus = CollabBus & {
  publishes: Array<{ event: string; data: unknown }>
  handler: ((msg: CollabBusMessage) => void) | null
}

const g = globalThis as { __pascalCollabBus?: CollabBus }

function installBus(sessionId = 'session-me'): FakeBus {
  const bus: FakeBus = {
    version: 1,
    projectId: 'p',
    sessionId,
    clientId: 'client-me',
    userId: 'user-me',
    publishes: [],
    handler: null,
    publish(_pluginId, event, data) {
      bus.publishes.push({ event, data })
      return 'sent'
    },
    subscribe(_pluginId, handler) {
      bus.handler = handler
      return () => {
        bus.handler = null
      }
    },
    getParticipants: () => [],
    onParticipants: () => () => {},
  }
  g.__pascalCollabBus = bus
  return bus
}

/** Deliver an inbound frame exactly as the host would. */
function inbound(kind: string, payload: unknown, sessionId: string, seq = 1): void {
  ingestBusMessage({
    event: kind,
    data: { v: NET_PROTOCOL, kind, seq, data: payload },
    sessionId,
    clientId: `client-${sessionId}`,
    userId: `user-${sessionId}`,
    sentAt: Date.now(),
  })
}

/** A delta that really changes something, so "did it merge" is observable. */
function damageDelta(from: string, nodeId = 'node-1'): SharedDelta {
  const d = emptyDelta(from)
  d.lamport = 1
  d.nodes = [
    {
      nodeId,
      epoch: 0,
      removed: [cellKey(1, 2, 3), cellKey(1, 2, 4)],
      segments: [],
      killed: false,
      reset: false,
    },
  ]
  return d
}

const framesOn = (bus: FakeBus, event: string) => bus.publishes.filter((p) => p.event === event)

/** The one frame published on `event`, as an envelope. Throws if there is none,
 * which is a clearer failure than an assertion on `undefined`. */
function envelopeOn(bus: FakeBus, event: string): { kind: string; data: unknown } {
  const frames = framesOn(bus, event)
  const first = frames[0]
  if (!first) throw new Error(`no frame published on '${event}'`)
  return first.data as { kind: string; data: unknown }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  stopWorldSync()
  stopNet()
  resetNetKinds()
  resetSharedBuild()
  resetSharedDamage()
  resetWorldSyncCounters()
  delete g.__pascalCollabBus
})

describe('flag off is a no-op', () => {
  test('no bus: nothing starts and no lane is attached', () => {
    expect(startWorldSync()).toBe(false)
    expect(worldSyncActive()).toBe(false)
    expect(worldSyncWorld()).toBe(null)
    expect(buildSyncOn()).toBe(false)
    expect(damageSyncActive()).toBe(false)
  })

  test('a bus of the wrong protocol version reads as no bus', () => {
    const bus = installBus()
    ;(bus as { version: number }).version = 2
    expect(startWorldSync()).toBe(false)
    expect(buildSyncOn()).toBe(false)
    expect(damageSyncActive()).toBe(false)
  })

  test('a session id we could not author records under refuses to start', () => {
    // '#' is the record-id separator: 'alice#7' would be forgeable by
    // 'alice#7evil', so mergeDelta refuses such a peer outright. Starting
    // would produce a session that can never publish anything valid.
    installBus('evil#1')
    expect(startWorldSync()).toBe(false)
    expect(buildSyncOn()).toBe(false)
    expect(damageSyncActive()).toBe(false)
  })
})

describe('session wiring', () => {
  test('starting attaches BOTH lanes and asks the room for state', () => {
    const bus = installBus()
    expect(startWorldSync()).toBe(true)
    expect(worldSyncActive()).toBe(true)
    expect(buildSyncOn()).toBe(true)
    expect(damageSyncActive()).toBe(true)
    expect(worldSyncWorld()?.self).toBe('session-me')
    // Late join is requested, not waited for.
    expect(framesOn(bus, 'state-request').length).toBe(1)
  })

  test('starting twice keeps the first session', () => {
    installBus()
    expect(startWorldSync()).toBe(true)
    const world = worldSyncWorld()
    expect(startWorldSync()).toBe(true)
    expect(worldSyncWorld()).toBe(world)
  })

  test('stopping detaches both lanes so single player is restored', () => {
    installBus()
    startWorldSync()
    stopWorldSync()
    expect(worldSyncActive()).toBe(false)
    expect(buildSyncOn()).toBe(false)
    expect(damageSyncActive()).toBe(false)
  })

  test('after stopping, an inbound frame merges nothing', () => {
    const bus = installBus()
    startWorldSync()
    const before = worldSyncDebug().merged
    stopWorldSync()
    inbound(WORLD_KIND, encodeDeltaText(damageDelta('peer-a')), 'peer-a')
    expect(worldSyncDebug().merged).toBe(before)
    expect(bus.publishes.some((p) => p.event === WORLD_KIND)).toBe(false)
  })
})

describe('outbound routing', () => {
  test('a lane delta lands on the delta kind, as base64 text', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    flushDamage()
    expect(framesOn(bus, WORLD_KIND).length).toBe(1)
    const envelope = envelopeOn(bus, WORLD_KIND)
    expect(envelope.kind).toBe(WORLD_KIND)
    // The bus is a JSON channel: the payload must be a string, never bytes.
    expect(typeof envelope.data).toBe('string')
    expect((envelope.data as string).length).toBeLessThanOrEqual(MAX_WIRE_TEXT)
  })

  test('a snapshot lands on its OWN kind, never the delta kind', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    flushDamage()
    const deltasBefore = framesOn(bus, WORLD_KIND).length
    publishWorldSnapshot()
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(1)
    // Sharing one host event would let the snapshot coalesce the delta away.
    expect(framesOn(bus, WORLD_KIND).length).toBe(deltasBefore)
    expect(worldSyncDebug().snapshots).toBe(1)
  })

  test('a published delta survives the round trip into another peer', () => {
    const bus = installBus('session-a')
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2), cellKey(2, 2, 3)])
    flushDamage()
    const text = envelopeOn(bus, WORLD_KIND).data as string
    // Now play it back as if it came from somebody else.
    const before = worldSyncDebug()
    inbound(WORLD_KIND, text, 'session-b')
    const after = worldSyncDebug()
    expect(after.merged).toBe(before.merged + 1)
    expect(worldSyncWorld()?.dropped).toBe(0)
  })
})

describe('the sender comes from the envelope, never the payload', () => {
  /**
   * THE DISCRIMINATOR. `delta.from` is a safe-looking peer id; the envelope's
   * sessionId is one mergeDelta must refuse ('#' is the record-id separator).
   * An implementation that trusted the payload would MERGE this frame; one
   * that uses the host-stamped sender drops the whole thing. Nothing about
   * record shapes is involved, so this cannot rot.
   */
  test('an unsafe envelope sender drops the frame even when the payload lies nicely', () => {
    installBus()
    startWorldSync()
    const world = worldSyncWorld()
    expect(world).not.toBe(null)
    const droppedBefore = world!.dropped
    const nodesBefore = world!.nodes.size

    inbound(WORLD_KIND, encodeDeltaText(damageDelta('alice')), 'evil#1')

    // Reached the model (so the validator accepted the bytes) and was refused
    // there — not merged.
    expect(world!.dropped).toBe(droppedBefore + 1)
    expect(world!.nodes.size).toBe(nodesBefore)
  })

  test('the same payload from a safe sender does merge', () => {
    installBus()
    startWorldSync()
    const world = worldSyncWorld()
    inbound(WORLD_KIND, encodeDeltaText(damageDelta('alice')), 'session-alice')
    expect(world!.nodes.size).toBe(1)
    expect(world!.dropped).toBe(0)
  })

  test('snapshots go through the same gate', () => {
    installBus()
    startWorldSync()
    const world = worldSyncWorld()
    const snap = damageDelta('alice')
    snap.kind = 'snapshot'
    inbound(WORLD_SNAP_KIND, encodeDeltaText(snap), 'evil#1')
    expect(world!.nodes.size).toBe(0)
    expect(world!.dropped).toBe(1)
  })
})

describe('convergent delivery', () => {
  test('duplicates and reorders are delivered, not discarded', () => {
    installBus()
    startWorldSync()
    const text = encodeDeltaText(damageDelta('alice'))
    const before = worldSyncDebug().merged
    inbound(WORLD_KIND, text, 'session-alice', 5)
    inbound(WORLD_KIND, text, 'session-alice', 5) // exact duplicate
    inbound(WORLD_KIND, text, 'session-alice', 3) // reordered, older
    // An ordered kind would have dropped the 2nd and 3rd. The merge is a
    // lattice join, so discarding them would lose records for nothing.
    expect(worldSyncDebug().merged).toBe(before + 3)
    // Idempotent: three merges of one delta leave one node's worth of state.
    expect(worldSyncWorld()!.nodes.size).toBe(1)
  })
})

describe('every remote payload is treated as hostile', () => {
  const hostile: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a boolean', true],
    ['an object', { v: 1, kind: 'delta', from: 'a' }],
    ['an array', [1, 2, 3]],
    ['a delta that forgot to be encoded', damageDelta('alice')],
    ['an empty string', ''],
    ['not base64 at all', 'this is not base64 !!! ***'],
    ['valid base64 of garbage bytes', bytesToBase64(new Uint8Array([1, 2, 3, 4, 5]))],
    ['valid base64 of nothing', bytesToBase64(new Uint8Array([]))],
    ['a string one char over the budget', 'A'.repeat(MAX_WIRE_TEXT + 1)],
    ['a megabyte of base64', 'A'.repeat(1 << 20)],
    ['a NaN', Number.NaN],
    ['a function-ish object', { call: 'me' }],
  ]

  for (const [name, payload] of hostile) {
    test(`${name} changes nothing and throws nothing`, () => {
      installBus()
      startWorldSync()
      const world = worldSyncWorld()!
      const before = {
        merged: worldSyncDebug().merged,
        nodes: world.nodes.size,
        pieces: world.pieces.adds.size,
        items: world.items.adds.size,
        strokes: world.strokes.adds.size,
        clock: world.clock,
      }
      expect(() => {
        inbound(WORLD_KIND, payload, 'session-attacker')
        inbound(WORLD_SNAP_KIND, payload, 'session-attacker')
      }).not.toThrow()
      // Rejected at the validator, so the model was never even called.
      expect(worldSyncDebug().merged).toBe(before.merged)
      expect(world.nodes.size).toBe(before.nodes)
      expect(world.pieces.adds.size).toBe(before.pieces)
      expect(world.items.adds.size).toBe(before.items)
      expect(world.strokes.adds.size).toBe(before.strokes)
      expect(world.clock).toBe(before.clock)
    })
  }

  test('a hostile frame never provokes an outbound frame', () => {
    const bus = installBus()
    startWorldSync()
    const before = bus.publishes.length
    inbound(WORLD_KIND, 'not base64 !!!', 'session-attacker')
    expect(bus.publishes.length).toBe(before)
  })
})

describe('late join', () => {
  test('a request is answered with our own snapshot, on its own kind', async () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(1, 1, 1)])
    flushDamage()
    inbound('state-request', { of: WORLD_KIND }, 'session-joiner')
    // Answers are jittered so N peers do not publish in one 66 ms window.
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(0)
    await sleep(600)
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(1)
  })

  test('a request for another kind is ignored', async () => {
    const bus = installBus()
    startWorldSync()
    inbound('state-request', { of: 'pose' }, 'session-joiner')
    await sleep(600)
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(0)
  })

  test('repeated requests cannot make us shout', async () => {
    const bus = installBus()
    startWorldSync()
    inbound('state-request', { of: WORLD_KIND }, 'session-joiner')
    await sleep(600)
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(1)
    // A replayed request inside the rate-limit window is refused, counted.
    for (let i = 0; i < 20; i++) {
      inbound('state-request', { of: WORLD_KIND }, 'session-joiner', 2 + i)
    }
    await sleep(600)
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(1)
    expect(worldSyncDebug().throttled).toBeGreaterThan(0)
  })
})

describe('the constants are the policy', () => {
  test('the healing period is real and the rate limit is tighter than it', () => {
    // Loss is never retransmitted — it heals on the next snapshot, so there
    // must always BE a next snapshot, and answering a join must not be
    // throttled by the heal that just happened to fire.
    expect(HEAL_PERIOD_MS).toBeGreaterThan(0)
    expect(SNAP_MIN_GAP_MS).toBeLessThan(HEAL_PERIOD_MS)
  })

  test('the wire budget leaves room for the JSON quotes', () => {
    // A base64 payload serializes as a bare JSON string: its length plus two
    // quote characters, and base64 needs no escaping.
    expect(MAX_WIRE_TEXT).toBeGreaterThan(0)
    expect(JSON.stringify('A'.repeat(MAX_WIRE_TEXT)).length).toBe(MAX_WIRE_TEXT + 2)
  })
})
