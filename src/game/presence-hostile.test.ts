import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { useBoots } from '../store'
import {
  type BootsEnvelope,
  type CollabBus,
  type CollabBusMessage,
  ingestBusMessage as netIngest,
  MAX_PAYLOAD_SERIALIZED,
  NET_PROTOCOL,
  readEnvelope,
  resetNetKinds,
  stopNet,
} from './net'
import {
  getRemotes,
  getRosterVersion,
  MAX_REMOTE_AVATARS,
  POSE_KIND,
  presenceCounters,
  presenceTick,
  startPresence,
  stopPresence,
} from './presence'
import { POS_LIMIT, validateFrame, WEAPON_ID_MAX } from './presence-interp'
import { armSceneWriteSentinel } from './session'

/**
 * THE HOSTILE-PEER SUITE — the non-destructive invariant under attack.
 *
 * A public lobby means strangers publish into our process. This file attacks
 * through the REAL inbound path — net.ts's bus ingestion, exactly what the
 * host subscription calls — so both halves of the trust boundary are under
 * test at once: the envelope check in net.ts and the payload validator the
 * kind owner registered. The contract:
 *
 *  1. every malformed/malicious shape is refused before the registry, whether
 *     it is a broken envelope or a broken pose;
 *  2. a full hostile battery, ingested with the scene-write sentinel ARMED
 *     during play, leaves the scene store byte-identical AND object-identical
 *     — no node created, updated, deleted, or even re-spread. Presence has no
 *     store handle at all; this test is what keeps it that way;
 *  3. no prototype pollution, no unbounded strings, no NaN/Infinity reaching
 *     a transform, no unbounded memory under a session-id flood.
 *
 * The four Save bridges (keep / save-demolition / paint-keep / item-keep) are
 * the ONLY scene writers in this plugin and they run from the sidebar after
 * Esc. A remote frame touches none of them, by construction: neither net.ts
 * nor presence.ts imports a store or a bridge.
 */

// ── Fake bus ─────────────────────────────────────────────────────────────────

function installBus(): CollabBus {
  const bus: CollabBus = {
    version: 1,
    projectId: 'lobby',
    sessionId: 'session-me',
    clientId: 'client-me',
    userId: 'user-me',
    publish: () => 'sent',
    subscribe: () => () => {},
    getParticipants: () => [],
    onParticipants: () => () => {},
  }
  ;(globalThis as { __pascalCollabBus?: CollabBus }).__pascalCollabBus = bus
  return bus
}

/** Start co-presence with a stationary local player holding the BUILDER (the
 * real spawn loadout) — the pose sampler the crowd cap measures against. */
function startAtOrigin(): void {
  startPresence(() => ({
    ph: 'game',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    w: 'builder',
    s: 0,
    g: true,
    st: false,
    f: 0,
  }))
}

const validFrame = {
  v: 1,
  ph: 'game',
  p: [1, 2, 3],
  yaw: 0.5,
  pitch: -0.2,
  w: 'rifle',
  s: 0.5,
  g: true,
  st: false,
}

/** A hostile payload battery — each entry MUST be refused. */
function hostilePayloads(): Array<{ why: string; data: unknown }> {
  const throwingGetter = {}
  Object.defineProperty(throwingGetter, 'v', {
    get() {
      throw new Error('gotcha')
    },
    enumerable: true,
  })
  const pollute = JSON.parse('{"__proto__":{"polluted":true},"v":1,"ph":"game"}')
  return [
    { why: 'null', data: null },
    { why: 'undefined', data: undefined },
    { why: 'a number', data: 42 },
    { why: 'a string', data: 'game' },
    { why: 'a bare array', data: [1, 2, 3] },
    { why: 'an empty object', data: {} },
    { why: 'a function', data: () => validFrame },
    { why: 'wrong protocol version', data: { ...validFrame, v: 2 } },
    { why: 'version as a string', data: { ...validFrame, v: '1' } },
    { why: 'an unknown phase', data: { ...validFrame, ph: 'admin' } },
    { why: 'a NaN coordinate', data: { ...validFrame, p: [Number.NaN, 0, 0] } },
    { why: 'an Infinity coordinate', data: { ...validFrame, p: [Number.POSITIVE_INFINITY, 0, 0] } },
    { why: 'a coordinate past the sanity bound', data: { ...validFrame, p: [POS_LIMIT * 10, 0, 0] } },
    { why: 'a negative coordinate past the bound', data: { ...validFrame, p: [0, -POS_LIMIT * 10, 0] } },
    { why: 'a short position tuple', data: { ...validFrame, p: [1, 2] } },
    { why: 'an oversize position tuple', data: { ...validFrame, p: [1, 2, 3, 4] } },
    { why: 'an array-like posing as a tuple', data: { ...validFrame, p: { 0: 1, 1: 2, 2: 3, length: 3 } } },
    { why: 'a string coordinate', data: { ...validFrame, p: ['1', '2', '3'] } },
    { why: 'a huge yaw', data: { ...validFrame, yaw: 1e9 } },
    { why: 'a NaN pitch', data: { ...validFrame, pitch: Number.NaN } },
    { why: 'an out-of-range pitch', data: { ...validFrame, pitch: 99 } },
    { why: 'an empty weapon id', data: { ...validFrame, w: '' } },
    { why: 'a megabyte weapon id', data: { ...validFrame, w: 'x'.repeat(1_000_000) } },
    { why: 'a weapon id one char over the bound', data: { ...validFrame, w: 'x'.repeat(WEAPON_ID_MAX + 1) } },
    { why: 'a non-string weapon id', data: { ...validFrame, w: { toString: () => 'rifle' } } },
    { why: 'a NaN speed', data: { ...validFrame, s: Number.NaN } },
    { why: 'a truthy-but-not-boolean grounded flag', data: { ...validFrame, g: 'yes' } },
    { why: 'a numeric staggered flag', data: { ...validFrame, st: 1 } },
    { why: 'a throwing getter', data: throwingGetter },
    { why: 'a prototype-pollution payload', data: pollute },
  ]
}

