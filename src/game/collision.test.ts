import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import {
  clearPassages,
  moveCapsule,
  passageCount,
  PLAYER_CAPSULE,
  registerPassage,
  unregisterPassage,
} from './collision'
import { bvhFor, type ColliderEntry } from './world'

/**
 * Open-doorway passage relief (owner report 2026-08-29, "door opens but I
 * can't go through"): real scenes author OTHER nodes across a doorway —
 * the repro house has window_living_a's 5 cm frame rails at y 0.60 / 1.75
 * spanning the front door's opening, so the capsule stopped exactly
 * capsule-radius short of them while the door stood visibly open
 * (advance 1.63 m of a 2 m approach, blocked at the rail plane). While a
 * passage volume is registered, collideCapsule ignores triangle contacts
 * whose closest point lies inside it; everything else keeps pushing.
 */

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

/** Walk a grounded capsule toward -Z for `seconds`; returns the feet. */
function walk(colliders: ColliderEntry[], startZ: number, seconds: number, x = 0): Vector3 {
  const pos = new Vector3(x, 0, startZ)
  const vel = new Vector3()
  const dt = 1 / 60
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    vel.set(0, vel.y - 9.8 * dt, -4)
    moveCapsule(pos, vel, dt, colliders, true, false, PLAYER_CAPSULE)
  }
  return pos
}

/** The repro doorway: a 0.8 × 2.1 door prism at the origin (passage built
 * the way interact.tsx builds it — full frame height, thin axis padded),
 * plus the overlapping window's bottom + head rails crossing the opening. */
function railsAcrossDoorway(): { colliders: ColliderEntry[]; passage: Box3 } {
  const rails = [
    // window_living_a i106: the waist rail (y 0.60–0.65, full opening span).
    boxCollider('window-1', 'window', [1.5, 0.05, 0.08], [0, 0.625, 0]),
    // window_living_a i105: the head rail (y 1.75–1.80).
    boxCollider('window-1', 'window', [1.5, 0.05, 0.08], [0, 1.775, 0]),
  ]
  const passage = new Box3(
    new Vector3(-0.4, 0, -0.06 - 0.35),
    new Vector3(0.4, 2.1, 0.06 + 0.35),
  )
  return { colliders: rails, passage }
}

afterEach(() => {
  clearPassages()
})

describe('open-doorway passage relief', () => {
  test('foreign rails across the doorway block WITHOUT a passage (the bug repro)', () => {
    const { colliders } = railsAcrossDoorway()
    const end = walk(colliders, 1.2, 1.5)
    // Stopped roughly capsule-radius short of the rail plane (z 0.04 + 0.34).
    expect(end.z).toBeGreaterThan(0.3)
  })

  test('the registered passage lets the capsule through the same rails', () => {
    const { colliders, passage } = railsAcrossDoorway()
    registerPassage(passage)
    const end = walk(colliders, 1.2, 1.5)
    expect(end.z).toBeLessThan(-1)
  })

  test('an OFF-AXIS pass still clears crossing bars (thin-bar slack, live QA wedge)', () => {
    const { colliders, passage } = railsAcrossDoorway()
    registerPassage(passage)
    // Hugging the jamb line: the capsule (r 0.34) at x 0.3 contacts the
    // rails out to x 0.64 — past the exact prism edge (0.4). The exact-
    // prism rule wedged here exactly like the live front door (stopped
    // mid-rail at z 4.31); the thin-bar pad clears it.
    const end = walk(colliders, 1.2, 1.5, 0.3)
    expect(end.z).toBeLessThan(-1)
  })

  test('unregister restores the block; register is idempotent by identity', () => {
    const { colliders, passage } = railsAcrossDoorway()
    registerPassage(passage)
    registerPassage(passage)
    expect(passageCount()).toBe(1)
    unregisterPassage(passage)
    expect(passageCount()).toBe(0)
    const end = walk(colliders, 1.2, 1.5)
    expect(end.z).toBeGreaterThan(0.3)
  })

  test('ground contacts keep resolving INSIDE the prism (normal-based floor protection)', () => {
    // A raised floor crossing the doorway, top at 0.3, fully inside the
    // prism: its walkable-normal contacts must keep resolving, or the
    // mover would sink to the lot plane mid-door.
    const floor = boxCollider('slab-1', 'slab', [4, 0.3, 14], [0, 0.15, 0])
    // Rails sit 0.6 above the raised floor, inside the prism.
    const rails = [
      boxCollider('window-1', 'window', [1.5, 0.05, 0.08], [0, 0.925, 0]),
      boxCollider('window-1', 'window', [1.5, 0.05, 0.08], [0, 2.075, 0]),
    ]
    const lifted = new Box3(new Vector3(-0.4, 0, -0.41), new Vector3(0.4, 2.4, 0.41))
    registerPassage(lifted)
    const all = [floor, ...rails]
    const pos = new Vector3(0, 0.3, 1.2)
    const vel = new Vector3()
    const dt = 1 / 60
    let groundedTicks = 0
    const ticks = Math.round(1.5 / dt)
    for (let i = 0; i < ticks; i++) {
      vel.set(0, vel.y - 9.8 * dt, -4)
      if (moveCapsule(pos, vel, dt, all, true, false, PLAYER_CAPSULE)) groundedTicks++
    }
    expect(pos.z).toBeLessThan(-1) // through the rails…
    expect(pos.y).toBeCloseTo(0.3, 1) // …standing ON the raised floor
    expect(groundedTicks).toBeGreaterThan(ticks * 0.9)
  })

  test('a perpendicular wall END crossing the prism stops wedging (QA wall_e corner)', () => {
    // The QA house's front door overlaps wall_e's end: its corner stood
    // inside the doorway and its contacts resolved at bottom-sphere height
    // (y ≈ 0.33), wedging the walk at z 4.31 forever. Steep-normal contacts
    // inside the prism relieve regardless of height.
    const wallEnd = boxCollider('wall-e', 'wall', [0.1, 2.5, 8.1], [5.0, 1.25, 0.0])
    const passage = new Box3(new Vector3(4.6, 0, 3.94 - 0.35), new Vector3(5.4, 2.1, 4.06 + 0.35))
    registerPassage(passage)
    const end = walk([wallEnd], 4.8, 1.5, 5.0)
    // Through the prism; past it the wall body's side faces push the mover
    // off the wall line (slide), never hold it at the doorway.
    expect(end.z).toBeLessThan(3.5)
  })

  test('contacts OUTSIDE the prism still push: the jamb wall keeps blocking', () => {
    const { passage } = railsAcrossDoorway()
    // Wall beside the doorway (x 0.5..2.5) — the walker aims at x 1.5.
    const wall = boxCollider('wall-1', 'wall', [2, 2.5, 0.12], [1.5, 1.25, 0])
    registerPassage(passage)
    const end = walk([wall], 1.2, 1.5, 1.5)
    expect(end.z).toBeGreaterThan(0.3)
    expect(end.x).toBeCloseTo(1.5, 1)
  })
})
