import { afterEach, describe, expect, test } from 'bun:test'
import {
  type BootsEnvelope,
  type CollabBus,
  type CollabBusMessage,
  type CollabParticipant,
  NET_PROTOCOL,
  netAvailable,
  PLUGIN_ID,
  resetNetKinds,
  stopNet,
} from './net'
import {
  getRemotes,
  getRosterVersion,
  type LocalPose,
  onPresenceEvent,
  POSE_KIND,
  type PresenceEvent,
  presenceCounters,
  presenceTick,
  startPresence,
  startSpectating,
  stopPresence,
  stopSpectating,
} from './presence'
import type { PresenceFrame } from './presence-interp'
import { latestSnapshot } from './presence-interp'
import { shouldStopOnCleanup } from './spectator-hint'

/**
 * THE SEAMLESS DROP-IN, headless. spectator.tsx claims that when an editor
 * viewer clicks JUMP IN the receive-only adapter opened by `startSpectating`
 * is ADOPTED by `startPresence` — same registry, same subscription, no
 * despawn, no false "X joined", no reconnect — and that the live harness saw
 * `rosterVersion 1 → 1` across the flip (scripts/qa/see-harness.mjs). This
 * file pins that claim against a stub bus so a change to either lifecycle
 * (presence.ts) or the cleanup rule (spectator-hint.ts) fails here first.
 *
 * The sequence under test is exactly spectator.tsx's:
 *   startSpectating()            — the editor-phase effect binds receive-only
 *   frame arrives                — a player is drawn, "Alice joined" is shown
 *   phase flips to 'game'        — the effect cleans up; shouldStopOnCleanup
 *                                  says NOT to stop, so the adapter lives on
 *   startPresence(getLocal)      — ActiveGame mounts and adopts it
 *
 * Frames go through the REAL transport (bus.handler with a well-formed
 * envelope), so the subscription identity across the flip is what is pinned,
 * not a shortcut into the registry. Bus idioms follow presence.test.ts.
 */

// ── Fake bus ─────────────────────────────────────────────────────────────────

type FakeBus = CollabBus & {
  publishes: Array<{ pluginId: string; event: string; data: unknown }>
  handler: ((msg: CollabBusMessage) => void) | null
  rosterHandler: ((participants: CollabParticipant[]) => void) | null
  participants: CollabParticipant[]
  subscribed: number
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
    handler: null,
    rosterHandler: null,
    participants: [
      { userId: 'user-me', name: 'Me', sessions: [{ sessionId: 'session-me', clientId: 'client-me' }] },
      { userId: 'user-a', name: 'Alice', sessions: [{ sessionId: 'session-a', clientId: 'client-a' }] },
    ],
    subscribed: 0,
    unsubscribed: 0,
    publish(pluginId, event, data) {
      bus.publishes.push({ pluginId, event, data })
      return 'sent'
    },
    subscribe(_pluginId, handler) {
      bus.subscribed++
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
    nm: 'Bob',
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
    nm: 'Alice',
    ...over,
  }
}

/** A raw host bus message from Alice carrying a well-formed envelope. */
function aliceMsg(seq: number, sentAt: number, frame: PresenceFrame = gameFrame()): CollabBusMessage {
  return {
    event: POSE_KIND,
    data: { v: NET_PROTOCOL, kind: POSE_KIND, seq, data: frame } satisfies BootsEnvelope,
    sessionId: 'session-a',
    clientId: 'client-a',
    userId: 'user-a',
    sentAt,
  }
}

/** The pose inside published frame `i` (publishes carry envelopes). */
function publishedFrame(bus: FakeBus, i: number): PresenceFrame {
  return (bus.publishes[i]!.data as BootsEnvelope).data as PresenceFrame
}

/** spectator.tsx's effect cleanup, reduced to the one decision it makes. */
function spectatorCleanup(phase: 'editor' | 'game'): void {
  if (shouldStopOnCleanup(phase)) stopSpectating()
}

afterEach(() => {
  stopPresence()
  stopSpectating()
  stopNet()
  resetNetKinds()
  delete g.__pascalCollabBus
})

