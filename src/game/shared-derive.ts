/**
 * shared-derive.ts — the deterministic derivations that sit on top of the
 * converged state, plus the seeded-randomness primitives the shared paths
 * must use instead of Math.random().
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. Anything two clients must AGREE on
 * is either replicated as an outcome (shared-world.ts) or computed here from
 * replicated inputs by a function that is pure, total, and free of iteration
 * order, wall clocks and frame budgets. Nothing in between. The live game has
 * several derivations that look pure and are not — the collapse cascade walks
 * `Map` values in prevoxelization order, the settle drain snapshots "due" keys
 * against performance.now() and stops at a per-frame budget, the explosion
 * segment pass caps at 48 sticks in Map order — and every one of them would
 * make two players see different rubble. Those stay LOCAL and their results
 * are replicated; the functions here are the ones we promote to shared.
 *
 * WHAT IS IN HERE
 *
 *   gridStamp        fingerprints the build grid, so peers can detect that
 *                    their slot ids mean different places.
 *   deriveCollapse   a round-synchronous fixpoint over the support graph:
 *                    same inputs, same output, in any order, on any machine.
 *   electSlots       one piece per slot when two peers claim it at once.
 *   foldCoats        replays paint strokes into the per-cell coat ledger in
 *                    canonical order, so held-spray build-up converges.
 *   buriedApertures  the derived form of the "wall gone ⇒ its openings are
 *                    gone" rule, which needs no replicated state at all.
 *   stableSeed etc.  seeded randomness keyed by (node id, cell), never by
 *                    call order.
 *
 * Nothing here imports the live game. Where a rule already exists in the game
 * (the paint coat arithmetic) it is INJECTED rather than copied, so there is
 * exactly one definition of it in the codebase and this module cannot drift
 * away from what the player actually sees.
 */

import {
  quantPos,
  type CellKey,
  type NodeId,
  type PieceRec,
  type StrokeRec,
} from './shared-world'

// ── Stable hashing and seeded randomness ────────────────────────────────────

/**
 * FNV-1a, byte-for-byte the same mixing the game already uses for its
 * deterministic shell seed. Same string ⇒ same u32, on every client, every
 * session, forever — which is the entire requirement.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/**
 * The seed for a decision about one cell of one node.
 *
 * The point of keying on (node id, cell key) rather than drawing from a
 * stream is that a stream's value depends on how many draws came before it,
 * and the number of draws depends on how many cells the local client has
 * materialized, in what order, at what frame rate. A key-derived seed has no
 * history: the same cell answers the same way whether it is the first thing
 * this client evaluates or the ten-thousandth.
 */
export function stableSeed(nodeId: NodeId, key: number): number {
  let h = hashString(nodeId)
  h = Math.imul(h ^ (key & 0xffff), 0x01000193)
  h = Math.imul(h ^ (key >>> 16), 0x01000193)
  return h >>> 0
}

/** A seed → a value in [0, 1). Deterministic, no state. */
export function seededUnit(seed: number): number {
  let h = seed >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x21f0aaad)
  h ^= h >>> 15
  h = Math.imul(h, 0x735a2d97)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Unit value for one cell of one node, in one named channel. Two different
 * channels ("scale", "spin") for the same cell are independent. */
export const seededCellUnit = (nodeId: NodeId, key: number, channel: string): number =>
  seededUnit(Math.imul(stableSeed(nodeId, key) ^ hashString(channel), 0x01000193))

/**
 * mulberry32 — a tiny seeded PRNG. This is for TESTS and for any local-only
 * effect that wants repeatability; it is deliberately NOT used for anything
 * two clients must agree on, because a shared decision must key off the thing
 * it is deciding about, not off a position in a sequence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Grid fingerprint ────────────────────────────────────────────────────────

/**
 * Fingerprint the build grid.
 *
 * Slot ids are strings like "Wx:3,-1,0" — a kind plus integer lattice coords.
 * They are stable and deterministic, but they are only a WORLD ADDRESS given
 * grid.ts's module-level anchor (the lot origin the client snapped to) and its
 * storey ladder (the y of each floor). Two clients in the same project derive
 * the same pair and stamp the same number; a client that has not resolved its
 * lot yet, or is somehow in a different one, stamps differently and its
 * slot-addressed pieces are refused rather than dropped in the wrong place.
 *
 * Anchor and storey values are quantized to the millimetre before hashing so
 * that floating-point noise in two clients' identical arithmetic cannot make
 * them disagree. Returns a non-zero u32 (0 is reserved for "unknown").
 */
export function gridStamp(anchorX: number, anchorZ: number, storeyYs: readonly number[]): number {
  const parts: string[] = [
    (quantPos(anchorX) * 1000).toFixed(0),
    (quantPos(anchorZ) * 1000).toFixed(0),
  ]
  for (const y of storeyYs) parts.push((quantPos(y) * 1000).toFixed(0))
  const h = hashString(parts.join('|'))
  return h === 0 ? 1 : h
}

