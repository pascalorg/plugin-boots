import { sceneRegistry, useScene } from '@pascal-app/core'
// Namespace import for FEATURE DETECTION only (hostTerrainHelpers): the
// plugin's pinned core (0.9.1) predates the terrain-field exports, but the
// host the plugin actually runs inside resolves this import to ITS core,
// which may carry them. Never referenced through static names.
import * as pascalCore from '@pascal-app/core'
import { snapLevelsToTruePositions, useViewer } from '@pascal-app/viewer'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type InstancedMesh,
  Line3,
  Matrix4,
  type Mesh,
  type Object3D,
  Ray,
  Vector3,
} from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import {
  type BvhAsyncBuilder,
  type BvhPrimeHandle,
  type BvhPrimeTask,
  bvhWorkerStats,
  runBvhPrimeQueue,
  workerBvhBuilder,
} from './bvh-worker'
import {
  FLAT_LOT_Y,
  type GroundSurfaceProbe,
  groundSurfaceY,
  lotFloorY,
  resetGround,
  setGroundSurfaceProbe,
  setLotFloorY,
} from './ground'
import { CELL, type GridAnchor, STOREY } from './grid'
import { WALKABLE_NORMAL_Y } from './movement'
import { perfEvent } from './perf-monitor'

/**
 * One-shot world snapshot taken when the game starts: which host meshes are
 * solid (colliders + bullet targets), which walls are voxel-destructible,
 * which panes are glass, which scene nodes are vegetation trees (combat
 * replacement — hostTrees), where the building sits, and where to spawn.
 *
 * BVHs are cached per-geometry in a module WeakMap — never attached to the
 * host's `geometry.boundsTree`, so the editor's own raycasting is untouched.
 */

export type WallNodeLike = {
  id: string
  start: [number, number]
  end: [number, number]
  height?: number
  thickness?: number
}

export type ColliderEntry = {
  mesh: Mesh
  bvh: MeshBVH
  inverse: Matrix4
  worldBox: Box3
  /** The registered node's root — hidden when this target voxelizes. */
  root: Object3D
  nodeId: string
  nodeType: string
  /** Set when this target was voxelized — the grid takes over collision. */
  disabled?: boolean
  /** FEET SEE THE PLANE (climb feel): placed ramp/roof planks set this at
   * entry creation (builder.tsx PlacedPieceMesh). At the voxelize handover
   * (destruction.hideHostNode) a marked entry becomes `walkOnly` instead of
   * `disabled`, so the capsule keeps the smooth merged-box surface while
   * the voxel grid takes bullets. Host nodes never set it. */
  walkOnClad?: boolean
  /** Active FEET-SEE-THE-PLANE state, set by the voxelize handover on
   * `walkOnClad` entries: capsule sweeps (collision.collideCapsule — player,
   * bots, grenades) still collide with this smooth collider, while bullets,
   * aim/paint raycasts and support probes see the voxel grid instead (they
   * skip it exactly like `disabled`). Flips off — `disabled` takes over —
   * once the piece's voxel target loses more than WALK_ONLY_MAX_DAMAGE of
   * its cells (destruction.settleWalkOnly): holes become real. */
  walkOnly?: boolean
  /** BULLETS SEE THE LEAF (open doors — the walkOnly inverse): set TOGETHER
   * WITH `disabled` by interact.tsx while a door / out-swing window stands
   * open. Movement keeps skipping the entry (every `disabled` consumer is
   * untouched: capsule sweeps, bot door logic, spawn/support probes), but
   * hitscan still tests it (shooting.ts), so an open door leaf can be shot
   * and voxelized at its true swung pose instead of letting rounds fly
   * through the doorway untouched. interact.tsx clears it when the door
   * shuts (with the `disabled` re-latch) and stands down once the node
   * voxelizes — destruction owns the grid then and the hidden host leaf
   * must not answer rays. Host collection never sets it. */
  ballistic?: boolean
}

export type GlassPane = {
  mesh: Mesh
  root: Object3D
  nodeId: string
}

export type DoorEntry = {
  nodeId: string
  /** The registered node root — the object doors.tsx swings on its hinge. */
  root: Object3D
  /** Indices into GameWorld.colliders belonging to this door node. */
  colliderIndices: number[]
  /** Shallow scene-store node snapshot taken at collect time — carries the
   * type fields interaction dispatches on (doorType / openingKind /
   * operationState, plus the geometry fields the host pose helpers read).
   * Optional so hand-built test worlds (and pre-snapshot callers) keep
   * working: no snapshot ⇒ the door is treated as a plain hinged leaf. */
  node?: Record<string, unknown>
}

/**
 * A non-door operable node the interaction system can open/close with E:
 * windows (sliding/casement/awning/hopper/hung/louvered sashes) and
 * cabinets/cabinet-modules (userData.cabinetPose fronts). Mirrors DoorEntry —
 * root + collider indices + a node snapshot for the type fields the pose
 * helpers dispatch on (windowType / openingKind / operationState …).
 */
export type OperableEntry = {
  nodeId: string
  /** The collected SOLID_KINDS registry kind: window | cabinet | cabinet-module. */
  kind: string
  /** The registered node root — the object whose named parts get posed. */
  root: Object3D
  /** Indices into GameWorld.colliders belonging to this node. */
  colliderIndices: number[]
  /** Shallow scene-store node snapshot taken at collect time. */
  node: Record<string, unknown>
}

/**
 * A hard-surface footprint projected onto the ground plane: the XZ triangles
 * of one road / driveway / pad mesh plus their bounds. Nature scatter rejects
 * any sample that lands on (or within a margin of) one of these — no grass
 * blades poking through asphalt.
 */
export type RoadFootprint = {
  /** World-space XZ triangles, packed 6 floats each: ax,az,bx,bz,cx,cz. */
  triangles: Float32Array
  /** XZ bounds of all triangles — cheap pre-filter before triangle tests. */
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/**
 * One host-scene vegetation tree node (a plugin kind like `trees:tree`),
 * captured so the session can swap it for a combat tree at the same world
 * transform. `root` is the node's REGISTERED object — for instanced plant
 * plugins that is the per-node selection proxy (it carries the node's world
 * transform and mounts the real geometry while hovered/selected), so hiding
 * it through the restore ledger covers the proxy lane; the collective
 * forest InstancedMeshes are found separately via collectHostForestMeshes.
 */
export type HostTreeNode = {
  nodeId: string
  /** The registered node root — hide via the session restore ledger only. */
  root: Object3D
  /** World-space base position (includes level offset + floor lift). */
  x: number
  y: number
  z: number
  /** Y rotation in radians (node.rotation[1], 0 when absent). */
  yaw: number
  /** Overall tree height in meters (node.height, defaulted when absent). */
  height: number
  /** True when the node sits on a hidden branch (level toggled off …).
   * Hidden trees get NO combat replacement but stay in the list so forest
   * InstancedMesh matching still recognizes every instance. */
  hidden: boolean
}

/**
 * The host lot, snapshotted at collect time so render-time consumers
 * (nature.tsx) never touch sceneRegistry themselves: identity + polygon +
 * how to read the ground height. The site's terrain surface / skirt / flat
 * ground fill meshes are regular 'site' colliders in GameWorld.colliders.
 */
export type SiteSnapshot = {
  nodeId: string
  /** The registered site root (the SiteRenderer group). */
  root: Object3D
  /** Lot polygon in WORLD XZ (node polygon points through the site root's
   * matrixWorld — identity for top-level sites, but never assumed). */
  polygon: Array<[number, number]>
  /** True when the node carries sculpted terrain data; false = the flat
   * polygon ground fill at y = −0.05. */
  hasTerrain: boolean
  /** Analytic terrain surface height (m) at world (x, z) — present only when
   * the HOST core exports the terrain-field helpers (feature-detected: the
   * plugin's pinned core 0.9.1 predates them) AND the site has terrain.
   * Callers without it fall back to siteGroundYAt (BVH probe). */
  surfaceHeightAt: ((x: number, z: number) => number) | null
}

export type GameWorld = {
  colliders: ColliderEntry[]
  /** wall nodeId → its colliders' indices + node data (for stud generation). */
  walls: Map<string, { node: WallNodeLike; root: Object3D; meshes: Mesh[] }>
  /** Shatterable panes: window glass plus glass-like sub-meshes of
   * ITEM_FAMILY_KINDS nodes (shower doors, glass cabinet fronts). Never
   * colliders, never voxel sources — glass.tsx owns their break. */
  glass: GlassPane[]
  doors: DoorEntry[]
  /** Non-door operables (window / cabinet / cabinet-module) for the E-interact
   * system. Optional so hand-built test worlds don't have to carry it;
   * collectWorld always fills it (possibly empty). */
  operables?: OperableEntry[]
  /** Registered roots of EVERY collected solid node — the hosted-child
   * fence (see collectMeshes) shared with the voxelize-time hide: hosted
   * doors / windows / items render NESTED inside their host wall's mesh,
   * so `visible = false` on that mesh would cull them (invisible closed
   * doors blocking an apparently-open doorway). Optional so hand-built
   * test worlds don't have to carry it; collectWorld always fills it. */
  solidRoots?: ReadonlySet<Object3D>
  /** Roots of engineering-overlay renderers (Bones X-ray members). Never
   * solid or destructible — game-root hides them for the session via the
   * restore ledger so no unbreakable ghost layer haunts voxelized walls.
   * collectWorld always returns it (possibly empty); hand-built test
   * worlds carry `overlayRoots: []`. */
  overlayRoots: Object3D[]
  /** Hard-surface XZ footprints (Streetscape road networks + flat host
   * pads: driveway slabs, parking-spot items, patio blocks). Optional so
   * hand-built test worlds don't have to carry it; collectWorld always
   * fills it (possibly empty). */
  roadFootprints?: RoadFootprint[]
  /** Host-scene vegetation trees (isTreeKind registry kinds) captured for
   * combat replacement by trees-destruct.tsx. Optional so hand-built test
   * worlds don't carry it; collectWorld always fills it (possibly empty). */
  hostTrees?: HostTreeNode[]
  /** Session grid anchor — the rigid XZ frame aligning the build lattice to
   * the building's dominant wall direction (deriveGridAnchor). Optional so
   * hand-built test worlds don't carry it (identity assumed); collectWorld
   * always fills it. builder.tsx installs it via grid.setGridAnchor. */
  gridAnchor?: GridAnchor
  /** Session storey ladder — ascending boundary elevations aligning the
   * grid's storeys to the building's REAL levels (deriveStoreyLadder: the
   * post-snap level group Ys, a measured top span, then sky rungs).
   * Optional so hand-built test worlds don't carry it (the grid falls back
   * to uniform 2.8 m storeys); collectWorld fills it whenever the scene has
   * registered levels. builder.tsx installs it via grid.setStoreyLadder. */
  storeyLadder?: number[]
  /** The first VISIBLE host site collected (its ground meshes are 'site'
   * colliders). Null when the scene has no visible site — nature then mounts
   * its own ground disc. Optional so hand-built test worlds don't have to
   * carry it; collectWorld always fills it (possibly null). */
  site?: SiteSnapshot | null
  buildingAabb: Box3
  spawn: Vector3
  spawnYaw: number
  levelId: string | null
}

/** Kinds that block movement and eat bullets. Registry-keyed leaf kinds only —
 * container kinds (level/building) would double-count their children. */
const SOLID_KINDS = [
  'wall',
  'slab',
  'roof',
  'roof-segment',
  'floor',
  'ceiling',
  'stair',
  'stair-segment',
  'column',
  'door',
  'window',
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'block',
  'fence',
  'counter',
  'kitchen-unit',
  'chimney',
  'dormer',
  'elevator',
  // The host lot itself: sculpted terrain surface + skirt (or the flat
  // polygon ground fill) become walk colliders, so the player stands ON the
  // hill instead of hovering at the y = 0 plane. Indestructible by
  // construction — 'site' is outside every damage dispatch (shooting
  // DESTRUCTIBLE, grenade fallback, prevoxelize walls). Guards in
  // collectWorld: never merged into buildingAabb, swept with the
  // all-registered-roots fence so child buildings stay out of its lane.
  'site',
]

/** Item-family kinds (all in SOLID_KINDS) whose GLASS-LIKE sub-meshes route
 * to `world.glass` instead of the solid collider list — phase 6 owner call:
 * a shower door SHATTERS like a window pane, it never voxelizes into chunky
 * blocks. Solid siblings (tray, frame, bowl…) keep colliding/voxelizing
 * exactly as before. Exported so destruction.ts's silhouette-cell lane and
 * QA assert the same set. */
export const ITEM_FAMILY_KINDS = new Set([
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'counter',
  'kitchen-unit',
])

/** Registry kinds the Bones plugin registers for its overlay renderers
 * (framing/CMU X-ray, lumber, service runs, devices). They draw members
 * INSIDE walls — the wall-layer face buckets (gypsum/sheathing/cladding)
 * are BY DESIGN exactly flush with the drawn wall face (plugin-bones
 * engines/wall-layers.ts) — so once a wall voxelizes they'd read as an
 * unbreakable, z-fighting "drywall" ghost coplanar with the voxel skins.
 * Collected here so the session can hide them wholesale. Exported so QA
 * can assert the exact match set. */
export const OVERLAY_KINDS = ['bones:framing', 'bones:lumber', 'bones:service', 'bones:device']

/** Kind PREFIXES treated as overlay renderers in addition to the explicit
 * list above. Audit 2026-08-25: `bones:framing|lumber|service|device` are
 * the only kinds plugin-bones registers TODAY (grep of every useRegistry
 * call), but bones ships new engines regularly — any future `bones:*` kind
 * is engineering overlay by construction, and missing one here would
 * resurrect the unbreakable-face bug. Prefix-swept against every kind the
 * host registry has ever seen, so no code change is needed when bones adds
 * one. Exported so QA can assert the predicate. */
export const OVERLAY_KIND_PREFIXES = ['bones:']

/** Name prefixes of overlay objects parented OUTSIDE any registered root —
 * bones' framing renderer re-parents cross-level "foreign" groups (gable
 * gypsum/sheathing/cladding, cross-level roof framing) onto LEVEL
 * Object3Ds and names them `bones-foreign-<levelId>`
 * (plugin-bones framing/renderer.tsx buildGroups). Audit 2026-08-25: that
 * is the ONLY out-of-root attachment in all of plugin-bones (the sole
 * scene-graph `.add` not under a registered root). The per-frame hider in
 * game-root.tsx and countCoplanarSuspects below both match through this
 * single exported list so QA can assert the predicate. */
export const OVERLAY_NAME_PREFIXES = ['bones-foreign-']

/** The per-frame hider's name predicate — single source of truth over
 * OVERLAY_NAME_PREFIXES. */
export function isOverlayName(name: string): boolean {
  if (!name) return false
  for (const prefix of OVERLAY_NAME_PREFIXES) if (name.startsWith(prefix)) return true
  return false
}

/** Every registry kind currently treated as overlay: the explicit list plus
 * any registered kind matching OVERLAY_KIND_PREFIXES. */
function overlayKinds(): string[] {
  const kinds = new Set(OVERLAY_KINDS)
  // `Object.keys` on the host's Proxy-backed byType map enumerates every
  // kind that ever registered — built-ins and plugin kinds alike.
  for (const kind of Object.keys(sceneRegistry.byType)) {
    if (OVERLAY_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix))) kinds.add(kind)
  }
  return [...kinds]
}

