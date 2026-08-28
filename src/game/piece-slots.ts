/**
 * Piece-slot registry — THE single occupancy authority of build grammar v2
 * (docs/BUILD-GRAMMAR-V2-REVIEW.md agent 3: the live glue between grid.ts,
 * support.ts, the builder, and QA). One module-level session registry maps
 *
 *   slotId  ↔  placedPieceId        (both directions, 1:1)
 *
 * and feeds a SupportGraph wired with grid.slotsTouching. EVERY occupancy
 * question — the ghost's blue/red, turbo dedupe, QA probes — reads through
 * this module; nobody else keeps a slot map.
 *
 * ── Grounding ────────────────────────────────────────────────────────────
 * A registered slot is a support ROOT when grid.isTerrainGrounded(slotId)
 * (storey 0) OR the injected scene-support probe says live scene geometry
 * still holds it up. The probe is supplied by the builder wiring
 * (setSceneSupportProbe) and MUST skip disabled colliders and dead voxel
 * targets (REVIEW risk note) so a demolished scene wall drops dependents.
 * Probe answers are CACHED per slot; the wiring must call
 * notifySceneSupportChanged() after anything that can change them (voxel
 * crumble, collider disable, dropTarget) — that clears the cache,
 * re-checks the graph, and cascades any newly-orphaned pieces.
 *
 * ── Collapse (the "same cleanup as undo" contract) ───────────────────────
 * onPieceRemoved(slotId) is the ONE removal entry point (undo Z AND
 * destruction call it). It unregisters the slot, stamps the died-slot
 * lockout, asks the graph for the orphaned component as BFS rings, and
 * fires the registered onCollapse listeners one ring every
 * COLLAPSE_RING_MS. THIS MODULE NEVER TOUCHES THE STORE: the listener
 * (builder wiring) owns the debris burst + store removal; unmounting
 * PlacedPieceMesh then runs the exact undo cleanup (collider splice +
 * destruction.dropTarget). Re-entry is safe — a collapsed piece's unmount
 * calling back into onPieceRemoved finds the slot already unregistered and
 * no-ops.
 *
 * ── Died-slot lockout ────────────────────────────────────────────────────
 * Every slot that loses its piece (undo, destruction, cascade) is stamped;
 * diedAt/isDeathLocked expose the 0.15 s turbo lockout (the settled turbo
 * spec: one attempt per slot per hold, 0.15 s lockout on died slots).
 *
 * No React, no three, no zustand — tests stub the store as a listener.
 * Candidate-support answers are memoized per slot and invalidated on any
 * mutation, so the per-frame ghost query allocates nothing in steady state.
 */

import { isTerrainGrounded, slotsTouching } from './grid'
import { type SlotId, SupportGraph } from './support'

/** Delay between collapse rings — ring N fires at N·COLLAPSE_RING_MS after
 * the removal (ring 0 on a 0 ms timeout: async, but this frame's next
 * macrotask, so store updates never re-enter the caller's stack). */
export const COLLAPSE_RING_MS = 50
/** Turbo lockout on slots where a piece just died (settled spec: 0.15 s). */
export const DIED_SLOT_LOCKOUT_MS = 150

/** True while live scene geometry (collider/voxel target within the slot's
 * bounds) supports this slot. MUST respect collider.disabled + voxel
 * liveness. Answers are cached — see notifySceneSupportChanged. */
export type SceneSupportProbe = (slotId: SlotId) => boolean

/** Fired once per collapsed piece, rings in cascade order. The listener
 * owns the debris burst + store removal (the same path as undo). */
export type CollapseListener = (pieceId: number, slotId: SlotId, ring: number) => void

const now: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

// --- Session state (module singleton, resetPieceSlots() between sessions) --

const pieceBySlot = new Map<SlotId, number>()
const slotByPiece = new Map<number, SlotId>()
const diedAtMs = new Map<SlotId, number>()
const listeners = new Set<CollapseListener>()
/** Scene probe answers, valid until notifySceneSupportChanged/probe swap. */
const probeCache = new Map<SlotId, boolean>()
/** Candidate-support memo (isSupported on EMPTY slots) — cleared on any
 * graph/world mutation so the ghost's per-frame query is alloc-free. */
const candidateCache = new Map<SlotId, boolean>()

let sceneProbe: SceneSupportProbe | null = null

function cachedProbe(slotId: SlotId): boolean {
  if (!sceneProbe) return false
  let hit = probeCache.get(slotId)
  if (hit === undefined) {
    hit = sceneProbe(slotId)
    probeCache.set(slotId, hit)
  }
  return hit
}

const graph = new SupportGraph(slotsTouching, cachedProbe)

type RingJob = {
  entries: { slotId: SlotId; pieceId: number }[]
  ring: number
  at: number
  timer: ReturnType<typeof setTimeout>
}
const pendingRings: RingJob[] = []

