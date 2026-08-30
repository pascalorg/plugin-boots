/**
 * shared-damage.ts — the two-way bridge between the live destruction runtime
 * and the convergent shared world.
 *
 * WHY THIS MODULE EXISTS
 *
 * shared-world.ts is a lattice: grow-only sets of dead cells and snapped
 * framing sticks per node, a monotone `killed` bit, and an epoch for the one
 * non-monotone operation (the sealed-door handback). It knows nothing about
 * three.js, voxel grids, render tiers or zustand. destruction.ts is the exact
 * opposite: 5k lines of frame budgets, lazy shells, dormant prebuilds, pooled
 * scratch vectors and Math.random(). Wiring them directly would drag one into
 * the other, so everything crosses here, in one file, in one direction.
 *
 * THE THREE RULES THIS FILE ENFORCES
 *
 * 1. REPLICATE OUTCOMES, NOT INTENTS. The carve path is soaked in
 *    Math.random(): a SMASH hit picks 4-6 nibbles at random offsets and radii,
 *    islands crumble with jittered seeds, the explosion pass caps at 48 sticks
 *    in Map order. A peer that re-simulated "player X shot here" would carve a
 *    different hole and the two screens would diverge forever. So the shooter
 *    carves locally and publishes the CELL SET that actually died. Same for
 *    segments: which sticks broke is replicated, never recomputed.
 *
 * 2. CELLS ARE GRID COORDINATES, NEVER VOXEL INDICES. The compact index into
 *    `grid.alive` is an artifact of the local build: thin-axis skinning,
 *    dropInteriorCells and the MAX_VOXELS truncation all mean two clients can
 *    give the same physical cell a different index. The lattice coordinate
 *    (ix, iy, iz) is the same on every client that voxelized the same node, so
 *    that is what goes on the wire (packed by cellKey, 10 bits per axis).
 *    Index ⇄ key conversion happens here and nowhere else.
 *
 * 3. RENDER TIER IS IRRELEVANT TO CORRECTNESS. Remote damage arrives for nodes
 *    the local player has never walked near — dormant prebuilds, shellPending
 *    placeholders, nodes with no voxel target at all yet. Every applied effect
 *    therefore begins by forcing the target into existence. Applying is
 *    idempotent, so a late-joining client folding a snapshot lands in exactly
 *    the state a client that watched it happen live is already in.
 *
 * SINGLE PLAYER IS BYTE-IDENTICAL. `sync` is null until something injects it.
 * Every publish entry point starts with that null check and returns before it
 * touches the world, allocates, sorts or reads a grid. The call sites in
 * destruction.ts and shooting.ts are unconditional calls to functions that do
 * nothing, which is what keeps the hot path free of `if (multiplayer)` noise
 * and keeps offline play provably unchanged (shared-damage-solo.test.ts).
 *
 * NO NETWORKING. This module does not know a socket exists. It is handed a
 * `publish` callback and a world; tests drive both directly.
 */

import { canonicalCellOrder, canonicalNodeOrder } from './shared-derive'
import {
  cellIx,
  cellIy,
  cellIz,
  cellKey,
  CELL_AXIS_MAX,
  emptyDelta,
  isCellKey,
  localWork,
  MAX_CELLS_PER_NODE,
  MAX_NODES_PER_FRAME,
  MAX_SEGMENTS_PER_NODE,
  MAX_SEGMENT_ID,
  nodeDamage,
  noteLocalKill,
  noteLocalRemoval,
  noteLocalReset,
  noteLocalSegments,
  type CellKey,
  type NodeDelta,
  type NodeId,
  type SharedDelta,
  type SharedEffects,
  type SharedWorld,
} from './shared-world'
import { setDemolitionWork } from './save-demolition'

// ── The shape of the runtime, structurally ──────────────────────────────────