/**
 * A well-formed pose frame smuggling scene-write cargo. This one is
 * deliberately ACCEPTED — forward compatibility means unknown fields never
 * invalidate a peer's pose — and the contract is that every extra field is
 * STRIPPED by normalization, so the cargo cannot reach anything.
 */
const dressedUpFrame = {
  ...validFrame,
  nodes: { 'node-1': { id: 'node-1', type: 'wall' } },
  roots: ['node-1'],
  dirtyNodes: ['node-1'],
  setScene: () => {},
  createNode: () => {},
  updateNodes: () => {},
  deleteNodes: () => {},
}

/**
 * A host bus message carrying `payload` inside a WELL-FORMED envelope, so the
 * hostile payload gets all the way to the pose validator instead of dying on
 * a technicality. Every attacker gets a fresh sessionId with seq 1, so the
 * transport's duplicate/reorder guard never masks a validation result.
 */
function busMessage(payload: unknown, sessionId = 'session-hostile'): CollabBusMessage {
  const envelope: BootsEnvelope = { v: NET_PROTOCOL, kind: POSE_KIND, seq: 1, data: payload }
  return {
    event: POSE_KIND,
    data: envelope,
    sessionId,
    clientId: 'client-hostile',
    userId: 'user-hostile',
    sentAt: 1000,
  }
}

/**
 * Hostile ENVELOPES — the transport's own half of the boundary. Each must die
 * in readEnvelope/dispatch before any pose validator is consulted, so a peer
 * cannot reach a kind owner by lying about the frame itself.
 */
function hostileEnvelopes(): Array<{ why: string; msg: CollabBusMessage }> {
  const good = { ...validFrame }
  const wrap = (data: unknown, over: Partial<CollabBusMessage> = {}): CollabBusMessage => ({
    ...busMessage(good, 'session-envelope'),
    data,
    ...over,
  })
  return [
    { why: 'no envelope at all (a bare pose)', msg: wrap(good) },
    { why: 'a null envelope', msg: wrap(null) },
    { why: 'a string envelope', msg: wrap('pose') },
    { why: 'wrong envelope protocol', msg: wrap({ v: 2, kind: POSE_KIND, seq: 1, data: good }) },
    { why: 'an unknown kind', msg: wrap({ v: 1, kind: 'exec', seq: 1, data: good }) },
    { why: 'a kind that is an object', msg: wrap({ v: 1, kind: {}, seq: 1, data: good }) },
    { why: 'a missing data field', msg: wrap({ v: 1, kind: POSE_KIND, seq: 1 }) },
    { why: 'seq zero', msg: wrap({ v: 1, kind: POSE_KIND, seq: 0, data: good }) },
    { why: 'a negative seq', msg: wrap({ v: 1, kind: POSE_KIND, seq: -5, data: good }) },
    { why: 'a fractional seq', msg: wrap({ v: 1, kind: POSE_KIND, seq: 1.5, data: good }) },
    { why: 'a NaN seq', msg: wrap({ v: 1, kind: POSE_KIND, seq: Number.NaN, data: good }) },
    { why: 'an Infinity seq', msg: wrap({ v: 1, kind: POSE_KIND, seq: Infinity, data: good }) },
    {
      why: 'a part past its parts count',
      msg: wrap({ v: 1, kind: POSE_KIND, seq: 1, part: 9, parts: 2, data: good }),
    },
    {
      why: 'an absurd parts count',
      msg: wrap({ v: 1, kind: POSE_KIND, seq: 1, part: 1, parts: 1e9, data: good }),
    },
    {
      why: 'a host event that disagrees with the kind (spoof)',
      msg: wrap({ v: 1, kind: POSE_KIND, seq: 1, data: good }, { event: 'boots/world' }),
    },
    { why: 'a NaN sentAt', msg: wrap({ v: 1, kind: POSE_KIND, seq: 1, data: good }, { sentAt: Number.NaN }) },
    {
      why: 'our own session id echoed back',
      msg: wrap({ v: 1, kind: POSE_KIND, seq: 1, data: good }, { sessionId: 'session-me' }),
    },
  ]
}