function touchWorld(): void {
  candidateCache.clear()
}

/** Install (or clear) the scene-support probe. Builder wiring provides it;
 * swapping invalidates every cached support answer. */
export function setSceneSupportProbe(probe: SceneSupportProbe | null): void {
  sceneProbe = probe
  probeCache.clear()
  graph.invalidate()
  touchWorld()
}

// --- Occupancy (the single authority) ---------------------------------------

/**
 * Record a placement. Returns false (and does nothing) when the slot is
 * already occupied by another piece — callers gate on ghost validity, so a
 * refusal here means two authorities disagreed and the registry wins.
 */
export function registerPlacement(slotId: SlotId, pieceId: number): boolean {
  const holder = pieceBySlot.get(slotId)
  if (holder !== undefined && holder !== pieceId) return false
  // 1:1 invariant: a piece moving slots (transformPlaced re-slot) drops its
  // old slot even if the caller skipped the explicit unregister.
  const previous = slotByPiece.get(pieceId)
  if (previous !== undefined && previous !== slotId) unregister(previous)
  pieceBySlot.set(slotId, pieceId)
  slotByPiece.set(pieceId, slotId)
  diedAtMs.delete(slotId) // a successful re-fill clears the lockout stamp
  graph.add(slotId, { grounded: isTerrainGrounded(slotId) })
  touchWorld()
  return true
}

/**
 * Bare removal — maps + graph + died stamp, NO cascade (onPieceRemoved is
 * the cascading entry point and calls through here). Exposed for the
 * transformPlaced re-slot (unregister old, registerPlacement new).
 * Returns the evicted pieceId, or null when the slot was empty.
 */
export function unregister(slotId: SlotId): number | null {
  const pieceId = pieceBySlot.get(slotId)
  if (pieceId === undefined) return null
  pieceBySlot.delete(slotId)
  slotByPiece.delete(pieceId)
  diedAtMs.set(slotId, now())
  graph.remove(slotId)
  touchWorld()
  return pieceId
}

export function isOccupied(slotId: SlotId): boolean {
  return pieceBySlot.has(slotId)
}

export function pieceAt(slotId: SlotId): number | undefined {
  return pieceBySlot.get(slotId)
}

export function slotOf(pieceId: number): SlotId | undefined {
  return slotByPiece.get(pieceId)
}

// --- Support (grid.WorldProbe-compatible) -----------------------------------

/**
 * Support answer for ANY slot — grid.resolveTargetSlot's WorldProbe:
 * - occupied slot → connected to ground through present pieces (graph);
 * - empty slot (the ghost's question) → terrain at storey 0, live scene
 *   geometry (probe), or ≥1 touching slot holding a SUPPORTED piece.
 * Memoized per slot until the world changes (no per-frame allocations).
 */
export function isSupported(slotId: SlotId): boolean {
  if (graph.has(slotId)) return graph.isSupported(slotId)
  let hit = candidateCache.get(slotId)
  if (hit === undefined) {
    hit = computeCandidateSupport(slotId)
    candidateCache.set(slotId, hit)
  }
  return hit
}

function computeCandidateSupport(slotId: SlotId): boolean {
  if (isTerrainGrounded(slotId) || cachedProbe(slotId)) return true
  for (const neighbor of slotsTouching(slotId)) {
    if (graph.has(neighbor) && graph.isSupported(neighbor)) return true
  }
  return false
}

// --- Collapse cascade -------------------------------------------------------

