import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { applyTeleport, playerRig } from './player'

/**
 * playerDebug.teleport grew an optional Y for multi-storey E2E (landing the
 * rig on an upper floor to walk stairs / shoot level-2 walls). The closure in
 * Player delegates to applyTeleport with its live refs — these tests pin the
 * pure core: default Y stays the historical ground teleport, explicit Y
 * places the feet, velocity always zeroes (no carried fall speed through a
 * teleport), yaw/pitch land on the rig.
 */

describe('applyTeleport', () => {
  test('default keeps the historical ground behavior (y = 0)', () => {
    const feet = new Vector3(9, 9, 9)
    const vel = new Vector3(1, -8, 2)
    applyTeleport(feet, vel, 3, -4, 1.25)
    expect(feet.toArray()).toEqual([3, 0, -4])
    expect(vel.toArray()).toEqual([0, 0, 0])
    expect(playerRig.yaw).toBe(1.25)
    expect(playerRig.pitch).toBe(0)
  })

  test('explicit y lands the feet on an upper storey', () => {
    const feet = new Vector3()
    const vel = new Vector3(0, -12, 0)
    applyTeleport(feet, vel, 1, 2, 0.5, -0.2, 2.8)
    expect(feet.toArray()).toEqual([1, 2.8, 2])
    expect(vel.toArray()).toEqual([0, 0, 0])
    expect(playerRig.yaw).toBe(0.5)
    expect(playerRig.pitch).toBe(-0.2)
  })
})
