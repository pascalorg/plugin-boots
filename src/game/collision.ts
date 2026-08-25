import { Box3, Line3, Vector3 } from 'three'
import type { ColliderEntry } from './world'

/**
 * Capsule-vs-world resolution — the three-mesh-bvh `characterMovement`
 * pattern, per-mesh in local space (host transforms are rigid). Mutates
 * position (feet) and clips velocity against contact normals so the player
 * slides along walls instead of sticking.
 */

export type CapsuleConfig = { radius: number; height: number }

export const PLAYER_CAPSULE: CapsuleConfig = { radius: 0.34, height: 1.78 }
export const EYE_HEIGHT = 1.58

const _segment = new Line3()
const _localSegment = new Line3()
const _worldBox = new Box3()
const _localBox = new Box3()
const _triPoint = new Vector3()
const _capsulePoint = new Vector3()
const _normal = new Vector3()

function refreshSegments(pos: Vector3, cfg: CapsuleConfig, collider: ColliderEntry): void {
  _segment.start.set(pos.x, pos.y + cfg.radius, pos.z)
  _segment.end.set(pos.x, pos.y + cfg.height - cfg.radius, pos.z)
  _localSegment.copy(_segment).applyMatrix4(collider.inverse)
}

/** Resolve the capsule out of every collider. Returns whether any contact
 * counted as ground (normal.y > 0.55) this pass. */
export function collideCapsule(
  pos: Vector3,
  vel: Vector3,
  colliders: ColliderEntry[],
  cfg: CapsuleConfig = PLAYER_CAPSULE,
): boolean {
  let grounded = false

  for (let iteration = 0; iteration < 3; iteration++) {
    let corrected = false
    _worldBox.min.set(pos.x - cfg.radius, pos.y, pos.z - cfg.radius)
    _worldBox.max.set(pos.x + cfg.radius, pos.y + cfg.height, pos.z + cfg.radius)

    for (const collider of colliders) {
      if (collider.disabled) continue
      if (!collider.worldBox.intersectsBox(_worldBox)) continue
      refreshSegments(pos, cfg, collider)
      _localBox.makeEmpty()
      _localBox.expandByPoint(_localSegment.start)
      _localBox.expandByPoint(_localSegment.end)
      _localBox.min.addScalar(-cfg.radius)
      _localBox.max.addScalar(cfg.radius)

      collider.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_localBox),
        intersectsTriangle: (tri) => {
          const distance = tri.closestPointToSegment(_localSegment, _triPoint, _capsulePoint)
          if (distance >= cfg.radius) return false
          const depth = cfg.radius - distance
          _normal.subVectors(_capsulePoint, _triPoint)
          if (_normal.lengthSq() < 1e-12) return false
          _normal.normalize().transformDirection(collider.mesh.matrixWorld)
          pos.addScaledVector(_normal, depth)
          if (_normal.y > 0.55) grounded = true
          const into = vel.dot(_normal)
          if (into < 0) vel.addScaledVector(_normal, -into)
          corrected = true
          refreshSegments(pos, cfg, collider)
          return false
        },
      })
    }
    if (!corrected) break
  }

  // The lot itself: an infinite ground plane at y = 0.
  if (pos.y < 0) {
    pos.y = 0
    if (vel.y < 0) vel.y = 0
    grounded = true
  } else if (pos.y < 0.02 && vel.y <= 0.01) {
    grounded = true
  }

  return grounded
}
