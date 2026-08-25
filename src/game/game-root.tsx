'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { useBoots } from '../store'
import { Builder, PlacedPieces } from './builder'
import { clearDebris, Debris } from './debris'
import * as destructionApi from './destruction'
import { resetDestruction, useDestruction, type VoxelTarget } from './destruction'
import { Doors, doorsDebug } from './doors'
import { clearDust, DustSystem } from './dust'
import { Enemies } from './enemies'
import { bots, debugFlags } from './enemies-state'
import { GlassCracks, resetGlass } from './glass'
import { GunTable } from './guntable'
import { Nature } from './nature'
import { Player, playerDebug } from './player'
import { hideForGame } from './session'
import { fire } from './shooting'
import { GameSky } from './sky'
import { Viewmodel } from './viewmodel'
import { VoxelWalls } from './voxel-walls'
import { WEAPONS } from './weapons'
import { collectWorld, type GameWorld } from './world'

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

/**
 * Phase-3 destruction API, feature-detected: pre-clads every wall in voxels
 * over the first frames of a session so the building already LOOKS voxel
 * when you jump in (instead of walls flipping on first hit). Read through
 * the namespace so game-root keeps compiling while destruction.ts's half
 * lands in a parallel branch; once the export exists the driver below runs
 * it automatically.
 */
const prevoxelizeTick = (
  destructionApi as {
    prevoxelizeTick?: (world: GameWorld, budget: number) => boolean
  }
).prevoxelizeTick

/**
 * Spreads prevoxelization across frames (budget: 2 walls/frame — a full
 * house clads in well under a second without a first-frame hitch), then
 * goes inert once destruction reports every wall done.
 */
function Prevoxelize({ world }: { world: GameWorld }) {
  const done = useRef(false)
  useFrame(() => {
    if (done.current) return
    done.current = prevoxelizeTick ? prevoxelizeTick(world, 2) : true
  })
  return null
}

/** Debug-dump helper: copy one member's primitive fields (+ number tuples
 * like center/size) so `__boots` hands out plain data, never live refs. */
function plainMember(member: object, nodeId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { nodeId }
  for (const [key, value] of Object.entries(member)) {
    const t = typeof value
    if (value === null || t === 'number' || t === 'string' || t === 'boolean') out[key] = value
    else if (Array.isArray(value) && value.every((n) => typeof n === 'number'))
      out[key] = [...value]
  }
  return out
}

/**
 * Dump a named member array of the destruction state — 'boards' (drywall
 * plates) and 'segments' (stud charcoal segments) land with the phase-3
 * anatomy. Checks per-target arrays first, then a store-level
 * nodeId→members Map, so the dump works whichever home the anatomy picks;
 * empty until the fields exist.
 */
function dumpDestructionMembers(field: string): Array<Record<string, unknown>> {
  const state = useDestruction.getState() as unknown as Record<string, unknown> & {
    targets: Map<string, VoxelTarget>
  }
  const out: Array<Record<string, unknown>> = []
  for (const target of state.targets.values()) {
    const members = (target as unknown as Record<string, unknown>)[field]
    if (!Array.isArray(members)) continue
    for (const member of members) {
      if (member && typeof member === 'object') out.push(plainMember(member, target.nodeId))
    }
  }
  const topLevel = state[field]
  if (topLevel instanceof Map) {
    for (const [nodeId, members] of topLevel as Map<unknown, unknown>) {
      if (!Array.isArray(members)) continue
      for (const member of members) {
        if (member && typeof member === 'object') out.push(plainMember(member, String(nodeId)))
      }
    }
  }
  return out
}

function ActiveGame() {
  // Snapshot once per session — walls don't move while you shoot them.
  const world = useMemo(() => collectWorld(), [])

  useEffect(() => {
    // Bones engineering overlays (X-ray framing/CMU, lumber, service runs,
    // devices) draw members INSIDE walls with their own renderers — once a
    // wall voxelizes they'd survive as an unbreakable ghost layer. Hide the
    // whole overlay roots for the session; exitGame's hiddenObjects ledger
    // restores every visibility flip untouched.
    for (const root of world.overlayRoots ?? []) hideForGame(root)

    // Dev/E2E handle — lets headless tests aim and fire deterministically.
    ;(globalThis as Record<string, unknown>).__boots = {
      world,
      fire: (weapon: 'pistol' | 'rifle' | 'knife' | 'minigun' = 'rifle') =>
        fire(world, WEAPONS[weapon]),
      teleport: (x: number, z: number, yaw: number, pitch?: number) =>
        playerDebug.teleport?.(x, z, yaw, pitch),
      state: () => useBoots.getState(),
      wallNodes: () => Array.from(world.walls.values()).map((w) => w.node),
      doors: doorsDebug,
      // Bot snapshots (plain copies, never live refs) + a freeze toggle the
      // enemies loop respects — see enemies-state.ts header (debugFlags).
      bots: () =>
        bots.map((b) => ({
          kind: b.kind,
          x: b.position.x,
          y: b.position.y,
          z: b.position.z,
          hp: b.health,
        })),
      setBotsFrozen: (v: boolean) => {
        debugFlags.botsFrozen = v
      },
      studs: () =>
        Array.from(useDestruction.getState().targets.values()).flatMap((target) =>
          target.studs.map((stud) => ({
            nodeId: target.nodeId,
            studId: stud.id,
            hp: stud.hp,
            broken: stud.broken,
          })),
        ),
      // Phase-3 anatomy dumps — empty arrays until destruction.ts's
      // boards/segments land (see dumpDestructionMembers).
      boards: () => dumpDestructionMembers('boards'),
      segments: () => dumpDestructionMembers('segments'),
      // Trees list — swaps to trees-destruct's debug dump when that module
      // lands; a stable key with an empty list until then.
      trees: () => [] as Array<Record<string, unknown>>,
      skyMounted: true,
      pieces: () =>
        useBoots.getState().placed.map((p) => ({
          ...p,
          position: [...p.position] as [number, number, number],
        })),
    }
    return () => {
      delete (globalThis as Record<string, unknown>).__boots
      resetDestruction()
      resetGlass()
      clearDebris()
      clearDust()
    }
  }, [world])

  return (
    <>
      <Player world={world} />
      <Viewmodel world={world} />
      <Prevoxelize world={world} />
      <VoxelWalls />
      <GlassCracks />
      <Debris />
      <DustSystem />
      <GameSky world={world} />
      <GunTable world={world} />
      <Doors world={world} />
      <PlacedPieces world={world} />
      <Builder />
      <Enemies world={world} />
      <Nature world={world} />
    </>
  )
}
