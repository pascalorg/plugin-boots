import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { moveCapsule, PLAYER_CAPSULE } from './collision'
import { createFeelState, smoothEyeY } from './feel'
import { MOVE, projectOnWalkableSlope, stepVelocity } from './movement'
import { bvhFor, type ColliderEntry } from './world'

/**
 * The camera's eased eye against the REAL move routine (stepVelocity →
 * projectOnWalkableSlope → moveCapsule, 60 Hz — the Player loop's order).
 * feel.test.ts pins smoothEyeY's math on synthetic feet heights; this suite
 * pins that what the collider actually does to the feet on a 43° plank, on
 * sawtooth stairs and on a jump landing is classified right: slope travel and
 * the last fall frame pass through (velocity explains them), riser lifts ease.
 * Review 2026-09-02: before the `expectedRise` hint the ease settled 24 cm
 * below the true eye on a stairs sprint — the control run below reproduces it.
 */

const RAMP_TILT = -Math.atan2(2.8, 3)
const DT = 1 / 60

function boxCollider(
  nodeId: string,
  size: [number, number, number],
  center: [number, number, number],
  rotX = 0,
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.rotation.x = rotX
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId,
    nodeType: 'stair',
  }
}

const ramp = () => boxCollider('ramp', [3, 0.12, 8.2], [0, 2.8, 3], RAMP_TILT)

function sawtoothStairs(): { colliders: ColliderEntry[]; onLanding: (p: Vector3) => boolean } {
  const riser = 0.19
  const tread = 0.26
  const steps = 10
  const colliders: ColliderEntry[] = []
  for (let i = 0; i < steps; i++) {
    const top = riser * (i + 1)
    colliders.push(boxCollider(`step-${i}`, [1.2, top, tread], [0, top / 2, -(i * tread + tread / 2)]))
  }
  const rise = riser * steps
  const runLen = tread * steps
  colliders.push(boxCollider('landing', [1.2, rise, 2], [0, rise / 2, -(runLen + 1)]))
  return { colliders, onLanding: (p) => p.z < -(runLen + 0.3) && p.y >= rise - 0.02 }
}

type Ride = {
  /** Largest |camera feet − true feet| on grounded frames after the settle. */
  maxGap: number
  /** Same, restricted to frames whose contact normal is a real slope. */
  maxGapSlope: number
  /** Gap on the first grounded frame after airtime (−1 = never landed). */
  landingGap: number
  slopeFrames: number
  pos: Vector3
}

/** Player-loop sim with the feel ease riding the feet: `explain` toggles the
 * expectedRise hint (false = the pre-review behaviour, the control). */
function ride(
  colliders: ColliderEntry[],
  start: Vector3,
  wishX: number,
  wishZ: number,
  seconds: number,
  explain: boolean,
  opts: { jumpAt?: number; goal?: (p: Vector3) => boolean } = {},
): Ride {
  const pos = start.clone()
  const vel = new Vector3()
  const normal = new Vector3(0, 1, 0)
  const f = createFeelState()
  let grounded = true
  let prevGrounded = true
  let maxGap = 0
  let maxGapSlope = 0
  let landingGap = -1
  let slopeFrames = 0
  for (let t = 0; t < seconds; t += DT) {
    const jump = opts.jumpAt !== undefined && t >= opts.jumpAt && t < opts.jumpAt + DT
    const jumped = stepVelocity(vel, { wishX, wishZ, walk: false, jump }, grounded, DT, MOVE)
    if (grounded && !jumped) projectOnWalkableSlope(vel, normal.x, normal.y, normal.z)
    const fallSpeed = vel.y // pre-move, exactly what player.tsx captures
    grounded = moveCapsule(pos, vel, DT, colliders, grounded, jumped, PLAYER_CAPSULE, normal)
    const camFeetY = smoothEyeY(f, pos.y, grounded, DT, explain ? fallSpeed * DT : 0)
    const gap = Math.abs(camFeetY - pos.y)
    if (grounded && !prevGrounded && landingGap < 0) landingGap = gap
    if (grounded && t > 0.15) {
      if (gap > maxGap) maxGap = gap
      if (normal.y < 0.99) {
        slopeFrames++
        if (gap > maxGapSlope) maxGapSlope = gap
      }
    }
    prevGrounded = grounded
    if (opts.goal?.(pos)) break
  }
  return { maxGap, maxGapSlope, landingGap, slopeFrames, pos }
}

describe('camera eye on real geometry (feel.smoothEyeY × collision.moveCapsule)', () => {
  test('sprinting UP the 43° plank: camera within 2 cm of the true eye on every slope frame', () => {
    const up = ride([ramp()], new Vector3(0, 0, -1), 0, 1, 1.5, true, { goal: (p) => p.y >= 5 })
    expect(up.pos.y).toBeGreaterThanOrEqual(5) // actually climbed it
    expect(up.slopeFrames).toBeGreaterThan(30)
    expect(up.maxGapSlope).toBeLessThan(0.02)
  })

  test('CONTROL: the same sprint without the hint sinks the camera > 15 cm into the treads (the review finding)', () => {
    const up = ride([ramp()], new Vector3(0, 0, -1), 0, 1, 1.5, false, { goal: (p) => p.y >= 5 })
    expect(up.pos.y).toBeGreaterThanOrEqual(5)
    expect(up.maxGapSlope).toBeGreaterThan(0.15)
  })

  test('running DOWN the plank at full speed: within 2 cm on every slope frame', () => {
    const down = ride([ramp()], new Vector3(0, 5.5, 5.9), 0, -1, 1.2, true)
    expect(down.pos.y).toBeLessThan(0.05) // reached the lot plane
    expect(down.slopeFrames).toBeGreaterThan(30)
    expect(down.maxGapSlope).toBeLessThan(0.02)
    const control = ride([ramp()], new Vector3(0, 5.5, 5.9), 0, -1, 1.2, false)
    expect(control.maxGapSlope).toBeGreaterThan(0.15)
  })

  test('sawtooth stairs (0.19 m risers): the riser lifts are STILL eased — a lag that exists but never exceeds a riser', () => {
    const { colliders, onLanding } = sawtoothStairs()
    const climb = ride(colliders, new Vector3(0, 0, 0.8), 0, -1, 3, true, { goal: onLanding })
    expect(onLanding(climb.pos)).toBe(true)
    expect(climb.maxGap).toBeGreaterThan(0.03) // the ease is doing its job on the risers…
    expect(climb.maxGap).toBeLessThan(0.19) // …and never trails a full riser behind
  })

  test('a run-and-jump on flat ground: the landing frame puts the camera exactly on the true eye', () => {
    const hop = ride([], new Vector3(0, 0, 0), 0, 1, 1.6, true, { jumpAt: 0.3 })
    expect(hop.landingGap).toBeGreaterThanOrEqual(0)
    expect(hop.landingGap).toBeLessThan(1e-9)
  })
})
