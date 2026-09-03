/**
 * shared-build.ts — the BUILD LANE's half of the convergent world.
 *
 * shared-world.ts holds the model (OR-Sets of pieces, items, apertures and
 * paint strokes) and shared-derive.ts the projections over it. Neither knows
 * this game exists. This module is the seam: it publishes what THIS player
 * builds into those record lanes, and it turns records that arrive from
 * elsewhere into pieces, furniture, openings and paint the player can see,
 * walk on, shoot and paint over.
 *
 * WHAT THIS MODULE IS RESPONSIBLE FOR, precisely:
 *
 *   1. MINT. Every local build becomes a record, quantized on mint (the
 *      shared-world addLocal* helpers do the quantizing — that is where the
 *      lattice lives, and doing it anywhere else would make the author and
 *      its receivers disagree about a record's canonical string).
 *   2. RECONCILE. The runtime stores are the truth for what the player did;
 *      the record set follows them. `reconcileSharedPieces` diffs
 *      `useBoots.placed` against the records it has minted — appearances
 *      publish, edits re-mint (an F-edit REPLACES a piece: tombstone + new
 *      record, because a record is immutable once published), disappearances
 *      tombstone. One diff covers every removal path there is (U undo, the
 *      support cascade, a voxel replica dying, the registry refusing a
 *      claim) without a hook at each site.
 *   3. ELECT. Two players can claim one slot in the same tick and both
 *      records are legitimate. `electSlots` names the winner identically on
 *      every client; the loser is REMOVED FROM THE RUNTIME and its owner is
 *      TOLD (hud.presenceToast) instead of watching a wall evaporate.
 *   4. APPLY. Remote records become real: pieces through the slot registry
 *      (so they support, collapse and voxelize exactly like local ones),
 *      items and apertures through the catalog stores, paint through
 *      `foldCoats` — folded, never replayed, so a late joiner's coats land
 *      where a client who watched them land already has them.
 *   5. ATTRIBUTE. Every runtime object it installs is remembered as FOREIGN,
 *      and that is what keeps a stranger's build out of this player's Save
 *      (keep.ts / item-keep.ts / paint-keep.ts ask their own lane module,
 *      which asks here — a Save bridge may not import a shared module for
 *      anything but `localWork`, and that fence is a test).
 *
 * WHAT IT DELIBERATELY IS NOT:
 *
 *   - NOT a transport. It imports nothing from net.ts and knows no peer
 *     roster. Outgoing frames go to an injected sink (`setBuildSyncSink`)
 *     and incoming ones arrive through `receiveBuildDelta`, which is also
 *     how the tests drive the whole lane with no network at all.
 *   - NOT a scene writer. Nothing here can reach `useScene`; play never
 *     writes the host document (shared-invariant.test.ts asserts it with the
 *     sentinel armed, and this module is in that storm).
 *   - NOT ALWAYS ON. With no world attached, every entry point returns
 *     immediately and the game behaves exactly as it did before sync
 *     existed. That is the property `shared-build.test.ts` pins: with sync
 *     off, the stores, the slot registry, the paint ledger and the Save
 *     bridges are byte-identical to single-player.
 *
 * THE PIECE LANE IS HANDLED HERE, THE OTHER TWO HAND US AN APPLIER. Placed
 * pieces live in the root store (`useBoots.placed`) and their pose comes from
 * grid.ts, so this module can own that lane outright. Items and paint keep
 * their state module-private inside item-place.tsx and paint.tsx, so those
 * two install an applier at mount (`setBuildAppliers`) — which also keeps the
 * import graph a tree instead of a cycle.
 */

import { useBoots, type BuildPiece, type PlacedPiece } from '../store'
import { parseSlotId, slotPose } from './grid'
import { onPieceRemoved, registerPlacement } from './piece-slots'
import { canonicalRecordOrder, electSlots, gridStamp } from './shared-derive'
import {
  addLocalAperture,
  addLocalItem,
  addLocalPiece,
  addLocalStroke,
  type ApertureRec,
  emptyDelta,
  emptyEffects,
  isOurs,
  type ItemRec,
  killRecord,
  liveRecords,
  mergeDelta,
  type PeerId,
  type PieceRec,
  type RecordId,
  setGridStamp,
  type SharedDelta,
  type SharedEffects,
  type SharedWorld,
  type StrokeRec,
} from './shared-world'

// ── The appliers the two store-owning lanes install ──────────────────────────

/**
 * What item-place.tsx and paint.tsx hand us at mount. Each returns the
 * runtime id it created (so removals can find it again) or null when it
 * could not make the thing — an unknown catalog id, a wall this client does
 * not have, a node with no voxel grid to coat.
 */
export type BuildAppliers = {
  /** Spawn a remote catalog item; null = catalog lookup failed. */
  spawnItem?: (rec: ItemRec) => number | null
  /** Spawn a remote door/window stand-in; null = unknown opening or wall. */
  spawnAperture?: (rec: ApertureRec) => number | null
  /** Drop a placement this module previously spawned. */
  removePlacement?: (runtimeId: number) => void
  /**
   * Fold remote strokes into the local coat ledger (paint.tsx owns it), and
   * hand back the ones whose SURFACE was not here yet — see pendingStrokes.
   */
  foldStrokes?: (strokes: readonly StrokeRec[]) => readonly StrokeRec[] | void
}

let appliers: BuildAppliers = {}

/**
 * STROKES THAT ARRIVED BEFORE THE WALL THEY LANDED ON.
 *
 * A stroke is grid-free, so a joiner accepts it whatever lot it thinks it is
 * standing on; a PIECE is slot-addressed, so the same frame's walls can be
 * refused (a stale grid stamp) or simply not have arrived yet. The record is
 * consumed either way — records are grow-only and a re-delivery is idempotent —
 * so without this list the coat on a player-built wall was dropped for the rest
 * of the session. Two-client QA read it as `foldUnnamed 1` on the latecomer with
 * the wall standing right there (2026-09-01).
 *
 * A piece INSTALL re-offers the list, but that event alone is not enough: the
 * install is a store write, and the wall is only paintable once its mesh exists
 * and has been voxelized, a frame or more later. QA read exactly that — the
 * latecomer retried on the install and reported `foldNoTarget`, with the wall
 * standing. So the paint lane also drains the list on a heartbeat
 * (drainPendingStrokes). Capped, newest-wins — a name that never resolves (a
 * piece deleted before we joined) must not accumulate.
 */
