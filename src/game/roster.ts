/**
 * WHO'S HERE — the answer to "did he actually join?"
 *
 * The report that started the multiplayer work was not "it crashed" or "he saw
 * the wrong thing". It was: "so nothing really like joining a game together."
 * Two people, one link, and NO WAY TO TELL from either screen whether the other
 * one had arrived. Silence looks identical to every distinct failure — the link
 * never opened, it opened read-only, it opened but the bus was off, they both
 * arrived and simply never found each other in a large building.
 *
 * So the sidebar names who else has this project open. That single line splits
 * that one silence into two very different bugs, without a devtools console:
 *
 *   "Just you in here right now."   → nobody arrived. The LINK is the problem.
 *   "Anna is in here with you."     → they arrived. Whatever is wrong is
 *                                     downstream — the game, not the link.
 *
 * WHY THE HOST BUS DIRECTLY, not net.ts's bound copy. `net.getParticipants()`
 * reads the bus that `startNet()` captured, and net is only started for the
 * duration of a game session. The sidebar is what the owner is looking at
 * BEFORE he jumps in and right after he presses Esc — precisely the moments net
 * is torn down and that roster would read empty. Empty renders as "just you",
 * which is the exact wrong answer at the exact wrong moment. `getCollabBus()`
 * is the host's object, alive for as long as the editor's awareness session is,
 * so this module is readable in every phase.
 *
 * SESSIONS, NOT USERS. The roster groups sessions under a userId, and the most
 * likely first test of a share link is one person on two devices signed into
 * the SAME account — which is one participant with two sessions. Counting
 * distinct users would tell that person they are alone while they are staring
 * at their own second window. Everything here counts sessions and drops only
 * OUR session id.
 *
 * Pure over (participants, mySessionId) so the wording is unit-testable without
 * a browser; the panel supplies both from the bus.
 */
import { type CollabParticipant, getCollabBus } from './net'

/** One other human (or one other window) with this project open. */
export type RosterEntry = {
  userId: string
  /** Display name from the host roster; never empty (see FALLBACK_NAME). */
  name: string
  /** How many of their windows/tabs are here. Always >= 1. */
  sessions: number
}

/**
 * The host roster carries a name for every participant, but it is a host
 * string and this is a line of UI: an empty one must not render as "  is in
 * here with you." Anonymous-but-present is still present.
 */
export const FALLBACK_NAME = 'Someone'

/**
 * Everyone here except us.
 *
 * `mySessionId` is null when there is no bus at all — and then this returns
 * empty rather than listing strangers, because with no bus we cannot tell our
 * own session from anyone else's and would count ourselves as company. The
 * "no bus" case is a separate state (`roster()` below returns null), never an
 * empty list.
 */
export function othersInRoom(
  participants: readonly CollabParticipant[],
  mySessionId: string | null,
): RosterEntry[] {
  const entries: RosterEntry[] = []
  for (const participant of participants) {
    let sessions = 0
    for (const session of participant.sessions) {
      // Our own window is not company. Compared per SESSION, not per user, so
      // our second tab still counts (it is a real second presence in the room).
      if (mySessionId !== null && session.sessionId === mySessionId) continue
      sessions++
    }
    if (sessions === 0) continue
    entries.push({
      name: participant.name?.trim() || FALLBACK_NAME,
      sessions,
      userId: participant.userId,
    })
  }
  // Stable order so the line does not shuffle on every roster tick: by name,
  // then by userId to break ties between two people who share a display name.
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
  return entries
}

/**
 * Live read of the room.
 *
 * `null` means THIS PAGE HAS NO SHARED SESSION — no host bus at all (the
 * standalone editor at :3002, an older host, plugin collab switched off). That
 * is not "you are alone in a shared room"; it is "there is no room", and the
 * two must not print the same sentence. `unknown` is not `false`, the same rule
 * the share bridge's reach follows.
 */
export function roster(): RosterEntry[] | null {
  const bus = getCollabBus()
  if (!bus) return null
  return othersInRoom(bus.getParticipants(), bus.sessionId)
}

/** Total other windows in the room — what the count in the UI reports. */
export function otherSessionCount(entries: readonly RosterEntry[]): number {
  let total = 0
  for (const entry of entries) total += entry.sessions
  return total
}

/** Visible names before the rest folds into "+N more" — the rail is narrow. */
export const NAME_CAP = 3

/**
 * The one-line answer, in the owner's terms.
 *
 * Deliberately says "in here" rather than "in the game": this roster is the
 * host's, so it knows who has the PROJECT open and cannot tell an editor tab
 * from someone already running around inside. Claiming the stronger thing
 * would re-introduce exactly the kind of lie the share sentence just had fixed
 * — someone reading "Anna is in the game with you" while Anna sits in a
 * read-only viewer learns something false about a bug he is trying to find.
 */
export function rosterMessage(entries: RosterEntry[] | null): string {
  if (entries === null) return 'No shared session on this page — nobody can join here.'
  if (entries.length === 0) return 'Just you in here right now.'

  const named = entries.slice(0, NAME_CAP).map((entry) => {
    // A second window of the same person is worth showing: it is the difference
    // between "my phone connected" and "my phone did not".
    return entry.sessions > 1 ? `${entry.name} (×${entry.sessions})` : entry.name
  })
  const hidden = entries.length - named.length
  if (hidden > 0) named.push(`+${hidden} more`)

  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  // Agrees with the number of NAMES, not of windows: "Anna (×2) are in here"
  // is wrong English — the subject is still Anna.
  const verb = entries.length === 1 ? 'is' : 'are'
  return `${list} ${verb} in here with you.`
}

/**
 * How often the panel re-reads the room, on top of the host's events.
 *
 * NOT a substitute for the subscription — a belt for two things the
 * subscription cannot cover. The panel can mount BEFORE the host installs the
 * bus (then `onRosterChange` subscribed to nothing and would stay silent
 * forever), and the host installs a NEW bus object whenever the awareness
 * session re-keys (net.ts documents that; a listener bound to the dead object
 * never fires again). A sidebar line is not latency-critical, and the read is a
 * loop over a handful of participants, so a few seconds is the right price for
 * never being wrong for the whole session.
 */
export const ROSTER_POLL_MS = 2500

/**
 * A cheap identity for a roster read, so the poll above only re-renders when
 * the room actually changed. Without it the panel would re-render every
 * ROSTER_POLL_MS forever, in the editor, for nothing.
 */
export function rosterSignature(entries: readonly RosterEntry[] | null): string {
  if (entries === null) return 'no-bus'
  return entries.map((entry) => `${entry.userId}:${entry.sessions}:${entry.name}`).join('|')
}

/**
 * Subscribe to roster changes. Returns a no-op unsubscribe with no bus, so a
 * caller needs no feature check of its own.
 *
 * The handler fires on the host's participant events only. It does NOT fire
 * when a bus appears later — a page that had no bus at mount keeps saying so,
 * which is correct for the host: the bus is installed with the awareness
 * runtime before the plugin panel can render, not sometime after.
 */
export function onRosterChange(handler: () => void): () => void {
  const bus = getCollabBus()
  if (!bus) return () => {}
  return bus.onParticipants(() => handler())
}
