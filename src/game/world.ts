import { sceneRegistry, useScene } from '@pascal-app/core'
import { Box3, type BufferGeometry, Matrix4, type Mesh, type Object3D, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

/**
 * One-shot world snapshot taken when the game starts: which host meshes are
 * solid (colliders + bullet targets), which walls are voxel-destructible,
 * which panes are glass, where the building sits, and where to spawn.
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
}

export type GameWorld = {
  colliders: ColliderEntry[]
  /** wall nodeId → its colliders' indices + node data (for stud generation). */
  walls: Map<string, { node: WallNodeLike; root: Object3D; meshes: Mesh[] }>
  glass: GlassPane[]
  doors: DoorEntry[]
  /** Roots of engineering-overlay renderers (Bones X-ray members). Never
   * solid or destructible — game-root hides them for the session via the
   * restore ledger so no unbreakable ghost layer haunts voxelized walls.
   * Optional only so hand-built test worlds don't have to carry it;
   * collectWorld always returns it (possibly empty).
   * TODO(quiet round): flip to required + add `overlayRoots: []` to every
   * test fixture. Deliberately left optional through phase-3 round 2: the
   * sandwich/trees agents were still landing new GameWorld fixtures written
   * against this optional shape, and their test files have other owners. */
  overlayRoots?: Object3D[]
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
 * INSIDE walls, so once a wall voxelizes they'd read as an unbreakable
 * ghost layer — collected here so the session can hide them wholesale. */
const OVERLAY_KINDS = ['bones:framing', 'bones:lumber', 'bones:service', 'bones:device']

const bvhCache = new WeakMap<BufferGeometry, MeshBVH>()

export function bvhFor(mesh: Mesh): MeshBVH {
  let bvh = bvhCache.get(mesh.geometry)
  if (!bvh) {
    bvh = new MeshBVH(mesh.geometry)
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

function collectMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = []
  root.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh || !mesh.visible) return
    if ((mesh.userData as { __boots?: boolean }).__boots) return
    const position = mesh.geometry?.getAttribute?.('position')
    if (!position || position.count < 3) return
    meshes.push(mesh)
  })
  return meshes
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
  for (const kind of OVERLAY_KINDS) {
    const ids = sceneRegistry.byType[kind]
    if (!ids) continue
    for (const id of ids) {
      const root = sceneRegistry.nodes.get(id)
      if (root) overlayRoots.push(root)
    }
  }
  return overlayRoots
}

export function collectWorld(): GameWorld {
  const nodes = useScene.getState().nodes as Record<
    string,
    { type?: string; visible?: boolean } & Partial<WallNodeLike> & Record<string, unknown>
  >

  const colliders: ColliderEntry[] = []
  const walls = new Map<string, { node: WallNodeLike; root: Object3D; meshes: Mesh[] }>()
  const glass: GlassPane[] = []
  const doors: DoorEntry[] = []
  const buildingAabb = new Box3()
  const meshBounds = new Box3()

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
      const meshes = collectMeshes(root)
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
        colliders.push({
          mesh,
          bvh: bvhFor(mesh),
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
        doors.push({ nodeId: id, root, colliderIndices })
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

  // Spawn: outside the building along +X of its center, eye toward it.
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

  const levelId =
    (
      useScene.getState() as unknown as {
        selectedLevelId?: string | null
      }
    ).selectedLevelId ?? null

  return { colliders, walls, glass, doors, overlayRoots, buildingAabb, spawn, spawnYaw, levelId }
}
