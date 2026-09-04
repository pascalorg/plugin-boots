import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import {
  isRoadWrapJump,
  pointOnEndlessRoad,
  ROAD_LOOP_HALF_LENGTH,
  roadLocalCoordinates,
  roadLocalPoint,
  roadLoopFrame,
  roadWrapOffset,
} from './road-loop'
import type { GameWorld } from './world'

function world(yaw = 0): GameWorld {
  return { spawn: new Vector3(10, 0, -3), spawnYaw: yaw } as GameWorld
}

describe('endless road loop', () => {
  test('local/world transforms round-trip at arbitrary spawn yaw', () => {
    const frame = roadLoopFrame(world(0.73))
    const p = roadLocalPoint(frame, 123, -4)
    const local = roadLocalCoordinates(frame, p.x, p.z)
    expect(local.along).toBeCloseTo(123, 10)
    expect(local.across).toBeCloseTo(-4, 10)
  })

  test('wraps a road-bound vehicle by exactly one period', () => {
    const frame = roadLoopFrame(world(0.4))
    const outside = roadLocalPoint(frame, ROAD_LOOP_HALF_LENGTH + 0.1, 2)
    const shift = roadWrapOffset(frame, outside.x, outside.z)
    const wrapped = roadLocalCoordinates(frame, outside.x + shift.x, outside.z + shift.z)
    expect(wrapped.along).toBeCloseTo(-ROAD_LOOP_HALF_LENGTH + 0.1, 8)
    expect(wrapped.across).toBeCloseTo(2, 8)
    expect(isRoadWrapJump(shift.x, shift.z)).toBe(true)
  })

  test('never teleports an off-road vehicle and exposes a vegetation-clear footprint', () => {
    const w = world(-0.6)
    const frame = roadLoopFrame(w)
    const offRoad = roadLocalPoint(frame, ROAD_LOOP_HALF_LENGTH + 2, 20)
    expect(roadWrapOffset(frame, offRoad.x, offRoad.z)).toEqual({ x: 0, z: 0 })
    const asphalt = roadLocalPoint(frame, 100, 0)
    const verge = roadLocalPoint(frame, 100, 8)
    expect(pointOnEndlessRoad(w, asphalt.x, asphalt.z)).toBe(true)
    expect(pointOnEndlessRoad(w, verge.x, verge.z)).toBe(false)
  })
})
