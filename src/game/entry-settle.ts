/**
 * THE LOT SETTLES AFTER YOU LAND — entry-snapshot self-correction.
 *
 * The session's world is a SNAPSHOT: collectWorld runs the instant the player
 * jumps in, and everything downstream (colliders, voxel targets, the build
 * lattice and the grid stamp that peers address slots in) is frozen from it.
 * That is correct for the first player into a room, whose scene finished
 * mounting minutes ago. It is wrong for a late joiner, whose scene is STILL
 * ARRIVING at the moment they click Jump in.
 *
 * Measured 2026-09-01, two clients in the same room, same document:
 *   [A] collected 347 walls · anchor (19.602, −11.249) · stamp 216597037
 *   [C] collected 236 walls · anchor  (4.177, −15.425) · stamp 1699715880
 * and the audit named the input: on C the anchor wall's `local` coordinate was
 * IDENTICAL to A's (the store agreed) while its root's world translation read
 * (0,0) — the matrices had not been applied yet. C derived the anchor from a
 * level-LOCAL point, published a lattice ~15 m off the lot it stood in, and
 * every slot-addressed piece between the two was refused for the whole
 * session. That is the owner's bug in one line: "MASSIVE problem that others
 * couldn't see my constructions… We should always all see the state of the map
 * as it is currently."
 *
 * C's own live derivation CORRECTED ITSELF a few seconds later — the frame was
 * knowable, just not yet at snapshot time. So the fix is not a better
 * derivation, it is a second look: poll what we WOULD publish now
 * (world.deriveLiveGrid) against what we DID publish, and once the readings
 * stop moving, correct.
 *
 * TWO CORRECTIONS, DELIBERATELY DIFFERENT IN COST:
 *   'reanchor'  — re-install the lattice frame and re-publish the stamp. Cheap,
 *                 no world churn. Fixes the anchor/ladder (the sync bug).
 *   'recollect' — re-run collectWorld. Also recovers walls that were missing
 *                 from the snapshot (C's 111), but it resets destruction state
 *                 and re-voxelizes, so it is allowed only while the session
 *                 holds nothing to lose.
 *
 * GUARDS ARE THE WHOLE DESIGN. A slot id is an address in the lattice, so
 * moving the lattice under pieces that already have addresses would relocate
 * them — re-anchoring is refused once any slot-addressed piece exists. A
 * re-collect drops destruction targets, so it is refused once anything is
 * damaged or built. Both are capped and both stop at the window: a session
 * that cannot be corrected safely says so ('blocked') instead of thrashing.
 *
 * QUIET IS NOT DONE. The first cut stopped watching after six agreeing
 * seconds; a joiner whose transforms landed at eight agreed with itself, then
 * drifted with nobody looking. Now quiet only slows the watch to a sentinel
 * cadence, the window alone ends it, and a peer's record refused against our
 * stamp (a 'nudge' from net-world) waives the stability wait outright.
 *
 * Pure decision math, no scene/React/three imports — the driver (game-root's
 * ActiveGame) samples the world and applies the verdict, and settle.test.ts
 * proves every branch headless.
 */

/** How often the driver samples. Cheap: a registry sweep + one derivation. */
export const SETTLE_CHECK_MS = 400

/**
 * HARD CAP, not the expected lifetime — the watcher normally exits early on
 * quiet (below). A first cut used a 20 s window and it expired BEFORE the late
 * joiner's transforms landed (measured: ~26 s after entry on a headless client
 * rendering ~3 fps, which is exactly the slow-client case the bug lives in), so
 * the correction never fired. Tying correctness to a wall-clock guess is the
 * mistake; the cap only stops a watcher from living forever.
 */
export const SETTLE_WINDOW_MS = 90000

/** Consecutive IDENTICAL drifting readings required before acting — the scene
 * arrives in pieces, and correcting mid-arrival would just be wrong twice. */
export const SETTLE_STABLE_CHECKS = 2

/** Consecutive identical AGREEING readings that end the watch: the scene has
 * stopped moving and we match it. ~6 s at SETTLE_CHECK_MS — long enough to
 * cover a storey arriving after the ground floor, short enough that a healthy
 * session isn't polling for a minute. */