/**
 * The slice of voxel.ts's VoxelGridData this bridge reads. Declared
 * structurally rather than imported so shared-damage stays a leaf that
 * destruction.ts depends on, not the reverse — and so unit tests can build a
 * grid literal with no three.js in the room.
 */
export type DamageGrid = {
  readonly nx: number
  readonly ny: number
  readonly nz: number
  /** Number of voxels that exist in this grid (alive or not). */
  readonly count: number
  /** ix, iy, iz per voxel index. */
  readonly coords: Int16Array
  /** 1 = still standing. */
  readonly alive: Uint8Array
  /** latticeKey(ix,iy,iz) → voxel index. */
  readonly index: ReadonlyMap<number, number>
}

/** The slice of a VoxelTarget this bridge reads. */
export type DamageTargetLike = {
  readonly nodeId: NodeId
  readonly grid: DamageGrid
}

/**
 * voxel.ts's flat linearization of the lattice. It is deliberately private
 * over there (nothing outside the voxel module should be addressing cells by
 * a packed local index), so it is MIRRORED here rather than exported — the one
 * line of duplication in this bridge. If voxel.ts ever changes its
 * linearization, `cellRoundTripsThroughGrid` in shared-damage.test.ts fails.
 */
const latticeKey = (ix: number, iy: number, iz: number, nx: number, ny: number): number =>
  ix + nx * (iy + ny * iz)

/**
 * A grid whose lattice does not fit in a CellKey cannot be shared: the key
 * packs 10 bits per axis, so an axis of 1024 or more cells would alias two
 * different places onto one key. No real building comes close (the largest
 * voxelized wall in the game is a few dozen cells on its long axis), but a
 * silent alias would be a divergence bug of the worst kind, so it is checked
 * and refused instead.
 */
export const gridIsShareable = (grid: DamageGrid): boolean =>
  grid.nx > 0 &&
  grid.ny > 0 &&
  grid.nz > 0 &&
  grid.nx <= CELL_AXIS_MAX &&
  grid.ny <= CELL_AXIS_MAX &&
  grid.nz <= CELL_AXIS_MAX

/** Voxel index → wire cell key, or -1 when the index is out of range. */
export function keyOfIndex(grid: DamageGrid, index: number): CellKey | -1 {
  if (!Number.isInteger(index) || index < 0 || index >= grid.count) return -1
  const ix = grid.coords[index * 3]
  const iy = grid.coords[index * 3 + 1]
  const iz = grid.coords[index * 3 + 2]
  if (ix === undefined || iy === undefined || iz === undefined) return -1
  if (ix < 0 || iy < 0 || iz < 0) return -1
  if (ix >= CELL_AXIS_MAX || iy >= CELL_AXIS_MAX || iz >= CELL_AXIS_MAX) return -1
  return cellKey(ix, iy, iz)
}

/**
 * Wire cell key → local voxel index, or -1 when this client has no such
 * voxel. A miss is NORMAL and not an error: the sender's grid may have kept a
 * cell that this client's skinning dropped, or the sender may have been under
 * the MAX_VOXELS truncation on a different frame. Dropping the cell is the
 * right answer — there is nothing local to remove.
 */
export function indexOfKey(grid: DamageGrid, key: CellKey): number {
  if (!isCellKey(key)) return -1
  const ix = cellIx(key)
  const iy = cellIy(key)
  const iz = cellIz(key)
  if (ix >= grid.nx || iy >= grid.ny || iz >= grid.nz) return -1
  const index = grid.index.get(latticeKey(ix, iy, iz, grid.nx, grid.ny))
  return index === undefined ? -1 : index
}

/** Voxel indices → wire cell keys, in canonical order, unknowns dropped. */
export function keysOfIndices(grid: DamageGrid, indices: Iterable<number>): CellKey[] {
  const keys: CellKey[] = []
  for (const index of indices) {
    const key = keyOfIndex(grid, index)
    if (key !== -1) keys.push(key)
  }
  return canonicalCellOrder(keys)
}

