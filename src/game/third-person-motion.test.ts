import { describe, expect, test } from 'bun:test'
import { createArticulation, createMotion } from './remote-players'
import {
  layerThirdPersonAim,
  steerThirdPersonBody,
  THIRD_PERSON_AIM_LEAN,
  THIRD_PERSON_AIM_ROLL,
} from './third-person-motion'

describe('third-person aim stance', () => {
  test('leans guns into ADS without moving the barrel or head off the aim pitch', () => {
    const pose = createArticulation()
    pose.torsoPitch = 0.1
    pose.headPitch = 0.25
    pose.armAim = 1.1
    pose.armSwing = 0.9

    const headPitchBefore = pose.torsoPitch + pose.headPitch
    const rightAimBefore = pose.torsoPitch + pose.armAim
    const leftAimBefore = pose.torsoPitch + pose.armSwing
    layerThirdPersonAim(pose, 1, 'long')

    expect(pose.torsoPitch).toBeCloseTo(0.1 + THIRD_PERSON_AIM_LEAN)
    expect(pose.torsoRoll).toBeCloseTo(-THIRD_PERSON_AIM_ROLL)
    expect(pose.torsoPitch + pose.headPitch).toBeCloseTo(headPitchBefore)
    expect(pose.torsoPitch + pose.armAim).toBeCloseTo(rightAimBefore)
    expect(pose.torsoPitch + pose.armSwing).toBeCloseTo(leftAimBefore)
  })

  test('clamps partial ADS and leaves tools untouched', () => {
    const half = createArticulation()
    layerThirdPersonAim(half, 0.5, 'short')
    expect(half.torsoPitch).toBeCloseTo(THIRD_PERSON_AIM_LEAN / 2)

    const tool = createArticulation()
    const before = { ...tool }
    layerThirdPersonAim(tool, 1, 'tool')
    expect(tool).toEqual(before)
  })
})

describe('third-person ADS body steering', () => {
  test('turns the hips toward the camera aim smoothly', () => {
    const motion = createMotion()
    motion.bodyYaw = 0
    const yaw = steerThirdPersonBody(motion, Math.PI / 2, 1, 1 / 60)
    expect(yaw).toBeGreaterThan(0)
    expect(yaw).toBeLessThan(Math.PI / 2)
  })

  test('hip-fire preserves the shared body dead-zone result', () => {
    const motion = createMotion()
    motion.bodyYaw = 0.4
    expect(steerThirdPersonBody(motion, 1.2, 0, 1 / 60)).toBe(0.4)
    expect(motion.bodyYaw).toBe(0.4)
  })
})
