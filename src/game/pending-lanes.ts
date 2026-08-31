import { useScene } from '@pascal-app/core'
import { useBoots } from '../store'
import { isForeignPlacedPiece } from './builder'
import { OPENING_ENTRIES, placeableCatalog } from './inventory'
import { isForeignItemPlacement, useItems } from './item-place'
import { usePaintKeep } from './paint-keep'
import {
  browserPendingStorage,
  buildPendingSnapshot,
  currentPendingScope,
  forgetPendingSnapshot,
  isEmptyPending,
  type PendingLanes,
  type PendingSnapshot,
  type PersistedPlacement,
  prunePendingSnapshot,
  readPendingSnapshot,
  writePendingSnapshot,
} from './pending-store'
import { useDemolition } from './save-demolition'

/**
 * The pending window's two doors: read the four lanes out, put them back.
 *
 * pending-store.ts owns the FORMAT and touches no store; this file owns the
 * STORES and knows nothing about JSON. The split is what keeps the format
 * testable without a browser and this file short enough to audit — and it is
 * also the import fence: the catalog lane keeps its store module-private, so
 * the resolution of a saved `catalogId` back into a real menu row happens
 * here, next to the store, exactly as shared-build does it for a remote peer.
 *
 * Writes happen at Esc (session.ts) and at the decision (panel.tsx). Reads
 * happen once, when the plugin's in-canvas system mounts (system.tsx).
 */

/** Everything pending that is OURS.
 *
 * The foreign filters are the same ones Save applies (keep.ts, item-keep.ts,
 * and the panel's own list): in a shared world the stores also hold what other
 * players built, and their work must not be written into this document — but
 * more to the point here, it must not be written into our STORAGE either. The
 * runtime attribution set is per-page-load (shared-build.ts), so a stranger's
 * wall persisted today would come back tomorrow indistinguishable from ours,
 * with the foreign set empty and every downstream gate satisfied. Filtering at
 * capture time is what keeps that door shut.
 */
export function collectPendingLanes(): PendingLanes {
  const demolition = useDemolition.getState()
  return {
    destroyed: demolition.destroyed,
    items: useItems
      .getState()
      .items.filter((placement) => !isForeignItemPlacement(placement.id))
      .map(encodePlacement),
    mine: demolition.mine,
    painted: usePaintKeep.getState().painted,
    placed: useBoots.getState().placed.filter((piece) => !isForeignPlacedPiece(piece.id)),
  }
}

/** Write the current pending window down (or clear the key when the decision
 * has been made and nothing is left). A project we cannot name, or a browser
 * with no usable storage, is a silent no-op by design — the in-page behaviour
 * is unchanged and nothing else in the plugin depends on this succeeding. */
export function persistPendingChanges(): void {
  const storage = browserPendingStorage()
  const scope = currentPendingScope()
  if (!storage || !scope) return
  const lanes = collectPendingLanes()
  if (isEmptyPending(lanes)) {
    forgetPendingSnapshot(storage, scope)
    return
  }
  const result = writePendingSnapshot(storage, scope, buildPendingSnapshot(lanes, Date.now()))
  if (result === 'too-big' || result === 'failed') {
    // Never silent: a fort that will not survive the reload has to say so
    // rather than look saved. The in-memory decision is untouched.
    console.warn(
      `[boots] pending changes could not be saved for later (${result}) — they are still pending in this tab, decide before reloading`,
    )
  }
}

/** Forget the stored window without touching the live lanes. Only the tests
 * and an explicit reset need this; Save and Discard both go through
 * `persistPendingChanges`, which clears the key because the lanes are empty. */
export function forgetPendingChanges(): void {
  const storage = browserPendingStorage()
  const scope = currentPendingScope()
  if (storage && scope) forgetPendingSnapshot(storage, scope)
}

export type PendingRestoreReport = {
  pieces: number
  items: number
  apertures: number
  /** Rows the format refused (corrupt or from another version). */
  skipped: number
  /** Rows whose host node is gone from the document. */
  stale: number
  /** Placements whose catalog row no longer exists in this build. */
  unknown: number
}

const EMPTY_REPORT: PendingRestoreReport = {
  apertures: 0,
  items: 0,
  pieces: 0,
  skipped: 0,
  stale: 0,
  unknown: 0,
}

/**
 * Restored once per project per page load. A remount of the in-canvas system
 * (a resize that recreates the canvas, a strict-mode double mount, a version
 * preview toggling the tree) must not add the same fort a second time.
 */
let restoredScope: string | null = null

/** Test-only: forget that a restore already ran. */
export function resetPendingRestore(): void {
  restoredScope = null
}

