import { Box3, Color, type Mesh, Vector3 } from 'three'
import { create } from 'zustand'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { hideForGame } from './session'
import {
  buildVoxelGrid,
  findUnsupportedIslands,
  raycastVoxels,
  removeSphere,
  type VoxelGridData,
} from './voxel'
import { bvhFor, type GameWorld } from './world'

/**
 * Voxel-wall destruction manager. A wall stays the host's pristine mesh
 * until the first hit lands; then the mesh is hidden (session ledger — the
 * editor gets it back untouched) and a voxel replica takes over rendering,
 * collision, and bullet interception. Studs are generated from the wall
 * node's own start/end/thickness — break the drywall, meet the framing.
 */

export type StudBox = {
  center: [number, number, number]
  size: [number, number, number]
  yaw: number
}

export type VoxelWall = {
  nodeId: string
  grid: VoxelGridData
  baseColor: Color
  studs: StudBox[]
  /** Voxel indices removed since the renderer last drained the queue. */
  removedQueue: number[]
  /** Bumped on every change so the renderer knows to re-upload. */
  revision: number
}

type DestructionState = {
  walls: Map<string, VoxelWall>
  version: number
  bump: () => void
  reset: () => void
}

export const useDestruction = create<DestructionState>((set) => ({
  walls: new Map(),
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
  reset: () => set({ walls: new Map(), version: 0 }),
}))

const _bounds = new Box3()
const _size = new Vector3()

const STUD_SPACING = 0.4064 // 16" o.c.
const STUD_WIDTH = 0.038

function buildStuds(wall: GameWorld['walls'] extends Map<string, infer V> ? V : never): StudBox[] {
  const { start, end } = wall.node
  const thickness = wall.node.thickness ?? 0.15
  if (thickness < 0.09) return []
  const height = wall.node.height ?? 2.7
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.3) return []
  const yaw = Math.atan2(dz, dx)
  const depth = Math.max(0.06, thickness - 0.05)
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

  const studs: StudBox[] = []
  const count = Math.max(2, Math.floor(length / STUD_SPACING) + 1)
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, (i * STUD_SPACING) / length)
    const x = start[0] + dx * t + offX
    const z = start[1] + dz * t + offZ
    studs.push({
      center: [x, baseY + height / 2, z],
      size: [STUD_WIDTH, height - 0.1, depth],
      yaw,
    })
  }
  // Top & bottom plates.
  for (const [cy, plateH] of [
    [baseY + 0.045, 0.09],
    [baseY + height - 0.045, 0.09],
  ] as const) {
    studs.push({
      center: [midX + offX, cy, midZ + offZ],
      size: [length, plateH, depth],
      yaw,
    })
  }
  return studs
}

function wallBaseColor(meshes: Mesh[]): Color {
  for (const mesh of meshes) {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const color = (material as { color?: Color } | undefined)?.color
    if (color) return color.clone()
  }
  return new Color('#d8d2c7')
}

/** Voxelize a wall on first damage; hides the host meshes via the session ledger. */
export function ensureVoxelWall(world: GameWorld, nodeId: string): VoxelWall | null {
  const state = useDestruction.getState()
  const existing = state.walls.get(nodeId)
  if (existing) return existing
  const wall = world.walls.get(nodeId)
  if (!wall) return null

  _bounds.makeEmpty()
  const sources = wall.meshes.map((mesh) => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
    _bounds.union(box)
    return { bvh: bvhFor(mesh), matrixWorld: mesh.matrixWorld }
  })
  if (_bounds.isEmpty()) return null

  const grid = buildVoxelGrid(sources, _bounds.clone(), 0.15)
  if (grid.count === 0) return null

  const voxelWall: VoxelWall = {
    nodeId,
    grid,
    baseColor: wallBaseColor(wall.meshes),
    studs: buildStuds(wall),
    removedQueue: [],
    revision: 0,
  }

  for (const mesh of wall.meshes) hideForGame(mesh)
  for (const collider of world.colliders) {
    if (collider.nodeId === nodeId) collider.disabled = true
  }

  state.walls.set(nodeId, voxelWall)
  state.bump()
  return voxelWall
}

