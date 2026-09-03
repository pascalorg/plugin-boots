'use client'

import { useEffect } from 'react'
import { DropGate } from './drop-gate'
import { GameRoot } from './game-root'
import { PendingPreview } from './preview'
import { watchProjectScope } from './project-scope'
import { SpectatorPlayers } from './spectator'

/**
 * Keep every Boots store keyed to THIS project, and put back whatever decision
 * was still open when the project was last closed.
 *
 * Mounted here because this is the earliest thing the plugin owns on the page
 * and it mounts in EDITOR phase: the lanes are filled before the sidebar reads
 * them, before the preview draws, and before the drop gate can hand anyone a
 * Jump in. The watcher runs the restore (once per project — the latch in
 * pending-lanes.ts, so a canvas remount cannot double the fort) and, the part a
 * remount alone can never do, hard-resets the module-level session state when
 * the host switches project under the plugin without a page load
 * (project-scope.ts — owner P0 2026-09-02, one project's fort offered in
 * another).
 */
function ProjectScopeGuard() {
  useEffect(() => watchProjectScope(), [])
  return null
}

/**
 * The plugin's collective system component — the host mounts it inside the
 * R3F canvas whenever Boots is installed in the scene (node count doesn't
 * matter). It renders nothing until Jump in flips the phase — except for
 * PendingPreview, which is the one thing that renders in EDITOR phase: while
 * the Save/Discard choice is open it shows the pending changes in the
 * viewport (preview.tsx). The two are mutually exclusive by construction —
 * GameRoot gates on `phase === 'game'`, the preview on `'editor'`.
 */
export default function BootsSystem() {
  return (
    <>
      <ProjectScopeGuard />
      <DropGate />
      <GameRoot />
      <SpectatorPlayers />
      <PendingPreview />
    </>
  )
}