const pendingStrokes: StrokeRec[] = []
const PENDING_STROKE_CAP = 512

/**
 * WHERE A WAITING STROKE WENT — the ledger of the ledger.
 *
 * A record is grow-only and delivered once, so anything that loses one loses a
 * coat for the whole session. QA read `foldNoTarget 1` with `pendingStrokes 0`
 * and nothing painted, which is a record that vanished between the two — a
 * bookkeeping question no coat census can answer. `landed + kept + cleared +
 * noApplier` must account for `offered`.
 */
const strokeAudit = {
  offered: 0,
  landed: 0,
  kept: 0,
  cleared: 0,
  drains: 0,
  noApplier: 0,
  refolds: 0,
}

/** Fold `records` plus everything still waiting, and keep what did not land. */
function foldWithPending(records: readonly StrokeRec[]): void {
  const fold = appliers.foldStrokes
  if (!fold) {
    strokeAudit.noApplier += records.length
    return
  }
  // ONE COPY OF EACH RECORD. A rebuild (refoldSharedStrokes) offers the room's
  // whole stroke set, which can already hold what is waiting here — and folding
  // one record twice would deposit two coats' worth of strength.
  const batch = dedupeById(records.length === 0 ? pendingStrokes : [...pendingStrokes, ...records])
  if (batch.length === 0) return
  pendingStrokes.length = 0
  strokeAudit.offered += records.length
  const unplaced = fold(batch)
  strokeAudit.landed += batch.length - (unplaced?.length ?? 0)
  for (const rec of unplaced ?? []) {
    if (pendingStrokes.length >= PENDING_STROKE_CAP) pendingStrokes.shift()
    pendingStrokes.push(rec)
  }
  // `kept` is the CURRENT wait list, so it has to be written on the empty path
  // too: reporting the last non-zero length made a drained queue read as if it
  // were still holding coats nobody had seen (QA run 2: landed 2, kept 2).
  strokeAudit.kept = pendingStrokes.length
}

/** The same records, one copy each, first occurrence wins. */
function dedupeById(records: readonly StrokeRec[]): StrokeRec[] {
  const seen = new Set<string>()
  const out: StrokeRec[] = []
  for (const rec of records) {
    if (seen.has(rec.id)) continue
    seen.add(rec.id)
    out.push(rec)
  }
  return out
}

/**
 * REBUILD THE COAT LEDGER FROM THE RECORDS THE ROOM ALREADY HOLDS.
 *
 * The paint ledger is derived state and the records are the truth — the world
 * keeps every live stroke, grow-only, forever. But delivery happens once: a
 * ledger wiped after a record arrived could never get it back, and QA caught
 * exactly that (`paintMounts 2` on a joiner — the tool's mount effect resets the
 * ledger, and a second mount threw away coats that had already folded, which is
 * the owner's "others couldn't see my constructions" in its paint form).
 *
 * So the paint lane asks for a rebuild whenever it installs its applier. Folding
 * is idempotent by construction (canonical order, accumulate-or-restart), so a
 * rebuild over a ledger that is already right is a no-op, not a double coat.
 */
export function refoldSharedStrokes(): void {
  const s = sync
  if (!s || !appliers.foldStrokes) return
  const all = liveRecords(s.world.strokes)
  if (all.length === 0) return
  strokeAudit.refolds++
  foldWithPending(all)
}

/**
 * Is this record one THIS player published? The paint lane needs it per record,
 * because a rebuild re-folds our own strokes alongside everyone else's and only
 * the foreign ones may be marked as somebody else's work (that mark is what
 * keeps a stranger's paint out of our Save).
 */
export function isOurRecord(id: RecordId): boolean {
  return sync !== null && isOurs(sync.world, id)
}

/**
 * Re-offer the waiting strokes — the paint lane's heartbeat, a few times a
 * second while the list is not empty. Free when it is: nothing is touched, and
 * a record that lands is gone from the list for good.
 */
export function drainPendingStrokes(): void {
  if (pendingStrokes.length === 0) return
  strokeAudit.drains++
  foldWithPending([])
}

/** Install (or clear, with `{}`) the lane appliers. Mount/unmount paired. */
export function setBuildAppliers(patch: BuildAppliers): void {
  appliers = { ...appliers, ...patch }
}

/** Forget every applier — session teardown, and the test reset. */
export function clearBuildAppliers(): void {
  appliers = {}
}

// ── Session state ───────────────────────────────────────────────────────────

/** Where outgoing frames go. The transport installs one; tests capture it. */
export type DeltaSink = (delta: SharedDelta) => void
/** One short line for the player. Defaults to the HUD presence toast. */
export type NoticeSink = (text: string) => void

type BuildSync = {
  world: SharedWorld
  sink: DeltaSink | null
  /** Records accumulated since the last flush (one frame's worth). */
  pending: SharedDelta | null
}

let sync: BuildSync | null = null

/**
 * Where a player-facing line goes. MODULE-LEVEL, not part of the session,
 * for two reasons: it must survive attach/detach ordering (the HUD is mounted
 * by the game, the world arrives from the transport, and neither waits for the
 * other), and keeping session.ts out of this module's imports avoids a cycle
 * through paint-keep. builder.tsx installs the HUD one; a test installs its
 * own. Null = the lane says nothing, which is the single-player case.
 */
let noticeSink: NoticeSink | null = null

/**
 * THE GATE. Every call site in builder.tsx, item-place.tsx and paint.tsx
 * starts with this, and every function here re-checks it. False = the game
 * is single-player and not one line of this module runs.
 */
export function buildSyncOn(): boolean {
  return sync !== null
}

/** The attached world, or null. Read-only convenience for the lane modules
 * and the QA handle; nobody outside may mutate it. */
export function buildSyncWorld(): SharedWorld | null {
  return sync?.world ?? null
}

