'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import type { Object3D } from 'three'
import { useBoots } from '../store'
import { Builder, PlacedPieces } from './builder'
import { clearDebris, Debris } from './debris'
import * as destructionApi from './destruction'
import { resetDestruction, useDestruction, type VoxelTarget } from './destruction'
import { Doors, doorsDebug } from './doors'
import * as dustApi from './dust'
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
import { collectOverlayRoots, collectWorld, type GameWorld } from './world'

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
    prevoxelizeTick?: (world: GameWorld, budgetMs?: number) => boolean
  }
).prevoxelizeTick

/**
 * Spreads prevoxelization across frames (~4 ms budget per tick — a full
 * house clads in well under a second without a hitch), then goes inert
 * once destruction reports every wall done. The very first frame is
 * skipped so first paint never carries the voxelization cost on top of
 * session-start work (fullscreen, HUD, snapshot).
 */
function Prevoxelize({ world }: { world: GameWorld }) {
  const done = useRef(false)
  const frame = useRef(0)
  useFrame(() => {
    if (done.current) return
    if (frame.current++ === 0) return
    done.current = prevoxelizeTick ? prevoxelizeTick(world, 4) : true
  })
  return null
}

/**
 * Bones' framing renderer re-parents cross-level "foreign" groups (gable
 * gypsum/sheathing/cladding, roof framing mounted on other storeys) onto
 * LEVEL Object3Ds and re-asserts `group.visible` from its own store EVERY
 * FRAME — so the one-shot overlay-root hide in ActiveGame never reaches
 * them, and they read as z-fighting, unbreakable drywall over voxelized
 * walls. Hidden here two ways, both cheap:
 *
 *  - `visible = false` per frame, AFTER bones' re-assert: this subscriber
 *    mounts at session start, long after bones' — R3F sorts equal-priority
 *    subscribers stably, so subscription order IS execution order and ours
 *    runs later within every frame. Deliberately priority 0: any priority
 *    > 0 flips the whole canvas into manual-render mode (R3F only
 *    auto-renders when internal.priority === 0), which would silently hand
 *    rendering to the host's post pipeline — or a black screen when that
 *    pipeline is errored/rebuilding.
 *  - `layers.disableAll()` once per descendant as the ordering-proof
 *    backstop: bones re-writes `visible` but never touches layers after
 *    build, so even a bones remount that resubscribes AFTER us (new stable
 *    sort position) cannot bring the meshes back mid-session.
 *
 * Exit-restore guarantees: `visible` restores ITSELF — bones' frame loop
 * re-asserts it from its store on the first frame after this component
 * unmounts, so no ledger entry is needed (or wanted: a ledger restore
 * would just be overwritten by the same loop). Layer masks are ours to
 * restore: the unmount cleanup writes every recorded mask back. Groups
 * bones disposed mid-session leave stale-but-inert entries; groups built
 * mid-session are caught by the ~1 Hz rescan below.
 */
function ForeignOverlayHide() {
  const groups = useRef<Object3D[]>([])
  const masks = useRef(new Map<Object3D, number>())
  const frame = useRef(0)
  useEffect(() => {
    const recorded = masks.current
    return () => {
      for (const [object, mask] of recorded) object.layers.mask = mask
      recorded.clear()
      groups.current = []
    }
  }, [])
  useFrame(({ scene }) => {
    frame.current++
    // (Late-registering overlay ROOTS are OverlaySweep's job below — this
    // component only handles the re-parented foreign groups that no root
    // hide can ever reach.)
    // Collect refs lazily (first frame, then ~1 Hz) — bones only rebuilds
    // these groups on compute changes, so a full scene traverse per frame
    // would be pure waste.
    if (frame.current === 1 || frame.current % 60 === 0) {
      groups.current = []
      scene.traverse((object) => {
        if (!object.name.startsWith('bones-foreign-')) return
        groups.current.push(object)
        object.traverse((child) => {
          if (masks.current.has(child)) return
          masks.current.set(child, child.layers.mask)
          child.layers.disableAll()
        })
      })
    }
    for (const group of groups.current) group.visible = false
  })
  return null
}

/**
 * Overlay ghost-buster for late-registering ROOTS: Bones' X-ray renderers
 * register their nodes asynchronously, so a root that lands after
 * collectWorld's snapshot escapes ActiveGame's mount-time hide and would
 * survive wall voxelization as an unbreakable ghost layer. Re-collects
 * every 15th frame for the first ~2s of the session; hideForGame skips
 * anything already invisible, so repeat sweeps cost nothing and every flip
 * still lands in the session's restore ledger. (Re-parented foreign groups
 * that no root hide can reach are ForeignOverlayHide's job above.)
 */
function OverlaySweep() {
  const frame = useRef(0)
  useFrame(() => {
    const f = frame.current
    if (f > 120) return
    frame.current = f + 1
    if (f % 15 !== 0) return
    for (const root of collectOverlayRoots()) hideForGame(root)
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
      // boards/segments/sheets land (see dumpDestructionMembers; sheets are
      // the logical drywall tear groups of the tear-out rework).
      boards: () => dumpDestructionMembers('boards'),
      segments: () => dumpDestructionMembers('segments'),
      sheets: () => dumpDestructionMembers('sheets'),
      // Dust debug — feature-detected like prevoxelizeTick: dust.tsx's
      // rework may export a `dustDebug` dump; a stable key + empty object
      // until then, never a live ref either way.
      dust: () => {
        const dump = (dustApi as { dustDebug?: () => Record<string, unknown> }).dustDebug
        return dump ? dump() : {}
      },
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
      <ForeignOverlayHide />
      <OverlaySweep />
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