const bvhCache = new WeakMap<BufferGeometry, MeshBVH>()

/** Cache-miss builds that ran on THIS thread — the other half of the split
 * bvhPrimeStats reports. Counted in bvhFor; page-lifetime, never reset. */
let mainThreadBuilds = 0

let emptyBvh: MeshBVH | null = null

/** Never-throwing fallback: a degenerate BVH that no ray/shape ever hits. */
function fallbackBvh(): MeshBVH {
  if (!emptyBvh) {
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, -1e9, 0, 0, -1e9, 0, 0, -1e9, 0]), 3),
    )
    emptyBvh = new MeshBVH(geometry)
  }
  return emptyBvh
}

/**
 * BVH-only geometry copy, hardened against every host-geometry shape that
 * has broken `new MeshBVH` in the wild:
 *
 * - GROUPS ARE STRIPPED (prod bug 2026-08-29, the "merged-stair" console
 *   error): the host stair system's empty placeholder carries two
 *   `addGroup(0, 0, …)` zero-count groups over a 3-vertex degenerate
 *   triangle. three-mesh-bvh derives one BVH root PER GROUP RANGE — a group
 *   set that intersects nothing yields ZERO roots and `buildPackedTree`
 *   crashes reading `rootRanges[0].offset` of undefined (`TypeError:
 *   reading 'offset'`), which world.ts then degraded to a NON-SOLID mesh
 *   (players/bullets fell through, and the build re-failed every session).
 *   Groups only exist to split material draw ranges; a collision BVH wants
 *   every triangle in one root — which also fixes the quieter bug where
 *   triangles OUTSIDE any group were silently absent from the BVH.
 * - Interleaved positions de-interleave into a plain attribute (prod crash
 *   2026-08-25: GLB attributes made MeshBVH read `.offset` of undefined).
 * - The index is rebuilt as a fresh Uint32Array, dropping any triangle that
 *   references a vertex beyond the position count (a malformed merge can't
 *   crash the build or read garbage bounds).
 * - The copy shares NOTHING with the host geometry, so the build never
 *   mutates the host's index order (MeshBVH reorders in place) and the
 *   worker path can transfer the copy's buffers without neutering a live
 *   render mesh.
 *
 * Exported for the background prime (bvh-worker.ts) and its tests.
 */
export function sanitizeGeometryForBvh(source: BufferGeometry): BufferGeometry {
  const position = source.getAttribute('position')
  const vertexCount = position?.count ?? 0
  const flat = new Float32Array(vertexCount * 3)
  const plain = position as {
    isInterleavedBufferAttribute?: boolean
    array?: unknown
    normalized?: boolean
  }
  if (
    position &&
    !plain.isInterleavedBufferAttribute &&
    !plain.normalized &&
    position.itemSize === 3 &&
    plain.array instanceof Float32Array
  ) {
    flat.set(plain.array.subarray(0, vertexCount * 3))
  } else if (position) {
    for (let i = 0; i < vertexCount; i++) {
      flat[i * 3] = position.getX(i)
      flat[i * 3 + 1] = position.getY(i)
      flat[i * 3 + 2] = position.getZ(i)
    }
  }
  const copy = new BufferGeometry()
  copy.setAttribute('position', new BufferAttribute(flat, 3))
  const index = source.index
  if (index) {
    const triCount = Math.floor(index.count / 3)
    const clean = new Uint32Array(triCount * 3)
    let write = 0
    for (let t = 0; t < triCount; t++) {
      const a = index.getX(t * 3)
      const b = index.getX(t * 3 + 1)
      const c = index.getX(t * 3 + 2)
      if (a < vertexCount && b < vertexCount && c < vertexCount) {
        clean[write] = a
        clean[write + 1] = b
        clean[write + 2] = c
        write += 3
      }
    }
    copy.setIndex(new BufferAttribute(write === clean.length ? clean : clean.slice(0, write), 1))
  }
  // No groups, no drawRange, no extra attributes: full-coverage single-root
  // BVH input. (Audit 2026-08-29: no host system draw-ranges a collider
  // mesh, so covering the full triangle list never over-collides.)
  return copy
}

/**
 * BVH per geometry, built SYNCHRONOUSLY on demand from a sanitized copy
 * (see sanitizeGeometryForBvh) — the correctness path: a capsule sweep or
 * spawn probe that needs a collider THIS frame must get a real BVH now.
 * Anything that still throws degrades to a never-hit BVH instead of
 * crashing the session. The background prime (primeColliderBvhs) fills the
 * same cache from a worker so this path is a WeakMap hit in the common
 * case; see it for the stall numbers this used to cause.
 */
export function bvhFor(mesh: Mesh): MeshBVH {
  let bvh = bvhCache.get(mesh.geometry)
  if (!bvh) {
    // Attribution for the perf monitor: a cache-miss build inside a shot /
    // wake frame is a known first-hit cost — tag it so spikes name it.
    perfEvent('bvh-build')
    mainThreadBuilds++
    try {
      bvh = new MeshBVH(sanitizeGeometryForBvh(mesh.geometry))
    } catch (error) {
      console.warn('[boots] BVH build failed — mesh will be non-solid', mesh.name, error)
      bvh = fallbackBvh()
    }
    bvhCache.set(mesh.geometry, bvh)
  }
  return bvh
}

/** Cache probe — true when `mesh`'s BVH is already built (sync or worker).
 * Never triggers a build. Exported for the prime tests and diagnostics. */
export function bvhBuilt(mesh: Mesh): boolean {
  return bvhCache.has(mesh.geometry)
}

let activeBvhPrime: BvhPrimeHandle | null = null
/** Whether the CURRENT queue is still working — see bvhPrimeStats. */
let bvhPrimeRunning = false

/**
 * Background BVH fill (perf fix #3): hand every collider geometry to the
 * shared worker builder, nearest-to-spawn first, so the cache is warm by
 * the time gameplay first raycasts each collider. Before this, EVERY build
 * ran synchronously inside whatever frame first touched the collider —
 * profiling a real 670-node scene showed 2136 / 1017 / 853 / 451 ms
 * `bvh-build` stalls at t≈12–17 s (historic worst 3177 ms), because a
 * MeshBVH construction is atomic and the budgeted warmup drain still eats
 * one whole build per frame.
 *
 * Correctness never depends on this: bvhFor stays synchronous for anything
 * demanded before its background build lands (the spawn settle's
 * probeSpawnSurfaceY touches 1–2 colliders at mount — those build sync,
 * exactly as before), and a null builder (no Worker, SSR, bun test, host
 * bundler without worker-chunk support, broken worker) makes this a no-op —
 * today's lazy behavior. collectWorld calls it last; each call supersedes
 * the previous session's queue. Returns the handle (null when priming is
 * unavailable or unneeded) for tests.
 */
export function primeColliderBvhs(
  colliders: readonly ColliderEntry[],
  spawn: Vector3,
  buildAsync: BvhAsyncBuilder | null = workerBvhBuilder(),
): BvhPrimeHandle | null {
  activeBvhPrime?.cancel()
  activeBvhPrime = null
  bvhPrimeRunning = false
  if (!buildAsync) return null
  const seen = new Set<BufferGeometry>()
  const tasks: BvhPrimeTask[] = []
  for (const collider of colliders) {
    const geometry = collider.mesh.geometry
    if (!geometry || seen.has(geometry) || bvhCache.has(geometry)) continue
    seen.add(geometry)
    tasks.push({ geometry, priority: collider.worldBox.distanceToPoint(spawn) })
  }
  if (tasks.length === 0) return null
  const handle = runBvhPrimeQueue(tasks, {
    // Sanitize on the main thread at build time (cheap O(n) copies), build
    // in the worker; the copy's buffers transfer, never the host mesh's.
    build: (geometry) => buildAsync(sanitizeGeometryForBvh(geometry)),
    isBuilt: (geometry) => bvhCache.has(geometry),
    onBuilt: (geometry, bvh) => bvhCache.set(geometry, bvh),
  })
  activeBvhPrime = handle
  bvhPrimeRunning = true
  // `done` never rejects and also resolves on cancel — "running" means this
  // queue is still working, not that it succeeded. A superseded queue's `done`
  // must not clear the flag for the queue that replaced it.
  handle.done.then(() => {
    if (activeBvhPrime === handle) bvhPrimeRunning = false
  })
  return handle
}

/**
 * Is the worker's prime queue still working? The frame-loop form of
 * bvhPrimeStats' `priming` — warmup.tsx asks this every frame to know whether to
 * stand down (see stepBvhDrain), so it must cost nothing and take no arguments.
 */
export function isBvhPriming(): boolean {
  return bvhPrimeRunning
}

/**
 * How far the background prime actually got.
 *
 * This reading is what nothing had: a dead worker and a drained queue look
 * IDENTICAL from inside a session — the cache fills either way, correctness
 * never changes, and the only difference is which thread paid for it. That is
 * how off-main-thread building shipped broken and stayed broken for two days
 * (bvh-worker-entry.ts has the story). `built` climbing while `priming` is true
 * is the queue working; `priming` false with `built` short of `geometries` is
 * the queue stopped, which is a builder that failed. And `workerBuilds` is what
 * a full cache alone cannot tell you: WHICH THREAD paid for it — 0 with
 * everything built means every BVH was built synchronously, the broken state
 * exactly.
 *
 * Reads the CACHE ONLY. Never `entry.bvh` — that getter BUILDS, so a reading
 * taken through it would synchronously create the very thing it reports, on the
 * main thread, which is the stall this whole lane exists to avoid.
 *
 * Exposed as `__boots.bvhPrime()`.
 */