/**
 * Turn the build lane on against `world`. The copresence layer calls this
 * when it has a shared world for the session; a test calls it with a world
 * it made itself and drives everything through `receiveBuildDelta`.
 */
export function attachBuildSync(
  world: SharedWorld,
  opts?: { sink?: DeltaSink; notice?: NoticeSink },
): void {
  sync = { world, sink: opts?.sink ?? null, pending: null }
  if (opts?.notice) noticeSink = opts.notice
  resetBindings()
  // THE GRID FRAME IS A RETAINED FACT, so attaching late cannot lose it. See
  // `publishGridStamp` for the production bug this line exists to close.
  if (gridFrame) {
    setGridStamp(world, gridStamp(gridFrame.x, gridFrame.z, gridFrame.yaw, gridFrame.ys))
    gridStampPublishes++
  }
}

/** Turn it off and forget every binding (session exit). The world itself is
 * not reset — its owner decides that (resetSharedWorld keeps the peer id). */
export function detachBuildSync(): void {
  sync = null
  resetBindings()
  // A waiting stroke names a record from THIS room; it must not follow us into
  // the next one.
  strokeAudit.cleared += pendingStrokes.length
  pendingStrokes.length = 0
}

export function setBuildSyncSink(sink: DeltaSink | null): void {
  if (sync) sync.sink = sink
}

export function setBuildSyncNotice(notice: NoticeSink | null): void {
  noticeSink = notice
}

function say(text: string): void {
  noticeSink?.(text)
}

/**
 * THE BUILD GRID'S FINGERPRINT — A RETAINED FACT, NOT A ONE-SHOT PUBLISH.
 *
 * Slot ids are addresses RELATIVE to grid.ts's module anchor (point AND
 * rotation) and storey ladder, so a peer whose stamp differs is speaking a
 * different coordinate system and mergeDelta refuses its slot-addressed pieces
 * (raising `refusedGrid`, which we surface as a line the player can read).
 * PlacedPieces calls this from the effect that installs the anchor, which is the
 * only moment the frame changes.
 *
 * IT USED TO NO-OP WHEN THE LANE WAS NOT ATTACHED YET, AND THAT WAS THE BUG.
 * React runs a CHILD component's effect before its parent's, and the parent
 * (ActiveGame) is the one that calls startWorldSync() → attachBuildSync. So the
 * publish ALWAYS lost that race. The only thing that ever saved it was
 * StrictMode's double-invoke of effects — which happens in DEVELOPMENT ONLY. In
 * a production build `world.gridStamp` stayed 0 for the entire session, and the
 * grid gate reads
 *
 *     slotsOk = delta.gridStamp !== 0 && delta.gridStamp === world.gridStamp
 *
 * so BOTH directions failed: our outbound deltas carried stamp 0 and every peer
 * refused them, and every inbound stamp mismatched our 0 and we refused theirs.
 * A total, silent, bidirectional refusal of the pieces lane — walls, floors and
 * slopes invisible to everyone, while grid-free damage kept landing. Reported
 * live on 2026-09-01 as "others couldn't see my constructions / only some
 * destructions", which is this file's own documented symptom almost word for
 * word (see net-world.ts's `identityHeld`), reached by a second road.
 *
 * The fix is to stop treating it as an event. The frame is a fact about the
 * running game, so it is HELD here across attach/detach and `attachBuildSync`
 * republishes it. Mount order stops mattering in either direction, and a session
 * that attaches its transport ten seconds late still speaks the right grid.
 */
type GridFrame = { x: number; z: number; yaw: number; ys: readonly number[] }
let gridFrame: GridFrame | null = null
/** How many times a stamp reached a world (QA: 0 means the frame never landed). */
let gridStampPublishes = 0
/** The last stamp published, to tell a re-publish of the SAME frame (mount
 * churn, a re-collect that derived the same lot) from a real change of lot. */
let lastStamp = 0
let stampChanged: (() => void) | null = null

/**
 * Called when the published stamp names a DIFFERENT lot than the last one —
 * i.e. the session re-anchored (entry-settle.ts corrected a snapshot taken
 * before the scene finished arriving).
 *
 * WHY THE WIRE HAS TO HEAR ABOUT IT. Everything the room sent us while our
 * stamp was wrong was refused by the grid gate, and a refusal leaves no trace
 * for a retry to find: nothing is marked seen, so the records simply are not
 * here. They come back on the next heal snapshot — up to HEAL_PERIOD_MS later.
 * The owner's requirement is "streamed to everyone live with as little latency
 * as possible", so net-world uses this to ask the room again immediately, and
 * to re-offer our own records under the corrected stamp (peers refused those
 * too, symmetrically). Bounded by the settle watcher's re-anchor cap.
 */
export function onGridStampChange(cb: (() => void) | null): void {
  stampChanged = cb
}

export function publishGridStamp(
  anchorX: number,
  anchorZ: number,
  anchorYaw: number,
  storeyYs: readonly number[],
): number {
  // Retained BEFORE the attach check: the whole point is that it survives the
  // window in which there is nothing to publish to.
  gridFrame = { x: anchorX, z: anchorZ, yaw: anchorYaw, ys: [...storeyYs] }
  const stamp = gridStamp(anchorX, anchorZ, anchorYaw, storeyYs)
  if (sync) {
    setGridStamp(sync.world, stamp)
    gridStampPublishes++
  }
  const moved = lastStamp !== 0 && stamp !== lastStamp
  lastStamp = stamp
  // After the world knows, never before: the listener re-offers our records and
  // they must go out stamped with the lot we just adopted.
  if (moved) stampChanged?.()
  return stamp
}

/**
 * Forget the retained frame — PlacedPieces' cleanup, i.e. session teardown or a
 * change of building. Deliberately NOT called by `detachBuildSync`: the frame
 * belongs to the game's piece tree, not to the transport, and the transport
 * attaching and detaching mid-session must not lose it.
 */
export function forgetGridStamp(): void {
  gridFrame = null
  // The NEXT session's first publish is not a change of lot, it is a first
  // frame — leaving this set would have it ask the room to re-send at entry,
  // when it is already asking.
  lastStamp = 0
}

