import { Color, Matrix4, Ray, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { spawnDust } from './dust'
import {
  damageStud,
  damageTarget,
  raycastStuds,
  raycastVoxelTargets,
  useDestruction,
} from './destruction'
import { damageBot, raycastBots } from './enemies-state'
import { hitGlass, raycastGlass } from './glass'
import { playerRig } from './player'
import type { WeaponDef } from './weapons'
import type { GameWorld } from './world'

/**
 * Hitscan resolution across every target class: solid host meshes (BVH),
 * voxelized targets (grid DDA), breakable studs (OBB), glass panes, bots.
 * Nearest hit wins; on a near-tie (within 1 cm) the higher class wins:
 * bot > glass > stud > voxel grid > solid collider. First bullet into a
 * pristine destructible node converts it to voxels and carves in the
 * same shot — walls get the skins + studs anatomy automatically.
 */

export type FireOutcome = 'bot' | 'wall' | 'glass' | 'solid' | 'none'

type HitClass = 'none' | 'solid' | 'voxel' | 'stud' | 'glass' | 'bot'

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

/** Carve into a destructible node; drywall skins get the papery crunch on
 * top (damageTarget's own crunch covers plain volumes). Returns voxels
 * removed. */
function carve(world: GameWorld, nodeId: string, point: Vector3, radius: number): number {
  const removed = damageTarget(world, nodeId, point, radius)
  if (removed > 0 && useDestruction.getState().targets.get(nodeId)?.kind === 'wall') {
    sfx.drywallCrunch(Math.min(1, removed / 10))
  }
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

  // Already-voxelized targets (walls, doors, slabs, items…).
  const voxelHit = raycastVoxelTargets(_origin, _direction, bestDist + TIE)
  if (voxelHit) {
    bestDist = voxelHit.distance
    winner = 'voxel'
    _point.copy(voxelHit.point)
  }

  // Breakable studs in opened wall cavities.
  const studHit = raycastStuds(_origin, _direction, bestDist + TIE)
  if (studHit) {
    bestDist = studHit.distance
    winner = 'stud'
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
    return 'bot'
  }
  if (winner === 'glass' && glassHit) {
    hitGlass(glassHit)
    return 'glass'
  }
  if (winner === 'stud' && studHit) {
    // Knife whittles (1 hp per swing); guns hit at full damage. damageStud
    // owns the chip/snap sfx — no extra sound here.
    const applied = damageStud(
      world,
      studHit.nodeId,
      studHit.studId,
      weapon.melee ? 1 : weapon.damage,
      studHit.point,
    )
    if (!applied) sfx.voxelCrunch(0.25)
    return 'wall'
  }
  if (winner === 'voxel' && voxelHit) {
    carve(world, voxelHit.nodeId, _point, weapon.holeRadius)
    return 'wall'
  }
  if (winner === 'solid' && solidNodeId) {
    if (solidNodeType && DESTRUCTIBLE.has(solidNodeType)) {
      // First blood: voxelize + carve in one go (walls keep their skins +
      // studs anatomy via the destruction manager).
      if (carve(world, solidNodeId, _point, weapon.holeRadius) > 0) return 'wall'
    }
    // Non-destructible surface (or one that refused to voxelize): sparks
    // and a thunk.
    for (let i = 0; i < 3; i++) {
      spawnDebris(_point.x, _point.y, _point.z, 0.035, SPARK, 1.4, 0.6)
    }
    spawnDust(_point.x, _point.y, _point.z, 0.25)
    if (weapon.melee) sfx.knifeHit()
    else sfx.voxelCrunch(0.25)
    return 'solid'
  }
  return 'none'
}
