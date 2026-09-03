import { useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useBoots } from '../store'
import { resetDropGate } from './drop-gate'
import { useItems } from './item-place'
import { usePaintKeep } from './paint-keep'
import {
  adoptLaneScope,
  laneScopeFor,
  persistPendingChanges,
  restorePendingChanges,
} from './pending-lanes'
import { currentPendingScope } from './pending-store'
import { resetPieceSlots } from './piece-slots'
import { useDemolition } from './save-demolition'
import { exitGame, getSession } from './session'
import { resetSharedBuild } from './shared-build'

/**
 * ONE PROJECT AT A TIME — the plugin's session state is re-keyed when the host
 * changes project under it.
 *
 * ── THE BUG THIS CLOSES ───────────────────────────────────────────────────
 * Owner, 2026-09-02: "i placed items and walls in a project. then changed
 * project went to boots. and even though i just started on this one I see
 * 'save changes' 'discard all' and many items and walls and roofs that i
 * placed IN THE DIFFERENT PROJECT". Every Boots store is a module singleton
 * (useBoots.placed, useItems.items, useDemolition, usePaintKeep, the shared
 * lane's attribution sets, the slot registry): they belong to the PAGE, and
 * the prod editor switches projects with a client-side navigation that never
 * reloads the page. Nothing observed the project identity, so project B
 * inherited A's four lanes: the sidebar offered them for saving, the preview
 * drew A's walls into B's viewport, the next Esc in B wrote A's fort under B's
 * pending key, and a Save would have created A's walls as real nodes in B's
 * document — the one thing docs/SESSION-CHANGES.md promises can never happen.
 * (`restorePendingChanges` could not help: it refuses to touch a non-empty
 * lane, and `resetSession` keeps `placed` on purpose, so B's own window was
 * ALSO silently withheld while A's sat in its place.)
 *
 * ── WHAT THIS DOES ────────────────────────────────────────────────────────
 * `syncProjectScope` compares the page's project (pending-store.ts
 * `currentPendingScope`: the route, else the bus) with the project the lanes
 * belong to (pending-lanes.ts `laneScopeFor`). When they differ:
 *   1. a live session is ended the ordinary way (`exitGame`), which captures
 *      demolition and paint and writes the pending window under the OLD scope —
 *      the lanes are keyed by the project they were built in, not by the URL of
 *      the moment;
 *   2. otherwise the old window is written down one last time under the old
 *      scope, so nothing pending is lost by leaving;
 *   3. every store holding session or pending state is hard-reset;
 *   4. the lanes adopt the new scope and the restore latch is cleared, so the
 *      new project's own stored window comes back — and so coming BACK to the
 *      old project restores its window again (the latch used to say "already
 *      restored" for a scope whose lanes had long since been replaced).
 * A null identity (a page that names no project) is a real change too: the
 * lanes are emptied and NOTHING is written — there is no shared fallback key.
 *
 * ── WHEN IT RUNS ──────────────────────────────────────────────────────────
 * `watchProjectScope` (mounted by system.tsx, in editor phase) checks on mount,
 * whenever the host scene store or the viewer store changes, on popstate, and
 * on a 1 Hz timer as the untrusted-host backstop. The steady-state check is two
 * string reads and a compare — nothing allocated, nothing per frame.
 *
 * ── THE RESTORE WAITS FOR THE DOCUMENT ────────────────────────────────────
 * `restorePendingChanges` prunes node-addressed rows against the loaded scene
 * and writes the pruned window back. Right after a switch the scene store may
 * still hold the OLD document; pruning the new project's window against it
 * would throw away every leveled and painted row as "gone". So after a switch
 * the restore is held until the host replaces the nodes map (it unloads the
 * scene at the start of every load), with a time cap so a host that never does
 * still gets its restore.
 */

export type ProjectScopeSync = {
  /** `changed` = the lanes were re-keyed (and every store reset). */
  result: 'same' | 'changed'
  from: string | null
  to: string | null
}

/** The two things the sync needs from the session, injectable for tests. */
export type ProjectScopeDeps = {
  sessionLive: () => boolean
  /** End the live session. MUST persist the window under the lane scope, which
   * is still the OLD project when this is called (exitGame does, via
   * pending-lanes). */
  endSession: () => void
}

const LIVE: ProjectScopeDeps = {
  sessionLive: () => getSession() !== null || useBoots.getState().phase === 'game',
  endSession: () => {
    exitGame()
    // A 'game' phase with no session is a tree that lost its ActiveGame to the
    // switch before the session noticed; the phase is the sidebar's write gate,
    // so it must not stay 'game' on a project that has no game running.
    if (useBoots.getState().phase === 'game') useBoots.getState().setPhase('editor')
  },
}