// ── Registries (authorship, and runtime ↔ record) ────────────────────────────

/** PlacedPiece.id → the record that piece IS. */
const pieceRecord = new Map<number, RecordId>()
/** …and back, so an arriving tombstone can find the runtime piece. */
const pieceRuntime = new Map<RecordId, number>()
/** Runtime pieces this client did not author. Save skips them. */
const foreignPieces = new Set<number>()
/**
 * What we last published about a runtime piece, so an F-edit is detected as
 * a change rather than re-published every frame.
 */
const piecePublished = new Map<number, string>()
/**
 * Records that LOST their slot to a canonically-later claim. Permanently
 * excluded from installation: the contract's rule is that a deposed piece
 * never comes back, not even if the winner is later destroyed (a slot going
 * empty is exactly what happens in single-player when a wall dies, and a
 * zombie wall popping into a hole nobody dug is worse than an empty slot).
 * Every client computes this set from the same records by the same rule.
 */
const deposedPieces = new Set<RecordId>()

/** useItems id → record, for both furniture and openings. */
const placementRecord = new Map<number, RecordId>()
const placementRuntime = new Map<RecordId, number>()
const foreignPlacements = new Set<number>()

/**
 * Drop the record↔runtime bindings. NOT the authorship sets — see below.
 */
function resetBindings(): void {
  pieceRecord.clear()
  pieceRuntime.clear()
  piecePublished.clear()
  deposedPieces.clear()
  placementRecord.clear()
  placementRuntime.clear()
}

/**
 * AUTHORSHIP OUTLIVES THE SESSION, on purpose.
 *
 * The Save bridges do not run during play — the panel offers its decision back
 * in the editor, after the session has torn down and the shared world has been
 * detached. If detaching forgot who built what, every stranger's wall would
 * read as this player's own work at exactly the moment Save writes the
 * document, which is the one thing that must never happen.
 *
 * Keeping them is safe because runtime ids are monotonic: `placedId` and
 * `itemId` are module counters that never reuse a number, so a stale entry can
 * never be mistaken for a new object. Only a test reset clears them.
 */
function resetAttribution(): void {
  foreignPieces.clear()
  foreignPlacements.clear()
}

/**
 * Is this placed piece somebody else's?
 *
 * Deliberately NOT gated on `buildSyncOn()`: Save runs after the session has
 * torn down and the world has been detached, and the answer has to still be
 * right then (see resetAttribution). Nothing is ever foreign in single-player,
 * so that path is untouched. keep.ts reaches this through builder.tsx — a Save
 * bridge may not import a shared module for anything but localWork, and
 * shared-invariant.test.ts enforces it.
 */
export function isForeignPiece(runtimeId: number): boolean {
  return foreignPieces.has(runtimeId)
}

/** Is this catalog placement somebody else's? */
export function isForeignPlacement(runtimeId: number): boolean {
  return foreignPlacements.has(runtimeId)
}

/** The record a placed piece was published as, if any (QA + tests). */
export function pieceRecordOf(runtimeId: number): RecordId | null {
  return pieceRecord.get(runtimeId) ?? null
}

/**
 * The same lookup for a placed catalog item or opening, BOTH DIRECTIONS.
 *
 * The damage lane needs both. A placed item is destructible — destruction.ts
 * keeps items out of PREVOXELIZATION only, and voxelizes them on their first
 * hit — and `__boots-item-<n>` is minted from a per-client counter, so a
 * player shooting a sofa can only tell anyone about it under the record id
 * (shared-world's itemTargetId). Inbound, the reverse is needed to find which
 * sofa in THIS scene a record names.
 *
 * Exported as a pair of lookups rather than the maps themselves so the
 * bindings stay private and nothing outside can bind, unbind or iterate them.
 */
export function placementRecordOf(runtimeId: number): RecordId | null {
  return placementRecord.get(runtimeId) ?? null
}

/** Record → this client's runtime id for that item/opening, if it has one. */
export function placementRuntimeOf(id: RecordId): number | null {
  return placementRuntime.get(id) ?? null
}

// ── Outgoing frames ─────────────────────────────────────────────────────────

function outgoing(): SharedDelta {
  const s = sync!
  if (!s.pending) s.pending = emptyDelta(s.world.self)
  s.pending.gridStamp = s.world.gridStamp
  s.pending.lamport = s.world.clock
  return s.pending
}

/**
 * Hand the accumulated records to the sink. Called at the end of every publish
 * path, so a turbo burst that stamped six walls in one frame leaves as one
 * frame. With no sink installed the records simply stay in the local world,
 * which is all the Save path and the tests need.
 *
 * EXACTLY ONE OUTBOUND PATH AT A TIME. `addLocalPiece`/`killRecord` and their
 * lane siblings also journal into `world.journal`, which the transport drains
 * with `takePending(world)` once per tick — so a transport that drains the
 * journal must NOT also install a sink here, or every record this client
 * builds goes out twice (idempotent on the receiving side, but double the
 * bytes on a bus that coalesces). The sink is for a transport that would
 * rather be pushed, and for the tests, which read the frames it hands over.
 */
export function flushBuildSync(): void {
  const s = sync
  if (!s || !s.pending) return
  const delta = s.pending
  s.pending = null
  delta.lamport = s.world.clock
  delta.gridStamp = s.world.gridStamp
  s.sink?.(delta)
}

// ── The piece lane: publish ─────────────────────────────────────────────────

/** The fields of a placed piece that a record carries — the change key. */
function pieceFingerprint(p: PlacedPiece): string {
  const corners = p.corners ? p.corners.join(',') : '-'
  return `${p.piece}|${p.slotId ?? ''}|${p.mask}|${p.yaw}|${p.height ?? 0}|${corners}`
}

function bindPiece(runtimeId: number, id: RecordId, foreign: boolean): void {
  pieceRecord.set(runtimeId, id)
  pieceRuntime.set(id, runtimeId)
  if (foreign) foreignPieces.add(runtimeId)
}