export function bvhPrimeStats(colliders: readonly ColliderEntry[]): {
  /** Distinct collider geometries — many colliders share one geometry. */
  geometries: number
  /** …of which how many hold a BVH, from either path. */
  built: number
  /** Is a queue still working? False both before the first prime and after the
   * last one drained, was cancelled, or stopped on a builder failure. */
  priming: boolean
  /** BVHs handed back by the worker since page load (across sessions). */
  workerBuilds: number
  /** …against cache-miss builds that ran on this thread, same window. The two
   * together are the split the cache alone hides. */
  mainThreadBuilds: number
  /** Has the worker been written off? Then everything left is main-thread. */
  workerBroken: boolean
} {
  const seen = new Set<BufferGeometry>()
  let built = 0
  for (const collider of colliders) {
    const geometry = collider.mesh.geometry
    if (!geometry || seen.has(geometry)) continue
    seen.add(geometry)
    if (bvhCache.has(geometry)) built++
  }
  const worker = bvhWorkerStats()
  return {
    geometries: seen.size,
    built,
    priming: isBvhPriming(),
    workerBuilds: worker.builds,
    mainThreadBuilds,
    workerBroken: worker.broken,
  }
}

/** Is this mesh's material glass-like? transparent with opacity < 0.95, or
 * physical transmission > 0.2 (array materials key off slot 0). Applied to
 * 'window' kinds and to ITEM_FAMILY_KINDS sub-meshes in collectWorld — a
 * glass-like mesh routes to world.glass (shatter lane), never colliders.
 * EXPORTED for the ResurrectionSweep lane (game-root.tsx): a voxelized
 * window/item node's un-shattered panes belong to the glass system, so a
 * sweep that ledger-hides `collectMeshes(root, fence)` wholesale must skip
 * the meshes this predicate matches or live shower doors / window panes
 * vanish ~1 s after their host node voxelizes. */
export function isGlassLikeMesh(mesh: Mesh): boolean {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  if (!material) return false
  const m = material as { transparent?: boolean; opacity?: number; transmission?: number }
  return Boolean((m.transparent && (m.opacity ?? 1) < 0.95) || (m.transmission ?? 0) > 0.2)
}

/** Is this mesh presentation-only backdrop? The host's SiteRenderer tags its
 * horizon disc — a 400 m+ raycast-noop ground plate at y = −0.07 fading into
 * the sky — with `userData.pascalExport = 'strip'` (the only such tag in the
 * host today). BVH collision never goes through `mesh.raycast`, so without
 * this filter the disc would become an enormous walkable "floor" collider
 * covering every XZ probe on the map. */
function isPresentationStrip(mesh: Mesh): boolean {
  return (mesh.userData as { pascalExport?: string }).pascalExport === 'strip'
}

/** Is every effective material of this mesh flagged invisible? Windows ship
 * full-rect interaction HITBOXES as `mesh.visible = true` meshes whose
 * MATERIAL has `visible = false` — three.js never renders (or raycasts,
 * see Mesh.raycast) those, but a `mesh.visible` check alone would collect
 * them as solid 'window' colliders that eat every glazing shot and grenade
 * pass (QA p4r3 bug 2). Material-less meshes render nothing either. */
function isMaterialInvisible(mesh: Mesh): boolean {
  const material = mesh.material
  if (Array.isArray(material)) {
    return material.length === 0 || material.every((m) => !m || m.visible === false)
  }
  return !material || material.visible === false
}

/**
 * Meshes of ONE node's subtree. `stopAt` (the registered roots of every
 * OTHER collected solid node) fences the sweep: hosted children — doors /
 * windows / wall-mounted items render NESTED inside their host wall's
 * registered root — are their own solid nodes and must never be swept into
 * the host's mesh set. Without the fence a closed door leaf + frame bake
 * into the wall's voxel grid at prevoxelize (the doorway reads as solid
 * voxel wall that never clears when the door opens — QA round-2 door
 * walk-through bug) and their colliders misattribute bullet damage to the
 * wall. Each fenced subtree is still collected — under its OWN nodeId, by
 * its own SOLID_KINDS pass. Meshes whose effective material is invisible
 * are skipped (see isMaterialInvisible). Exported so ResurrectionSweep in
 * game-root.tsx hides through the exact same fence + filters.
 */
export function collectMeshes(root: Object3D, stopAt?: ReadonlySet<Object3D>): Mesh[] {
  const meshes: Mesh[] = []
  const walk = (obj: Object3D): void => {
    if (obj !== root && stopAt?.has(obj)) return
    const mesh = obj as Mesh
    if (
      mesh.isMesh &&
      mesh.visible &&
      !(mesh.userData as { __boots?: boolean }).__boots &&
      !isPresentationStrip(mesh) &&
      !isMaterialInvisible(mesh) &&
      (mesh.geometry?.getAttribute?.('position')?.count ?? 0) >= 3
    ) {
      meshes.push(mesh)
    }
    for (const child of obj.children) walk(child)
  }
  walk(root)
  return meshes
}

/**
 * Registered roots of every SOLID_KINDS node currently in the registry —
 * the `stopAt` fence for collectMeshes. collectWorld builds its snapshot
 * fence through this; ResurrectionSweep (game-root.tsx) rebuilds it every
 * sweep so hosted children registered mid-session still fence correctly.
 */
export function collectSolidRoots(): Set<Object3D> {
  const solidRoots = new Set<Object3D>()
  for (const kind of SOLID_KINDS) {
    const ids = sceneRegistry.byType[kind]
    if (!ids) continue
    for (const id of ids) {
      const root = sceneRegistry.nodes.get(id)
      if (root) solidRoots.add(root)
    }
  }
  return solidRoots
}

/**
 * Bones overlay roots — installations may predate any of these kinds, so
 * guard every byType lookup (the map only has keys something registered).
 * Exported separately from collectWorld so the session can re-sweep a few
 * frames in: overlay renderers register their nodes asynchronously and a
 * root that lands AFTER the world snapshot would otherwise stay visible
 * (and unbreakable) for the whole session.
 */
export function collectOverlayRoots(): Object3D[] {
  const overlayRoots: Object3D[] = []
  for (const kind of overlayKinds()) {
    const ids = sceneRegistry.byType[kind]
    if (!ids) continue
    for (const id of ids) {
      const root = sceneRegistry.nodes.get(id)
      if (root) overlayRoots.push(root)
    }
  }
  return overlayRoots
}

/**
 * QA / owner-repro probe: count the meshes that would ACTUALLY RENDER right
 * now and match the bones overlay patterns — descendants of a registered
 * overlay root (OVERLAY_KINDS + OVERLAY_KIND_PREFIXES) or of an object whose
 * name matches OVERLAY_NAME_PREFIXES. "Would render" = self and every
 * ancestor visible AND a non-empty layer mask (the per-frame hider's two
 * mechanisms), so during a game session this MUST be 0; any non-zero count
 * is an unbreakable coplanar face waiting to be reported, and the traversal
 * path tells QA exactly which hide is being undone. Exposed on `__boots`
 * by game-root. Pure and read-only — never mutates the scene.
 */
export function countCoplanarSuspects(sceneRoot: Object3D): number {
  const overlayRoots = new Set(collectOverlayRoots())
  let count = 0
  const walk = (object: Object3D, inOverlay: boolean): void => {
    // An invisible ancestor culls the whole subtree in three.js — nothing
    // below it renders, so nothing below it is a suspect.
    if (!object.visible) return
    const overlay = inOverlay || overlayRoots.has(object) || isOverlayName(object.name)
    if (
      overlay &&
      (object as { isMesh?: boolean }).isMesh === true &&
      object.layers.mask !== 0
    ) {
      count++
    }
    for (const child of object.children) walk(child, overlay)
  }
  walk(sceneRoot, false)
  return count
}

// ---------------------------------------------------------------------------
// Road / hard-surface footprints (nature-scatter rejection)
// ---------------------------------------------------------------------------

/** Registry kinds whose meshes ARE road surface. The community host ships
 * `@pascal-app/plugin-streetscape`, whose road-network renderer registers
 * under this kind and names every paved mesh `road-*` (segment surfaces,
 * junction bands, sidewalks/curbs/gutters, medians, markings, roundabout
 * islands). */
const ROAD_KINDS = ['streetscape:road-network']

/** Road-network meshes that are NOT pavement on the ground: editor-only
 * ghosts (`*-preview`), invisible pick targets (`road-edge-hit`,
 * `road-curb-corner-hit`), validation badges, manual-boundary handles and
 * approach hits, elevated `road-bridge-*` decks/piers (grass under a bridge
 * is fine), and `road-earthwork-*` embankment slopes (those WANT grass). */
const ROAD_MESH_EXCLUDE = /preview|hit|validation|boundary|approach|earthwork|bridge/

/** Solid kinds that double as hard-surface ground pads when they lie flat
 * near the ground: driveway/patio slabs, flat catalog items (the
 * `parking-spot` asphalt pad is 0.12 m thick), and block pavers. */
const PAD_KINDS = new Set(['slab', 'item', 'block'])
/** A pad is "flat" when its world AABB is at most this tall… */
const PAD_MAX_THICKNESS = 0.35
/** …and starts at most this far above THE GROUND UNDER IT (an absolute
 * ceiling dropped every driveway on a lot standing higher than 0.6 m, and
 * grass grew straight through the pavement). */
const PAD_MAX_BASE_Y = 0.6

/** Triangles whose lowest vertex sits more than this above the ground under
 * them are skipped — an elevated deck is not ground the draped scatter could
 * poke through. Measured from the dirt, not from the lot plane: on a yard at
 * +1.7 an absolute 1.5 dropped the road mesh itself. */
const FOOTPRINT_MAX_Y = 1.5
/** Degenerate XZ triangles (vertical faces seen from above) carry no area
 * worth testing; the scatter margin already covers their sliver. */
const FOOTPRINT_MIN_AREA = 1e-6
/** Meshes past this vertex count fall back to their world AABB rectangle —
 * a footprint is a coarse mask, not a render. */
const FOOTPRINT_VERTEX_BUDGET = 30000

/** Keep grass at least this far (m) from any hard-surface edge. */
export const ROAD_SCATTER_MARGIN = 0.3

const _fpA = new Vector3()
const _fpB = new Vector3()
const _fpC = new Vector3()

/**
 * World-space triangles of a mesh projected to XZ, packed 6 floats per
 * triangle. XZ-degenerate triangles are dropped, and so are elevated ones:
 * `rise` is how far a triangle's lowest vertex may sit ABOVE THE GROUND
 * UNDER IT (one field lookup per triangle, once per session — and on a flat
 * lot no probe is installed, so the ground is 0 and this is the historical
 * absolute test).
 */
export function meshFootprintTriangles(mesh: Mesh, rise = FOOTPRINT_MAX_Y): Float32Array {
  const geometry = mesh.geometry
  const position = geometry?.getAttribute?.('position')
  if (!position || position.count < 3) return new Float32Array(0)
  mesh.updateWorldMatrix(true, false)
  const index = geometry.index
  const triCount = Math.floor((index ? index.count : position.count) / 3)
  const out: number[] = []
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2
    _fpA.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld)
    _fpB.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld)
    _fpC.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld)
    const ground = groundSurfaceY((_fpA.x + _fpB.x + _fpC.x) / 3, (_fpA.z + _fpB.z + _fpC.z) / 3)
    if (Math.min(_fpA.y, _fpB.y, _fpC.y) > ground + rise) continue
    const area = Math.abs(
      (_fpB.x - _fpA.x) * (_fpC.z - _fpA.z) - (_fpC.x - _fpA.x) * (_fpB.z - _fpA.z),
    )
    if (area < FOOTPRINT_MIN_AREA) continue
    out.push(_fpA.x, _fpA.z, _fpB.x, _fpB.z, _fpC.x, _fpC.z)
  }
  return new Float32Array(out)
}

/** Bounds-wrapped footprint, or null when no triangle survived. */
export function footprintFromTriangles(triangles: Float32Array): RoadFootprint | null {
  if (triangles.length < 6) return null
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < triangles.length; i += 2) {
    const x = triangles[i]!
    const z = triangles[i + 1]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return { triangles, minX, minZ, maxX, maxZ }
}

/** Squared distance from (px,pz) to segment (ax,az)→(bx,bz) in XZ. */
function segmentDistSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  let t = lengthSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSq : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = ax + dx * t - px
  const qz = az + dz * t - pz
  return qx * qx + qz * qz
}

