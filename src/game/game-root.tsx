'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { type Object3D, Raycaster, Vector3 } from 'three'
import { useBoots } from '../store'
import { GameBoundary } from './boundary'
import { Builder, PlacedPieces } from './builder'
import { clearDebris, Debris } from './debris'
import {
  prevoxelizeTick,
  resetDestruction,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { Doors, doorsDebug } from './doors'
import { clearDust, dustDebug, DustSystem } from './dust'
import { Enemies } from './enemies'
import { bots, debugFlags } from './enemies-state'
import { GlassCracks, resetGlass } from './glass'
import { Grenades } from './grenade'
import { GunTable } from './guntable'
import { Nature } from './nature'
import { Player, playerDebug, playerRig } from './player'
import { getSession, hideForGame, getSessionSerial } from './session'
import { aimDirection, fire } from './shooting'
import { GameSky } from './sky'
import { TreesDestruct, treesDebug } from './trees-destruct'
import { Viewmodel } from './viewmodel'
import { PipelineWarmup } from './warmup'
import { VoxelWalls } from './voxel-walls'
import { WEAPONS } from './weapons'
import {
  collectOverlayRoots,
  collectWorld,
  countCoplanarSuspects,
  type GameWorld,
  isOverlayName,
} from './world'

/**
 * In-canvas game orchestrator, mounted through the plugin's `def.system`
 * slot (so it exists whenever Boots is installed in the scene) and inert
 * until the panel flips the store into game phase.
 */
export function GameRoot() {
  const phase = useBoots((s) => s.phase)
  if (phase !== 'game') return null
  // Fresh boundary per session (key) — one crash exits cleanly and the next
  // Jump in starts unpoisoned.
  return (
    <GameBoundary key={getSessionSerial()}>
      <ActiveGame />
    </GameBoundary>
  )
}

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
    done.current = prevoxelizeTick(world, 4)
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
        // Single exported predicate (world.ts OVERLAY_NAME_PREFIXES) — QA
        // asserts the same list countCoplanarSuspects matches through.
        if (!isOverlayName(object.name)) return
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
 * every 15th frame for the WHOLE session — the old ~2s (120-frame) window
 * assumed registration only races session start, but bones re-registers
 * whenever a renderer REMOUNTS (its store recompute / device-reconcile
 * scene writes / a slow plugin bundle finishing past 2s), and a remounted
 * root is a brand-new Object3D that defaults `visible = true`: in the
 * owner's Bones-installed scene that read as an unbreakable drywall face
 * coplanar with the voxel skins, forever (round 2026-08-25, feedback B).
 * hideForGame skips anything already invisible, so steady-state sweeps
 * cost one registry walk every 15 frames and nothing else; every actual
 * flip still lands in the session's restore ledger, so exit restores the
 * fresh roots too. (Re-parented foreign groups that no root hide can
 * reach are ForeignOverlayHide's job above.)
 */
function OverlaySweep() {
  const frame = useRef(0)
  useFrame(() => {
    if (frame.current++ % 15 !== 0) return
    for (const root of collectOverlayRoots()) hideForGame(root)
  })
  return null
}

/** Debug-dump helper: copy one member's primitive fields (+ SHORT number
 * tuples like center/size/normal) so `__boots` hands out plain data, never
 * live refs. Long number arrays (SheetMember.cells — internal voxel-index
 * bookkeeping, hundreds of ints per sheet) are deliberately skipped. */
function plainMember(member: object, nodeId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { nodeId }
  for (const [key, value] of Object.entries(member)) {
    const t = typeof value
    if (value === null || t === 'number' || t === 'string' || t === 'boolean') out[key] = value
    else if (
      Array.isArray(value) &&
      value.length <= 8 &&
      value.every((n) => typeof n === 'number')
    )
      out[key] = [...value]
  }
  return out
}

/**
 * Dump a named per-target member array of the destruction state. The
 * phase-3 anatomy landed both members ON the target: 'segments' (charcoal
 * framing sticks; `studs` is the same array) and 'sheets' (logical drywall
 * tear groups) — see the VoxelTarget doc in destruction.ts. Unknown fields
 * simply dump empty.
 */
function dumpDestructionMembers(field: 'segments' | 'sheets'): Array<Record<string, unknown>> {
  const state = useDestruction.getState() as unknown as {
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
  return out
}

const _idRay = new Raycaster()
const _idOrigin = new Vector3()
const _idDir = new Vector3()

/** One entry of the identifyAim() hit chain — plain data, never live refs. */
type IdentifiedHit = {
  name: string
  type: string
  /** Ancestor names root-ward (nearest parent first; '' → placeholder). */
  parentNames: string[]
  userDataKeys: string[]
  nodeId: string | null
  materialName: string | null
  materialColor: string | null
  visible: boolean
  layersMask: number
  distance: number
  point: [number, number, number]
  boots: boolean
}

/**
 * Diagnosis probe (mid-surface lane 2026-08-25): raycast the WHOLE scene —
 * recursive, every layer — and name the first few surfaces that would
 * actually RENDER along the ray (self + every ancestor visible; mask-0
 * objects are skipped by the layer test, matching the per-frame hider).
 * This is the tool that identifies a mystery unbreakable face: name, parent
 * chain, userData keys, material, layers, distance. Read-only.
 */
function identifyRay(
  scene: Object3D,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  max = 5,
): IdentifiedHit[] {
  _idRay.ray.origin.set(ox, oy, oz)
  _idRay.ray.direction.set(dx, dy, dz).normalize()
  _idRay.far = 500
  _idRay.layers.enableAll()
  let intersections: Array<{ object: Object3D; distance: number; point: Vector3 }> = []
  try {
    intersections = _idRay.intersectObject(scene, true)
  } catch {
    // A hostile object without raycast support — fall through with what we have.
  }
  const out: IdentifiedHit[] = []
  for (const hit of intersections) {
    if (out.length >= max) break
    // Would-render filter: an invisible object OR ancestor culls the surface.
    let renders = true
    let nodeId: string | null = null
    const parentNames: string[] = []
    for (let walker: Object3D | null = hit.object; walker; walker = walker.parent) {
      if (!walker.visible) {
        renders = false
        break
      }
      if (walker !== hit.object) parentNames.push(walker.name || `<${walker.type}>`)
      const id = (walker.userData as { nodeId?: unknown }).nodeId
      if (nodeId === null && typeof id === 'string') nodeId = id
    }
    if (!renders) continue
    const mesh = hit.object as unknown as {
      material?: { name?: string; color?: { getHexString?: () => string } }
    }
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    out.push({
      name: hit.object.name,
      type: hit.object.type,
      parentNames,
      userDataKeys: Object.keys(hit.object.userData ?? {}),
      nodeId,
      materialName: material?.name || null,
      materialColor: material?.color?.getHexString?.() ?? null,
      visible: hit.object.visible,
      layersMask: hit.object.layers.mask,
      distance: hit.distance,
      point: [hit.point.x, hit.point.y, hit.point.z],
      boots: Boolean((hit.object.userData as { __boots?: boolean }).__boots),
    })
  }
  return out
}

function ActiveGame() {
  // Snapshot once per session — walls don't move while you shoot them.
  const [world, setWorld] = useState(() => collectWorld())
  // Stable for the canvas' life — used by the __boots coplanar-suspect probe.
  const scene = useThree((s) => s.scene)

  // Remount healing (Fast Refresh / dev module sync — players never remount
  // mid-session): this component unmounting is NOT the session ending;
  // exitGame owns that. If we unmount while the session is still live,
  // give every ledger-hidden host object its visibility back so the
  // replacement ActiveGame can snapshot a full world — it re-hides
  // overlays and re-voxelizes walls from scratch anyway (the main effect's
  // cleanup below resets all destruction state). On a real exit, exitGame
  // already restored + emptied the ledger and phase is 'editor': no-op.
  useEffect(
    () => () => {
      const session = getSession()
      if (!session || useBoots.getState().phase !== 'game') return
      for (const entry of session.hiddenObjects.splice(0)) entry.object.visible = entry.visible
    },
    [],
  )

  // The replacement mount still RENDERS before the old instance's cleanup
  // restores visibility (React commits new render → old cleanup → new
  // effects), so the render-time snapshot above can come up empty — the
  // "building vanished" QA burn. Effects run after the restore: re-collect
  // once if the snapshot missed every wall.
  useEffect(() => {
    if (world.walls.size > 0) return
    const fresh = collectWorld()
    if (fresh.walls.size > 0) setWorld(fresh)
  }, [world])

  useEffect(() => {
    // Bones engineering overlays (X-ray framing/CMU, lumber, service runs,
    // devices) draw members INSIDE walls with their own renderers — once a
    // wall voxelizes they'd survive as an unbreakable ghost layer. Hide the
    // whole overlay roots for the session; exitGame's hiddenObjects ledger
    // restores every visibility flip untouched.
    for (const root of world.overlayRoots) hideForGame(root)

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
      // Per-target voxel census (QA asked for this to measure removal /
      // island collapse numerically): plain copies, never live refs.
      targets: () =>
        Array.from(useDestruction.getState().targets.values()).map((target) => ({
          nodeId: target.nodeId,
          kind: target.kind,
          aliveCount: target.grid.aliveCount,
          totalCount: target.grid.alive.length,
          revision: target.revision,
          brokenStuds: target.studs.reduce((n, s) => n + (s.broken ? 1 : 0), 0),
        })),
      studs: () =>
        Array.from(useDestruction.getState().targets.values()).flatMap((target) =>
          target.studs.map((stud) => ({
            nodeId: target.nodeId,
            studId: stud.id,
            hp: stud.hp,
            broken: stud.broken,
          })),
        ),
      // Phase-3 anatomy dumps. `segments` = charcoal framing sticks
      // (id/center/size/yaw/hp/broken); `sheets` = logical drywall tear
      // groups (id/center/size/yaw/side/normal/hits/torn/cellCount/
      // flownOff). `boards` is a legacy alias of sheets — the round-1
      // "drywall plates" idea shipped as the logical-sheet rework.
      boards: () => dumpDestructionMembers('sheets'),
      segments: () => dumpDestructionMembers('segments'),
      sheets: () => dumpDestructionMembers('sheets'),
      // Dust debug — plain-data dump from dust.tsx, never a live ref.
      dust: () => dustDebug(),
      // Unbreakable-face tripwire (owner round 2026-08-25, feedback B):
      // visible bones-overlay meshes that would actually render right now —
      // MUST be 0 during a session; non-zero means a hide was undone or a
      // pattern was missed (see world.ts countCoplanarSuspects). Counts
      // via the SAME exported predicates the hiders use, so QA asserting
      // this asserts the match set itself.
      countCoplanarSuspects: () => countCoplanarSuspects(scene),
      // Mid-surface identifier (owner round 2026-08-25): name the surfaces
      // the crosshair ray would actually RENDER, nearest-first — the tool
      // that attributes any "unbreakable face" to its owning mesh. (It
      // cleared the owner's report: the veil plugging fresh breaches was
      // lingering dust/haze, fixed in dust.tsx.)
      identifyAim: (max = 5) => {
        _idOrigin.copy(playerRig.position)
        aimDirection(_idDir, 0)
        return identifyRay(
          scene,
          _idOrigin.x,
          _idOrigin.y,
          _idOrigin.z,
          _idDir.x,
          _idDir.y,
          _idDir.z,
          max,
        )
      },
      // Combat-tree dump (trees-destruct.tsx): id/x/z/scale/state/hp/
      // canopyDamage/burnT/charHits per tree; [] outside a session.
      trees: () => treesDebug.dump(),
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
  }, [world, scene])

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
      <Grenades world={world} />
      <GunTable world={world} />
      <Doors world={world} />
      <PlacedPieces world={world} />
      <Builder />
      <Enemies world={world} />
      <Nature world={world} />
      <PipelineWarmup />
      <TreesDestruct world={world} />
    </>
  )
}