function unbindPiece(runtimeId: number): RecordId | null {
  const id = pieceRecord.get(runtimeId) ?? null
  pieceRecord.delete(runtimeId)
  piecePublished.delete(runtimeId)
  foreignPieces.delete(runtimeId)
  if (id !== null) pieceRuntime.delete(id)
  return id
}

function mintPiece(p: PlacedPiece): PieceRec | null {
  const s = sync!
  // Legacy pieces carry no slot. A record without one has no address any
  // other client could resolve, so it stays local-only (it still renders,
  // still collides, still saves — it is simply not shared).
  if (!p.slotId) return null
  const rec = addLocalPiece(s.world, {
    kind: p.piece,
    slot: p.slotId,
    mask: p.mask,
    yaw: p.yaw,
    height: p.height ?? 0,
    corners: p.corners ?? null,
  })
  if (!rec) return null
  bindPiece(p.id, rec.id, false)
  piecePublished.set(p.id, pieceFingerprint(p))
  outgoing().pieces.push(rec)
  return rec
}

function tombstonePiece(runtimeId: number): void {
  const s = sync!
  const id = unbindPiece(runtimeId)
  if (id === null) return
  if (killRecord(s.world, 'pieces', id)) outgoing().deadPieces.push(id)
}

/** Re-entrancy guard: installing pieces writes the store, which re-runs the
 * effect that called us. The second pass is a no-op, but the guard keeps the
 * first one from tripping over its own writes. */
let reconciling = false

/**
 * Diff the placed-piece store against what we have published, then install
 * whatever the election says should be standing. Called from PlacedPieces on
 * every change to `useBoots.placed` (and once when the grid is installed),
 * which is every path that can add, edit or remove a piece.
 */
export function reconcileSharedPieces(): void {
  const s = sync
  if (!s || reconciling) return
  reconciling = true
  try {
    const placed = useBoots.getState().placed
    const alive = new Set<number>()
    for (const p of placed) {
      alive.add(p.id)
      if (foreignPieces.has(p.id)) continue // somebody else's — never ours to publish
      const known = pieceRecord.get(p.id)
      if (known === undefined) {
        mintPiece(p)
        continue
      }
      // An F-edit (mask, corners) or an exit transform (kind, yaw) REPLACES
      // the piece: records are immutable, so the old one is tombstoned and a
      // new one minted. Both peers see the carve, and the slot claim moves
      // with it (the new record has a later lamport, so it wins its own
      // slot outright).
      if (piecePublished.get(p.id) !== pieceFingerprint(p)) {
        tombstonePiece(p.id)
        mintPiece(p)
      }
    }
    // Gone from the store = gone from the world. Undo, the support cascade, a
    // replica shot to bits and the registry's rollback all land here.
    for (const runtimeId of [...pieceRecord.keys()]) {
      if (alive.has(runtimeId)) continue
      if (foreignPieces.has(runtimeId)) {
        unbindPiece(runtimeId) // theirs: our screen lost it, their record stands
        continue
      }
      tombstonePiece(runtimeId)
    }
    installPieces()
    flushBuildSync()
  } finally {
    reconciling = false
  }
}

/**
 * Save/Discard resolved the pending placements: the store is cleared, but the
 * records must SURVIVE. On this screen the game pieces become real scene
 * walls; on every other screen they are still the walls they always were,
 * and tombstoning them would delete a peer's view of a building that very
 * much still exists. So we forget the bindings instead — the reconcile above
 * must not read the now-empty store as a demolition.
 */
export function forgetSharedPieces(): void {
  if (!sync) return
  for (const runtimeId of [...pieceRecord.keys()]) {
    if (foreignPieces.has(runtimeId)) continue
    unbindPiece(runtimeId)
  }
}

// ── The piece lane: elect and install ───────────────────────────────────────

/**
 * One piece per slot, agreed by everyone.
 *
 * `electSlots` keys winners by SLOT ID, which is the same unit of exclusion
 * piece-slots.ts enforces (`pieceBySlot`, one piece per slot id, and a floor
 * and a stair share the `F:` addresses), so the election needs no narrowing
 * here: every winner it returns is a placement the registry will accept.
 * `deposedPieces` is the memory that keeps a loser from coming back, and the
 * install order stays canonical so two clients walk the same list.
 */
function electedPieces(): { desired: Map<RecordId, PieceRec>; losers: PieceRec[] } {
  const s = sync!
  const { winners, losers } = electSlots(liveRecords(s.world.pieces))
  const desired = new Map<RecordId, PieceRec>()
  for (const rec of canonicalRecordOrder([...winners.values()])) {
    if (deposedPieces.has(rec.id)) continue // lost once, gone for good
    desired.set(rec.id, rec)
  }
  return { desired, losers }
}

/** Human name for a piece kind, for the one line the loser gets to read. */
const PIECE_NOUN: Record<BuildPiece, string> = {
  wall: 'wall',
  floor: 'floor',
  stairs: 'stairs',
  roof: 'roof',
}

/**
 * Bring the runtime in line with the election: uninstall anything standing
 * that should not be, then install everything that should be and is not.
 * Order matters — the slot registry holds one piece per slot, so the loser
 * must leave before the winner can claim.
 */
function installPieces(): void {
  const s = sync!
  const { desired, losers } = electedPieces()

  for (const rec of losers) deposedPieces.add(rec.id)

  for (const [id, runtimeId] of [...pieceRuntime]) {
    if (desired.has(id)) continue
    // THE PLAYER'S QUESTION, NOT THE WIRE'S. `isOurs` spans the names this tab
    // has published under, because the human who built this wall is the same
    // human after the host re-keys their session — and they are the one the
    // notice below is for. Asking `isAuthoredBy(id, world.self)` here would go
    // quiet the moment we were renamed, so a wall built before the rename could
    // be deposed by a stranger and vanish without a word. The wire's narrow
    // question stays where it belongs: mergeDelta vouches for a frame by its
    // envelope sender, and this module never second-guesses it.
    const mine = isOurs(s.world, id)
    const piece = useBoots.getState().placed.find((p) => p.id === runtimeId)
    unbindPiece(runtimeId)
    if (piece) {
      useBoots.getState().removePlaced(runtimeId)
      if (piece.slotId) onPieceRemoved(piece.slotId)
      // THE LOSER IS TOLD. Silently deleting a wall the player just built is
      // the one outcome this whole election exists to avoid.
      if (mine && deposedPieces.has(id)) {
        say(`Another builder claimed that ${PIECE_NOUN[piece.piece]} slot`)
      }
    }
  }

  for (const rec of desired.values()) {
    if (pieceRuntime.has(rec.id)) continue
    // Our own records are bound at mint. One that is not bound any more was
    // resolved into the document by Save (forgetSharedPieces) — re-spawning
    // it would double the wall the player just saved. `isOurs`, not
    // `isAuthoredBy`: a rename must not turn our own released work into a
    // stranger's wall standing on top of the one we just made real.
    if (isOurs(s.world, rec.id)) continue
    spawnRemotePiece(rec)
  }
}

