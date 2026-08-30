'use client'

import { sceneRegistry } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { type Object3D, Raycaster, Vector3 } from 'three'
import { useBoots } from '../store'
import { GameBoundary } from './boundary'
import { Builder, PlacedPieces } from './builder'
import { clearDebris, Debris, debrisDump, setDebrisGroundProbe } from './debris'
import {
  collapseWholeTarget,
  damageSegment,
  ensureVoxelTarget,
  prevoxelizeSchedulerStats,
  prevoxelizeTick,
  probeLandingY,
  resetDestruction,
  setShellFlag,
  shellBuildTick,
  shellPendingCount,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { Doors, doorsDebug } from './doors'
import { clearDust, dustDebug, DustSystem, setDustFloorProbe } from './dust'
import { Enemies } from './enemies'
import { bots, debugFlags } from './enemies-state'
import { GlassCracks, glassShardCensus, resetGlass, setGlassFloorProbe } from './glass'
import { Grenades } from './grenade'
import { GunTable } from './guntable'
import { HostPostTuning, hostPostDebug } from './host-post'
import { GameItems } from './item-place'
import { advanceProgress, type LoadingSample, pendingLabel } from './loading'
import { Nature } from './nature'
import { PaintTool } from './paint'
import { MOVE } from './movement'
import { PerfMonitor, perfReset, perfSections, perfSnapshot } from './perf-monitor'
import { Player, playerDebug, playerRig } from './player'
import {
  type LocalPose,
  onPresenceEvent,
  presenceDebug,
  startPresence,
  stopPresence,
} from './presence'
import { RemotePlayers } from './remote-players'
import { getSession, hideForGame, getSessionSerial } from './session'
import { ShellLayer, shellCensus } from './shell-layer'
import { aimDirection, fire } from './shooting'
import { pendingToneCount, toneAuditReport } from './skin-tone'
import { GameSky } from './sky'
import { TreesDestruct, treesDebug } from './trees-destruct'
import { Viewmodel } from './viewmodel'
import { settleTasksPending } from './structure'
import { PipelineWarmup } from './warmup'
import { dormantPrimeQueueSize, VoxelWalls } from './voxel-walls'
import { WEAPONS } from './weapons'
import {
  collectMeshes,
  collectOverlayRoots,
  collectSolidRoots,
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

/**
 * Resurrection sweep — the "drywall that can't be damaged" fix: the host's
 * wall system rebuilds its meshes asynchronously (geometry bundles), so a
 * wall voxelized 10 minutes ago can sprout FRESH host meshes mid-session —
 * visible, absent from our colliders, untouchable by bullets or grenades.
 * Every ~0.5s, re-walk each voxelized node's registry root and hide any
 * visible mesh through the session ledger (restored on exit as always).
 *
 * The walk goes through collectMeshes with the SAME hosted-children fence
 * collectWorld uses (QA p4r3 bug 1): a voxelized wall's subtree NESTS its
 * hosted door/window/item roots, and an unfenced traverse hid those live
 * nodes ~0.5 s after jump-in — windows and doors simply vanished. Fencing
 * also keeps the sweep off glass panes and off windows' material-invisible
 * interaction hitboxes (collectMeshes skips those), so the pane fix in
 * world.ts stays fixed. The fence set is rebuilt per sweep (2 Hz registry
 * walk — cheap) so mid-session registrations fence correctly.
 */
function ResurrectionSweep() {
  const frame = useRef(0)
  useFrame(() => {
    frame.current++
    if (frame.current % 30 !== 0) return
    const targets = useDestruction.getState().targets
    if (targets.size === 0) return
    const fence = collectSolidRoots()
    for (const [nodeId, target] of targets) {
      if (target.dormant) continue // the host mesh is SUPPOSED to render
      const root = sceneRegistry.nodes.get(nodeId as never)
      if (!root) continue
      for (const mesh of collectMeshes(root, fence)) hideForGame(mesh)
    }
  })
  return null
}

/**
 * Display-rate frames for the session: the host advances R3F through a
 * FrameLimiter capped at 50 fps (fixed 20 ms quanta), which beats against
 * 120 Hz displays as judder — the "feels slow" live report; measured frame
 * COST was 8–10 ms, so the headroom exists. While the game runs, this
 * pauses the limiter (renderPaused is read ONLY by it) and drives
 * `advance` from a raw rAF at the display's own rate, continuing the R3F
 * clock epoch from where the limiter left it (capped dt so the first
 * sample never spikes). The limiter's other duty — pixel-ratio/size sync —
 * is replicated on size/dpr changes (fullscreen enters right after mount).
 * On exit everything restores; the limiter resumes its own saved clock
 * (one stale-dt frame in the editor, clamped by consumers).
 */
function FrameBooster() {
  const advance = useThree((s) => s.advance)
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const clock = useThree((s) => s.clock)
  useEffect(() => {
    gl.setPixelRatio(dpr)
    gl.setSize(size.width, size.height, false)
  }, [gl, size, dpr])
  useEffect(() => {
    // The plugin's pinned viewer typings predate the renderPaused flag —
    // resolve it structurally (same defensive idiom as the core history
    // transaction in panel.tsx); the live host store has carried it since
    // the gallery-cover feature.
    const viewerStore = useViewer as unknown as {
      getState: () => { renderPaused?: boolean }
      setState: (partial: { renderPaused: boolean }) => void
    }
    const prevPaused = viewerStore.getState().renderPaused ?? false
    viewerStore.setState({ renderPaused: true })
    let frameTime = clock.elapsedTime
    let lastNow = 0
    let raf = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = lastNow > 0 ? Math.min((now - lastNow) / 1000, 0.05) : 1 / 120
      lastNow = now
      frameTime += dt
      advance(frameTime)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      viewerStore.setState({ renderPaused: prevPaused })
    }
  }, [advance, clock])
  return null
}

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
 * Spreads prevoxelization across frames on destruction's ADAPTIVE time
 * budget (4 ms per tick, raised to 8 ms while frames run comfortably
 * idle), NEAREST THE PLAYER FIRST (the rig position is the focus — the
 * remaining queue re-sorts every ~2 s as the player moves), then goes
 * inert once destruction reports every node done. Distant targets can
 * wait: their hosts render + collide meanwhile, and first damage out
 * there still builds on demand. The very first frame is skipped so first
 * paint never carries the voxelization cost on top of session-start work
 * (fullscreen, HUD, snapshot).
 */
function Prevoxelize({ world }: { world: GameWorld }) {
  const done = useRef(false)
  const frame = useRef(0)
  useFrame(() => {
    if (frame.current++ === 0) return
    if (!done.current) {
      done.current = prevoxelizeTick(world, undefined, playerRig.position)
      return
    }
    // S2 lazy shell tier: once every node has its grid, deferred shells
    // build nearest-first on their own small budget (~2 ms/tick), near-
    // gated so far targets stay pending — an empty/idle queue costs one
    // counter check per frame.
    shellBuildTick(undefined, playerRig.position)
  })
  return null
}

/**
 * Feeds the HUD's entry veil with REAL progress (loading.ts weights) —
 * the owner's "terrible lag when launching" fix: the veil holds until the
 * session's actual gear-up pipeline is done instead of a fixed 1.2 s.
 * Per frame while session.loading (a boolean check once revealed):
 *
 *  - wall fraction: walls with a destruction target / world.walls.size —
 *    prevoxelizeTick only reports a done BOOLEAN, so the counter is read
 *    off useDestruction's targets map directly (O(walls) Map lookups).
 *  - prevoxelize done: the zero-budget prevoxelizeTick probe (same idiom
 *    as warmup.tsx — budget 0 means "check, never work").
 *  - prime drain: dormantPrimeQueueSize() against the highest size seen
 *    (the queue GROWS while prevoxelize enqueues — loading.ts caps the
 *    open-queue fraction and advanceProgress keeps the signal monotonic).
 *  - warm frames: counted only after the primes drained — they absorb the
 *    serialized warm-draw GPU uploads (voxel-walls serializes one replica
 *    upload per frame) plus the first steady renders.
 *
 * The 4 s cap lives in advanceProgress (elapsed wall clock) AND as a
 * hud-side timer (a wedged frame loop can't hold the veil). Feature-
 * detected hud call, plain reads only — never writes any store.
 */
function LoadingDriver({ world }: { world: GameWorld }) {
  const start = useRef(0)
  const peak = useRef(0)
  const warm = useRef(0)
  const progress = useRef(0)
  useFrame(() => {
    const session = getSession()
    if (!session?.loading) return
    if (start.current === 0) start.current = performance.now()
    const targets = useDestruction.getState().targets
    let voxelized = 0
    for (const nodeId of world.walls.keys()) {
      if (targets.has(nodeId)) voxelized++
    }
    const remaining = dormantPrimeQueueSize()
    if (remaining > peak.current) peak.current = remaining
    const prevoxelizeDone = prevoxelizeTick(world, 0)
    if (prevoxelizeDone && remaining === 0) warm.current++
    const sample: LoadingSample = {
      snapshotDone: true, // collectWorld ran synchronously before this mount
      wallsTotal: world.walls.size,
      wallsVoxelized: voxelized,
      prevoxelizeDone,
      primeQueuePeak: peak.current,
      primeQueueRemaining: remaining,
      warmFrames: warm.current,
      elapsedMs: performance.now() - start.current,
    }
    progress.current = advanceProgress(progress.current, sample)
    session.hud.loadingProgress?.(progress.current, pendingLabel(sample))
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

/**
 * Co-presence local pose sampler — what the 12 Hz publisher reads. One
 * reused object (the adapter quantizes it into its own wire scratch), all
 * plain reads: playerRig (eye position, yaw/pitch, speed, grounded) + the
 * boots store (phase, weapon, staggered). Speed normalizes against the
 * run speed so peers animate gait without knowing our tuning.
 */
const _localPose: LocalPose = {
  ph: 'editor',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  w: 'knife',
  s: 0,
  g: true,
  st: false,
}

function sampleLocalPose(): LocalPose {
  const s = useBoots.getState()
  _localPose.ph = s.phase === 'game' ? 'game' : 'editor'
  _localPose.x = playerRig.position.x
  _localPose.y = playerRig.position.y
  _localPose.z = playerRig.position.z
  _localPose.yaw = playerRig.yaw
  _localPose.pitch = playerRig.pitch
  _localPose.w = s.weapon
  _localPose.s = Math.min(1, playerRig.speed / MOVE.runSpeed)
  _localPose.g = playerRig.grounded
  _localPose.st = s.staggered
  return _localPose
}

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
  // collectWorld itself snaps every level group to its true stacked Y first
  // (world.ts snapLevelsForSnapshot), so a jump-in right after enterGame
  // forced levelMode never bakes mid-lerp storey elevations.
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
  // once if the snapshot missed every wall. DEV-ONLY: the race is a Fast
  // Refresh remount artifact (players never remount mid-session), and in
  // production a wall-less lot has `walls.size === 0` as its NORMAL state —
  // without the gate every jump-in there paid a duplicate full-scene
  // collectWorld walk.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    if (world.walls.size > 0) return
    const fresh = collectWorld()
    if (fresh.walls.size > 0) setWorld(fresh)
  }, [world])

  // Co-presence adapter lifecycle — keyed on the session serial (ActiveGame
  // itself remounts fresh per session via GameBoundary's key, and startPresence
  // is idempotent, so a dev-time Fast Refresh remount mid-session only swaps
  // the pose sampler — never despawns the registry or re-announces us).
  // exitGame owns the REAL stop (final ph:'editor' goodbye before teardown);
  // the cleanup below only covers the crash path where ActiveGame unmounts
  // with the session already over. Join/leave events feed muted HUD toasts.
  useEffect(() => {
    const serial = getSessionSerial()
    startPresence(sampleLocalPose) // feature-detected: no bus → no-op
    const offEvents = onPresenceEvent((event) => {
      const hud = getSession()?.hud as unknown as
        | { presenceToast?: (text: string) => void }
        | undefined
      hud?.presenceToast?.(`${event.name} ${event.type === 'join' ? 'joined' : 'left'}`)
    })
    return () => {
      offEvents()
      // Same-session remounts keep the adapter alive; a stale unmount
      // (session ended or a new one started) must not stop the new one.
      if (useBoots.getState().phase !== 'game' && getSessionSerial() === serial) stopPresence()
    }
  }, [])

  useEffect(() => {
    // Bones engineering overlays (X-ray framing/CMU, lumber, service runs,
    // devices) draw members INSIDE walls with their own renderers — once a
    // wall voxelizes they'd survive as an unbreakable ghost layer. Hide the
    // whole overlay roots for the session; exitGame's hiddenObjects ledger
    // restores every visibility flip untouched.
    for (const root of world.overlayRoots) hideForGame(root)

    // Floors for things (MULTILEVEL-PLAN Phase B polish): debris and dust
    // resolve their landing plane through one shared downward probe over
    // live colliders + voxel targets — upper-storey debris rests on the
    // upper floor instead of falling to the terrain plane.
    const landingProbe = (x: number, y: number, z: number) => probeLandingY(world, x, y, z)
    setDebrisGroundProbe(landingProbe)
    setDustFloorProbe(landingProbe)
    // Glass plate shards land on their own storey's floor too — probed once
    // per pane FACE at shatter time (glass.tsx), never per shard/frame.
    setGlassFloorProbe(landingProbe)

    // Dev/E2E handle — lets headless tests aim and fire deterministically.
    ;(globalThis as Record<string, unknown>).__boots = {
      world,
      fire: (weapon: 'pistol' | 'rifle' | 'knife' | 'minigun' = 'rifle') =>
        fire(world, WEAPONS[weapon]),
      teleport: (x: number, z: number, yaw: number, pitch?: number, y?: number) =>
        playerDebug.teleport?.(x, z, yaw, pitch, y),
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
          // Movement-handover flags (climb QA): which grids the capsule
          // skips (walkOnly planks / dormant prebuilds) vs collides.
          walkOnly: target.walkOnly === true,
          dormant: target.dormant === true,
          // Metal spark lane (QA P9R1 fix 2): the coarse flag + how many
          // cells the per-cell mask marks metal (0 = mask-less).
          metal: target.metal === true,
          metalCells: target.cellMetal
            ? target.cellMetal.reduce((n, v) => n + v, 0)
            : 0,
        })),
      // Prevoxelize scheduler live numbers (perf fix 2 QA): frame-dt EMA,
      // the adaptive time budget it picked, and the queue remainder.
      prevoxelize: () => prevoxelizeSchedulerStats(),
      // Conforming-shell lane (S2 default ON): census (shelled targets /
      // fragments / fragments killed / S2 pending deferred builds, totals
      // + per kind) + the per-kind flag toggle. setShell is SESSION-
      // LATCHED per kind: destruction reads each flag once at the
      // session's first voxelize of that kind, so a flip takes effect on
      // the NEXT Jump in — setShell(kind, false) is the kill-switch back
      // to the voxel-only path, no code revert needed.
      shell: () => shellCensus(),
      setShell: (kind: 'wall' | 'roof' | 'slab', v: boolean) => setShellFlag(kind, v),
      // S2 lazy tier: deferred shell builds still outstanding (drains as
      // the player approaches; far targets stay pending by design).
      shellPending: () => shellPendingCount(),
      // Tone audit (voxel-fidelity QA): every node still wearing a
      // FALLBACK skin tone instead of its surface's real albedo, and why
      // ('pending' entries are still retrying ~1/s). Empty = no voxel
      // renders the untextured default. Plain copies via skin-tone.ts.
      toneAudit: () => toneAuditReport(),
      pendingTones: () => pendingToneCount(),
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
      // QA-only total demolition of one node: kills every voxel and snaps
      // every framing segment so save-demolition's strict classifier can be
      // exercised deterministically (sweeping a whole wall clean by scripted
      // gunfire is flaky under headless load). Same code paths as real
      // damage — no state is written outside the destruction store.
      levelTarget: (nodeId: string) => {
        ensureVoxelTarget(world, nodeId)
        const target = useDestruction.getState().targets.get(nodeId)
        if (!target) return false
        collapseWholeTarget(nodeId)
        for (const segment of target.segments) {
          if (segment.broken) continue
          _idOrigin.set(segment.center[0], segment.center[1], segment.center[2])
          damageSegment(world, nodeId, segment.id, 10_000, _idOrigin)
        }
        return true
      },
      // Dust debug — plain-data dump from dust.tsx, never a live ref.
      dust: () => dustDebug(),
      // Debris debug — per-live-piece position + resolved landing plane
      // (debris.tsx debrisDump; floors-for-things QA reads settle heights
      // straight off this instead of traversing instance matrices).
      debris: () => debrisDump(),
      // Glass plate-shard census (owner round 5: panes shatter into flat
      // plates, never cubes) — live count / mean vy / sliver thickness.
      glassShards: () => glassShardCensus(),
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
      // Frame-lag recorder (perf-monitor.ts): spike log + p95/worst summary.
      perf: () => perfSnapshot(),
      perfReset,
      // Where the blast milliseconds went (accumulated {ms, calls} per
      // instrumented phase since the last perfReset) — boom decomposition.
      perfSections,
      // Drain-bound introspection (perf QA round 2026-08-28): unprimed
      // dormant replicas still queued + whether budgeted settle tasks
      // (island flood-fills / structure checks) are pending — both plain
      // counters, so QA can assert the blast-frame drain bound directly.
      dormantPrimeQueueSize,
      settleTasksPending: (prefix?: string) => settleTasksPending(prefix),
      // Co-presence QA dump (presence.ts): live remotes as plain copies
      // ({sessionId, name, p, w, ageMs}) + the {published, received}
      // counters. Empty remotes + zero counters on a bus-less host.
      presence: () => presenceDebug(),
      // Host post-tuning census (host-post.ts, perf fix 5): is the shadow
      // throttle + outline guard live, how many lights are frozen, how
      // often the outline guard had to re-clear. Plain data.
      hostPost: () => hostPostDebug(),
    }
    return () => {
      delete (globalThis as Record<string, unknown>).__boots
      setDebrisGroundProbe(null)
      setDustFloorProbe(null)
      setGlassFloorProbe(null)
      resetDestruction()
      resetGlass()
      clearDebris()
      clearDust()
    }
  }, [world, scene])

  return (
    <>
      <Player world={world} />
      <RemotePlayers />
      <Viewmodel world={world} />
      <PaintTool world={world} />
      <Prevoxelize world={world} />
      <ForeignOverlayHide />
      <OverlaySweep />
      <VoxelWalls />
      <ShellLayer world={world} />
      <GlassCracks />
      <Debris />
      <DustSystem />
      <GameSky world={world} />
      <Grenades world={world} />
      <GunTable world={world} />
      <Doors world={world} />
      <PlacedPieces world={world} />
      <GameItems world={world} />
      <Builder />
      <Enemies world={world} />
      <Nature world={world} />
      <PipelineWarmup world={world} />
      <LoadingDriver world={world} />
      <ResurrectionSweep />
      <TreesDestruct world={world} />
      <HostPostTuning />
      <PerfMonitor />
      <FrameBooster />
    </>
  )
}
