import { sceneRegistry, useScene } from '@pascal-app/core'
import { snapLevelsToTruePositions, useViewer } from '@pascal-app/viewer'
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  type Object3D,
  Vector3,
} from 'three'
import { MeshBVH } from 'three-mesh-bvh'

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

export type GameWorld = {
  colliders: ColliderEntry[]
  /** wall nodeId → its colliders' indices + node data (for stud generation). */
  walls: Map<string, { node: WallNodeLike; root: Object3D; meshes: Mesh[] }>
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
]

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
 * BVH per geometry, hardened for the wild (prod crash 2026-08-25: a scene
 * mesh with interleaved GLB attributes made `new MeshBVH` read `.offset` of
 * undefined INSIDE the game's mount useMemo — the viewer's error boundary
 * then ate the whole canvas). Interleaved positions are de-interleaved into
 * a BVH-only copy; anything that still throws degrades to a never-hit BVH
 * instead of crashing the session.
 */
export function bvhFor(mesh: Mesh): MeshBVH {
  let bvh = bvhCache.get(mesh.geometry)
  if (!bvh) {
    try {
      let geometry = mesh.geometry
      const position = geometry.getAttribute('position')
      if ((position as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
        const flat = new Float32Array(position.count * 3)
        for (let i = 0; i < position.count; i++) {
          flat[i * 3] = position.getX(i)
          flat[i * 3 + 1] = position.getY(i)
          flat[i * 3 + 2] = position.getZ(i)
        }
        const copy = new BufferGeometry()
        copy.setAttribute('position', new BufferAttribute(flat, 3))
        if (geometry.index) copy.setIndex(geometry.index.clone())
        geometry = copy
      }
      bvh = new MeshBVH(geometry)
    } catch (error) {
      console.warn('[boots] BVH build failed — mesh will be non-solid', mesh.name, error)
      bvh = fallbackBvh()
    }
    bvhCache.set(mesh.geometry, bvh)
  }
  return bvh
}

function isGlassMesh(mesh: Mesh): boolean {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  if (!material) return false
  const m = material as { transparent?: boolean; opacity?: number; transmission?: number }
  return Boolean((m.transparent && (m.opacity ?? 1) < 0.95) || (m.transmission ?? 0) > 0.2)
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
/** …and starts at most this far above the ground plane. */
const PAD_MAX_BASE_Y = 0.6

/** Triangles whose lowest vertex sits above this are skipped — an elevated
 * deck is not ground the scatter plane (y = 0) could poke through. */
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
 * triangle. Elevated (min y > maxY) and XZ-degenerate triangles are dropped.
 */
export function meshFootprintTriangles(mesh: Mesh, maxY = FOOTPRINT_MAX_Y): Float32Array {
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
    if (Math.min(_fpA.y, _fpB.y, _fpC.y) > maxY) continue
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
    if (size.y > PAD_MAX_THICKNESS || entry.worldBox.min.y > PAD_MAX_BASE_Y) continue
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

/** Lowest storey ground: min world-Y over all registered level groups
 * (post-snap that IS each level's baseY), clamped to the terrain plane at 0
 * — spawn/respawn live on the terrain ring outside the building, so a
 * basement's negative baseY must not sink the spawn underground. */
function lowestLevelGroundY(): number {
  let lowest = Number.POSITIVE_INFINITY
  const levelIds = sceneRegistry.byType.level
  if (levelIds) {
    for (const id of levelIds) {
      const obj = sceneRegistry.nodes.get(id)
      if (!obj) continue
      obj.updateWorldMatrix(true, false)
      const y = _levelWorldPos.setFromMatrixPosition(obj.matrixWorld).y
      if (y < lowest) lowest = y
    }
  }
  return Number.isFinite(lowest) ? Math.max(0, lowest) : 0
}

const _levelWorldPos = new Vector3()

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
      const meshes = collectMeshes(root, solidRoots)
      if (meshes.length === 0) continue

      const solidMeshes: Mesh[] = []
      for (const mesh of meshes) {
        if (kind === 'window' && isGlassMesh(mesh)) {
          glass.push({ mesh, root, nodeId: id })
          continue
        }
        solidMeshes.push(mesh)
      }

      const firstColliderIndex = colliders.length
      for (const mesh of solidMeshes) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        meshBounds.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
        buildingAabb.union(meshBounds)
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
  const roadFootprints = collectRoadFootprints(colliders)
  const hostTrees = collectHostTrees(nodes)

  // Spawn: outside the building along +X of its center, eye toward it.
  // Y is the LOWEST level's ground (usually 0) — with the whole stacked
  // building collected, buildingAabb spans every storey, but the ring stays
  // on the ground the building rises from.
  const spawn = new Vector3(6, 0, 6)
  let spawnYaw = Math.PI * 0.75
  if (!buildingAabb.isEmpty()) {
    const center = buildingAabb.getCenter(new Vector3())
    const size = buildingAabb.getSize(new Vector3())
    const dist = Math.max(size.x, size.z) / 2 + 5
    spawn.set(center.x + dist, lowestLevelGroundY(), center.z + dist * 0.4)
    spawnYaw = Math.atan2(spawn.x - center.x, spawn.z - center.z) + Math.PI
    // Camera yaw convention: 0 looks down -Z; face the building center.
    const dx = center.x - spawn.x
    const dz = center.z - spawn.z
    spawnYaw = Math.atan2(-dx, -dz)
  }

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
    buildingAabb,
    spawn,
    spawnYaw,
    levelId,
  }
}
