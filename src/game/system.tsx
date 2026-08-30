'use client'

import { DropGate } from './drop-gate'
import { GameRoot } from './game-root'
import { PendingPreview } from './preview'

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
      <DropGate />
      <GameRoot />
      <PendingPreview />
    </>
  )
}
