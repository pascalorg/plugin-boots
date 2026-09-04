/**
 * Shared runtime state for the depot convoy.  The rendered controller owns
 * the pose; Player and Viewmodel only read the tiny driver contract below,
 * which keeps the vehicle out of either system's React state.
 */

export const VEHICLE_KIND = 'boots/vehicle' as const
/** Authoritative forward-speed ceiling shared by simulation and wire input.
 * 50 m/s is 180 km/h: deliberately fast enough for the endless road, while
 * keeping one 30 Hz physics step shorter than the truck's collision probes. */
export const VEHICLE_MAX_FORWARD_SPEED = 50
export const VEHICLE_CHASE_MIN_LOOK_AHEAD = 2
export const VEHICLE_CHASE_MAX_LOOK_AHEAD = 8

/** Third-person focus moves down the road with speed, leaving the truck low
 * in frame and giving the driver useful sight distance at highway velocity. */
export function vehicleChaseLookAhead(speed: number): number {
  const safeSpeed = Number.isFinite(speed) ? Math.abs(speed) : 0
  return Math.min(
    VEHICLE_CHASE_MAX_LOOK_AHEAD,
    VEHICLE_CHASE_MIN_LOOK_AHEAD + safeSpeed * 0.12,
  )
}

export type VehicleFrame = {
  x: number
  y: number
  z: number
  yaw: number
  /** Tractor pose. Optional only for rolling compatibility with the previous
   * rigid-convoy wire frame; every current publisher includes all three. */
  truckX?: number
  truckZ?: number
  truckYaw?: number
  speed: number
  /** Normalized front-wheel steering input (-1 left, +1 right). */
  steer?: number
  occupied: boolean
}

export type ConvoyPose = VehicleFrame & {
  truckX: number
  truckZ: number
  truckYaw: number
  ready: boolean
  targetX: number
  targetY: number
  targetZ: number
  targetYaw: number
  targetTruckX: number
  targetTruckZ: number
  targetTruckYaw: number
  remoteDriver: string | null
  remoteAt: number
  steer: number
  targetSteer: number
}

export const convoyPose: ConvoyPose = {
  ready: false,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  truckX: 0,
  truckZ: 0,
  truckYaw: 0,
  speed: 0,
  steer: 0,
  targetSteer: 0,
  occupied: false,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
  targetYaw: 0,
  targetTruckX: 0,
  targetTruckZ: 0,
  targetTruckYaw: 0,
  remoteDriver: null,
  remoteAt: 0,
}

/** The seat position Player follows while this browser is driving. */
export const vehicleRig = {
  driving: false,
  view: 'first' as 'first' | 'third',
  seatX: 0,
  seatY: 0,
  seatZ: 0,
  speed: 0,
}

export function resetConvoyPose(
  x: number,
  y: number,
  z: number,
  yaw: number,
  truckX = x,
  truckZ = z,
  truckYaw = yaw,
): void {
  convoyPose.ready = true
  convoyPose.x = convoyPose.targetX = x
  convoyPose.y = convoyPose.targetY = y
  convoyPose.z = convoyPose.targetZ = z
  convoyPose.yaw = convoyPose.targetYaw = yaw
  convoyPose.truckX = convoyPose.targetTruckX = truckX
  convoyPose.truckZ = convoyPose.targetTruckZ = truckZ
  convoyPose.truckYaw = convoyPose.targetTruckYaw = truckYaw
  convoyPose.speed = 0
  convoyPose.steer = convoyPose.targetSteer = 0
  convoyPose.occupied = false
  convoyPose.remoteDriver = null
  convoyPose.remoteAt = 0
  vehicleRig.driving = false
  vehicleRig.view = 'first'
  vehicleRig.speed = 0
}

export function clearConvoyPose(): void {
  convoyPose.ready = false
  convoyPose.occupied = false
  convoyPose.remoteDriver = null
  convoyPose.remoteAt = 0
  convoyPose.steer = convoyPose.targetSteer = 0
  vehicleRig.driving = false
  vehicleRig.view = 'first'
  vehicleRig.speed = 0
}

export function readVehicleFrame(data: unknown): VehicleFrame | null {
  if (!data || typeof data !== 'object') return null
  const f = data as Record<string, unknown>
  if (
    typeof f.x !== 'number' ||
    typeof f.y !== 'number' ||
    typeof f.z !== 'number' ||
    typeof f.yaw !== 'number' ||
    typeof f.speed !== 'number' ||
    typeof f.occupied !== 'boolean' ||
    !Number.isFinite(f.x) ||
    !Number.isFinite(f.y) ||
    !Number.isFinite(f.z) ||
    !Number.isFinite(f.yaw) ||
    !Number.isFinite(f.speed)
  ) {
    return null
  }
  // A malformed peer must not teleport the convoy to infinity or inject a
  // speed that makes interpolation/camera code unstable.
  if (Math.abs(f.x) > 1_000_000 || Math.abs(f.y) > 100_000 || Math.abs(f.z) > 1_000_000) {
    return null
  }
  return {
    x: f.x,
    y: f.y,
    z: f.z,
    yaw: wrapVehicleYaw(f.yaw),
    ...(typeof f.truckX === 'number' &&
    typeof f.truckZ === 'number' &&
    typeof f.truckYaw === 'number' &&
    Number.isFinite(f.truckX) &&
    Number.isFinite(f.truckZ) &&
    Number.isFinite(f.truckYaw) &&
    Math.abs(f.truckX) <= 1_000_000 &&
    Math.abs(f.truckZ) <= 1_000_000
      ? {
          truckX: f.truckX,
          truckZ: f.truckZ,
          truckYaw: wrapVehicleYaw(f.truckYaw),
        }
      : {}),
    speed: Math.max(-20, Math.min(VEHICLE_MAX_FORWARD_SPEED, f.speed)),
    ...(typeof f.steer === 'number' && Number.isFinite(f.steer)
      ? { steer: Math.max(-1, Math.min(1, f.steer)) }
      : {}),
    occupied: f.occupied,
  }
}

export function wrapVehicleYaw(yaw: number): number {
  const twoPi = Math.PI * 2
  let out = yaw % twoPi
  if (out > Math.PI) out -= twoPi
  if (out <= -Math.PI) out += twoPi
  return out
}

export function shortestYawDelta(from: number, to: number): number {
  return wrapVehicleYaw(to - from)
}

export function convoyLocalToWorld(
  lx: number,
  lz: number,
  pose: Pick<ConvoyPose, 'x' | 'z' | 'yaw'> = convoyPose,
): { x: number; z: number } {
  const cos = Math.cos(pose.yaw)
  const sin = Math.sin(pose.yaw)
  return { x: pose.x + lx * cos + lz * sin, z: pose.z - lx * sin + lz * cos }
}

export function convoyWorldToLocal(
  x: number,
  z: number,
  pose: Pick<ConvoyPose, 'x' | 'z' | 'yaw'> = convoyPose,
): { x: number; z: number } {
  const cos = Math.cos(pose.yaw)
  const sin = Math.sin(pose.yaw)
  const dx = x - pose.x
  const dz = z - pose.z
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos }
}