/** Register a collapse listener; returns the unsubscribe. */
export function onCollapse(listener: CollapseListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * THE removal entry point (REVIEW contract): call after ANY piece leaves
 * its slot — undo Z, destruction, weapon carve. Unregisters, stamps the
 * died-slot lockout, and staggers the orphaned component's collapse one
 * ring per COLLAPSE_RING_MS through the onCollapse listeners. Idempotent:
 * an already-empty slot (e.g. re-entry from a collapsing piece's own
 * cleanup) is a no-op.
 */
export function onPieceRemoved(slotId: SlotId): void {
  if (unregister(slotId) === null) return
  scheduleCollapse(graph.computeCollapse(slotId))
}

/**
 * The world changed under the graph (voxel crumble, collider disable,
 * dropTarget, Keep conversion): clear the probe cache, re-check support,
 * and cascade every piece that just lost its footing. `hints` narrows the
 * seed scan to slots near the change; omit it to sweep all pieces.
 */
export function notifySceneSupportChanged(hints?: readonly SlotId[]): void {
  probeCache.clear()
  graph.invalidate()
  touchWorld()
  const seeds = hints ?? [...pieceBySlot.keys()]
  for (const slotId of seeds) {
    if (!graph.has(slotId) || graph.isSupported(slotId)) continue
    // Still present but unsupported → it leads ring 0 itself (support.ts
    // "external support lost" mode); computeCollapse evicts the component.
    scheduleCollapse(graph.computeCollapse(slotId))
    touchWorld()
  }
}

function scheduleCollapse(rings: SlotId[][]): void {
  if (rings.length === 0) return
  touchWorld() // computeCollapse evicted the component from the graph
  for (let ring = 0; ring < rings.length; ring++) {
    const entries: RingJob['entries'] = []
    for (const slotId of rings[ring]!) {
      const pieceId = pieceBySlot.get(slotId)
      if (pieceId !== undefined) entries.push({ slotId, pieceId })
    }
    if (entries.length === 0) continue
    const at = now() + ring * COLLAPSE_RING_MS
    const job: RingJob = {
      entries,
      ring,
      at,
      timer: setTimeout(() => fireRing(job), ring * COLLAPSE_RING_MS),
    }
    pendingRings.push(job)
  }
}

function fireRing(job: RingJob): void {
  const index = pendingRings.indexOf(job)
  if (index !== -1) pendingRings.splice(index, 1)
  for (const { slotId, pieceId } of job.entries) {
    // Skip pieces that left the slot during the stagger (player undid Z
    // mid-cascade) — their removal already ran the full cleanup once.
    if (pieceBySlot.get(slotId) !== pieceId) continue
    pieceBySlot.delete(slotId)
    slotByPiece.delete(pieceId)
    diedAtMs.set(slotId, now())
    for (const listener of listeners) listener(pieceId, slotId, job.ring)
  }
  touchWorld()
}

/** True while at least one collapse ring is still scheduled (QA probe). */
export function hasPendingCollapse(): boolean {
  return pendingRings.length > 0
}

/** Fire every scheduled ring NOW, in cascade order — deterministic tests
 * and the Esc teardown (nothing may land after the session closed). */
export function flushCollapse(): void {
  pendingRings.sort((a, b) => a.at - b.at)
  while (pendingRings.length > 0) {
    const job = pendingRings[0]!
    clearTimeout(job.timer)
    fireRing(job) // splices itself out of pendingRings
  }
}

// --- Piece-as-unit death (SUPPORT-STRICT, phase 9) ----------------------------

/** A placed piece's voxel replica is structurally DEAD once fewer than this
 * fraction of its cells survive. The old rule (dead only at aliveCount 0)
 * let ONE surviving corner voxel hold a whole column of pieces up — the
 * genre reads pieces as units: shot past ~85%, the piece bursts and its
 * dependents cascade. 15% chosen over a contact-band scan because
 * aliveCount/count already sit on every grid (zero extra state, no
 * per-voxel loop on the hot carve path) and the fraction reads the same
 * for every piece shape/mask. Stays comfortably above the walk-only plank
 * demotion (12% DAMAGE ≡ 88% alive), so planks always demote long before
 * they die. */
export const PIECE_DEAD_ALIVE_FRACTION = 0.15

/** True when a piece replica with `aliveCount` live cells of `count` total
 * should be treated as REMOVED — destruction.settleSupportAfterRemoval
 * gates the full undo cleanup (store removal → collider splice + dropTarget
 * → onPieceRemoved cascade) on this instead of aliveCount === 0. Pure;
 * degenerate zero-cell grids are dead by definition. */
export function pieceReplicaDead(aliveCount: number, count: number): boolean {
  return aliveCount <= 0 || aliveCount < count * PIECE_DEAD_ALIVE_FRACTION
}

// --- Died-slot lockout (turbo) ----------------------------------------------

/** Timestamp (ms, performance.now clock) of the last piece death in this
 * slot; 0 when no piece ever died there. */
export function diedAt(slotId: SlotId): number {
  return diedAtMs.get(slotId) ?? 0
}

/** True while the slot is inside the DIED_SLOT_LOCKOUT_MS window — turbo
 * must not re-place here yet. Pass `nowMs` to test without sleeping. */
export function isDeathLocked(slotId: SlotId, nowMs: number = now()): boolean {
  const died = diedAtMs.get(slotId)
  return died !== undefined && nowMs - died < DIED_SLOT_LOCKOUT_MS
}

// --- Lifecycle ---------------------------------------------------------------

/** Session teardown: cancel pending rings WITHOUT firing (the store resets
 * on its own), forget every mapping, stamp, cache, listener, and probe. */
export function resetPieceSlots(): void {
  for (const job of pendingRings) clearTimeout(job.timer)
  pendingRings.length = 0
  pieceBySlot.clear()
  slotByPiece.clear()
  diedAtMs.clear()
  probeCache.clear()
  candidateCache.clear()
  listeners.clear()
  sceneProbe = null
  graph.clear()
}
