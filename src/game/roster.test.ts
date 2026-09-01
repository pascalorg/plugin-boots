import { afterEach, describe, expect, test } from 'bun:test'
import type { CollabBus, CollabParticipant } from './net'
import {
  FALLBACK_NAME,
  NAME_CAP,
  onRosterChange,
  otherSessionCount,
  othersInRoom,
  roster,
  rosterMessage,
} from './roster'

/**
 * WHO'S HERE.
 *
 * The bug these tests exist for is a sentence that reads "Just you in here
 * right now" while someone else is standing in the room — because then the
 * owner goes hunting for a broken link that works fine. Two ways to earn that
 * lie, and both are pinned below:
 *
 *  1. Counting distinct USERS. One person on a laptop and a phone signed into
 *     the same account is ONE participant with TWO sessions. Count users and
 *     the most likely first test of a share link reports failure.
 *  2. Rendering "no bus at all" as an empty room. A page with no shared session
 *     cannot be joined by anyone; saying "just you, right now" implies someone
 *     could arrive.
 */

const globals = globalThis as { __pascalCollabBus?: CollabBus }

afterEach(() => {
  delete globals.__pascalCollabBus
})

const participant = (
  userId: string,
  name: string,
  ...sessionIds: string[]
): CollabParticipant => ({
  name,
  sessions: sessionIds.map((sessionId) => ({ clientId: `client-${sessionId}`, sessionId })),
  userId,
})