// ── Canonical orders ────────────────────────────────────────────────────────

/** Node ids in the one order every client agrees on. */
export const canonicalNodeOrder = (ids: Iterable<NodeId>): NodeId[] => [...ids].sort()

/** Cells in the one order every client agrees on. */
export const canonicalCellOrder = (keys: Iterable<CellKey>): CellKey[] =>
  [...keys].sort((a, b) => a - b)

/**
 * Records in the one order every client agrees on: lamport first (so causal
 * order is respected where it exists), then id (so concurrent records still
 * have a total order). Never insertion order, which differs per client.
 */
export const canonicalRecordOrder = <T extends { id: string; lamport: number }>(
  recs: Iterable<T>,
): T[] =>
  [...recs].sort((a, b) => (a.lamport !== b.lamport ? a.lamport - b.lamport : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// ── Collapse derivation ─────────────────────────────────────────────────────

/**
 * Ceiling on how much one derivation may collapse. This is a SAFETY VALVE,
 * not a tuning knob: the fixpoint below terminates on its own after at most
 * one round per node, so this only trips on a pathological graph. It is
 * deliberately far above any real lot, because a cap that bites would make
 * the result depend on how much the client happened to know — the exact class
 * of bug this module exists to avoid.
 */
export const MAX_DERIVED_COLLAPSE = 4096

export type CollapseInput = {
  /** Nodes already gone — the converged `killed` set plus whatever the caller
   * has just removed. Never mutated. */
  dead: ReadonlySet<NodeId>
  /** Nodes that MIGHT now be unsupported. Order irrelevant. */
  seeds: Iterable<NodeId>
  /** What rests on this node. Must be a pure function of node identity. */
  dependentsOf: (id: NodeId) => Iterable<NodeId>
  /**
   * Is `id` still held up, given `dead`? Must be pure and must not consult
   * anything the caller has not replicated (in particular not "is this node
   * materialized locally", which is what makes the live probe unusable here).
   */
  isSupported: (id: NodeId, dead: ReadonlySet<NodeId>) => boolean
}

/**
 * The cascade, as a ROUND-SYNCHRONOUS fixpoint.
 *
 * Each round evaluates every candidate against the dead set as it stood at
 * the START of the round, then adds all the failures at once. That is the one
 * detail that makes the result order-free: if candidates were tested against
 * a set being mutated as we walked it, then "A falls, therefore B falls"
 * versus "B tested first, survives" would depend on iteration order — which
 * is precisely how the live cascade drifts between clients.
 *
 * Returns the newly-dead nodes in canonical order (NOT including `dead`).
 */
export function deriveCollapse(input: CollapseInput): NodeId[] {
  const dead = new Set(input.dead)
  const fresh: NodeId[] = []
  let frontier = canonicalNodeOrder(input.seeds).filter((id) => !dead.has(id))

  let rounds = 0
  while (frontier.length > 0 && rounds++ < MAX_DERIVED_COLLAPSE) {
    // Snapshot: every test in this round sees the same world.
    const before: ReadonlySet<NodeId> = new Set(dead)
    const falling: NodeId[] = []
    for (const id of frontier) {
      if (dead.has(id)) continue
      if (!input.isSupported(id, before)) falling.push(id)
    }
    if (falling.length === 0) break
    const next = new Set<NodeId>()
    for (const id of falling) {
      if (dead.has(id)) continue
      dead.add(id)
      fresh.push(id)
      if (fresh.length >= MAX_DERIVED_COLLAPSE) return canonicalNodeOrder(fresh)
      for (const dep of input.dependentsOf(id)) {
        if (!dead.has(dep)) next.add(dep)
      }
    }
    frontier = canonicalNodeOrder(next)
  }
  return canonicalNodeOrder(fresh)
}

// ── Slot election ───────────────────────────────────────────────────────────

/**
 * One piece per slot.
 *
 * Two players can hammer the same wall slot in the same tick, and both
 * records are legitimate — neither peer may overwrite the other's id, so the
 * OR-Set correctly keeps both. The GAME cannot show both (there is one slot,
 * and slotByPiece is a 1:1 map), so the tie is settled by a projection every
 * client computes identically: highest lamport wins, id breaks the tie. The
 * loser stays in the model, untombstoned — if the winner is later destroyed
 * the slot simply stays empty, which is the same thing that happens when a
 * single-player wall is destroyed, rather than a zombie piece popping back.
 */
export function electSlots(pieces: Iterable<PieceRec>): {
  winners: Map<string, PieceRec>
  losers: PieceRec[]
} {
  const winners = new Map<string, PieceRec>()
  const losers: PieceRec[] = []
  for (const rec of canonicalRecordOrder(pieces)) {
    const key = `${rec.kind}|${rec.slot}`
    const prior = winners.get(key)
    if (!prior) {
      winners.set(key, rec)
      continue
    }
    // canonicalRecordOrder is ascending, so `rec` always wins on arrival.
    winners.set(key, rec)
    losers.push(prior)
  }
  losers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { winners, losers }
}

// ── Paint coat fold ─────────────────────────────────────────────────────────

/**
 * The two pieces of the live coat rule, injected rather than imported so this
 * module stays pure AND so the arithmetic has exactly one definition in the
 * codebase. Pass `{ pack: paintValue, base: coatBaseStrength }` from paint.
 */
export type CoatOps = {
  /** (color, strength 0..1) → packed ledger value. */
  pack: (color: number, strength: number) => number
  /** The strength a coat of `color` builds on, given the previous packed
   * value: same colour accumulates, a different colour restarts at 0. */
  base: (prev: number | undefined, color: number) => number
}

/** What one stroke touches on THIS client's grid: cell + falloff weight. */
export type CoatSplat = { cell: number; add: number }

/**
 * Replay the converged strokes of one node into a per-cell coat ledger.
 *
 * Two things make this convergent where naive replication would not be.
 *
 * First, order. Coat build-up is not commutative — min(1, a+b) is, but a
 * COLOUR CHANGE resets the accumulator, so blue-then-green and
 * green-then-blue leave different cells. Folding in canonical (lamport, id)
 * order gives every client the same sequence regardless of arrival order.
 *
 * Second, tier independence. `expand` is asked for the cells a ball touches
 * on the local grid; a client that materializes the node later, at a
 * different moment, still expands the same ball against the same grid and
 * gets the same cells. The stroke never carries a cell list, so it cannot be
 * stale, and re-folding from scratch after a late join lands exactly where a
 * client that watched it happen live already is.
 */
export function foldCoats(
  strokes: Iterable<StrokeRec>,
  expand: (stroke: StrokeRec) => Iterable<CoatSplat>,
  ops: CoatOps,
  into: Map<number, number> = new Map(),
): Map<number, number> {
  for (const stroke of canonicalRecordOrder(strokes)) {
    for (const splat of expand(stroke)) {
      const before = ops.base(into.get(splat.cell), stroke.color)
      into.set(splat.cell, ops.pack(stroke.color, Math.min(1, before + splat.add)))
    }
  }
  return into
}

/** Strokes grouped by node, each group already in canonical order. */
export function strokesByNode(strokes: Iterable<StrokeRec>): Map<NodeId, StrokeRec[]> {
  const out = new Map<NodeId, StrokeRec[]>()
  for (const rec of canonicalRecordOrder(strokes)) {
    const list = out.get(rec.node)
    if (list) list.push(rec)
    else out.set(rec.node, [rec])
  }
  return out
}

// ── Derived-not-replicated rules ────────────────────────────────────────────

/**
 * "The wall is gone, so its openings are gone."
 *
 * The live game buries a hosted door or window by disabling its collider when
 * the wall that holds it loses its last cell. There is no state to replicate
 * here at all: the input (which walls have no cells left) is already
 * converged, the test is a pure predicate on scene parentage, and the action
 * is idempotent. Deriving it also fixes a latent late-join problem for free —
 * a joiner receiving a snapshot has never seen the wall's last cell die, so
 * an event-shaped "bury this door" message would simply never arrive.
 *
 * `hostOf` must be the scene relation the game already uses (a node is hosted
 * by the wall that is its parent, or that it names as its wall).
 */
export function buriedApertures(
  emptiedWalls: Iterable<NodeId>,
  apertureNodes: Iterable<NodeId>,
  hostOf: (apertureNode: NodeId) => NodeId | null,
): NodeId[] {
  const gone = new Set(emptiedWalls)
  const out: NodeId[] = []
  for (const node of apertureNodes) {
    const host = hostOf(node)
    if (host !== null && gone.has(host)) out.push(node)
  }
  return canonicalNodeOrder(out)
}

/**
 * "The sheet has no cells left, so it has flown off."
 *
 * Torn-sheet state (hit counters, tear thresholds) is deliberately NOT
 * replicated: the counters are local accumulations of local hits, and the
 * only outcome that matters — the sheet leaving — is already implied by its
 * cells being dead, which IS replicated. A joiner folding a snapshot sees the
 * empty sheet and flies it off on the spot.
 */
export const sheetHasFlown = (sheetCells: Iterable<CellKey>, dead: ReadonlySet<CellKey>): boolean => {
  let any = false
  for (const cell of sheetCells) {
    any = true
    if (!dead.has(cell)) return false
  }
  return any
}
