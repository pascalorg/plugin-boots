'use client'

import { useEffect, useMemo } from 'react'
import { useBoots } from '../store'
import { Builder, PlacedPieces } from './builder'
import { clearDebris, Debris } from './debris'
import { resetDestruction } from './destruction'
import { Enemies } from './enemies'
import { GlassCracks, resetGlass } from './glass'
import { GunTable } from './guntable'
import { Nature } from './nature'
import { Player } from './player'
import { Viewmodel } from './viewmodel'
import { VoxelWalls } from './voxel-walls'
import { collectWorld } from './world'

/**
 * In-canvas game orchestrator, mounted through the plugin's `def.system`
 * slot (so it exists whenever Boots is installed in the scene) and inert
 * until the panel flips the store into game phase.
 */
export function GameRoot() {
  const phase = useBoots((s) => s.phase)
  if (phase !== 'game') return null
  return <ActiveGame />
}

function ActiveGame() {
  // Snapshot once per session — walls don't move while you shoot them.
  const world = useMemo(() => collectWorld(), [])

  useEffect(
    () => () => {
      resetDestruction()
      resetGlass()
      clearDebris()
    },
    [],
  )

  return (
    <>
      <Player world={world} />
      <Viewmodel world={world} />
      <VoxelWalls />
      <GlassCracks />
      <Debris />
      <GunTable world={world} />
      <PlacedPieces world={world} />
      <Builder />
      <Enemies world={world} />
      <Nature world={world} />
    </>
  )
}