/**
 * Empty every store that holds session or pending state.
 *
 * The game tree's own unmount cleanups (destruction targets, glass, debris,
 * paint ledgers, ground probes) are not repeated here: they die with
 * ActiveGame, which `endSession` has already torn down. What is listed is
 * exactly what OUTLIVES a session by design — the four Save/Discard lanes, the
 * catalog ghost, the loadout, the shared lane's attribution (keyed on piece ids
 * that no longer exist), the slot registry, and the drop-link one-shot.
 */
export function resetProjectState(): void {
  const boots = useBoots.getState()
  boots.resolvePlaced()
  boots.resetSession()
  const items = useItems.getState()
  items.resolveItems()
  items.disarm()
  useDemolition.getState().clear()
  usePaintKeep.getState().clear()
  resetSharedBuild()
  resetPieceSlots()
  resetDropGate()
}

/**
 * Re-key the plugin to the page's current project if it moved. Idempotent and
 * cheap when nothing changed — the watcher calls it freely.
 */
export function syncProjectScope(deps: ProjectScopeDeps = LIVE): ProjectScopeSync {
  const from = laneScopeFor()
  const to = currentPendingScope()
  if (from === to) return { from, result: 'same', to }
  let written = false
  if (deps.sessionLive()) {
    // Leaving the project ends the session; exitGame writes the window under
    // the lane scope, which is still `from`.
    deps.endSession()
    written = true
  }
  // One last write under the OLD key: the lanes are that project's window and
  // this is the last moment they can be told apart from the new project's. A
  // null `from` has no key and writes nothing.
  if (!written && from !== null) persistPendingChanges()
  resetProjectState()
  adoptLaneScope(to)
  return { from, result: 'changed', to }
}

/** How long a post-switch restore waits for the host to replace the document
 * before going ahead against whatever is loaded. */
export const RESTORE_HOLD_MS = 5000

type BusLike = { projectId?: unknown }

/**
 * Start watching. Returns the stop function (the mount effect's cleanup).
 *
 * The fast path reads the two identity sources and compares them with what it
 * saw last; only a change (or a held restore) goes on to the sync. Restore runs
 * once per adopted scope from here, so a project with nothing stored is not
 * re-read from storage on every scene edit.
 */
export function watchProjectScope(): () => void {
  let seenPath: string | null | undefined
  let seenBus: unknown
  let restoredFor: string | null | undefined
  let staleNodes: unknown = null
  let heldSince = 0

  const globals = globalThis as {
    location?: { pathname?: string }
    __pascalCollabBus?: BusLike
  }

  const restoreWhenReady = () => {
    const scope = laneScopeFor()
    if (scope === restoredFor) return
    if (staleNodes !== null) {
      // Still the document we left: hold, unless the host is taking too long.
      if (useScene.getState().nodes === staleNodes && Date.now() - heldSince < RESTORE_HOLD_MS) {
        return
      }
      staleNodes = null
    }
    restoredFor = scope
    restorePendingChanges()
  }

  const check = () => {
    const path = globals.location?.pathname ?? null
    const bus = globals.__pascalCollabBus?.projectId
    if (path !== seenPath || bus !== seenBus) {
      seenPath = path
      seenBus = bus
      const nodesBefore = useScene.getState().nodes
      if (syncProjectScope().result === 'changed') {
        // Hold the restore while the store still shows the document we left.
        staleNodes = Object.keys(nodesBefore).length > 0 ? nodesBefore : null
        heldSince = Date.now()
      }
    }
    restoreWhenReady()
  }

  check()

  const offs: Array<() => void> = []
  // Only a document swap is a signal here — not every node edit. (`prev` is
  // undefined under the bun-test store stub, which then always checks.)
  offs.push(
    useScene.subscribe((state, prev) => {
      if (!prev || state.nodes !== prev.nodes) check()
    }),
  )
  // The viewer store carries the host's own project id (Editor prop → store);
  // it is an untrusted key ('default' on hosts without projects) but a fine
  // change signal. Gated on that one field so an orbit or a selection never
  // reaches the check. Feature-detected: the bun-test stub may not subscribe.
  type ViewerLike = { projectId?: unknown }
  const viewer = useViewer as unknown as {
    subscribe?: (listener: (state: ViewerLike, prev?: ViewerLike) => void) => () => void
  }
  if (typeof viewer.subscribe === 'function') {
    offs.push(
      viewer.subscribe((state, prev) => {
        if (!prev || state.projectId !== prev.projectId) check()
      }),
    )
  }
  const win = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void
    removeEventListener?: (type: string, listener: () => void) => void
  }
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('popstate', check)
    offs.push(() => win.removeEventListener?.('popstate', check))
  }
  const timer = setInterval(check, 1000)
  offs.push(() => clearInterval(timer))

  return () => {
    for (const off of offs.splice(0)) off()
  }
}