// ── Receive-only ─────────────────────────────────────────────────────────────

describe('startSpectating — the receive half, and nothing else', () => {
  test('binds one subscription and one roster handler under the plugin id', () => {
    const bus = installBus()
    expect(startSpectating()).toBe(true)
    expect(bus.subscribed).toBe(1)
    expect(bus.handler).not.toBeNull()
    expect(bus.rosterHandler).not.toBeNull()
    expect(netAvailable()).toBe(true)
    expect(PLUGIN_ID).toBe('pascal:boots')
  })

  test('ticks sweep but never publish: a spectator has no avatar to announce', () => {
    const bus = installBus()
    startSpectating()
    for (let t = 1000; t <= 3000; t += 100) presenceTick(t)
    expect(bus.publishes.length).toBe(0)
  })

  test('a player frame through the real transport draws the player and says who joined', () => {
    const bus = installBus()
    startSpectating()
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    bus.handler!(aliceMsg(1, 1000))
    expect(getRemotes().size).toBe(1)
    expect(getRemotes().get('session-a')?.ph).toBe('game')
    // The "Alice joined" line under the pill is this event — legitimate here.
    expect(events).toEqual([{ type: 'join', sessionId: 'session-a', userId: 'user-a', name: 'Alice' }])
    off()
  })

  test('no bus: false, and nothing to adopt later', () => {
    expect(startSpectating()).toBe(false)
    expect(netAvailable()).toBe(false)
    expect(getRemotes().size).toBe(0)
  })
})

// ── The drop-in ──────────────────────────────────────────────────────────────

describe('drop-in — startPresence adopts the spectating registry', () => {
  test('same entries, same roster version, no despawn, no false join, no reconnect', () => {
    const bus = installBus()
    startSpectating()
    bus.handler!(aliceMsg(1, 1000))
    const handlerBefore = bus.handler
    const remoteBefore = getRemotes().get('session-a')!
    const joinedAtBefore = remoteBefore.joinedAt
    const versionBefore = getRosterVersion()
    const receivedBefore = presenceCounters().received
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))

    // The phase flips to 'game': the spectator effect cleans up WITHOUT
    // stopping (the handoff rule), then ActiveGame's startPresence runs.
    spectatorCleanup('game')
    expect(netAvailable()).toBe(true) // still bound — nothing was torn down
    expect(startPresence(() => localPose())).toBe(true)

    // Adopted, not rebuilt: the very same entry object, untouched.
    expect(getRemotes().size).toBe(1)
    expect(getRemotes().get('session-a')).toBe(remoteBefore)
    expect(remoteBefore.joinedAt).toBe(joinedAtBefore)
    expect(latestSnapshot(remoteBefore.ring)?.sentAt).toBe(1000)
    // No roster edge: remote-players.tsx re-renders off this, so 1 → 1 means
    // no avatar unmount/remount and no scale-in replay.
    expect(getRosterVersion()).toBe(versionBefore)
    // No toast — Alice neither left nor joined.
    expect(events).toEqual([])
    // No reconnect: one subscription for the whole life of the page.
    expect(bus.subscribed).toBe(1)
    expect(bus.unsubscribed).toBe(0)
    expect(bus.handler).toBe(handlerBefore)
    // The idempotent branch resets nothing: what the spectator heard still counts.
    expect(presenceCounters().received).toBe(receivedBefore)
    off()
  })

  test('publishing turns on with the adoption — the first tick announces us', () => {
    const bus = installBus()
    startSpectating()
    bus.handler!(aliceMsg(1, 1000))
    presenceTick(1000)
    expect(bus.publishes.length).toBe(0) // still a spectator
    spectatorCleanup('game')
    startPresence(() => localPose())
    presenceTick(2000)
    expect(bus.publishes.length).toBe(1)
    expect(bus.publishes[0]!.event).toBe(POSE_KIND)
    const frame = publishedFrame(bus, 0)
    expect(frame.ph).toBe('game')
    expect(frame.nm).toBe('Bob')
  })

  test('the adopted subscription keeps feeding the same entry after the flip', () => {
    const bus = installBus()
    startSpectating()
    bus.handler!(aliceMsg(1, 1000))
    const remote = getRemotes().get('session-a')!
    spectatorCleanup('game')
    startPresence(() => localPose())
    const version = getRosterVersion()
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    bus.handler!(aliceMsg(2, 1084, gameFrame({ p: [1.5, 0, 2] })))
    expect(getRemotes().get('session-a')).toBe(remote)
    expect(latestSnapshot(remote.ring)?.sentAt).toBe(1084)
    expect(latestSnapshot(remote.ring)?.x).toBe(1.5)
    expect(getRosterVersion()).toBe(version)
    expect(events).toEqual([]) // an update, not a re-join
    off()
  })

  test('stopSpectating after the drop-in is a no-op: the session owns the adapter now', () => {
    const bus = installBus()
    startSpectating()
    bus.handler!(aliceMsg(1, 1000))
    spectatorCleanup('game')
    startPresence(() => localPose())
    // A late cleanup (or a stray call) from the spectator side must not pull
    // the rug from under the game session.
    stopSpectating()
    expect(netAvailable()).toBe(true)
    expect(bus.unsubscribed).toBe(0)
    expect(getRemotes().size).toBe(1)
    // Only the session's own stopPresence ends it — with the goodbye frame.
    stopPresence()
    expect(publishedFrame(bus, bus.publishes.length - 1).ph).toBe('editor')
    expect(bus.unsubscribed).toBe(1)
    expect(getRemotes().size).toBe(0)
    expect(netAvailable()).toBe(false)
  })

  test('a spectate attempt while a session is live never steals the sampler', () => {
    const bus = installBus()
    startPresence(() => localPose())
    expect(startSpectating()).toBe(true) // "already owned" reads as success
    presenceTick(1000)
    expect(bus.publishes.length).toBe(1) // getLocal intact — we still publish
    expect(bus.subscribed).toBe(1)
  })
})