/** A v1 host bus carrying a fixed roster. Only the roster surface is real. */
const installBus = (participants: CollabParticipant[], mySessionId = 'mine'): CollabBus => {
  const handlers = new Set<(p: CollabParticipant[]) => void>()
  const bus = {
    clientId: 'client-mine',
    getParticipants: () => participants,
    onParticipants: (handler: (p: CollabParticipant[]) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    projectId: 'project_test',
    publish: () => 'sent' as const,
    sessionId: mySessionId,
    subscribe: () => () => {},
    userId: 'user-mine',
    version: 1,
    // Test-only hook to fire the host's participant event.
    __fire: () => {
      for (const handler of handlers) handler(participants)
    },
  } as unknown as CollabBus & { __fire: () => void }
  globals.__pascalCollabBus = bus
  return bus
}

describe('othersInRoom', () => {
  test('our own session is not company', () => {
    const entries = othersInRoom([participant('user-mine', 'Me', 'mine')], 'mine')
    expect(entries).toEqual([])
  })

  test('a second window of OUR OWN account still counts — it is a real presence', () => {
    // The likeliest first test of a share link: same Google account, two
    // devices. Counting distinct users would report "just you" to someone
    // looking at their own phone sitting in the lobby.
    const entries = othersInRoom([participant('user-mine', 'Julien', 'mine', 'phone')], 'mine')
    expect(entries).toEqual([{ name: 'Julien', sessions: 1, userId: 'user-mine' }])
    expect(otherSessionCount(entries)).toBe(1)
  })

  test('sessions are counted, not users', () => {
    const entries = othersInRoom(
      [participant('user-anna', 'Anna', 'a1', 'a2', 'a3')],
      'mine',
    )
    expect(entries).toEqual([{ name: 'Anna', sessions: 3, userId: 'user-anna' }])
    expect(otherSessionCount(entries)).toBe(3)
  })

  test('a participant with no session left is dropped, not listed with zero', () => {
    const entries = othersInRoom([participant('user-mine', 'Me', 'mine')], 'mine')
    expect(entries.some((entry) => entry.sessions === 0)).toBe(false)
  })

  test('an empty host name renders as someone, never as blank', () => {
    const entries = othersInRoom([participant('user-x', '   ', 's1')], 'mine')
    expect(entries[0]?.name).toBe(FALLBACK_NAME)
    expect(rosterMessage(entries)).toBe(`${FALLBACK_NAME} is in here with you.`)
  })

  test('order is stable — by name, then userId for a shared name', () => {
    const entries = othersInRoom(
      [
        participant('user-z', 'Zoe', 's1'),
        participant('user-b', 'Anna', 's2'),
        participant('user-a', 'Anna', 's3'),
      ],
      'mine',
    )
    expect(entries.map((entry) => entry.userId)).toEqual(['user-a', 'user-b', 'user-z'])
  })

  test('with no session id of our own, nobody is company', () => {
    // No bus means we cannot tell our own window from anyone else's, so this
    // must not turn our own reflection into a peer. The "no bus" state is
    // reported by roster() as null instead.
    expect(othersInRoom([participant('user-mine', 'Me', 'mine')], null)).toEqual([
      { name: 'Me', sessions: 1, userId: 'user-mine' },
    ])
  })
})

describe('rosterMessage', () => {
  test('no shared session is not the same as an empty room', () => {
    const noBus = rosterMessage(null)
    const alone = rosterMessage([])
    expect(noBus).not.toBe(alone)
    expect(noBus).toMatch(/nobody can join/i)
    expect(alone).toBe('Just you in here right now.')
    // The alone case must not claim the room is unjoinable — that is the bug
    // report's other half, and the owner would stop sharing the link.
    expect(alone).not.toMatch(/nobody/i)
  })

  test('one other person reads as a person, not a count', () => {
    expect(rosterMessage([{ name: 'Anna', sessions: 1, userId: 'u1' }])).toBe(
      'Anna is in here with you.',
    )
  })

  test('a second window of the same person is shown, not hidden', () => {
    // And the verb agrees with the NAME, not the window count.
    expect(rosterMessage([{ name: 'Anna', sessions: 2, userId: 'u1' }])).toBe(
      'Anna (×2) is in here with you.',
    )
  })

  test('two people are joined with "and"', () => {
    expect(
      rosterMessage([
        { name: 'Anna', sessions: 1, userId: 'u1' },
        { name: 'Bob', sessions: 1, userId: 'u2' },
      ]),
    ).toBe('Anna and Bob are in here with you.')
  })

  test('past the name cap the remainder is printed, never silently dropped', () => {
    const crowd = ['Anna', 'Bob', 'Cleo', 'Dan', 'Eve'].map((name, index) => ({
      name,
      sessions: 1,
      userId: `u${index}`,
    }))
    const message = rosterMessage(crowd)
    expect(message).toContain('Anna')
    expect(message).toContain(`+${crowd.length - NAME_CAP} more`)
    // Nobody is invisible: the names shown plus the remainder account for all.
    expect(message).not.toContain('Eve')
    expect(message).toMatch(/\+2 more are in here with you\.$/)
  })

  test('it never promises they are in the GAME — the host roster cannot know', () => {
    // The share sentence had exactly this bug: claiming the stronger thing.
    // This roster sees who has the project open, editor tab included.
    const message = rosterMessage([{ name: 'Anna', sessions: 1, userId: 'u1' }])
    expect(message).not.toMatch(/in the game/i)
    expect(message).not.toMatch(/playing/i)
  })
})

describe('roster (live read)', () => {
  test('no bus reads as null, not as an empty room', () => {
    expect(roster()).toBeNull()
  })

  test('a bus below the protocol version also reads as null', () => {
    installBus([participant('user-anna', 'Anna', 'a1')])
    ;(globals.__pascalCollabBus as { version: number }).version = 2
    expect(roster()).toBeNull()
  })

  test('with a bus, our own session id comes from the bus', () => {
    installBus([participant('user-mine', 'Me', 'mine'), participant('user-anna', 'Anna', 'a1')])
    expect(roster()).toEqual([{ name: 'Anna', sessions: 1, userId: 'user-anna' }])
  })
})

describe('onRosterChange', () => {
  test('no bus gives a no-op unsubscribe, so callers need no feature check', () => {
    const stop = onRosterChange(() => {
      throw new Error('must not fire without a bus')
    })
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })

  test('the host participant event reaches the handler, and unsubscribing stops it', () => {
    const bus = installBus([participant('user-anna', 'Anna', 'a1')]) as CollabBus & {
      __fire: () => void
    }
    let fired = 0
    const stop = onRosterChange(() => {
      fired++
    })
    bus.__fire()
    expect(fired).toBe(1)
    stop()
    bus.__fire()
    expect(fired).toBe(1)
  })
})
