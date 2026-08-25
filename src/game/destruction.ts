import { Box3, Color, Matrix4, type Mesh, Vector3 } from 'three'
import { create } from 'zustand'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { spawnDust, spawnHaze } from './dust'
import { hideForGame } from './session'
import {
  buildVoxelGrid,
  dropInteriorCells,
  findUnsupportedIslands,
  raycastVoxels,
  raycastYawObb,
  removeSphere,
  type VoxelGridData,
  type VoxelSource,
} from './voxel'
import { bvhFor, type GameWorld } from './world'

/**
 * Voxel destruction manager — "everything should be able to break apart".
 *
 * A target stays the host's pristine mesh until the first hit lands; then
 * the mesh is hidden (session ledger — the editor gets it back untouched)
 * and a voxel replica takes over rendering, collision, and bullet
 * interception.
 *
 * WALL ANATOMY: walls voxelize ANISOTROPICALLY — the thickness axis is
 * pinned to thickness/3 cells (≥ 3 layers even on a 0.10 m wall) while
 * length/height keep ~0.15 m cells — then interior layers are dropped
 * (`dropInteriorCells`), leaving TWO thin drywall skins with the stud
 * cavity between them, and the studs are first-class breakable members
 * with their own hp. DIAGONAL walls (no thin world axis) get the same
 * anatomy from a grid built in the wall's yaw-local frame (grid.yaw —
 * centers stay world-space); only degenerate segments fall back to the
 * plain isotropic volume.
 *
 * ── API (build against this) ──────────────────────────────────────────
 * State
 *   useDestruction            zustand store. `targets` (and its legacy
 *                             alias `walls` — the SAME Map instance) maps
 *                             nodeId → VoxelTarget. `version` bumps on any
 *                             change; re-read the map when it does.
 *   VoxelTarget               { nodeId, kind: 'wall' | 'volume', grid,
 *                             baseColor, studs: StudMember[],
 *                             removedQueue, revision }
 *   StudMember                { id, center, size, yaw, hp, broken } —
 *                             renderers should skip `broken` studs.
 * Voxelize / damage
 *   ensureVoxelTarget(world, nodeId)   voxelize ANY collider group (walls,
 *                             doors, slabs, roofs, items…). Walls get the
 *                             skins + studs anatomy; everything else is a
 *                             plain adaptive volume (≤ 1600 voxels).
 *                             `ensureVoxelWall` is a legacy alias.
 *   damageTarget(world, nodeId, point, radius, direction?)   carve a sphere
 *                             at a world point (voxelizes on first hit);
 *                             direction aims the tear dust plume. Returns
 *                             the number of voxels removed. `damageWall`
 *                             is a legacy alias.
 *   damageStud(world, nodeId, studId, damage, point)   chip a stud (wood
 *                             splinters); at hp ≤ 0 it breaks — two large
 *                             falling pieces + snap sfx. Returns true if
 *                             damage applied.
 * Queries
 *   raycastVoxelTargets(origin, direction, maxDist)   first live voxel of
 *                             any target along the ray → { nodeId,
 *                             distance, point } | null.
 *                             `raycastVoxelWalls` is a legacy alias.
 *   raycastStuds(origin, direction, maxDist)   analytic ray-vs-OBB over
 *                             all live studs → { nodeId, studId, distance,
 *                             point } | null. Shooting should test this
 *                             alongside voxels and keep the nearest.
 *   collideVoxelTargets(pos, vel, radius, height)   capsule push-out
 *                             against live voxels; returns grounded.
 *                             `collideVoxelWalls` is a legacy alias.
 * Lifecycle
 *   resetDestruction()        clear all targets + pending island timers
 *                             (session exit path).
 * ──────────────────────────────────────────────────────────────────────
 */

export type StudMember = {
  id: number
  center: [number, number, number]
  size: [number, number, number]
  yaw: number
  hp: number
  broken: boolean
}

/** Legacy alias — studs now carry id/hp/broken on top of the old shape. */
export type StudBox = StudMember

export type VoxelTarget = {
  nodeId: string
  /** 'wall' targets carry the skins + studs anatomy; 'volume' is plain. */
  kind: 'wall' | 'volume'
  grid: VoxelGridData
  baseColor: Color
  studs: StudMember[]
  /** Voxel indices removed since the renderer last drained the queue. */
  removedQueue: number[]
  /** Bumped on every change so the renderer knows to re-upload. */
  revision: number
}