// ── Scene helpers ────────────────────────────────────────────────────────────

type SceneStore = {
  getState: () => {
    setScene: (nodes: Record<string, unknown>, roots: string[]) => void
    setReadOnly?: (readOnly: boolean) => void
    nodes: Record<string, unknown>
    roots?: string[]
  }
}
const scene = useScene as unknown as SceneStore

afterEach(() => {
  stopPresence()
  stopNet()
  resetNetKinds()
  delete (globalThis as { __pascalCollabBus?: CollabBus }).__pascalCollabBus
  useBoots.getState().setPhase('editor')
  scene.getState().setReadOnly?.(false)
  scene.getState().setScene({}, [])
})

// ── 1. The trust boundary refuses everything ─────────────────────────────────

describe('hostile frames — refused at the trust boundary', () => {
  test('every payload in the battery is rejected by validateFrame', () => {
    for (const { why, data } of hostilePayloads()) {
      expect(validateFrame(data), `should reject: ${why}`).toBeNull()
    }
  })

  test('not one hostile frame enters the remote registry', () => {
    installBus()
    startAtOrigin()
    // Module-global counters: assert they do not MOVE (bun shares the module
    // registry across test files, so absolutes are order-dependent).
    const received = presenceCounters().received
    const roster = getRosterVersion()
    hostilePayloads().forEach(({ data }, i) => {
      netIngest(busMessage(data, `session-hostile-${i}`))
    })
    expect(getRemotes().size).toBe(0)
    expect(presenceCounters().received).toBe(received)
    expect(getRosterVersion()).toBe(roster)
  })

  test('every hostile ENVELOPE dies in the transport, before any validator', () => {
    installBus()
    startAtOrigin()
    const received = presenceCounters().received
    for (const { why, msg } of hostileEnvelopes()) {
      netIngest(msg)
      expect(getRemotes().size, `should refuse: ${why}`).toBe(0)
    }
    expect(presenceCounters().received).toBe(received)
    // readEnvelope is total: a hostile getter reads as invalid, never a throw.
    const throwing: Record<string, unknown> = { v: NET_PROTOCOL }
    Object.defineProperty(throwing, 'kind', {
      get() {
        throw new Error('gotcha')
      },
      enumerable: true,
    })
    expect(readEnvelope(throwing)).toBeNull()
    // ...and so is the whole inbound path, getter and all.
    expect(() => netIngest({ ...busMessage(validFrame), data: throwing })).not.toThrow()
  })

  test('an oversize frame cannot be received either — the cap is symmetric', () => {
    installBus()
    startAtOrigin()
    const received = presenceCounters().received
    // A weapon id far past the wire budget: refused by the pose validator's
    // length bound long before anything allocates per-avatar state.
    netIngest(busMessage({ ...validFrame, w: 'x'.repeat(MAX_PAYLOAD_SERIALIZED * 2) }, 'session-fat'))
    expect(getRemotes().size).toBe(0)
    expect(presenceCounters().received).toBe(received)
  })

  test('scene-write cargo on a valid pose frame is stripped, not honoured', () => {
    const frame = validateFrame(dressedUpFrame)
    expect(frame).not.toBeNull()
    const keys = Object.keys(frame as object)
    for (const smuggled of [
      'nodes',
      'roots',
      'dirtyNodes',
      'setScene',
      'createNode',
      'updateNodes',
      'deleteNodes',
    ]) {
      expect(keys).not.toContain(smuggled)
    }
  })

  test('a normalized frame carries only the bounded wire fields', () => {
    const frame = validateFrame({
      ...validFrame,
      nodes: { 'node-1': {} },
      evil: 'payload',
    })
    expect(frame).not.toBeNull()
    expect(Object.keys(frame as object).sort()).toEqual([
      'a',
      'f',
      'g',
      'nm',
      'p',
      'ph',
      'pitch',
      's',
      'st',
      'v',
      'w',
      'yaw',
    ])
    // validFrame deliberately omits `f` (it predates the fire counter, exactly
    // like a peer still pinned to the older build): the field is SOFT, so the
    // frame is accepted and the counter reads 0 rather than the whole frame
    // being refused and that peer losing their avatar.
    expect(frame!.f).toBe(0)
    // A copy, never the sender's object: no retained prototype or getter.
    expect(Object.getPrototypeOf(frame as object)).toBe(Object.prototype)
  })
})

