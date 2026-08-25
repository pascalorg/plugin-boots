import { Color, Matrix4, Ray, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import * as destruct from './destruction'
import {
  damageStud,
  damageTarget,
  raycastStuds,
  raycastVoxelTargets,
  useDestruction,
} from './destruction'
import { spawnDust } from './dust'
import { damageBot, raycastBots } from './enemies-state'
import { hitGlass, raycastGlass } from './glass'
import { playerRig } from './player'
import type { WeaponDef } from './weapons'
import type { GameWorld } from './world'

/**
 * Hitscan resolution across every target class, phase-3 edition:
 * solid host meshes (BVH), voxelized skins (grid DDA), drywall BOARDS
 * (flat tearable plates), framing SEGMENTS (charcoal-stick studs), trees,
 * glass panes, bots. Nearest hit wins; on a near-tie (within 1 cm) the
 * higher class wins:
 *
 *   bot > glass > tree > segment > board > voxel skin > solid collider
 *
 * First bullet into a pristine destructible node converts it to voxels and
 * carves in the same shot — walls get the skins + framing anatomy
 * automatically.
 *
 * ── Sound ownership (no double-voicing) ───────────────────────────────
 *   voxel skins   drywallCrunch here (carve); plain volumes self-voice in
 *                 damageTarget.
 *   boards        damageBoard voices the paper tear — silent here.
 *   segments      damageSegment / damageStud voice chip + snap — silent
 *                 here (tiny voxelCrunch only when the hit went stale).
 *   trees/glass/bots  their modules voice themselves.
 *
 * ── Dust ───────────────────────────────────────────────────────────────
 *   Every hit class puffs spawnDust at the impact (guarded — the fleet
 *   rewrites dust.tsx too); heavy carves (removed > 6) add a second puff
 *   pushed along the shot so carve-through reads inside the hole.
 *
 * ── Phase-3 destruction contract (feature-detected) ────────────────────
 * destruction.ts is being extended by a parallel agent. This file routes
 * through the new surface the moment it exists and falls back to the
 * legacy stud lane meanwhile. Expected exports (build against these — a
 * mismatch fails tsc AT THE CAST BELOW on purpose, loudly):
 *   raycastSegments(origin, direction, maxDist)
 *       → { nodeId, segmentId, distance, point } | null
 *   damageSegment(world, nodeId, segmentId, damage, point) → boolean
 *   raycastBoards(origin, direction, maxDist)
 *       → { nodeId, boardId, distance, point } | null
 *   damageBoard(world, nodeId, boardId, damage, point, direction) → number
 *       (voxels/shreds removed; owns the tear sfx)
 *   damageTarget(world, nodeId, point, radius, direction?) — direction is
 *       the new optional carve-through param; legacy 4-arg calls still work.
 *
 * ── Tree routes (registry) ─────────────────────────────────────────────
 * trees-destruct owns tree combat; it registers here at module init:
 *   registerTreeRoutes({
 *     raycast: treesRaycast,   // (origin, direction, maxDist) → hit | null
 *     damage: (world, hit, damage, radius, direction) =>
 *       treesDamage(world, hit, damage, radius, direction),
 *   })
 * Hits only need { distance, point }; the damage callback receives the
 * exact object its paired raycast returned, so extra fields flow through.
 * Until registration, trees resolve as plain solid colliders (sparks).
 */

export type FireOutcome = 'bot' | 'wall' | 'glass' | 'tree' | 'solid' | 'none'

type HitClass = 'none' | 'solid' | 'voxel' | 'board' | 'segment' | 'tree' | 'glass' | 'bot'

/** Near-tie window: hits this close resolve by class priority, not range. */
const TIE = 0.01

/** Node types that route through the voxel destruction manager. Anything
 * else (terrain, fixtures we can't voxelize…) just sparks. */
const DESTRUCTIBLE = new Set([
  'wall',
  'door',
  'slab',
  'floor',
  'ceiling',
  'roof',
  'roof-segment',
  'item',
  'shelf',
  'cabinet',
  'cabinet-module',
  'block',
  'column',
  'stair',
  'stair-segment',
  'counter',
  'kitchen-unit',
])

// --- Phase-3 destruction façade (see contract in the doc block) ---------

type SegmentRayHit = {
  nodeId: string
  /** Phase-3 field name; the legacy stud lane fills studId instead. */
  segmentId?: number
  studId?: number
  distance: number
  point: Vector3
}

type BoardRayHit = {
  nodeId: string
  boardId: number
  distance: number
  point: Vector3
}

type Phase3Destruction = {
  raycastSegments?: (origin: Vector3, direction: Vector3, maxDist: number) => SegmentRayHit | null
  damageSegment?: (
    world: GameWorld,
    nodeId: string,
    segmentId: number,
    damage: number,
    point: Vector3,
  ) => boolean
  raycastBoards?: (origin: Vector3, direction: Vector3, maxDist: number) => BoardRayHit | null
  damageBoard?: (
    world: GameWorld,
    nodeId: string,
    boardId: number,
    damage: number,
    point: Vector3,
    direction: Vector3,
  ) => number | void
}

/** Guarded view of the parallel agent's new exports — every use checks
 * existence, so this file is green before AND after they land. */
const d3: Phase3Destruction = destruct as Phase3Destruction

/** damageTarget with the phase-3 carve-through direction; calling the
 * legacy 4-arg implementation with a 5th arg is harmless until it lands. */
const carveTarget = damageTarget as (
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
  direction?: Vector3,
) => number

// --- Tree combat routes (registered by trees-destruct at module init) ---

export type TreeRayHit = { distance: number; point: Vector3 }

export type TreeCombatRoutes<H extends TreeRayHit = TreeRayHit> = {
  /** Nearest live tree part along the ray, culled at maxDist. */
  raycast: (origin: Vector3, direction: Vector3, maxDist: number) => H | null
  /** hit is the exact object this route's raycast returned. direction is
   * the normalized shot direction (felling / carve-through). */
  damage: (world: GameWorld, hit: H, damage: number, radius: number, direction: Vector3) => void
}

let treeRoutes: TreeCombatRoutes | null = null

/** Wire (or clear, with null) tree combat. The generic ties the damage
 * callback to its own raycast's hit type, so richer hit shapes need no
 * casts on the caller side. */
export function registerTreeRoutes<H extends TreeRayHit>(routes: TreeCombatRoutes<H> | null): void {
  treeRoutes = routes as TreeCombatRoutes | null
}

// -------------------------------------------------------------------------

const _origin = new Vector3()
const _direction = new Vector3()
const _ray = new Ray()
const _inverse = new Matrix4()
const _point = new Vector3()
const SPARK = new Color('#c9c2b4')

export function aimDirection(target: Vector3, spread: number): Vector3 {
  target.set(0, 0, -1)
  // yaw/pitch → forward (YXZ order, same as the camera).
  const cp = Math.cos(playerRig.pitch)
  target.set(
    -Math.sin(playerRig.yaw) * cp,
    Math.sin(playerRig.pitch),
    -Math.cos(playerRig.yaw) * cp,
  )
  if (spread > 0) {
    // Movement widens the cone — reward planted feet.
    const total = spread * (1 + playerRig.speed * 0.25) * (playerRig.grounded ? 1 : 1.8)
    target.x += (Math.random() - 0.5) * 2 * total
    target.y += (Math.random() - 0.5) * 2 * total
    target.z += (Math.random() - 0.5) * 2 * total
    target.normalize()
  }
  return target
}

/** Impact dust, existence-guarded (the fleet rewrites dust.tsx too). */
function puff(x: number, y: number, z: number, intensity: number): void {
  if (typeof spawnDust === 'function') spawnDust(x, y, z, intensity)
}

/** Extra puff for heavy carves, pushed along the shot so the dissolve
 * reads INSIDE the hole — the slow-lobby shootout air. */
function heavyPuff(point: Vector3, direction: Vector3, removed: number): void {
  if (removed <= 6) return
  puff(
    point.x + direction.x * 0.25,
    point.y + direction.y * 0.25,
    point.z + direction.z * 0.25,
    Math.min(1, 0.5 + removed / 30),
  )
}

/** Carve into a destructible node; drywall skins get the papery crunch on
 * top (damageTarget's own crunch covers plain volumes). Returns voxels
 * removed. */
function carve(
  world: GameWorld,
  nodeId: string,
  point: Vector3,
  radius: number,
  direction: Vector3,
): number {
  const removed = carveTarget(world, nodeId, point, radius, direction)
  if (removed > 0 && useDestruction.getState().targets.get(nodeId)?.kind === 'wall') {
    sfx.drywallCrunch(Math.min(1, removed / 10))
  }
  puff(point.x, point.y, point.z, Math.min(1, 0.3 + removed / 40))
  heavyPuff(point, direction, removed)
  return removed
}

export function fire(world: GameWorld, weapon: WeaponDef): FireOutcome {
  _origin.copy(playerRig.position)
  aimDirection(_direction, weapon.spread)

  // Candidates are cast in ascending class priority, each culled at the
  // current winner's distance + TIE. Any hit a later cast returns is either
  // strictly nearer or a near-tie — and near-ties go to the higher class —
  // so "last accepted wins" resolves both rules at once.
  let bestDist = weapon.range
  let winner: HitClass = 'none'
  let solidNodeId: string | null = null
  let solidNodeType: string | null = null
  _point.set(0, 0, 0)

  // Solid host meshes (lowest priority).
  for (const collider of world.colliders) {
    if (collider.disabled) continue
    _inverse.copy(collider.inverse)
    _ray.origin.copy(_origin).applyMatrix4(_inverse)
    _ray.direction.copy(_direction).transformDirection(_inverse)
    const hit = collider.bvh.raycastFirst(_ray, 2)
    if (!hit) continue
    const world_ = hit.point.applyMatrix4(collider.mesh.matrixWorld)
    const distance = world_.distanceTo(_origin)
    if (distance < bestDist) {
      bestDist = distance
      winner = 'solid'
      solidNodeId = collider.nodeId
      solidNodeType = collider.nodeType
      _point.copy(world_)
    }
  }

  // Already-voxelized skins (walls, doors, slabs, items…).
  const voxelHit = raycastVoxelTargets(_origin, _direction, bestDist + TIE)
  if (voxelHit) {
    bestDist = voxelHit.distance
    winner = 'voxel'
    _point.copy(voxelHit.point)
  }

  // Drywall boards behind the cladding (phase-3 lane; absent = skip).
  const boardHit =
    d3.raycastBoards && d3.damageBoard
      ? d3.raycastBoards(_origin, _direction, bestDist + TIE)
      : null
  if (boardHit) {
    bestDist = boardHit.distance
    winner = 'board'
  }

  // Framing segments in opened cavities (falls back to the legacy whole-stud
  // lane until the segment API lands).
  const segmentHit: SegmentRayHit | null =
    d3.raycastSegments && d3.damageSegment
      ? d3.raycastSegments(_origin, _direction, bestDist + TIE)
      : raycastStuds(_origin, _direction, bestDist + TIE)
  if (segmentHit) {
    bestDist = segmentHit.distance
    winner = 'segment'
  }

  // Trees (once trees-destruct has registered its routes).
  const treeHit = treeRoutes ? treeRoutes.raycast(_origin, _direction, bestDist + TIE) : null
  if (treeHit) {
    bestDist = treeHit.distance
    winner = 'tree'
  }

  // Glass.
  const glassHit = raycastGlass(world, _origin, _direction, bestDist + TIE)
  if (glassHit) {
    bestDist = glassHit.distance
    winner = 'glass'
  }

  // Bots.
  const botHit = raycastBots(_origin, _direction, bestDist + TIE)
  if (botHit) winner = 'bot'

  if (winner === 'bot' && botHit) {
    damageBot(botHit.bot, weapon.damage)
    puff(botHit.point.x, botHit.point.y, botHit.point.z, 0.3)
    return 'bot'
  }
  if (winner === 'glass' && glassHit) {
    hitGlass(glassHit)
    puff(glassHit.point.x, glassHit.point.y, glassHit.point.z, 0.25)
    return 'glass'
  }
  if (winner === 'tree' && treeHit && treeRoutes) {
    // Tree module owns its own voxel-burst/char sfx.
    treeRoutes.damage(world, treeHit, weapon.damage, weapon.holeRadius, _direction)
    puff(treeHit.point.x, treeHit.point.y, treeHit.point.z, 0.35)
    return 'tree'
  }
  if (winner === 'segment' && segmentHit) {
    // Knife whittles (1 hp per swing); guns hit at full damage. The damage
    // routine owns the chip/snap sfx — no extra sound here.
    const memberId = segmentHit.segmentId ?? segmentHit.studId ?? -1
    const dmg = weapon.melee ? 1 : weapon.damage
    const applied = d3.damageSegment
      ? d3.damageSegment(world, segmentHit.nodeId, memberId, dmg, segmentHit.point)
      : damageStud(world, segmentHit.nodeId, memberId, dmg, segmentHit.point)
    if (!applied) sfx.voxelCrunch(0.25)
    puff(segmentHit.point.x, segmentHit.point.y, segmentHit.point.z, 0.3)
    return 'wall'
  }
  if (winner === 'board' && boardHit && d3.damageBoard) {
    // damageBoard voices the paper tear itself — silent here.
    const torn = d3.damageBoard(
      world,
      boardHit.nodeId,
      boardHit.boardId,
      weapon.damage,
      boardHit.point,
      _direction,
    )
    puff(boardHit.point.x, boardHit.point.y, boardHit.point.z, 0.4)
    if (typeof torn === 'number') heavyPuff(boardHit.point, _direction, torn)
    return 'wall'
  }
  if (winner === 'voxel' && voxelHit) {
    carve(world, voxelHit.nodeId, _point, weapon.holeRadius, _direction)
    return 'wall'
  }
  if (winner === 'solid' && solidNodeId) {
    if (solidNodeType && DESTRUCTIBLE.has(solidNodeType)) {
      // First blood: voxelize + carve in one go (walls keep their skins +
      // framing anatomy via the destruction manager).
      if (carve(world, solidNodeId, _point, weapon.holeRadius, _direction) > 0) return 'wall'
    }
    // Non-destructible surface (or one that refused to voxelize): sparks
    // and a thunk.
    for (let i = 0; i < 3; i++) {
      spawnDebris(_point.x, _point.y, _point.z, 0.035, SPARK, 1.4, 0.6)
    }
    puff(_point.x, _point.y, _point.z, 0.25)
    if (weapon.melee) sfx.knifeHit()
    else sfx.voxelCrunch(0.25)
    return 'solid'
  }
  return 'none'
}