/**
 * Put a stored pending window back into the lanes.
 *
 * Refuses in three situations, each for its own reason:
 *  - `phase !== 'editor'` — hydrating mid-session would drop a second copy of
 *    every piece into a live game.
 *  - a lane that is already non-empty — whatever is in memory is newer than
 *    what is on disk, always (the disk copy was written by an earlier Esc in
 *    this same window at the latest). Per-lane, not all-or-nothing: a session
 *    that only painted must still get its stored pieces back.
 *  - the same scope twice — see `restoredScope`.
 */
export function restorePendingChanges(): PendingRestoreReport {
  const storage = browserPendingStorage()
  const scope = currentPendingScope()
  if (!storage || !scope || scope === restoredScope) return EMPTY_REPORT
  if (useBoots.getState().phase !== 'editor') return EMPTY_REPORT
  const parsed = readPendingSnapshot(storage, scope)
  if (!parsed) return EMPTY_REPORT
  restoredScope = scope

  // Prune only against a document that has actually arrived: an empty node map
  // is "not loaded yet", and pruning against it would throw the window away.
  const nodes = useScene.getState().nodes as Readonly<Record<string, unknown>>
  const loaded = Object.keys(nodes).length > 0
  const { snapshot, dropped } = loaded
    ? prunePendingSnapshot(parsed.snapshot, nodes)
    : { dropped: 0, snapshot: parsed.snapshot }

  const report = hydratePendingLanes(snapshot)
  report.skipped = parsed.skipped
  report.stale = dropped
  // Write the pruned window back, so the next load does not re-check rows that
  // are already gone. Nothing to write when the whole thing was stale.
  if (dropped > 0) {
    const lanes = collectPendingLanes()
    writePendingSnapshot(
      storage,
      scope,
      isEmptyPending(lanes) ? null : buildPendingSnapshot(lanes, snapshot.savedAt),
    )
  }
  const noise = report.skipped + report.stale + report.unknown
  if (noise > 0) {
    console.warn(
      `[boots] restored the pending changes minus ${noise} row(s): ${report.skipped} unreadable, ${report.stale} whose element is gone, ${report.unknown} no longer in the catalog`,
    )
  }
  return report
}

/**
 * Fill the empty lanes from a snapshot. Pieces and placements go back through
 * the ordinary store actions (`addPlaced`, `addItem`, `addAperture`) rather
 * than a bulk `setState`, so they get fresh runtime ids from the same counters
 * every other placement uses — ids that key colliders, the support graph and
 * the shared records, and that must not collide with anything placed later in
 * this page load.
 */
export function hydratePendingLanes(snapshot: PendingSnapshot): PendingRestoreReport {
  const report: PendingRestoreReport = { ...EMPTY_REPORT }
  const boots = useBoots.getState()
  if (boots.placed.length === 0) {
    for (const piece of snapshot.placed) {
      boots.addPlaced({
        corners: piece.corners,
        height: piece.height,
        mask: piece.mask,
        piece: piece.piece,
        position: piece.position,
        slotId: piece.slotId,
        yaw: piece.yaw,
      })
      report.pieces++
    }
  }

  const demolition = useDemolition.getState()
  if (demolition.destroyed.length === 0 && snapshot.destroyed.length > 0) {
    // `foreign` is a per-capture count of what the ownership gate withheld at
    // an exit that is now over; there is no honest value to restore but zero.
    demolition.setDestroyed(snapshot.destroyed, snapshot.mine, 0)
  }

  const paint = usePaintKeep.getState()
  if (paint.painted.length === 0 && snapshot.painted.length > 0) {
    paint.setPainted(snapshot.painted)
  }

  const items = useItems.getState()
  if (items.items.length === 0) {
    for (const placement of snapshot.items) {
      if (placement.kind === 'item') {
        const asset = placeableCatalog().find((entry) => entry.id === placement.catalogId)
        if (!asset) {
          report.unknown++
          continue
        }
        items.addItem(asset, placement.position, placement.yaw)
        report.items++
        continue
      }
      const def = OPENING_ENTRIES.find((entry) => entry.id === placement.catalogId)
      if (!def) {
        report.unknown++
        continue
      }
      items.addAperture(def, placement.wallId, placement.u, placement.v, {
        height: placement.height,
        width: placement.width,
      })
      report.apertures++
    }
  }
  return report
}

/** A placement as the key stores it — catalog id plus its pose. */
function encodePlacement(
  placement: ReturnType<typeof useItems.getState>['items'][number],
): PersistedPlacement {
  if (placement.kind === 'item') {
    return {
      catalogId: placement.asset.id,
      kind: 'item',
      position: [placement.position[0], placement.position[1], placement.position[2]],
      yaw: placement.yaw,
    }
  }
  return {
    catalogId: placement.def.id,
    height: placement.height,
    kind: 'aperture',
    u: placement.u,
    v: placement.v,
    wallId: placement.wallId,
    width: placement.width,
  }
}
