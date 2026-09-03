import { afterEach, describe, expect, test } from 'bun:test'
import { type CollabBus, startNet, stopNet } from './net'
import type { RemotePlayer } from './presence'
import { remoteLabel as presenceRemoteLabel } from './presence'
import { livePlayerNames, remoteLabel, sameNames } from './roster-names'

/**
 * The one label rule (roster-names.ts): nick beats roster name beats
 * 'builder'; only in-game remotes count as players; sorted so a poll can
 * compare lists positionally.
 */

const g = globalThis as { __pascalCollabBus?: CollabBus }

/** The three fields the label rule reads — the functions accept exactly this
 * Pick, so the test never depends on the rest of RemotePlayer. */
type Labelled = Pick<RemotePlayer, 'nick' | 'userId' | 'ph'>

function remote(sessionId: string, over: Partial<Labelled> = {}): Labelled {
  return { userId: `u-${sessionId}`, ph: 'game', nick: '', ...over }
}

/** A v1 bus whose roster names `userId` — the roster-name branch's input.
 * Only getParticipants matters here; the rest is the minimum net.ts accepts. */
function installBusNaming(userId: string, name: string): void {
  const bus: CollabBus = {
    version: 1,
    projectId: 'project-1',
    sessionId: 'session-me',
    clientId: 'client-me',
    userId: 'user-me',
    publish: () => 'sent',
    subscribe: () => () => {},
    getParticipants: () => [
      { userId: 'user-me', name: 'Me', sessions: [{ sessionId: 'session-me', clientId: 'client-me' }] },
      { userId, name, sessions: [{ sessionId: `s-${userId}`, clientId: `c-${userId}` }] },
    ],
    onParticipants: () => () => {},
  }
  g.__pascalCollabBus = bus
}

afterEach(() => {
  stopNet()
  delete g.__pascalCollabBus
})

describe('remoteLabel', () => {
  test("nick wins; no nick and no bus → 'builder'", () => {
    expect(remoteLabel({ nick: 'Zed', userId: 'u-1' })).toBe('Zed')
    expect(remoteLabel({ nick: '', userId: 'u-1' })).toBe('builder')
  })

  test('no nick → the host roster names the userId; a nick still beats it', () => {
    installBusNaming('u-1', 'Alice')
    expect(startNet()).toBe(true)
    expect(remoteLabel({ nick: '', userId: 'u-1' })).toBe('Alice')
    expect(remoteLabel({ nick: 'Zed', userId: 'u-1' })).toBe('Zed')
    // A userId the roster does not know still falls through to 'builder'.
    expect(remoteLabel({ nick: '', userId: 'u-stranger' })).toBe('builder')
    // ...and the roster name is only readable through a STARTED transport
    // (net.getParticipants reads the bound bus, not the global).
    stopNet()
    expect(remoteLabel({ nick: '', userId: 'u-1' })).toBe('builder')
  })

  test('is the very function presence.ts emits with (one rule, re-exported)', () => {
    expect(remoteLabel).toBe(presenceRemoteLabel)
  })
})

describe('livePlayerNames', () => {
  test('in-game remotes only, sorted, nick over roster name', () => {
    const remotes = new Map<string, Labelled>([
      ['s-b', remote('s-b', { nick: 'Bob' })],
      ['s-a', remote('s-a', { nick: 'Alice' })],
      ['s-e', remote('s-e', { nick: 'Eve', ph: 'editor' })], // watching, not playing
      ['s-x', remote('s-x')], // unprofiled stranger, no nick, no roster
    ])
    expect(livePlayerNames(remotes)).toEqual(['Alice', 'Bob', 'builder'])
    expect(livePlayerNames(new Map())).toEqual([])
  })
})

describe('sameNames', () => {
  test('positional equality', () => {
    expect(sameNames([], [])).toBe(true)
    expect(sameNames(['A'], ['A'])).toBe(true)
    expect(sameNames(['A'], ['B'])).toBe(false)
    expect(sameNames(['A'], ['A', 'B'])).toBe(false)
    expect(sameNames(['A', 'B'], ['B', 'A'])).toBe(false) // callers sort first
  })
})