const islandTimers = new Map<string, ReturnType<typeof setTimeout>>()

function crumbleIslands(wall: VoxelWall): void {
  const islands = findUnsupportedIslands(wall.grid)
  if (islands.length === 0) return
  let total = 0
  for (const island of islands) {
    total += island.length
    for (const idx of island) {
      if (!wall.grid.alive[idx]) continue
      wall.grid.alive[idx] = 0
      wall.grid.aliveCount--
      wall.removedQueue.push(idx)
      spawnDebris(
        wall.grid.centers[idx * 3]!,
        wall.grid.centers[idx * 3 + 1]!,
        wall.grid.centers[idx * 3 + 2]!,
        wall.grid.cell,
        wall.baseColor,
        1.6,
      )
    }
  }
  wall.revision++
  useDestruction.getState().bump()
  sfx.crumble(total)
}

/** Carve a sphere out of a wall at a world point; spawns debris, queues the
 * island check. Returns how many voxels were removed. */
export function damageWall(
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
): number {
  const wall = ensureVoxelWall(world, nodeId)
  if (!wall) return 0
  const removed = removeSphere(wall.grid, point.x, point.y, point.z, radius)
  if (removed.length === 0) return 0
  wall.removedQueue.push(...removed)
  wall.revision++
  useDestruction.getState().bump()
  const debrisCount = Math.min(removed.length, 10)
  for (let i = 0; i < debrisCount; i++) {
    const idx = removed[Math.floor(Math.random() * removed.length)]!
    spawnDebris(
      wall.grid.centers[idx * 3]!,
      wall.grid.centers[idx * 3 + 1]!,
      wall.grid.centers[idx * 3 + 2]!,
      wall.grid.cell * (0.6 + Math.random() * 0.5),
      wall.baseColor,
      2.6,
    )
  }
  sfx.voxelCrunch(Math.min(1, removed.length / 12))

  const prior = islandTimers.get(nodeId)
  if (prior) clearTimeout(prior)
  islandTimers.set(
    nodeId,
    setTimeout(() => {
      islandTimers.delete(nodeId)
      crumbleIslands(wall)
    }, 140),
  )
  return removed.length
}

export type WallRayHit = { nodeId: string; distance: number; point: Vector3 }

/** First live voxel any damaged wall's grid intersects along the ray. */
export function raycastVoxelWalls(
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): WallRayHit | null {
  let best: WallRayHit | null = null
  for (const wall of useDestruction.getState().walls.values()) {
    const hit = raycastVoxels(
      wall.grid,
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
        nodeId: wall.nodeId,
        distance: hit.distance,
        point: origin.clone().addScaledVector(direction, hit.distance),
      }
    }
  }
  return best
}

const _voxelCenter = new Vector3()

/** Capsule push-out against live voxels (voxels ≈ spheres of r=0.55·cell —
 * close enough at 15 cm cells, and far cheaper than box tests). */
export function collideVoxelWalls(pos: Vector3, vel: Vector3, radius: number, height: number): boolean {
  let grounded = false
  for (const wall of useDestruction.getState().walls.values()) {
    const { grid } = wall
    const r = grid.cell * 0.55
    const minX = Math.floor((pos.x - radius - r - grid.origin.x) / grid.cell)
    const maxX = Math.floor((pos.x + radius + r - grid.origin.x) / grid.cell)
    const minY = Math.floor((pos.y - r - grid.origin.y) / grid.cell)
    const maxY = Math.floor((pos.y + height + r - grid.origin.y) / grid.cell)
    const minZ = Math.floor((pos.z - radius - r - grid.origin.z) / grid.cell)
    const maxZ = Math.floor((pos.z + radius + r - grid.origin.z) / grid.cell)
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

export function resetDestruction(): void {
  for (const timer of islandTimers.values()) clearTimeout(timer)
  islandTimers.clear()
  useDestruction.getState().reset()
}
