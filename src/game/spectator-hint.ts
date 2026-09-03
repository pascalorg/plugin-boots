/**
 * SPECTATOR HINT — the pure half of spectator.tsx: pill copy, the join/leave
 * line, the drop-in handoff rule and the never-two-Jump-in-buttons check. No
 * React, no three, no DOM — spectator.tsx imports these and the tests pin them
 * headless without dragging the avatar renderer along.
 */

/** Roster poll cadence (ms). A plain timer, not useFrame: names and the
 * suppression check are UI-rate concerns, not render-rate ones. */
export const WATCH_POLL_MS = 400
/** Names spelled out in the pill before it falls back to a count. */
export const HINT_NAME_CAP = 3
/** How long a join/leave line rides under the pill (ms). */
export const HINT_EVENT_HOLD_MS = 2400
/** The pill's DOM marker — QA + the drop gate's suppression check. */
export const HINT_ATTR = 'data-boots-spectator-hint'

/** Pill copy from the sorted live-player names; null = nobody playing. */
export function spectatorHintText(names: readonly string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is playing — ⏵ JUMP IN`
  if (names.length <= HINT_NAME_CAP) return `${names.join(', ')} playing — ⏵ JUMP IN`
  return `${names.length} people playing — ⏵ JUMP IN`
}

/** One muted line for a join/leave under the pill. */
export function presenceEventLine(event: { type: 'join' | 'leave'; name: string }): string {
  return `${event.name} ${event.type === 'join' ? 'joined' : 'left'}`
}

/**
 * Tear the receive-only adapter down on cleanup? Only when the phase is NOT
 * 'game': a drop-in hands the live registry to startPresence instead (no
 * reconnect, no re-join). Everything else (unmount in editor phase) stops.
 */
export function shouldStopOnCleanup(phase: string): boolean {
  return phase !== 'game'
}

/** Hide the pill while another Jump-in surface is up (drop veil / reentry). */
export function hintSuppressed(doc: { querySelector(selectors: string): unknown }): boolean {
  return !!doc.querySelector('[data-boots-drop-veil],[data-boots-reentry]')
}