export const SETTLE_QUIET_CHECKS = 15
/**
 * After quiet the watcher does NOT stop — it slows to this cadence until the
 * window closes. Measured 2026-09-02 (two-client harness, headless): a late
 * joiner agreed with itself on the still-unapplied level transforms for the
 * first six seconds, the watcher latched "settled", and when the transforms
 * landed at ~8 s the live anchor drifted 15 m with nobody left to look:
 * `refusedGrid 11, regrids 0` for the whole session. A quiet scene is a
 * scene that has stopped moving SO FAR.
 */
export const SETTLE_SENTINEL_MS = 2000

/** Anchor agreement tolerances. The stamp quantizes position to millimetres
 * (world.quantPos) and yaw to 0.05°, so anything below these is the same
 * lattice by construction — never re-publish over float noise. */
export const SETTLE_POS_EPS = 0.005
export const SETTLE_YAW_EPS = 0.0005

/** One re-collect is a recovery, two is a loop. */
export const SETTLE_MAX_RECOLLECTS = 1

/** Two re-anchors: one for the common late-matrix landing, one spare for a
 * scene that lands in two stages (upper storeys after the ground floor). */
export const SETTLE_MAX_REANCHORS = 2

export type SettleAnchor = { x: number; z: number; yaw: number }

/** One sample of "what we published" vs "what we would publish now". */
export type SettleReading = {
  /** ms since the driver's first sample (entry). */
  elapsedMs: number
  /** The lattice frame the session INSTALLED (from the snapshot). */
  installed: SettleAnchor | null
  /** The frame the live scene derives right now. */
  live: SettleAnchor | null
  /** The storey ladder the session installed, and the live one. */
  installedLadder: number[] | null
  liveLadder: number[] | null
  /** Walls in the frozen snapshot vs walls the live registry holds. */
  collectedWalls: number
  liveWalls: number
  /** Any placed piece carrying a slot id — its address lives in the lattice. */
  hasSlotPieces: boolean
  /** Any placed piece at all (slot-addressed or free). */
  hasPieces: boolean
  /** Any destruction target with a cell already gone. */
  hasDamage: boolean
  /** A peer's slot-addressed record was just refused for a grid-stamp
   * mismatch — the loudest possible evidence that OUR frame is the odd one.
   * Waives the stability wait: the room has already agreed on a lattice. */
  nudged?: boolean
}

export type SettleAction =
  /** Nothing to correct yet (or the scene is still moving). */
  | 'wait'
  /** Agreeing and quiet: keep watching, slowly (SETTLE_SENTINEL_MS). */
  | 'quiet'
  /** Re-install the lattice frame + re-publish the stamp. */
  | 'reanchor'
  /** Re-run collectWorld and adopt the fresh snapshot. */
  | 'recollect'
  /** A real drift that no correction may safely touch — report it. */
  | 'blocked'
  /** Stop watching. */
  | 'settled'

export type SettleMemory = {
  /** Consecutive identical drifting readings. */
  stable: number
  /** Key of the reading `stable` is counting. */
  key: string
  recollects: number
  reanchors: number
  /** The reading has been quiet: the driver polls at the sentinel cadence. */
  quiet: boolean
  /** Latched once the watcher is finished (window closed, or blocked). */
  done: boolean
}

export function newSettleMemory(): SettleMemory {
  return { done: false, key: '', quiet: false, reanchors: 0, recollects: 0, stable: 0 }
}

/** Same lattice? Missing on either side counts as disagreement ONLY when one
 * side has a frame and the other doesn't; two nulls agree (nothing installed
 * yet, nothing derivable — a wall-less lot runs the identity grid). */
export function anchorsAgree(
  a: SettleAnchor | null,
  b: SettleAnchor | null,
  posEps = SETTLE_POS_EPS,
  yawEps = SETTLE_YAW_EPS,
): boolean {
  if (!a || !b) return !a && !b
  return (
    Math.abs(a.x - b.x) <= posEps &&
    Math.abs(a.z - b.z) <= posEps &&
    Math.abs(a.yaw - b.yaw) <= yawEps
  )
}

/** Same storeys? Length and every rung within the position tolerance — the
 * ladder is part of the stamp preimage, so a rung that lands late is the same
 * class of bug as a matrix that lands late. */
