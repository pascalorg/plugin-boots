import type { GameWorld } from './world'

/** The repeat is deliberately longer than the detailed play field. The road
 * continues past the wrap plane so neither end can enter the camera frustum
 * during the one-frame authoritative translation. */
export const ROAD_LOOP_HALF_LENGTH = 420
export const ROAD_RENDER_HALF_LENGTH = 470
export const ROAD_WIDTH = 8.4
export const ROAD_WRAP_HALF_WIDTH = 11

/** The road shares the depot's spawn-relative frame: it passes beneath the
 * parked tractor/trailer and runs along their initial heading. Keep these two
 * values paired with guntable's public DEPOT_OFFSET contract. */
const ROAD_ANCHOR_LATERAL = 0.5
const ROAD_ANCHOR_FORWARD = -4.5

export type RoadLoopFrame = { x: number; z: number; yaw: number }

export function roadLoopFrame(world: Pick<GameWorld, 'spawn' | 'spawnYaw'>): RoadLoopFrame {
  const fwdX = -Math.sin(world.spawnYaw)
  const fwdZ = -Math.cos(world.spawnYaw)
  return {
    x: world.spawn.x + fwdX * ROAD_ANCHOR_FORWARD - fwdZ * ROAD_ANCHOR_LATERAL,
    z: world.spawn.z + fwdZ * ROAD_ANCHOR_FORWARD + fwdX * ROAD_ANCHOR_LATERAL,
    yaw: world.spawnYaw + Math.PI,
  }
}

export function roadLocalPoint(
  frame: RoadLoopFrame,
  along: number,
  across: number,
): { x: number; z: number } {
  const cos = Math.cos(frame.yaw)
  const sin = Math.sin(frame.yaw)
  return {
    x: frame.x + along * cos + across * sin,
    z: frame.z - along * sin + across * cos,
  }
}

export function roadLocalCoordinates(
  frame: RoadLoopFrame,
  x: number,
  z: number,
): { along: number; across: number } {
  const cos = Math.cos(frame.yaw)
  const sin = Math.sin(frame.yaw)
  const dx = x - frame.x
  const dz = z - frame.z
  return { along: dx * cos - dz * sin, across: dx * sin + dz * cos }
}

/** Extra grass/tree rejection footprint for Boots' generated road. */
export function pointOnEndlessRoad(
  world: Pick<GameWorld, 'spawn' | 'spawnYaw'>,
  x: number,
  z: number,
  margin = 0.4,
): boolean {
  const local = roadLocalCoordinates(roadLoopFrame(world), x, z)
  return (
    Math.abs(local.along) <= ROAD_RENDER_HALF_LENGTH + margin &&
    Math.abs(local.across) <= ROAD_WIDTH / 2 + margin
  )
}

/** Return the world translation which wraps a road-bound point to the other
 * end of the repeated corridor. Off-road vehicles never teleport. */
export function roadWrapOffset(
  frame: RoadLoopFrame,
  x: number,
  z: number,
): { x: number; z: number } {
  const local = roadLocalCoordinates(frame, x, z)
  if (Math.abs(local.across) > ROAD_WRAP_HALF_WIDTH) return { x: 0, z: 0 }
  let alongShift = 0
  const span = ROAD_LOOP_HALF_LENGTH * 2
  if (local.along > ROAD_LOOP_HALF_LENGTH) alongShift = -span
  else if (local.along < -ROAD_LOOP_HALF_LENGTH) alongShift = span
  if (alongShift === 0) return { x: 0, z: 0 }
  const cos = Math.cos(frame.yaw)
  const sin = Math.sin(frame.yaw)
  return { x: alongShift * cos, z: -alongShift * sin }
}

export function isRoadWrapJump(dx: number, dz: number): boolean {
  return Math.hypot(dx, dz) > ROAD_LOOP_HALF_LENGTH
}
