import { describe, expect, test } from 'bun:test'
import { Box3, Vector3 } from 'three'
import {
  cameraBoomDistance,
  CAMERA_BOOM_MIN_DISTANCE,
  CAMERA_BOOM_WALL_PADDING,
} from './camera-boom'

const origin = new Vector3(0, 1, 0)
const desired = new Vector3(0, 1, 10)

describe('third-person camera boom collision', () => {
  test('keeps the desired distance in open space', () => {
    expect(cameraBoomDistance(origin, desired, [])).toBe(10)
  })

  test('pulls the camera just in front of the nearest wall', () => {
    const far = { worldBox: new Box3(new Vector3(-2, 0, 7), new Vector3(2, 3, 8)) }
    const near = { worldBox: new Box3(new Vector3(-2, 0, 4), new Vector3(2, 3, 5)) }
    expect(cameraBoomDistance(origin, desired, [far, near])).toBeCloseTo(
      4 - CAMERA_BOOM_WALL_PADDING,
      10,
    )
  })

  test('ignores disabled, containing, and explicitly owned colliders', () => {
    const disabled = {
      disabled: true,
      worldBox: new Box3(new Vector3(-2, 0, 2), new Vector3(2, 3, 3)),
    }
    const containing = {
      worldBox: new Box3(new Vector3(-2, 0, -1), new Vector3(2, 3, 1)),
    }
    const convoy = {
      nodeId: '__boots-depot',
      worldBox: new Box3(new Vector3(-2, 0, 4), new Vector3(2, 3, 5)),
    }
    expect(cameraBoomDistance(origin, desired, [disabled, containing, convoy], '__boots-depot')).toBe(
      10,
    )
  })

  test('keeps a usable minimum boom when a wall is extremely close', () => {
    const wall = { worldBox: new Box3(new Vector3(-2, 0, 0.2), new Vector3(2, 3, 0.3)) }
    expect(cameraBoomDistance(origin, desired, [wall])).toBe(CAMERA_BOOM_MIN_DISTANCE)
  })
})