// ── Injection points ────────────────────────────────────────────────────────

/** Where a built frame goes. The bridge never knows what is on the far side. */
export type DamagePublish = (delta: SharedDelta) => void

export type DamageSync = {
  world: SharedWorld
  publish: DamagePublish
}

/**
 * What the bridge is allowed to do to the live scene when a stranger's damage
 * lands. Injected by destruction.ts, which owns all of it; kept as an
 * interface so shared-damage.test.ts can assert the exact call sequence
 * without a renderer.
 */
export type DamageRuntime = {
  /**
   * Force the local voxel target for `nodeId` into existence, whatever tier it
   * is in — dormant prebuild, shellPending placeholder, or nothing at all.
   * Returns null when the node cannot be voxelized on this client (it may not
   * even be in this client's scene yet), in which case the effect is counted
   * as deferred rather than applied.
   */
  materialize: (nodeId: NodeId) => DamageTargetLike | null
  /** Kill these voxel indices. Already filtered to ones that are alive. */
  removeCells: (target: DamageTargetLike, indices: readonly number[]) => void
  /** Snap these framing sticks. Idempotent per stick. */
  breakSegments: (target: DamageTargetLike, ids: readonly number[]) => void
  /** Collapse the whole node (the replicated `killed` bit). Idempotent. */
  killNode: (nodeId: NodeId) => void
  /** The sealed-door handback: restore the node to pristine. Idempotent. */
  resetNode: (nodeId: NodeId) => void
}

let sync: DamageSync | null = null
let runtime: DamageRuntime | null = null

/**
 * Turn the damage lane on (a shared session started) or off (single player,
 * or session exit). Also hands the Save bridge its one door onto the shared
 * model: a getter for LocalWork, so `deleteDestroyed()` can tell the player's
 * own demolition from a stranger's rubble. Passing null restores exact
 * single-player behaviour, including in the middle of a session.
 */
export function setDamageSync(next: DamageSync | null): void {
  sync = next
  pending = null
  batchDepth = 0
  remoteDepth = 0
  setDemolitionWork(next === null ? null : () => localWork(next.world))
}

/** Register what the bridge may do to the scene. */
export function setDamageRuntime(next: DamageRuntime | null): void {
  runtime = next
}

/** Is the damage lane live? The hot path never asks; QA and tests do. */
export const damageSyncActive = (): boolean => sync !== null

/**
 * Drop in-flight staging without touching the injected sync or runtime.
 * Called from resetDestruction() so a session teardown mid-batch cannot leak
 * half a frame into the next one.
 */
export function resetSharedDamage(): void {
  pending = null
  batchDepth = 0
  remoteDepth = 0
}

// ── Publishing ──────────────────────────────────────────────────────────────

/**
 * The frame being assembled. Null whenever there is nothing to send, which is
 * always in single player: no Map is allocated until the first shot of a
 * shared session lands.
 */
let pending: Map<NodeId, NodeDelta> | null = null
let batchDepth = 0
/**
 * Depth of the apply stack. While it is above zero every publish entry point
 * returns immediately: a cascade that this client DERIVED from a stranger's
 * shot is not this client's work, and claiming it would let a stranger's kills
 * ride into the owner's Save on our authorship. The damage still happens
 * locally (the collapse is derived, not replicated) — it is just not ours.
 */
let remoteDepth = 0

const pendingNode = (nodeId: NodeId): NodeDelta => {
  const map = (pending ??= new Map())
  let entry = map.get(nodeId)
  if (entry === undefined) {
    entry = { nodeId, epoch: 0, removed: [], segments: [], killed: false, reset: false }
    map.set(nodeId, entry)
  }
  return entry
}

/**
 * Open a batch. Everything published until the matching end lands in ONE
 * frame: one trigger pull is one delta, not five (a SMASH hit carves 4-6
 * random nibbles, and each is a separate removeSphere). Nestable, because
 * `fire()` wraps `carve()` which can fan out to a roof group's planes.
 */