/**
 * Materialize one remote piece. The pose is DERIVED from the slot, not
 * replicated: `slotPose` is pure and both clients hold the same anchor (that
 * is exactly what the grid stamp guarantees), so the piece lands to the
 * millimetre without a single coordinate on the wire. Only the yaw travels,
 * because a stair's ascent quarter and a wall's flip are choices, not
 * geometry.
 */
function spawnRemotePiece(rec: PieceRec): number | null {
  const slot = parseSlotId(rec.slot)
  if (!slot) return null
  const pose = slotPose(slot)
  const stored = useBoots.getState().addPlaced({
    piece: rec.kind,
    position: [pose.position[0], pose.position[1], pose.position[2]],
    yaw: rec.yaw,
    slotId: rec.slot,
    mask: rec.mask,
    ...(rec.height > 0 ? { height: rec.height } : {}),
    ...(rec.corners
      ? {
          corners: [rec.corners[0], rec.corners[1], rec.corners[2], rec.corners[3]] satisfies [
            number,
            number,
            number,
            number,
          ],
        }
      : {}),
  })
  // The registry is the single occupancy authority and it wins: if it refuses
  // (a local piece still holds the slot this frame), roll the append back and
  // leave the record alone — the next reconcile tries again.
  if (!registerPlacement(rec.slot, stored.id)) {
    useBoots.getState().removePlaced(stored.id)
    return null
  }
  bindPiece(stored.id, rec.id, true)
  return stored.id
}

// ── The item + aperture lanes: publish ──────────────────────────────────────

function bindPlacement(runtimeId: number, id: RecordId, foreign: boolean): void {
  placementRecord.set(runtimeId, id)
  placementRuntime.set(id, runtimeId)
  if (foreign) foreignPlacements.add(runtimeId)
}

function unbindPlacement(runtimeId: number): RecordId | null {
  const id = placementRecord.get(runtimeId) ?? null
  placementRecord.delete(runtimeId)
  foreignPlacements.delete(runtimeId)
  if (id !== null) placementRuntime.delete(id)
  return id
}

/** Publish a locally dropped catalog item. */
export function publishItem(
  runtimeId: number,
  catalogId: string,
  position: readonly [number, number, number],
  yaw: number,
): RecordId | null {
  const s = sync
  if (!s || placementRecord.has(runtimeId)) return null
  const rec = addLocalItem(s.world, {
    catalogId,
    x: position[0],
    y: position[1],
    z: position[2],
    yaw,
  })
  if (!rec) return null
  bindPlacement(runtimeId, rec.id, false)
  outgoing().items.push(rec)
  flushBuildSync()
  return rec.id
}

/**
 * Replace a placed item's immutable shared record while keeping its runtime
 * identity. This is the L-to-move path: peers receive the old tombstone and
 * the new grounded pose in one flushed delta, so nobody observes a private
 * local teleport.
 */
export function moveSharedItem(
  runtimeId: number,
  catalogId: string,
  position: readonly [number, number, number],
  yaw: number,
): RecordId | null {
  const s = sync
  if (!s) return null
  const next = addLocalItem(s.world, {
    catalogId,
    x: position[0],
    y: position[1],
    z: position[2],
    yaw,
  })
  if (!next) return null
  const previous = unbindPlacement(runtimeId)
  if (previous !== null && killRecord(s.world, 'items', previous)) {
    outgoing().deadItems.push(previous)
  }
  bindPlacement(runtimeId, next.id, false)
  outgoing().items.push(next)
  flushBuildSync()
  return next.id
}

/** Publish a locally placed door/window. Host-relative by construction, so
 * it survives a peer whose grid anchor differs entirely. */
export function publishAperture(
  runtimeId: number,
  catalogId: string,
  host: string,
  u: number,
  v: number,
  width: number,
  height: number,
): RecordId | null {
  const s = sync
  if (!s || placementRecord.has(runtimeId)) return null
  const rec = addLocalAperture(s.world, { catalogId, host, u, v, width, height })
  if (!rec) return null
  bindPlacement(runtimeId, rec.id, false)
  outgoing().apertures.push(rec)
  flushBuildSync()
  return rec.id
}

/**
 * Save/Discard resolved the catalog placements — same reasoning as
 * forgetSharedPieces: the records outlive this screen's stand-ins.
 */
export function forgetSharedPlacements(): void {
  if (!sync) return
  for (const runtimeId of [...placementRecord.keys()]) {
    if (foreignPlacements.has(runtimeId)) continue
    unbindPlacement(runtimeId)
  }
}

// ── A rename's unsent work ──────────────────────────────────────────────────

/**
 * Move a runtime piece's binding onto a new record without disturbing anything
 * else about it. NOT unbind+bind: `unbindPiece` drops the published
 * fingerprint, and reconcile reads a missing fingerprint as an F-edit and
 * replaces the record we just minted.
 */
function rebindPiece(runtimeId: number, oldId: RecordId, newId: RecordId): void {
  pieceRecord.set(runtimeId, newId)
  pieceRuntime.delete(oldId)
  pieceRuntime.set(newId, runtimeId)
}

function rebindPlacement(runtimeId: number, oldId: RecordId, newId: RecordId): void {
  placementRecord.set(runtimeId, newId)
  placementRuntime.delete(oldId)
  placementRuntime.set(newId, runtimeId)
}