/** Legacy alias — every voxelized target uses the same shape. */
export type VoxelWall = VoxelTarget

type DestructionState = {
  /** nodeId → voxelized target (walls, doors, slabs, items…). */
  targets: Map<string, VoxelTarget>
  /** Legacy alias — the SAME Map instance as `targets`. */
  walls: Map<string, VoxelTarget>
  version: number
  bump: () => void
  reset: () => void
}

export const useDestruction = create<DestructionState>((set) => {
  const initial = new Map<string, VoxelTarget>()
  return {
    targets: initial,
    walls: initial,
    version: 0,
    bump: () => set((s) => ({ version: s.version + 1 })),
    reset: () => {
      const next = new Map<string, VoxelTarget>()
      set({ targets: next, walls: next, version: 0 })
    },
  }
})

const _bounds = new Box3()
/** Scratch for damageTarget's dust direction (dust.tsx reads it at spawn). */
const _plumeDir = new Vector3()
const _size = new Vector3()
const _localBounds = new Box3()
const _meshBox = new Box3()
const _toLocal = new Matrix4()
const _meshToLocal = new Matrix4()

/** Above this world-axis thickness the node is not a thin axis-aligned wall
 * (diagonal walls, piers) — no skin/cavity layering, legacy grid instead. */
const MAX_ANATOMY_THICKNESS = 0.35

const STUD_SPACING = 0.4064 // 16" o.c.
const STUD_WIDTH = 0.038
const STUD_HP = 3
const WOOD = new Color('#8a6a43')

/** Stud depth that fits STRICTLY inside the cavity between the two drywall
 * skins. Anatomy grids pin the thickness axis to a thinner cell than the
 * 0.15 m length/height cells, and that cell IS the skin thickness
 * (extent/layers) — so the cavity spans cell × (layers − 2), minus a hair
 * of clearance so intact outer faces never show wood. Isotropic grids
 * (diagonal walls — no skins, full volume) keep the legacy near-full depth. */
function studDepth(grid: VoxelGridData, thickness: number): number {
  if (grid.cellX !== grid.cellZ) {
    const skinCell = Math.min(grid.cellX, grid.cellZ)
    const layers = grid.cellX < grid.cellZ ? grid.nx : grid.nz
    return Math.max(0.02, skinCell * (layers - 2) - 0.004)
  }
  return Math.max(0.06, thickness - 0.05)
}

type WallEntry = GameWorld['walls'] extends Map<string, infer V> ? V : never

/**
 * Anatomy grid for DIAGONAL walls — walls with no thin WORLD axis, the
 * common case when rooms are drawn in the rotated 3D view. Their world AABB
 * is metres deep on both plan axes, so the axis-aligned skinning path can't
 * see the thickness; instead the grid is built in the wall's yaw-local
 * frame (segment yaw, same convention as the studs), where the thickness
 * axis is thin again and the usual pinned-cell + dropInteriorCells anatomy
 * applies. Centers stay world-space so rendering, debris, and collision
 * push-out are untouched. Returns null when the segment is degenerate or
 * the local extent still isn't wall-like — callers keep the legacy
 * isotropic volume then.
 */
function buildDiagonalWallGrid(wall: WallEntry, sources: VoxelSource[]): VoxelGridData | null {
  const { start, end } = wall.node
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  if (Math.hypot(dx, dz) < 0.3) return null
  const yaw = Math.atan2(dz, dx)
  _toLocal.makeRotationY(yaw)
  _localBounds.makeEmpty()
  for (const mesh of wall.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    _meshBox
      .copy(mesh.geometry.boundingBox!)
      .applyMatrix4(_meshToLocal.multiplyMatrices(_toLocal, mesh.matrixWorld))
    _localBounds.union(_meshBox)
  }
  if (_localBounds.isEmpty()) return null
  _localBounds.getSize(_size)
  // In the yaw frame the segment runs along local X, thickness along local Z.
  const extent = _size.z
  if (extent <= 0.001 || extent > MAX_ANATOMY_THICKNESS || extent > _size.x) return null
  const layers = Math.max(3, Math.ceil(extent / 0.15 - 1e-6))
  const grid = dropInteriorCells(
    buildVoxelGrid(sources, _localBounds.clone(), 0.15, false, { z: extent / layers }, yaw),
    MAX_ANATOMY_THICKNESS,
  )
  return grid.count > 0 ? grid : null
}