/**
 * Is the XZ point on (or within `margin` of) any hard-surface footprint?
 * Winding-agnostic point-in-triangle plus distance-to-edge for the margin;
 * footprint AABB then per-triangle bounds pre-filter, so the common
 * off-road sample costs a handful of compares.
 */
export function pointOnRoad(
  footprints: readonly RoadFootprint[] | undefined,
  x: number,
  z: number,
  margin = ROAD_SCATTER_MARGIN,
): boolean {
  if (!footprints || footprints.length === 0) return false
  const marginSq = margin * margin
  for (const footprint of footprints) {
    if (
      x < footprint.minX - margin ||
      x > footprint.maxX + margin ||
      z < footprint.minZ - margin ||
      z > footprint.maxZ + margin
    ) {
      continue
    }
    const tri = footprint.triangles
    for (let i = 0; i < tri.length; i += 6) {
      const ax = tri[i]!
      const az = tri[i + 1]!
      const bx = tri[i + 2]!
      const bz = tri[i + 3]!
      const cx = tri[i + 4]!
      const cz = tri[i + 5]!
      if (x < Math.min(ax, bx, cx) - margin || x > Math.max(ax, bx, cx) + margin) continue
      if (z < Math.min(az, bz, cz) - margin || z > Math.max(az, bz, cz) + margin) continue
      const d1 = (bx - ax) * (z - az) - (bz - az) * (x - ax)
      const d2 = (cx - bx) * (z - bz) - (cz - bz) * (x - bx)
      const d3 = (ax - cx) * (z - cz) - (az - cz) * (x - cx)
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0
      if (!(hasNeg && hasPos)) return true
      if (
        marginSq > 0 &&
        (segmentDistSq(x, z, ax, az, bx, bz) <= marginSq ||
          segmentDistSq(x, z, bx, bz, cx, cz) <= marginSq ||
          segmentDistSq(x, z, cx, cz, ax, az) <= marginSq)
      ) {
        return true
      }
    }
  }
  return false
}

/** Two XZ triangles covering a world AABB — the over-budget mesh fallback. */
function boxFootprintTriangles(box: Box3): Float32Array {
  const { min, max } = box
  // biome-ignore format: two triangles, one per row
  return new Float32Array([
    min.x, min.z, max.x, min.z, max.x, max.z,
    min.x, min.z, max.x, max.z, min.x, max.z,
  ])
}

function onHiddenBranch(root: Object3D): boolean {
  let walker: Object3D | null = root
  while (walker) {
    if (!walker.visible) return true
    walker = walker.parent
  }
  return false
}

/**
 * Hard-surface footprints the nature scatter must stay off:
 * 1. Streetscape road networks — every `road-*` surface mesh under each
 *    registered `streetscape:road-network` root (curved ribbons, junctions,
 *    sidewalks: exact projected triangles, not boxes).
 * 2. Flat host pads among the collected colliders — slab / item / block
 *    meshes lying flat near the ground (driveways, parking pads, patios).
 * Exported for QA; collectWorld calls it with the fresh collider set.
 */
export function collectRoadFootprints(colliders: readonly ColliderEntry[]): RoadFootprint[] {
  const footprints: RoadFootprint[] = []
  const push = (triangles: Float32Array) => {
    const footprint = footprintFromTriangles(triangles)
    if (footprint) footprints.push(footprint)
  }

  for (const kind of ROAD_KINDS) {
    const ids = sceneRegistry.byType[kind]
    if (!ids) continue
    for (const id of ids) {
      const root = sceneRegistry.nodes.get(id)
      if (!root || onHiddenBranch(root)) continue
      root.updateWorldMatrix(true, true)
      for (const mesh of collectMeshes(root)) {
        if (!mesh.name.startsWith('road-') || ROAD_MESH_EXCLUDE.test(mesh.name)) continue
        push(meshFootprintTriangles(mesh))
      }
    }
  }

  const size = new Vector3()
  for (const entry of colliders) {
    if (!PAD_KINDS.has(entry.nodeType)) continue
    entry.worldBox.getSize(size)
    if (size.y > PAD_MAX_THICKNESS) continue
    const box = entry.worldBox
    const padGround = groundSurfaceY((box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2)
    if (box.min.y - padGround > PAD_MAX_BASE_Y) continue
    const position = entry.mesh.geometry?.getAttribute?.('position')
    if (position && position.count > FOOTPRINT_VERTEX_BUDGET) {
      push(boxFootprintTriangles(entry.worldBox))
    } else {
      push(meshFootprintTriangles(entry.mesh))
    }
  }

  return footprints
}

// ---------------------------------------------------------------------------
// Host site / terrain — the lot the whole session stands on
// ---------------------------------------------------------------------------

/**
 * Even-odd point-in-polygon over XZ (winding-agnostic ray crossing). Used to
 * clamp nature scatter to the lot polygon — without the boots ground disc,
 * anything beyond the polygon floats over the host's horizon plate. Fewer
 * than 3 points is no polygon: nothing is inside it. Pure; exported for the
 * site tests.
 */
export function pointInPolygonXZ(
  points: ReadonlyArray<readonly [number, number]>,
  x: number,
  z: number,
): boolean {
  if (points.length < 3) return false
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i]![0]
    const zi = points[i]![1]
    const xj = points[j]![0]
    const zj = points[j]![1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/**
 * How far inside the lot boundary a clamped spawn point lands (m). Roughly a
 * bot capsule diameter plus slack: a point ON the boundary is a coin flip
 * between the terrain triangle and nothing at all (the polygon edge is where
 * the site mesh ends), and a droid's 0.45 m radius must fit entirely over
 * ground or the capsule pass shoves it off the lot on its first tick.
 */
export const LOT_SPAWN_INSET = 1.5

/**
 * The radius along a ray that keeps a point ON THE LOT, as close to `desired`
 * as the parcel allows — the deterministic half of the wave-spawn clamp
 * (enemies.tsx spawnWave). The ray is the ring's own direction, so a clamp
 * only ever SHORTENS the radius and the wave keeps its angular spread; a bot
 * that can't stand 30 m out on that bearing stands as far out as the lot goes
 * on that same bearing.
 *
 * Every crossing of the ray with the polygon is collected and sorted, which
 * makes the inside/outside runs explicit: correct for a CONCAVE parcel (an
 * L-shaped lot's ray can leave and re-enter, and the naive "first crossing
 * wins" answer would refuse the whole far arm) and for a ring center that is
 * itself off the lot (the runs then start OUTSIDE). Each run is inset at both
 * ends; a run too thin to inset degenerates to its midpoint rather than being
 * dropped, so a narrow strip of a lot still spawns bots instead of falling
 * through to the fallback. Among the surviving runs, the one whose clamp lands
 * nearest `desired` wins (ties → the larger radius, i.e. further from the
 * player). Returns null only when the ray never crosses into the polygon at
 * all — the caller's cue to use lotPerimeterPoint instead.
 *
 * `polygon` shorter than 3 points is NOT a lot: `desired` passes through
 * untouched, which is exactly the pre-existing behaviour on a void or flat
 * scene (no site node → no polygon → the ring is what it always was).
 * Pure; no allocation beyond one crossings array per call (called `count`
 * times per wave, never per frame).
 */
export function lotRadiusAlong(
  polygon: ReadonlyArray<readonly [number, number]>,
  originX: number,
  originZ: number,
  dirX: number,
  dirZ: number,
  desired: number,
  inset = LOT_SPAWN_INSET,
): number | null {
  if (polygon.length < 3) return desired
  const dirLen = Math.hypot(dirX, dirZ)
  if (dirLen < 1e-9) return null
  const dx = dirX / dirLen
  const dz = dirZ / dirLen

  // Ray × edge crossings. O + t·D = A + u·E, u ∈ [0, 1], t ≥ 0.
  const crossings: number[] = []
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j]![0]
    const az = polygon[j]![1]
    const ex = polygon[i]![0] - ax
    const ez = polygon[i]![1] - az
    const den = dx * ez - dz * ex
    if (Math.abs(den) < 1e-12) continue // parallel — the run bounds come from its neighbours
    const wx = ax - originX
    const wz = az - originZ
    const u = (wx * dz - wz * dx) / den
    if (u < 0 || u > 1) continue
    const t = (wx * ez - wz * ex) / den
    if (t >= 0) crossings.push(t)
  }
  crossings.sort((a, b) => a - b)

  let inside = pointInPolygonXZ(polygon, originX, originZ)
  let best: number | null = null
  let bestError = Number.POSITIVE_INFINITY
  const consider = (lo: number, hi: number): void => {
    // Inset both ends; a run thinner than 2·inset collapses to its midpoint.
    const a = lo + inset
    const b = hi - inset
    const value = a > b ? (lo + hi) / 2 : desired < a ? a : desired > b ? b : desired
    if (value < 0) return
    const error = Math.abs(value - desired)
    if (error < bestError || (error === bestError && best !== null && value > best)) {
      bestError = error
      best = value
    }
  }
  let cursor = 0
  for (const t of crossings) {
    if (inside) consider(cursor, t)
    cursor = t
    inside = !inside
  }
  // A closed polygon always ends OUTSIDE; an unpaired tail is numerical noise
  // (the ray grazed a vertex) and is deliberately dropped rather than treated
  // as an unbounded run.
  return best
}

/**
 * A point ON the lot at `fraction` of the way around its perimeter, pushed
 * `inset` inward — the BOUNDED FALLBACK for wave spawning when the ring
 * itself cannot be clamped (a ring center off the lot on a bearing that
 * misses the parcel, or a lot so small the clamp lands in the player's lap).
 * Walking the perimeter keeps the wave SPREAD — the whole point of the ring —
 * where a "give up and use the centroid" fallback would stack the wave on one
 * point, which is worse than the bug being fixed.
 *
 * Inward is found by TESTING both edge normals against the polygon, so it
 * needs no winding convention (the host's polygon points arrive in whatever
 * order the parcel was drawn). If neither side is inside — a lot thinner than
 * 2·inset — the boundary point itself is returned: still the parcel's own
 * ground, which is the best a sliver offers. Null only for a degenerate
 * polygon (< 3 points, or zero perimeter). Pure.
 */
export function lotPerimeterPoint(
  polygon: ReadonlyArray<readonly [number, number]>,
  fraction: number,
  inset = LOT_SPAWN_INSET,
): [number, number] | null {
  if (polygon.length < 3) return null
  let perimeter = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    perimeter += Math.hypot(polygon[i]![0] - polygon[j]![0], polygon[i]![1] - polygon[j]![1])
  }
  if (perimeter < 1e-6) return null
  const wrapped = fraction - Math.floor(fraction)
  let remaining = wrapped * perimeter
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j]![0]
    const az = polygon[j]![1]
    const ex = polygon[i]![0] - ax
    const ez = polygon[i]![1] - az
    const len = Math.hypot(ex, ez)
    if (len < 1e-9) continue
    if (remaining > len && i !== polygon.length - 1) {
      remaining -= len
      continue
    }
    // Stay `inset` clear of BOTH endpoints: at a vertex, the inward offset
    // along one edge's normal slides along the OTHER edge and lands exactly
    // on the boundary, where an even-odd test is a coin flip (it read the
    // parcel's own corners as off-lot). An edge shorter than 2·inset has no
    // such room and answers with its midpoint.
    const margin = len > inset * 2 ? inset / len : 0.5
    const t = Math.min(1 - margin, Math.max(margin, Math.min(1, remaining / len)))
    const px = ax + ex * t
    const pz = az + ez * t
    // Both edge normals, then keep the one that lands inside.
    const nx = -ez / len
    const nz = ex / len
    if (pointInPolygonXZ(polygon, px + nx * inset, pz + nz * inset)) {
      return [px + nx * inset, pz + nz * inset]
    }
    if (pointInPolygonXZ(polygon, px - nx * inset, pz - nz * inset)) {
      return [px - nx * inset, pz - nz * inset]
    }
    return [px, pz]
  }
  return null
}

const _siteRay = new Ray()
const _siteHitPoint = new Vector3()

/**
 * Terrain surface height at world (x, z) read from the SITE colliders alone:
 * a downward BVH raycast per XZ-covering site collider, cast from above the
 * highest candidate top (mirrors probeSpawnSurfaceY) — the topmost hit wins.
 * No walkability filter: scatter drapes flora onto steep banks too. Returns
 * null when no site collider covers the XZ (off the lot, or a scene without
 * a site). This is the fallback ground authority when the host core doesn't
 * export the analytic terrain field (SiteSnapshot.surfaceHeightAt) — cache
 * friendly: bvhFor memoizes per geometry and the scratch Ray/Vector3 are
 * module-level, so a 20k-instance scatter pass allocates nothing.
 */
