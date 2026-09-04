import { describe, expect, test } from 'bun:test'
import { Group, Quaternion, Vector3 } from 'three'
import { createArticulation, createMotion } from './remote-players'
import {
  avatarAimDirection,
  layerThirdPersonAim,
  orientMuzzleFx,
  pointMuzzleFxAt,
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

describe('third-person shot direction', () => {
  const worldForward = (fx: Group) =>
    new Vector3(0, 0, -1).applyQuaternion(fx.getWorldQuaternion(new Quaternion())).normalize()

  test('removes inherited arm yaw so the tracer follows the authoritative aim ray', () => {
    const root = new Group()
    const arm = new Group()
    const fx = new Group()
    root.rotation.set(0.12, 0.7, -0.04)
    arm.rotation.set(0.8, 0.45, 0)
    root.add(arm)
    arm.add(fx)

    const expected = avatarAimDirection(new Vector3(), 1.1, 0.24)
    orientMuzzleFx(fx, expected)
    expect(worldForward(fx).dot(expected)).toBeGreaterThan(0.999999)
  })

  test('converges the offset muzzle on the actual hitscan target', () => {
    const root = new Group()
    const arm = new Group()
    const fx = new Group()
    root.position.set(4, 1, -2)
    root.rotation.set(-0.1, -0.8, 0.06)
    arm.position.set(0.3, 1.2, 0)
    arm.rotation.set(1.0, 0.38, 0)
    fx.position.set(0, 0.05, -0.61)
    root.add(arm)
    arm.add(fx)

    const target = new Vector3(-8, 3, -14)
    pointMuzzleFxAt(fx, target)
    const muzzle = fx.getWorldPosition(new Vector3())
    const expected = target.clone().sub(muzzle).normalize()
    expect(worldForward(fx).dot(expected)).toBeGreaterThan(0.999999)
  })
})
