'use client'

import { useEffect } from 'react'
import { DropGate } from './drop-gate'
import { GameRoot } from './game-root'
import { restorePendingChanges } from './pending-lanes'
import { PendingPreview } from './preview'
import { SpectatorPlayers } from './spectator'

/**
 * Put back whatever decision was still open when this project was last closed.
 *
 * Mounted here because this is the earliest thing the plugin owns on the page
 * and it mounts in EDITOR phase: the lanes are filled before the sidebar reads
 * them, before the preview draws, and before the drop gate can hand anyone a
 * Jump in. Runs once per project per page load — `restorePendingChanges` holds
 * the latch, so a canvas remount cannot double the fort.
 */
function PendingRestore() {
  useEffect(() => {
    restorePendingChanges()
  }, [])
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
      <PendingRestore />
      <DropGate />
      <GameRoot />
      <SpectatorPlayers />
      <PendingPreview />
    </>
  )
}