function buildStuds(
  wall: GameWorld['walls'] extends Map<string, infer V> ? V : never,
  grid: VoxelGridData,
): StudMember[] {
  const { start, end } = wall.node
  const thickness = wall.node.thickness ?? 0.15
  if (thickness < 0.09) return []
  const height = wall.node.height ?? 2.7
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.3) return []
  const yaw = Math.atan2(dz, dx)
  const depth = studDepth(grid, thickness)
  // The wall's meshes live in a level whose Y offset we take from their
  // world bounds (start/end are level-local XZ but match world XZ in the
  // common single-transform case; the voxel grid corrects any drift).
  _bounds.makeEmpty()
  for (const mesh of wall.meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    _bounds.expandByPoint(
      mesh.geometry.boundingBox!.min.clone().applyMatrix4(mesh.matrixWorld),
    )
    _bounds.expandByPoint(
      mesh.geometry.boundingBox!.max.clone().applyMatrix4(mesh.matrixWorld),
    )
  }
  const baseY = _bounds.min.y
  const midX = (start[0] + end[0]) / 2
  const midZ = (start[1] + end[1]) / 2
  const centerX = _bounds.getCenter(_size).x
  const centerZ = _size.z
  // Shift start/end into world XZ using the delta between node midpoint and
  // the mesh bounds center (levels can offset their children).
  const offX = centerX - midX
  const offZ = centerZ - midZ

  const studs: StudMember[] = []
  const count = Math.max(2, Math.floor(length / STUD_SPACING) + 1)
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, (i * STUD_SPACING) / length)
    const x = start[0] + dx * t + offX
    const z = start[1] + dz * t + offZ
    studs.push({
      id: studs.length,
      center: [x, baseY + height / 2, z],
      size: [STUD_WIDTH, height - 0.1, depth],
      yaw,
      hp: STUD_HP,
      broken: false,
    })
  }
  // Top & bottom plates.
  for (const [cy, plateH] of [
    [baseY + 0.045, 0.09],
    [baseY + height - 0.045, 0.09],
  ] as const) {
    studs.push({
      id: studs.length,
      center: [midX + offX, cy, midZ + offZ],
      size: [length, plateH, depth],
      yaw,
      hp: STUD_HP,
      broken: false,
    })
  }
  return studs
}

function targetBaseColor(meshes: Mesh[]): Color {
  for (const mesh of meshes) {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const color = (material as { color?: Color } | undefined)?.color
    if (color) return color.clone()
  }
  return new Color('#d8d2c7')
}

/**
 * Voxelize ANY collider group on first damage; hides the host meshes via
 * the session ledger. Walls (world.walls) become two drywall skins with
 * breakable studs in the cavity; every other node type (doors, slabs,
 * roofs, items…) becomes a plain adaptive volume capped at 1600 voxels.
 */