export function beginDamageBatch(): void {
  if (sync === null) return
  batchDepth++
}

/** Close a batch; the outermost close sends the frame. */
export function endDamageBatch(): void {
  if (sync === null) return
  if (batchDepth > 0) batchDepth--
  if (batchDepth === 0) flushDamage()
}

/**
 * Run `body` as one published frame. Exception-safe: a throw inside the carve
 * still closes the batch, so a bug in destruction cannot wedge the lane into
 * "forever batching".
 */
export function inDamageBatch<T>(body: () => T): T {
  if (sync === null) return body()
  beginDamageBatch()
  try {
    return body()
  } finally {
    endDamageBatch()
  }
}

const autoFlush = (): void => {
  if (batchDepth === 0) flushDamage()
}

/**
 * Cells this client just killed on `target`, given the voxel indices that
 * removeSphere (or a collapse walk) reported as alive→dead. Indices are
 * converted to lattice keys here; only genuinely-new keys reach the wire.
 */
export function publishRemovedCells(
  target: DamageTargetLike,
  indices: readonly number[] | ReadonlyArray<number>,
): void {
  if (sync === null || remoteDepth > 0) return
  if (indices.length === 0) return
  if (!gridIsShareable(target.grid)) return
  publishRemovedKeys(target.nodeId, keysOfIndices(target.grid, indices))
}

/** Same, when the caller already holds lattice keys. */
export function publishRemovedKeys(nodeId: NodeId, keys: readonly CellKey[]): void {
  if (sync === null || remoteDepth > 0) return
  if (keys.length === 0) return
  const fresh = noteLocalRemoval(sync.world, nodeId, keys)
  if (fresh.length === 0) return
  const entry = pendingNode(nodeId)
  for (const key of fresh) entry.removed.push(key)
  autoFlush()
}

/**
 * Framing sticks this client just snapped. These are replicated rather than
 * derived for the same reason cells are: EXPLOSION_SEGMENT_CAP stops the
 * explosion pass after 48 sticks, and WHICH 48 depends on Map iteration order,
 * i.e. on where the player happened to stand when the wall was voxelized.
 */
export function publishBrokenSegments(nodeId: NodeId, ids: readonly number[]): void {
  if (sync === null || remoteDepth > 0) return
  if (ids.length === 0) return
  const fresh = noteLocalSegments(sync.world, nodeId, ids)
  if (fresh.length === 0) return
  const entry = pendingNode(nodeId)
  for (const id of fresh) entry.segments.push(id)
  autoFlush()
}

/** One stick. */
export function publishBrokenSegment(nodeId: NodeId, id: number): void {
  if (sync === null || remoteDepth > 0) return
  publishBrokenSegments(nodeId, [id])
}

/**
 * This client collapsed a whole node. The bit is what a peer that has never
 * materialized the node can obey without knowing its grid at all; the cells
 * are published alongside it (by the collapse walk) so that `mine` stays
 * truthful for the Save gate.
 */
export function publishKilledNode(nodeId: NodeId): void {
  if (sync === null || remoteDepth > 0) return
  if (!noteLocalKill(sync.world, nodeId)) return
  pendingNode(nodeId).killed = true
  autoFlush()
}

/**
 * The one non-monotone operation: restoreOperableTarget handing a sealed door
 * back to the host. A grow-only set cannot express "un-destroyed", so the node
 * gets a new epoch — higher epoch wins outright and clears the old sets on
 * every receiver, including this one.
 *
 * This flushes immediately even inside a batch, because the epoch it publishes
 * must not be batched behind removals at the OLD epoch: those would be
 * stamped with the new epoch and resurrect as post-restore damage.
 */
