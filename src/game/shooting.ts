import { Color, Matrix4, Ray, Vector3 } from 'three'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { damageWall, raycastVoxelWalls } from './destruction'
import { damageBot, raycastBots } from './enemies-state'
import { hitGlass, raycastGlass } from './glass'
import { playerRig } from './player'
import type { WeaponDef } from './weapons'
import type { GameWorld } from './world'

/**
 * Hitscan resolution across every target class: solid host meshes (BVH),
 * voxelized walls (grid DDA), glass panes, bots. Nearest hit wins; effects
 * route by class. First bullet into a pristine wall converts it to voxels
 * and carves in the same shot.
 */

export type FireOutcome = 'bot' | 'wall' | 'glass' | 'solid' | 'none'

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

export function fire(world: GameWorld, weapon: WeaponDef): FireOutcome {
  _origin.copy(playerRig.position)
  aimDirection(_direction, weapon.spread)

  let bestDist = weapon.range
  let outcome: FireOutcome = 'none'
  let hitNodeId: string | null = null
  let hitNodeType: string | null = null
  _point.set(0, 0, 0)

  // Solid host meshes.
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
      outcome = 'solid'
      hitNodeId = collider.nodeId
      hitNodeType = collider.nodeType
      _point.copy(world_)
    }
  }

  // Already-voxelized walls.
  const voxelHit = raycastVoxelWalls(_origin, _direction, bestDist)
  if (voxelHit) {
    bestDist = voxelHit.distance
    outcome = 'wall'
    hitNodeId = voxelHit.nodeId
    _point.copy(voxelHit.point)
  }

  // Glass.
  const glassHit = raycastGlass(world, _origin, _direction, bestDist)

  // Bots.
  const botHit = raycastBots(_origin, _direction, glassHit ? glassHit.distance : bestDist)

  if (botHit) {
    damageBot(botHit.bot, weapon.damage)
    return 'bot'
  }
  if (glassHit && glassHit.distance < bestDist) {
    hitGlass(glassHit)
    return 'glass'
  }

  if (outcome === 'wall' && hitNodeId) {
    damageWall(world, hitNodeId, _point, weapon.holeRadius)
    return 'wall'
  }
  if (outcome === 'solid' && hitNodeId) {
    if (hitNodeType === 'wall' && world.walls.has(hitNodeId)) {
      // First blood on this wall: voxelize + carve in one go.
      damageWall(world, hitNodeId, _point, weapon.holeRadius)
      return 'wall'
    }
    // Non-destructible surface: sparks and a thunk.
    for (let i = 0; i < 3; i++) {
      spawnDebris(_point.x, _point.y, _point.z, 0.035, SPARK, 1.4, 0.6)
    }
    if (weapon.melee) sfx.knifeHit()
    else sfx.voxelCrunch(0.25)
    return 'solid'
  }
  return 'none'
}