export function ensureVoxelTarget(world: GameWorld, nodeId: string): VoxelTarget | null {
  const state = useDestruction.getState()
  const existing = state.targets.get(nodeId)
  if (existing) return existing

  const wall = world.walls.get(nodeId)
  const meshes: Mesh[] = []
  if (wall) {
    meshes.push(...wall.meshes)
  } else {
    for (const collider of world.colliders) {
      if (collider.nodeId === nodeId && !meshes.includes(collider.mesh)) {
        meshes.push(collider.mesh)
      }
    }
  }
  if (meshes.length === 0) return null

  _bounds.makeEmpty()
  const sources = meshes.map((mesh) => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    _bounds.union(box)
    return { bvh: bvhFor(mesh), matrixWorld: mesh.matrixWorld }
  })
  if (_bounds.isEmpty()) return null

  let grid: ReturnType<typeof buildVoxelGrid>
  if (wall) {
    // Wall anatomy needs ≥ 3 layers across the thickness so the two drywall
    // skins survive dropInteriorCells with a real cavity between them —
    // typical walls (0.10–0.15 m) are ONE 0.15 m cell thick otherwise. Pin
    // the thickness axis (the thin horizontal world extent) to thickness/3
    // cells: 0.03–0.05 m skins, ~0.15 m cells along length/height. Diagonal
    // walls have no thin world axis and keep the legacy isotropic grid.
    _bounds.getSize(_size)
    const thicknessAxis = _size.x <= _size.z ? 'x' : 'z'
    const extent = thicknessAxis === 'x' ? _size.x : _size.z
    if (extent > 0.001 && extent <= MAX_ANATOMY_THICKNESS) {
      const layers = Math.max(3, Math.ceil(extent / 0.15 - 1e-6))
      const thicknessCell = extent / layers
      grid = dropInteriorCells(
        buildVoxelGrid(
          sources,
          _bounds.clone(),
          0.15,
          false,
          thicknessAxis === 'x' ? { x: thicknessCell } : { z: thicknessCell },
        ),
        MAX_ANATOMY_THICKNESS,
      )
    } else {
      // Diagonal walls have no thin world axis: their AABB is metres deep on
      // both plan axes, so the min-extent axis dropInteriorCells would pick
      // is the wall HEIGHT — skinning the world grid deletes the whole wall
      // body. Build the same anatomy in the wall's yaw-local frame instead;
      // degenerate segments keep the full isotropic volume.
      grid = buildDiagonalWallGrid(wall, sources) ?? buildVoxelGrid(sources, _bounds.clone(), 0.15, false)
    }
  } else {
    grid = buildVoxelGrid(sources, _bounds.clone(), 0.15, true)
  }
  if (grid.count === 0) return null

  const target: VoxelTarget = {
    nodeId,
    kind: wall ? 'wall' : 'volume',
    grid,
    baseColor: targetBaseColor(meshes),
    studs: wall ? buildStuds(wall, grid) : [],
    removedQueue: [],
    revision: 0,
  }

  for (const mesh of meshes) hideForGame(mesh)
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) collider.disabled = true
  }

  state.targets.set(nodeId, target)
  state.bump()
  return target
}

/** Legacy alias — works for any node kind now, not just walls. */
export const ensureVoxelWall = ensureVoxelTarget

const islandTimers = new Map<string, ReturnType<typeof setTimeout>>()

function crumbleIslands(target: VoxelTarget): void {
  const islands = findUnsupportedIslands(target.grid)
  if (islands.length === 0) return
  let total = 0
  for (const island of islands) {
    total += island.length
    for (const idx of island) {
      if (!target.grid.alive[idx]) continue
      target.grid.alive[idx] = 0
      target.grid.aliveCount--
      target.removedQueue.push(idx)
      spawnDebris(
        target.grid.centers[idx * 3]!,
        target.grid.centers[idx * 3 + 1]!,
        target.grid.centers[idx * 3 + 2]!,
        target.grid.cell,
        target.baseColor,
        1.6,
      )
    }
  }
  target.revision++
  useDestruction.getState().bump()
  // One lingering haze plume per collapse, rising from the first lost voxel.
  const first = islands[0]?.[0]
  if (first !== undefined) {
    spawnHaze(
      target.grid.centers[first * 3]!,
      target.grid.centers[first * 3 + 1]!,
      target.grid.centers[first * 3 + 2]!,
    )
  }
  // Broken framing in the collapse → wood-laced rubble; pure drywall otherwise.
  let framingGone = false
  for (const stud of target.studs) {
    if (stud.broken) {
      framingGone = true
      break
    }
  }
  if (framingGone) sfx.woodCrumble(total)
  else sfx.crumble(total)
}

/** Carve a sphere out of any target at a world point (voxelizes on first
 * hit); spawns debris, queues the island check. Returns how many voxels
 * were removed. `direction` (optional, phase 3) is the shot direction —
 * it aims the wall-tear dust plume through the hole. */