export function publishNodeReset(nodeId: NodeId): void {
  if (sync === null || remoteDepth > 0) return
  flushDamage()
  const epoch = noteLocalReset(sync.world, nodeId)
  const entry = pendingNode(nodeId)
  entry.reset = true
  entry.epoch = epoch
  entry.removed.length = 0
  entry.segments.length = 0
  entry.killed = false
  flushDamage()
}

/**
 * Send everything staged, as one or more frames.
 *
 * The loop exists for the wire caps: a frame carries at most
 * MAX_NODES_PER_FRAME nodes and at most MAX_CELLS_PER_NODE cells per node, and
 * a whole-lot explosion can exceed both. Anything over a cap stays staged and
 * goes out in the next frame, so nothing is ever silently dropped.
 *
 * Node order is canonicalNodeOrder and cell order is canonicalCellOrder — not
 * for the receiver's benefit (merging is a set union, order-free) but because
 * a frame that is a pure function of its content is one that can be compared,
 * hashed and golden-tested. Map order here is prevoxelization order, which is
 * to say it depends on where the player was standing.
 */
export function flushDamage(): void {
  const live = sync
  if (live === null || pending === null) return
  let guard = 0
  while (pending !== null && pending.size > 0 && guard++ < 64) {
    const frame = emptyDelta(live.world.self)
    frame.lamport = live.world.clock
    frame.gridStamp = live.world.gridStamp
    let nodes = 0
    for (const nodeId of canonicalNodeOrder(pending.keys())) {
      if (nodes >= MAX_NODES_PER_FRAME) break
      const entry = pending.get(nodeId)
      if (entry === undefined) continue
      const cells = canonicalCellOrder(entry.removed)
      const segments = [...entry.segments].sort((a, b) => a - b)
      const cellsNow = cells.length > MAX_CELLS_PER_NODE ? cells.slice(0, MAX_CELLS_PER_NODE) : cells
      const segsNow =
        segments.length > MAX_SEGMENTS_PER_NODE ? segments.slice(0, MAX_SEGMENTS_PER_NODE) : segments
      frame.nodes.push({
        nodeId,
        // The epoch a reset ANNOUNCES is its own; every other frame reports the
        // node's current epoch so a receiver that has already restored the door
        // discards our stale holes instead of re-punching them.
        epoch: entry.reset ? entry.epoch : nodeDamage(live.world, nodeId).epoch,
        removed: cellsNow,
        segments: segsNow,
        killed: entry.killed,
        reset: entry.reset,
      })
      nodes++
      if (cellsNow.length === cells.length && segsNow.length === segments.length) {
        pending.delete(nodeId)
      } else {
        entry.removed = cells.slice(cellsNow.length)
        entry.segments = segments.slice(segsNow.length)
        entry.killed = false
        entry.reset = false
      }
    }
    if (frame.nodes.length === 0) break
    live.publish(frame)
  }
  if (pending !== null && pending.size === 0) pending = null
}

// ── Applying ───────────────────────────────────────────────────────────────

/** What one apply pass actually did, for QA and tests. Plain data. */
export type DamageApplyReport = {
  /** Nodes restored to pristine at a higher epoch. */
  resets: number
  /** Nodes forced into existence to receive remote damage. */
  materialized: number
  /** Cells killed locally. */
  cells: number
  /** Framing sticks snapped locally. */
  segments: number
  /** Whole nodes collapsed. */
  kills: number
  /** Cells that name no voxel on this client (skinning / truncation skew). */
  unknownCells: number
  /** Nodes this client cannot voxelize yet — the effect is dropped, and the
   * next snapshot fold will land it once the node exists. */
  deferred: number
}

const emptyReport = (): DamageApplyReport => ({
  resets: 0,
  materialized: 0,
  cells: 0,
  segments: 0,
  kills: 0,
  unknownCells: 0,
  deferred: 0,
})