export function siteGroundYAt(
  world: Pick<GameWorld, 'colliders'>,
  x: number,
  z: number,
): number | null {
  let ceiling = Number.NEGATIVE_INFINITY
  for (const collider of world.colliders) {
    if (collider.nodeType !== 'site' || collider.disabled) continue
    const box = collider.worldBox
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
    if (box.max.y > ceiling) ceiling = box.max.y
  }
  if (!Number.isFinite(ceiling)) return null

  const fromY = ceiling + 1
  let best: number | null = null
  for (const collider of world.colliders) {
    if (collider.nodeType !== 'site' || collider.disabled) continue
    const box = collider.worldBox
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
    if (best !== null && box.max.y <= best) continue
    _siteRay.origin.set(x, fromY, z)
    _siteRay.direction.set(0, -1, 0)
    _siteRay.applyMatrix4(collider.inverse)
    const hit = collider.bvh.raycastFirst(_siteRay, 2)
    if (!hit) continue
    const worldY = _siteHitPoint.copy(hit.point).applyMatrix4(collider.mesh.matrixWorld).y
    if (best === null || worldY > best) best = worldY
  }
  return best
}

/** The host core's analytic terrain helpers, when its version exports them. */
type TerrainHelperFns = {
  fieldOf: (site: { id: string; terrain?: unknown }) => unknown
  surfaceHeightAt: (field: unknown, x: number, z: number) => number
}

/**
 * FEATURE-DETECT the analytic ground authority: `terrainFieldOf` +
 * `surfaceHeightAt` shipped in the host core well after the plugin's pinned
 * 0.9.1 — a static named import would fail type-check against the pin and
 * crash module load on an old host. Detected off the namespace import at
 * call time, so whichever core the HOST bundles decides.
 */
function hostTerrainHelpers(): TerrainHelperFns | null {
  const core = pascalCore as unknown as Record<string, unknown>
  const fieldOf = core.terrainFieldOf
  const surfaceHeightAt = core.surfaceHeightAt
  if (typeof fieldOf !== 'function' || typeof surfaceHeightAt !== 'function') return null
  return {
    fieldOf: fieldOf as TerrainHelperFns['fieldOf'],
    surfaceHeightAt: surfaceHeightAt as TerrainHelperFns['surfaceHeightAt'],
  }
}

const _sitePolygonPoint = new Vector3()

/**
 * Build the GameWorld.site snapshot from the picked site node: world-space
 * polygon + terrain flag + the analytic height closure when the host core
 * provides one (see hostTerrainHelpers — injectable for tests). A throwing
 * helper (host-version mismatch) degrades to the BVH-probe fallback, never
 * takes down Jump-in.
 */
export function buildSiteSnapshot(
  pick: { id: string; root: Object3D; node: Record<string, unknown> } | null,
  helpers: TerrainHelperFns | null = hostTerrainHelpers(),
): SiteSnapshot | null {
  if (!pick) return null
  const polygonRaw = (pick.node.polygon as { points?: unknown } | undefined)?.points
  const polygon: Array<[number, number]> = []
  if (Array.isArray(polygonRaw)) {
    pick.root.updateWorldMatrix(true, false)
    for (const point of polygonRaw) {
      if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
        continue
      }
      _sitePolygonPoint.set(point[0], 0, point[1]).applyMatrix4(pick.root.matrixWorld)
      polygon.push([_sitePolygonPoint.x, _sitePolygonPoint.z])
    }
  }
  const hasTerrain = pick.node.terrain != null
  let surfaceHeightAt: SiteSnapshot['surfaceHeightAt'] = null
  if (hasTerrain && helpers) {
    try {
      const field = helpers.fieldOf({ id: pick.id, terrain: pick.node.terrain })
      if (field) {
        surfaceHeightAt = (x: number, z: number) => helpers.surfaceHeightAt(field, x, z)
      }
    } catch {
      surfaceHeightAt = null
    }
  }
  return { nodeId: pick.id, root: pick.root, polygon, hasTerrain, surfaceHeightAt }
}

// ---------------------------------------------------------------------------
// The lot edge — walkable ground past the parcel
// ---------------------------------------------------------------------------

/**
 * The off-lot ground, once it exists: the host's OWN horizon plate made solid.
 *
 * The parcel polygon is where the terrain is, not where the world ends. Past
 * it the session had ground you could see and not stand on: SiteRenderer draws
 * a 400 m+ disc at y = −0.07 under every site, isPresentationStrip keeps it
 * out of collectMeshes (as it must — an unconditional 800 m floor collider
 * would answer every XZ probe on the map), and so a player who walked off a
 * sculpted lot sank through the visible grass onto the collision backstop
 * (−5.61 m on the owner's project) and stood under the world.
 *
 * The fix adopts the plate the host already renders instead of synthesizing an
 * apron: same geometry, same height, so solid and visible agree by
 * construction. It is only ever adopted when the plate is PROVEN holed over
 * the terrain (see plateHasTerrainHole) — the host punches the terrain
 * footprint out of the disc precisely so the two never overlap, and adopting
 * an unholed plate would seal every excavation at −0.07.
 *
 * `min/max` is the terrain field rect the hole is punched for: inside it the
 * terrain is the ground, outside it this plate is. The analytic probe needs
 * that boundary because the host's terrain field CLAMPS to its border height
 * out of range (a sculpted border would otherwise report metres of phantom
 * ground over the flat plate).
 */
export type LotEdge = {
  /** World Y of the plate — the ground off the lot. */
  y: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** The host's disc is a flat ShapeGeometry. Anything with real thickness is
 * some other 'strip'-tagged mesh, not the apron. */
const PLATE_MAX_THICKNESS = 0.05
/** …and the apron SURROUNDS the terrain: the host's disc is 400 m+ across, so
 * demand real reach past the field rect on all four sides. A strip-tagged
 * mesh sitting inside the lot is decoration, not ground. */
const PLATE_MIN_REACH = 20
/** Where plateHasTerrainHole samples (fractions of the field rect). The hole
 * is the field rect inset by half a cell, so a 3 × 3 grid at the quarter
 * points is comfortably inside it — no sample can graze the plate's inner rim
 * and refuse a perfectly good apron. */
const PLATE_HOLE_FRACTIONS = [0.25, 0.5, 0.75]

/**
 * The meshes collectMeshes deliberately drops as presentation-only backdrop:
 * the same walk, the same fence, the same invisible/degenerate/boots-owned
 * filters — only isPresentationStrip is inverted.
 */
function collectPresentationStrips(root: Object3D, stopAt?: ReadonlySet<Object3D>): Mesh[] {
  const meshes: Mesh[] = []
  const walk = (obj: Object3D): void => {
    if (obj !== root && stopAt?.has(obj)) return
    const mesh = obj as Mesh
    if (
      mesh.isMesh &&
      mesh.visible &&
      !(mesh.userData as { __boots?: boolean }).__boots &&
      isPresentationStrip(mesh) &&
      !isMaterialInvisible(mesh) &&
      (mesh.geometry?.getAttribute?.('position')?.count ?? 0) >= 3
    ) {
      meshes.push(mesh)
    }
    for (const child of obj.children) walk(child)
  }
  walk(root)
  return meshes
}

/** XZ union of the site colliders collected so far — the terrain field rect
 * (surface + edge skirt; nothing else is a 'site' mesh). Null when there are
 * none, or when the union is degenerate. */
function siteColliderRect(
  colliders: ReadonlyArray<ColliderEntry>,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const collider of colliders) {
    if (collider.nodeType !== 'site' || collider.disabled) continue
    const box = collider.worldBox
    if (box.min.x < minX) minX = box.min.x
    if (box.max.x > maxX) maxX = box.max.x
    if (box.min.z < minZ) minZ = box.min.z
    if (box.max.z > maxZ) maxZ = box.max.z
  }
  if (!Number.isFinite(minX) || maxX - minX < 1e-6 || maxZ - minZ < 1e-6) return null
  return { minX, maxX, minZ, maxZ }
}

/**
 * Is this candidate plate punched open over the terrain? Nine downward probes
 * across the field rect must ALL miss it. One hit means the plate spans the
 * terrain, and adopting it would lay a flat lid at −0.07 over every basement,
 * pond and cut on the lot — refuse it and leave the edge as it was rather
 * than break the parcel to fix its border.
 */
function plateHasTerrainHole(
  plate: ColliderEntry,
  rect: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  const probe = [plate]
  for (const fx of PLATE_HOLE_FRACTIONS) {
    for (const fz of PLATE_HOLE_FRACTIONS) {
      const x = rect.minX + (rect.maxX - rect.minX) * fx
      const z = rect.minZ + (rect.maxZ - rect.minZ) * fz
      if (siteGroundYAt({ colliders: probe }, x, z) !== null) return false
    }
  }
  return true
}

/**
 * Make the ground off the lot walkable by adopting the host's horizon plate as
 * a 'site' collider, and report where the terrain stops. Mutates `colliders`
 * (one entry at most) and returns null when nothing was adopted.
 *
 * A 'site' entry is the right shape for it: outside damage dispatch, out of
 * buildingAabb, not in PAD_KINDS (never a road footprint), eligible for spawn
 * probes — indistinguishable from the terrain colliders it continues, under
 * the same nodeId.
 *
 * Only sculpted sites qualify. A FLAT site has no hole punched (nothing to
 * punch one for) and needs none: its polygon fill sits at −0.05 and off it the
 * backstop already holds bodies at FLAT_LOT_Y = 0, five centimetres of
 * seamless — while a void lot has no site node at all and keeps the
 * infinite-grass horizon rig (horizon.ts) untouched.
 */
export function adoptLotPlate(
  colliders: ColliderEntry[],
  site: SiteSnapshot | null,
  fence?: ReadonlySet<Object3D>,
): LotEdge | null {
  if (!site?.hasTerrain) return null
  const rect = siteColliderRect(colliders)
  if (!rect) return null

  let best: ColliderEntry | null = null
  let bestArea = 0
  const bounds = new Box3()
  for (const mesh of collectPresentationStrips(site.root, fence)) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    bounds.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
    if (bounds.max.y - bounds.min.y > PLATE_MAX_THICKNESS) continue
    if (
      bounds.min.x > rect.minX - PLATE_MIN_REACH ||
      bounds.max.x < rect.maxX + PLATE_MIN_REACH ||
      bounds.min.z > rect.minZ - PLATE_MIN_REACH ||
      bounds.max.z < rect.maxZ + PLATE_MIN_REACH
    ) {
      continue
    }
    const area = (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z)
    if (best && area <= bestArea) continue
    const candidate: ColliderEntry = {
      mesh,
      get bvh() {
        return bvhFor(this.mesh)
      },
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: bounds.clone(),
      root: site.root,
      nodeId: site.nodeId,
      nodeType: 'site',
    }
    if (!plateHasTerrainHole(candidate, rect)) continue
    best = candidate
    bestArea = area
  }
  if (!best) return null

  colliders.push(best)
  return { y: best.worldBox.max.y, minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ, maxZ: rect.maxZ }
}

// ---------------------------------------------------------------------------
// The session's ground authority (see ground.ts)
// ---------------------------------------------------------------------------

/**
 * Ground height at a world XZ on a SCULPTED site: the host core's analytic
 * terrain field when its version exports one (a bilinear sample of the same
 * heightfield the editor renders — cheap, exact, and defined everywhere
 * because the host clamps out-of-range XZ to the edge height), else a
 * downward BVH raycast of the 'site' colliders. Returns null when the scene
 * has no site terrain, or when the BVH fallback finds no site under the XZ
 * (off the lot). Deliberately the ONE place the two existing probes are
 * ranked, so nothing downstream has to know which host it is running on.
 */
export function terrainSurfaceYAt(
  world: Pick<GameWorld, 'colliders' | 'site'>,
  x: number,
  z: number,
): number | null {
  const analytic = world.site?.surfaceHeightAt
  if (analytic) {
    const y = analytic(x, z)
    if (Number.isFinite(y)) return y
  }
  return siteGroundYAt(world, x, z)
}

/** BVH-fallback cache cell (m). The terrain is static and indestructible for
 * the whole session — unlike probe-memo.ts's 400 ms TTL, entries never go
 * stale, so one raycast per cell serves every bot step, debris chunk and
 * crater for the rest of the round. */
const GROUND_CACHE_CELL = 0.25
/** Cache cap — a 0.25 m grid over a 100 × 100 m lot is 160k cells, far more
 * than a session actually touches; past this the map is dropped wholesale
 * (cheaper than LRU bookkeeping and the refill is one raycast per cell). */