/**
 * Re-publish work whose record names an author no peer will vouch for again.
 *
 * `rekeySharedWorld` renames a live session in place, and returns the ids of
 * adds that were still in the journal when the rename landed. Those records
 * are the one thing a rename cannot save by itself: no peer has them yet, and
 * every peer will refuse them now that our envelope says a different name. The
 * model will not rewrite their ids because it does not know what the runtime
 * bound them to. This map does, so this is where that work gets a name that
 * will be honoured — the transport calls it after the rename and before it
 * queues the snapshot, so the re-mints travel in the same breath.
 *
 * THE RULES THIS KEEPS, all four of them load-bearing:
 *
 * - It does not publish. The new adds land in `world.journal` via `addLocal*`
 *   and the transport's tick drains them. Pushing them into `outgoing()` as
 *   well would send every record twice on a bus that coalesces.
 * - It does not throw. This runs inside the transport's tick, where a throw
 *   would skip the snapshot that carries the re-mints out. A record that
 *   cannot be re-minted costs itself and nothing else.
 * - It does not tombstone the old record. Nobody ever saw it, so a kill would
 *   only cost bytes — and for pieces the election collapses the pair anyway
 *   (the new record is canonically later, so it wins; the old one is unbound,
 *   so nothing is uninstalled and nobody is told a slot was taken).
 * - It refuses unbound ids. A record with no runtime object was resolved into
 *   the document by Save or removed by the player; re-publishing it would
 *   resurrect a wall that is either already real or deliberately gone, which
 *   is the one outcome worse than losing an unsent tick of work.
 *
 * Strokes are dropped in silence: a stroke has no runtime object to re-read,
 * only the coat ledger it already folded into.
 *
 * Returns the new ids in input order — `ids.length` minus the result length is
 * the genuinely unrecoverable remainder.
 */
export function remintSharedRecords(ids: readonly RecordId[]): RecordId[] {
  const s = sync
  if (!s || ids.length === 0) return []
  const out: RecordId[] = []
  for (const id of ids) {
    try {
      const next = remintOne(s, id)
      if (next !== null) out.push(next)
    } catch {
      // Contained deliberately — see "It does not throw" above.
    }
  }
  return out
}

function remintOne(s: BuildSync, id: RecordId): RecordId | null {
  const piece = s.world.pieces.adds.get(id)
  if (piece) {
    const runtimeId = pieceRuntime.get(id)
    if (runtimeId === undefined) return null
    const rec = addLocalPiece(s.world, {
      kind: piece.kind,
      slot: piece.slot,
      mask: piece.mask,
      yaw: piece.yaw,
      height: piece.height,
      corners: piece.corners,
    })
    if (!rec) return null
    rebindPiece(runtimeId, id, rec.id)
    return rec.id
  }

  const item = s.world.items.adds.get(id)
  if (item) {
    const runtimeId = placementRuntime.get(id)
    if (runtimeId === undefined) return null
    const rec = addLocalItem(s.world, {
      catalogId: item.catalogId,
      x: item.x,
      y: item.y,
      z: item.z,
      yaw: item.yaw,
    })
    if (!rec) return null
    rebindPlacement(runtimeId, id, rec.id)
    return rec.id
  }

  const aperture = s.world.apertures.adds.get(id)
  if (aperture) {
    const runtimeId = placementRuntime.get(id)
    if (runtimeId === undefined) return null
    const rec = addLocalAperture(s.world, {
      catalogId: aperture.catalogId,
      host: aperture.host,
      u: aperture.u,
      v: aperture.v,
      width: aperture.width,
      height: aperture.height,
    })
    if (!rec) return null
    rebindPlacement(runtimeId, id, rec.id)
    return rec.id
  }

  // A stroke, or an id from a lane we do not own, or nothing at all.
  return null
}

// ── The paint lane: publish ─────────────────────────────────────────────────

/**
 * Publish one spray stamp. `radius` is the COAT radius (paint.tsx's
 * `coatRadiusFor` applied), which is what StrokeRec documents and what the
 * receiver expands against its own grid — the stroke carries the ball, never
 * a cell list, so it cannot go stale and it costs ~20 bytes.
 */
export function publishStroke(
  node: string,
  color: number,
  x: number,
  y: number,
  z: number,
  radius: number,
): RecordId | null {
  const s = sync
  if (!s) return null
  const rec = addLocalStroke(s.world, { node, color, x, y, z, radius })
  if (!rec) return null
  outgoing().strokes.push(rec)
  return rec.id
}

// ── Receive ─────────────────────────────────────────────────────────────────

/**
 * THE LOCAL INJECTION POINT. The transport calls this with the frame body and
 * the sender's id FROM THE BUS ENVELOPE (never from the payload — that is the
 * whole authorship defence); a test calls it with a delta it built by hand.
 * Merging is idempotent, so re-delivery, a snapshot after a delta and a
 * delta after a snapshot are all the same operation.
 */
export function receiveBuildDelta(delta: SharedDelta, sender: PeerId | null): SharedEffects {
  const s = sync
  if (!s) return emptyEffects()
  const fx = mergeDelta(s.world, delta, sender)
  applyBuildEffects(fx)
  return fx
}

/**
 * Apply merged effects to the running game. Separate from the merge so a
 * transport that merges several frames before a frame boundary can apply once
 * — and so the tests can assert the model and the runtime independently.
 */
export function applyBuildEffects(fx: SharedEffects): void {
  const s = sync
  if (!s) return
  // Installing pieces writes the store, and the store's subscribers include
  // the effect that calls reconcileSharedPieces. Hold the guard across the
  // whole apply so an arrival cannot recurse into a diff of a half-applied
  // world (the diff would read a piece as vanished mid-install).
  const outer = reconciling
  reconciling = true
  try {
    applyEffectsInner(s, fx)
  } finally {
    reconciling = outer
  }
}