export function damageTarget(
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
  direction?: Vector3,
): number {
  const target = ensureVoxelTarget(world, nodeId)
  if (!target) return 0
  const removed = removeSphere(target.grid, point.x, point.y, point.z, radius)
  if (removed.length === 0) return 0
  target.removedQueue.push(...removed)
  target.revision++
  useDestruction.getState().bump()
  const debrisCount = Math.min(removed.length, 10)
  for (let i = 0; i < debrisCount; i++) {
    const idx = removed[Math.floor(Math.random() * removed.length)]!
    spawnDebris(
      target.grid.centers[idx * 3]!,
      target.grid.centers[idx * 3 + 1]!,
      target.grid.centers[idx * 3 + 2]!,
      target.grid.cell * (0.6 + Math.random() * 0.5),
      target.baseColor,
      2.6,
    )
  }
  // Dust (single-emission policy: this module owns ALL wall carve dust —
  // shooting.ts is deliberately silent for walls). Drywall tears throw a
  // MASSIVE billowing plume coned through the hole; plain volumes keep a
  // modest puff scaled by how much material the carve took out.
  if (target.kind === 'wall') {
    spawnDust(point, Math.min(1, 0.45 + removed.length / 18), {
      kind: 'plume',
      direction: direction ? _plumeDir.copy(direction) : undefined,
    })
  } else {
    spawnDust(point, Math.min(1, 0.25 + removed.length / 30), {
      kind: 'puff',
      direction: direction ? _plumeDir.copy(direction) : undefined,
    })
  }
  // Walls get the papery drywallCrunch from shooting.ts; only plain volumes
  // voice their own crunch here (avoids the two sounds layering).
  if (target.kind !== 'wall') sfx.voxelCrunch(Math.min(1, removed.length / 12))

  const prior = islandTimers.get(nodeId)
  if (prior) clearTimeout(prior)
  islandTimers.set(
    nodeId,
    setTimeout(() => {
      islandTimers.delete(nodeId)
      crumbleIslands(target)
    }, 140),
  )
  return removed.length
}

/** Legacy alias. */
export const damageWall = damageTarget

export type StudRayHit = { nodeId: string; studId: number; distance: number; point: Vector3 }

/** Nearest live (unbroken) stud any voxelized wall exposes along the ray —
 * analytic ray-vs-OBB, no meshes involved. */
export function raycastStuds(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): StudRayHit | null {
  let bestDist = maxDist
  let bestNode: string | null = null
  let bestStud = -1
  for (const target of useDestruction.getState().targets.values()) {
    for (const stud of target.studs) {
      if (stud.broken) continue
      const t = raycastYawObb(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        stud.center[0],
        stud.center[1],
        stud.center[2],
        stud.size[0] / 2,
        stud.size[1] / 2,
        stud.size[2] / 2,
        stud.yaw,
        bestDist,
      )
      if (t === null || t >= bestDist) continue
      bestDist = t
      bestNode = target.nodeId
      bestStud = stud.id
    }
  }
  if (bestNode === null) return null
  return {
    nodeId: bestNode,
    studId: bestStud,
    distance: bestDist,
    point: origin.clone().addScaledVector(direction, bestDist),
  }
}

/** Chip a stud. Splinters fly at the hit point; at hp ≤ 0 the stud breaks:
 * two large falling wood pieces (upper + lower halves), more splinters, a
 * snap. Returns true when damage applied (false: unknown/already broken). */
export function damageStud(
  world: GameWorld,
  nodeId: string,
  studId: number,
  damage: number,
  point: Vector3,
): boolean {
  void world // reserved (future: structural collapse of the wall above)
  const target = useDestruction.getState().targets.get(nodeId)
  if (!target) return false
  const stud = target.studs.find((s) => s.id === studId)
  if (!stud || stud.broken) return false
  stud.hp -= damage
  for (let i = 0; i < 4; i++) {
    spawnDebris(point.x, point.y, point.z, 0.02 + Math.random() * 0.02, WOOD, 2, 0.9)
  }
  if (stud.hp > 0) {
    sfx.studHit()
    return true
  }
  stud.hp = 0 // clamp — debug snapshots read hp, don't show underflow
  stud.broken = true
  target.revision++
  useDestruction.getState().bump()
  const quarter = stud.size[1] / 4
  spawnDebris(stud.center[0], stud.center[1] + quarter, stud.center[2], 0.09 + Math.random() * 0.03, WOOD, 1.2, 3.5)
  spawnDebris(stud.center[0], stud.center[1] - quarter, stud.center[2], 0.09 + Math.random() * 0.03, WOOD, 1.2, 3.5)
  for (let i = 0; i < 6; i++) {
    spawnDebris(point.x, point.y, point.z, 0.02 + Math.random() * 0.025, WOOD, 2.4, 1.2)
  }
  sfx.studSnap()
  return true
}

export type TargetRayHit = { nodeId: string; distance: number; point: Vector3 }
/** Legacy alias. */
export type WallRayHit = TargetRayHit

/** First live voxel any damaged target's grid intersects along the ray. */
export function raycastVoxelTargets(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): TargetRayHit | null {
  let best: TargetRayHit | null = null
  for (const target of useDestruction.getState().targets.values()) {
    const hit = raycastVoxels(
      target.grid,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      maxDist,
    )
    if (!hit) continue
    if (!best || hit.distance < best.distance) {
      best = {
        nodeId: target.nodeId,
        distance: hit.distance,
        point: origin.clone().addScaledVector(direction, hit.distance),
      }
    }
  }
  return best
}

