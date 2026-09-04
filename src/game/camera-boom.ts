import { type Box3, Ray, Vector3 } from 'three'

export type CameraBoomObstacle = {
  disabled?: boolean
  nodeId?: string
  worldBox: Box3
}

export const CAMERA_BOOM_MIN_DISTANCE = 0.45
export const CAMERA_BOOM_WALL_PADDING = 0.16

const direction = new Vector3()
const hit = new Vector3()
const ray = new Ray()

/**
 * Pull a third-person camera in front of the nearest blocking AABB.
 *
 * The helper is allocation-free on the frame path and intentionally skips a
 * collider containing the origin: floors, the room containing the player,
 * and the driven convoy's cab must not collapse the camera by themselves.
 */
export function cameraBoomDistance(
  origin: Vector3,
  desired: Vector3,
  obstacles: readonly CameraBoomObstacle[],
  ignoredNodeId?: string,
  minimum = CAMERA_BOOM_MIN_DISTANCE,
  padding = CAMERA_BOOM_WALL_PADDING,
): number {
  direction.subVectors(desired, origin)
  const wanted = direction.length()
  if (!Number.isFinite(wanted) || wanted <= 1e-6) return 0
  direction.multiplyScalar(1 / wanted)
  ray.set(origin, direction)

  let allowed = wanted
  for (const obstacle of obstacles) {
    if (
      obstacle.disabled ||
      (ignoredNodeId !== undefined && obstacle.nodeId === ignoredNodeId) ||
      obstacle.worldBox.containsPoint(origin)
    ) continue
    if (!ray.intersectBox(obstacle.worldBox, hit)) continue
    const hitDistance = hit.distanceTo(origin)
    if (hitDistance <= wanted && hitDistance < allowed) {
      allowed = Math.max(minimum, hitDistance - padding)
    }
  }
  return Math.min(wanted, allowed)
}
