import { afterEach, describe, expect, test } from 'bun:test'
import {
  HEAL_PERIOD_MS,
  MAX_WIRE_TEXT,
  PUBLISH_TICK_MS,
  publishWorldSnapshot,
  pumpWorldSync,
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
  netCounters,
  resetNetIdentity,
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
import { bytesToBase64, decodeDeltaText, encodeDeltaText, MAX_TEXT_CHARS } from './shared-wire'
import {
  addLocalStroke,
  cellKey,
  emptyDelta,
  isOurs,
  setGridStamp,
  type SharedDelta,
} from './shared-world'

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
  /** What the host says next. 'deferred' is the coalescing window refusing us. */
  result: 'sent' | 'deferred' | 'suppressed'
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
    result: 'sent',
    publish(_pluginId, event, data) {
      if (bus.result !== 'sent') return bus.result
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
  resetNetIdentity()
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

describe('outbound is the journal, one frame per tick', () => {
  test('a journalled op lands on the delta kind, as base64 text', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    pumpWorldSync()
    expect(framesOn(bus, WORLD_KIND).length).toBe(1)
    const envelope = envelopeOn(bus, WORLD_KIND)
    expect(envelope.kind).toBe(WORLD_KIND)
    // The bus is a JSON channel: the payload must be a string, never bytes.
    expect(typeof envelope.data).toBe('string')
    expect((envelope.data as string).length).toBeLessThanOrEqual(MAX_WIRE_TEXT)
  })

  /**
   * THE DOUBLE-SEND REGRESSION. Every local op journals itself AND the damage
   * lane auto-flushes to its own sink after each one, so there are two roads to
   * the wire and wiring both would put every cell out twice — correct, but
   * double the bytes on a channel that only grants one frame per 66 ms. The
   * sink is deliberately a counted no-op, so the count rises while the frame
   * count stays at one.
   */
  test('the lane sink is ignored, so a record goes out ONCE and not twice', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    // The lane already offered us this frame through its own sink...
    expect(worldSyncDebug().laneSinkIgnored).toBeGreaterThan(0)
    // ...and we dropped it, so nothing has gone out yet.
    expect(framesOn(bus, WORLD_KIND).length).toBe(0)
    pumpWorldSync()
    expect(framesOn(bus, WORLD_KIND).length).toBe(1)
  })

  test('the lane flushing on its own publishes nothing at all', () => {
    const bus = installBus()
    startWorldSync()
    const before = bus.publishes.length
    flushDamage()
    flushDamage()
    expect(bus.publishes.length).toBe(before)
  })

  /**
   * The journal's whole point: it holds maps and sets, not a list of ops, so
   * sixty shots into one wall collapse into one node entry carrying the union
   * of the cells. Without that, a burst either floods the bus or is silently
   * eaten by the coalescing window.
   */
  test('a burst collapses into ONE frame instead of sixty', () => {
    const bus = installBus()
    startWorldSync()
    for (let i = 0; i < 60; i++) publishRemovedKeys('node-7', [cellKey(1, 1, i)])
    expect(framesOn(bus, WORLD_KIND).length).toBe(0)
    pumpWorldSync()
    expect(framesOn(bus, WORLD_KIND).length).toBe(1)
    // And the frame really did carry all sixty cells, via the round trip.
    const text = envelopeOn(bus, WORLD_KIND).data as string
    const echo = decodeDeltaText(text)
    if (echo === null) throw new Error('our own frame did not decode')
    expect(echo.nodes.length).toBe(1)
    expect(echo.nodes[0]?.removed.length).toBe(60)
  })

  test('a tick with an empty journal publishes nothing', () => {
    const bus = installBus()
    startWorldSync()
    const before = bus.publishes.length
    pumpWorldSync()
    pumpWorldSync()
    expect(bus.publishes.length).toBe(before)
    expect(worldSyncDebug().depth).toBe(0)
  })

  test('a snapshot lands on its OWN kind, never the delta kind', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    pumpWorldSync()
    const deltasBefore = framesOn(bus, WORLD_KIND).length
    publishWorldSnapshot()
    pumpWorldSync()
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(1)
    // Sharing one host event would let the snapshot coalesce the delta away.
    expect(framesOn(bus, WORLD_KIND).length).toBe(deltasBefore)
    expect(worldSyncDebug().snapshots).toBe(1)
  })

  /**
   * 'deferred' is the host's coalescing window refusing us. The frame must go
   * back to the queue, not on the floor: the alternative is that a burst of
   * local work vanishes into a 66 ms window with nobody the wiser.
   */
  test('a frame the host refuses is requeued and goes out on the next tick', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    bus.result = 'deferred'
    pumpWorldSync()
    expect(framesOn(bus, WORLD_KIND).length).toBe(0)
    let debug = worldSyncDebug()
    expect(debug.deferred).toBe(1)
    expect(debug.sent).toBe(0)
    expect(debug.depth).toBe(1) // still owed, still visible
    bus.result = 'sent'
    pumpWorldSync()
    expect(framesOn(bus, WORLD_KIND).length).toBe(1)
    debug = worldSyncDebug()
    expect(debug.sent).toBe(1)
    expect(debug.depth).toBe(0)
    expect(debug.requeued).toBe(1)
  })

  test('a snapshot supersedes our own increments still waiting in the queue', () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2)])
    bus.result = 'deferred'
    pumpWorldSync() // queued, refused, requeued
    expect(worldSyncDebug().depth).toBe(1)
    bus.result = 'sent'
    publishWorldSnapshot()
    // The snapshot already contains those cells, so keeping the increment would
    // be pure duplicate bytes.
    expect(worldSyncDebug().superseded).toBeGreaterThan(0)
    pumpWorldSync()
    expect(framesOn(bus, WORLD_SNAP_KIND).length).toBe(1)
    expect(framesOn(bus, WORLD_KIND).length).toBe(0)
  })

  test('a published delta survives the round trip into another peer', () => {
    const bus = installBus('session-a')
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(2, 2, 2), cellKey(2, 2, 3)])
    pumpWorldSync()
    const text = envelopeOn(bus, WORLD_KIND).data as string
    // Now play it back as if it came from somebody else.
    const before = worldSyncDebug()
    inbound(WORLD_KIND, text, 'session-b')
    const after = worldSyncDebug()
    expect(after.merged).toBe(before.merged + 1)
    expect(worldSyncWorld()?.dropped).toBe(0)
  })

  test('the interval publishes without anyone calling pump', async () => {
    const bus = installBus()
    startWorldSync()
    publishRemovedKeys('node-7', [cellKey(3, 3, 3)])
    await sleep(PUBLISH_TICK_MS * 3)
    expect(framesOn(bus, WORLD_KIND).length).toBe(1)
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

describe('our own name is not a constant', () => {
  /**
   * The host installs a bus per awareness runtime and its scope key includes the
   * session id, so anything that re-keys the session replaces the bus object.
   * Bound to the old one we would go deaf — and the id we can read belongs to
   * that dead bus, so a check on the id alone could never notice.
   */
  test('a bus swap rebinds the transport instead of going deaf', () => {
    installBus('session-me')
    startWorldSync()
    const world = worldSyncWorld()
    const swapsBefore = netCounters().swaps

    // Same name, new object: a plain reconnect.
    const fresh = installBus('session-me')
    pumpWorldSync()

    expect(netCounters().swaps).toBe(swapsBefore + 1)
    // Same identity, so the session and its records are kept.
    expect(worldSyncWorld()).toBe(world)
    expect(worldSyncDebug().rekeys).toBe(0)
    // And we are listening on the NEW bus, not the corpse.
    expect(fresh.handler).not.toBe(null)
    inbound(WORLD_KIND, encodeDeltaText(damageDelta('alice')), 'session-alice')
    expect(worldSyncWorld()!.nodes.size).toBe(1)
  })

  /**
   * RENAME IN PLACE, never start over. A teardown-and-re-mint recovery looks
   * equivalent and is not: it republishes records peers already hold (items and
   * apertures have no slot, so nothing elects between the copies), it invalidates
   * the damage lane's runtime<->record bindings mid-flight, and it drops the
   * damage attribution only we hold, so Save would under-report the player's own
   * demolition. The world object surviving IS the property.
   */
  test('a re-key renames us in place and keeps everything', () => {
    installBus('session-old')
    startWorldSync()
    const world = worldSyncWorld()!
    expect(world.self).toBe('session-old')
    // Work only we hold, of both shapes: an authored record and unauthored damage.
    addLocalStroke(world, { node: 'node-9', color: 3, x: 1, y: 1, z: 1, radius: 0.4 })
    publishRemovedKeys('node-9', [cellKey(4, 4, 4)])

    installBus('session-new')
    pumpWorldSync()

    expect(worldSyncDebug().rekeys).toBe(1)
    expect(worldSyncActive()).toBe(true)
    // The SAME world, renamed — not a fresh one.
    expect(worldSyncWorld()).toBe(world)
    expect(world.self).toBe('session-new')
    expect(world.formerSelves).toEqual(['session-old'])
    expect(world.strokes.adds.size).toBe(1)
    expect(world.nodes.get('node-9')?.removed.size).toBe(1)
    // The recovery must not be silent, and it must not look like an error.
    expect(worldSyncDebug().applyErrors).toBe(0)
  })

  /**
   * The work a rename cannot save: adds minted under the old name that were
   * still in the journal, so no peer has them and none will now accept them.
   * Bounded by one tick, and counted rather than swallowed.
   */
  test('a re-key counts the mints it could not save', () => {
    installBus('session-old')
    startWorldSync()
    const world = worldSyncWorld()!
    addLocalStroke(world, { node: 'node-9', color: 3, x: 1, y: 1, z: 1, radius: 0.4 })
    addLocalStroke(world, { node: 'node-9', color: 4, x: 2, y: 1, z: 1, radius: 0.4 })

    installBus('session-new')
    pumpWorldSync()

    expect(worldSyncDebug().staleMints).toBe(2)
  })

  test('a re-key with nothing pending loses nothing', () => {
    installBus('session-old')
    startWorldSync()
    pumpWorldSync() // drain first, so the journal is empty
    installBus('session-new')
    pumpWorldSync()
    expect(worldSyncDebug().rekeys).toBe(1)
    expect(worldSyncDebug().staleMints).toBe(0)
  })

  /**
   * rekeySharedWorld refuses an unsafe name by returning [], which reads exactly
   * like "nothing was pending" — so carrying on would leave us publishing under a
   * name no peer can ever vouch for. Stop, for the same reason startWorldSync
   * refuses to begin on one.
   */
  test('a re-key to a name that could never author stops the session', () => {
    installBus('session-old')
    startWorldSync()
    installBus('bad#name')
    pumpWorldSync()

    expect(worldSyncDebug().unsafeNames).toBe(1)
    expect(worldSyncDebug().rekeys).toBe(0)
    expect(worldSyncActive()).toBe(false)
    expect(buildSyncOn()).toBe(false)
    expect(damageSyncActive()).toBe(false)
  })

  /**
   * Records minted under the old name keep it forever — peers hold them and we
   * cannot rename them — so "did this player make this" has to span names or Save
   * would disown the fort. The model answers it; this pins that the adapter
   * actually gives it the old name to remember.
   */
  test('a re-key leaves the old prefix recognisable as ours', () => {
    installBus('session-old')
    startWorldSync()
    const world = worldSyncWorld()!
    const mine = addLocalStroke(world, {
      node: 'node-9',
      color: 3,
      x: 1,
      y: 1,
      z: 1,
      radius: 0.4,
    })!

    installBus('session-new')
    pumpWorldSync()

    expect(isOurs(world, mine.id)).toBe(true) // minted under the OLD name
    expect(isOurs(world, 'session-stranger#4')).toBe(false)
  })

  /**
   * The stamp belongs to the LOT, not to us. slotsOk demands a NON-ZERO stamp
   * equal to the receiver's and it is only ever published when the storey ladder
   * installs, so losing it would refuse every slot-addressed record for the rest
   * of the session — the bug traded for a permanent version of itself. Renaming
   * in place keeps it; this pins that so no future recovery can drop it.
   */
  test('the lot grid fingerprint survives a re-key', () => {
    installBus('session-old')
    startWorldSync()
    setGridStamp(worldSyncWorld()!, 0xbeef)

    installBus('session-new')
    pumpWorldSync()

    expect(worldSyncWorld()?.gridStamp).toBe(0xbeef)
  })

  test('a re-key says the whole of it again, so peers hear it before the next heal', () => {
    installBus('session-old')
    startWorldSync()
    const fresh = installBus('session-new')
    pumpWorldSync() // detects, renames, queues the snapshot
    pumpWorldSync() // publishes one frame of it
    expect(framesOn(fresh, WORLD_SNAP_KIND).length).toBeGreaterThan(0)
  })

  test('the bus disappearing stops the session instead of queueing into a corpse', () => {
    installBus()
    startWorldSync()
    delete g.__pascalCollabBus
    pumpWorldSync()
    expect(worldSyncDebug().busLost).toBe(1)
    expect(worldSyncActive()).toBe(false)
    expect(buildSyncOn()).toBe(false)
    expect(damageSyncActive()).toBe(false)
  })

  test('a steady bus never restarts anything', () => {
    installBus()
    startWorldSync()
    const world = worldSyncWorld()
    const swapsBefore = netCounters().swaps
    for (let i = 0; i < 5; i++) pumpWorldSync()
    expect(worldSyncWorld()).toBe(world)
    expect(worldSyncDebug().rekeys).toBe(0)
    expect(worldSyncDebug().busLost).toBe(0)
    expect(netCounters().swaps).toBe(swapsBefore)
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

  test('the adapter and the wire agree on the budget', () => {
    // Two modules derive the same number from different directions: the
    // transport's payload cap minus the quotes, and shared-wire's own default
    // chunk budget. If they ever drift, frames are either refused by the host
    // or split more finely than they need to be.
    expect(MAX_WIRE_TEXT).toBe(MAX_TEXT_CHARS)
  })

  test('the publish tick matches the window the host actually grants', () => {
    // The host keeps the latest value per (plugin, event) per 66 ms. Ticking
    // faster cannot make frames leave sooner, it only manufactures 'deferred'.
    expect(PUBLISH_TICK_MS).toBeGreaterThanOrEqual(66)
  })
})
