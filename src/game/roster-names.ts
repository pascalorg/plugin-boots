import { remoteLabel, type RemotePlayer } from './presence'

/**
 * ROSTER NAMES — list helpers over the one label rule for a remote player,
 * shared by every surface that prints WHO is here: the spectator pill in the
 * editor ("Alice is playing — JUMP IN"), the in-game roster chip ("2 players:
 * Alice, Bob") and the join/leave toasts.
 *
 * The rule itself is `remoteLabel` in presence.ts, next to emit() so the
 * toasts and every list here cannot drift apart: the peer's CHOSEN nickname
 * (rides their pose frame, `nm`) wins; otherwise the host roster's display
 * name for their userId; otherwise 'builder'. Open-lobby strangers are
 * unprofiled, so a surface built off the roster name alone would read
 * "builder is playing" — the nick is what makes the copy true. Re-exported
 * here so existing importers keep working.
 */

/** Display label for a remote — nick first, roster name second, 'builder' last. */
export { remoteLabel } from './presence'

/**
 * Sorted labels of every remote that is IN THE GAME (ph:'game'). Editor-phase
 * entries never become avatars (presence.ts drops them), so they are not
 * players either. Allocates — call it on roster edges and slow polls, never
 * per frame.
 */
export function livePlayerNames(
  remotes: ReadonlyMap<string, Pick<RemotePlayer, 'nick' | 'userId' | 'ph'>>,
): string[] {
  const names: string[] = []
  for (const remote of remotes.values()) {
    if (remote.ph === 'game') names.push(remoteLabel(remote))
  }
  names.sort()
  return names
}

/** Order-sensitive equality for two name lists (poll change gate). */
export function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