export function laddersAgree(
  a: number[] | null,
  b: number[] | null,
  eps = SETTLE_POS_EPS,
): boolean {
  if (!a || !b) return !a && !b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > eps) return false
  }
  return true
}

/** Is this reading a real disagreement with what we published? */
export function settleDrifted(r: SettleReading): boolean {
  return (
    !anchorsAgree(r.installed, r.live) ||
    !laddersAgree(r.installedLadder, r.liveLadder) ||
    r.liveWalls > r.collectedWalls
  )
}

/** Stability key: the LIVE side only, quantized. Two consecutive readings with
 * the same key mean the scene stopped moving — the installed side can't move
 * on its own, so folding it in would only add noise. */
export function readingKey(r: SettleReading): string {
  const a = r.live
  const anchor = a ? `${a.x.toFixed(3)},${a.z.toFixed(3)},${a.yaw.toFixed(4)}` : 'none'
  const ladder = r.liveLadder ? r.liveLadder.map((y) => y.toFixed(2)).join('|') : 'none'
  return `${anchor}/${ladder}/${r.liveWalls}`
}

/**
 * One step of the watcher: what to do about this reading, and the memory to
 * carry into the next one. Pure — same inputs, same verdict, no clock read.
 *
 * Ordering matters: a re-collect fixes BOTH the missing walls and the frame,
 * so it wins when the snapshot is short of walls and nothing is at stake;
 * otherwise the cheap correction runs. A drift with no safe correction left
 * latches `done` — the session keeps playing with an honest 'blocked' reading
 * rather than re-publishing a lattice under addressed pieces.
 */
export function settleStep(
  r: SettleReading,
  mem: SettleMemory,
): { action: SettleAction; mem: SettleMemory } {
  if (mem.done) return { action: 'settled', mem }

  // Stability is measured over EVERY reading, agreeing or not: it answers "has
  // the scene stopped moving?", which is the question both exits ask.
  const key = readingKey(r)
  const stable = key === mem.key ? mem.stable + 1 : 1
  const waited = { ...mem, key, stable }

  const drifted = settleDrifted(r)
  const expired = r.elapsedMs >= SETTLE_WINDOW_MS

  if (!drifted) {
    // Agreement is the normal case (the first player into a room reads it on
    // the first sample). Keep watching anyway — a scene can agree at 400 ms
    // and still move a storey in seconds later — and once the reading has
    // been quiet, keep watching SLOWLY: quiet means "stopped moving so far",
    // and the joiner's transforms have landed eight seconds in. Only the
    // window ends the watch.
    if (expired) return { action: 'settled', mem: { ...waited, done: true } }
    if (mem.quiet || stable >= SETTLE_QUIET_CHECKS) {
      return { action: 'quiet', mem: { ...waited, quiet: true } }
    }
    return { action: 'wait', mem: waited }
  }
  // Drifting, but out of time — stop. Reporting 'blocked' here would be a lie:
  // we never got a stable reading to act on.
  if (expired) return { action: 'settled', mem: { ...waited, done: true } }
  // Two identical drifting readings before acting — unless the room has just
  // refused one of its records against our stamp, which settles the question.
  if (stable < SETTLE_STABLE_CHECKS && !r.nudged) {
    return { action: 'wait', mem: { ...waited, quiet: false } }
  }

  const anchorDrift =
    !anchorsAgree(r.installed, r.live) || !laddersAgree(r.installedLadder, r.liveLadder)
  const wallsShort = r.liveWalls > r.collectedWalls
  const canRecollect = !r.hasPieces && !r.hasDamage && mem.recollects < SETTLE_MAX_RECOLLECTS
  const canReanchor = !r.hasSlotPieces && mem.reanchors < SETTLE_MAX_REANCHORS

  if (wallsShort && canRecollect) {
    return {
      action: 'recollect',
      mem: { ...waited, key: '', quiet: false, recollects: mem.recollects + 1, stable: 0 },
    }
  }
  if (anchorDrift && canReanchor) {
    return {
      action: 'reanchor',
      mem: { ...waited, key: '', quiet: false, reanchors: mem.reanchors + 1, stable: 0 },
    }
  }
  // A stable, real drift we may not touch: pieces already addressed in the old
  // lattice, damage already applied, or the caps spent. Latch and say so.
  return { action: 'blocked', mem: { ...waited, done: true } }
}