const GROUND_CACHE_MAX = 40000
/** How far below the terrain's lowest point the lot's hard floor sits, so the
 * backstop plane never fights the terrain BVH holding a body up. */
const LOT_FLOOR_MARGIN = 0.5

/**
 * Point ground.ts at this session's terrain, so every downstream system
 * (collision backstop, bot settle, debris/dust rest, craters, dropped items)
 * reads ONE height. Returns whether sculpted terrain was found.
 *
 * A scene without site terrain installs NOTHING: `groundSurfaceY` keeps
 * answering the flat lot plane and `lotFloorY()` stays 0, so every flat and
 * void scene behaves exactly as it did before the ground authority existed.
 *
 * The lot's hard floor comes from the site colliders' own AABBs (their
 * skirt reaches below the lowest terrain vertex) minus a margin — measured,
 * not guessed, and clamped to ≤ 0 by setLotFloorY so a site that sits
 * entirely on high ground can never raise the floor into the scene.
 */
export function installGroundProbes(
  world: Pick<GameWorld, 'colliders' | 'site'>,
  lotEdge?: LotEdge | null,
): boolean {
  if (!world.site?.hasTerrain) {
    resetGround()
    return false
  }

  const analytic = world.site.surfaceHeightAt
  let probe: GroundSurfaceProbe
  if (analytic) {
    probe = (x, z) => {
      // Past the terrain field the apron is the ground, and the host's field
      // must not be asked: surfaceHeightAt CLAMPS to its border height out of
      // range, so a sculpted lot edge would report its own height metres above
      // (or below) the flat plate bodies actually rest on.
      if (
        lotEdge &&
        (x < lotEdge.minX || x > lotEdge.maxX || z < lotEdge.minZ || z > lotEdge.maxZ)
      ) {
        return lotEdge.y
      }
      const y = analytic(x, z)
      return Number.isFinite(y) ? y : (lotEdge?.y ?? FLAT_LOT_Y)
    }
  } else {
    // BVH fallback: quantize and memoize, one raycast per 0.25 m cell.
    const cache = new Map<number, number>()
    probe = (x, z) => {
      const cx = Math.round(x / GROUND_CACHE_CELL)
      const cz = Math.round(z / GROUND_CACHE_CELL)
      const key = (cx + 32768) * 65536 + (cz + 32768)
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      const y = siteGroundYAt(world, cx * GROUND_CACHE_CELL, cz * GROUND_CACHE_CELL)
      // With an apron adopted the probe answers everywhere the plate reaches
      // (400 m+), so this is the beyond-the-horizon case: the apron's own
      // height, else the flat plane as the documented last resort.
      const value = y === null ? (lotEdge?.y ?? FLAT_LOT_Y) : y
      if (cache.size >= GROUND_CACHE_MAX) cache.clear()
      cache.set(key, value)
      return value
    }
  }

  let floor = Number.POSITIVE_INFINITY
  for (const collider of world.colliders) {
    if (collider.nodeType !== 'site' || collider.disabled) continue
    if (collider.worldBox.min.y < floor) floor = collider.worldBox.min.y
  }

  setGroundSurfaceProbe(probe)
  setLotFloorY(Number.isFinite(floor) ? floor - LOT_FLOOR_MARGIN : FLAT_LOT_Y)
  return true
}

// ---------------------------------------------------------------------------
// Host-scene vegetation trees (combat replacement — trees-destruct.tsx)
// ---------------------------------------------------------------------------

/** Exact registry kinds that are host vegetation trees. */
export const TREE_KINDS = ['tree', 'vegetation']

/** Kind SUFFIXES treated as host trees in addition to the exact list —
 * plugin kinds namespace as `<plugin>:<kind>` (the community vegetation
 * plugin registers `trees:tree`), so any registered `*:tree` /
 * `*:vegetation` is a tree by construction. Exported so QA can assert the
 * predicate. Grass/flower kinds (`trees:grass`, `trees:flower`) are ground
 * flora, NOT trees — they stay untouched. */
export const TREE_KIND_SUFFIXES = [':tree', ':vegetation']

/** The node-detection predicate: is this registry kind a host tree?
 * Single source of truth for collectHostTrees — QA asserting this asserts
 * the collection's match set. */
export function isTreeKind(kind: string): boolean {
  if (!kind) return false
  if (TREE_KINDS.includes(kind)) return true
  for (const suffix of TREE_KIND_SUFFIXES) if (kind.endsWith(suffix)) return true
  return false
}

/** Fallback overall height (m) when a tree node carries no numeric height. */
const DEFAULT_HOST_TREE_HEIGHT = 6

const _treePos = new Vector3()

/**
 * Every registered host tree node, world transform resolved from the
 * REGISTERED object (instanced plant plugins keep the per-node registered
 * proxy at the node's transform, floor lift included — the store position
 * is level-local). Hidden-branch trees are captured with `hidden: true`
 * (see HostTreeNode). `nodes` is the scene store's node record —
 * collectWorld passes its own snapshot; tests pass a hand-built record.
 */
export function collectHostTrees(nodes: Record<string, Record<string, unknown>>): HostTreeNode[] {
  const hostTrees: HostTreeNode[] = []
  for (const kind of Object.keys(sceneRegistry.byType)) {
    if (!isTreeKind(kind)) continue
    const ids = sceneRegistry.byType[kind]
    if (!ids) continue
    for (const id of ids) {
      const root = sceneRegistry.nodes.get(id)
      const node = nodes[id]
      if (!root || !node) continue
      root.updateWorldMatrix(true, false)
      _treePos.setFromMatrixPosition(root.matrixWorld)
      const rotation = node.rotation
      const yaw = Array.isArray(rotation) && typeof rotation[1] === 'number' ? rotation[1] : 0
      const height =
        typeof node.height === 'number' && Number.isFinite(node.height) && node.height > 0
          ? node.height
          : DEFAULT_HOST_TREE_HEIGHT
      hostTrees.push({
        nodeId: id,
        root,
        x: _treePos.x,
        y: _treePos.y,
        z: _treePos.z,
        yaw,
        height,
        hidden: onHiddenBranch(root),
      })
    }
  }
  return hostTrees
}

/** XZ tolerance (m) matching a forest instance to a captured tree. Instance
 * matrices and the registered proxy share the exact same source transform,
 * so this only absorbs float folding (parent level matrix multiply). */
const TREE_MATCH_EPS_XZ = 0.075
/** Y tolerance (m) — instance Y and proxy Y both come from the host's floor
 * lift but through two code paths; keep it loose (a tree is meters tall). */
const TREE_MATCH_EPS_Y = 1.5

const _forestMatrix = new Matrix4()

/**
 * Is this object a collective forest InstancedMesh for the captured host
 * trees? Instanced plant plugins batch every tree of a geometry variant
 * into one InstancedMesh AT THE SCENE ROOT (outside any registered root,
 * no marker name/userData), so the only reliable signature is positional:
 * every live instance translation must coincide with a captured tree's
 * world position (hidden ones included — see HostTreeNode.hidden), and the
 * instance count can't exceed the tree count. Zero-count meshes never
 * match. Exported so QA can assert the predicate.
 */
export function isForestInstancedMesh(
  object: Object3D,
  hostTrees: readonly HostTreeNode[],
): boolean {
  const mesh = object as InstancedMesh
  if ((mesh as { isInstancedMesh?: boolean }).isInstancedMesh !== true) return false
  const count = mesh.count
  if (count === 0 || count > hostTrees.length) return false
  for (let i = 0; i < count; i++) {
    mesh.getMatrixAt(i, _forestMatrix)
    const e = _forestMatrix.elements
    let matched = false
    for (const tree of hostTrees) {
      if (
        Math.abs(e[12]! - tree.x) <= TREE_MATCH_EPS_XZ &&
        Math.abs(e[14]! - tree.z) <= TREE_MATCH_EPS_XZ &&
        Math.abs(e[13]! - tree.y) <= TREE_MATCH_EPS_Y
      ) {
        matched = true
        break
      }
    }
    if (!matched) return false
  }
  return true
}

/**
 * The collective forest InstancedMeshes rendering the captured host trees —
 * the meshes the session must hide (through the restore ledger ONLY)
 * alongside the per-node registered roots. Skips `__boots` subtrees
 * wholesale: the combat grove is itself an InstancedMesh standing at the
 * same transforms, and matching it would hide the replacement. Pure and
 * read-only — never mutates the scene.
 */
export function collectHostForestMeshes(
  sceneRoot: Object3D,
  hostTrees: readonly HostTreeNode[],
): Object3D[] {
  const found: Object3D[] = []
  if (hostTrees.length === 0) return found
  const walk = (object: Object3D): void => {
    if ((object.userData as { __boots?: boolean }).__boots) return
    if (isForestInstancedMesh(object, hostTrees)) {
      found.push(object)
      return
    }
    for (const child of object.children) walk(child)
  }
  walk(sceneRoot)
  return found
}

// ---------------------------------------------------------------------------
// Grid anchor — the build lattice adopts the building's frame
// ---------------------------------------------------------------------------

/** Histogram bins over the folded yaw domain [−45°, 45°) — 1° per bin. */
const ANCHOR_BINS = 90
/** Snap to exact identity when the dominant yaw sits within this of a
 * cardinal direction… */
const ANCHOR_YAW_EPS = (0.5 * Math.PI) / 180
/** …and the anchor point sits within this of a CELL multiple on both axes —
 * an already-aligned building keeps the legacy absolute lattice bit-exact
 * (saves, QA scripts and the identity-fallback tests never move). */
const ANCHOR_OFFSET_EPS = 0.02
/** Walls shorter than this are stubs — no vote, never the anchor point
 * (same degeneracy floor the stud/anatomy builders use). */
const ANCHOR_MIN_WALL = 0.3

const HALF_PI = Math.PI / 2

/** Fold a wall yaw MOD 90° into [−45°, 45°): perpendicular walls vote
 * together (the lattice can't tell a wall along X from one along Z), and
 * the anchor is always the MINIMAL rotation off cardinal. */
function foldYaw(yaw: number): number {
  return ((((yaw + HALF_PI / 2) % HALF_PI) + HALF_PI) % HALF_PI) - HALF_PI / 2
}

/** Y rotation of an object's world matrix, read off its world basis X
 * (makeRotationY: basisX = (cos, 0, −sin)). Wall roots carry no local
 * rotation of their own — the host renders walls as level-origin groups
 * spanning start/end (the wall schema has no position/rotation field) — so
 * this is the building/level rotation the node coordinates compose with. */
function matrixWorldYaw(root: Object3D): number {
  const e = root.matrixWorld.elements
  return Math.atan2(-e[2]!, e[0]!)
}

const _anchorStart = new Vector3()

/**
 * Derive the session grid anchor from the collected walls: the rigid XZ
 * transform { x, z, yaw } that aligns the build lattice (grid.ts) to the
 * building's dominant frame.
 * - yaw: length-weighted histogram over wall world yaws folded MOD 90°
 *   (perpendicular walls vote together); the winning bin is refined by the
 *   length-weighted mean of its own cluster so parallel long walls beat a
 *   short odd one without the 1° bin quantizing the result.
 * - position: the LONGEST wall's world START point — that wall's start
 *   lands exactly on a lattice corner, so grid placements run flush along
 *   the building's strongest edge.
 * - wall world yaw composes atan2 over (end−start) — node start/end are
 *   LEVEL-local — with the wall root's matrixWorld yaw (buildings rotate
 *   wholesale at the level); the start point goes through the root's full
 *   matrixWorld for the same reason.
 * - identity snap: yaw ≈ cardinal AND offset ≈ a CELL multiple → exact
 *   { 0, 0, 0 }, the do-nothing anchor.
 * No walls (or only stubs) → identity. Pure math over the walls iterable —
 * exported for the anchor-derivation tests.
 */