/**
 * Make the local scene match what just merged.
 *
 * Ordering is deliberate and total:
 *
 *   resets first  — a restored door is pristine, and any removal for that node
 *                   in the same pass is post-restore damage that must land ON
 *                   the restored node, not be wiped by it.
 *   cells, then segments — a wall's cells and its studs are independent state;
 *                   doing cells first means a support settle triggered by the
 *                   last cell sees the studs in their pre-break state exactly
 *                   as a local carve would.
 *   kills last    — "the whole thing is gone" subsumes everything above it, so
 *                   it is applied after, never before, the partial damage.
 *
 * Every step materializes its target first. Every step is idempotent, so
 * folding a snapshot on top of a live session is a no-op where they agree.
 * The whole pass runs with the apply guard raised, so the local cascades it
 * provokes are applied but never re-published as this client's work.
 */
export function applySharedDamage(fx: SharedEffects): DamageApplyReport {
  const report = emptyReport()
  const live = runtime
  if (live === null) return report

  remoteDepth++
  try {
    for (const nodeId of canonicalNodeOrder(fx.resetNodes)) {
      live.resetNode(nodeId)
      report.resets++
    }

    for (const nodeId of canonicalNodeOrder(fx.removedCells.keys())) {
      const keys = fx.removedCells.get(nodeId)
      if (keys === undefined || keys.length === 0) continue
      const target = live.materialize(nodeId)
      if (target === null) {
        report.deferred++
        continue
      }
      report.materialized++
      if (!gridIsShareable(target.grid)) continue
      const indices: number[] = []
      for (const key of canonicalCellOrder(keys)) {
        const index = indexOfKey(target.grid, key)
        if (index === -1) {
          report.unknownCells++
          continue
        }
        if (target.grid.alive[index] === 0) continue
        indices.push(index)
      }
      if (indices.length === 0) continue
      live.removeCells(target, indices)
      report.cells += indices.length
    }

    for (const nodeId of canonicalNodeOrder(fx.brokenSegments.keys())) {
      const ids = fx.brokenSegments.get(nodeId)
      if (ids === undefined || ids.length === 0) continue
      const target = live.materialize(nodeId)
      if (target === null) {
        report.deferred++
        continue
      }
      const sane: number[] = []
      for (const id of ids) {
        if (Number.isInteger(id) && id >= 0 && id <= MAX_SEGMENT_ID) sane.push(id)
      }
      if (sane.length === 0) continue
      sane.sort((a, b) => a - b)
      live.breakSegments(target, sane)
      report.segments += sane.length
    }

    for (const nodeId of canonicalNodeOrder(fx.killedNodes)) {
      live.killNode(nodeId)
      report.kills++
    }
  } finally {
    remoteDepth--
  }
  return report
}

/**
 * Run `body` as if it were remote work: applied locally, never attributed to
 * this client. destruction.ts uses it for the rehydration path, where the
 * local runtime replays converged state it did not author.
 */
export function asRemoteDamage<T>(body: () => T): T {
  remoteDepth++
  try {
    return body()
  } finally {
    remoteDepth--
  }
}

/** True while a remote effect is being applied. Publishing is inert. */
export const applyingRemoteDamage = (): boolean => remoteDepth > 0

/** Plain-data dump for the `__boots` QA handle — copies, never live refs. */
export function sharedDamageDebug(): {
  active: boolean
  runtime: boolean
  batchDepth: number
  applying: boolean
  pendingNodes: number
  pendingCells: number
  pendingSegments: number
} {
  let pendingCells = 0
  let pendingSegments = 0
  if (pending !== null) {
    for (const entry of pending.values()) {
      pendingCells += entry.removed.length
      pendingSegments += entry.segments.length
    }
  }
  return {
    active: sync !== null,
    runtime: runtime !== null,
    batchDepth,
    applying: remoteDepth > 0,
    pendingNodes: pending === null ? 0 : pending.size,
    pendingCells,
    pendingSegments,
  }
}
