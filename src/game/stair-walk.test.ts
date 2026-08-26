import { describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { collideCapsule, PLAYER_CAPSULE } from './collision'
import { MOVE, stepVelocity } from './movement'
import { bvhFor, type ColliderEntry } from './world'

/**
 * Phase A stair traversal: host stairs are REAL sawtooth colliders (riser
 * ~0.17–0.27 m, tread ~0.25–0.28 m; stair/stair-segment are SOLID_KINDS), and
 * multi-storey play depends on the plain capsule slide climbing them with NO
 * step-up logic. That works mechanically because every riser is shorter than
 * the capsule's bottom-sphere radius (0.34 m): contact lands on the tread
 * nosing, the push-out normal points up-and-back, and forward pressure walks
 * the sphere over each step. These sims pin that guarantee — if someone
 * shrinks the capsule radius or reworks collideCapsule so risers start
 * defeating the slide, this is the tripwire that says "now you need the
 * step-up pass" (raise-and-retry, docs/MULTILEVEL-PLAN.md Phase A4/D).
 *
 * Movement integration mirrors player.tsx's frame loop: stepVelocity →
 * integrate → collideCapsule, fixed 60 Hz.
 */

function stepBox(size: [number, number, number], center: [number, number, number]): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(...size))
  mesh.position.set(...center)
  mesh.updateMatrixWorld(true)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId: 'stair',
    nodeType: 'stair',
  }
}

/** Solid sawtooth staircase rising toward -Z, plus a landing slab at the top
 * (so "arrived" is a stable stand, not a fall off the last step). */
function buildStaircase(riser: number, tread: number, steps: number): {
  colliders: ColliderEntry[]
  rise: number
  runLen: number
} {
  const colliders: ColliderEntry[] = []
  for (let i = 0; i < steps; i++) {
    const top = riser * (i + 1)
    colliders.push(stepBox([1.2, top, tread], [0, top / 2, -(i * tread + tread / 2)]))
  }
  const rise = riser * steps
  const runLen = tread * steps
  colliders.push(stepBox([1.2, rise, 2], [0, rise / 2, -(runLen + 1)]))
  return { colliders, rise, runLen }
}

type WalkResult = { pos: Vector3; seconds: number; maxY: number; arrived: boolean }

/** Integrate a player-config capsule pushing a constant wish direction until
 * `goal(pos)` holds (the landing is finite — pushing past it walks off the
 * far edge) or the time budget runs out. */
function walk(
  colliders: ColliderEntry[],
  start: Vector3,
  wishZ: -1 | 1,
  seconds: number,
  goal: (pos: Vector3) => boolean,
  walkSpeed = false,
): WalkResult {
  const pos = start.clone()
  const vel = new Vector3()
  let grounded = true
  let maxY = pos.y
  const dt = 1 / 60
  let t = 0
  for (; t < seconds; t += dt) {
    stepVelocity(vel, { wishX: 0, wishZ, walk: walkSpeed, jump: false }, grounded, dt, MOVE)
    pos.addScaledVector(vel, dt)
    grounded = collideCapsule(pos, vel, colliders, PLAYER_CAPSULE)
    if (pos.y > maxY) maxY = pos.y
    if (goal(pos)) return { pos, seconds: t, maxY, arrived: true }
  }
  return { pos, seconds: t, maxY, arrived: false }
}

describe('sawtooth stairs are walkable with the plain capsule slide', () => {
  test('host-typical 0.19 m risers: full 1.9 m storey climbed well inside 3 s', () => {
    const { colliders, rise, runLen } = buildStaircase(0.19, 0.26, 10)
    const onLanding = (p: Vector3) => p.z < -(runLen + 0.3) && p.y >= rise - 0.02
    const { pos, arrived } = walk(colliders, new Vector3(0, 0, 0.8), -1, 3, onLanding)
    // Standing on the top landing: full rise gained, past the last step.
    expect(arrived).toBe(true)
    expect(pos.y).toBeGreaterThanOrEqual(rise - 0.02)
  })

  test('code-max 0.27 m risers (riser < capsule radius 0.34) still climb', () => {
    const { colliders, rise, runLen } = buildStaircase(0.27, 0.28, 10)
    const onLanding = (p: Vector3) => p.z < -(runLen + 0.3) && p.y >= rise - 0.02
    const { arrived } = walk(colliders, new Vector3(0, 0, 0.8), -1, 5, onLanding)
    expect(arrived).toBe(true)
  })

  test('walk speed (shift) climbs too — no run-momentum dependence', () => {
    const { colliders, rise, runLen } = buildStaircase(0.19, 0.26, 10)
    const onLanding = (p: Vector3) => p.z < -(runLen + 0.3) && p.y >= rise - 0.02
    const { arrived } = walk(colliders, new Vector3(0, 0, 0.8), -1, 8, onLanding, true)
    expect(arrived).toBe(true)
  })

  test('descent reaches the ground without launching', () => {
    const { colliders, rise, runLen } = buildStaircase(0.19, 0.26, 10)
    const start = new Vector3(0, rise, -(runLen + 0.8))
    const atBottom = (p: Vector3) => p.z > 0.5 && p.y < 0.02
    const { arrived, maxY } = walk(colliders, start, 1, 4, atBottom)
    expect(arrived).toBe(true) // back on the terrain plane, past the staircase
    expect(maxY).toBeLessThan(rise + 0.2) // never popped above the landing
  })
})