function applyEffectsInner(s: BuildSync, fx: SharedEffects): void {
  // THE GRID REFUSAL IS A PLAYER-VISIBLE EVENT, not a dropped packet. A peer
  // whose anchor differs has its slot-addressed pieces refused wholesale, and
  // a player wondering where a friend's walls went deserves the reason.
  //
  // ONE EXCEPTION, AND IT IS ABOUT US, NOT THEM: our own stamp is 0 until the
  // grid effect publishes it, and the transport attaches earlier than the piece
  // tree mounts — so a frame arriving in that window is refused because WE do
  // not know our lot yet. That is not "a builder is on a different lot", and
  // saying so would blame a stranger for our own startup order. Refusing the
  // frame stays correct (records are grow-only, the next frame lands); the
  // notice waits until we have a lot of our own to disagree about.
  if (fx.refusedGrid && !refusedGridSaid && s.world.gridStamp !== 0) {
    refusedGridSaid = true
    say('A builder is on a different lot grid — their pieces are hidden')
  }

  // Records that died elsewhere: drop their runtime object here. Pieces go
  // through the same path as the election's losers.
  for (const id of fx.deadPieces) {
    const runtimeId = pieceRuntime.get(id)
    if (runtimeId === undefined) continue
    const piece = useBoots.getState().placed.find((p) => p.id === runtimeId)
    unbindPiece(runtimeId)
    if (!piece) continue
    useBoots.getState().removePlaced(runtimeId)
    if (piece.slotId) onPieceRemoved(piece.slotId)
  }
  for (const id of [...fx.deadItems, ...fx.deadApertures]) {
    const runtimeId = placementRuntime.get(id)
    if (runtimeId === undefined) continue
    unbindPlacement(runtimeId)
    appliers.removePlacement?.(runtimeId)
  }

  // Additions. Pieces are installed by the election (an arrival can depose a
  // piece that is already standing, so the whole projection is recomputed
  // rather than the new records appended).
  if (fx.addedPieces.length > 0) installPieces()

  // `isOurs` on both lanes for the same reason as the pieces: our own work,
  // published under any name this tab has worn, is already in the scene.
  for (const rec of fx.addedItems) {
    if (placementRuntime.has(rec.id)) continue
    if (isOurs(s.world, rec.id)) continue
    const runtimeId = appliers.spawnItem?.(rec)
    if (runtimeId !== null && runtimeId !== undefined) bindPlacement(runtimeId, rec.id, true)
  }
  for (const rec of fx.addedApertures) {
    if (placementRuntime.has(rec.id)) continue
    if (isOurs(s.world, rec.id)) continue
    const runtimeId = appliers.spawnAperture?.(rec)
    if (runtimeId !== null && runtimeId !== undefined) bindPlacement(runtimeId, rec.id, true)
  }

  // Paint folds; a stroke of ours coming back (it cannot, the authorship gate
  // stops it) would double-coat, so filter by author anyway. Strokes have no
  // runtime binding to fall back on — the coat ledger is the only record that
  // they landed — so this filter is the ONLY thing standing between a rename
  // and our own paint being folded over itself, twice as strong.
  if (appliers.foldStrokes) {
    const theirs = fx.addedStrokes.filter((rec) => !isOurs(s.world, rec.id))
    // Installing a piece is the one event that can give a waiting stroke its
    // surface, so a frame that installed one re-offers the list even when it
    // carried no paint of its own.
    if (theirs.length > 0 || (fx.addedPieces.length > 0 && pendingStrokes.length > 0)) {
      foldWithPending(theirs)
    }
  }
}

/** One grid-mismatch line per session is plenty. */
let refusedGridSaid = false

// ── QA ──────────────────────────────────────────────────────────────────────

/** Plain-data dump for the `__boots` family of handles. Copies, never refs. */
export function sharedBuildDebug(): {
  on: boolean
  self: string
  pieces: { bound: number; foreign: number; deposed: number }
  placements: { bound: number; foreign: number }
  gridStamp: number
  /** Is the grid frame retained? False mid-session means no slot can replicate. */
  gridFrameHeld: boolean
  /** Times a stamp actually reached a world. 0 with a live lane is the bug. */
  gridStampPublishes: number
  /**
   * THE STAMP'S OWN INPUTS, as a plain copy. A mismatched stamp is a hash
   * collision-free "you two are not on the same lot", which tells QA that the
   * pieces lane is refused and NOTHING about why. These four fields are the
   * whole preimage — anchor x/z/yaw and the storey ladder with the terrain rung
   * first — so a disagreement can be read off two dumps instead of guessed at.
   */
  gridFrame: { x: number; z: number; yaw: number; ys: number[] } | null
  /** Strokes still waiting for the wall they landed on (see pendingStrokes). */
  pendingStrokes: number
  /** Where every offered stroke ended up (see strokeAudit) — QA arithmetic. */
  strokes: typeof strokeAudit
} {
  return {
    on: sync !== null,
    self: sync?.world.self ?? '',
    pieces: {
      bound: pieceRecord.size,
      foreign: foreignPieces.size,
      deposed: deposedPieces.size,
    },
    placements: { bound: placementRecord.size, foreign: foreignPlacements.size },
    gridStamp: sync?.world.gridStamp ?? 0,
    gridFrameHeld: gridFrame !== null,
    gridStampPublishes,
    gridFrame: gridFrame ? { x: gridFrame.x, z: gridFrame.z, yaw: gridFrame.yaw, ys: [...gridFrame.ys] } : null,
    pendingStrokes: pendingStrokes.length,
    strokes: { ...strokeAudit },
  }
}

/** Test/teardown reset: forget the session AND the once-per-session notices. */
export function resetSharedBuild(): void {
  detachBuildSync()
  resetAttribution()
  clearBuildAppliers()
  noticeSink = null
  refusedGridSaid = false
  gridFrame = null
  gridStampPublishes = 0
  lastStamp = 0
  stampChanged = null
  pendingStrokes.length = 0
  // The audit survives a detach on purpose (a coat lost at session exit is the
  // interesting case), so only the hard reset zeroes it.
  strokeAudit.offered = 0
  strokeAudit.landed = 0
  strokeAudit.kept = 0
  strokeAudit.cleared = 0
  strokeAudit.drains = 0
  strokeAudit.noApplier = 0
  strokeAudit.refolds = 0
}
