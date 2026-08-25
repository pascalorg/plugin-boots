'use client'

import { useEffect, useMemo } from 'react'
import { useBoots } from '../store'
import { Builder, PlacedPieces } from './builder'
import { clearDebris, Debris } from './debris'
import { resetDestruction, useDestruction } from './destruction'
import { Doors, doorsDebug } from './doors'
import { Enemies } from './enemies'
import { GlassCracks, resetGlass } from './glass'
import { GunTable } from './guntable'
import { Nature } from './nature'
import { Player, playerDebug } from './player'
import { fire } from './shooting'
import { Viewmodel } from './viewmodel'
import { VoxelWalls } from './voxel-walls'
import { WEAPONS } from './weapons'
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

  useEffect(() => {
    // Dev/E2E handle — lets headless tests aim and fire deterministically.
    ;(globalThis as Record<string, unknown>).__boots = {
      world,
      fire: (weapon: 'pistol' | 'rifle' | 'knife' = 'rifle') => fire(world, WEAPONS[weapon]),
      teleport: (x: number, z: number, yaw: number, pitch?: number) =>
        playerDebug.teleport?.(x, z, yaw, pitch),
      state: () => useBoots.getState(),
      wallNodes: () => Array.from(world.walls.values()).map((w) => w.node),
      doors: doorsDebug,
      studs: () =>
        Array.from(useDestruction.getState().targets.values()).flatMap((target) =>
          target.studs.map((stud) => ({
            nodeId: target.nodeId,
            studId: stud.id,
            hp: stud.hp,
            broken: stud.broken,
          })),
        ),
    }
    return () => {
      delete (globalThis as Record<string, unknown>).__boots
      resetDestruction()
      resetGlass()
      clearDebris()
    }
  }, [world])

  return (
    <>
      <Player world={world} />
      <Viewmodel world={world} />
      <VoxelWalls />
      <GlassCracks />
      <Debris />
      <GunTable world={world} />
      <Doors world={world} />
      <PlacedPieces world={world} />
      <Builder />
      <Enemies world={world} />
      <Nature world={world} />
    </>
  )
}