// ── The other edges ──────────────────────────────────────────────────────────

describe('no drop-in — the receive-only owner closes shop on a real unmount', () => {
  test('editor-phase cleanup tears the adapter down, silently (no goodbye frame)', () => {
    const bus = installBus()
    startSpectating()
    bus.handler!(aliceMsg(1, 1000))
    const version = getRosterVersion()
    spectatorCleanup('editor')
    expect(bus.unsubscribed).toBe(1)
    expect(bus.rosterHandler).toBeNull()
    expect(getRemotes().size).toBe(0)
    expect(getRosterVersion()).toBe(version + 1) // the renderer unmounts them
    expect(netAvailable()).toBe(false)
    // A spectator never announced itself, so it has nothing to take back.
    expect(bus.publishes.length).toBe(0)
  })
})

describe('the way back — Esc ends the session, spectating binds again from zero', () => {
  test('stopPresence says goodbye and closes; startSpectating re-subscribes and re-hears', () => {
    const bus = installBus()
    startPresence(() => localPose())
    bus.handler!(aliceMsg(1, 1000))
    stopPresence()
    expect(publishedFrame(bus, bus.publishes.length - 1).ph).toBe('editor')
    expect(bus.unsubscribed).toBe(1)
    expect(getRemotes().size).toBe(0)

    // spectator.tsx's editor-phase effect binds again (untilNet → startSpectating).
    expect(startSpectating()).toBe(true)
    expect(bus.subscribed).toBe(2)
    expect(bus.handler).not.toBeNull()
    const events: PresenceEvent[] = []
    const off = onPresenceEvent((e) => events.push(e))
    // The transport's sequence state was cleared with the session, so Alice's
    // next frame — whatever its seq — is heard, and from the viewer's point of
    // view she genuinely (re)appears.
    bus.handler!(aliceMsg(2, 1100))
    expect(getRemotes().size).toBe(1)
    expect(events.map((e) => e.type)).toEqual(['join'])
    // …and we are back to receive-only.
    const published = bus.publishes.length
    presenceTick(5000)
    expect(bus.publishes.length).toBe(published)
    off()
  })
})
