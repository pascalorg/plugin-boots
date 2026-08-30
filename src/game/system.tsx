'use client'

import { DropGate } from './drop-gate'
import { GameRoot } from './game-root'

/**
 * The plugin's collective system component — the host mounts it inside the
 * R3F canvas whenever Boots is installed in the scene (node count doesn't
 * matter). It renders nothing until Jump in flips the phase.
 */
export default function BootsSystem() {
  return (
    <>
      <DropGate />
      <GameRoot />
    </>
  )
}