export function deriveGridAnchor(
  walls: Iterable<{ node: WallNodeLike; root: Object3D }>,
): GridAnchor {
  const votes: Array<{ folded: number; length: number }> = []
  let longest = 0
  let anchorX = 0
  let anchorZ = 0
  for (const wall of walls) {
    const { start, end } = wall.node
    const dx = end[0] - start[0]
    const dz = end[1] - start[1]
    const length = Math.hypot(dx, dz)
    if (length < ANCHOR_MIN_WALL) continue
    // Object-yaw convention (local +X → (cos yaw, −sin yaw), the codebase's
    // wall/piece yaw): level-local atan2 composed with the root rotation.
    const folded = foldYaw(Math.atan2(-dz, dx) + matrixWorldYaw(wall.root))
    votes.push({ folded, length })
    if (length > longest) {
      longest = length
      _anchorStart.set(start[0], 0, start[1]).applyMatrix4(wall.root.matrixWorld)
      anchorX = _anchorStart.x
      anchorZ = _anchorStart.z
    }
  }
  if (votes.length === 0) return { x: 0, z: 0, yaw: 0 }

  const bins = new Float64Array(ANCHOR_BINS)
  const binWidth = HALF_PI / ANCHOR_BINS
  for (const vote of votes) {
    const bin = Math.min(ANCHOR_BINS - 1, Math.floor((vote.folded + HALF_PI / 2) / binWidth))
    bins[bin]! += vote.length
  }
  let winner = 0
  for (let b = 1; b < ANCHOR_BINS; b++) {
    if (bins[b]! > bins[winner]!) winner = b
  }

  // Refine within the winning cluster: length-weighted mean of the votes
  // within 1.5 bins of the winner's center, measured CIRCULARLY on the 90°
  // domain (0° and 89° are one degree apart) so the fold seam never splits
  // a cluster. Votes from losing clusters don't skew the mean.
  const center = -HALF_PI / 2 + (winner + 0.5) * binWidth
  let sum = 0
  let weight = 0
  for (const vote of votes) {
    let d = ((((vote.folded - center) % HALF_PI) + HALF_PI) % HALF_PI)
    if (d > HALF_PI / 2) d -= HALF_PI
    if (Math.abs(d) > binWidth * 1.5) continue
    sum += d * vote.length
    weight += vote.length
  }
  const yaw = foldYaw(weight > 0 ? center + sum / weight : center)

  if (Math.abs(yaw) <= ANCHOR_YAW_EPS) {
    const offX = Math.abs(anchorX - Math.round(anchorX / CELL) * CELL)
    const offZ = Math.abs(anchorZ - Math.round(anchorZ / CELL) * CELL)
    if (offX <= ANCHOR_OFFSET_EPS && offZ <= ANCHOR_OFFSET_EPS) return { x: 0, z: 0, yaw: 0 }
  }
  return { x: anchorX, z: anchorZ, yaw }
}

/**
 * Snap every level group to its true stacked Y + visible before the world
 * snapshot. The host LevelSystem LERPS group Y toward baseY every frame —
 * a snapshot taken mid-animation (e.g. right after enterGame forced
 * levelMode from 'exploded' to 'stacked') would bake collider inverse
 * matrices at the wrong elevation, leaving invisible walls where storeys
 * used to hover. The host's own `snapLevelsToTruePositions` does the exact
 * elevation math; its restore closure is deliberately DISCARDED — the
 * LevelSystem lerp reconverges from the snapped position (a no-op under the
 * 'stacked' mode the session forces), so there is nothing to undo.
 *
 * try/catch: never let a host-version gap in the util take down Jump-in —
 * a missed snap only matters when levels were mid-flight.
 */
export function snapLevelsForSnapshot(): void {
  try {
    snapLevelsToTruePositions()
  } catch {
    // Host without the util (or an empty registry): snapshot proceeds with
    // whatever Y the groups currently hold.
  }
}

// ---------------------------------------------------------------------------
// Spawn ground settle — the player must START ON the surface, never in it
// ---------------------------------------------------------------------------

/** Session-fixture colliders (the spawn depot cluster guntable.tsx registers
 * under '__boots-depot', plus any future '__boots*' fixture) are placed
 * RELATIVE to the spawn — letting them answer a spawn ground probe would be
 * circular, and the depot container sits only ~3 m behind the spawn point:
 * a probe must never stand the player ON it. They are also mount-order racy
 * (guntable pushes its entries into world.colliders around the same time
 * the player settles), so skipping them keeps the settle deterministic. */
const SESSION_FIXTURE_PREFIX = '__boots'

/** Feet rest this far above a probed surface so the capsule never starts
 * its first frame a hair interpenetrated; the first ground resolve snaps
 * it flush. */
export const SPAWN_SETTLE_EPS = 0.02

/** The unstick pass gives up after lifting this far — a spawn buried deeper
 * than 3 m is a data pathology better left to the lot plane + fall guard
 * than silently teleported to a rooftop. */
export const SPAWN_UNSTICK_MAX_LIFT = 3
/** Unstick lift granularity (m). */
const SPAWN_UNSTICK_STEP = 0.25
/** Overlap slack for the unstick test: a graze shallower than this is
 * exactly what collideCapsule's push-out resolves on frame one — lifting
 * for it would pop the player over fences the capsule merely touches. */
const SPAWN_UNSTICK_SLACK = 0.05

function spawnProbeEligible(collider: ColliderEntry): boolean {
  return !collider.disabled && !collider.nodeId.startsWith(SESSION_FIXTURE_PREFIX)
}

const _spawnRay = new Ray()
const _spawnNormal = new Vector3()
const _spawnHitPoint = new Vector3()

/**
 * Topmost WALKABLE surface at (x, z) over the collider set: a downward BVH
 * raycast per XZ-covering collider, cast from above the HIGHEST candidate
 * top — starting above every top means a probe point INSIDE a volume still
 * resolves to that volume's top face ("lift out"), the one shape a capsule
 * cannot save itself from (triangles deeper than its radius are invisible
 * to push-out, so a buried start used to stay buried). Faces steeper than
 * the walkable limit are not spawn ground (a 60° roof plane must not catch
 * the probe). Returns null when no eligible collider covers the XZ at all —
 * callers fall back to the lot's terrain plane. Pure over its inputs;
 * exported for the spawn-settle tests.
 */
export function probeSpawnSurfaceY(
  colliders: readonly ColliderEntry[],
  x: number,
  z: number,
): number | null {
  let ceiling = Number.NEGATIVE_INFINITY
  for (const collider of colliders) {
    if (!spawnProbeEligible(collider)) continue
    const box = collider.worldBox
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
    if (box.max.y > ceiling) ceiling = box.max.y
  }
  if (!Number.isFinite(ceiling)) return null

  const fromY = ceiling + 1
  let best: number | null = null
  for (const collider of colliders) {
    if (!spawnProbeEligible(collider)) continue
    const box = collider.worldBox
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
    // Box top at or below the current best can't improve on it.
    if (best !== null && box.max.y <= best) continue
    _spawnRay.origin.set(x, fromY, z)
    _spawnRay.direction.set(0, -1, 0)
    _spawnRay.applyMatrix4(collider.inverse)
    const hit = collider.bvh.raycastFirst(_spawnRay, 2)
    if (!hit?.face) continue
    // Walkability in WORLD space; |n.y| because a double-sided first hit
    // from above may report the back-face normal.
    _spawnNormal.copy(hit.face.normal).transformDirection(collider.mesh.matrixWorld)
    if (Math.abs(_spawnNormal.y) < WALKABLE_NORMAL_Y) continue
    const worldY = _spawnHitPoint.copy(hit.point).applyMatrix4(collider.mesh.matrixWorld).y
    if (best === null || worldY > best) best = worldY
  }
  return best
}

/**
 * The Y the spawn's FEET start at for a chosen XZ: the topmost walkable
 * collider surface there (+ SPAWN_SETTLE_EPS), else the ground under it.
 * This replaces the old lowest-LEVEL-elevation guess, which knew nothing
 * about what actually stands at the spawn XZ: a raised site slab / terrace
 * under the ring spawn left the player waist-deep in it on large real
 * projects ("spawns half into the ground"), and an elevated building floated
 * the spawn in mid-air over flat ground.
 *
 * The lower bound is the LOT FLOOR, not zero. It used to be `Math.max(0, …)`
 * because collision.ts's infinite plane at y = 0 would have fought anything
 * lower — so a spawn XZ over the owner's −5.1 m excavation started five
 * metres in the air. Both halves of that pact are gone: the floor is now the
 * measured underside of the site (0 without terrain, so flat scenes are
 * unchanged) and the terrain BVH does the real holding-up.
 */
export function spawnGroundY(colliders: readonly ColliderEntry[], x: number, z: number): number {
  const surface = probeSpawnSurfaceY(colliders, x, z)
  if (surface === null) return groundSurfaceY(x, z)
  return Math.max(lotFloorY(), surface + SPAWN_SETTLE_EPS)
}

const _usBox = new Box3()
const _usSegment = new Line3()
const _usLocalSegment = new Line3()
const _usLocalBox = new Box3()
const _usTriPoint = new Vector3()
const _usCapsulePoint = new Vector3()

/**
 * Does a capsule standing at feet (x, y, z) intersect any eligible collider
 * surface? The same segment-vs-triangle proximity test collideCapsule
 * resolves with, read-only. Shares the deep-burial blind spot (a segment
 * farther than `radius` from every surface triangle reads free) — which is
 * why the spawn settle probes the surface FIRST and only unsticks after.
 * Exported for the spawn-settle tests.
 */
export function capsuleOverlapsColliders(
  colliders: readonly ColliderEntry[],
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
): boolean {
  _usBox.min.set(x - radius, y, z - radius)
  _usBox.max.set(x + radius, y + height, z + radius)
  for (const collider of colliders) {
    if (!spawnProbeEligible(collider)) continue
    if (!collider.worldBox.intersectsBox(_usBox)) continue
    _usSegment.start.set(x, y + radius, z)
    _usSegment.end.set(x, y + height - radius, z)
    _usLocalSegment.copy(_usSegment).applyMatrix4(collider.inverse)
    _usLocalBox.makeEmpty()
    _usLocalBox.expandByPoint(_usLocalSegment.start)
    _usLocalBox.expandByPoint(_usLocalSegment.end)
    _usLocalBox.min.addScalar(-radius)
    _usLocalBox.max.addScalar(radius)
    let overlapped = false
    collider.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_usLocalBox),
      intersectsTriangle: (tri) => {
        if (tri.closestPointToSegment(_usLocalSegment, _usTriPoint, _usCapsulePoint) < radius) {
          overlapped = true
          return true // one contact answers the question — abort traversal
        }
        return false
      },
    })
    if (overlapped) return true
  }
  return false
}

/**
 * UNSTICK: a capsule that STARTS intersecting a collider is the one state
 * the mover can't fix (push-out needs a surface within its radius; the slide
 * then wedges on whatever it's embedded in) — lift in SPAWN_UNSTICK_STEP
 * slices, cap SPAWN_UNSTICK_MAX_LIFT, until free. The test radius is shrunk
 * by SPAWN_UNSTICK_SLACK so shallow grazes stay with the regular push-out.
 * Returns the lift applied; 0 means already free OR nothing free within the
 * cap (feet left untouched then — the lot plane and push-out do what they
 * can). Exported for the spawn-settle tests.
 */
export function unstickSpawn(
  colliders: readonly ColliderEntry[],
  feet: Vector3,
  capsule: { radius: number; height: number },
): number {
  const radius = Math.max(0.05, capsule.radius - SPAWN_UNSTICK_SLACK)
  if (!capsuleOverlapsColliders(colliders, feet.x, feet.y, feet.z, radius, capsule.height)) {
    return 0
  }
  for (
    let lift = SPAWN_UNSTICK_STEP;
    lift <= SPAWN_UNSTICK_MAX_LIFT + 1e-9;
    lift += SPAWN_UNSTICK_STEP
  ) {
    if (
      !capsuleOverlapsColliders(colliders, feet.x, feet.y + lift, feet.z, radius, capsule.height)
    ) {
      feet.y += lift
      return lift
    }
  }
  return 0
}

/**
 * Session-start feet settle (player.tsx mount + its fall-off-world respawn):
 * stand exactly on the topmost walkable surface at the spawn XZ (the LIVE
 * collider set — it can differ from the snapshot-time probe), then lift free
 * if the capsule still interpenetrates something the point probe couldn't
 * see (an overhang lip, a beam crossing the capsule body off-center).
 */
export function settleSpawnFeet(
  colliders: readonly ColliderEntry[],
  feet: Vector3,
  capsule: { radius: number; height: number },
): void {
  feet.y = spawnGroundY(colliders, feet.x, feet.z)
  unstickSpawn(colliders, feet, capsule)
}

const _levelWorldPos = new Vector3()

// ---------------------------------------------------------------------------
// Storey ladder — the grid's storeys follow the building's real levels
// ---------------------------------------------------------------------------

export type StackedLevel = { id: string; y: number }