/** Legacy alias. */
export const raycastVoxelWalls = raycastVoxelTargets

const _voxelCenter = new Vector3()

/** Capsule push-out against live voxels of every target (voxels ≈ spheres
 * of r=0.55·cell — close enough at 15 cm cells, and far cheaper than box
 * tests). */
export function collideVoxelTargets(pos: Vector3, vel: Vector3, radius: number, height: number): boolean {
  let grounded = false
  for (const target of useDestruction.getState().targets.values()) {
    const { grid } = target
    // Sphere radius keys off the LARGEST cell — any smaller and the capsule
    // could slip between skin voxels spaced a full length-cell apart.
    const r = grid.cell * 0.55
    // Yaw grids index cells in their local frame; a vertical capsule stays
    // a vertical capsule under a Y rotation, so only its XZ center moves.
    // The push-out below runs on world centers and needs no rotation.
    let px = pos.x
    let pz = pos.z
    if (grid.yaw !== 0) {
      const cos = Math.cos(grid.yaw)
      const sin = Math.sin(grid.yaw)
      px = pos.x * cos + pos.z * sin
      pz = -pos.x * sin + pos.z * cos
    }
    const minX = Math.floor((px - radius - r - grid.origin.x) / grid.cellX)
    const maxX = Math.floor((px + radius + r - grid.origin.x) / grid.cellX)
    const minY = Math.floor((pos.y - r - grid.origin.y) / grid.cellY)
    const maxY = Math.floor((pos.y + height + r - grid.origin.y) / grid.cellY)
    const minZ = Math.floor((pz - radius - r - grid.origin.z) / grid.cellZ)
    const maxZ = Math.floor((pz + radius + r - grid.origin.z) / grid.cellZ)
    if (maxX < 0 || maxY < 0 || maxZ < 0) continue
    for (let iz = Math.max(0, minZ); iz <= Math.min(grid.nz - 1, maxZ); iz++) {
      for (let iy = Math.max(0, minY); iy <= Math.min(grid.ny - 1, maxY); iy++) {
        for (let ix = Math.max(0, minX); ix <= Math.min(grid.nx - 1, maxX); ix++) {
          const idx = grid.index.get(ix + grid.nx * (iy + grid.ny * iz))
          if (idx === undefined || !grid.alive[idx]) continue
          _voxelCenter.set(
            grid.centers[idx * 3]!,
            grid.centers[idx * 3 + 1]!,
            grid.centers[idx * 3 + 2]!,
          )
          // Closest point on the capsule's core segment to the voxel center.
          const coreY = Math.min(Math.max(_voxelCenter.y, pos.y + radius), pos.y + height - radius)
          const dx = pos.x - _voxelCenter.x
          const dy = coreY - _voxelCenter.y
          const dz = pos.z - _voxelCenter.z
          const dist = Math.hypot(dx, dy, dz)
          const minDist = radius + r
          if (dist >= minDist || dist < 1e-6) continue
          const push = (minDist - dist) / dist
          pos.x += dx * push
          pos.y += dy * push
          pos.z += dz * push
          if (dy / dist > 0.55) grounded = true
          const nx = dx / dist
          const nyn = dy / dist
          const nz = dz / dist
          const into = vel.x * nx + vel.y * nyn + vel.z * nz
          if (into < 0) {
            vel.x -= nx * into
            vel.y -= nyn * into
            vel.z -= nz * into
          }
        }
      }
    }
  }
  return grounded
}

/** Legacy alias. */
export const collideVoxelWalls = collideVoxelTargets

/** Forget one voxel target (builder G-undo unmounts its source mesh): the
 * replica unmounts and any pending island collapse for it is cancelled.
 * No-op if the node never voxelized. */
export function dropTarget(nodeId: string): void {
  const timer = islandTimers.get(nodeId)
  if (timer !== undefined) {
    clearTimeout(timer)
    islandTimers.delete(nodeId)
  }
  const state = useDestruction.getState()
  if (state.targets.delete(nodeId)) state.bump()
}

export function resetDestruction(): void {
  for (const timer of islandTimers.values()) clearTimeout(timer)
  islandTimers.clear()
  useDestruction.getState().reset()
}
