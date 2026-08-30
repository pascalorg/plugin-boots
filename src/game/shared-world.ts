/**
 * THE CONVERGENT SHARED WORLD — pure state model (no transport, no renderer,
 * no scene writes, no imports from the live game).
 *
 * The requirement is total: two strangers in the same lot must see the SAME
 * holes in the same walls and the same pieces built. "Same field, separate
 * rubble" is rejected. This module is the data model that makes that true
 * without a lockstep, without an authoritative host, and without rollback.
 *
 * ── Why outcomes, not intents ───────────────────────────────────────────────
 * The obvious design is to replicate the EVENT ("player fired at point P")
 * and let every client re-run destruction. That cannot work here, and the
 * reason is measurable in the existing code: a single rifle shot's carve
 * footprint is drawn from `Math.random()` — shooting.ts picks
 * `4 + floor(random()*3)` nibbles at random offsets with random radii, and
 * a grenade ring offsets every carve point and radius the same way. Two
 * clients replaying the same shot delete DIFFERENT cells. Replaying intents
 * would diverge on the first trigger pull.
 *
 * So we replicate OUTCOMES: the set of cells that died. That turns out to be
 * the cheap thing anyway, because of the shape of the outcome:
 *
 * ── Cell removal is monotone and idempotent ─────────────────────────────────
 * Destruction only ever clears `alive[i] = 0`. Removing the same cell twice
 * is a no-op; removing cells in a different order gives the same grid. So
 * the removed-cell set per node is a GROW-ONLY SET (G-Set) and its least
 * upper bound is UNION: commutative, associative, idempotent. Messages may
 * arrive out of order, twice, or not at all (the next snapshot repairs a
 * loss) and every client still lands on the same grid. No sequence numbers
 * are needed for correctness — only for the transport's own book-keeping.
 *
 * ── …except for one restore path, which needs an epoch ──────────────────────
 * `restoreOperableTarget` in destruction.ts hands a lightly-damaged closed
 * door BACK to the host on E: the voxel target is dropped and the node is
 * pristine and operable again. That is a NON-monotone reset, and shoehorning
 * it into a grow-only set is impossible (union can only add holes back). It
 * is modelled explicitly as a versioned reset: every node carries an
 * `epoch`, removals belong to the epoch they were made in, and the join
 * keeps the HIGHEST epoch and discards everything below it. Formally each
 * node is a lexicographic product of a counter and a G-Set — still a
 * lattice, still order-free. Concurrent resets that land on the same epoch
 * merge their damage by union, which is the right answer: both peers agree
 * the door came back, then both peers' subsequent shots count.
 *
 * ── Everything else is add-only with unique ids ─────────────────────────────
 * Built pieces, catalog items, wall apertures and paint strokes are records
 * with globally unique ids, plus removals. Each lane is an OR-Set: an add
 * map and a tombstone set, both grow-only, alive = adds \ tombstones. Ids
 * are `<peerId>#<seq>`, so two peers can never mint the same id, and a peer
 * may only ADD ids under its own prefix (validated against the bus envelope,
 * never against a self-reported field) — that is what stops a hostile peer
 * from overwriting someone else's wall. Tombstones may name any id, because
 * in a shared lot anyone may blow up anyone's wall.
 *
 * ── Collapse is DERIVED, then replicated as an outcome ──────────────────────
 * Structural collapse and support cascades are not replicated as physics.
 * They are derived locally (shared-derive.ts gives the deterministic
 * ordering) and the DECISION is published as `killed` — a monotone per-node
 * bit meaning "every cell of this node is gone". See shared-derive.ts for
 * the full argument; the short version is that the existing probe's inputs
 * (which nodes are materialized at all, which colliders are disabled) differ
 * per client by design, so re-deriving from remote state would diverge,
 * while a monotone kill bit converges for free.
 *
 * ── Local authorship: the non-destructive invariant survives ────────────────
 * Nothing here reaches a scene write. The four Save bridges (keep.ts,
 * save-demolition.ts, paint-keep.ts, item-keep.ts) must only ever see the
 * LOCAL player's work, so every lane can answer "is this mine?" without a
 * lookup: `id.startsWith(self + '#')`. Voxel damage has no per-cell author
 * (that would double the memory), so a node keeps a second, LOCAL-ONLY set
 * `mine` — the subset of `removed` this client caused. `mine` is never
 * encoded, never merged, and never read by anything but `localWork()`; the
 * merge law below is stated over the REPLICATED projection, which excludes
 * it. `localWork()` is the only shape the Save bridges may consume.
 *
 * ── Independent of render tier ──────────────────────────────────────────────
 * Prevoxelization is time-budgeted and proximity-ordered, so at the instant
 * a remote message arrives a node may be dormant here and awake there. The
 * model therefore never refers to a local voxel target: cells are addressed
 * by GRID COORDINATE (packed, see CellKey), not by the compact `index` of
 * `VoxelGridData` — that compact index depends on which cells the BVH
 * sampler happened to accept and on whether the drywall-skin pass ran, so it
 * is not a portable name for a cell. Applying merged state is a two-step the
 * wiring layer performs: force materialization, then remove by coordinate.
 * The effects returned by `mergeDelta` are exactly that instruction list.
 */

// ── Identity ────────────────────────────────────────────────────────────────

/** A peer, as the collaboration bus names it (one browser tab = one). NEVER
 * taken from a payload field: the bus envelope's `sessionId` is the only
 * trustworthy source, so a peer cannot claim to be someone else. */
export type PeerId = string

/** A host scene node id, or one of the game's synthetic target ids. */
export type NodeId = string

/** `<peerId>#<seq>` — unique across peers by construction. */
export type RecordId = string

/** Max characters in a peer id (bus session ids are uuid-shaped). */
export const MAX_PEER_ID_LEN = 64
/** Max characters in a node id (host ids are uuid-shaped; synthetic target
 * ids are `__boots-piece-<recordId>`, hence the slack). */
export const MAX_NODE_ID_LEN = 160
/** Max characters in a record id. */
export const MAX_RECORD_ID_LEN = MAX_PEER_ID_LEN + 16
/** Max characters in a grid slot id (grid.ts codec output). */
export const MAX_SLOT_ID_LEN = 64
/** Max characters in a catalog id. */
export const MAX_CATALOG_ID_LEN = 96

/** Ids are opaque strings from the host, but a hostile peer is not the host:
 * only these characters are allowed through, so an id can never carry a
 * newline into a log, a `<` into the DOM, or a separator into a key. The comma
 * is in the set because slot ids are spelled "Wx:3,-1,0". */