/**
 * Every registered level with its TRUE STACKED base elevation, ascending.
 * The read goes through the host's own snap util and RESTORES afterwards —
 * safe outside a session too (Keep runs back in the editor, which may sit
 * in exploded/solo where group Ys are nowhere near their stacked bases;
 * inside collectWorld the groups are already snapped, so the round-trip is
 * a no-op). A host without the util degrades to the current group Ys.
 */
export function collectStackedLevels(): StackedLevel[] {
  let restore: (() => void) | undefined
  try {
    restore = snapLevelsToTruePositions()
  } catch {
    restore = undefined
  }
  const levels: StackedLevel[] = []
  const levelIds = sceneRegistry.byType.level
  if (levelIds) {
    for (const id of levelIds) {
      const obj = sceneRegistry.nodes.get(id)
      if (!obj) continue
      obj.updateWorldMatrix(true, false)
      levels.push({ id, y: _levelWorldPos.setFromMatrixPosition(obj.matrixWorld).y })
    }
  }
  try {
    restore?.()
  } catch {
    // A restore that throws leaves the groups snapped — the LevelSystem
    // lerp reconverges, same posture as snapLevelsForSnapshot.
  }
  levels.sort((a, b) => a.y - b.y)
  return levels
}

/** Rungs extended above the top level's ceiling boundary (pure STOREY
 * multiples) — sky forts keep building past the roof line. */
const LADDER_SKY_RUNGS = 3
/** Level bases closer than this merge into one rung: a "storey" that thin
 * is a data artifact, not a floor a piece could stand under. */
const MIN_STOREY_SPAN = 1

/** The TOP level's own height — the tallest wall/ceiling child height in
 * the scene store (the same children the host's level-height util reads;
 * that util is not exported from the viewer package root, so the scan is
 * replicated here). No measurable children → the level node's OWN numeric
 * `height` (host-default walls carry no per-node height, but the level
 * does — 2.5 on a fresh scene). Nothing at all → STOREY. */
function levelTopSpan(levelId: string, nodes: Record<string, Record<string, unknown>>): number {
  const level = nodes[levelId]
  const children = Array.isArray(level?.children) ? (level.children as string[]) : []
  let span = 0
  for (const childId of children) {
    const child = nodes[childId]
    if (!child) continue
    if (child.type !== 'wall' && child.type !== 'ceiling') continue
    const height = child.height
    if (typeof height === 'number' && Number.isFinite(height) && height > span) span = height
  }
  if (span > 0) return span
  const own = level?.height
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own
  return STOREY
}

/**
 * Derive the session storey ladder from the stacked levels: each level base
 * is a boundary (sub-MIN_STOREY_SPAN rungs merge), the top level closes at
 * its own measured height, then LADDER_SKY_RUNGS pure-STOREY rungs extend
 * above so building keeps working past the roof. No levels → null (the
 * grid keeps its uniform 2.8 fallback). The terrain-storey prepend for
 * elevated buildings lives in grid.setStoreyLadder — this is the raw
 * building read. Exported for the derivation tests.
 */
export function deriveStoreyLadder(
  levels: readonly StackedLevel[],
  nodes: Record<string, Record<string, unknown>>,
): number[] | null {
  if (levels.length === 0) return null
  const ys: number[] = []
  let topId = levels[0]!.id
  for (const level of levels) {
    if (ys.length > 0 && level.y - ys[ys.length - 1]! < MIN_STOREY_SPAN) continue
    ys.push(level.y)
    topId = level.id
  }
  ys.push(ys[ys.length - 1]! + levelTopSpan(topId, nodes))
  for (let rung = 0; rung < LADDER_SKY_RUNGS; rung++) ys.push(ys[ys.length - 1]! + STOREY)
  return ys
}

export function collectWorld(): GameWorld {
  // Whole-building presence: bake the snapshot at true stacked elevations,
  // never mid-lerp (see snapLevelsForSnapshot).
  snapLevelsForSnapshot()

  const nodes = useScene.getState().nodes as Record<
    string,
    { type?: string; visible?: boolean } & Partial<WallNodeLike> & Record<string, unknown>
  >

  const colliders: ColliderEntry[] = []
  const walls = new Map<string, { node: WallNodeLike; root: Object3D; meshes: Mesh[] }>()
  const glass: GlassPane[] = []
  const doors: DoorEntry[] = []
  const operables: OperableEntry[] = []
  const buildingAabb = new Box3()
  const meshBounds = new Box3()

  // Registered roots of every collected solid node — the mesh-sweep fence
  // (see collectMeshes). A wall's sweep stops at its hosted door / window /
  // item roots; those subtrees are collected under their own nodeId instead.
  const solidRoots = collectSolidRoots()

  // The SITE sweep fences at EVERY registered root, not just the solid ones:
  // the SiteRenderer mounts its children (buildings → levels → …) inside the
  // registered site group, and a solid-only fence would sweep any level-side
  // presentation mesh (zone fills, grids) into the indestructible site lane.
  // Lazy — only built when a site is actually collected.
  let siteFence: Set<Object3D> | null = null

  // First visible site — snapshotted for GameWorld.site after the loop.
  let sitePick: { id: string; root: Object3D; node: Record<string, unknown> } | null = null

  for (const kind of SOLID_KINDS) {
    const ids = sceneRegistry.byType[kind]
    if (!ids) continue
    for (const id of ids) {
      const root = sceneRegistry.nodes.get(id)
      const node = nodes[id]
      if (!root || !node) continue
      // Skip nodes on hidden branches (other levels toggled off, etc.).
      let hidden = false
      let walker: Object3D | null = root
      while (walker) {
        if (!walker.visible) {
          hidden = true
          break
        }
        walker = walker.parent
      }
      if (hidden) continue

      root.updateWorldMatrix(true, true)
      if (kind === 'site' && !siteFence) {
        siteFence = new Set<Object3D>(sceneRegistry.nodes.values())
      }
      const meshes = collectMeshes(root, kind === 'site' ? siteFence! : solidRoots)
      if (meshes.length === 0) continue
      if (kind === 'site' && !sitePick) sitePick = { id, root, node }

      // Glass split: window panes AND glass-like sub-meshes of item-family
      // nodes (shower doors, cabinet fronts, counter splash panels…) join
      // the glass shatter lane — they never become colliders and never
      // voxelize. Runs AFTER the hosted-children fence above, so a wall
      // never sees a hosted item's pane and an item never donates glass to
      // its host.
      const solidMeshes: Mesh[] = []
      const glassEligible = kind === 'window' || ITEM_FAMILY_KINDS.has(kind)
      for (const mesh of meshes) {
        if (glassEligible && isGlassLikeMesh(mesh)) {
          glass.push({ mesh, root, nodeId: id })
          continue
        }
        solidMeshes.push(mesh)
      }

      const firstColliderIndex = colliders.length
      for (const mesh of solidMeshes) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        meshBounds.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
        // REQUIRED site guard: the lot surface spans the whole parcel —
        // merging it into buildingAabb would inflate the spawn ring, the
        // nature hole, the sky center and crater rejection to the entire lot.
        if (kind !== 'site') buildingAabb.union(meshBounds)
        // BVH is LAZY: building hundreds of trees synchronously at snapshot
        // time blocks the main thread for seconds on a real house (the
        // "frozen frame on Jump in" class of bug). bvhFor caches per
        // geometry, so the getter costs one WeakMap hit after first touch.
        colliders.push({
          mesh,
          get bvh() {
            return bvhFor(this.mesh)
          },
          inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
          worldBox: meshBounds.clone(),
          root,
          nodeId: id,
          nodeType: kind,
        })
      }

      if (kind === 'door' && colliders.length > firstColliderIndex) {
        const colliderIndices: number[] = []
        for (let i = firstColliderIndex; i < colliders.length; i++) colliderIndices.push(i)
        doors.push({ nodeId: id, root, colliderIndices, node: { ...node } })
      }

      // Non-door operables the E-interact system can pose (window sashes,
      // cabinet fronts). Snapshot mirrors DoorEntry; a node with no solid
      // mesh (nothing to aim at) contributes no entry.
      if (
        (kind === 'window' || kind === 'cabinet' || kind === 'cabinet-module') &&
        colliders.length > firstColliderIndex
      ) {
        const colliderIndices: number[] = []
        for (let i = firstColliderIndex; i < colliders.length; i++) colliderIndices.push(i)
        operables.push({ nodeId: id, kind, root, colliderIndices, node: { ...node } })
      }

      if (kind === 'wall' && Array.isArray(node.start) && Array.isArray(node.end)) {
        walls.set(id, {
          node: {
            id,
            start: node.start as [number, number],
            end: node.end as [number, number],
            height: typeof node.height === 'number' ? node.height : undefined,
            thickness: typeof node.thickness === 'number' ? node.thickness : undefined,
          },
          root,
          meshes: solidMeshes,
        })
      }
    }
  }

  const overlayRoots = collectOverlayRoots()
  // The lot snapshot: nature reads existence (ground-disc suppression),
  // polygon (scatter clamp) and the analytic height (drape) off this —
  // never off the registry at render time.
  const site = buildSiteSnapshot(sitePick)
  // The lot edge, before the ground authority reads the collider set: the
  // host's horizon plate becomes solid ground past the parcel, so walking off
  // a sculpted lot steps onto the grass you can see instead of sinking metres
  // onto the collision backstop. Refuses itself on flat sites and does nothing
  // at all on a void lot (no site node → no plate → horizon.ts as before).
  const lotEdge = adoptLotPlate(colliders, site, siteFence ?? undefined)
  // …and the ground authority adopts it FIRST: the hard-surface mask and the
  // spawn settle below both ask ground.ts for the dirt under a point, and a
  // stale (or absent) probe would put a driveway's height ceiling and the
  // lot floor back on the y = 0 plane. Everything that used to assume y = 0
  // reads from here on (game-root resets it on teardown).
  installGroundProbes({ colliders, site }, lotEdge)
  const roadFootprints = collectRoadFootprints(colliders)
  const hostTrees = collectHostTrees(nodes)
  // The build lattice adopts the building's frame — identity when nothing
  // dominates (empty lot) or the building already sits on the legacy grid.
  const gridAnchor = deriveGridAnchor(walls.values())
  // …and its storeys adopt the building's REAL level elevations (the level
  // groups are already snapped to their stacked bases — see above). No
  // registered levels → undefined, the grid keeps uniform 2.8 storeys.
  const storeyLadder = deriveStoreyLadder(collectStackedLevels(), nodes) ?? undefined

  // Spawn: outside the building along +X of its center, eye toward it.
  // XZ first; Y then SETTLES onto whatever actually stands there —
  // spawnGroundY probes the collected colliders straight down at the spawn
  // XZ (raised lot slabs, terraces, foundation plinths that reach the ring)
  // and falls back to the ground under it. The old Y guess (the
  // lowest LEVEL's elevation) knew nothing about the ground at the ring:
  // a raised site slab under the spawn buried the player waist-deep on big
  // real projects, and an elevated building floated the spawn mid-air.
  const spawn = new Vector3(6, 0, 6)
  let spawnYaw = Math.PI * 0.75
  if (!buildingAabb.isEmpty()) {
    const center = buildingAabb.getCenter(new Vector3())
    const size = buildingAabb.getSize(new Vector3())
    const dist = Math.max(size.x, size.z) / 2 + 5
    spawn.set(center.x + dist, 0, center.z + dist * 0.4)
    spawnYaw = Math.atan2(spawn.x - center.x, spawn.z - center.z) + Math.PI
    // Camera yaw convention: 0 looks down -Z; face the building center.
    const dx = center.x - spawn.x
    const dz = center.z - spawn.z
    spawnYaw = Math.atan2(-dx, -dz)
  }
  spawn.y = spawnGroundY(colliders, spawn.x, spawn.z)

  // Background BVH fill — AFTER the spawn probe above so the 1–2 colliders
  // the settle touched are already cached, and with the spawn known so the
  // queue builds nearest-first. No-op wherever workers can't run.
  primeColliderBvhs(colliders, spawn)

  // Telemetry only (the game is whole-building; nothing gameplay-side keys
  // on this). The editor's active level lives on the VIEWER's selection —
  // the old `useScene.selectedLevelId` read pointed at a field that has
  // never existed and was always null.
  const levelId =
    (
      useViewer.getState() as unknown as {
        selection?: { levelId?: string | null }
      }
    ).selection?.levelId ?? null

  return {
    colliders,
    walls,
    glass,
    doors,
    operables,
    solidRoots,
    overlayRoots,
    roadFootprints,
    hostTrees,
    gridAnchor,
    storeyLadder,
    site,
    buildingAabb,
    spawn,
    spawnYaw,
    levelId,
  }
}