// ── 2. THE INVARIANT: a hostile frame changes NOTHING ────────────────────────

describe('hostile frames — the non-destructive invariant holds', () => {
  test('the full battery leaves the scene store untouched, sentinel silent', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})

    // A scene worth destroying, then play begins and the sentinel arms.
    const seeded = {
      'wall-1': { id: 'wall-1', type: 'wall', name: 'south wall' },
      'slab-1': { id: 'slab-1', type: 'slab', name: 'floor' },
    }
    scene.getState().setScene(seeded, ['wall-1', 'slab-1'])
    useBoots.getState().setPhase('game')
    const teardown: Array<() => void> = []
    armSceneWriteSentinel(teardown)

    const before = scene.getState().nodes
    const beforeJson = JSON.stringify(before)

    installBus()
    startAtOrigin()

    // Every hostile shape and every hostile envelope, plus a barrage of
    // well-formed frames from strangers (the legitimate case must not write
    // either), plus ticks so the staleness sweep and the publisher both run
    // over the whole mess.
    hostilePayloads().forEach(({ data }, i) => {
      netIngest(busMessage(data, `session-hostile-${i}`))
    })
    for (const { msg } of hostileEnvelopes()) netIngest(msg)
    // ...including the valid-but-smuggling frame, whose cargo is stripped.
    netIngest(busMessage(dressedUpFrame, 'session-smuggler'))
    for (let i = 0; i < 50; i++) {
      netIngest(busMessage({ ...validFrame, p: [i, 0, i], w: 'minigun' }, `session-peer-${i}`))
      presenceTick(6000 + i)
    }

    const after = scene.getState().nodes
    // Object identity: not even a defensive re-spread of the nodes map.
    expect(after).toBe(before)
    expect(JSON.stringify(after)).toBe(beforeJson)
    expect(after['wall-1']).toBe(seeded['wall-1'])
    expect(Object.keys(after).sort()).toEqual(['slab-1', 'wall-1'])
    // The sentinel is the product's alarm: one line here is an automatic FAIL.
    expect(error).not.toHaveBeenCalled()

    for (const fn of teardown.splice(0)) fn()
    error.mockRestore()
    info.mockRestore()
  })

  test('neither the transport nor presence holds a scene or Save-bridge handle', async () => {
    // The structural half of the invariant: these modules cannot write the
    // scene because they never import anything that can. Keeps a future edit
    // honest — including the sync-core work that will add kinds to net.ts,
    // whose own writes must go through its own reviewed path, not this one.
    for (const module of ['./net.ts', './presence.ts']) {
      const source = await Bun.file(new URL(module, import.meta.url).pathname).text()
      expect(source, module).not.toContain('@pascal-app/core')
      expect(source, module).not.toContain('useScene')
      for (const bridge of ['./keep', './save-demolition', './paint-keep', './item-keep']) {
        expect(source, `${module} imports ${bridge}`).not.toContain(bridge)
      }
    }
  })
})

// ── 3. Bounded under attack ──────────────────────────────────────────────────

describe('hostile frames — bounded resources, no pollution', () => {
  test('the prototype chain is clean after a pollution attempt', () => {
    for (const { data } of hostilePayloads()) validateFrame(data)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('a 5000-session flood cannot grow the registry past the cap', () => {
    installBus()
    startAtOrigin()
    const culled = presenceCounters().culled
    // Distinct fabricated session ids, all far away: the classic memory
    // exhaustion shape (each admitted remote owns a 24-slot ring, and the
    // transport a sequence tracker — both bounded, SEQ_TRACK_MAX covers the
    // second in net.test.ts).
    for (let i = 0; i < 5000; i++) {
      netIngest(busMessage({ ...validFrame, p: [1000 + i, 0, 0] }, `session-flood-${i}`))
    }
    expect(getRemotes().size).toBeLessThanOrEqual(MAX_REMOTE_AVATARS)
    expect(presenceCounters().culled - culled).toBeGreaterThan(4000)
  })

  test('accepted coordinates and strings are always finite and bounded', () => {
    const frame = validateFrame({ ...validFrame, p: [POS_LIMIT - 1, 0, 0], s: 42 })
    expect(frame).not.toBeNull()
    for (const v of frame!.p) expect(Number.isFinite(v)).toBe(true)
    expect(Math.abs(frame!.p[0])).toBeLessThanOrEqual(POS_LIMIT)
    expect(frame!.s).toBe(1) // clamped, never dropped
    expect(frame!.w.length).toBeLessThanOrEqual(WEAPON_ID_MAX)
  })
})