const ID_SAFE = /^[A-Za-z0-9_\-:.#/,]+$/

export function isSafeId(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && ID_SAFE.test(value)
}

/**
 * A peer id additionally may not contain `#`, because `#` is the separator in
 * a record id. Without this rule a peer calling itself `alice#1` could mint
 * `alice#1#1`, whose author reads back as `alice` — an identity forgery out of
 * nothing but a nickname.
 */
export function isSafePeerId(value: unknown): value is PeerId {
  return isSafeId(value, MAX_PEER_ID_LEN) && !value.includes('#')
}

/** Mint the id for the local peer's next record. */
export function mintRecordId(world: SharedWorld): RecordId {
  return `${world.self}#${++world.seq}`
}

/** True when `id` was minted by `peer` — the authorship test, a prefix
 * compare with no lookup. The `#` guard stops `alice` from matching
 * `alice2#7`. */
export function isAuthoredBy(id: RecordId, peer: PeerId): boolean {
  return id.length > peer.length && id.charCodeAt(peer.length) === 35 /* # */ && id.startsWith(peer)
}

/** The peer half of a record id ('' when malformed). */
export function authorOf(id: RecordId): PeerId {
  const hash = id.indexOf('#')
  return hash > 0 ? id.slice(0, hash) : ''
}

/**
 * The voxel-target node id for a shared placed piece. The runtime's own
 * `__boots-piece-<n>` counter is per-client and WOULD COLLIDE across peers
 * (my third wall and yours are both `#3`); shared pieces must key their
 * target off the record id instead, which carries the author.
 */
export const PIECE_TARGET_PREFIX = '__boots-piece-'
/** Same story for placed catalog items (`__boots-item-*` colliders). */
export const ITEM_TARGET_PREFIX = '__boots-item-'

export const pieceTargetId = (id: RecordId): NodeId => `${PIECE_TARGET_PREFIX}${id}`
export const itemTargetId = (id: RecordId): NodeId => `${ITEM_TARGET_PREFIX}${id}`

// ── Cell addressing ─────────────────────────────────────────────────────────

/**
 * A voxel cell named by its GRID COORDINATE, packed 10 bits per axis into
 * one non-negative int32 (`ix | iy<<10 | iz<<20`).
 *
 * Why not the compact voxel index? `buildVoxelGrid` appends only the cells
 * its BVH sampler declared inside, then `dropInteriorCells` REBUILDS the
 * array keeping two skins — so the compact index of a cell depends on the
 * geometry sampling and on which post-passes ran. A wire index would land on
 * the wrong cell if a peer's grid differed by one accepted cell. A grid
 * coordinate is absolute: `grid.index.get(gridKey(ix,iy,iz,nx,ny))` either
 * finds the cell or the local grid never had it, and a miss is a harmless
 * no-op instead of a hole in the wrong place.
 *
 * Why not (nx,ny)-packed keys (voxel.ts's `gridKey`)? Because decoding one
 * requires the receiver's nx/ny to equal the sender's. 10 bits per axis is
 * dims-free, and 1024 cells on an axis is 60× the MAX_VOXELS budget.
 */
export type CellKey = number

export const CELL_AXIS_BITS = 10
/** Exclusive upper bound on a grid coordinate on any axis. */
export const CELL_AXIS_MAX = 1 << CELL_AXIS_BITS
/** Inclusive upper bound on a packed key. */
export const CELL_KEY_MAX = (1 << (CELL_AXIS_BITS * 3)) - 1

export const cellKey = (ix: number, iy: number, iz: number): CellKey =>
  ix | (iy << CELL_AXIS_BITS) | (iz << (CELL_AXIS_BITS * 2))
export const cellIx = (key: CellKey): number => key & (CELL_AXIS_MAX - 1)
export const cellIy = (key: CellKey): number => (key >>> CELL_AXIS_BITS) & (CELL_AXIS_MAX - 1)
export const cellIz = (key: CellKey): number => (key >>> (CELL_AXIS_BITS * 2)) & (CELL_AXIS_MAX - 1)

/** True for a key that could name a cell in any plausible grid. */
export const isCellKey = (key: unknown): key is CellKey =>
  typeof key === 'number' && Number.isInteger(key) && key >= 0 && key <= CELL_KEY_MAX

// ── Caps (hostile input is the default assumption) ──────────────────────────

/** Cells one node may carry in ONE frame (MAX_VOXELS is 1600 and the item
 * budget 2600 — slack, but still a hard bound). */
export const MAX_CELLS_PER_NODE = 4096
/** Framing sticks one node may report broken in ONE frame. */
export const MAX_SEGMENTS_PER_NODE = 4096
/** Upper bound on a `SegmentMember.id` (build-order integers). */
export const MAX_SEGMENT_ID = 65535
/** Nodes one frame may touch. */
export const MAX_NODES_PER_FRAME = 1024
/** Records one lane may carry in ONE frame. */
export const MAX_RECORDS_PER_FRAME = 2048
/** Tombstones one lane may carry in ONE frame. */
export const MAX_TOMBSTONES_PER_FRAME = 2048
/** Cells one paint stroke may cover. */
export const MAX_STROKE_CELLS = 1024
/** Nodes the RESIDENT model will hold (warner-2 is 670 nodes; the synthetic
 * scale probe 3.7k). Past this, remote adds are dropped and counted. */
export const MAX_MODEL_NODES = 8192
/** Live records the RESIDENT model will hold per lane. */
export const MAX_MODEL_RECORDS = 8192
/** Tombstones the RESIDENT model will hold per lane. */
export const MAX_MODEL_TOMBSTONES = 16384
/** |x|,|y|,|z| bound for any replicated position (metres). */
export const WORLD_BOUND_M = 4096
/** A lamport stamp may not jump further than this past what we have seen —
 * a peer that shouts 1e300 must not poison every future tie-break. */
export const LAMPORT_JUMP_CAP = 1 << 20
/** Colors in the paint carousel (paint.tsx's palette; the cap is generous so
 * a palette change is not a protocol change). */
export const MAX_PAINT_COLORS = 64
/** Piece kinds: wall, floor, stairs, roof. */
export const PIECE_KINDS = ['wall', 'floor', 'stairs', 'roof'] as const
export type PieceKind = (typeof PIECE_KINDS)[number]
/** 3×3 lattice mask upper bound (9 bits; 511 = intact). */
export const MAX_PIECE_MASK = 511
/** A storey span, in metres. Generous; a peer claiming 400 m is refused. */
export const MAX_PIECE_HEIGHT_M = 32
/** Widest/tallest opening a peer may claim, in metres. */
export const MAX_APERTURE_M = 16
/** Biggest paint ball, in metres (PAINT_RADIUS is ~0.18). */
export const MAX_STROKE_RADIUS_M = 4
/** Kind-specific packed shape upper bound (roof corner bits, stair run…). */
// ── Canonical numeric form ──────────────────────────────────────────────────
//
// Records are quantized ON MINT, not on encode. This matters more than it
// looks: the join's final tie-break is the canonical STRING of a record, so
// if the wire rounded 1.23456 to 1.235 then the author (holding the raw
// value) and every receiver (holding the rounded one) would compute different
// canonical forms for the same id and could elect different winners. Making
// quantization part of the model instead of part of the codec makes the
// encoder exactly lossless and the join order-free for real.

/** Positions and lengths live on a 1 mm lattice. */
export const POS_PER_M = 1000
/** Yaw lives on a 65536-step turn (0.0055°) in [0, 2π). */
export const YAW_STEPS = 65536

export const quantPos = (v: number): number => Math.round(v * POS_PER_M) / POS_PER_M
export const quantYaw = (v: number): number => {
  const turn = Math.PI * 2
  const wrapped = ((v % turn) + turn) % turn
  return ((Math.round((wrapped / turn) * YAW_STEPS) % YAW_STEPS) * turn) / YAW_STEPS
}

// ── Lanes ───────────────────────────────────────────────────────────────────

/** Every replicated record carries its id and the lamport stamp it was
 * minted at (the tie-break, never a clock the game reads). */
export type Stamped = { id: RecordId; lamport: number }

/**
 * A placed fort piece — the replicated form of `store.ts`'s `PlacedPiece`.
 *
 * The address is the GRID SLOT ID (grid.ts's `slotId` codec, `<kind>:<i>,<k>,<s>`),
 * never a float triple: placement is slot-locked by construction, so the slot
 * string is both the identity and the position, it costs a dozen bytes, and
 * two peers describing the same slot produce byte-identical strings — no
 * float drift, no rounding policy, and `slotsTouching` works on it directly.
 *
 * The slot is only a WORLD address if both peers share grid.ts's session
 * state (`_anchor` and the storey ladder are module-level and derived from
 * the scene, not embedded in the key). They do share it — both loaded the
 * same document — but "should" is not "is", so every frame carries a
 * `gridStamp` and slot-addressed lanes are refused wholesale on a mismatch
 * rather than rendered in the wrong place. See SharedDelta.gridStamp.
 *
 * `store.ts`'s own `id: number` counter is per-page-load and starts at 1 on
 * every client, so it is NOT usable as a shared identity (two peers' first
 * walls are both `id: 1`, and that number is also the `__boots-piece-N`
 * collider id). Shared pieces key off `RecordId` — see pieceTargetId.
 */
export type PieceRec = Stamped & {
  kind: PieceKind
  slot: string
  /** 3×3 lattice mask, 9 bits — 511 is intact (edit-overlay carves bits). */
  mask: number
  /** Yaw about Y (radians, quantized to ~0.06° on the wire). */
  yaw: number
  /** Storey span stamped at placement (metres; 0 = the piece had none). */
  height: number
  /** Roof corner heights (roof-corners.ts `RoofCorners`); null off roofs. */
  corners: readonly [number, number, number, number] | null
}

/** A placed catalog item — the replicated form of `PlacedItem`. The runtime
 * record embeds the whole `CatalogEntry` verbatim; the wire carries only
 * `asset.id` and the receiver looks the entry up (the existing labelled proxy
 * box already covers a lookup or GLB failure). Bottom-centre anchor + yaw is
 * the whole transform — no scale, no pitch/roll. */
export type ItemRec = Stamped & {
  catalogId: string
  x: number
  y: number
  z: number
  yaw: number
}

/**
 * A door/window snapped onto a wall — the replicated form of
 * `PlacedAperture`. Wall-RELATIVE by construction (`wallId` + normalized
 * u,v + metric width/height), which is exactly what replication wants: no
 * world transform to keep in step, and `collapseHostedApertures` can
 * tombstone every aperture of a levelled wall by host id alone.
 */
export type ApertureRec = Stamped & {
  catalogId: string
  /** `PlacedAperture.wallId` — the host wall's scene node id. */
  host: NodeId
  u: number
  v: number
  width: number
  height: number
}

/**
 * One spray splat: a color and the ball it painted on one node.
 *
 * Paint is the one OVERWRITABLE lane — a repaint in a different colour
 * restarts the cell's strength from 0 (`coatBaseStrength`), the same colour
 * accumulates — so per-cell writes are not commutative and a plain set
 * cannot express them. Two moves fix it. First, the lane stays a G-Set of
 * STROKES and the per-cell coat is DERIVED by folding strokes in canonical
 * (lamport, id) order — order-free input, order-fixed fold, so every client
 * computes the same ledger. Second, a stroke carries its GEOMETRY, not its
 * cell list: `splatCoat` is pure, so each client expands the ball against
 * its own grid. That keeps a stroke at ~20 bytes instead of ~1 KB, and it
 * sidesteps the compact-voxel-index portability problem entirely.
 */
export type StrokeRec = Stamped & {
  node: NodeId
  /** Index into paint.tsx's PAINT_PALETTE (12 today). */
  color: number
  x: number
  y: number
  z: number
  /** Coat radius in metres (paint.tsx `coatRadiusFor`). */
  radius: number
}

/** An OR-Set: adds and tombstones, both grow-only. alive = adds \ dead. */
export type OrSet<T extends Stamped> = {
  adds: Map<RecordId, T>
  dead: Set<RecordId>
}

const emptyOrSet = <T extends Stamped>(): OrSet<T> => ({ adds: new Map(), dead: new Set() })

/** Live records of a lane, in CANONICAL (id-sorted) order — never Map order,
 * which is insertion order and therefore per-client. */
export function liveRecords<T extends Stamped>(lane: OrSet<T>): T[] {
  const out: T[] = []
  for (const [id, rec] of lane.adds) {
    if (!lane.dead.has(id)) out.push(rec)
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** One record by id, or null when absent or tombstoned. */
export function liveRecord<T extends Stamped>(lane: OrSet<T>, id: RecordId): T | null {
  if (lane.dead.has(id)) return null
  return lane.adds.get(id) ?? null
}

// ── Per-node voxel damage ───────────────────────────────────────────────────

export type NodeDamage = {
  nodeId: NodeId
  /** Reset generation (restoreOperableTarget). Higher wins outright. */
  epoch: number
  /** Grow-only set of removed cells AT THIS EPOCH. */
  removed: Set<CellKey>
  /**
   * Grow-only set of BROKEN framing sticks (`SegmentMember.id`) at this
   * epoch. A second lane is needed because a stick is not a cell: nothing in
   * the voxel grid records `segment.broken`, `isFullyDestroyed` requires
   * "zero voxels AND every stick broken", and the 30 %-support avalanche
   * keys off broken RATIOS. Breaking is monotone too, so it is the same
   * G-Set with the same union.
   */
  segments: Set<number>
  /** Monotone "the whole target is gone" — the replicated form of a
   * structural collapse decision, tier-independent by construction (a
   * dormant client does not need to know the cell set to obey it). */
  killed: boolean
  /** LOCAL ONLY — the subset of `removed` this client caused. Never encoded,
   * never merged, only read by localWork() for the Save bridges. */
  mine: Set<CellKey>
  /** LOCAL ONLY — the subset of `segments` this client broke. */
  mySegments: Set<number>
  /** LOCAL ONLY — this client collapsed the node itself. */
  killedByMe: boolean
}

const emptyDamage = (nodeId: NodeId): NodeDamage => ({
  nodeId,
  epoch: 0,
  removed: new Set(),
  segments: new Set(),
  killed: false,
  mine: new Set(),
  mySegments: new Set(),
  killedByMe: false,
})

// ── The outbound journal ────────────────────────────────────────────────────

/**
 * What this client has done since it last published — held as maps and sets so
 * a burst of ops COLLAPSES instead of accumulating: sixty rifle shots into the
 * same wall journal as one node entry with the union of their cells, and a
 * record edited twice journals once.
 *
 * Kept separate from the model proper because the model is what we KNOW and
 * the journal is what we still OWE the room. Merging a remote frame never
 * touches it: relaying someone else's records would be refused by their
 * authorship gate anyway.
 */
export type Journal = {
  nodes: Map<NodeId, NodeDelta>
  pieces: Map<RecordId, PieceRec>
  items: Map<RecordId, ItemRec>
  apertures: Map<RecordId, ApertureRec>
  strokes: Map<RecordId, StrokeRec>
  deadPieces: Set<RecordId>
  deadItems: Set<RecordId>
  deadApertures: Set<RecordId>
  deadStrokes: Set<RecordId>
}

function emptyJournal(): Journal {
  return {
    nodes: new Map(),
    pieces: new Map(),
    items: new Map(),
    apertures: new Map(),
    strokes: new Map(),
    deadPieces: new Set(),
    deadItems: new Set(),
    deadApertures: new Set(),
    deadStrokes: new Set(),
  }
}

// ── The model ───────────────────────────────────────────────────────────────

export type SharedWorld = {
  /** This client's peer id (the bus session id). */
  self: PeerId
  /** Lamport clock: max(seen) — bumped on every local op, raised on merge. */
  clock: number
  /** Local record serial (the `#n` half of a minted id). */
  seq: number
  /** This client's build-grid fingerprint; stamped into every outgoing frame
   * and compared against incoming ones. 0 until the wiring layer calls
   * `setGridStamp` (which it must do before publishing anything). */
  gridStamp: number
  nodes: Map<NodeId, NodeDamage>
  pieces: OrSet<PieceRec>
  items: OrSet<ItemRec>
  apertures: OrSet<ApertureRec>
  strokes: OrSet<StrokeRec>
  /**
   * Everything local that has happened since the last `takePending` — the
   * outbound journal. See the section below: the transport coalesces to ONE
   * frame per kind per 66 ms window and drops the rest of a burst, so
   * "publish once per tick" is the only sane cadence and this is what makes
   * it a first-class path instead of something each lane reinvents.
   */
  journal: Journal
  /** QA counters — hostile or over-cap input is dropped, never thrown. */
  dropped: number
  /** Ops applied from remote peers (observability). */
  applied: number
  /** Local ops that were journalled, taken, and then handed BACK because the
   * publish did not happen (coalesced, refused, or over the byte budget).
   * They are still in the journal and will go out on a later tick; the
   * counter exists so a lost frame is visible instead of silent. */
  unsent: number
}

export function createSharedWorld(self: PeerId): SharedWorld {
  return {
    self: isSafePeerId(self) ? self : 'local',
    clock: 0,
    seq: 0,
    gridStamp: 0,
    nodes: new Map(),
    pieces: emptyOrSet(),
    items: emptyOrSet(),
    apertures: emptyOrSet(),
    strokes: emptyOrSet(),
    journal: emptyJournal(),
    dropped: 0,
    applied: 0,
    unsent: 0,
  }
}

/** Node ids that carry damage, in canonical order. */
export function damagedNodes(world: SharedWorld): NodeId[] {
  const out: NodeId[] = []
  for (const [id, dmg] of world.nodes) {
    if (dmg.epoch > 0 || dmg.removed.size > 0 || dmg.segments.size > 0 || dmg.killed) out.push(id)
  }
  out.sort()
  return out
}

/** The damage record for a node (created empty on demand). */
export function nodeDamage(world: SharedWorld, nodeId: NodeId): NodeDamage {
  let dmg = world.nodes.get(nodeId)
  if (!dmg) {
    dmg = emptyDamage(nodeId)
    world.nodes.set(nodeId, dmg)
  }
  return dmg
}

/** Removed cells of a node in canonical (ascending key) order. */
export function removedCells(world: SharedWorld, nodeId: NodeId): CellKey[] {
  const dmg = world.nodes.get(nodeId)
  if (!dmg) return []
  const out = [...dmg.removed]
  out.sort((a, b) => a - b)
  return out
}

/** Broken framing sticks of a node in canonical (ascending id) order. */
export function brokenSegments(world: SharedWorld, nodeId: NodeId): number[] {
  const dmg = world.nodes.get(nodeId)
  if (!dmg) return []
  const out = [...dmg.segments]
  out.sort((a, b) => a - b)
  return out
}

// ── Local ops (the only writers of `mine`) ──────────────────────────────────

/**
 * The journal entry for a node, at the node's CURRENT epoch. A reset replaces
 * the entry outright (see noteLocalReset): cells journalled at an old epoch
 * are not merely redundant, they are wrong — every receiver would discard them
 * against the higher epoch, and re-sending them would be noise forever.
 */
function journalNode(world: SharedWorld, nodeId: NodeId): NodeDelta {
  const epoch = world.nodes.get(nodeId)?.epoch ?? 0
  let entry = world.journal.nodes.get(nodeId)
  if (!entry || entry.epoch !== epoch) {
    entry = { nodeId, epoch, removed: [], segments: [], killed: false, reset: false }
    world.journal.nodes.set(nodeId, entry)
  }
  return entry
}

/**
 * Record cells the LOCAL player just destroyed. Returns the keys that were
 * genuinely new (the wire payload — re-reporting a cell is legal but wasteful).
 * `mine` grows with them so the Save bridges can still tell the player's own
 * demolition from a stranger's.
 */
export function noteLocalRemoval(
  world: SharedWorld,
  nodeId: NodeId,
  keys: Iterable<CellKey>,
): CellKey[] {
  const dmg = nodeDamage(world, nodeId)
  const fresh: CellKey[] = []
  for (const key of keys) {
    if (!isCellKey(key)) continue
    dmg.mine.add(key)
    if (dmg.removed.has(key)) continue
    dmg.removed.add(key)
    fresh.push(key)
  }
  if (fresh.length > 0) {
    world.clock++
    const entry = journalNode(world, nodeId)
    for (const key of fresh) entry.removed.push(key)
  }
  return fresh
}

/**
 * Record framing sticks the LOCAL player just broke. Returns the genuinely
 * new ids (the wire payload). Same G-Set discipline as cells: breaking is
 * one-way, so union converges.
 */
export function noteLocalSegments(
  world: SharedWorld,
  nodeId: NodeId,
  ids: Iterable<number>,
): number[] {
  const dmg = nodeDamage(world, nodeId)
  const fresh: number[] = []
  for (const id of ids) {
    if (!smallInt(id, MAX_SEGMENT_ID)) continue
    dmg.mySegments.add(id)
    if (dmg.segments.has(id)) continue
    dmg.segments.add(id)
    fresh.push(id)
  }
  if (fresh.length > 0) {
    world.clock++
    const entry = journalNode(world, nodeId)
    for (const id of fresh) entry.segments.push(id)
  }
  return fresh
}

/** Record that the LOCAL client collapsed a whole target. Returns false when
 * it was already known dead (nothing to publish). */
export function noteLocalKill(world: SharedWorld, nodeId: NodeId): boolean {
  const dmg = nodeDamage(world, nodeId)
  dmg.killedByMe = true
  if (dmg.killed) return false
  dmg.killed = true
  world.clock++
  journalNode(world, nodeId).killed = true
  return true
}

/**
 * The restore path (`restoreOperableTarget`): the node is pristine again.
 * Bumps the epoch and drops every removal at the old epoch — including this
 * client's own, which is correct: the door came back, so nobody's holes in
 * it survive. Returns the new epoch (the wire payload).
 */
export function noteLocalReset(world: SharedWorld, nodeId: NodeId): number {
  const dmg = nodeDamage(world, nodeId)
  dmg.epoch++
  dmg.removed.clear()
  dmg.mine.clear()
  dmg.segments.clear()
  dmg.mySegments.clear()
  dmg.killed = false
  dmg.killedByMe = false
  world.clock++
  // Replaces whatever was journalled at the old epoch, cells included.
  world.journal.nodes.set(nodeId, {
    nodeId,
    epoch: dmg.epoch,
    removed: [],
    segments: [],
    killed: false,
    reset: true,
  })
  return dmg.epoch
}

/** Add a locally-built piece. Fills in id + lamport; returns the record. */
export function addLocalPiece(
  world: SharedWorld,
  rec: Omit<PieceRec, 'id' | 'lamport'>,
): PieceRec | null {
  const full: PieceRec = {
    ...rec,
    id: mintRecordId(world),
    lamport: ++world.clock,
    yaw: quantYaw(rec.yaw),
    height: quantPos(rec.height),
    corners: rec.corners
      ? [
          quantPos(rec.corners[0]),
          quantPos(rec.corners[1]),
          quantPos(rec.corners[2]),
          quantPos(rec.corners[3]),
        ]
      : null,
  }
  if (!sanePiece(full)) return null
  world.pieces.adds.set(full.id, full)
  world.journal.pieces.set(full.id, full)
  return full
}

export function addLocalItem(
  world: SharedWorld,
  rec: Omit<ItemRec, 'id' | 'lamport'>,
): ItemRec | null {
  const full: ItemRec = {
    ...rec,
    id: mintRecordId(world),
    lamport: ++world.clock,
    x: quantPos(rec.x),
    y: quantPos(rec.y),
    z: quantPos(rec.z),
    yaw: quantYaw(rec.yaw),
  }
  if (!saneItem(full)) return null
  world.items.adds.set(full.id, full)
  world.journal.items.set(full.id, full)
  return full
}

export function addLocalAperture(
  world: SharedWorld,
  rec: Omit<ApertureRec, 'id' | 'lamport'>,
): ApertureRec | null {
  const full: ApertureRec = {
    ...rec,
    id: mintRecordId(world),
    lamport: ++world.clock,
    u: quantPos(rec.u),
    v: quantPos(rec.v),
    width: quantPos(rec.width),
    height: quantPos(rec.height),
  }
  if (!saneAperture(full)) return null
  world.apertures.adds.set(full.id, full)
  world.journal.apertures.set(full.id, full)
  return full
}

export function addLocalStroke(
  world: SharedWorld,
  rec: Omit<StrokeRec, 'id' | 'lamport'>,
): StrokeRec | null {
  const full: StrokeRec = {
    ...rec,
    id: mintRecordId(world),
    lamport: ++world.clock,
    x: quantPos(rec.x),
    y: quantPos(rec.y),
    z: quantPos(rec.z),
    radius: quantPos(rec.radius),
  }
  if (!saneStroke(full)) return null
  world.strokes.adds.set(full.id, full)
  world.journal.strokes.set(full.id, full)
  return full
}

/** Lane names, so removals and effects can be spoken about generically. */
export const LANES = ['pieces', 'items', 'apertures', 'strokes'] as const
export type Lane = (typeof LANES)[number]

/** Tombstone a record (anyone may kill anyone's piece — that is the game).
 * Returns false when it was already dead. */
export function killRecord(world: SharedWorld, lane: Lane, id: RecordId): boolean {
  const set = world[lane] as OrSet<Stamped>
  if (set.dead.has(id)) return false
  set.dead.add(id)
  world.clock++
  world.journal[DEAD_LANE[lane]].add(id)
  // An add still waiting in the journal is now pointless: the tombstone alone
  // says everything a receiver needs, and it wins anyway.
  ;(world.journal[lane] as Map<RecordId, Stamped>).delete(id)
  return true
}

/** Lane → the journal's tombstone set for that lane. */
const DEAD_LANE = {
  pieces: 'deadPieces',
  items: 'deadItems',
  apertures: 'deadApertures',
  strokes: 'deadStrokes',
} as const satisfies Record<Lane, keyof Journal>

// ── The wire shape ──────────────────────────────────────────────────────────

/**
 * One frame's worth of state. A DELTA and a SNAPSHOT have the SAME shape —
 * a snapshot is just a delta that happens to contain everything — because
 * merge is a lattice join: applying a full snapshot to a live model is the
 * identical operation as applying an increment, and there is exactly one
 * code path to get wrong. `kind` exists only so the transport can prioritise
 * and cap the two differently.
 */
export type SharedDelta = {
  v: 1
  kind: 'delta' | 'snapshot'
  /** Author, for the authorship check. Filled from the BUS ENVELOPE on
   * receipt, never trusted from the payload. */
  from: PeerId
  lamport: number
  /**
   * Fingerprint of the sender's BUILD GRID (`grid.ts` anchor + storey ladder,
   * see gridStamp() in shared-derive.ts). Slot ids like `Wx:3,-1,0` are only
   * world addresses relative to that anchor, and the anchor is module state
   * derived from the lot the client loaded. Peers with different stamps are in
   * different coordinate systems: cells and items are still meaningful (they
   * are node-relative and world-absolute respectively) but slot-addressed
   * lanes are NOT, so a mismatch refuses `pieces` and keeps the rest. 0 means
   * "unknown", which also refuses.
   */
  gridStamp: number
  nodes: NodeDelta[]
  pieces: PieceRec[]
  items: ItemRec[]
  apertures: ApertureRec[]
  strokes: StrokeRec[]
  deadPieces: RecordId[]
  deadItems: RecordId[]
  deadApertures: RecordId[]
  deadStrokes: RecordId[]
}

export type NodeDelta = {
  nodeId: NodeId
  epoch: number
  /** Cells removed at `epoch`, ascending. */
  removed: CellKey[]
  /** Framing sticks broken at `epoch`, ascending. */
  segments: number[]
  killed: boolean
  /**
   * ADVISORY: this frame is the one announcing the epoch bump. The merge does
   * not read it — the epoch comparison alone decides everything, which is
   * what makes a lost reset frame self-healing (the next frame or snapshot
   * carries the higher epoch and performs the reset then). It rides along
   * because it costs a spare bit in a flags byte and makes a captured frame
   * readable in QA.
   */
  reset: boolean
}

export const emptyDelta = (from: PeerId, kind: SharedDelta['kind'] = 'delta'): SharedDelta => ({
  v: 1,
  kind,
  from,
  lamport: 0,
  gridStamp: 0,
  nodes: [],
  pieces: [],
  items: [],
  apertures: [],
  strokes: [],
  deadPieces: [],
  deadItems: [],
  deadApertures: [],
  deadStrokes: [],
})

export function deltaIsEmpty(delta: SharedDelta): boolean {
  return (
    delta.nodes.length === 0 &&
    delta.pieces.length === 0 &&
    delta.items.length === 0 &&
    delta.apertures.length === 0 &&
    delta.strokes.length === 0 &&
    delta.deadPieces.length === 0 &&
    delta.deadItems.length === 0 &&
    delta.deadApertures.length === 0 &&
    delta.deadStrokes.length === 0
  )
}

/**
 * The WHOLE replicated state as one frame — what a late joiner receives.
 * Canonically ordered (nodes by id, cells ascending, records by id) so two
 * peers answering the same request produce byte-identical snapshots, which
 * makes the format diffable in QA and the tests exact.
 */
export function snapshotOf(world: SharedWorld): SharedDelta {
  const out = emptyDelta(world.self, 'snapshot')
  out.lamport = world.clock
  out.gridStamp = world.gridStamp
  for (const nodeId of damagedNodes(world)) {
    const dmg = world.nodes.get(nodeId)!
    out.nodes.push({
      nodeId,
      epoch: dmg.epoch,
      removed: removedCells(world, nodeId),
      segments: brokenSegments(world, nodeId),
      killed: dmg.killed,
      // A snapshot always states the epoch as authoritative: a joiner has no
      // history to reconcile, and a peer already at that epoch ignores it.
      reset: dmg.epoch > 0,
    })
  }
  out.pieces = liveRecords(world.pieces)
  out.items = liveRecords(world.items)
  out.apertures = liveRecords(world.apertures)
  out.strokes = liveRecords(world.strokes)
  out.deadPieces = [...world.pieces.dead].sort()
  out.deadItems = [...world.items.dead].sort()
  out.deadApertures = [...world.apertures.dead].sort()
  out.deadStrokes = [...world.strokes.dead].sort()
  return out
}

// ── Publishing once per tick ────────────────────────────────────────────────

/**
 * ONE BATCHED DELTA PER TICK — the cadence the transport actually wants.
 *
 * The host bus coalesces to the latest value per (plugin, event) every ~66 ms
 * and a burst inside one window is DROPPED, not queued: publishing per op
 * means a magazine emptied into a wall arrives as its last shot. So the wiring
 * layer does not publish per op. It calls the local-op functions as usual —
 * they journal what was genuinely new — and once per tick calls takePending()
 * and publishes the single frame that comes back.
 *
 * The journal collapses: sixty shots into one wall become one node entry with
 * the union of their cells, which is both smaller than sixty frames and
 * cheaper than one frame per shot would have been.
 *
 *   const out = takePending(world)
 *   if (out) {
 *     for (const frame of wireParts(out, MAX_WIRE_TEXT)) { ...publish... }
 *     // and if the publish did not happen:
 *     restorePending(world, out)
 *   }
 *
 * Returns null when there is nothing to say. `lamport` is stamped at take
 * time, `from`/`gridStamp` from the world, and the contents are canonically
 * ordered so two clients in the same state produce the same bytes.
 */
export function takePending(
  world: SharedWorld,
  kind: SharedDelta['kind'] = 'delta',
): SharedDelta | null {
  const j = world.journal
  const out = emptyDelta(world.self, kind)
  out.lamport = world.clock
  out.gridStamp = world.gridStamp
  for (const nodeId of [...j.nodes.keys()].sort()) {
    const entry = j.nodes.get(nodeId)!
    entry.removed = ascendingUnique(entry.removed)
    entry.segments = ascendingUnique(entry.segments)
    out.nodes.push(entry)
  }
  out.pieces = stampedOrder(j.pieces)
  out.items = stampedOrder(j.items)
  out.apertures = stampedOrder(j.apertures)
  out.strokes = stampedOrder(j.strokes)
  out.deadPieces = [...j.deadPieces].sort()
  out.deadItems = [...j.deadItems].sort()
  out.deadApertures = [...j.deadApertures].sort()
  out.deadStrokes = [...j.deadStrokes].sort()
  if (deltaIsEmpty(out)) return null
  world.journal = emptyJournal()
  return out
}

/**
 * STRICTLY ascending, which is a precondition and not a nicety: the wire spells
 * a cell list as gaps between consecutive keys, so a repeated key would ask the
 * encoder for a gap of -1. The local ops only ever journal genuinely-new keys,
 * but `restorePending` unions frames back in and cannot know what the journal
 * already holds — so the guarantee is made here, where canonical form is made.
 */
function ascendingUnique(values: number[]): number[] {
  values.sort((a, b) => a - b)
  const out: number[] = []
  for (const value of values) {
    if (out[out.length - 1] !== value) out.push(value)
  }
  return out
}

/** Canonical (lamport, then id) order — the same rule the merge tie-breaks on. */
function stampedOrder<T extends Stamped>(lane: Map<RecordId, T>): T[] {
  const out = [...lane.values()]
  out.sort((a, b) => (a.lamport !== b.lamport ? a.lamport - b.lamport : a.id < b.id ? -1 : 1))
  return out
}

/**
 * Hand a taken delta BACK because it never went out — the host coalesced it
 * ('deferred'), refused it ('suppressed'), or it was over the byte budget.
 * The journal absorbs it (union, max epoch, or of the flags), so the next tick
 * publishes it together with whatever happened since. Idempotent: restoring a
 * delta that partly went out costs a few duplicate bytes and nothing else.
 *
 * `world.unsent` counts these, because a lost frame that nobody can see is a
 * desync nobody can explain. The 15 s heal snapshot is the safety net; this is
 * the fast path that usually means the player never notices.
 */
export function restorePending(world: SharedWorld, delta: SharedDelta): void {
  if (delta === null || typeof delta !== 'object') return
  const j = world.journal
  world.unsent++
  for (const nd of Array.isArray(delta.nodes) ? delta.nodes : []) {
    if (!isSafeId(nd?.nodeId, MAX_NODE_ID_LEN)) continue
    // A node that has since been reset (higher epoch) must not have its old
    // cells resurrected: the epoch on the wire would lose anyway, and the
    // bytes would be spent every tick from now on.
    const epoch = world.nodes.get(nd.nodeId)?.epoch ?? 0
    if (nd.epoch !== epoch) continue
    const entry = journalNode(world, nd.nodeId)
    for (const key of Array.isArray(nd.removed) ? nd.removed : []) {
      if (isCellKey(key)) entry.removed.push(key)
    }
    for (const id of Array.isArray(nd.segments) ? nd.segments : []) {
      if (smallInt(id, MAX_SEGMENT_ID)) entry.segments.push(id)
    }
    entry.killed = entry.killed || nd.killed === true
    entry.reset = entry.reset || nd.reset === true
  }
  restoreLane(j.pieces, delta.pieces)
  restoreLane(j.items, delta.items)
  restoreLane(j.apertures, delta.apertures)
  restoreLane(j.strokes, delta.strokes)
  restoreDead(j.deadPieces, delta.deadPieces)
  restoreDead(j.deadItems, delta.deadItems)
  restoreDead(j.deadApertures, delta.deadApertures)
  restoreDead(j.deadStrokes, delta.deadStrokes)
}

function restoreLane<T extends Stamped>(into: Map<RecordId, T>, recs: T[] | undefined): void {
  for (const rec of Array.isArray(recs) ? recs : []) {
    if (rec && isSafeId(rec.id, MAX_RECORD_ID_LEN) && !into.has(rec.id)) into.set(rec.id, rec)
  }
}

function restoreDead(into: Set<RecordId>, ids: RecordId[] | undefined): void {
  for (const id of Array.isArray(ids) ? ids : []) {
    if (isSafeId(id, MAX_RECORD_ID_LEN)) into.add(id)
  }
}

/** Is there anything to publish? (Cheaper than building the frame to ask.) */
export function hasPending(world: SharedWorld): boolean {
  const j = world.journal
  return (
    j.nodes.size > 0 ||
    j.pieces.size > 0 ||
    j.items.size > 0 ||
    j.apertures.size > 0 ||
    j.strokes.size > 0 ||
    j.deadPieces.size > 0 ||
    j.deadItems.size > 0 ||
    j.deadApertures.size > 0 ||
    j.deadStrokes.size > 0
  )
}

/** What is waiting, for the debug HUD. */
export function pendingCount(world: SharedWorld): {
  nodes: number
  cells: number
  segments: number
  records: number
  tombstones: number
} {
  const j = world.journal
  let cells = 0
  let segments = 0
  for (const nd of j.nodes.values()) {
    cells += nd.removed.length
    segments += nd.segments.length
  }
  return {
    nodes: j.nodes.size,
    cells,
    segments,
    records: j.pieces.size + j.items.size + j.apertures.size + j.strokes.size,
    tombstones:
      j.deadPieces.size + j.deadItems.size + j.deadApertures.size + j.deadStrokes.size,
  }
}

// ── Effects: what the local game must now do ────────────────────────────────

/**
 * The instruction list a merge produced — the ONLY thing the wiring layer
 * needs to look at. Every entry is idempotent, so replaying an effect list
 * is harmless, and every node id in it must be MATERIALIZED before the cells
 * are applied (`resetNodes` and `removedCells` both imply "force the local
 * voxel target into existence first, whatever tier it is in").
 */
export type SharedEffects = {
  /** Epoch bumped — drop the local target and rebuild it pristine. */
  resetNodes: NodeId[]
  /** Newly removed cells per node, ascending. */
  removedCells: Map<NodeId, CellKey[]>
  /** Newly broken framing sticks per node, ascending. */
  brokenSegments: Map<NodeId, number[]>
  /** Newly collapsed whole targets. */
  killedNodes: NodeId[]
  addedPieces: PieceRec[]
  addedItems: ItemRec[]
  addedApertures: ApertureRec[]
  addedStrokes: StrokeRec[]
  deadPieces: RecordId[]
  deadItems: RecordId[]
  deadApertures: RecordId[]
  deadStrokes: RecordId[]
  /** Records/cells refused by validation or a cap. */
  dropped: number
  /** The sender's build grid did not fingerprint like ours, so its
   * slot-addressed pieces were refused. Surfaced so the HUD can say so
   * instead of the player wondering where the walls went. */
  refusedGrid: boolean
}

export function emptyEffects(): SharedEffects {
  return {
    resetNodes: [],
    removedCells: new Map(),
    brokenSegments: new Map(),
    killedNodes: [],
    addedPieces: [],
    addedItems: [],
    addedApertures: [],
    addedStrokes: [],
    deadPieces: [],
    deadItems: [],
    deadApertures: [],
    deadStrokes: [],
    dropped: 0,
    refusedGrid: false,
  }
}

export function effectsAreEmpty(fx: SharedEffects): boolean {
  return (
    fx.resetNodes.length === 0 &&
    fx.removedCells.size === 0 &&
    fx.brokenSegments.size === 0 &&
    fx.killedNodes.length === 0 &&
    fx.addedPieces.length === 0 &&
    fx.addedItems.length === 0 &&
    fx.addedApertures.length === 0 &&
    fx.addedStrokes.length === 0 &&
    fx.deadPieces.length === 0 &&
    fx.deadItems.length === 0 &&
    fx.deadApertures.length === 0 &&
    fx.deadStrokes.length === 0
  )
}

// ── Validation (every remote input is hostile) ──────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const bounded = (v: unknown): v is number => finite(v) && Math.abs(v) <= WORLD_BOUND_M
const smallInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max

function saneStamp(rec: Stamped): boolean {
  return isSafeId(rec.id, MAX_RECORD_ID_LEN) && smallInt(rec.lamport, Number.MAX_SAFE_INTEGER)
}

const saneYaw = (v: unknown): v is number => finite(v) && Math.abs(v) <= Math.PI * 4

export function sanePiece(rec: PieceRec): boolean {
  if (!saneStamp(rec)) return false
  if (!(PIECE_KINDS as readonly string[]).includes(rec.kind)) return false
  if (!isSafeId(rec.slot, MAX_SLOT_ID_LEN)) return false
  if (!smallInt(rec.mask, MAX_PIECE_MASK)) return false
  if (!saneYaw(rec.yaw)) return false
  if (!finite(rec.height) || rec.height < 0 || rec.height > MAX_PIECE_HEIGHT_M) return false
  if (rec.corners !== null) {
    if (!Array.isArray(rec.corners) || rec.corners.length !== 4) return false
    for (const c of rec.corners) if (!bounded(c)) return false
  }
  return true
}

export function saneItem(rec: ItemRec): boolean {
  return (
    saneStamp(rec) &&
    isSafeId(rec.catalogId, MAX_CATALOG_ID_LEN) &&
    bounded(rec.x) &&
    bounded(rec.y) &&
    bounded(rec.z) &&
    saneYaw(rec.yaw)
  )
}

/** Apertures are HOST-RELATIVE (u,v along the wall, plus a size), exactly as
 * PlacedAperture stores them — so they survive a peer whose grid anchor
 * differs, and so `collapseHostedApertures` can find them by wall id. */
export function saneAperture(rec: ApertureRec): boolean {
  return (
    saneStamp(rec) &&
    isSafeId(rec.catalogId, MAX_CATALOG_ID_LEN) &&
    isSafeId(rec.host, MAX_NODE_ID_LEN) &&
    bounded(rec.u) &&
    bounded(rec.v) &&
    finite(rec.width) &&
    rec.width > 0 &&
    rec.width <= MAX_APERTURE_M &&
    finite(rec.height) &&
    rec.height > 0 &&
    rec.height <= MAX_APERTURE_M
  )
}

/**
 * A stroke carries the BALL, not the cells it hit. Two reasons: the cell list
 * of one splat is up to a few hundred keys (the ball is ~0.35 m across a
 * 0.06 m grid) where the ball is 5 numbers, and a remote client may not have
 * the same voxel grid materialized yet — expanding the ball locally, later,
 * against whatever grid exists is both smaller AND tier-independent.
 */
export function saneStroke(rec: StrokeRec): boolean {
  return (
    saneStamp(rec) &&
    isSafeId(rec.node, MAX_NODE_ID_LEN) &&
    smallInt(rec.color, MAX_PAINT_COLORS - 1) &&
    bounded(rec.x) &&
    bounded(rec.y) &&
    bounded(rec.z) &&
    finite(rec.radius) &&
    rec.radius > 0 &&
    rec.radius <= MAX_STROKE_RADIUS_M
  )
}

const SANE: { [L in Lane]: (rec: never) => boolean } = {
  pieces: sanePiece as (rec: never) => boolean,
  items: saneItem as (rec: never) => boolean,
  apertures: saneAperture as (rec: never) => boolean,
  strokes: saneStroke as (rec: never) => boolean,
}

/**
 * Canonical serialization of a record — the FINAL tie-break of the join, so
 * that even a peer replaying someone else's record id at the same lamport
 * cannot make two clients disagree. Field order is fixed here forever;
 * adding a field appends to the end.
 */
export function canonOf(lane: Lane, rec: Stamped): string {
  switch (lane) {
    case 'pieces': {
      const p = rec as PieceRec
      return `${p.id}|${p.lamport}|${p.kind}|${p.slot}|${p.mask}|${p.yaw}|${p.height}|${p.corners ? p.corners.join(',') : ''}`
    }
    case 'items': {
      const i = rec as ItemRec
      return `${i.id}|${i.lamport}|${i.catalogId}|${i.x}|${i.y}|${i.z}|${i.yaw}`
    }
    case 'apertures': {
      const a = rec as ApertureRec
      return `${a.id}|${a.lamport}|${a.catalogId}|${a.host}|${a.u}|${a.v}|${a.width}|${a.height}`
    }
    case 'strokes': {
      const s = rec as StrokeRec
      return `${s.id}|${s.lamport}|${s.node}|${s.color}|${s.x}|${s.y}|${s.z}|${s.radius}`
    }
  }
}

/** The join of two competing records for one id: higher lamport, then the
 * greater canonical form. Total and order-free. */
function joinRecord<T extends Stamped>(lane: Lane, a: T, b: T): T {
  if (a.lamport !== b.lamport) return a.lamport > b.lamport ? a : b
  return canonOf(lane, a) >= canonOf(lane, b) ? a : b
}

// ── The join ────────────────────────────────────────────────────────────────

/**
 * MERGE — the whole convergence story in one function.
 *
 *   mergeDelta(world, delta) applies `delta` to `world` and reports what
 *   changed. It is:
 *     idempotent    merging the same delta twice changes nothing the second
 *                   time (sets, max, boolean-or);
 *     commutative   the order two deltas arrive in cannot change the result;
 *     associative   batching deltas cannot change the result.
 *
 * `sender` is the peer the TRANSPORT says sent this (bus envelope
 * `sessionId`), not `delta.from`. It gates authorship: a peer may only add
 * records under its own id prefix.
 *
 * NULL IS NOT A TRUSTED RELAY. It means "this frame came out of THIS client's
 * own model" — replaying our own snapshot, or a test fixture — and it skips
 * both the authorship gate and the grid gate for exactly that reason. The bus
 * never produces it: every inbound frame carries a host-stamped
 * `msg.sessionId`, so net-world.ts always passes a real peer. There is no
 * channel on which somebody else's aggregate could arrive vouched for, which
 * is why late join is answered by every peer with its OWN records rather than
 * by one peer relaying the room.
 */
export function mergeDelta(
  world: SharedWorld,
  delta: SharedDelta,
  sender: PeerId | null,
  fx: SharedEffects = emptyEffects(),
): SharedEffects {
  // Not even "is this the right protocol" may be asked of a value that might
  // not be an object: the transport hands us whatever a peer serialized, and
  // `null` is a legal JSON document.
  if (delta === null || typeof delta !== 'object' || (delta as SharedDelta).v !== 1) {
    fx.dropped++
    world.dropped++
    return fx
  }
  // A sender the transport cannot name safely gets nothing merged. Refusing
  // the whole frame (rather than the lanes) is correct: we would have no way
  // to attribute its records, and unattributed records are the one thing the
  // authorship gate exists to prevent.
  if (sender !== null && !isSafePeerId(sender)) {
    fx.dropped++
    world.dropped++
    return fx
  }
  // Raise our lamport to at least what we have seen — clamped, so a peer
  // shouting 2^53 cannot make every future local stamp lose forever.
  if (smallInt(delta.lamport, Number.MAX_SAFE_INTEGER)) {
    world.clock = Math.max(world.clock, Math.min(delta.lamport, world.clock + LAMPORT_JUMP_CAP))
  }

  mergeNodes(world, delta, fx)

  // GRID GATE. `pieces` are addressed by slot id ("Wx:3,-1,0"), which is only
  // a world address relative to grid.ts's module-level anchor and storey
  // ladder. If the sender's grid does not fingerprint the same as ours, its
  // slot names point somewhere else entirely, so we take everything EXCEPT
  // the slot-addressed lane. Tombstones are slot-free (they name a record id)
  // so they still apply — a piece can always be destroyed.
  const slotsOk = sender === null || (delta.gridStamp !== 0 && delta.gridStamp === world.gridStamp)
  if (!slotsOk) {
    fx.refusedGrid = true
    if (Array.isArray(delta.pieces)) fx.dropped += delta.pieces.length
  }
  mergeLane(
    world,
    'pieces',
    slotsOk ? delta.pieces : undefined,
    delta.deadPieces,
    sender,
    fx,
    fx.addedPieces,
    fx.deadPieces,
  )
  mergeLane(world, 'items', delta.items, delta.deadItems, sender, fx, fx.addedItems, fx.deadItems)
  mergeLane(
    world,
    'apertures',
    delta.apertures,
    delta.deadApertures,
    sender,
    fx,
    fx.addedApertures,
    fx.deadApertures,
  )
  mergeLane(
    world,
    'strokes',
    delta.strokes,
    delta.deadStrokes,
    sender,
    fx,
    fx.addedStrokes,
    fx.deadStrokes,
  )
  world.applied++
  world.dropped += fx.dropped
  return fx
}

function mergeNodes(world: SharedWorld, delta: SharedDelta, fx: SharedEffects): void {
  if (!Array.isArray(delta.nodes)) return
  let seen = 0
  for (const nd of delta.nodes) {
    if (++seen > MAX_NODES_PER_FRAME) {
      fx.dropped++
      break
    }
    if (!nd || !isSafeId(nd.nodeId, MAX_NODE_ID_LEN) || !smallInt(nd.epoch, LAMPORT_JUMP_CAP)) {
      fx.dropped++
      continue
    }
    const known = world.nodes.get(nd.nodeId)
    if (!known && world.nodes.size >= MAX_MODEL_NODES) {
      fx.dropped++
      continue
    }
    const dmg = known ?? nodeDamage(world, nd.nodeId)

    if (nd.epoch < dmg.epoch) {
      // Stale generation: the node was restored since. Silently ignored —
      // this is the ONLY place the model discards well-formed damage, and it
      // is what makes the restore path composable with a grow-only set.
      continue
    }
    if (nd.epoch > dmg.epoch) {
      dmg.epoch = nd.epoch
      dmg.removed.clear()
      dmg.mine.clear()
      dmg.segments.clear()
      dmg.mySegments.clear()
      dmg.killed = false
      dmg.killedByMe = false
      if (!fx.resetNodes.includes(nd.nodeId)) fx.resetNodes.push(nd.nodeId)
      // A reset supersedes any newly-removed cells reported for the OLD
      // epoch earlier in this same merge.
      fx.removedCells.delete(nd.nodeId)
      fx.brokenSegments.delete(nd.nodeId)
      const wasKilled = fx.killedNodes.indexOf(nd.nodeId)
      if (wasKilled >= 0) fx.killedNodes.splice(wasKilled, 1)
    }

    if (Array.isArray(nd.removed)) {
      let cells = 0
      let fresh: CellKey[] | undefined
      for (const key of nd.removed) {
        if (++cells > MAX_CELLS_PER_NODE) {
          fx.dropped++
          break
        }
        if (!isCellKey(key)) {
          fx.dropped++
          continue
        }
        if (dmg.removed.has(key)) continue
        dmg.removed.add(key)
        if (!fresh) {
          fresh = fx.removedCells.get(nd.nodeId) ?? []
          fx.removedCells.set(nd.nodeId, fresh)
        }
        fresh.push(key)
      }
      if (fresh) fresh.sort((a, b) => a - b)
    }

    if (Array.isArray(nd.segments)) {
      let count = 0
      let fresh: number[] | undefined
      for (const id of nd.segments) {
        if (++count > MAX_SEGMENTS_PER_NODE) {
          fx.dropped++
          break
        }
        if (!smallInt(id, MAX_SEGMENT_ID)) {
          fx.dropped++
          continue
        }
        if (dmg.segments.has(id)) continue
        dmg.segments.add(id)
        if (!fresh) {
          fresh = fx.brokenSegments.get(nd.nodeId) ?? []
          fx.brokenSegments.set(nd.nodeId, fresh)
        }
        fresh.push(id)
      }
      if (fresh) fresh.sort((a, b) => a - b)
    }

    if (nd.killed === true && !dmg.killed) {
      dmg.killed = true
      if (!fx.killedNodes.includes(nd.nodeId)) fx.killedNodes.push(nd.nodeId)
    }
  }
}

function mergeLane<T extends Stamped>(
  world: SharedWorld,
  lane: Lane,
  adds: readonly T[] | undefined,
  dead: readonly RecordId[] | undefined,
  sender: PeerId | null,
  fx: SharedEffects,
  added: T[],
  removed: RecordId[],
): void {
  const set = world[lane] as unknown as OrSet<T>
  const sane = SANE[lane] as unknown as (rec: T) => boolean

  if (Array.isArray(adds)) {
    let seen = 0
    for (const rec of adds) {
      if (++seen > MAX_RECORDS_PER_FRAME) {
        fx.dropped++
        break
      }
      if (!rec || typeof rec !== 'object' || !sane(rec)) {
        fx.dropped++
        continue
      }
      // AUTHORSHIP: a peer may only mint ids under its own prefix. This is
      // the whole defence against "peer B overwrites peer A's wall" — B
      // cannot even name A's record, let alone replace it.
      if (sender !== null && !isAuthoredBy(rec.id, sender)) {
        fx.dropped++
        continue
      }
      const prior = set.adds.get(rec.id)
      if (prior) {
        const winner = joinRecord(lane, prior, rec)
        if (winner !== prior) {
          set.adds.set(rec.id, winner)
          if (!set.dead.has(rec.id)) added.push(winner)
        }
        continue
      }
      if (set.adds.size >= MAX_MODEL_RECORDS) {
        fx.dropped++
        continue
      }
      set.adds.set(rec.id, rec)
      if (!set.dead.has(rec.id)) added.push(rec)
    }
  }

  if (Array.isArray(dead)) {
    let seen = 0
    for (const id of dead) {
      if (++seen > MAX_TOMBSTONES_PER_FRAME) {
        fx.dropped++
        break
      }
      if (!isSafeId(id, MAX_RECORD_ID_LEN)) {
        fx.dropped++
        continue
      }
      if (set.dead.has(id)) continue
      if (set.dead.size >= MAX_MODEL_TOMBSTONES) {
        fx.dropped++
        continue
      }
      set.dead.add(id)
      removed.push(id)
      // A record added earlier in THIS merge and killed later in it never
      // reaches the game.
      const pending = added.findIndex((rec) => rec.id === id)
      if (pending >= 0) added.splice(pending, 1)
    }
  }
}

// ── The Save-bridge boundary ────────────────────────────────────────────────

/**
 * The LOCAL player's work, and nothing else — the only projection the four
 * Save bridges (keep.ts, save-demolition.ts, paint-keep.ts, item-keep.ts)
 * may ever consume. A stranger's holes, pieces, items and paint are visible,
 * shootable and shared, but they are NOT yours to commit to the document:
 * the non-destructive invariant is per client, and a peer's state reaching a
 * scene write would violate it on the peer's behalf.
 *
 * Voxel damage has no per-cell author on the wire, so `mine` is the local
 * annotation that answers it; records answer it from their id prefix.
 * `killedByMe` is likewise local, which is why save-demolition only ever
 * deletes nodes THIS player finished off.
 */
export type LocalWork = {
  /** node → cells this client removed (ascending). */
  cells: Map<NodeId, CellKey[]>
  /** node → framing sticks this client broke (ascending). */
  segments: Map<NodeId, number[]>
  /** Nodes this client collapsed whole. */
  killed: NodeId[]
  pieces: PieceRec[]
  items: ItemRec[]
  apertures: ApertureRec[]
  strokes: StrokeRec[]
}

export function localWork(world: SharedWorld): LocalWork {
  const cells = new Map<NodeId, CellKey[]>()
  const segments = new Map<NodeId, number[]>()
  const killed: NodeId[] = []
  for (const nodeId of damagedNodes(world)) {
    const dmg = world.nodes.get(nodeId)!
    if (dmg.mine.size > 0) {
      const keys = [...dmg.mine]
      keys.sort((a, b) => a - b)
      cells.set(nodeId, keys)
    }
    if (dmg.mySegments.size > 0) {
      const ids = [...dmg.mySegments]
      ids.sort((a, b) => a - b)
      segments.set(nodeId, ids)
    }
    if (dmg.killedByMe) killed.push(nodeId)
  }
  const mine = <T extends Stamped>(lane: OrSet<T>): T[] =>
    liveRecords(lane).filter((rec) => isAuthoredBy(rec.id, world.self))
  return {
    cells,
    segments,
    killed,
    pieces: mine(world.pieces),
    items: mine(world.items),
    apertures: mine(world.apertures),
    strokes: mine(world.strokes),
  }
}

// ── Grid fingerprint ────────────────────────────────────────────────────────

/**
 * Declare this client's build-grid fingerprint (see gridStamp() in
 * shared-derive.ts). The wiring layer calls this once the lot is loaded and
 * again after any anchor change; frames published before it are stamped 0 and
 * their pieces will be refused by every receiver, which is the safe default.
 */
export function setGridStamp(world: SharedWorld, stamp: number): void {
  world.gridStamp = smallInt(stamp, 0xffffffff) ? stamp : 0
}

// ── Teardown ────────────────────────────────────────────────────────────────

/** Forget everything (session exit). The peer id and serial survive so a
 * re-entry in the same tab cannot re-mint ids it already published. */
export function resetSharedWorld(world: SharedWorld): void {
  world.nodes.clear()
  world.pieces = emptyOrSet()
  world.items = emptyOrSet()
  world.apertures = emptyOrSet()
  world.strokes = emptyOrSet()
  world.journal = emptyJournal()
  world.clock = 0
  world.dropped = 0
  world.applied = 0
  world.unsent = 0
}

/** Plain-data QA dump for the `__boots` handle — copies, never live refs. */
export function sharedWorldDebug(world: SharedWorld): {
  self: PeerId
  clock: number
  nodes: number
  cells: number
  segments: number
  killed: number
  pieces: number
  items: number
  apertures: number
  strokes: number
  dropped: number
  applied: number
  /** Cells + records still owed to the room (see takePending). */
  pending: number
  /** Frames taken and handed back unsent (coalesced, refused, oversize). */
  unsent: number
} {
  let cells = 0
  let segments = 0
  let killed = 0
  for (const dmg of world.nodes.values()) {
    cells += dmg.removed.size
    segments += dmg.segments.size
    if (dmg.killed) killed++
  }
  return {
    self: world.self,
    clock: world.clock,
    nodes: world.nodes.size,
    cells,
    segments,
    killed,
    pieces: liveRecords(world.pieces).length,
    items: liveRecords(world.items).length,
    apertures: liveRecords(world.apertures).length,
    strokes: liveRecords(world.strokes).length,
    dropped: world.dropped,
    applied: world.applied,
    pending: (() => {
      const p = pendingCount(world)
      return p.cells + p.segments + p.records + p.tombstones
    })(),
    unsent: world.unsent,
  }
}
