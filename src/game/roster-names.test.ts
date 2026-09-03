import { afterEach, describe, expect, test } from 'bun:test'
import { type CollabBus, stopNet } from './net'
import type { RemotePlayer } from './presence'
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

afterEach(() => {
  stopNet()
  delete g.__pascalCollabBus
})

describe('remoteLabel', () => {
  test("nick wins; no nick and no bus → 'builder'", () => {
    expect(remoteLabel({ nick: 'Zed', userId: 'u-1' })).toBe('Zed')
    expect(remoteLabel({ nick: '', userId: 'u-1' })).toBe('builder')
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
