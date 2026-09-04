import { describe, expect, test } from 'bun:test'
import {
  convoyLocalToWorld,
  convoyWorldToLocal,
  clearConvoyPose,
  readVehicleFrame,
  resetConvoyPose,
  shortestYawDelta,
  VEHICLE_MAX_FORWARD_SPEED,
  vehicleRig,
  wrapVehicleYaw,
} from './vehicle-state'

describe('vehicle wire boundary', () => {
  test('accepts and normalizes a finite shared pose', () => {
    expect(
      readVehicleFrame({ x: 4, y: 0.5, z: -8, yaw: Math.PI * 3, speed: 90, occupied: true }),
    ).toEqual({
      x: 4,
      y: 0.5,
      z: -8,
      yaw: Math.PI,
      speed: VEHICLE_MAX_FORWARD_SPEED,
      occupied: true,
    })
  })

  test('preserves the articulated truck pose when a current peer includes it', () => {
    expect(
      readVehicleFrame({
        x: 4,
        y: 0.5,
        z: -8,
        yaw: 0.2,
        truckX: -1.5,
        truckZ: -7,
        truckYaw: Math.PI * 3,
        speed: 5,
        steer: 4,
        occupied: true,
      }),
    ).toMatchObject({ truckX: -1.5, truckZ: -7, truckYaw: Math.PI, steer: 1 })
  })

  test('rejects malformed and unbounded peer data', () => {
    expect(readVehicleFrame(null)).toBeNull()
    expect(readVehicleFrame({ x: 0, y: 0, z: 0, yaw: 0, speed: 0 })).toBeNull()
    expect(
      readVehicleFrame({ x: Infinity, y: 0, z: 0, yaw: 0, speed: 0, occupied: false }),
    ).toBeNull()
    expect(
      readVehicleFrame({ x: 2_000_000, y: 0, z: 0, yaw: 0, speed: 0, occupied: false }),
    ).toBeNull()
  })
})

describe('convoy transform', () => {
  test('local/world round-trips at arbitrary headings', () => {
    for (const yaw of [-Math.PI, -0.7, 0, 1.2, Math.PI]) {
      const pose = { x: 13, z: -9, yaw }
      const world = convoyLocalToWorld(-5.72, 0.45, pose)
      const local = convoyWorldToLocal(world.x, world.z, pose)
      expect(local.x).toBeCloseTo(-5.72, 10)
      expect(local.z).toBeCloseTo(0.45, 10)
    }
  })

  test('heading interpolation crosses the ±π seam by the short route', () => {
    expect(shortestYawDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2, 10)
    expect(wrapVehicleYaw(Math.PI * 5)).toBe(Math.PI)
  })
})

describe('driver camera mode', () => {
  test('a new or cleared convoy always starts in first person', () => {
    vehicleRig.view = 'third'
    resetConvoyPose(0, 0, 0, 0)
    expect(String(vehicleRig.view)).toBe('first')
    vehicleRig.view = 'third'
    clearConvoyPose()
    expect(String(vehicleRig.view)).toBe('first')
  })
})
