/**
 * BUS-BIND RETRY — the one helper both multiplayer lifecycles share.
 *
 * The host installs `__pascalCollabBus` ASYNCHRONOUSLY: the awareness runtime
 * that carries it mounts only once realtime auth has landed, while our own
 * mounts (ActiveGame after a Jump In, SpectatorPlayers in the editor) are
 * gated on the SCENE being ready. So both used to bind exactly once — and a
 * fast Jump In, or an editor viewer whose bus arrived a second after the
 * plugin mounted, played a whole SOLO session / watched an empty lot: the
 * literal "we do not see each other".
 *
 * `untilNet(start, onReady)` calls `start()` now and, if it reports failure,
 * again every `intervalMs` until it succeeds; then `onReady` runs exactly once.
 * The transport modules themselves stay single-shot and schedule nothing
 * without a bus (presence.test.ts pins that) — the timer belongs to the
 * CALLER, which is the component whose lifetime bounds it, and the returned
 * cancel is its cleanup.
 *
 * Cost without a bus: one global read per second. A page that never gets a
 * bus (solo app, host flag off, :3002 without the QA stub) pays that and
 * nothing else — no subscription, no frames, no avatars.
 */

/** Retry cadence (ms). A bus that lands late lands within a second of us. */
export const NET_RETRY_MS = 1000

/**
 * Run `start` until it returns true, then `onReady` once. Returns a cancel.
 *
 * - `start()` true on the first call → `onReady()` runs synchronously and
 *   NOTHING is scheduled (the returned cancel is a no-op): with a bus already
 *   installed this is exactly the old single pass.
 * - otherwise an interval re-runs `start()`; the first success clears the
 *   interval and runs `onReady()`; a cancel before that means `onReady` never
 *   runs.
 */
export function untilNet(
  start: () => boolean,
  onReady?: () => void,
  intervalMs: number = NET_RETRY_MS,
): () => void {
  if (start()) {
    onReady?.()
    return noop
  }
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!start()) return
    if (timer !== null) clearInterval(timer)
    timer = null
    onReady?.()
  }, intervalMs)
  return () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
}

function noop(): void {}
